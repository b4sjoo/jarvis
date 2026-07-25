import assert from "node:assert/strict";
import test from "node:test";
import { deduplicateRolloverTranscript } from "../src/lib/meeting/rollover-transcript.js";

test("removes a reliable leading overlap from the next rollover transcript", () => {
  const result = deduplicateRolloverTranscript(
    "We can store the vectors in an HNSW index",
    "an HNSW index, and shard it by tenant."
  );

  assert.equal(result.changed, true);
  assert.equal(result.overlapTokenCount, 3);
  assert.equal(result.text, "and shard it by tenant.");
  assert.equal(result.reason, "leading-overlap-removed");
});

test("does not remove a short single-word overlap", () => {
  const result = deduplicateRolloverTranscript(
    "The first option is Redis",
    "Redis can also be used for the cache."
  );

  assert.equal(result.changed, false);
  assert.equal(result.text, "Redis can also be used for the cache.");
  assert.equal(result.reason, "no-reliable-token-overlap");
});

test("can suppress a transcript made entirely from rollover overlap", () => {
  const result = deduplicateRolloverTranscript(
    "The answer is consistent hashing",
    "consistent hashing."
  );

  assert.equal(result.changed, true);
  assert.equal(result.text, "");
  assert.equal(result.reason, "entire-transcript-overlap");
});

test("does not apply fuzzy similarity outside an exact suffix-prefix overlap", () => {
  const result = deduplicateRolloverTranscript(
    "We should clarify the read and write traffic",
    "We should estimate the read traffic before choosing storage."
  );

  assert.equal(result.changed, false);
  assert.equal(result.overlapTokenCount, 0);
});
