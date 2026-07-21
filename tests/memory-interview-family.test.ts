import assert from "node:assert/strict";
import test from "node:test";
import {
  auditMemoryInterviewFamilyNormalization,
  getMemoryInterviewFamilyGateRejectReason,
  resolveMemoryInterviewFamilies,
} from "../src/lib/memory/interview-family.js";
import { classifyRuntimeMemoryRole } from "../src/lib/memory/runtime-role.js";
import type { MemoryEntry } from "../src/lib/memory/types.js";

test("specialized project evidence receives families independently from runtime role", () => {
  const entry = makeEntry({
    type: "implementation_note",
    scope: "project",
    projectId: "agentic-memory",
    projectName: "Agentic Memory",
    title: "Agentic Memory retrieval pipeline",
  });

  assert.deepEqual(resolveMemoryInterviewFamilies(entry), {
    families: ["ai-ml-system-design", "project-deep-dive"],
    source: "inferred",
    evidence: ["ai-ml-metadata", "project-metadata"],
  });
  assert.equal(classifyRuntimeMemoryRole(entry).role, "fact-evidence");
});

test("specialized fact evidence cannot bypass an incompatible interview family gate", () => {
  const entry = makeEntry({
    type: "answer_evidence",
    title: "RAG model serving evidence",
  });

  assert.equal(
    getMemoryInterviewFamilyGateRejectReason({
      entry,
      interviewTypes: ["behavioral"],
      questionType: "behavioral",
    }),
    "brief-interview-type-blocked"
  );
});

test("multi-family memories pass when one family is explicitly allowed", () => {
  const entry = makeEntry({
    type: "implementation_note",
    scope: "project",
    projectId: "agentic-memory",
    title: "Agentic Memory architecture",
  });

  assert.equal(
    getMemoryInterviewFamilyGateRejectReason({
      entry,
      interviewTypes: ["mixed"],
      questionType: "project-deep-dive",
      memoryPolicy: {
        id: "project-only",
        allowedFamilies: ["project-deep-dive"],
      },
    }),
    undefined
  );
});

test("explicit families override inference and general memory stays general", () => {
  assert.deepEqual(
    resolveMemoryInterviewFamilies(
      makeEntry({
        title: "RAG notes",
        interviewFamilies: ["project-deep-dive"],
      })
    ),
    {
      families: ["project-deep-dive"],
      source: "explicit",
      evidence: ["explicit:project-deep-dive"],
    }
  );
  assert.deepEqual(resolveMemoryInterviewFamilies(makeEntry({})).families, [
    "general",
  ]);
});

test("behavioral evaluation language does not create an AI/ML escape family", () => {
  const decision = resolveMemoryInterviewFamilies(
    makeEntry({
      type: "evaluation_criteria",
      title: "Amazon behavioral evaluation rubric",
      useCases: ["behavioral_interview"],
    })
  );

  assert.deepEqual(decision.families, ["behavioral"]);
});

test("hyphenated and underscored specialized metadata resolves to canonical families", () => {
  assert.deepEqual(
    resolveMemoryInterviewFamilies(
      makeEntry({ tags: ["general-system-design"] })
    ).families,
    ["system-design"]
  );
  assert.deepEqual(
    resolveMemoryInterviewFamilies(
      makeEntry({ tags: ["ai_ml_system_design"] })
    ).families,
    ["ai-ml-system-design", "system-design"]
  );
  assert.deepEqual(
    resolveMemoryInterviewFamilies(
      makeEntry({ tags: ["project-deep-dive"] })
    ).families,
    ["project-deep-dive"]
  );
});

test("hyphenated general system-design templates are blocked by the coding playbook", () => {
  const entryIds = [
    "mem_gsd_source_truth_derived_cdc",
    "mem_gsd_sharding_consistent_hashing",
    "mem_gsd_transactions_invariants_failure",
    "mem_gsd_cache_cdn_policy",
  ];

  for (const id of entryIds) {
    const entry = makeEntry({
      id,
      title: "Reusable architecture template",
      tags: ["system-design", "general-system-design"],
    });
    assert.deepEqual(resolveMemoryInterviewFamilies(entry).families, [
      "system-design",
    ]);
    assert.equal(
      getMemoryInterviewFamilyGateRejectReason({
        entry,
        interviewTypes: ["mixed"],
        questionType: "coding",
        memoryPolicy: {
          id: "coding-only",
          allowedFamilies: ["coding"],
        },
      }),
      "playbook-family-blocked"
    );
  }
});

test("family audit preserves truly general entries and reports no normalized alias leaks", () => {
  const general = makeEntry({
    id: "mem_general_preference",
    title: "Communication preference",
    tags: ["meeting-assistant"],
  });
  const specialized = makeEntry({
    id: "mem_system_design",
    title: "Architecture template",
    tags: ["system-design"],
  });

  assert.deepEqual(resolveMemoryInterviewFamilies(general).families, ["general"]);
  assert.deepEqual(
    auditMemoryInterviewFamilyNormalization([general, specialized]),
    []
  );
});

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "mem_family",
    sourceIds: [],
    type: "field_note",
    title: "General communication preference",
    content: "Keep answers concise.",
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
