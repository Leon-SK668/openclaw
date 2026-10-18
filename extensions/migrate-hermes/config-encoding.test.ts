import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { expect, it } from "vitest";
import { buildHermesMigrationProvider } from "./provider.js";
import { useHermesFixture } from "./test/migration-fixture.js";
import { makeConfigRuntime, writeFile } from "./test/provider-helpers.js";

const fixture = useHermesFixture();

it("rejects lossy YAML config before migration and accepts a re-encoded source", async () => {
  const input = path.join(fixture.paths.source, "config.yaml");
  const prefix = 'skills:\n  config:\n    proof:\n      label: "';
  const malformed = Buffer.concat([
    Buffer.from(prefix),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('"\n'),
  ]);
  await writeFile(input, "");
  await fs.writeFile(input, malformed);
  const config: OpenClawConfig = {};
  const context = fixture.context({ config, runtime: makeConfigRuntime(config) });
  const provider = buildHermesMigrationProvider();

  await expect(provider.apply(context)).rejects.toThrow(/UTF-8/);
  expect(config).toEqual({});
  expect(await fs.readFile(input)).toEqual(malformed);

  const value = "中文 🦞 literal �";
  await fs.writeFile(input, `${prefix}${value}"\n`);
  await provider.apply(context);
  expect(config.skills?.entries?.proof?.config?.label).toBe(value);
});
