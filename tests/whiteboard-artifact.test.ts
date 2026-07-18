import assert from "node:assert/strict";
import test from "node:test";
import { updateWhiteboardArtifactFromAnswer } from "../src/lib/meeting/whiteboard-artifact.js";

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
