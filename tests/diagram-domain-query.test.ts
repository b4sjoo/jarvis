import assert from "node:assert/strict";
import test from "node:test";
import { gateDiagramOverlayEntriesByDomain } from "../src/lib/memory/diagram-overlay.js";
import type { MemoryEntry } from "../src/lib/memory/types.js";
import { buildCurrentTaskDiagramDomainContext } from "../src/lib/meeting/diagram-domain-query.js";

test("new parent excludes the unrelated prior parent domain", () => {
  const context = buildCurrentTaskDiagramDomainContext({
    currentQuestion: "Design an Instagram social feed",
    parentTopic: "Design an Uber-like driver location system",
    relation: "new-parent",
  });

  assert.equal(context.query, "Design an Instagram social feed");
  assert.deepEqual(context.evidenceSources, ["current-question"]);
  assert.equal(context.parentTopicIncluded, false);
  assert.deepEqual(
    gateDiagramOverlayEntriesByDomain(makeOverlays(), {
      query: context.query,
      questionType: "general-system-design",
    }).allowedEntryIds,
    ["mem_overlay_feed"]
  );
});

test("broad RAG interview context cannot widen a current ticket domain", () => {
  const ordinaryRetrievalQuery = [
    "interview brief: RAG and agentic AI",
    "current question: Design a ticket selling system",
  ].join("\n");
  const context = buildCurrentTaskDiagramDomainContext({
    currentQuestion: "Design a ticket selling system",
    parentTopic: "Design a RAG assistant",
    relation: "new-parent",
  });

  assert.match(ordinaryRetrievalQuery, /RAG/i);
  assert.doesNotMatch(context.query, /RAG/i);
  assert.deepEqual(
    gateDiagramOverlayEntriesByDomain(makeOverlays(), {
      query: context.query,
      questionType: "general-system-design",
    }).allowedEntryIds,
    ["mem_overlay_inventory"]
  );
});

test("child probe keeps the active AI/ML parent as primary domain evidence", () => {
  const context = buildCurrentTaskDiagramDomainContext({
    currentQuestion: "Implement the loss function in Python",
    parentTopic: "Design a real-time ML ranking system with model serving",
    relation: "child-probe",
  });

  assert.equal(context.parentTopicIncluded, true);
  assert.deepEqual(context.evidenceSources, [
    "active-parent-topic",
    "current-question",
  ]);
  assert.deepEqual(
    gateDiagramOverlayEntriesByDomain(makeOverlays(), {
      query: context.query,
      questionType: "ai-ml-system-design",
    }).allowedEntryIds,
    ["mem_overlay_ml"]
  );
});

test("screen question excludes company-like capture title evidence", () => {
  const context = buildCurrentTaskDiagramDomainContext({
    currentQuestion: "Design a RAG trip planning assistant",
    relation: "new-parent",
    captureTitleFallback: "Amazon interview guide",
  });

  assert.equal(context.query, "Design a RAG trip planning assistant");
  assert.deepEqual(context.evidenceSources, ["current-question"]);
  assert.deepEqual(
    gateDiagramOverlayEntriesByDomain(makeOverlays(), {
      query: context.query,
      questionType: "ai-ml-system-design",
    }).allowedEntryIds,
    ["mem_overlay_rag"]
  );
});

test("capture title is weak fallback only when no focused question exists", () => {
  const context = buildCurrentTaskDiagramDomainContext({
    relation: "new-parent",
    captureTitleFallback: "Ticket reservation system design",
  });

  assert.equal(context.query, "Ticket reservation system design");
  assert.deepEqual(context.evidenceSources, ["capture-title-fallback"]);
});

test("unknown current task produces no diagram domain", () => {
  const context = buildCurrentTaskDiagramDomainContext({
    relation: "unknown",
  });

  assert.equal(context.query, "");
  assert.deepEqual(context.evidenceSources, []);
  assert.deepEqual(
    gateDiagramOverlayEntriesByDomain(makeOverlays(), {
      query: context.query,
      questionType: "general-system-design",
    }).allowedEntryIds,
    []
  );
});

function makeOverlays() {
  return [
    makeOverlay("mem_overlay_geo", "Geo location driver matching"),
    makeOverlay("mem_overlay_inventory", "Ticket reservation inventory"),
    makeOverlay("mem_overlay_feed", "Social feed fanout timeline"),
    makeOverlay("mem_overlay_rag", "RAG vector retrieval pipeline"),
    makeOverlay(
      "mem_overlay_ml",
      "ML system design feature store model training serving drift"
    ),
  ];
}

function makeOverlay(id: string, text: string): MemoryEntry {
  return {
    id,
    sourceIds: [],
    type: "architecture_diagram",
    title: text,
    content: text,
    scope: "global",
    tags: text.toLowerCase().split(/\s+/),
    keywords: text.toLowerCase().split(/\s+/),
    priority: "normal",
    enabled: true,
    injectionMode: "retrieval",
    useCases: ["meeting_assistant"],
    confidentiality: "normal",
    curationStatus: "curated",
    relatedEntryIds: [],
    evidenceEntryIds: [],
    createdAt: 1_779_000_000_000,
    updatedAt: 1_779_000_000_000,
  };
}
