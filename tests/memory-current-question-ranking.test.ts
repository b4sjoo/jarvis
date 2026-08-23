import assert from "node:assert/strict";
import test from "node:test";
import {
  scoreCurrentQuestionRelevance,
} from "../src/lib/memory/current-question-ranking.js";
import type { MemoryEntry } from "../src/lib/memory/types.js";

test("current question relevance outranks broad preparation guidance", () => {
  const currentQuestionTokens = new Set([
    "oasis",
    "ndjson",
    "per",
    "item",
    "failure",
  ]);
  const oasis = scoreCurrentQuestionRelevance(
    makeEntry({
      id: "mem_oasis_index_bulk_implementation",
      type: "implementation_note",
      title: "Oasis IndexAction and BulkAction implementation",
      summary: "NDJSON serialization and per-item failure parsing.",
      content:
        "OasisJsonConverter serialized NDJSON and BulkResponse parsed each item failure.",
      scope: "project",
      projectId: "oasis",
      projectName: "Oasis",
      tags: ["oasis", "ndjson", "partial-failure"],
      keywords: ["NDJSON", "per-item failure", "BulkResponse"],
      priority: "high",
    }),
    currentQuestionTokens
  );
  const generic = scoreCurrentQuestionRelevance(
    makeEntry({
      id: "mem_aiml_eval_stack",
      type: "evaluation_criteria",
      title: "Evaluation stack for LLM RAG and agent systems",
      summary: "Evaluate RAG systems and agent quality.",
      content: "Use retrieval and generation evaluation metrics.",
      tags: ["agent", "evaluation", "rag", "system-design"],
      keywords: ["RAG", "evaluation"],
      priority: "high",
    }),
    currentQuestionTokens
  );

  assert.ok(oasis.score > generic.score, `${oasis.score} <= ${generic.score}`);
  assert.ok(oasis.tagMatches > generic.tagMatches);
});

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "entry",
    sourceIds: [],
    type: "field_note",
    title: "Entry",
    content: "Entry content",
    scope: "global",
    tags: [],
    keywords: [],
    priority: "normal",
    enabled: true,
    injectionMode: "retrieval",
    useCases: ["meeting_assistant"],
    confidentiality: "normal",
    curationStatus: "curated",
    relatedEntryIds: [],
    evidenceEntryIds: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}
