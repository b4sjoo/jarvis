import assert from "node:assert/strict";
import test from "node:test";
import {
  createGeneralMemoryEligibilityRecorder,
  resolveGeneralMemoryEligibility,
} from "../src/lib/memory/general-eligibility.js";
import { resolveMemoryInterviewFamilies } from "../src/lib/memory/interview-family.js";
import type { MemoryEntry } from "../src/lib/memory/types.js";

test("allows explicitly reusable global profile metadata for its exact use case", () => {
  const entry = makeEntry({
    type: "profile",
    useCases: ["meeting_assistant"],
  });

  assert.deepEqual(decide(entry, "Tell me about a conflict."), {
    applies: true,
    eligible: true,
    scopePath: "explicit-reusable",
    evidence: ["type:profile", "entryUseCase:meeting_assistant"],
  });
});

test("allows a general entry bound to the current project", () => {
  const entry = makeEntry({
    type: "field_note",
    scope: "project",
    projectId: "agentic_memory",
    projectName: "Agentic Memory",
  });

  const decision = resolveGeneralMemoryEligibility({
    entry,
    familyDecision: resolveMemoryInterviewFamilies(entry),
    query: "What tradeoff did you make?",
    useCase: "project_deep_dive",
    projectAnchor: "Agentic Memory",
  });
  assert.equal(decision.eligible, true);
  assert.equal(decision.scopePath, "project-compatible");
});

test("allows strong structured current-question relevance", () => {
  const entry = makeEntry({
    title: "Redis failover alternatives",
    tags: ["redis", "failover"],
    keywords: ["sentinel", "cluster mode"],
  });

  const decision = decide(
    entry,
    "What Redis failover alternatives would you consider?"
  );
  assert.equal(decision.eligible, true);
  assert.equal(decision.scopePath, "strong-current-question");
});

test("rejects unrelated project notes before scoring", () => {
  const entry = makeEntry({
    id: "throttling-note",
    type: "field_note",
    scope: "project",
    projectId: "throttling",
    projectName: "Distributed Inference Throttling",
    title: "Token bucket lease behavior",
    content: "Nodes receive approximate token leases.",
  });

  const decision = resolveGeneralMemoryEligibility({
    entry,
    familyDecision: resolveMemoryInterviewFamilies(entry),
    query: "Implement a stack in Python.",
    useCase: "coding_interview",
    projectAnchor: "Agentic Memory",
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.rejectReason, "general-without-positive-scope");
});

test("broad model stack and implement tokens cannot authorize general memory", () => {
  const entry = makeEntry({
    type: "field_note",
    title: "Model implementation stack",
    tags: ["model", "stack", "implementation"],
    keywords: ["implement"],
    priority: "pinned",
    injectionMode: "always",
  });

  const decision = decide(entry, "Please implement the model stack.");
  assert.equal(decision.eligible, false);
  assert.equal(decision.rejectReason, "general-without-positive-scope");
});

test("specialized entries remain outside the general eligibility gate", () => {
  const entry = makeEntry({
    type: "coding_question",
    title: "Queue implementation",
  });
  assert.deepEqual(decide(entry, "Implement a queue."), {
    applies: false,
    eligible: true,
    evidence: [],
  });
});

test("summarizes bounded scope paths and rejected ids for trace metadata", () => {
  const recorder = createGeneralMemoryEligibilityRecorder();
  recorder.record("profile", decide(makeEntry({ type: "profile" }), "Hello"));
  recorder.record(
    "redis",
    decide(
      makeEntry({ tags: ["redis", "failover"] }),
      "Compare Redis failover options."
    )
  );
  recorder.record(
    "unrelated",
    decide(makeEntry({ title: "Unrelated note" }), "Implement a stack.")
  );

  assert.deepEqual(recorder.summary(), {
    evaluatedCount: 3,
    allowedCount: 2,
    rejectedCount: 1,
    scopePathCounts: {
      "explicit-reusable": 1,
      "project-compatible": 0,
      "strong-current-question": 1,
    },
    allowedSamples: [
      { entryId: "profile", scopePath: "explicit-reusable" },
      { entryId: "redis", scopePath: "strong-current-question" },
    ],
    rejectedEntryIds: ["unrelated"],
  });
});

function decide(entry: MemoryEntry, query: string) {
  return resolveGeneralMemoryEligibility({
    entry,
    familyDecision: resolveMemoryInterviewFamilies(entry),
    query,
    useCase: "behavioral_interview",
  });
}

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "general-entry",
    sourceIds: [],
    type: "field_note",
    title: "General communication guidance",
    content: "Use a concise answer with concrete evidence.",
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
