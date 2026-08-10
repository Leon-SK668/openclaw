import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { redactToolPayloadText } from "../logging/redact.js";

const MAX_PRESERVED_ACTION_LINES = 12;
const ACTION_REQUIRED_OUTPUT_HEADER = "action-required output preserved:";
const CODE_PROMPT_MASK_CHAR = "\0";
const QUALIFIED_YOUR_CODE_IS_PATTERN =
  /\byour\s+(?:(?:one[- ]time|verification|device|user|authorization|auth|login|otp)\s+)code\s+is\s*:?\s*(\S+?)(?=[.,;!?]?(?:\s|$))/i;
const YOUR_CODE_IS_PATTERN = /\byour\s+code\s+is\s*:?\s*(\S+?)(?=[.,;!?]?(?:\s|$))/i;
const CODE_PROMPT_PATTERNS = [
  /\b(device|user|verification|authorization|auth|login|one[- ]time|otp)\s+code\b/i,
  /\b(?:log(?:\s|-)?in|auth(?:enticate|orize))\s+(?:with|using)\s+(?:this\s+)?code\b/i,
  /\byour\s+(?:(?:one[- ]time|verification|device)\s+)?code\s*[:=]/i,
  /\b(?:enter|copy)\s+(?:(?:the|this|your)\s+)?(?:(?:following|one[- ]time|verification|device)\s+)?code(?:\s+to\s+continue)?\b/i,
  /\buse\s+(?:(?:this|your)\s+)?(?:(?:one[- ]time|verification|device)\s+)?code\b/i,
];
const URL_HANDOFF_LINE_PATTERN =
  /\b(?:visit|open)\s+(?:this|the)\s+(?:url|link)(?:\s+to\s+continue)?\b/i;
const ACTION_LINE_PATTERNS = [
  ...CODE_PROMPT_PATTERNS,
  /\bvisit\s+(?:https?:\/\/|www\.)/i,
  /\bopen\s+(?:https?:\/\/|www\.)/i,
  URL_HANDOFF_LINE_PATTERN,
  /\bbrowser\s+(?:to|at)\s+(?:https?:\/\/|www\.)/i,
  /\blog(?:\s|-)?in\s+(?:at|to|with)\b/i,
  /\bauth(?:enticate|orize)\s+(?:at|with|using)\b/i,
  /\bhttps?:\/\/[^\s]+\/(?:device|activate|login|oauth|authorize|auth)\b/i,
];
const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/gi;
const REDACTED_URL = "[redacted-url]";
// docs.openclaw.ai is the product-owned public information origin; it has no
// private bearer routes. Arbitrary external hosts remain fail-closed.
const PUBLIC_INFORMATION_URL_HOST = "docs.openclaw.ai";
const URL_TRAILING_PROSE_CHARS = new Set([
  ".",
  ",",
  ";",
  ":",
  "!",
  "?",
  "'",
  '"',
  "]",
  "}",
  ">",
  "`",
]);
const URL_PROSE_SUFFIX_CHARS = new Set([...URL_TRAILING_PROSE_CHARS, ")"]);
const STANDALONE_URL_LINE_PATTERN = /^\s*(?:https?:\/\/|www\.)\S+\s*$/i;
const GENERATED_OUTPUT_SECTION_HEADER_PATTERN = /^stdout:$/i;
const CODE_CANDIDATE_PATTERN = /\b(?:[A-Z0-9]{4}(?:[- ][A-Z0-9]{3,8}){1,4}|[A-Z0-9]{6,12})\b/g;
const GROUPED_CODE_TOKEN_PATTERN =
  /(?<![A-Z0-9])[A-Z0-9]{3,12}(?:(?:-| )[A-Z0-9]{3,12})+(?![A-Z0-9])/g;
const PLAIN_CODE_TOKEN_PATTERN = /(?<![A-Z0-9])[A-Z0-9]{6,12}(?![A-Z0-9])/g;
const MAX_CODE_TOKEN_GROUPS = 5;
const BARE_SEPARATED_CODE_PATTERN =
  /^(\s*)(?=[A-Z0-9 -]*(?:\d|-))[A-Z0-9]{4}(?:[- ][A-Z0-9]{3,8}){1,4}(\s*)$/;
const BARE_MIXED_CODE_PATTERN =
  /^(\s*)(?=[A-Z0-9]{6,12}\s*$)(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{6,12}(\s*)$/;
const BARE_NUMERIC_CODE_PATTERN = /^(\s*)\d{6}(\s*)$/;
const BARE_PROMPT_NUMERIC_CODE_PATTERN = /^(\s*)\d{6,12}(\s*)$/;
const BARE_LETTERS_CODE_PATTERN = /^(\s*)[A-Z]{6,12}(\s*)$/;
const BARE_SPACE_SEPARATED_LETTERS_CODE_PATTERN = /^(\s*)[A-Z]{4} [A-Z]{4}(\s*)$/;
const CODE_PROMPT_EXPLANATION_PATTERN = /^\([^\r\n]{1,160}\)$/;
const DIRECT_CODE_VALUE_PREFIX_PATTERN = /\b(?:enter|paste|type)\s+$/i;
const DIRECT_CODE_VALUE_SUFFIX_PATTERN = /^\s*(?:[.,;:!?)]\s*)?$/;
const CONTINUATION_CODE_VALUE_SUFFIX_PATTERN =
  /^\s+(?:(?:in|into|on)\s+(?:the\s+)?(?:browser|app|client)|to\s+continue)\b/i;
const PLAIN_CODE_LABEL_PREFIX_PATTERN = /^\s*code\s*[:=]\s*$/i;
const CODE_VALUE_PATTERN = /^(?:[A-Z0-9]{4}(?:-[A-Z0-9]{3,8}){1,4}|[A-Z0-9]{6,12})$/;
const INLINE_CODE_VALUE_PATTERN =
  /^(?=[A-Z0-9-]*(?:\d|-))(?:[A-Z0-9]{4}(?:-[A-Z0-9]{3,8}){1,4}|[A-Z0-9]{6,12})$/;
// Common terminal labels are command diagnostics, not device codes.
const CRON_OUTPUT_STATUS_LINE_PATTERN =
  /^(?:status|result|(?:(?:status|job|result|test|tests|make|task|command|process|run|build|step)(?:\s*:\s*|\s+))?(?:success|succeeded|failed|failure|passed|skipped|complete|completed|cancelled|canceled|finished|pending|queued|running|started|waiting|timeout|timed out|warning|error|aborted|blocked|paused|retrying|stopped|terminated))$/i;
const SECRET_ASSIGNMENT_PATTERN =
  /\b((?:access|refresh)[_-]?token|api[_-]?key|token|password|secret)\s*([:=])\s*([^\s;&]+)/gi;

export function isCronCommandActionCriticalLine(line: string): boolean {
  const normalized = normalizeOptionalString(line);
  return Boolean(
    normalized &&
    (isYourCodeIsPrompt(normalized) ||
      ACTION_LINE_PATTERNS.some((pattern) => pattern.test(normalized))),
  );
}

function isYourCodeIsPrompt(line: string): boolean {
  const qualifiedValue = QUALIFIED_YOUR_CODE_IS_PATTERN.exec(line)?.[1];
  if (qualifiedValue && CODE_VALUE_PATTERN.test(qualifiedValue)) {
    return true;
  }
  const genericValue = YOUR_CODE_IS_PATTERN.exec(line)?.[1];
  return Boolean(genericValue && INLINE_CODE_VALUE_PATTERN.test(genericValue));
}

function isCronCommandCodePromptExplanationLine(line: string): boolean {
  const normalized = normalizeOptionalString(line);
  return Boolean(normalized && CODE_PROMPT_EXPLANATION_PATTERN.test(normalized));
}

function isCronCommandTerminalStatusLine(line: string): boolean {
  const normalized = normalizeOptionalString(line);
  return Boolean(normalized && CRON_OUTPUT_STATUS_LINE_PATTERN.test(normalized));
}

function isCronCommandUrlHandoffLine(line: string): boolean {
  const normalized = normalizeOptionalString(line);
  return Boolean(normalized && URL_HANDOFF_LINE_PATTERN.test(normalized));
}

function normalizeLines(lines: string[] | undefined): string[] {
  const result: string[] = [];
  for (const line of lines ?? []) {
    const normalized = normalizeOptionalString(line);
    if (normalized && !result.includes(normalized)) {
      result.push(normalized);
    }
    if (result.length >= MAX_PRESERVED_ACTION_LINES) {
      break;
    }
  }
  return result;
}

function trimOutput(value: string): string | undefined {
  return normalizeOptionalString(value);
}

function combineOutput(params: { stdout?: string; stderr?: string }): string | undefined {
  const stdout = trimOutput(params.stdout ?? "");
  const stderr = trimOutput(params.stderr ?? "");
  if (stdout && stderr) {
    return `stdout:\n${stdout}\n\nstderr:\n${stderr}`;
  }
  return stdout ?? stderr;
}

function containsLine(haystack: string | undefined, needle: string): boolean {
  if (!haystack) {
    return false;
  }
  return haystack.split(/\r?\n/).some((line) => line.trim() === needle.trim());
}

export function buildCronCommandSummary(params: {
  stdout: string;
  stderr: string;
  preservedStdoutLines?: string[];
  preservedStderrLines?: string[];
}): string | undefined {
  const tail = combineOutput({ stdout: params.stdout, stderr: params.stderr });
  const preserved = [
    ...normalizeLines(params.preservedStdoutLines),
    ...normalizeLines(params.preservedStderrLines),
  ].filter((line) => !containsLine(tail, line));
  if (preserved.length === 0) {
    return tail;
  }
  const actionBlock = `${ACTION_REQUIRED_OUTPUT_HEADER}\n${preserved.join("\n")}`;
  return tail ? `${actionBlock}\n\n${tail}` : actionBlock;
}

function cronCommandSummaryNeedsExternalRedaction(summary: string | undefined): boolean {
  if (!summary) {
    return false;
  }
  return summary
    .split(/\r?\n/)
    .some(
      (line) =>
        line.startsWith(ACTION_REQUIRED_OUTPUT_HEADER) || isCronCommandActionCriticalLine(line),
    );
}

type EmbeddedCodeRedactionMode = "action" | "continuation" | "preserved" | "none";
type ActionPromptCarry = "none" | "code-or-explanation" | "code-only" | "url-handoff";

function maskCodePromptTextForScan(line: string): string {
  let masked = line;
  const codeIsPatterns = [
    { pattern: QUALIFIED_YOUR_CODE_IS_PATTERN, valuePattern: CODE_VALUE_PATTERN },
    { pattern: YOUR_CODE_IS_PATTERN, valuePattern: INLINE_CODE_VALUE_PATTERN },
  ];
  for (const { pattern, valuePattern } of codeIsPatterns) {
    const globalPattern = new RegExp(pattern.source, "gi");
    masked = masked.replace(globalPattern, (match, value: string) => {
      if (!valuePattern.test(value)) {
        return match;
      }
      return `${CODE_PROMPT_MASK_CHAR.repeat(match.length - value.length)}${value}`;
    });
  }
  for (const pattern of CODE_PROMPT_PATTERNS) {
    const globalPattern = new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
    );
    masked = masked.replace(globalPattern, (match) => CODE_PROMPT_MASK_CHAR.repeat(match.length));
  }
  return masked;
}

function isCodeCandidateAttachedToPrompt(
  scan: string,
  start: number,
  end: number,
  allowPlainCodeLabel: boolean,
): boolean {
  const prefix = scan.slice(0, start);
  const suffix = scan.slice(end);
  // A bare Code: label is strong only while an action prompt remains active;
  // matching it globally would redact ordinary command output.
  if (allowPlainCodeLabel && PLAIN_CODE_LABEL_PREFIX_PATTERN.test(prefix)) {
    return true;
  }
  if (
    DIRECT_CODE_VALUE_PREFIX_PATTERN.test(prefix) &&
    (DIRECT_CODE_VALUE_SUFFIX_PATTERN.test(suffix) ||
      CONTINUATION_CODE_VALUE_SUFFIX_PATTERN.test(suffix))
  ) {
    return true;
  }
  const promptEnd = scan.lastIndexOf(CODE_PROMPT_MASK_CHAR, start - 1) + 1;
  return (
    promptEnd > 0 &&
    /^[\s:;,=()-]*(?:(?:is|type|use|paste)\s+)?$/i.test(scan.slice(promptEnd, start))
  );
}

function redactEmbeddedCodeCandidates(
  line: string,
  mode: EmbeddedCodeRedactionMode,
  allowPlainCodeLabel: boolean,
  onRedactedCode: (code: string, satisfiesPrompt: boolean) => void,
): string {
  if (mode === "none") {
    return line;
  }
  const scan = maskCodePromptTextForScan(line);
  let cursor = 0;
  let result = "";
  for (const match of scan.matchAll(CODE_CANDIDATE_PATTERN)) {
    if (match.index === undefined) {
      continue;
    }
    const start = match.index;
    const end = start + match[0].length;
    const candidate = line.slice(start, end);
    const attachedToPrompt = isCodeCandidateAttachedToPrompt(scan, start, end, allowPlainCodeLabel);
    const isUnambiguousCodeShape = /[\d -]/.test(candidate);
    const candidateSuffix = line.slice(end);
    const isUrlHandoffCode =
      mode === "action" &&
      line.includes(REDACTED_URL) &&
      (DIRECT_CODE_VALUE_SUFFIX_PATTERN.test(candidateSuffix) ||
        CONTINUATION_CODE_VALUE_SUFFIX_PATTERN.test(candidateSuffix));
    const shouldRedact =
      attachedToPrompt ||
      (!isCronCommandTerminalStatusLine(candidate) &&
        (mode === "action" || mode === "preserved") &&
        (isUnambiguousCodeShape || isUrlHandoffCode));
    result += line.slice(cursor, start);
    result += shouldRedact ? "[redacted-code]" : candidate;
    if (shouldRedact) {
      onRedactedCode(candidate, attachedToPrompt);
    }
    cursor = end;
  }
  return result + line.slice(cursor);
}

function redactKnownGroupedCodes(value: string, knownCodes: ReadonlySet<string>): string {
  const groups = value.split(/[- ]/);
  const separators = value.match(/[- ]/g) ?? [];
  const redactedSpans: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < groups.length; start += 1) {
    let candidate = groups[start];
    let matchedEnd = knownCodes.has(candidate) ? start + 1 : -1;
    const endLimit = Math.min(groups.length, start + MAX_CODE_TOKEN_GROUPS);
    for (let end = start + 1; end < endLimit; end += 1) {
      candidate += `${separators[end - 1]}${groups[end]}`;
      if (knownCodes.has(candidate)) {
        matchedEnd = end + 1;
      }
    }
    if (matchedEnd <= start) {
      continue;
    }
    // A hyphen-connected wrapper is one identifier; preserve adjacent words
    // across spaces, but redact the complete identifier around a known code.
    let redactedStart = start;
    while (redactedStart > 0 && separators[redactedStart - 1] === "-") {
      redactedStart -= 1;
    }
    let redactedEnd = matchedEnd;
    while (redactedEnd < groups.length && separators[redactedEnd - 1] === "-") {
      redactedEnd += 1;
    }
    const previous = redactedSpans.at(-1);
    if (previous && redactedStart < previous.end) {
      previous.end = Math.max(previous.end, redactedEnd);
    } else {
      redactedSpans.push({ start: redactedStart, end: redactedEnd });
    }
  }
  if (redactedSpans.length === 0) {
    return value;
  }
  const groupStarts: number[] = [];
  let groupOffset = 0;
  for (const group of groups) {
    groupStarts.push(groupOffset);
    groupOffset += group.length + 1;
  }
  let cursor = 0;
  let result = "";
  for (const span of redactedSpans) {
    const endGroupIndex = span.end - 1;
    const startOffset = groupStarts[span.start]!;
    const endOffset = groupStarts[endGroupIndex]! + groups[endGroupIndex]!.length;
    result += `${value.slice(cursor, startOffset)}[redacted-code]`;
    cursor = endOffset;
  }
  return result + value.slice(cursor);
}

function redactKnownCodeOccurrences(line: string, knownCodes: ReadonlySet<string>): string {
  if (knownCodes.size === 0) {
    return line;
  }
  // Code grammar caps grouped candidates at five parts, so each line is scanned
  // with bounded lookups instead of rescanning the complete summary per value.
  return line
    .replace(GROUPED_CODE_TOKEN_PATTERN, (token) => redactKnownGroupedCodes(token, knownCodes))
    .replace(PLAIN_CODE_TOKEN_PATTERN, (token) =>
      knownCodes.has(token) ? "[redacted-code]" : token,
    );
}

function isExplicitlyPublicExternalUrl(value: string): boolean {
  const normalized = /^www\./i.test(value) ? `https://${value}` : value;
  if (redactSensitiveUrlLikeString(normalized) !== normalized) {
    return false;
  }
  try {
    const parsed = new URL(normalized);
    return (
      normalized === parsed.toString() &&
      parsed.protocol === "https:" &&
      parsed.hostname === PUBLIC_INFORMATION_URL_HOST &&
      !parsed.port &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

function splitExternalUrlCandidate(value: string): { url: string; suffix: string } {
  let openParens = 0;
  let end = value.length;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(") {
      openParens += 1;
    } else if (char === ")") {
      if (openParens === 0) {
        end = index;
        break;
      }
      openParens -= 1;
    }
  }
  while (end > 0 && URL_TRAILING_PROSE_CHARS.has(value[end - 1]!)) {
    end -= 1;
  }
  return { url: value.slice(0, end), suffix: value.slice(end) };
}

function redactExternalUrls(line: string, redactAll: boolean): string {
  return line.replace(URL_PATTERN, (candidate) => {
    const { url, suffix } = splitExternalUrlCandidate(candidate);
    for (const char of suffix) {
      if (!URL_PROSE_SUFFIX_CHARS.has(char)) {
        return REDACTED_URL;
      }
    }
    return !redactAll && isExplicitlyPublicExternalUrl(url)
      ? candidate
      : `${REDACTED_URL}${suffix}`;
  });
}

function redactCronCommandSummaryLine(
  line: string,
  embeddedCodeMode: EmbeddedCodeRedactionMode,
  hasActivePromptContinuation: boolean,
  redactBareUnambiguousCodes: boolean,
  redactUrls: boolean,
  onRedactedCode: (code: string, satisfiesPrompt: boolean) => void,
): string {
  let redacted = redactToolPayloadText(redactExternalUrls(line, redactUrls)).replace(
    SECRET_ASSIGNMENT_PATTERN,
    (_match, key: string, separator: string) => {
      return `${key}${separator}***`;
    },
  );
  redacted = redactEmbeddedCodeCandidates(
    redacted,
    embeddedCodeMode,
    hasActivePromptContinuation,
    onRedactedCode,
  );
  const bareCode = redacted.trim();
  const redactBareCode = (value: string, pattern: RegExp): string => {
    if (!pattern.test(value)) {
      return value;
    }
    onRedactedCode(bareCode, true);
    return value.replace(pattern, "$1[redacted-code]$2");
  };
  let bareRedacted = redacted;
  if (redactBareUnambiguousCodes) {
    bareRedacted = redactBareCode(bareRedacted, BARE_SEPARATED_CODE_PATTERN);
    bareRedacted = redactBareCode(bareRedacted, BARE_MIXED_CODE_PATTERN);
    bareRedacted = redactBareCode(bareRedacted, BARE_NUMERIC_CODE_PATTERN);
  }
  if (!hasActivePromptContinuation || isCronCommandTerminalStatusLine(bareCode)) {
    return bareRedacted;
  }
  bareRedacted = redactBareCode(bareRedacted, BARE_PROMPT_NUMERIC_CODE_PATTERN);
  bareRedacted = redactBareCode(bareRedacted, BARE_SPACE_SEPARATED_LETTERS_CODE_PATTERN);
  return redactBareCode(bareRedacted, BARE_LETTERS_CODE_PATTERN);
}

export function redactCronCommandSummaryForExternalDelivery(
  summary: string | undefined,
): string | undefined {
  if (!summary || !cronCommandSummaryNeedsExternalRedaction(summary)) {
    return summary;
  }
  let inPreservedActionBlock = false;
  let actionPromptCarry: ActionPromptCarry = "none";
  let pendingPreservedOutputHeader = false;
  const redactedCodes = new Set<string>();
  const redactedSummary = summary
    .split(/(\r?\n)/)
    .map((part) => {
      if (/^\r?\n$/.test(part)) {
        return part;
      }
      if (part.trim().length === 0) {
        if (inPreservedActionBlock) {
          // normalizeLines removes blank entries, so this is the block/tail delimiter.
          inPreservedActionBlock = false;
          pendingPreservedOutputHeader = actionPromptCarry !== "none";
        }
        return part;
      }
      const isGeneratedOutputHeader =
        pendingPreservedOutputHeader && GENERATED_OUTPUT_SECTION_HEADER_PATTERN.test(part);
      pendingPreservedOutputHeader = false;
      if (part.startsWith(ACTION_REQUIRED_OUTPUT_HEADER)) {
        inPreservedActionBlock = true;
      }
      const isActionLine = isCronCommandActionCriticalLine(part);
      const isUrlHandoffLine = isCronCommandUrlHandoffLine(part);
      const promptCarry = actionPromptCarry;
      // An explicit URL handoff remains action context only through its
      // standalone URL line; arbitrary output still expires the prompt.
      const isPromptCarriedUrlLine =
        promptCarry === "url-handoff" && STANDALONE_URL_LINE_PATTERN.test(part);
      const isPromptActionLine = isActionLine || isPromptCarriedUrlLine;
      const isTerminalStatusLine = isCronCommandTerminalStatusLine(part);
      const hasActivePromptContinuation = promptCarry !== "none" && promptCarry !== "url-handoff";
      // The first bounded continuation belongs to the preceding action prompt;
      // otherwise an embedded one-time code bypasses the bare-code redaction path.
      const embeddedCodeMode: EmbeddedCodeRedactionMode = inPreservedActionBlock
        ? "preserved"
        : isPromptActionLine
          ? "action"
          : hasActivePromptContinuation
            ? "continuation"
            : "none";
      let lineSatisfiedPrompt = false;
      const redacted = redactCronCommandSummaryLine(
        part,
        embeddedCodeMode,
        hasActivePromptContinuation,
        inPreservedActionBlock || hasActivePromptContinuation,
        inPreservedActionBlock || isPromptActionLine,
        (code, satisfiesPrompt) => {
          lineSatisfiedPrompt ||=
            !isTerminalStatusLine &&
            (satisfiesPrompt || (!isPromptActionLine && hasActivePromptContinuation));
          // Status-shaped values on prompt lines are redacted locally but are too
          // ambiguous to replace throughout otherwise unrelated command output.
          if (
            !isCronCommandTerminalStatusLine(code) &&
            (!isActionLine || inPreservedActionBlock || satisfiesPrompt || /[\d -]/.test(code))
          ) {
            redactedCodes.add(code);
          }
        },
      );
      // A terminal status remains visible and does not consume the cue: command
      // output can emit status before the actual one-time credential.
      if (lineSatisfiedPrompt) {
        actionPromptCarry = "none";
      } else if (isPromptCarriedUrlLine) {
        actionPromptCarry = "code-or-explanation";
      } else if (isUrlHandoffLine) {
        actionPromptCarry = "url-handoff";
      } else if (isActionLine) {
        actionPromptCarry = "code-or-explanation";
      } else if (isGeneratedOutputHeader && promptCarry !== "none") {
        // buildCronCommandSummary inserts stdout: between preserved prompts and tail output.
        actionPromptCarry = promptCarry;
      } else if (promptCarry !== "none" && isTerminalStatusLine) {
        actionPromptCarry = promptCarry;
      } else if (
        promptCarry === "code-or-explanation" &&
        isCronCommandCodePromptExplanationLine(part)
      ) {
        actionPromptCarry = "code-only";
      } else {
        actionPromptCarry = "none";
      }
      return redacted;
    })
    .join("");
  // A code classified anywhere in the bounded state pass stays secret at every
  // occurrence. This second pass scans the output once, independent of code count.
  return redactKnownCodeOccurrences(redactedSummary, redactedCodes);
}
