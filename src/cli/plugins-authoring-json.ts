import { isUtf8 } from "node:buffer";
import fs from "node:fs";

/** Read author-owned metadata without silently replacing malformed input bytes. */
export function readPluginAuthoringJson(filePath: string): Record<string, unknown> {
  // Metadata is a file, but author-provided symlinks remain supported. Inspect
  // the opened descriptor; a blocking open would wait on FIFOs before this check.
  const flags =
    process.platform === "win32" ? "r" : fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;
  const fd = fs.openSync(filePath, flags);
  let bytes: Buffer;
  try {
    if (!fs.fstatSync(fd).isFile()) {
      throw new Error(
        `JSON input must be a regular file: ${filePath}. Choose a metadata file and retry.`,
      );
    }
    bytes = fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (!isUtf8(bytes)) {
    throw new Error(`JSON file must be valid UTF-8: ${filePath}`);
  }
  try {
    // SAFETY: Preserve the JSON-object authoring contract; values stay unknown for consumers to narrow.
    return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Malformed JSON in ${filePath}`, { cause: err });
  }
}
