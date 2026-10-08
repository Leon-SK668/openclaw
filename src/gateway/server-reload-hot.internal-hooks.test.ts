import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import { prepareInternalHooks } from "../hooks/loader.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import type { GatewayReloadHandlerParams } from "./server-reload-contracts.js";
import {
  createDefaultGatewayReloadState,
  createHotTailPlan,
  makePluginReloadResult,
} from "./server-reload-handlers.config.test-support.js";
import { createGatewayReloadHandlers } from "./server-reload-hot.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => drainGlobalSingletonLifecycleState("restart"));

describe("gateway internal hook reload publication", () => {
  it.each(["startup", "reload"])(
    "reconciles a %s hook publication after preparing config reload",
    async (predecessor) => {
      await drainGlobalSingletonLifecycleState("restart");
      const workspace = tempDirs.make("openclaw-hook-publication-");
      const configFor = (name: string): OpenClawConfig => ({
        agents: { defaults: { workspace }, entries: { main: {} } },
        hooks: { internal: { entries: { [name]: { enabled: true } } } },
      });
      for (const name of ["predecessor", "candidate"]) {
        const hookDir = path.join(workspace, "hooks", name);
        fs.mkdirSync(hookDir, { recursive: true });
        fs.writeFileSync(
          path.join(hookDir, "HOOK.md"),
          [
            "---",
            `name: ${name}`,
            "description: Hook publication fixture",
            'metadata: {"openclaw":{"events":["command:new"]}}',
            "---",
          ].join("\n"),
        );
        fs.writeFileSync(
          path.join(hookDir, "handler.js"),
          `export default async function(event) { event.messages.push(${JSON.stringify(name)}); }\n`,
        );
      }
      const nextConfig = configFor("candidate");
      const preparedPredecessor = await prepareInternalHooks(configFor("predecessor"), workspace);
      const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
      let state: ReturnType<GatewayReloadHandlerParams["getState"]> =
        createDefaultGatewayReloadState();
      const { applyHotReload } = createGatewayReloadHandlers({
        scheduler: createTestGatewayScheduler("fake-timers"),
        deps: {} as never,
        broadcast: vi.fn(),
        getPluginRegistry: createEmptyPluginRegistry,
        getState: () => state,
        setState: (nextState) => {
          state = nextState;
        },
        startChannel: vi.fn(async () => new Map()),
        stopChannel: vi.fn(async () => {}),
        releaseChannelRouteHandoffs: vi.fn(),
        pruneInactiveChannelAccountState: vi.fn(),
        reloadPlugins: vi.fn(async () => makePluginReloadResult()),
        logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        logChannels: { info: vi.fn(), error: vi.fn() },
        logCron: { error: vi.fn() },
        logReload: { info: vi.fn(), warn: vi.fn() },
        cronReconciliation: {
          arm: vi.fn(() => ({ complete: async () => {} })),
          invalidate: vi.fn(),
        },
        requestRecoveryRestart,
      });
      const status = await applyHotReload(
        createHotTailPlan({ reloadInternalHooks: true }),
        nextConfig,
        {
          sourceConfig: nextConfig,
          isCurrent: () => true,
          checkpoint: async () => {
            expect(preparedPredecessor.commit({ initial: predecessor === "startup" })).toBe(true);
          },
          publish: async (commit) => await commit(),
        },
      );
      expect(status).toBe(predecessor === "startup" ? "applied" : "applied-restart-required");
      expect(requestRecoveryRestart).toHaveBeenCalledTimes(predecessor === "startup" ? 0 : 1);
      const event = createInternalHookEvent("command", "new", "agent:main:main");
      await triggerInternalHook(event);
      expect(event.messages).toEqual([predecessor === "startup" ? "candidate" : "predecessor"]);
    },
  );
});
