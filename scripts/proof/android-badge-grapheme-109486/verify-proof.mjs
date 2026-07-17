import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

if (process.argv.length !== 6) {
  throw new Error("usage: verify-proof.mjs <png> <xml> <metrics-json> <expected-head-sha>");
}

const [, , pngPath, xmlPath, metricsPath, expectedHead] = process.argv;
assert.match(expectedHead, /^[0-9a-f]{40}$/u);

const [png, xmlBytes, metricsBytes] = await Promise.all([
  readFile(pngPath),
  readFile(xmlPath),
  readFile(metricsPath),
]);

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
assert.ok(png.length > 10_000, `screenshot is unexpectedly small: ${png.length} bytes`);
assert.deepEqual(png.subarray(0, pngSignature.length), pngSignature, "artifact is not a PNG");
const pngWidth = png.readUInt32BE(16);
const pngHeight = png.readUInt32BE(20);
assert.ok(pngWidth > 0 && pngHeight > 0, "PNG has invalid dimensions");

const decoder = new TextDecoder("utf-8", { fatal: true });
const xml = decoder.decode(xmlBytes);
const metricsText = decoder.decode(metricsBytes);
assert.ok(!metricsText.includes("\uFFFD"), "metrics contain a replacement character");
// UiDevice.dumpWindowHierarchy serializes supplementary code points as decimal XML references.
const decodedXml = xml.replace(/&#([0-9]+);/gu, (reference, rawCodePoint) => {
  const codePoint = Number(rawCodePoint);
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : reference;
});
assert.ok(!decodedXml.includes("\uFFFD"), "UI hierarchy contains a replacement character");

const expectedCases = new Map([
  ["compass", "\u{1F9ED}"],
  ["flag", "\u{1F1FA}\u{1F1F8}"],
  ["zwj", "\u{1F469}\u200D\u{1F4BB}"],
  ["combining", "E\u0301"],
]);
for (const [id, rendered] of expectedCases) {
  assert.ok(
    decodedXml.includes(`content-desc="badge:${id}:${rendered}"`),
    `UI hierarchy is missing exact ${id} grapheme semantics`,
  );
}

const metrics = JSON.parse(metricsText);
assert.equal(metrics.head, expectedHead, "proof did not run against the requested PR head");
assert.equal(metrics.screenWidth, pngWidth, "PNG and runtime width differ");
assert.equal(metrics.screenHeight, pngHeight, "PNG and runtime height differ");
assert.ok(metrics.screenUniqueColors >= 16, "screenshot does not contain enough color variation");
assert.equal(metrics.replacementNodeCount, 0, "runtime found replacement characters in UI nodes");
assert.equal(metrics.cases.length, expectedCases.size, "unexpected proof case count");

for (const proofCase of metrics.cases) {
  const expected = expectedCases.get(proofCase.id);
  assert.ok(expected, `unexpected proof case: ${proofCase.id}`);
  assert.equal(proofCase.rendered, expected, `${proofCase.id} rendered the wrong grapheme`);
  assert.equal(proofCase.expected, expected, `${proofCase.id} fixture expectation drifted`);
  assert.equal(proofCase.contentDescription, `badge:${proofCase.id}:${expected}`);
  assert.ok(proofCase.width > 0 && proofCase.height > 0, `${proofCase.id} has empty bounds`);
  assert.ok(
    Math.abs(proofCase.width - proofCase.height) <= Math.max(2, proofCase.width / 10),
    `${proofCase.id} badge is not approximately square`,
  );
  assert.ok(proofCase.uniqueColors >= 4, `${proofCase.id} badge pixel region is nearly flat`);
  assert.ok(
    proofCase.nonDominantPixels >= Math.max(12, proofCase.pixelCount / 200),
    `${proofCase.id} badge has no detectable foreground glyph pixels`,
  );
}

console.log(
  `verified ${metrics.cases.length} production badges on API ${metrics.sdk}; ` +
    `PNG ${pngWidth}x${pngHeight}, ${metrics.screenUniqueColors} sampled colors, head ${metrics.head}`,
);
