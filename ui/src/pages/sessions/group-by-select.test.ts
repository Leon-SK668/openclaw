/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderSessionsGroupBySelect } from "./group-by-select.ts";

describe("sessions group-by select", () => {
  it("restores its controlled value after the DOM value drifts", async () => {
    const container = document.createElement("div");
    const props = {
      groupBy: "agent" as const,
      personGroupingAvailable: true,
      onGroupByChange: () => undefined,
    };
    render(renderSessionsGroupBySelect(props), container);
    await Promise.resolve();

    const select = container.querySelector<HTMLSelectElement>(".session-groupby__select");
    expect(select?.value).toBe("agent");
    select!.value = "none";

    render(renderSessionsGroupBySelect(props), container);
    await Promise.resolve();

    expect(container.querySelector<HTMLSelectElement>(".session-groupby__select")?.value).toBe(
      "agent",
    );
  });
});
