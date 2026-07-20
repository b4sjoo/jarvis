import assert from "node:assert/strict";
import test from "node:test";
import {
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
