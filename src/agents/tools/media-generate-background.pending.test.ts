import { beforeEach, expect, it, vi } from "vitest";
import { resetGeneratedMediaTaskActivityForTests } from "../../tasks/generated-media-task-activity.test-support.js";
import {
  createMediaGenerationTaskLifecycle,
  scheduleMediaGenerationTaskCompletion,
} from "./media-generate-background-shared.js";

const subagentAnnounceDeliveryMocks = vi.hoisted(() => ({
  deliverSubagentAnnouncement: vi.fn(),
  loadRequesterSessionEntry: vi.fn(() => ({ entry: undefined })),
}));
const detachedTaskRuntimeMocks = vi.hoisted(() => ({
  completeTaskRunByRunId: vi.fn(),
  createRunningTaskRun: vi.fn(() => ({ taskId: "queued-media-task" })),
  failTaskRunByRunId: vi.fn(),
  recordTaskRunProgressByRunId: vi.fn(),
}));
const observer = vi.hoisted(() => ({ controller: new AbortController() }));
vi.mock("../../infra/session-delivery-queue-runtime.js", () => ({
  observeSessionDeliveryRuntime: async <T>(run: (signal: AbortSignal) => Promise<T>) =>
    await run(observer.controller.signal),
}));
vi.mock("../subagents/announce/subagent-announce-delivery.js", () => subagentAnnounceDeliveryMocks);
vi.mock("../../tasks/detached-task-runtime.js", () => detachedTaskRuntimeMocks);
vi.mock("../../tasks/cron-run-continuation-cleanup.js", () => ({
  removeCronRunContinuationSessionIfIdle: async () => {},
}));

beforeEach(() => {
  observer.controller = new AbortController();
  resetGeneratedMediaTaskActivityForTests();
  vi.clearAllMocks();
  subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockReset();
});

function createImageMediaLifecycle() {
  return createMediaGenerationTaskLifecycle({
    toolName: "image_generate",
    taskKind: "image_generation",
    label: "Image generation",
    queuedProgressSummary: "Queued image generation",
    generatedLabel: "image",
    failureProgressSummary: "Image generation failed",
    eventSource: "image_generation",
    announceType: "image generation task",
    completionLabel: "image",
  });
}

it.each([
  { handoff: "failed", generationFails: false },
  { handoff: "unconfirmed", generationFails: false },
  { handoff: "accepted", generationFails: false },
  { handoff: "failed", generationFails: true },
  { handoff: "unconfirmed", generationFails: true },
  { handoff: "accepted", generationFails: true },
])(
  "requires queue acceptance before deferring terminal state on shutdown ($handoff, generation fails: $generationFails)",
  async ({ handoff, generationFails }) => {
    vi.useFakeTimers();
    let background: Promise<void> | undefined;
    try {
      const lifecycle = createImageMediaLifecycle();
      const onWakeFailure = vi.fn();
      const generationError = new Error("original generation failure");
      let attempts = 0;
      subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockImplementation(async () => {
        if (++attempts === 1 && handoff === "accepted") {
          return { delivered: false, disposition: "session_queued" };
        }
        observer.controller.abort(new Error("queue runtime stopped"));
        if (handoff === "unconfirmed") {
          return { delivered: false, reason: "completion_handoff_pending" };
        }
        throw new Error("handoff store unavailable");
      });
      scheduleMediaGenerationTaskCompletion({
        lifecycle,
        handle: lifecycle.createTaskRun({
          sessionKey: "agent:main:handoff-proof",
          prompt: "proof",
        }),
        scheduleBackgroundWork: (work) => {
          background = work();
        },
        progressSummary: "Generating image",
        toolName: "Image generation",
        onWakeFailure,
        run: async () => {
          if (generationFails) {
            throw generationError;
          }
          return {
            provider: "fixture",
            model: "image",
            count: 1,
            wakeResult: "ready",
            attachments: [{ type: "image" as const, path: "/tmp/retained-proof.png" }],
          };
        },
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await background;
      if (handoff === "accepted") {
        expect(detachedTaskRuntimeMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
        expect(detachedTaskRuntimeMocks.failTaskRunByRunId).not.toHaveBeenCalled();
        expect(onWakeFailure).not.toHaveBeenCalled();
      } else {
        expect(onWakeFailure).toHaveBeenCalledOnce();
        if (generationFails) {
          expect(detachedTaskRuntimeMocks.failTaskRunByRunId).toHaveBeenCalledWith(
            expect.objectContaining({ error: generationError.message }),
          );
          expect(detachedTaskRuntimeMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
        } else {
          expect(detachedTaskRuntimeMocks.completeTaskRunByRunId).toHaveBeenCalledWith(
            expect.objectContaining({
              terminalOutcome: "blocked",
              terminalSummary: expect.stringContaining('path="/tmp/retained-proof.png"'),
            }),
          );
          expect(detachedTaskRuntimeMocks.failTaskRunByRunId).not.toHaveBeenCalled();
        }
      }
    } finally {
      observer.controller.abort();
      await background;
      vi.useRealTimers();
    }
  },
);

it.each([
  { generationFails: false, deliveryFails: false, stopAfterDelivery: false },
  { generationFails: false, deliveryFails: true, stopAfterDelivery: false },
  { generationFails: true, deliveryFails: false, stopAfterDelivery: false },
  { generationFails: true, deliveryFails: true, stopAfterDelivery: false },
  { generationFails: false, deliveryFails: false, stopAfterDelivery: true },
  { generationFails: true, deliveryFails: false, stopAfterDelivery: true },
])(
  "preserves late settlement (generation fails: $generationFails, delivery fails: $deliveryFails, stop after delivery: $stopAfterDelivery)",
  async ({ generationFails, deliveryFails, stopAfterDelivery }) => {
    vi.useFakeTimers();
    let backgroundWork: Promise<void> | undefined;
    try {
      const scheduled: Array<() => Promise<void>> = [];
      const onWakeFailure = vi.fn();
      const generationError = new Error("provider returned no images");
      subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValue({
        delivered: false,
        path: "queued",
        disposition: "session_queued",
      });
      const lifecycle = createImageMediaLifecycle();
      const handle = lifecycle.createTaskRun({
        sessionKey: "agent:main:discord:channel:123",
        prompt: "delayed queue proof",
      });
      scheduleMediaGenerationTaskCompletion({
        lifecycle,
        handle,
        scheduleBackgroundWork: (work) => scheduled.push(work),
        progressSummary: "Generating image",
        toolName: "Image generation",
        onWakeFailure,
        run: async () => {
          if (generationFails) {
            throw generationError;
          }
          return {
            provider: "openai",
            model: "gpt-image-1",
            count: 1,
            wakeResult: "generated",
            attachments: [{ type: "image" as const, path: "/tmp/retained-proof.png" }],
          };
        },
      });
      backgroundWork = scheduled[0]?.();
      await vi.advanceTimersByTimeAsync(122_000);

      expect(detachedTaskRuntimeMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
      expect(detachedTaskRuntimeMocks.failTaskRunByRunId).not.toHaveBeenCalled();
      expect(onWakeFailure).not.toHaveBeenCalled();
      expect(detachedTaskRuntimeMocks.recordTaskRunProgressByRunId).toHaveBeenLastCalledWith(
        expect.objectContaining({ progressSummary: "Media task finished; completion queued" }),
      );

      subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockImplementation(async () => {
        if (stopAfterDelivery) {
          observer.controller.abort();
        }
        return deliveryFails
          ? { delivered: false, path: "queued", disposition: "permanent_failure" }
          : { delivered: true, path: "queued", disposition: "delivered" };
      });
      await vi.advanceTimersByTimeAsync(2_000);
      await backgroundWork;
      if (generationFails) {
        expect(detachedTaskRuntimeMocks.failTaskRunByRunId).toHaveBeenCalledWith(
          expect.objectContaining({ error: generationError.message }),
        );
        expect(detachedTaskRuntimeMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
      } else {
        expect(detachedTaskRuntimeMocks.completeTaskRunByRunId).toHaveBeenCalledWith(
          expect.objectContaining(
            deliveryFails
              ? {
                  terminalOutcome: "blocked",
                  terminalSummary: expect.stringContaining('path="/tmp/retained-proof.png"'),
                }
              : { terminalOutcome: undefined },
          ),
        );
        expect(detachedTaskRuntimeMocks.failTaskRunByRunId).not.toHaveBeenCalled();
      }
    } finally {
      // Join the admitted waiter before restoring the clock, including assertion failures.
      subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValue({
        delivered: true,
        path: "queued",
      });
      await vi.advanceTimersByTimeAsync(2_000);
      await backgroundWork;
      vi.useRealTimers();
    }
  },
);

it.each([false, true])(
  "stops the local waiter on shutdown without failing accepted delivery (generation failed: %s)",
  async (generationFails) => {
    vi.useFakeTimers();
    let backgroundWork: Promise<void> | undefined;
    try {
      const scheduled: Array<() => Promise<void>> = [];
      const lifecycle = createImageMediaLifecycle();
      const onWakeFailure = vi.fn();
      subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValue({
        delivered: false,
        disposition: "session_queued",
      });
      scheduleMediaGenerationTaskCompletion({
        lifecycle,
        handle: lifecycle.createTaskRun({
          sessionKey: "agent:main:shutdown-proof",
          prompt: "proof",
        }),
        scheduleBackgroundWork: (work) => scheduled.push(work),
        progressSummary: "Generating image",
        toolName: "Image generation",
        onWakeFailure,
        run: async () => {
          if (generationFails) {
            throw new Error("provider generation failed");
          }
          return { provider: "fixture", model: "image", count: 1, wakeResult: "ready" };
        },
      });
      backgroundWork = scheduled[0]?.();
      await vi.advanceTimersByTimeAsync(1_000);
      observer.controller.abort();
      await backgroundWork;
      const attempts = subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement.mock.calls.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(subagentAnnounceDeliveryMocks.deliverSubagentAnnouncement).toHaveBeenCalledTimes(
        attempts,
      );
      expect(detachedTaskRuntimeMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
      expect(detachedTaskRuntimeMocks.failTaskRunByRunId).not.toHaveBeenCalled();
      expect(onWakeFailure).not.toHaveBeenCalled();
    } finally {
      observer.controller.abort();
      await backgroundWork;
      vi.useRealTimers();
    }
  },
);
