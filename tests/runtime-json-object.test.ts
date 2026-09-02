import assert from "node:assert/strict";
import test from "node:test";
import {
  isRuntimeJsonObjectTruncated,
  parseRuntimeJsonObject,
} from "../src/lib/meeting/runtime-json-object.js";

test("normalizes BOM and one complete JSON fence", () => {
  const parsed = parseRuntimeJsonObject(
    '\uFEFF```json\n{"v":1,"d":"r"}\n```',
    { maxChars: 64 }
  );

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.value : undefined, { v: 1, d: "r" });
  assert.equal(parsed.fenceStripped, true);
});

test("distinguishes truncated output from malformed syntax", () => {
  const truncated = parseRuntimeJsonObject(
    '{"v":1,"d":"r","q":"Within this RAG system"'
  );
  const malformed = parseRuntimeJsonObject(
    '{"v":1,"d":"r,"c":0.95,"q":"Within this RAG system"}'
  );

  assert.equal(truncated.ok, false);
  assert.equal(truncated.ok ? undefined : truncated.reason, "truncated-json");
  assert.equal(malformed.ok, false);
  assert.equal(malformed.ok ? undefined : malformed.reason, "malformed-json");
  assert.equal(isRuntimeJsonObjectTruncated("```json\n{\"v\":1"), true);
});

test("rejects oversized and non-object outputs without semantic repair", () => {
  const oversized = parseRuntimeJsonObject('{"value":"long"}', {
    maxChars: 4,
  });
  const array = parseRuntimeJsonObject("[]");

  assert.equal(oversized.ok, false);
  assert.equal(oversized.ok ? undefined : oversized.reason, "output-too-large");
  assert.equal(array.ok, false);
  assert.equal(array.ok ? undefined : array.reason, "output-is-not-object");
});
