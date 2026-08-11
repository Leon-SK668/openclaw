import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../../config/sessions.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  resolveSubagentSessionCompletion,
  type SubagentSessionStoreCache,
} from "./subagent-session-reconciliation.js";

describe("subagent session reconciliation", () => {
  it("does not complete from a case-colliding sibling session", () => {
    const missingChildKey = "agent:main:matrix:group:!Room:server";
    const collidingSiblingKey = "agent:main:matrix:group:!room:server";
    const storePath = "/tmp/openclaw-subagent-session-reconciliation.sqlite";
    const cfg = { session: { store: storePath } } satisfies OpenClawConfig;
    const terminalSibling: SessionEntry = {
      sessionId: "sibling-session",
      status: "done",
      startedAt: 1_000,
      updatedAt: 2_000,
      endedAt: 2_000,
    };
    const storeCache: SubagentSessionStoreCache = new Map([
      [storePath, { [collidingSiblingKey]: terminalSibling }],
    ]);

    expect(
      resolveSubagentSessionCompletion({
        childSessionKey: missingChildKey,
        fallbackEndedAt: 3_000,
        notBeforeMs: 0,
        storeCache,
        cfg,
      }),
    ).toBeNull();
  });
});
