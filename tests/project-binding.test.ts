import assert from "node:assert/strict";
import test from "node:test";
import {
  formatProjectBindingDecisionForTrace,
  resolveProjectBinding,
} from "../src/lib/meeting/project-binding.js";
import type {
  MemoryEntry,
  MemoryRetrievalResult,
  RetrievedMemoryEntry,
} from "../src/lib/memory/types.js";
import type { ProjectBinding } from "../src/lib/meeting/types.js";

test("binds the only eligible evidence project without a model decision", () => {
  const decision = resolveProjectBinding({
    questionType: "project-deep-dive",
    relation: "new-parent",
    memoryContext: makeMemoryResult([
      makeEvidence("mem_agentic_overview", "agentic-memory", "Agentic Memory"),
      makeEvidence("mem_agentic_tradeoff", "agentic-memory", "Agentic Memory"),
    ]),
    now: 100,
  });

  assert.equal(decision.action, "bind");
  assert.equal(decision.binding?.projectName, "Agentic Memory");
  assert.equal(decision.binding?.primaryEntryId, "mem_agentic_overview");
  assert.deepEqual(decision.binding?.evidenceEntryIds, [
    "mem_agentic_overview",
    "mem_agentic_tradeoff",
  ]);
  assert.equal(decision.binding?.revision, 1);
});

test("does not treat guidance as a bindable project", () => {
  const decision = resolveProjectBinding({
    questionType: "project-deep-dive",
    relation: "new-parent",
    projectAnchor: "Agentic Memory",
    memoryContext: makeMemoryResult([
      makeRetrieved(
        makeEntry({
          id: "mem_agentic_guidance",
          type: "field_note",
          title: "Agentic Memory interview guidance",
          projectId: "agentic-memory",
          projectName: "Agentic Memory",
        })
      ),
    ]),
  });

  assert.equal(decision.action, "needs-selection");
  assert.equal(decision.binding, undefined);
  assert.deepEqual(decision.candidates, []);
});

test("requires selection when multiple evidence projects are eligible", () => {
  const decision = resolveProjectBinding({
    questionType: "project-deep-dive",
    relation: "new-parent",
    memoryContext: makeMemoryResult([
      makeEvidence("mem_agentic", "agentic-memory", "Agentic Memory"),
      makeEvidence("mem_model_interface", "model-interface", "Model Interface"),
    ]),
  });

  assert.equal(decision.action, "needs-selection");
  assert.deepEqual(
    decision.candidates.map((candidate) => candidate.projectName),
    ["Agentic Memory", "Model Interface"]
  );
});

test("uses a project hint only when it resolves to one evidence project", () => {
  const decision = resolveProjectBinding({
    questionType: "project-deep-dive",
    relation: "new-parent",
    projectAnchor: "Please tell me about the Model Interface project",
    memoryContext: makeMemoryResult([
      makeEvidence("mem_agentic", "agentic-memory", "Agentic Memory"),
      makeEvidence("mem_model_interface", "model-interface", "Model Interface"),
    ]),
  });

  assert.equal(decision.action, "bind");
  assert.equal(decision.binding?.projectId, "model-interface");
  assert.equal(decision.reason, "project-hint-matched-one-evidence-project");
});

test("preserves an existing binding through a child probe", () => {
  const existingBinding = makeBinding();
  const decision = resolveProjectBinding({
    existingBinding,
    questionType: "field-knowledge",
    relation: "child-probe",
    memoryContext: makeMemoryResult([
      makeEvidence("mem_other", "model-interface", "Model Interface"),
    ]),
  });

  assert.equal(decision.action, "preserve");
  assert.equal(decision.binding?.projectId, "agentic-memory");
  assert.equal(decision.changed, false);
});

test("explicit selection can revise the project binding", () => {
  const decision = resolveProjectBinding({
    existingBinding: makeBinding(),
    questionType: "project-deep-dive",
    relation: "followup-parent",
    explicitProjectSelection: "Model Interface",
    explicitSelectionSource: "correction",
    memoryContext: makeMemoryResult([
      makeEvidence("mem_agentic", "agentic-memory", "Agentic Memory"),
      makeEvidence("mem_model_interface", "model-interface", "Model Interface"),
    ]),
    now: 200,
  });

  assert.equal(decision.action, "bind");
  assert.equal(decision.binding?.projectId, "model-interface");
  assert.equal(decision.binding?.source, "correction");
  assert.equal(decision.binding?.revision, 3);
  assert.equal(decision.changed, true);
});

test("an unsupported explicit selection cannot silently replace the binding", () => {
  const decision = resolveProjectBinding({
    existingBinding: makeBinding(),
    questionType: "project-deep-dive",
    relation: "followup-parent",
    explicitProjectSelection: "Uncurated Secret Project",
    explicitSelectionSource: "correction",
    memoryContext: makeMemoryResult([
      makeEvidence("mem_agentic", "agentic-memory", "Agentic Memory"),
    ]),
  });

  assert.equal(decision.action, "needs-selection");
  assert.equal(decision.binding, undefined);
  assert.equal(
    decision.reason,
    "explicit-selection-has-no-eligible-evidence-match"
  );
});

test("a new parent does not inherit the old project binding", () => {
  const decision = resolveProjectBinding({
    existingBinding: makeBinding(),
    questionType: "project-deep-dive",
    relation: "new-parent",
    memoryContext: makeMemoryResult([
      makeEvidence("mem_model_interface", "model-interface", "Model Interface"),
    ]),
    now: 300,
  });

  assert.equal(decision.action, "bind");
  assert.equal(decision.binding?.projectId, "model-interface");
  assert.equal(decision.binding?.revision, 1);
});

test("a screen project hint without eligible evidence cannot bind", () => {
  const decision = resolveProjectBinding({
    questionType: "project-deep-dive",
    relation: "new-parent",
    projectAnchor: "Microsoft MCP",
    memoryContext: makeMemoryResult([]),
  });

  assert.equal(decision.action, "needs-selection");
  assert.equal(decision.binding, undefined);
  assert.equal(
    formatProjectBindingDecisionForTrace(decision).projectBindingCandidateCount,
    0
  );
});

function makeBinding(): ProjectBinding {
  return {
    projectId: "agentic-memory",
    projectName: "Agentic Memory",
    primaryEntryId: "mem_agentic",
    evidenceEntryIds: ["mem_agentic"],
    source: "memory",
    confidence: 0.96,
    lockedAt: 50,
    revision: 2,
    reason: "existing-test-binding",
  };
}

function makeEvidence(id: string, projectId: string, projectName: string) {
  return makeRetrieved(
    makeEntry({
      id,
      type: "project_context",
      title: `${projectName} evidence`,
      projectId,
      projectName,
    })
  );
}

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
      useCase: "project_deep_dive",
      maxEntries: 6,
      maxChars: 6000,
      perEntryMaxChars: 1200,
    },
  };
}

function makeRetrieved(entry: MemoryEntry): RetrievedMemoryEntry {
  return {
    entry,
    score: 100,
    matchReason: [],
    injectedContent: entry.content,
  };
}

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "mem_1",
    sourceIds: [],
    type: "project_context",
    title: "Memory",
    content: "Concrete project evidence.",
    scope: "project",
    tags: [],
    keywords: [],
    priority: "normal",
    enabled: true,
    injectionMode: "retrieval",
    useCases: ["project_deep_dive"],
    confidentiality: "normal",
    curationStatus: "curated",
    relatedEntryIds: [],
    evidenceEntryIds: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}
