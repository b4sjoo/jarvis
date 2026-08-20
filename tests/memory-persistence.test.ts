import assert from "node:assert/strict";
import test from "node:test";
import { resolveMemoryInterviewFamilies } from "../src/lib/memory/interview-family.js";
import { parseCuratedMemoryDraft } from "../src/lib/memory/parser.js";
import {
  decodePersistedMemoryInterviewFamilies,
  encodePersistedMemoryInterviewFamilies,
} from "../src/lib/memory/persistence.js";

test("preserves explicit interview families across parser and persisted row encoding", () => {
  const parsed = parseCuratedMemoryDraft(
    {
      path: "curated.md",
      content: `\`\`\`yaml
entries:
  - id: mem_multi_family
    sourceIds: [source_a]
    type: interview_framework
    title: Shared design guidance
    content: Shared guidance.
    interviewFamilies: [ai-ml-system-design, system-design, ai-ml-system-design]
\`\`\``,
    },
    100
  );
  const parsedEntry = parsed.entries[0];
  assert.ok(parsedEntry);

  const encoded = encodePersistedMemoryInterviewFamilies(
    parsedEntry.interviewFamilies
  );
  const decoded = decodePersistedMemoryInterviewFamilies(encoded);
  const hydrated = {
    ...parsedEntry,
    interviewFamilies: decoded.families,
  };

  assert.equal(decoded.status, "explicit");
  assert.deepEqual(decoded.families, [
    "ai-ml-system-design",
    "system-design",
  ]);
  assert.deepEqual(resolveMemoryInterviewFamilies(hydrated).families, [
    "ai-ml-system-design",
    "system-design",
  ]);
  assert.equal(resolveMemoryInterviewFamilies(hydrated).source, "explicit");
});

test("keeps old rows on inference fallback", () => {
  assert.deepEqual(decodePersistedMemoryInterviewFamilies(null), {
    status: "missing",
  });
  assert.deepEqual(decodePersistedMemoryInterviewFamilies("[]"), {
    status: "missing",
  });
});

test("diagnoses malformed persisted families without accepting partial authority", () => {
  assert.deepEqual(decodePersistedMemoryInterviewFamilies("not-json"), {
    status: "malformed",
    reason: "invalid-json",
  });
  assert.deepEqual(
    decodePersistedMemoryInterviewFamilies(
      JSON.stringify(["behavioral", "not-a-family"])
    ),
    {
      status: "malformed",
      reason: "invalid-family",
    }
  );
});
