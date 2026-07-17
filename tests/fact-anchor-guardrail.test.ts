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
          type: "personal_story",
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

test("does not promote a story template to fact evidence", () => {
  const decision = buildFactAnchorDecision({
    questionType: "behavioral",
    memoryContext: makeMemoryResult([
      makeRetrievedEntry({
        entry: makeMemoryEntry({
          id: "mem_story_template",
          type: "answer_template",
          title: "AOS cleanup cost-saving story",
          content: "Situation, action, and measurable impact template.",
          projectName: "AOS cleanup",
          evidenceEntryIds: ["mem_aos_evidence"],
        }),
        matchReason: ["behavioral:story-anchor"],
      }),
    ]),
  });

  assert.equal(decision.state, "weak-anchor");
  assert.equal(decision.action, "answer-with-caveats");
  assert.deepEqual(decision.supportedAnchorTitles, []);
});

test("does not promote global field guidance to a project fact anchor", () => {
  const decision = buildFactAnchorDecision({
    questionType: "project-deep-dive",
    memoryContext: makeMemoryResult([
      makeRetrievedEntry({
        entry: makeMemoryEntry({
          id: "mem_rag_failure_modes",
          type: "field_note",
          title: "RAG failure modes",
          content: "Generic retrieval and grounding guidance.",
          projectName: "Agentic Memory",
        }),
        matchReason: ["project:fact-anchor"],
      }),
    ]),
  });

  assert.equal(decision.state, "weak-anchor");
  assert.deepEqual(decision.supportedAnchorTitles, []);
});

test("uses separately retrieved linked evidence instead of its answer template", () => {
  const decision = buildFactAnchorDecision({
    questionType: "behavioral",
    memoryContext: makeMemoryResult([
      makeRetrievedEntry({
        entry: makeMemoryEntry({
          id: "mem_story_template",
          type: "answer_template",
          title: "Cost-saving answer template",
          evidenceEntryIds: ["mem_aos_evidence"],
        }),
      }),
      makeRetrievedEntry({
        entry: makeMemoryEntry({
          id: "mem_aos_evidence",
          type: "answer_evidence",
          title: "AOS cleanup evidence",
          projectName: "AOS cleanup",
        }),
      }),
    ]),
  });

  assert.equal(decision.state, "strong-anchor");
  assert.equal(decision.selectedAnchorId, "mem_aos_evidence");
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

test("enforces personal project evidence even when taxonomy says coding", () => {
  const decision = buildFactAnchorDecision({
    questionType: "coding",
    questionText: "What did you implement in this feature?",
    personalEvidenceGuardrailMode: "enforcement",
    memoryContext: makeMemoryResult([]),
  });

  assert.equal(decision.personalEvidence.enforced, true);
  assert.equal(decision.requiredFor, "project-deep-dive");
  assert.equal(decision.state, "no-anchor");
  assert.equal(decision.action, "ask-clarification");
  assert.equal(decision.unsupportedClaimRisk, "high");
});

test("shadow mode records the personal evidence signal without changing behavior", () => {
  const decision = buildFactAnchorDecision({
    questionType: "coding",
    questionText: "What did you implement in this feature?",
    personalEvidenceGuardrailMode: "shadow",
    memoryContext: makeMemoryResult([]),
  });

  assert.equal(decision.personalEvidence.confidenceTier, "high");
  assert.equal(decision.personalEvidence.enforced, false);
  assert.equal(decision.requiredFor, "none");
  assert.equal(decision.state, "not-required");
  assert.equal(decision.unsupportedClaimRisk, "shadow-observed");
});

test("does not enforce a hypothetical implementation request", () => {
  const decision = buildFactAnchorDecision({
    questionType: "coding",
    questionText: "How would you implement a stack with two queues?",
    personalEvidenceGuardrailMode: "enforcement",
    memoryContext: makeMemoryResult([]),
  });

  assert.equal(decision.personalEvidence.requirement, "not-required");
  assert.equal(decision.requiredFor, "none");
  assert.equal(decision.state, "not-required");
});

test("offers project choices instead of blending multiple eligible projects", () => {
  const decision = buildFactAnchorDecision({
    questionType: "project-deep-dive",
    memoryContext: makeMemoryResult([
      makeRetrievedEntry({
        entry: makeMemoryEntry({
          id: "mem_agentic",
          projectId: "agentic-memory",
          projectName: "Agentic Memory",
        }),
      }),
      makeRetrievedEntry({
        entry: makeMemoryEntry({
          id: "mem_model_interface",
          projectId: "model-interface",
          projectName: "Model Interface",
        }),
      }),
    ]),
    projectBindingDecision: {
      action: "needs-selection",
      candidates: [
        {
          projectId: "agentic-memory",
          projectName: "Agentic Memory",
          primaryEntryId: "mem_agentic",
          evidenceEntryIds: ["mem_agentic"],
          score: 100,
        },
        {
          projectId: "model-interface",
          projectName: "Model Interface",
          primaryEntryId: "mem_model_interface",
          evidenceEntryIds: ["mem_model_interface"],
          score: 90,
        },
      ],
      changed: false,
      reason: "multiple-eligible-evidence-projects",
    },
  });

  assert.equal(decision.action, "offer-supported-choices");
  assert.deepEqual(decision.supportedAnchorTitles, [
    "Agentic Memory",
    "Model Interface",
  ]);
  assert.equal(decision.unsupportedClaimRisk, "high");
});

test("a project binding filters unrelated retrieved fact evidence", () => {
  const decision = buildFactAnchorDecision({
    questionType: "project-deep-dive",
    memoryContext: makeMemoryResult([
      makeRetrievedEntry({
        entry: makeMemoryEntry({
          id: "mem_model_interface",
          projectId: "model-interface",
          projectName: "Model Interface",
        }),
      }),
      makeRetrievedEntry({
        entry: makeMemoryEntry({
          id: "mem_agentic",
          projectId: "agentic-memory",
          projectName: "Agentic Memory",
        }),
      }),
    ]),
    projectBindingDecision: {
      action: "preserve",
      binding: {
        projectId: "agentic-memory",
        projectName: "Agentic Memory",
        primaryEntryId: "mem_agentic",
        evidenceEntryIds: ["mem_agentic"],
        source: "memory",
        confidence: 0.96,
        lockedAt: 1,
        revision: 1,
        reason: "test-binding",
      },
      candidates: [],
      changed: false,
      reason: "existing-parent-binding-is-authoritative",
    },
  });

  assert.equal(decision.selectedAnchorId, "mem_agentic");
  assert.deepEqual(decision.supportedAnchorIds, ["mem_agentic"]);
  assert.deepEqual(decision.supportedAnchorTitles, ["Agentic Memory"]);
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
