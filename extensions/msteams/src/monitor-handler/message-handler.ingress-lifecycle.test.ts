// Microsoft Teams tests cover durable claim ownership through inbound debounce.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import {
  DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import { createMSTeamsIngress } from "../msteams-ingress.js";
import type { MSTeamsIngressLifecycle } from "../msteams-ingress.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
import "./message-handler-mock-support.test-support.js";
import { getRuntimeApiMockState } from "./message-handler-mock-support.test-support.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";
import { buildChannelActivity, createMessageHandlerDeps } from "./message-handler.test-support.js";

const runtimeApiMockState = getRuntimeApiMockState();

function createLifecycle(): MSTeamsIngressLifecycle & {
  adoptedCount: () => number;
  abandonedCount: () => number;
} {
  let adopted = 0;
  let abandoned = 0;
  return {
    abortSignal: new AbortController().signal,
    onAdopted: async () => {
      adopted += 1;
    },
    onDeferred: () => {},
    onAdoptionFinalizing: () => {},
    onAbandoned: async () => {
      abandoned += 1;
    },
    adoptedCount: () => adopted,
    abandonedCount: () => abandoned,
  };
}

function context(activity: MSTeamsTurnContext["activity"]): MSTeamsTurnContext {
  return {
    activity,
    sendActivity: vi.fn(async () => ({ id: "sent" })),
    sendActivities: vi.fn(async () => []),
    updateActivity: vi.fn(async () => ({ id: "updated" })),
    deleteActivity: vi.fn(async () => {}),
  };
}

function directActivity(id: string, text: string): MSTeamsTurnContext["activity"] {
  return {
    ...buildChannelActivity({
      id,
      text,
      conversation: { id: "dm-conversation", conversationType: "personal" },
      channelData: {},
      entities: [],
    }),
  } as MSTeamsTurnContext["activity"];
}

function createHandler(cfg: OpenClawConfig) {
  const { deps } = createMessageHandlerDeps(cfg, {
    createInboundDebouncer,
    resolveInboundDebounceMs: vi.fn(() => 40),
  });
  return createMSTeamsMessageHandler(deps);
}

describe("Microsoft Teams drain claim ownership", () => {
  beforeEach(() => {
    runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher.mockClear();
  });

  it("defers a claimed activity and binds completion to reply adoption", async () => {
    const handler = createHandler({
      channels: { msteams: { dmPolicy: "open", allowFrom: ["*"] } },
    } as OpenClawConfig);
    const lifecycle = createLifecycle();

    const result = await handler(context(directActivity("activity-one", "hello")), lifecycle);

    expect(result).toEqual({ kind: "deferred" });
    await vi.waitFor(
      () => {
        expect(runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(
          1,
        );
        expect(lifecycle.adoptedCount()).toBe(1);
      },
      { timeout: 5_000 },
    );
    const dispatchParams = runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher.mock
      .calls[0]?.[0] as
      | { replyOptions?: { turnAdoptionLifecycle?: { admission?: string } } }
      | undefined;
    expect(dispatchParams?.replyOptions?.turnAdoptionLifecycle).toMatchObject({
      admission: "exclusive",
    });
    expect(lifecycle.abandonedCount()).toBe(0);
  });

  it("fans merged-flush adoption to every constituent claim", async () => {
    const handler = createHandler({
      messages: { inbound: { debounceMs: 40 } },
      channels: { msteams: { dmPolicy: "open", allowFrom: ["*"] } },
    } as OpenClawConfig);
    const first = createLifecycle();
    const second = createLifecycle();

    const results = [
      await handler(context(directActivity("activity-first", "part one")), first),
      await handler(context(directActivity("activity-second", "part two")), second),
    ];

    expect(results).toEqual([{ kind: "deferred" }, { kind: "deferred" }]);
    await vi.waitFor(
      () => {
        expect(runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(
          1,
        );
        expect(first.adoptedCount()).toBe(1);
        expect(second.adoptedCount()).toBe(1);
      },
      { timeout: 5_000 },
    );
    const dispatchParams = runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher.mock
      .calls[0]?.[0] as { ctx?: { BodyForAgent?: string } } | undefined;
    expect(dispatchParams?.ctx?.BodyForAgent).toContain("part one\npart two");
    expect(first.abandonedCount()).toBe(0);
    expect(second.abandonedCount()).toBe(0);
  });

  it("completes a gated no-dispatch turn instead of stalling its claim", async () => {
    const { deps } = createMessageHandlerDeps(
      {
        channels: {
          msteams: {
            groupPolicy: "open",
            requireMention: true,
          },
        },
      } as OpenClawConfig,
      {
        createInboundDebouncer,
        resolveInboundDebounceMs: vi.fn(() => 20),
      },
    );
    const handler = createMSTeamsMessageHandler(deps);
    const lifecycle = createLifecycle();
    const gatedActivity = buildChannelActivity({
      id: "activity-gated",
      text: "not for the bot",
      entities: [],
    }) as MSTeamsTurnContext["activity"];

    const result = await handler(context(gatedActivity), lifecycle);

    expect(result).toEqual({ kind: "deferred" });
    await vi.waitFor(() => expect(lifecycle.adoptedCount()).toBe(1), { timeout: 5_000 });
    expect(runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(lifecycle.abandonedCount()).toBe(0);
  });

  it("dead-letters an aged exhausted flush failure with its error and unblocks its lane", async () => {
    vi.useFakeTimers();
    let clock = Date.UTC(2026, 0, 2);
    vi.setSystemTime(clock);
    const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-failure-"));
    const stateDir = await fs.realpath(created);
    type Queue = NonNullable<Parameters<typeof createMSTeamsIngress>[0]["queue"]>;
    type Payload = Parameters<Queue["enqueue"]>[1];
    const queue = createChannelIngressQueueForTests<Payload>({
      channelId: "msteams",
      accountId: "test-app",
      stateDir,
      now: () => clock,
    });
    const failedActivity = directActivity("activity-original-error", "retry me");
    const nextActivity = directActivity("activity-after-error", "continue");
    await queue.enqueue(
      "activity-original-error",
      { version: 1, receivedAt: clock, rawActivity: JSON.stringify(failedActivity) },
      { laneKey: "dm-conversation", receivedAt: clock },
    );
    const dispatchMock = runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher;
    const priorImplementation = dispatchMock.getMockImplementation();
    const dispatchError = new Error("archived Microsoft Teams session rejected before admission");
    dispatchMock.mockRejectedValue(dispatchError);

    const createIntegratedIngress = () => {
      const handler = createHandler({
        channels: { msteams: { dmPolicy: "open", allowFrom: ["*"] } },
      } as OpenClawConfig);
      return createMSTeamsIngress({
        accountId: "test-app",
        queue,
        runtime: { error: vi.fn(), log: vi.fn() },
        dispatch: async (activity, lifecycle) => await handler(context(activity), lifecycle),
      });
    };
    const expectPendingAttempt = async (attempts: number) => {
      await vi.waitFor(async () => {
        const pending = await queue.listPending({ limit: "all" });
        expect(pending).toEqual([
          expect.objectContaining({
            id: "activity-original-error",
            attempts,
            lastAttemptAt: expect.any(Number),
            lastError: dispatchError.message,
          }),
        ]);
      });
    };

    try {
      const first = createIntegratedIngress();
      first.start();
      await expectPendingAttempt(1);
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      await first.stop();

      for (let attempt = 2; attempt < DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS; attempt += 1) {
        const claim = await queue.claim("activity-original-error", { ownerId: `seed-${attempt}` });
        if (!claim) {
          throw new Error(`Expected Microsoft Teams seed claim ${attempt}`);
        }
        await queue.release(claim, {
          lastError: dispatchError.message,
          releasedAt: clock,
        });
      }

      clock += DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS + 1;
      vi.setSystemTime(clock);
      const exhausted = createIntegratedIngress();
      exhausted.start();
      await vi.waitFor(async () => {
        expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
          {
            id: "activity-original-error",
            laneKey: "dm-conversation",
            reason: "retry-limit-exceeded",
            message: dispatchError.message,
          },
        ]);
      });

      if (!priorImplementation) {
        throw new Error("Missing Microsoft Teams test dispatch implementation");
      }
      dispatchMock.mockImplementation(priorImplementation);
      await exhausted.accept(nextActivity);
      await vi.waitFor(async () => {
        expect(dispatchMock).toHaveBeenCalledTimes(2);
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
      });
      await exhausted.stop();
    } finally {
      dispatchMock.mockReset();
      if (priorImplementation) {
        dispatchMock.mockImplementation(priorImplementation);
      }
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });
});
