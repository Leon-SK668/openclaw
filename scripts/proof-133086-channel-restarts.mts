import { execFileSync } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startQaBusServer } from "../extensions/qa-lab/src/bus-server.js";
import { createQaBusState } from "../extensions/qa-lab/src/bus-state.js";
import { createQaGatewayChild } from "../extensions/qa-lab/src/gateway-child.js";
import { startQaMockOpenAiServer } from "../extensions/qa-lab/src/providers/mock-openai/server.js";
import { createQaChannelTransport } from "../extensions/qa-lab/src/qa-channel-transport.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const state = createQaBusState();
const bus = await startQaBusServer({ state });
const mock = await startQaMockOpenAiServer();
const transport = createQaChannelTransport(state);
const owner = createQaGatewayChild();

try {
  const gateway = await owner.start({
    repoRoot,
    useRepoCli: true,
    providerBaseUrl: `${mock.baseUrl}/v1`,
    providerMode: "mock-openai",
    transport,
    transportBaseUrl: bus.baseUrl,
    controlUiEnabled: false,
  });
  await transport.waitReady({ gateway });

  // The production qa-channel poller owns this bus connection. Closing the real
  // HTTP service makes its account task fail; the Gateway supervisor must then
  // restart it and preserve the attempt count in the status snapshot.
  await bus.stop();
  let attempts = 0;
  let status: Record<string, unknown> | undefined;
  for (let i = 0; i < 30; i += 1) {
    await sleep(1_000);
    status = (await gateway.call("channels.status", { probe: false })) as Record<string, unknown>;
    const accounts = (status.channelAccounts as Record<string, unknown> | undefined)?.[
      "qa-channel"
    ];
    const account = Array.isArray(accounts)
      ? (accounts[0] as Record<string, unknown> | undefined)
      : undefined;
    attempts = typeof account?.reconnectAttempts === "number" ? account.reconnectAttempts : 0;
    if (attempts > 0) break;
  }
  if (attempts <= 0) {
    throw new Error(
      `expected supervisor reconnectAttempts > 0; status=${JSON.stringify(status)} logs=${gateway.logs()}`,
    );
  }
  const rendered = await gateway.runCli(["channels", "status", "--channel", "qa-channel"]);
  if (!/restarts:[1-9][0-9]*/u.test(rendered)) {
    throw new Error(`status CLI omitted restarts:N; attempts=${attempts} output=${rendered}`);
  }
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  process.stdout.write(JSON.stringify({ head, attempts, rendered }) + "\n");
} finally {
  await owner.stop();
  await mock.stop();
  if (bus.server.listening) await bus.stop();
}
