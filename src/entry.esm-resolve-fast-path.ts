/**
 * Short-circuits Node's ESM resolution for dist-internal relative imports.
 *
 * Node's default resolver calls getPackageScopeConfig() for every file: URL to
 * pick a module format, and each call re-materializes the package.json
 * `exports` map. With openclaw's 300+ subpath exports that costs ~0.1ms per
 * resolution and multiple seconds across the ~15k module edges of a gateway
 * boot. Every built dist file is ESM (all dist package.json files declare
 * "type": "module"), so a relative "./chunk.js" import inside dist can resolve
 * by URL join with format "module" without consulting the package scope at
 * all. This hook removes only resolver cost; the resolved URL and format are
 * byte-identical to Node's default resolution.
 */
import Module from "node:module";
import process from "node:process";

type SyncResolveResult = { url: string; format?: string | null; shortCircuit?: boolean };
type SyncResolveContext = { parentURL?: string; conditions?: readonly string[] };
type SyncResolveHook = (
  specifier: string,
  context: SyncResolveContext,
  nextResolve: (specifier: string, context?: SyncResolveContext) => SyncResolveResult,
) => SyncResolveResult;
type RegisterModuleHooks = (options: { resolve?: SyncResolveHook }) => { deregister: () => void };

// SAFETY: Module.registerHooks ships in every supported Node runtime but is missing from the bundled type declarations; the optional member keeps callers probing before use (Bun lacks it).
const moduleWithHooks = Module as typeof Module & {
  registerHooks?: RegisterModuleHooks;
};

const installedDistRootUrls = new Set<string>();
const NODE_OPTIONS_RESOLVER_HOOK_PATTERN =
  /(?:^|[\s"])(?:--import|--require|-r|--loader|--experimental[-_]loader)(?:=|[\s"]|$)/u;

function hasNodeResolverHookOption(params: {
  execArgv: readonly string[];
  nodeOptions: string | undefined;
}): boolean {
  if (
    params.execArgv.some(
      (arg) =>
        arg === "--import" ||
        arg.startsWith("--import=") ||
        arg === "--require" ||
        arg.startsWith("--require=") ||
        arg === "-r" ||
        arg === "--loader" ||
        arg.startsWith("--loader=") ||
        arg === "--experimental-loader" ||
        arg.startsWith("--experimental-loader=") ||
        arg === "--experimental_loader" ||
        arg.startsWith("--experimental_loader=") ||
        arg === "--experimental-config-file" ||
        arg.startsWith("--experimental-config-file=") ||
        arg === "--experimental-default-config-file",
    )
  ) {
    return true;
  }
  return NODE_OPTIONS_RESOLVER_HOOK_PATTERN.test(params.nodeOptions ?? "");
}

/**
 * Resolves a dist-internal relative ESM specifier to its final file URL, or
 * returns null when the specifier must go through Node's default resolution.
 * Only relative ".js" specifiers whose parent and target both live under the
 * dist root qualify; require() resolutions stay on the default path because
 * the CJS loader does not pay the eager format-detection cost this bypasses.
 */
function resolveDistEsmFastPathUrl(params: {
  specifier: string;
  parentUrl: string | undefined;
  conditions: readonly string[] | undefined;
  distRootUrl: string;
}): string | null {
  const { specifier, parentUrl } = params;
  if (
    specifier.charCodeAt(0) !== 46 /* "." */ ||
    !specifier.endsWith(".js") ||
    parentUrl === undefined ||
    !parentUrl.startsWith(params.distRootUrl) ||
    params.conditions?.includes("require") === true ||
    (specifier.charCodeAt(1) !== 47 /* "/" */ &&
      (specifier.charCodeAt(1) !== 46 /* "." */ || specifier.charCodeAt(2) !== 47))
  ) {
    return null;
  }
  let resolved: string;
  try {
    resolved = new URL(specifier, parentUrl).href;
  } catch {
    return null;
  }
  // "../" chains can leave the built output tree; those targets may live in a
  // different package scope, so they keep Node's default format detection.
  return resolved.startsWith(params.distRootUrl) ? resolved : null;
}

/**
 * Installs the dist-relative ESM resolve fast path for a built entry file.
 * No-ops (returns false) outside a dist layout — source checkouts run through
 * tsx/vitest resolvers that must keep owning ".js" specifier rewrites — and
 * on runtimes without Module.registerHooks.
 */
export function installDistEsmResolveFastPath(
  entryFileUrl: string,
  deps: {
    registerHooks?: RegisterModuleHooks | undefined;
    execArgv?: readonly string[];
    nodeOptions?: string | undefined;
  } = {},
): boolean {
  const registerHooks =
    "registerHooks" in deps ? deps.registerHooks : moduleWithHooks.registerHooks;
  if (typeof registerHooks !== "function") {
    return false;
  }
  const distRootUrl = new URL("./", entryFileUrl).href;
  if (!distRootUrl.endsWith("/dist/")) {
    return false;
  }
  const nodeOptions = "nodeOptions" in deps ? deps.nodeOptions : process.env.NODE_OPTIONS;
  // Preloads and loaders can register resolver hooks before OpenClaw starts.
  // Our later short circuit would otherwise bypass that user-owned chain.
  if (hasNodeResolverHookOption({ execArgv: deps.execArgv ?? process.execArgv, nodeOptions })) {
    return false;
  }
  if (installedDistRootUrls.has(distRootUrl)) {
    return true;
  }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const url = resolveDistEsmFastPathUrl({
        specifier,
        parentUrl: context.parentURL,
        conditions: context.conditions,
        distRootUrl,
      });
      if (url !== null) {
        return { url, format: "module", shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  installedDistRootUrls.add(distRootUrl);
  return true;
}
