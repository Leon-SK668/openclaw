import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../test/helpers/temp-dir.js";
import { installDistEsmResolveFastPath } from "./entry.esm-resolve-fast-path.js";

type ResolveHook = (
  specifier: string,
  context: { parentURL?: string; conditions?: readonly string[] },
  nextResolve: (specifier: string) => { url: string },
) => { url: string; format?: string | null; shortCircuit?: boolean };

const DIST_ROOT = "file:///opt/openclaw/dist/";
const DIST_ENTRY_PATH = path.resolve("dist/entry.js");

function installCapturedHook(entryFileUrl: string): ResolveHook {
  let hook: ResolveHook | undefined;
  const installed = installDistEsmResolveFastPath(entryFileUrl, {
    registerHooks: (options) => {
      hook = options.resolve as ResolveHook;
      return { deregister: () => {} };
    },
    execArgv: [],
    nodeOptions: undefined,
  });
  expect(installed).toBe(true);
  if (!hook) {
    throw new Error("resolve hook was not registered");
  }
  return hook;
}

function runHook(
  hook: ResolveHook,
  specifier: string,
  context: { parentURL?: string; conditions?: readonly string[] } = {},
) {
  const resolvedContext = {
    parentURL: "parentURL" in context ? context.parentURL : `${DIST_ROOT}entry.js`,
    conditions: context.conditions ?? ["node", "import"],
  };
  let deferred = false;
  const result = hook(specifier, resolvedContext, () => {
    deferred = true;
    return { url: "next:resolved" };
  });
  return { deferred, result };
}

describe("installDistEsmResolveFastPath resolve hook", () => {
  const hook = installCapturedHook(`${DIST_ROOT}entry.js`);

  it("short-circuits dist-internal relative .js imports with module format", () => {
    const direct = runHook(hook, "./chunk-abc.js");
    expect(direct.deferred).toBe(false);
    expect(direct.result).toStrictEqual({
      url: `${DIST_ROOT}chunk-abc.js`,
      format: "module",
      shortCircuit: true,
    });
    const fromExtension = runHook(hook, "../../plugin-entry.js", {
      parentURL: `${DIST_ROOT}extensions/telegram/index.js`,
    });
    expect(fromExtension.result.url).toBe(`${DIST_ROOT}plugin-entry.js`);
  });

  it("defers require() resolutions to the default CJS path", () => {
    expect(runHook(hook, "./chunk.js", { conditions: ["node", "require"] }).deferred).toBe(true);
  });

  it("defers bare, absolute, and non-.js specifiers", () => {
    for (const specifier of [
      "openclaw/plugin-sdk/plugin-entry",
      "node:path",
      "/opt/openclaw/dist/chunk.js",
      "./chunk.mjs",
      "./chunk.cjs",
      "./manifest.json",
      "./chunk.js?query",
      ".js",
    ]) {
      expect(runHook(hook, specifier).deferred, specifier).toBe(true);
    }
  });

  it("defers parents outside the dist root and missing parents", () => {
    expect(runHook(hook, "./chunk.js", { parentURL: "file:///opt/other/entry.js" }).deferred).toBe(
      true,
    );
    expect(runHook(hook, "./chunk.js", { parentURL: undefined }).deferred).toBe(true);
  });

  it("defers relative targets that escape the dist root", () => {
    expect(runHook(hook, "../outside/chunk.js").deferred).toBe(true);
  });
});

describe("installDistEsmResolveFastPath gating", () => {
  it("registers one hook per dist root and stays idempotent", () => {
    let registered = 0;
    const registerHooks = () => {
      registered += 1;
      return { deregister: () => {} };
    };
    const root = "file:///opt/openclaw-idempotent/dist/";
    const deps = { registerHooks, execArgv: [], nodeOptions: undefined };
    expect(installDistEsmResolveFastPath(`${root}entry.js`, deps)).toBe(true);
    expect(installDistEsmResolveFastPath(`${root}index.js`, deps)).toBe(true);
    expect(registered).toBe(1);
  });

  it("declines outside dist layouts and without registerHooks support", () => {
    let registered = 0;
    const registerHooks = () => {
      registered += 1;
      return { deregister: () => {} };
    };
    expect(
      installDistEsmResolveFastPath("file:///opt/openclaw/src/entry.ts", { registerHooks }),
    ).toBe(false);
    expect(registered).toBe(0);
    expect(
      installDistEsmResolveFastPath("file:///opt/openclaw-two/dist/entry.js", {
        registerHooks: undefined,
        execArgv: [],
        nodeOptions: undefined,
      }),
    ).toBe(false);
  });

  it.each([
    { name: "CLI --import", execArgv: ["--import", "./hook.mjs"], nodeOptions: undefined },
    { name: "CLI --import=", execArgv: ["--import=./hook.mjs"], nodeOptions: undefined },
    { name: "CLI --require", execArgv: ["--require", "./hook.cjs"], nodeOptions: undefined },
    { name: "CLI --require=", execArgv: ["--require=./hook.cjs"], nodeOptions: undefined },
    { name: "CLI -r", execArgv: ["-r", "./hook.cjs"], nodeOptions: undefined },
    { name: "CLI --loader", execArgv: ["--loader", "./hook.mjs"], nodeOptions: undefined },
    { name: "CLI --loader=", execArgv: ["--loader=./hook.mjs"], nodeOptions: undefined },
    {
      name: "CLI --experimental-loader",
      execArgv: ["--experimental-loader", "./hook.mjs"],
      nodeOptions: undefined,
    },
    {
      name: "CLI --experimental-loader=",
      execArgv: ["--experimental-loader=./hook.mjs"],
      nodeOptions: undefined,
    },
    {
      name: "CLI --experimental_loader",
      execArgv: ["--experimental_loader", "./hook.mjs"],
      nodeOptions: undefined,
    },
    {
      name: "CLI --experimental_loader=",
      execArgv: ["--experimental_loader=./hook.mjs"],
      nodeOptions: undefined,
    },
    {
      name: "CLI --experimental-config-file",
      execArgv: ["--experimental-config-file"],
      nodeOptions: undefined,
    },
    {
      name: "CLI --experimental-config-file=",
      execArgv: ["--experimental-config-file=./node.config.json"],
      nodeOptions: undefined,
    },
    {
      name: "CLI --experimental-default-config-file",
      execArgv: ["--experimental-default-config-file"],
      nodeOptions: undefined,
    },
    { name: "NODE_OPTIONS --import", execArgv: [], nodeOptions: "--import ./hook.mjs" },
    {
      name: "NODE_OPTIONS quoted --import token",
      execArgv: [],
      nodeOptions: '"--import" ./hook.mjs',
    },
    {
      name: "NODE_OPTIONS quoted --require value",
      execArgv: [],
      nodeOptions: '--enable-source-maps --require "./my hook.cjs"',
    },
    { name: "NODE_OPTIONS --loader", execArgv: [], nodeOptions: "--loader ./hook.mjs" },
    {
      name: "NODE_OPTIONS --experimental-loader=",
      execArgv: [],
      nodeOptions: "--experimental-loader=./hook.mjs",
    },
    {
      name: "NODE_OPTIONS --experimental_loader",
      execArgv: [],
      nodeOptions: "--experimental_loader ./hook.mjs",
    },
  ])(
    "declines when a resolver hook may be configured through $name",
    ({ execArgv, nodeOptions }) => {
      let registered = 0;
      const installed = installDistEsmResolveFastPath(
        `file:///opt/openclaw-preload-${registered}-${execArgv.length}/dist/entry.js`,
        {
          registerHooks: () => {
            registered += 1;
            return { deregister: () => {} };
          },
          execArgv,
          nodeOptions,
        },
      );

      expect(installed).toBe(false);
      expect(registered).toBe(0);
    },
  );
});

describe.skipIf(!fs.existsSync(DIST_ENTRY_PATH))("built dist resolver hook chaining", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each([
    {
      name: "synchronous preload",
      nodeOption: "--import",
      source: `import { registerHooks } from "node:module";
registerHooks({ resolve: recordRuntimeGuard });`,
    },
    {
      name: "asynchronous loader",
      nodeOption: "--loader",
      source:
        "export async function resolve(specifier, context, nextResolve) { return recordRuntimeGuard(specifier, context, nextResolve); }",
    },
    {
      name: "quoted NODE_OPTIONS synchronous preload",
      nodeOption: "--import",
      nodeOptions: true,
      source: `import { registerHooks } from "node:module";
registerHooks({ resolve: recordRuntimeGuard });`,
    },
    {
      name: "underscore asynchronous loader",
      nodeOption: "--experimental_loader",
      source:
        "export async function resolve(specifier, context, nextResolve) { return recordRuntimeGuard(specifier, context, nextResolve); }",
    },
    {
      name: "configuration-file synchronous preload",
      nodeConfig: true,
      nodeOption: "--experimental-config-file",
      source: `import { registerHooks } from "node:module";
registerHooks({ resolve: recordRuntimeGuard });`,
    },
  ])("preserves $name resolver hooks", ({ nodeConfig, nodeOption, nodeOptions, source }) => {
    const root = tempDirs.make("openclaw-dist-resolver-hook-");
    const hookPath = path.join(root, "resolver-hook.mjs");
    const markerPath = path.join(root, "resolver-hook.log");
    fs.writeFileSync(
      hookPath,
      `import { appendFileSync } from "node:fs";
function recordRuntimeGuard(specifier, context, nextResolve) {
  if (/^\\.\\/runtime-guard-[^/]+\\.js$/.test(specifier)) {
    appendFileSync(process.env.OPENCLAW_TEST_RESOLVER_HOOK_MARKER, specifier + "\\n");
  }
  return nextResolve(specifier, context);
}
${source}
`,
    );
    const hookUrl = pathToFileURL(hookPath).href;
    const configPath = path.join(root, "node.config.json");
    if (nodeConfig) {
      fs.writeFileSync(configPath, JSON.stringify({ nodeOptions: { import: [hookUrl] } }));
    }
    const nodeArgs = nodeConfig
      ? [`${nodeOption}=${configPath}`, DIST_ENTRY_PATH, "--version"]
      : nodeOptions
        ? [DIST_ENTRY_PATH, "--version"]
        : [nodeOption, hookUrl, DIST_ENTRY_PATH, "--version"];

    const result = spawnSync(process.execPath, nodeArgs, {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: root,
        NODE_DISABLE_COMPILE_CACHE: "1",
        NODE_ENV: undefined,
        NODE_OPTIONS: nodeOptions ? `"${nodeOption}" ${hookUrl}` : undefined,
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_TEST_RESOLVER_HOOK_MARKER: markerPath,
        VITEST: undefined,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    const resolvedRuntimeGuards = fs.readFileSync(markerPath, "utf8").trim().split("\n");
    expect(resolvedRuntimeGuards.length).toBeGreaterThan(0);
    expect(resolvedRuntimeGuards).toEqual(
      resolvedRuntimeGuards.filter((specifier) => /^\.\/runtime-guard-[^/]+\.js$/.test(specifier)),
    );
  });
});
