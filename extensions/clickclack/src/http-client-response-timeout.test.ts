import { describe, expect, it, vi } from "vitest";
import { createClickClackClient } from "./http-client.js";

function createSignalAbortedJsonResponse(signal: AbortSignal): {
  response: Response;
  wasAborted: () => boolean;
} {
  let aborted = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const abortBody = () => {
        aborted = true;
        controller.error(signal.reason ?? new Error("body aborted"));
      };
      if (signal.aborted) {
        abortBody();
        return;
      }
      signal.addEventListener("abort", abortBody, { once: true });
    },
    async pull() {
      await new Promise<void>(() => {});
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    wasAborted: () => aborted,
  };
}

describe("ClickClack HTTP response timeout", () => {
  it("keeps the REST deadline active while reading a hanging response body", async () => {
    vi.useFakeTimers();
    let body: ReturnType<typeof createSignalAbortedJsonResponse> | undefined;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) {
        throw new Error("expected ClickClack client to pass an AbortSignal");
      }
      const responseBody = createSignalAbortedJsonResponse(signal);
      body = responseBody;
      return responseBody.response;
    });
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "placeholder",
      fetch: fetchMock as unknown as typeof fetch,
    });

    try {
      const pending = client.me().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(30_000);
      const error = await pending;

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("request timed out");
      expect(body?.wasAborted()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not add implicit deadlines to message creates", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ message: { id: "msg_1" } }, { status: 201 }),
    );
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "placeholder",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.createChannelMessage("chn_1", "channel");
    await client.createThreadReply("msg_root", "thread");
    await client.createDirectMessage("dm_1", "direct");

    expect(fetchMock.mock.calls.map((call) => call[1]?.signal)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("does not add an implicit deadline to multipart uploads", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        upload: {
          id: "upl_1",
          workspace_id: "wsp_1",
          owner_id: "usr_1",
          filename: "proof.txt",
          content_type: "text/plain",
          byte_size: 5,
          width: 0,
          height: 0,
          duration_ms: 0,
          created_at: "2026-08-16T00:00:00Z",
        },
      }),
    );
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "placeholder",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.createUpload({
      workspaceId: "wsp_1",
      buffer: Buffer.from("proof"),
      filename: "proof.txt",
      contentType: "text/plain",
    });

    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeUndefined();
  });
});
