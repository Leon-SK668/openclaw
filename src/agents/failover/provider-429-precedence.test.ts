import { describe, expect, it, vi } from "vitest";
import { classifyFailoverSignal } from "./classify.js";

describe("prepared provider HTTP 429 precedence", () => {
  it.each(["rate_limit", "billing"] as const)("retains the owner's %s decision", (reason) => {
    const classifyFailoverReason = vi.fn(() => reason);
    expect(
      classifyFailoverSignal(
        {
          provider: "custom-route",
          status: 429,
          code: "OWNER_QUOTA",
          message: "insufficient_quota",
        },
        { providerPlugin: { id: "prepared-owner", classifyFailoverReason } },
      ),
    ).toEqual({ kind: "reason", reason });
    expect(classifyFailoverReason).toHaveBeenCalledOnce();
    expect(classifyFailoverReason).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "prepared-owner",
        status: 429,
        code: "OWNER_QUOTA",
      }),
    );
  });

  it("keeps generic billing and rate limits when no provider decision is available", () => {
    for (const providerPlugin of [
      null,
      { id: "unknown-owner", classifyFailoverReason: () => undefined },
    ]) {
      expect(
        classifyFailoverSignal(
          { provider: "custom-route", status: 429, message: "insufficient_quota" },
          { providerPlugin },
        ),
      ).toEqual({ kind: "reason", reason: "billing" });
      expect(
        classifyFailoverSignal(
          { provider: "custom-route", status: 429, message: "Too many requests" },
          { providerPlugin },
        ),
      ).toEqual({ kind: "reason", reason: "rate_limit" });
    }
  });
});
