import assert from "node:assert/strict";
import test from "node:test";
import {
  settleMemoryContextForProjectBinding,
} from "../src/lib/meeting/project-memory-settlement.js";
import type {
  MemoryEntry,
  MemoryRetrievalResult,
  RetrievedMemoryEntry,
} from "../src/lib/memory/types.js";
import type {
  ProjectBindingDecision,
} from "../src/lib/meeting/types.js";

test("keeps only the settled project and global guidance", () => {
  const settlement = settleMemoryContextForProjectBinding({
    candidateContext: makeMemoryResult([
      makeRetrieved(
        makeEntry({
          id: "mem_agentic_fact",
          projectId: "agentic-memory",
          projectName: "Agentic Memory",
        })
      ),
      makeRetrieved(
        makeEntry({
          id: "mem_throttling_fact",
          projectId: "throttling",
          projectName: "Distributed Inference Throttling",
        })
      ),
      makeRetrieved(
        makeEntry({
          id: "mem_project_framework",
          type: "interview_framework",
          title: "Project interview framework",
          scope: "global",
          projectId: undefined,
          projectName: undefined,
        })
      ),
    ]),
    bindingDecision: makeBindingDecision(),
  });

  assert.equal(settlement.state, "settled");
  assert.deepEqual(settlement.selectedEntryIds, [
    "mem_agentic_fact",
    "mem_project_framework",
  ]);
  assert.deepEqual(settlement.rejectedEntryIds, [
    "mem_throttling_fact",
  ]);
  assert.match(
    settlement.memoryContext?.contextText ?? "",
    /mem_agentic_fact/
  );
  assert.doesNotMatch(
    settlement.memoryContext?.contextText ?? "",
    /mem_throttling_fact/
  );
  assert.equal(
    settlement.memoryContext?.policySnapshot.strictProjectAnchor,
    "agentic-memory"
  );
});

test("blocks project facts while the binding needs selection", () => {
  const settlement = settleMemoryContextForProjectBinding({
    candidateContext: makeMemoryResult([
      makeRetrieved(
        makeEntry({
          id: "mem_agentic_fact",
          projectId: "agentic-memory",
          projectName: "Agentic Memory",
        })
      ),
      makeRetrieved(
        makeEntry({
          id: "mem_global_guidance",
          type: "evaluation_criteria",
          title: "Project answer guidance",
          scope: "global",
          projectId: undefined,
          projectName: undefined,
        })
      ),
    ]),
    bindingDecision: {
      action: "needs-selection",
      candidates: [],
      changed: false,
      sourceAuthority: "memory-candidate",
      sourceTurnIds: ["turn_1"],
      sourceObservationIds: [],
      topicCompatible: true,
      bindingRevision: 0,
      reason: "multiple-eligible-evidence-projects",
    },
  });

  assert.equal(settlement.state, "blocked-unsettled-binding");
  assert.deepEqual(settlement.selectedEntryIds, ["mem_global_guidance"]);
  assert.deepEqual(settlement.rejectedEntryIds, ["mem_agentic_fact"]);
});

test("does not filter memory for a task without project binding", () => {
  const candidateContext = makeMemoryResult([
    makeRetrieved(
      makeEntry({
        id: "mem_field_note",
        projectId: "agentic-memory",
        projectName: "Agentic Memory",
      })
    ),
  ]);
  const settlement = settleMemoryContextForProjectBinding({
    candidateContext,
    bindingDecision: {
      action: "not-applicable",
      candidates: [],
      changed: false,
      sourceAuthority: "memory-candidate",
      sourceTurnIds: [],
      sourceObservationIds: [],
      topicCompatible: true,
      bindingRevision: 0,
      reason: "task-does-not-require-project-binding",
    },
  });

  assert.equal(settlement.state, "not-applicable");
  assert.deepEqual(settlement.selectedEntryIds, ["mem_field_note"]);
});

function makeBindingDecision(): ProjectBindingDecision {
  return {
    action: "bind",
    binding: {
      projectId: "agentic-memory",
      projectName: "Agentic Memory",
      primaryEntryId: "mem_agentic_fact",
      evidenceEntryIds: ["mem_agentic_fact"],
      source: "interviewer-explicit",
      confidence: 1,
      lockedAt: 1,
      revision: 2,
      reason: "interviewer-explicit-project-selection",
      authority: "interviewer-explicit",
      sourceTurnIds: ["turn_1"],
      sourceObservationIds: [],
    },
    candidates: [],
    changed: true,
    sourceAuthority: "interviewer-explicit",
    sourceTurnIds: ["turn_1"],
    sourceObservationIds: [],
    topicCompatible: true,
    bindingRevision: 2,
    reason: "interviewer-explicit-matched-eligible-evidence",
  };
}

function makeMemoryResult(
  entries: RetrievedMemoryEntry[]
): MemoryRetrievalResult {
  return {
    entries,
    contextText: entries.map((item) => item.injectedContent).join("\n"),
    totalChars: entries.reduce(
      (total, item) => total + item.injectedContent.length,
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
    matchReason: ["content:1"],
    injectedContent: entry.content,
  };
}

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "mem_default",
    sourceIds: ["source_1"],
    type: "project_context",
    title: "Project fact",
    content: "Concrete project fact evidence.",
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
