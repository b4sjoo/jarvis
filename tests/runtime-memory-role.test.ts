import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRuntimeMemoryRoleTelemetry,
  classifyRuntimeMemoryRole,
  extractRuntimeFactAnchorLabels,
} from "../src/lib/memory/runtime-role.js";
import type {
  MemoryEntry,
  RetrievedMemoryEntry,
} from "../src/lib/memory/types.js";

test("classifies direct and project-scoped evidence conservatively", () => {
  assert.deepEqual(
    classifyRuntimeMemoryRole(
      makeMemoryEntry({ type: "resume_fact", title: "Resume fact" })
    ),
    {
      role: "fact-evidence",
      anchorEligible: true,
      anchorEligibilityReason: "direct-fact-entry-type:resume_fact",
    }
  );

  const projectEvidence = classifyRuntimeMemoryRole(
    makeMemoryEntry({
      type: "implementation_note",
      projectId: "agentic-memory",
      projectName: "Agentic Memory",
    })
  );
  assert.equal(projectEvidence.role, "fact-evidence");
  assert.equal(projectEvidence.anchorEligible, true);

  const unboundImplementationNote = classifyRuntimeMemoryRole(
    makeMemoryEntry({ type: "implementation_note" })
  );
  assert.equal(unboundImplementationNote.role, "guidance");
  assert.equal(unboundImplementationNote.anchorEligible, false);
});

test("keeps guidance, templates, and overlays out of fact anchors", () => {
  const guidance = classifyRuntimeMemoryRole(
    makeMemoryEntry({
      type: "field_note",
      title: "RAG failure modes",
      projectName: "Agentic Memory",
    })
  );
  assert.equal(guidance.role, "guidance");
  assert.equal(guidance.anchorEligible, false);

  const template = classifyRuntimeMemoryRole(
    makeMemoryEntry({
      type: "answer_template",
      evidenceEntryIds: ["mem_evidence"],
    })
  );
  assert.equal(template.role, "template");
  assert.equal(template.anchorEligible, false);
  assert.match(template.anchorEligibilityReason, /separately-retrieved/);

  const overlay = classifyRuntimeMemoryRole(
    makeMemoryEntry({ type: "architecture_diagram" })
  );
  assert.equal(overlay.role, "overlay");
  assert.equal(overlay.anchorEligible, false);
});

test("extracts anchors and telemetry only from eligible fact evidence", () => {
  const entries = [
    makeRetrievedEntry(
      makeMemoryEntry({
        id: "mem_evidence",
        type: "answer_evidence",
        projectName: "AOS cleanup",
      })
    ),
    makeRetrievedEntry(
      makeMemoryEntry({
        id: "mem_template",
        type: "answer_template",
        projectName: "AOS cleanup",
        evidenceEntryIds: ["mem_evidence"],
      })
    ),
    makeRetrievedEntry(
      makeMemoryEntry({ id: "mem_guidance", type: "field_note" })
    ),
    makeRetrievedEntry(
      makeMemoryEntry({ id: "mem_overlay", type: "whiteboard_overlay" })
    ),
  ];

  assert.deepEqual(extractRuntimeFactAnchorLabels(entries), ["AOS cleanup"]);

  const telemetry = buildRuntimeMemoryRoleTelemetry(entries);
  assert.deepEqual(telemetry.counts, {
    "fact-evidence": 1,
    guidance: 1,
    template: 1,
    overlay: 1,
  });
  assert.equal(telemetry.anchorEligibleCount, 1);
  assert.equal(telemetry.anchorIneligibleCount, 3);
});

function makeRetrievedEntry(entry: MemoryEntry): RetrievedMemoryEntry {
  return {
    entry,
    score: 100,
    matchReason: [],
    injectedContent: entry.content,
  };
}

function makeMemoryEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  const now = 1_779_000_000_000;
  return {
    id: "mem_1",
    sourceIds: [],
    type: "field_note",
    title: "Memory",
    content: "Memory content",
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
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
