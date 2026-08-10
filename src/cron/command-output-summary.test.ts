import { describe, expect, it } from "vitest";
import {
  buildCronCommandSummary,
  isCronCommandActionCriticalLine,
  redactCronCommandSummaryForExternalDelivery,
} from "./command-output-summary.js";

describe("cron command output summaries", () => {
  it("prepends preserved action lines that were truncated out of the captured tail", () => {
    const summary = buildCronCommandSummary({
      stdout: "tail only",
      stderr: "",
      preservedStdoutLines: ["Visit https://example.com/device and enter code ABCD-EFGH"],
    });

    expect(summary).toBe(
      "action-required output preserved:\nVisit https://example.com/device and enter code ABCD-EFGH\n\ntail only",
    );
  });

  it("redacts action-required URLs and codes before external cron delivery", () => {
    const summary =
      "action-required output preserved:\nVisit https://example.com/device or www.example.com/device and enter code ABCD-EFGH\n\ncompleted";

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "action-required output preserved:\nVisit [redacted-url] or [redacted-url] and enter code [redacted-code]\n\ncompleted",
    );
  });

  it("redacts split URLs and bare codes inside preserved action blocks", () => {
    const summary = buildCronCommandSummary({
      stdout: "Build 123456 is complete",
      stderr: "",
      preservedStdoutLines: [
        "Visit this URL:",
        "https://example.com/continue?session=fixture-secret",
        "Use this code:",
        "ABCDEF12",
      ],
    });

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "action-required output preserved:\nVisit this URL:\n[redacted-url]\nUse this code:\n[redacted-code]\n\nBuild 123456 is complete",
    );
  });

  it("carries a preserved URL handoff through the generated stdout header", () => {
    const summary = buildCronCommandSummary({
      stdout: "https://example.com/continue?session=fixture-secret\nABCDEF12",
      stderr: "diagnostic output",
      preservedStdoutLines: ["Open this URL to continue:"],
    });

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      [
        "action-required output preserved:",
        "Open this URL to continue:",
        "",
        "stdout:",
        "[redacted-url]",
        "[redacted-code]",
        "",
        "stderr:",
        "diagnostic output",
      ].join("\n"),
    );
  });

  it("redacts split URLs and bare codes after action lines in the captured tail", () => {
    const summary = buildCronCommandSummary({
      stdout:
        "Authorization code:\n\nOpen this URL to continue:\nhttps://example.com/continue?session=fixture-secret\n\nABCDEF12\n\nBuild 123456 is complete\nReference ABCDEF12\nReference ABCDEF1234\nReference ZXCVBN12",
      stderr: "",
      preservedStdoutLines: ["Authorization code:"],
    });

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "Authorization code:\n\nOpen this URL to continue:\n[redacted-url]\n\n[redacted-code]\n\nBuild 123456 is complete\nReference [redacted-code]\nReference ABCDEF1234\nReference ZXCVBN12",
    );
  });

  it("leaves URL and code-shaped output unchanged without action context", () => {
    const summary =
      "Report: https://example.com/continue?session=public\nBuild 123456 is complete\nReference ABCDEF12";

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(summary);
  });

  it("preserves standalone statuses and identifiers in gated summaries", () => {
    const summary =
      "action-required output preserved:\nEnter code 123456\n\nSUCCESS\nFAILED\nSKIPPED\nCOMPLETE\n20240115\nMAKE ERROR";

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "action-required output preserved:\nEnter code [redacted-code]\n\nSUCCESS\nFAILED\nSKIPPED\nCOMPLETE\n20240115\nMAKE ERROR",
    );
  });

  it("preserves status words inside action blocks", () => {
    const summary =
      "action-required output preserved:\nStatus: FAILED\nSTATUS FAILED\nJob COMPLETE\nMAKE ERROR\nALL TESTS PASSED\nFirst copy your one-time code: 1A2B-3C4D\nYour code: 482913\nThen type WDJBMJHT into the browser\nThen enter 739214 in the browser\nEnter code ABCDEF12\n\nReference ABCDEF12";

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "action-required output preserved:\nStatus: FAILED\nSTATUS FAILED\nJob COMPLETE\nMAKE ERROR\nALL TESTS PASSED\nFirst copy your one-time code: [redacted-code]\nYour code: [redacted-code]\nThen type [redacted-code] into the browser\nThen enter [redacted-code] in the browser\nEnter code [redacted-code]\n\nReference [redacted-code]",
    );
  });

  it("carries URL action context to a following letters-only code", () => {
    const summary = "action-required output preserved:\nGo to https://example.com/device\nWDJBMJHT";

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "action-required output preserved:\nGo to [redacted-url]\n[redacted-code]",
    );
  });

  it("carries an explicit URL handoff to a standalone URL and bare code", () => {
    const summary = [
      "Open this URL to continue:",
      "https://example.com/continue?session=fixture-secret",
      "ABCDEF12",
    ].join("\n");

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "Open this URL to continue:\n[redacted-url]\n[redacted-code]",
    );
  });

  it("does not treat an ordinary code prompt plus URL as a URL handoff", () => {
    const summary = ["Enter code:", "https://docs.example.com/help", "123456"].join("\n");

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "Enter code:\n[redacted-url]\n123456",
    );
  });

  it("redacts an embedded letters-only code in the first action continuation", () => {
    const summary = "Visit https://example.com/device\nThen type WDJBMJHT in the browser";

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "Visit [redacted-url]\nThen type [redacted-code] in the browser",
    );
  });

  it.each([
    ["Enter this code:", "SUCCESS", "Enter this code:"],
    ["Visit https://example.com/device", "FAILED", "Visit [redacted-url]"],
  ])(
    "preserves terminal status after action prompt %s",
    (prompt, status, redactedPrompt) => {
      const summary = `${prompt}\n${status}`;

      expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
        `${redactedPrompt}\n${status}`,
      );
    },
  );

  it("keeps bounded prompt context across a visible terminal status", () => {
    const summary = "Visit https://example.com/device\nSUCCESS\nWDJBMJHT\nDEBUGGING";

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "Visit [redacted-url]\nSUCCESS\n[redacted-code]\nDEBUGGING",
    );
  });

  it.each(["WDJBMJHT", "482913", "ABCD-EFGH"])(
    "redacts a plain Code label in active action context: %s",
    (code) => {
      const summary = `Visit https://example.com/device\nCode: ${code}`;

      expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
        "Visit [redacted-url]\nCode: [redacted-code]",
      );
    },
  );

  it("does not redact a plain Code label after action context expires", () => {
    const summary = "Visit https://example.com/device\nDetails are available\nCode: WDJBMJHT";

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "Visit [redacted-url]\nDetails are available\nCode: WDJBMJHT",
    );
  });

  it("redacts letters-only codes embedded in captured-tail action lines", () => {
    const summary = "Go to https://example.com/device and type WDJBMJHT";

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "Go to [redacted-url] and type [redacted-code]",
    );
  });

  it("redacts letters-only codes after qualified captured-tail prompts", () => {
    const summary =
      "Visit https://example.com/device and enter the following code to continue: WDJBMJHT";

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "Visit [redacted-url] and enter the following code to continue: [redacted-code]",
    );
  });

  it("preserves uppercase prose after an imperative in action lines", () => {
    const summary = "Go to https://example.com/device and enter DEBUGGING mode";

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "Go to [redacted-url] and enter DEBUGGING mode",
    );
  });

  it("preserves uppercase prose and redacts clear codes in action blocks", () => {
    const summary = [
      "action-required output preserved:",
      "Visit https://example.com/device and enter DEBUGGING mode",
      "Then type WDJBMJHT in the browser",
      "123456",
      "AB12CD34",
      "A1B2-C3D4",
    ].join("\n");

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      [
        "action-required output preserved:",
        "Visit [redacted-url] and enter DEBUGGING mode",
        "Then type [redacted-code] in the browser",
        "[redacted-code]",
        "[redacted-code]",
        "[redacted-code]",
      ].join("\n"),
    );
  });

  it("redacts a letters-only code after an action prompt", () => {
    const summary = "Enter code:\n\nWDJBMJHT\n\nSUCCESS";

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "Enter code:\n\n[redacted-code]\n\nSUCCESS",
    );
  });

  it("does not let an uppercase instruction word cancel prompt carry", () => {
    const summary = "Enter code from the CONSOLE\n\nWDJBMJHT";

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "Enter code from the CONSOLE\n\n[redacted-code]",
    );
  });

  it("carries a code prompt across one explanatory line", () => {
    const summary = "Enter this code:\n(expires in 15 minutes)\nWDJBMJHT\n\nSUCCESS";

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "Enter this code:\n(expires in 15 minutes)\n[redacted-code]\n\nSUCCESS",
    );
  });

  it("does not carry a code prompt across bracketed logs or multiple explanations", () => {
    const bracketedLog = "Enter this code:\n[INFO]\nDEPLOYED";
    const repeatedExplanations = "Enter this code:\n(first note)\n(second note)\nUPLOADED";

    expect(redactCronCommandSummaryForExternalDelivery(bracketedLog)).toBe(bracketedLog);
    expect(redactCronCommandSummaryForExternalDelivery(repeatedExplanations)).toBe(
      repeatedExplanations,
    );
  });

  it("does not redact bare codes after prompt context expires", () => {
    const summary = [
      "Enter code Z9X8-Y7W6",
      "build completed",
      "654321",
      "AB12CD34",
      "A1B2-C3D4",
    ].join("\n");

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "Enter code [redacted-code]\nbuild completed\n654321\nAB12CD34\nA1B2-C3D4",
    );
  });

  it("redacts bare unambiguous codes in an active prompt continuation", () => {
    const numeric = "Enter code:\n(expires in 15 minutes)\n123456";
    const mixed = "Enter code:\n(expires in 15 minutes)\nAB12CD34";
    const separated = "Enter code:\n(expires in 15 minutes)\nA1B2-C3D4";

    expect(redactCronCommandSummaryForExternalDelivery(numeric)).toBe(
      "Enter code:\n(expires in 15 minutes)\n[redacted-code]",
    );
    expect(redactCronCommandSummaryForExternalDelivery(mixed)).toBe(
      "Enter code:\n(expires in 15 minutes)\n[redacted-code]",
    );
    expect(redactCronCommandSummaryForExternalDelivery(separated)).toBe(
      "Enter code:\n(expires in 15 minutes)\n[redacted-code]",
    );
  });

  it.each([
    "SUCCESS",
    "FAILED",
    "COMPLETED",
    "CANCELLED",
    "FINISHED",
    "TIMEOUT",
    "WARNING",
    "PASSED",
    "QUEUED",
    "STARTED",
    "WAITING",
  ])("preserves terminal status %s after a prompt explanation", (status) => {
    const summary = `Enter this code:\n(waiting for approval)\n${status}`;

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(summary);
  });

  it.each(["STATUS FAILED", "TASK FAILED", "TEST FAILED", "MAKE ERROR"])(
    "preserves terminal diagnostic phrase %s after a prompt explanation",
    (status) => {
      const summary = `Enter this code:\n(waiting for approval)\n${status}`;

      expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(summary);
    },
  );

  it("keeps the action classifier focused on credential prompts", () => {
    expect(isCronCommandActionCriticalLine("Use this code:")).toBe(true);
    expect(isCronCommandActionCriticalLine("Your code: 482913")).toBe(true);
    expect(isCronCommandActionCriticalLine("Your code is ABCD-EFGH")).toBe(true);
    expect(isCronCommandActionCriticalLine("Your code is 482913")).toBe(true);
    expect(isCronCommandActionCriticalLine("Your device code is ABCD-EFGH")).toBe(true);
    expect(isCronCommandActionCriticalLine("Your device code is WDJBMJHT")).toBe(true);
    expect(isCronCommandActionCriticalLine("Open this URL to continue:")).toBe(true);
    expect(isCronCommandActionCriticalLine("Code: WDJBMJHT")).toBe(false);
    expect(isCronCommandActionCriticalLine("Use the code from the previous step")).toBe(false);
    expect(isCronCommandActionCriticalLine("Your code compiles successfully")).toBe(false);
    expect(isCronCommandActionCriticalLine("Your code is already formatted")).toBe(false);
    expect(isCronCommandActionCriticalLine("YOUR CODE IS BROKEN")).toBe(false);
    expect(isCronCommandActionCriticalLine("YOUR CODE IS ALREADY FORMATTED")).toBe(false);
  });

  it("redacts a space-separated letters code after a prompt", () => {
    const summary = "Enter this code:\nABCD EFGH";

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "Enter this code:\n[redacted-code]",
    );
  });

  it.each(["MAKE TEST FAILED", "OPEN THE BROWSER"])(
    "does not treat uppercase prompt-adjacent prose as a code: %s",
    (line) => {
      const summary = `Enter this code:\n${line}\n${line}`;

      expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(summary);
    },
  );

  it("redacts values attached to qualified and status-shaped code prompts", () => {
    const summary =
      "Your device code is ABCD-EFGH\nYour verification code is WDJBMJHT\nEnter code FAILED";

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "Your device code is [redacted-code]\nYour verification code is [redacted-code]\nEnter code [redacted-code]",
    );
  });

  it("uses preserved-block redaction for prompt-bearing lines", () => {
    const summary =
      "action-required output preserved:\nThen enter your code, type WDJBMJHT\nYour device code is ABCDEFGH\n\nReference WDJBMJHT";

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "action-required output preserved:\nThen enter your code, type [redacted-code]\nYour device code is [redacted-code]\n\nReference [redacted-code]",
    );
  });

  it("redacts bare numeric and letters codes inside preserved action blocks", () => {
    const numeric = "action-required output preserved:\nUse this code:\n123456";
    const letters = "action-required output preserved:\nUse this code:\nWDJBMJHT";

    expect(redactCronCommandSummaryForExternalDelivery(numeric)).toBe(
      "action-required output preserved:\nUse this code:\n[redacted-code]",
    );
    expect(redactCronCommandSummaryForExternalDelivery(letters)).toBe(
      "action-required output preserved:\nUse this code:\n[redacted-code]",
    );
  });

  it("does not mistake uppercase prompt text for the code it introduces", () => {
    const summary = "ENTER THIS CODE:\nWDJBMJHT\nCOPY THIS CODE ABCD EFGH";

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "ENTER THIS CODE:\n[redacted-code]\nCOPY THIS CODE [redacted-code]",
    );
  });

  it("carries a preserved action prompt to the first captured tail line", () => {
    const summary = buildCronCommandSummary({
      stdout: "WDJBMJHT\n\nSUCCESS",
      stderr: "",
      preservedStdoutLines: ["Enter this code:"],
    });

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "action-required output preserved:\nEnter this code:\n\n[redacted-code]\n\nSUCCESS",
    );
  });

  it("redacts numeric and unseparated codes on action-required lines", () => {
    const summary =
      "action-required output preserved:\nEnter code 123456\nCopy this code ABCDEF12\n\nBuild 123456 is complete\nBuild 654321 is complete";

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "action-required output preserved:\nEnter code [redacted-code]\nCopy this code [redacted-code]\n\nBuild [redacted-code] is complete\nBuild 654321 is complete",
    );
  });

  it("redacts exact numeric and letters-only code repeats after classification", () => {
    const summary =
      "Enter code 123456\nReference 123456\nUse this code:\nWDJBMJHT\nReference WDJBMJHT";

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "Enter code [redacted-code]\nReference [redacted-code]\nUse this code:\n[redacted-code]\nReference [redacted-code]",
    );
  });

  it("redacts repeated codes even when embedded in larger identifiers", () => {
    const summary =
      "Enter code ABCD-EFGH\n\nReference ABCD-EFGH\nReference ABCD-EFGH SUCCESS\nReference ABCD-EFGH NOW\nTOKEN ABCD-EFGH\nReference ABCD-EFGH-IJKL\nReference IJKL-ABCD-EFGH\nsession_ABCD-EFGH_id\nrunABCD-EFGHlog\nbuild-ABCD-EFGH-output";

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "Enter code [redacted-code]\n\nReference [redacted-code]\nReference [redacted-code] SUCCESS\nReference [redacted-code] NOW\nTOKEN [redacted-code]\nReference [redacted-code]\nReference [redacted-code]\nsession_[redacted-code]_id\nrun[redacted-code]log\nbuild-[redacted-code]-output",
    );
  });

  it("does not let status words on action lines poison later output", () => {
    const summary =
      "Enter code ABCD-EFGH - STATUS PENDING\nStatus: FAILED\nJob COMPLETE\nTASK_PENDING_AT";

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "Enter code [redacted-code] - STATUS PENDING\nStatus: FAILED\nJob COMPLETE\nTASK_PENDING_AT",
    );
  });

  it("does not propagate a prompt-attached status-shaped code", () => {
    const summary = "Enter code FAILED\nJob FAILED";

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "Enter code [redacted-code]\nJob FAILED",
    );
  });

  it("masks token assignments on action-required lines before external delivery", () => {
    const summary =
      "action-required output preserved:\nLog in with token=opaque-secret-value\n\nLog in with token=opaque-secret-value";

    const redacted = redactCronCommandSummaryForExternalDelivery(summary);

    expect(redacted).not.toContain("opaque-secret-value");
    expect(redacted).toContain("token=***");
  });

  it("masks token assignments on plain lines only when the summary gate is active", () => {
    const plainTail = "command output:\ntoken=opaque-secret-value";
    const gatedSummary = `Authorization code:\n\n${plainTail}`;

    expect(redactCronCommandSummaryForExternalDelivery(gatedSummary)).toBe(
      "Authorization code:\n\ncommand output:\ntoken=***",
    );
    expect(redactCronCommandSummaryForExternalDelivery(plainTail)).toBe(plainTail);
  });
});
