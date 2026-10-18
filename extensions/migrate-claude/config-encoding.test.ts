import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildClaudeMigrationProvider } from "./provider.js";
import { makeConfigRuntime, makeContext, writeFile } from "./test/provider-helpers.js";

let scratch: TempWorkspace;

beforeEach(async () => {
  scratch = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-claude-config-encoding-",
  });
  vi.spyOn(os, "homedir").mockReturnValue(scratch.dir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await scratch.cleanup();
});

it.each([
  ["project", ".mcp.json", "project"],
  [".claude", ".claude.json", "."],
  [".claude", "Library/Application Support/Claude/claude_desktop_config.json", "."],
])(
  "refuses lossy MCP config from %s/%s and accepts repaired Unicode",
  async (sourceDir, filename, inputDir) => {
    const source = path.join(scratch.dir, sourceDir);
    const input = path.join(scratch.dir, inputDir, filename);
    await fs.mkdir(source, { recursive: true });
    const workspaceDir = path.join(scratch.dir, "workspace");
    const config: OpenClawConfig = { agents: { defaults: { workspace: workspaceDir } } };
    const original = structuredClone(config);
    const context = makeContext({
      source,
      stateDir: path.join(scratch.dir, "state"),
      workspaceDir,
      reportDir: path.join(scratch.dir, "report"),
      config,
      runtime: makeConfigRuntime(config),
    });
    const provider = buildClaudeMigrationProvider();
    const malformed = Buffer.concat([
      Buffer.from('{"mcpServers":{"proof":{"command":"node","args":["'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"]}}}'),
    ]);
    await writeFile(input, "");
    await fs.writeFile(input, malformed);

    await expect(provider.apply(context)).rejects.toThrow(/UTF-8/);
    expect(config).toEqual(original);
    expect(await fs.readFile(input)).toEqual(malformed);

    const value = "中文 🦞 literal �";
    await writeFile(
      input,
      JSON.stringify({ mcpServers: { proof: { command: "node", args: [value] } } }),
    );
    await provider.apply(context);
    expect(config.mcp?.servers?.proof).toMatchObject({ command: "node", args: [value] });
  },
);
