import crypto from "node:crypto";
import path from "node:path";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { DEFAULT_TRACE_DIR } from "../paths.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import type { BrowserRouteContext } from "../server-context.js";
import { createPlaywrightRouteRegistrar } from "./agent.playwright.js";
import {
  browserNavigationPolicyForProfile,
  readBody,
  resolveProfileContext,
  withPlaywrightRouteContext,
} from "./agent.shared.js";
import { EXISTING_SESSION_LIMITS } from "./existing-session-limits.js";
import { resolveWritableOutputPathOrRespond } from "./output-paths.js";
import { readRoutePositiveInteger } from "./route-numeric.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { jsonError, toBoolean, toStringOrEmpty } from "./utils.js";

export function registerBrowserAgentDebugRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  const register = createPlaywrightRouteRegistrar(app, ctx, "inspection");

  app.post("/archive", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) {
      return;
    }
    if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
      return jsonError(res, 501, "Page archives require a Chromium CDP profile.");
    }
    await withPlaywrightRouteContext({
      req,
      res,
      ctx,
      profileCtx,
      targetId: toStringOrEmpty(readBody(req).targetId) || undefined,
      feature: "archive",
      enforceCurrentUrlAllowed: true,
      run: async ({ cdpUrl, tab, pw, signal, assertCurrent }) => {
        const { buffer } = await pw.archiveViaPlaywright({
          cdpUrl,
          targetId: tab.targetId,
          signal,
          assertCurrent,
          ...browserNavigationPolicyForProfile(ctx, profileCtx),
        });
        await assertCurrent?.();
        // Native capture can outlive a caller; fence every media publication await.
        const assertCommitAllowed = () => {
          signal.throwIfAborted();
          if (req.requester?.isCurrent() === false) {
            throw new Error("Browser requester is no longer active");
          }
        };
        const saved = await saveMediaBuffer(
          buffer,
          "multipart/related",
          "browser",
          undefined,
          "page.mhtml",
          undefined,
          { assertCommitAllowed },
        );
        res.json({
          ok: true,
          path: path.resolve(saved.path),
          targetId: tab.targetId,
          url: tab.url,
        });
      },
    });
  });

  register("get", "/console", "console messages", (input) => {
    const level = normalizeOptionalString(typeof input.level === "string" ? input.level : "");
    return async (pw, { cdpUrl, targetId }) => ({
      messages: await pw.getConsoleMessagesViaPlaywright({ cdpUrl, targetId, level }),
    });
  });

  register(
    "get",
    "/errors",
    "page errors",
    (input) => {
      const clear = toBoolean(input.clear) ?? false;
      return (pw, { cdpUrl, targetId }) =>
        pw.getPageErrorsViaPlaywright({ cdpUrl, targetId, clear });
    },
    EXISTING_SESSION_LIMITS.errors,
  );

  register(
    "get",
    "/requests",
    "network requests",
    (input) => {
      const filter = normalizeOptionalString(typeof input.filter === "string" ? input.filter : "");
      const clear = toBoolean(input.clear) ?? false;
      return (pw, { cdpUrl, targetId }) =>
        pw.getNetworkRequestsViaPlaywright({ cdpUrl, targetId, filter, clear });
    },
    EXISTING_SESSION_LIMITS.requests,
  );

  register(
    "get",
    "/text",
    "page text",
    (input) => {
      const selector = normalizeOptionalString(input.selector);
      const maxChars = readRoutePositiveInteger(input.maxChars, "maxChars");
      return (pw, target, signal) =>
        pw.getPageTextViaPlaywright({ ...target, signal, selector, maxChars });
    },
    EXISTING_SESSION_LIMITS.text,
  );

  register("get", "/dialogs", "dialog state", () => async (pw, { cdpUrl, targetId }) => ({
    browserState: await pw.getObservedBrowserStateViaPlaywright({
      cdpUrl,
      targetId,
      ssrfPolicy: ctx.state().resolved.ssrfPolicy,
    }),
  }));

  register("post", "/trace/start", "trace start", (input) => {
    const screenshots = toBoolean(input.screenshots);
    const snapshots = toBoolean(input.snapshots);
    const sources = toBoolean(input.sources);
    return async (pw, { cdpUrl, targetId }) => {
      await pw.traceStartViaPlaywright({ cdpUrl, targetId, screenshots, snapshots, sources });
      return {};
    };
  });

  register("post", "/trace/stop", "trace stop", (input, _params, res) => {
    const requestedPath = toStringOrEmpty(input.path);
    return async (pw, { cdpUrl, targetId }) => {
      const tracePath = await resolveWritableOutputPathOrRespond({
        res,
        rootDir: DEFAULT_TRACE_DIR,
        requestedPath,
        scopeLabel: "trace directory",
        defaultFileName: `browser-trace-${crypto.randomUUID()}.zip`,
        ensureRootDir: true,
      });
      if (!tracePath) {
        return null;
      }
      return { path: await pw.traceStopViaPlaywright({ cdpUrl, targetId, path: tracePath }) };
    };
  });
}
