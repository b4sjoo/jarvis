import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFactAnchorDecision,
  formatFactAnchorDecisionForTrace,
} from "../src/lib/meeting/fact-anchor-guardrail.js";
import type {
  MemoryEntry,
  MemoryRetrievalResult,
  RetrievedMemoryEntry,
} from "../src/lib/memory/types.js";

test("allows behavioral answers when selected memory contains a supported story anchor", () => {
  const decision = buildFactAnchorDecision({
    questionType: "behavioral",
    memoryContext: makeMemoryResult([
      makeRetrievedEntry({
        entry: makeMemoryEntry({
          id: "mem_story_aos_cleanup",
          type: "answer_template",
          title: "AOS cleanup cost-saving story",
          content:
            "Situation: shared AOS test account had 400+ inactive clusters. Action: cleanup. Result: saved over $30,000/month.",
          projectName: "AOS cleanup",
        }),
        matchReason: ["behavioral:story-anchor"],
      }),
    ]),
  });

  assert.equal(decision.state, "strong-anchor");
  assert.equal(decision.action, "answer-with-anchor");
  assert.equal(decision.selectedAnchorId, "mem_story_aos_cleanup");
  assert.deepEqual(decision.supportedAnchorTitles, ["AOS cleanup"]);
});

test("uses caveats when behavioral retrieval only found rubrics or guidance", () => {
  const decision = buildFactAnchorDecision({
    questionType: "behavioral",
    memoryContext: makeMemoryResult([
      makeRetrievedEntry({
        entry: makeMemoryEntry({
          id: "mem_amazon_lp",
          type: "evaluation_criteria",
          title: "Amazon behavioral rubric",
          content: "Use Leadership Principle strength signals.",
        }),
        matchReason: ["always"],
      }),
    ]),
  });

  assert.equal(decision.state, "weak-anchor");
  assert.equal(decision.action, "answer-with-caveats");
  assert.match(decision.missingAnchorReason ?? "", /no concrete/i);
});

test("blocks project deep-dive fabrication when no memory anchor is retrieved", () => {
  const decision = buildFactAnchorDecision({
    questionType: "project-deep-dive",
    memoryContext: makeMemoryResult([]),
    projectAnchor: "Microsoft MCP",
  });

  assert.equal(decision.state, "no-anchor");
  assert.equal(decision.action, "offer-supported-choices");
  assert.deepEqual(decision.supportedAnchorTitles, ["Microsoft MCP"]);
  assert.equal(
    formatFactAnchorDecisionForTrace(decision).factAnchorState,
    "no-anchor"
  );
});

test("does not require fact anchors for coding or system design tasks", () => {
  const decision = buildFactAnchorDecision({
    questionType: "coding",
    memoryContext: makeMemoryResult([]),
  });

  assert.equal(decision.state, "not-required");
  assert.equal(decision.requiredFor, "none");
});

function makeMemoryResult(
  entries: RetrievedMemoryEntry[]
): MemoryRetrievalResult {
  return {
    entries,
    contextText: entries.map((entry) => entry.injectedContent).join("\n"),
    totalChars: entries.reduce(
      (total, entry) => total + entry.injectedContent.length,
      0
    ),
    candidateCount: entries.length,
    eligibleCount: entries.length,
    rejectedCount: 0,
    rejectSummary: [],
    policySnapshot: {
      useCase: "behavioral_interview",
      maxEntries: 5,
      maxChars: 6000,
      perEntryMaxChars: 1200,
    },
  };
}

function makeRetrievedEntry({
  entry,
  matchReason = [],
}: {
  entry: MemoryEntry;
  matchReason?: string[];
}): RetrievedMemoryEntry {
  return {
    entry,
    score: 100,
    matchReason,
    injectedContent: entry.content,
  };
}

function makeMemoryEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  const now = 1_779_000_000_000;
  return {
    id: "mem_1",
    sourceIds: [],
    type: "project_context",
    title: "Memory",
    content: "Memory content",
    scope: "global",
    tags: [],
    keywords: [],
    priority: "normal",
    enabled: true,
    injectionMode: "retrieval",
    useCases: ["behavioral_interview"],
    confidentiality: "normal",
    curationStatus: "curated",
    relatedEntryIds: [],
    evidenceEntryIds: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
