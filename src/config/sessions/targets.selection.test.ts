import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveConfiguredAgentDatabaseTargets, resolveSessionStoreTargets } from "./targets.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session store target selection", () => {
  it.each(["default", "template", "fixed", "shared"])(
    "selects one database owner without changing %s store ownership",
    (layout) => {
      const root = tempDirs.make("configured-database-selection-");
      const env = { OPENCLAW_STATE_DIR: root };
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { first: {}, second: {} } },
        acp: { allowedAgents: ["acp-only"] },
        ...(layout === "default"
          ? {}
          : {
              session: {
                store: path.join(
                  root,
                  layout === "template" ? "{agentId}" : "fixed",
                  layout === "shared" ? "shared.sqlite" : "sessions.json",
                ),
              },
            }),
      };
      const all = resolveConfiguredAgentDatabaseTargets(cfg, { env, registeredDatabases: [] });
      for (const agentId of ["first", "second", "acp-only", "missing"]) {
        expect(
          resolveConfiguredAgentDatabaseTargets(cfg, { env, registeredDatabases: [], agentId }),
        ).toEqual(all.filter((target) => target.agentId === agentId));
      }
    },
  );

  it("rejects a blank agent instead of selecting the default store", () => {
    expect(() => resolveSessionStoreTargets({}, { agent: "" })).toThrow(
      "--agent must not be blank",
    );
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", "   "],
  ])("rejects an %s store instead of selecting the default store", (_label, store) => {
    expect(() => resolveSessionStoreTargets({}, { store })).toThrow("--store must not be blank");
  });
});
