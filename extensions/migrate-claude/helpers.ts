import { isUtf8 } from "node:buffer";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFileHandleBounded } from "openclaw/plugin-sdk/file-access-runtime";
import {
  markMigrationItemError,
  markMigrationItemSkipped,
  MIGRATION_REASON_MISSING_SOURCE_OR_TARGET,
} from "openclaw/plugin-sdk/migration";
import { safeStat } from "openclaw/plugin-sdk/path-existence-runtime";
import type { MigrationItem } from "openclaw/plugin-sdk/plugin-entry";
import {
  appendRegularFile,
  pathExists,
  readRegularFile,
} from "openclaw/plugin-sdk/security-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export function resolveHomePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  return path.resolve(trimmed.replace(/^~(?=$|[\\/])/u, () => os.homedir()));
}

export { pathExists as exists };

export async function isDirectory(dirPath: string): Promise<boolean> {
  return (await safeStat(dirPath))?.isDirectory() === true;
}

export function sanitizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

export async function readSourceFile(filePath: string): Promise<Buffer> {
  // Follow source symlinks, but do not wait for a FIFO writer before checking its type.
  const flags = process.platform === "win32" ? "r" : constants.O_RDONLY | constants.O_NONBLOCK;
  const handle = await fs.open(filePath, flags);
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error(
        `Claude migration source must be a regular file: ${filePath}. Choose or restore a regular source file, then rerun the migration.`,
      );
    }
    // Nonblocking reads may be short before EOF (for example, on 9p).
    return await readFileHandleBounded(handle, Infinity);
  } finally {
    await handle.close();
  }
}

export async function readJsonObject(
  filePath: string | undefined,
): Promise<Record<string, unknown>> {
  const content = filePath ? await readSourceFile(filePath).catch(() => undefined) : undefined;
  if (!content) {
    return {};
  }
  // Check before replacement decoding can silently alter imported settings.
  if (!isUtf8(content)) {
    throw new Error(
      `Claude configuration file is not valid UTF-8: ${filePath}. Re-save or re-encode it as UTF-8, then rerun the migration.`,
    );
  }
  try {
    const parsed = JSON.parse(content.toString("utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function appendItem(item: MigrationItem): Promise<MigrationItem> {
  if (!item.source || !item.target) {
    return markMigrationItemError(item, MIGRATION_REASON_MISSING_SOURCE_OR_TARGET);
  }
  try {
    const content = await readSourceFile(item.source);
    if (!isUtf8(content)) {
      throw new Error(
        `Claude instruction file is not valid UTF-8: ${item.source}. Re-save or re-encode it as UTF-8, then rerun the migration.`,
      );
    }
    const label =
      typeof item.details?.sourceLabel === "string"
        ? item.details.sourceLabel
        : path.basename(item.source);
    const body = content.toString("utf8").trimEnd();
    if (!body) {
      return markMigrationItemSkipped(item, "source file is empty");
    }
    const importBlock = `\n\n<!-- Imported from Claude: ${label} -->\n\n${body}\n`;
    const existing = (await pathExists(item.target))
      ? (await readRegularFile({ filePath: item.target })).buffer.toString("utf8")
      : "";
    if (existing.includes(importBlock)) {
      return markMigrationItemSkipped(item, "already imported from Claude");
    }
    await fs.mkdir(path.dirname(item.target), { recursive: true });
    await appendRegularFile({
      filePath: item.target,
      content: importBlock,
      rejectSymlinkParents: true,
    });
    return { ...item, status: "migrated" };
  } catch (err) {
    return markMigrationItemError(item, err instanceof Error ? err.message : String(err));
  }
}
