import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (process.argv.length !== 5) {
  throw new Error("usage: run.mts <target-root> <expected-head-sha> <artifact-dir>");
}

const [, , targetRootArg, expectedHead, artifactDirArg] = process.argv;
assert.match(expectedHead, /^[0-9a-f]{40}$/u);

const targetRoot = path.resolve(targetRootArg);
const artifactDir = path.resolve(artifactDirArg);
const actualHead = execFileSync("git", ["-C", targetRoot, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
assert.equal(actualHead, expectedHead, "proof checkout is not at the requested PR head");

const importTarget = async (relativePath: string) =>
  await import(pathToFileURL(path.join(targetRoot, relativePath)).href);

const [harnessRuntime, clientRuntime, syncRuntime, requestRuntime, scenarioRuntime, errorRuntime] =
  await Promise.all([
    importTarget(
      "extensions/qa-lab/src/live-transports/matrix/substrate/harness.runtime.ts",
    ),
    importTarget("extensions/qa-lab/src/live-transports/matrix/substrate/client.ts"),
    importTarget("extensions/qa-lab/src/live-transports/matrix/substrate/sync.ts"),
    importTarget("extensions/qa-lab/src/live-transports/matrix/substrate/request.ts"),
    importTarget(
      "extensions/qa-lab/src/live-transports/matrix/scenarios/scenario-runtime-tool-progress.ts",
    ),
    importTarget("src/plugin-sdk/error-runtime.ts"),
  ]);

const { startMatrixQaHarness } = harnessRuntime;
const { provisionMatrixQaRoom } = clientRuntime;
const { createMatrixQaRoomObserver } = syncRuntime;
const { requestMatrixJson } = requestRuntime;
const { runToolProgressPreviewScenario } = scenarioRuntime;
const { formatErrorMessage } = errorRuntime;
const SCENARIO_TIMEOUT_MS = 15_000;

type MatrixAccount = {
  accessToken: string;
  userId: string;
};

type MatrixProvisioning = {
  driver: MatrixAccount;
  observer: MatrixAccount;
  roomId: string;
  sut: MatrixAccount;
  topology: unknown;
};

function hasLoneSurrogate(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

async function sendNotice(params: {
  account: MatrixAccount;
  baseUrl: string;
  body: string;
  roomId: string;
  targetEventId?: string;
}) {
  const content = params.targetEventId
    ? {
        body: `* ${params.body}`,
        msgtype: "m.notice",
        "m.new_content": { body: params.body, msgtype: "m.notice" },
        "m.relates_to": { event_id: params.targetEventId, rel_type: "m.replace" },
      }
    : { body: params.body, msgtype: "m.notice" };
  const response = await requestMatrixJson({
    accessToken: params.account.accessToken,
    baseUrl: params.baseUrl,
    body: content,
    endpoint:
      `/_matrix/client/v3/rooms/${encodeURIComponent(params.roomId)}` +
      `/send/m.room.message/${encodeURIComponent(randomUUID())}`,
    fetchImpl: fetch,
    method: "PUT",
  });
  const eventId = response.body.event_id?.trim();
  assert.ok(eventId, "Matrix send did not return an event id");
  return eventId;
}

async function provisionProofRoom(params: {
  harness: { baseUrl: string; registrationToken: string };
  suffix: string;
}) {
  return (await provisionMatrixQaRoom({
    baseUrl: params.harness.baseUrl,
    driverLocalpart: `proof-driver-${params.suffix}`,
    observerLocalpart: `proof-observer-${params.suffix}`,
    registrationToken: params.harness.registrationToken,
    roomName: `OpenClaw timeout proof ${params.suffix}`,
    sutLocalpart: `proof-sut-${params.suffix}`,
  })) as MatrixProvisioning;
}

function createProofScenarioContext(params: {
  baseUrl: string;
  provisioning: MatrixProvisioning;
}) {
  return {
    baseUrl: params.baseUrl,
    driverAccessToken: params.provisioning.driver.accessToken,
    driverUserId: params.provisioning.driver.userId,
    observedEvents: [],
    observerAccessToken: params.provisioning.observer.accessToken,
    observerUserId: params.provisioning.observer.userId,
    roomId: params.provisioning.roomId,
    sutAccessToken: params.provisioning.sut.accessToken,
    sutUserId: params.provisioning.sut.userId,
    syncState: {},
    timeoutMs: SCENARIO_TIMEOUT_MS,
    topology: params.provisioning.topology,
  };
}

await fs.rm(artifactDir, { force: true, recursive: true });
await fs.mkdir(artifactDir, { recursive: true });

const harnessOutputDir = path.join(artifactDir, "harness-work");
const harness = await startMatrixQaHarness({ outputDir: harnessOutputDir, repoRoot: targetRoot });
harness.recording.setScenarioId("matrix-timeout-utf16-proof");

try {
  const suffix = randomUUID().slice(0, 8);
  const provisioning = await provisionProofRoom({ harness, suffix });
  const witnessEvents: unknown[] = [];
  const witness = createMatrixQaRoomObserver({
    ...provisioning.observer,
    baseUrl: harness.baseUrl,
    observedEvents: witnessEvents,
  });
  await witness.prime();

  const context = createProofScenarioContext({ baseUrl: harness.baseUrl, provisioning });

  const scenarioOutcome = runToolProgressPreviewScenario(context).then(
    (result: unknown) => ({ kind: "success" as const, result }),
    (error: unknown) => ({ error, kind: "failure" as const }),
  );
  await witness.waitForRoomEvent({
    predicate: (event: { sender?: string; type: string }) =>
      event.sender === provisioning.driver.userId && event.type === "m.room.message",
    roomId: provisioning.roomId,
    timeoutMs: 10_000,
  });

  const previewEventId = await sendNotice({
    account: provisioning.sut,
    baseUrl: harness.baseUrl,
    body: "Working...",
    roomId: provisioning.roomId,
  });
  const progressPrefix = "read: from ";
  const preservedPrefix = `${progressPrefix}${"a".repeat(224)}`;
  const splitPrefix = `${progressPrefix}${"a".repeat(225)}`;
  assert.equal(preservedPrefix.length, 235);
  assert.equal(splitPrefix.length, 236);
  const preservedBody = `${preservedPrefix}\u{1f600}tail`;
  const splitBody = `${splitPrefix}\u{1f600}tail`;

  const preservedEventId = await sendNotice({
    account: provisioning.sut,
    baseUrl: harness.baseUrl,
    body: preservedBody,
    roomId: provisioning.roomId,
    targetEventId: previewEventId,
  });
  const splitEventId = await sendNotice({
    account: provisioning.sut,
    baseUrl: harness.baseUrl,
    body: splitBody,
    roomId: provisioning.roomId,
    targetEventId: previewEventId,
  });

  const witnessedSplit = await witness.waitForRoomEvent({
    predicate: (event: { eventId: string }) => event.eventId === splitEventId,
    roomId: provisioning.roomId,
    timeoutMs: 10_000,
  });
  // The QA observer unwraps m.replace to m.new_content; the "* " wire fallback is not the edit body.
  assert.equal(witnessedSplit.event.body, splitBody, "Matrix round-trip changed the boundary body");
  assert.equal(witnessedSplit.event.relatesTo?.relType, "m.replace");
  assert.equal(witnessedSplit.event.relatesTo?.eventId, previewEventId);
  assert.equal(splitBody.charCodeAt(236), 0xd83d);
  assert.equal(splitBody.charCodeAt(237), 0xde00);

  const outcome = await scenarioOutcome;
  assert.equal(outcome.kind, "failure", "scenario unexpectedly received a final reply");
  const timeoutMessage = formatErrorMessage(outcome.error);
  assert.ok(
    timeoutMessage.includes(
      `timed out after ${SCENARIO_TIMEOUT_MS}ms waiting for Matrix room event`,
    ),
    "diagnostic did not come from the real Matrix wait timeout",
  );
  assert.ok(
    timeoutMessage.includes(`${preservedPrefix}\u{1f600}...`),
    "diagnostic did not preserve the complete boundary emoji",
  );
  assert.ok(
    timeoutMessage.includes(`${splitPrefix}...`),
    "diagnostic did not retreat before the split surrogate pair",
  );
  assert.ok(!timeoutMessage.includes("\\ud83d"), "diagnostic exposed an escaped half surrogate");
  assert.ok(!timeoutMessage.includes("\ufffd"), "diagnostic contains a replacement character");
  assert.ok(!hasLoneSurrogate(timeoutMessage), "diagnostic contains an unpaired surrogate");
  const utf8RoundTrip = Buffer.from(timeoutMessage, "utf8").toString("utf8");
  assert.equal(utf8RoundTrip, timeoutMessage, "diagnostic changed during UTF-8 round-trip");
  assert.ok(!utf8RoundTrip.includes("\ufffd"));

  const records = harness.recording.records();
  const routes = [
    ...new Set(records.map((record: { request: { method: string; route: string } }) =>
      `${record.request.method} ${record.request.route}`,
    )),
  ].toSorted();
  assert.ok(routes.some((route) => route.endsWith(" /_matrix/client/v3/register")));
  assert.ok(routes.some((route) => route.endsWith(" /_matrix/client/v3/createRoom")));
  assert.ok(routes.some((route) => route.includes("/send/m.room.message/{transactionId}")));
  assert.ok(routes.some((route) => route.endsWith(" /_matrix/client/v3/sync")));

  const routeManifest = harness.recording.buildManifest({
    requestedProfile: "matrix-timeout-utf16-proof",
    scenarioIds: ["matrix-timeout-utf16-proof"],
    substrate: { id: "tuwunel", version: harness.image },
  });
  await fs.writeFile(
    path.join(artifactDir, "recording-routes.json"),
    `${JSON.stringify(routeManifest, null, 2)}\n`,
    "utf8",
  );
  await fs.copyFile(harness.manifestPath, path.join(artifactDir, "matrix-qa-harness.json"));

  let redactedTimeout = timeoutMessage;
  for (const [eventId, label] of [
    [previewEventId, "<preview-event>"],
    [preservedEventId, "<preserved-boundary-event>"],
    [splitEventId, "<split-boundary-event>"],
  ]) {
    redactedTimeout = redactedTimeout.replaceAll(eventId, label);
  }
  await fs.writeFile(path.join(artifactDir, "timeout.log"), `${redactedTimeout}\n`, "utf8");
  await fs.writeFile(
    path.join(artifactDir, "proof.json"),
    `${JSON.stringify(
      {
        version: 1,
        exactHead: expectedHead,
        node: process.version,
        homeserverImage: harness.image,
        assertions: {
          realMatrixRoundTrip: witnessedSplit.event.body === splitBody,
          replacementRelation: witnessedSplit.event.relatesTo?.relType === "m.replace",
          splitHighSurrogateIndex: 236,
          splitLowSurrogateIndex: 237,
          preservedBoundaryEmoji: true,
          retreatedBeforeSplitPair: true,
          noEscapedHalfSurrogate: true,
          noLoneSurrogate: true,
          noReplacementCharacter: true,
          utf8RoundTrip: true,
          realTimeoutPath: true,
        },
        routeCount: routes.length,
        routes,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
} finally {
  await harness.stop();
}

console.log(`Matrix timeout proof passed at exact head ${expectedHead}`);
