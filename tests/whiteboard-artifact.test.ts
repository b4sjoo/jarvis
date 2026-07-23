import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveWhiteboardArtifactDisplay,
  updateWhiteboardArtifactFromAnswer,
} from "../src/lib/meeting/whiteboard-artifact.js";

const WHITEBOARD_ANSWER = `
中文思路:
先明确库存一致性和热点。

Answer:
I would design this around a reservation state machine.

Whiteboard:
Scope: ticket booking for scarce inventory.
Flow: Client -> API -> Reservation Service -> Inventory DB -> Payment -> Event Log.
Invariant: no seat can be confirmed twice.
Observability: hold expiry, oversell count, payment mismatch.
`;

test("creates a first-class whiteboard artifact for system design answers", () => {
  const artifact = updateWhiteboardArtifactFromAnswer({
    parentTaskId: "parent_1",
    parentQuestionType: "general-system-design",
    parentTopic: "Design a ticket selling system",
    finalContent: WHITEBOARD_ANSWER,
    phase: "design_framing",
    traceId: "trace_1",
    selectedOverlayIds: ["mem_overlay_scarce_inventory_booking"],
    updateSource: "model-output",
    now: 1_779_000_000_000,
  });

  assert.ok(artifact);
  assert.equal(artifact.parentTaskId, "parent_1");
  assert.equal(artifact.revision, 1);
  assert.equal(artifact.domainTrack, "general_sd");
  assert.deepEqual(artifact.selectedOverlayIds, [
    "mem_overlay_scarce_inventory_booking",
  ]);
  assert.match(artifact.summary, /Reservation Service/);
});

test("creates a provisional revision-one skeleton during requirement clarification", () => {
  const artifact = updateWhiteboardArtifactFromAnswer({
    parentTaskId: "parent_provisional",
    parentQuestionType: "general-system-design",
    parentTopic: "Design an Uber-like app",
    finalContent:
      "Answer:\nI would first clarify traffic, consistency, and latency.",
    phase: "requirement_clarification",
    provisional: true,
    openConstraintCategories: [
      "scale_qps",
      "consistency_invariant",
      "latency_sla",
    ],
    revisionReason: "provisional-requirement-framing",
    updateSource: "new-parent",
    now: 1,
  });

  assert.ok(artifact);
  assert.equal(artifact.revision, 1);
  assert.equal(artifact.provisional, true);
  assert.deepEqual(artifact.openConstraintCategories, [
    "scale_qps",
    "consistency_invariant",
    "latency_sla",
  ]);
  assert.equal(
    artifact.revisionReason,
    "provisional-requirement-framing"
  );
  assert.match(artifact.content, /PROVISIONAL r1/);
  assert.match(artifact.content, /Client -> Interface\/API/);
});

test("refines the same provisional artifact after requirement readiness", () => {
  const provisional = updateWhiteboardArtifactFromAnswer({
    parentTaskId: "parent_aiml",
    parentQuestionType: "ai-ml-system-design",
    parentTopic: "Design a RAG trip planner",
    finalContent: "Answer:\nI would clarify objective, data, and latency.",
    phase: "requirement_clarification",
    provisional: true,
    openConstraintCategories: ["success_evaluation", "data_grounding"],
    updateSource: "new-parent",
    now: 1,
  });

  const refined = updateWhiteboardArtifactFromAnswer({
    existing: provisional,
    parentTaskId: "parent_aiml",
    parentQuestionType: "ai-ml-system-design",
    parentTopic: "Design a RAG trip planner",
    finalContent:
      "Whiteboard:\nTravel data -> index -> retrieve -> rerank -> generate -> citation checks.",
    phase: "design_framing",
    provisional: false,
    openConstraintCategories: [],
    revisionReason: "requirement-readiness-satisfied",
    updateSource: "model-output",
    now: 2,
  });

  assert.ok(refined);
  assert.equal(refined.id, provisional?.id);
  assert.equal(refined.revision, 2);
  assert.equal(refined.provisional, false);
  assert.deepEqual(refined.openConstraintCategories, []);
  assert.match(refined.content, /rerank/);
});

test("preserves existing artifact when a follow-up has no whiteboard section", () => {
  const artifact = updateWhiteboardArtifactFromAnswer({
    parentTaskId: "parent_1",
    parentQuestionType: "general-system-design",
    parentTopic: "Design a ticket selling system",
    finalContent: WHITEBOARD_ANSWER,
    phase: "design_framing",
    updateSource: "model-output",
    now: 1,
  });

  const preserved = updateWhiteboardArtifactFromAnswer({
    existing: artifact,
    parentTaskId: "parent_1",
    parentQuestionType: "general-system-design",
    parentTopic: "Design a ticket selling system",
    finalContent: "Answer:\nA load balancer spreads traffic.",
    phase: "design_framing",
    updateSource: "model-output",
    now: 2,
  });

  assert.equal(preserved, artifact);
});

test("increments revision when the whiteboard changes", () => {
  const artifact = updateWhiteboardArtifactFromAnswer({
    parentTaskId: "parent_1",
    parentQuestionType: "ai-ml-system-design",
    parentTopic: "Design a RAG app",
    finalContent:
      "Whiteboard:\nOffline docs -> chunks -> embeddings -> vector index.\nOnline query -> retrieve -> generate.",
    phase: "design_framing",
    selectedOverlayIds: ["mem_overlay_rag_dual_pipeline"],
    updateSource: "model-output",
    now: 1,
  });

  const updated = updateWhiteboardArtifactFromAnswer({
    existing: artifact,
    parentTaskId: "parent_1",
    parentQuestionType: "ai-ml-system-design",
    parentTopic: "Design a RAG app",
    finalContent:
      "Whiteboard:\nOffline docs -> chunks -> embeddings -> vector index.\nOnline query -> retrieve -> rerank -> generate -> verify citations.",
    phase: "design_framing",
    selectedOverlayIds: ["mem_overlay_rag_dual_pipeline"],
    updateSource: "manual-next",
    now: 2,
  });

  assert.ok(updated);
  assert.equal(updated.revision, 2);
  assert.equal(updated.updateSource, "manual-next");
  assert.match(updated.content, /rerank/);
});

test("preserves the current whiteboard when model output is partial", () => {
  const artifact = updateWhiteboardArtifactFromAnswer({
    parentTaskId: "parent_1",
    parentQuestionType: "general-system-design",
    parentTopic: "Design a ticket selling system",
    finalContent: WHITEBOARD_ANSWER,
    phase: "design_framing",
    updateSource: "model-output",
    now: 1,
  });

  const preserved = updateWhiteboardArtifactFromAnswer({
    existing: artifact,
    parentTaskId: "parent_1",
    parentQuestionType: "general-system-design",
    parentTopic: "Design a ticket selling system",
    finalContent: "Whiteboard:",
    phase: "follow_up",
    updateSource: "model-output",
    now: 2,
  });

  assert.equal(preserved, artifact);
});

test("accepts inline whiteboard only from the active compatible parent", () => {
  const accepted = resolveWhiteboardArtifactDisplay({
    activeParentTaskId: "parent_1",
    activeParentQuestionType: "ai-ml-system-design",
    inlineWhiteboard: "Client -> Retrieval -> LLM",
    sourceParentTaskId: "parent_1",
    sourceParentQuestionType: "general-system-design",
  });
  assert.deepEqual(accepted, {
    whiteboard: { kind: "replace", value: "Client -> Retrieval -> LLM" },
    isCached: false,
  });

  const rejected = resolveWhiteboardArtifactDisplay({
    activeParentTaskId: "parent_1",
    activeParentQuestionType: "behavioral",
    inlineWhiteboard: "stale diagram",
    sourceParentTaskId: "parent_1",
    sourceParentQuestionType: "general-system-design",
  });
  assert.deepEqual(rejected, {
    whiteboard: { kind: "clear" },
    isCached: false,
  });
});

test("preserves a cached whiteboard across compatible system-design correction", () => {
  const display = resolveWhiteboardArtifactDisplay({
    activeParentTaskId: "parent_1",
    activeParentQuestionType: "ai-ml-system-design",
    artifact: {
      parentTaskId: "parent_1",
      content: "Client -> API -> Service",
    },
    sourceParentTaskId: "parent_1",
    sourceParentQuestionType: "general-system-design",
  });

  assert.deepEqual(display, {
    whiteboard: { kind: "replace", value: "Client -> API -> Service" },
    isCached: true,
  });
});
