import assert from "node:assert/strict";
import test from "node:test";
import {
  createGeneralMemoryEligibilityRecorder,
  resolveGeneralMemoryEligibility,
  resolveMemoryEligibilityQuery,
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

test("rejects Oasis NDJSON memory for an unrelated LRU coding question", () => {
  const entry = makeEntry({
    id: "mem_oasis_ndjson_bulk_requirement",
    type: "field_note",
    title: "NDJSON requirement for OpenSearch bulk operations",
    summary:
      "OpenSearch Bulk API requires newline-delimited JSON so each operation can be processed independently.",
    content:
      "The backend server can stream bulk operations and report partial failures per item.",
    scope: "project",
    projectId: "oasis",
    projectName: "Oasis",
    tags: ["ndjson", "bulk-api", "opensearch", "field-knowledge"],
    keywords: [
      "NDJSON",
      "newline-delimited JSON",
      "Bulk API",
      "partial failure",
      "streaming parser",
    ],
  });

  const decision = resolveGeneralMemoryEligibility({
    entry,
    familyDecision: resolveMemoryInterviewFamilies(entry),
    query:
      "Implement an LRU cache for a backend service and explain the operations.",
    useCase: "coding_interview",
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.rejectReason, "general-without-positive-scope");
  assert.equal(
    decision.projectScopeEvidence?.discriminativeAnchorMatchCount,
    0
  );
  assert.ok(
    (decision.projectScopeEvidence?.genericContentMatchCount ?? 0) > 0
  );
});

test("uses only the current question for project-scoped eligibility", () => {
  const entry = makeEntry({
    id: "mem_oasis_ndjson_bulk_requirement",
    type: "field_note",
    title: "NDJSON requirement for OpenSearch bulk operations",
    summary: "OpenSearch Bulk API uses newline-delimited JSON.",
    content: "Each operation can report a partial failure.",
    scope: "project",
    projectId: "oasis",
    projectName: "Oasis",
    tags: ["ndjson", "bulk-api", "opensearch"],
    keywords: ["NDJSON", "Bulk API", "partial failure"],
  });
  const retrievalQuery = [
    "Implement an LRU cache with O(1) get and put.",
    "Preparation guidance: Agentic Memory in OpenSearch ML Commons.",
  ].join("\n");
  const bounded = resolveMemoryEligibilityQuery({
    retrievalQuery,
    currentQuestionQuery: "Implement an LRU cache with O(1) get and put.",
  });

  assert.equal(bounded.source, "current-question");
  assert.equal(decide(entry, bounded.query).eligible, false);
  assert.equal(decide(entry, retrievalQuery).eligible, true);
});

test("falls back to the retrieval query when no current question exists", () => {
  assert.deepEqual(
    resolveMemoryEligibilityQuery({
      retrievalQuery: "Why does the OpenSearch Bulk API use NDJSON?",
    }),
    {
      query: "Why does the OpenSearch Bulk API use NDJSON?",
      source: "retrieval-query",
    }
  );
});

test("allows project-scoped general memory for an exact product or API anchor", () => {
  const entry = makeEntry({
    type: "field_note",
    title: "NDJSON requirement for OpenSearch bulk operations",
    scope: "project",
    projectId: "oasis",
    projectName: "Oasis",
    tags: ["ndjson", "bulk-api", "opensearch"],
    keywords: ["NDJSON", "Bulk API"],
  });

  const decision = decide(
    entry,
    "Why does the OpenSearch Bulk API require NDJSON?"
  );
  assert.equal(decision.eligible, true);
  assert.equal(decision.scopePath, "strong-current-question");
  assert.ok(
    (decision.projectScopeEvidence?.discriminativeAnchorMatchCount ?? 0) > 0
  );
});

test("does not treat generic project metadata as a discriminative anchor", () => {
  const entry = makeEntry({
    type: "field_note",
    title: "Backend API implementation requirement",
    scope: "project",
    projectId: "private_service",
    projectName: "Private Service",
    tags: ["backend", "api", "field-knowledge"],
    keywords: ["backend API"],
  });

  const decision = decide(entry, "Explain the backend API requirement.");
  assert.equal(decision.eligible, false);
  assert.equal(
    decision.projectScopeEvidence?.discriminativeAnchorMatchCount,
    0
  );
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
    projectScopedEvidence: {
      evaluatedCount: 0,
      allowedByDiscriminativeAnchorCount: 0,
      rejectedWithGenericOverlapCount: 0,
      samples: [],
    },
  });
});

test("summarizes discriminative anchors separately from generic overlap", () => {
  const recorder = createGeneralMemoryEligibilityRecorder();
  const entry = makeEntry({
    id: "oasis-note",
    title: "NDJSON requirement for OpenSearch bulk operations",
    summary:
      "OpenSearch Bulk API requires newline-delimited JSON for each operation.",
    content:
      "The backend server can stream bulk operations and report partial failures.",
    scope: "project",
    projectId: "oasis",
    projectName: "Oasis",
    tags: ["ndjson", "bulk-api", "opensearch"],
    keywords: ["NDJSON", "Bulk API"],
  });
  recorder.record(
    entry.id,
    decide(
      entry,
      "Implement an LRU cache for a backend service and explain the operations."
    )
  );
  recorder.record(
    entry.id,
    decide(entry, "Why does the OpenSearch Bulk API require NDJSON?")
  );

  const evidence = recorder.summary().projectScopedEvidence;
  assert.equal(evidence.evaluatedCount, 2);
  assert.equal(evidence.allowedByDiscriminativeAnchorCount, 1);
  assert.equal(evidence.rejectedWithGenericOverlapCount, 1);
  assert.equal(evidence.samples[0]?.entryId, "oasis-note");
  assert.equal(evidence.samples[0]?.eligible, false);
  assert.equal(evidence.samples[0]?.discriminativeAnchorMatchCount, 0);
  assert.ok(
    (evidence.samples[0]?.genericStructuredMatchCount ?? 0) > 0 ||
      (evidence.samples[0]?.genericContentMatchCount ?? 0) > 0
  );
  assert.equal(evidence.samples[1]?.entryId, "oasis-note");
  assert.equal(evidence.samples[1]?.eligible, true);
  assert.ok(
    (evidence.samples[1]?.discriminativeAnchorMatchCount ?? 0) > 0
  );
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
