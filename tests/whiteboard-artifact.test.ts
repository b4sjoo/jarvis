import assert from "node:assert/strict";
import test from "node:test";
import {
  formatWhiteboardRenderValidationForTrace,
  isWhiteboardRevisionAuthorized,
  resolveWhiteboardArtifactDisplay,
  updateWhiteboardArtifactFromAnswer,
  validateWhiteboardRenderCandidate,
} from "../src/lib/meeting/whiteboard-artifact.js";

test("requires explicit whiteboard intent when a settled plan exists", () => {
  assert.equal(
    isWhiteboardRevisionAuthorized({
      artifactIntent: "revise-whiteboard",
      policyAllowsWhiteboard: true,
    }),
    true
  );
  assert.equal(
    isWhiteboardRevisionAuthorized({
      artifactIntent: "preserve",
      policyAllowsWhiteboard: true,
    }),
    false
  );
  assert.equal(
    isWhiteboardRevisionAuthorized({
      artifactIntent: "revise-whiteboard",
      policyAllowsWhiteboard: false,
    }),
    false
  );
});

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
  assert.equal(artifact.renderState?.status, "valid-text");
  assert.equal(artifact.renderState?.visibleRevision, 1);
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

test("does not let an inline whiteboard bypass artifact validation", () => {
  const cleared = resolveWhiteboardArtifactDisplay({
    activeParentTaskId: "parent_1",
    activeParentQuestionType: "ai-ml-system-design",
    sourceParentTaskId: "parent_1",
    sourceParentQuestionType: "general-system-design",
  });
  assert.deepEqual(cleared, {
    whiteboard: { kind: "clear" },
    isCached: false,
  });

  const rejected = resolveWhiteboardArtifactDisplay({
    activeParentTaskId: "parent_1",
    activeParentQuestionType: "behavioral",
    sourceParentTaskId: "parent_1",
    sourceParentQuestionType: "general-system-design",
  });
  assert.deepEqual(rejected, {
    whiteboard: { kind: "clear" },
    isCached: false,
  });
});

test("promotes valid Mermaid only after local parser validation", async () => {
  const answer = [
    "Answer:",
    "Use a reservation service.",
    "",
    "Whiteboard:",
    "```mermaid",
    "flowchart TD",
    "  Client --> ReservationService",
    "  ReservationService --> InventoryDB",
    "```",
  ].join("\n");
  const validation = await validateWhiteboardRenderCandidate({
    whiteboard: [
      "```mermaid",
      "flowchart TD",
      "  Client --> ReservationService",
      "  ReservationService --> InventoryDB",
      "```",
    ].join("\n"),
    operationId: "validation_valid",
  });

  assert.equal(validation.disposition, "valid-mermaid");
  assert.equal(validation.valid, true);

  const artifact = updateWhiteboardArtifactFromAnswer({
    parentTaskId: "parent_mermaid",
    parentQuestionType: "general-system-design",
    parentTopic: "Design ticket booking",
    finalContent: answer,
    phase: "design_framing",
    renderValidation: validation,
    updateSource: "model-output",
    now: 10,
  });

  assert.ok(artifact);
  assert.equal(artifact.revision, 1);
  assert.equal(artifact.renderState?.status, "valid-mermaid");
  assert.equal(
    artifact.renderState?.validationOperationId,
    "validation_valid"
  );
});

test("preserves the last valid revision when Mermaid validation fails", async () => {
  const existing = updateWhiteboardArtifactFromAnswer({
    parentTaskId: "parent_invalid_update",
    parentQuestionType: "general-system-design",
    parentTopic: "Design ticket booking",
    finalContent: "Whiteboard:\nClient -> API -> Reservation Service",
    phase: "design_framing",
    updateSource: "model-output",
    now: 1,
  });
  assert.ok(existing);

  const invalidWhiteboard = [
    "```mermaid",
    "flowchart TD",
    "  subgraph Open Constraints & Unclear Scale",
    "  A --> B",
    "```",
  ].join("\n");
  const validation = await validateWhiteboardRenderCandidate({
    whiteboard: invalidWhiteboard,
    operationId: "validation_invalid",
  });
  assert.equal(validation.disposition, "invalid-mermaid");
  assert.equal(validation.valid, false);

  const preserved = updateWhiteboardArtifactFromAnswer({
    existing,
    parentTaskId: "parent_invalid_update",
    parentQuestionType: "general-system-design",
    parentTopic: "Design ticket booking",
    finalContent: `Whiteboard:\n${invalidWhiteboard}`,
    phase: "design_framing",
    renderValidation: validation,
    updateSource: "model-output",
    now: 2,
  });

  assert.ok(preserved);
  assert.equal(preserved.content, existing.content);
  assert.equal(preserved.revision, existing.revision);
  assert.equal(preserved.renderState?.status, "preserved-last-valid");
  assert.equal(preserved.renderState?.candidateRevision, 2);
  assert.equal(preserved.renderState?.visibleRevision, 1);
  assert.equal(
    preserved.renderState?.parserErrorClass,
    "mermaid-syntax-error"
  );

  const trace = formatWhiteboardRenderValidationForTrace({
    decision: validation,
    before: existing,
    after: preserved,
  });
  assert.equal(trace.whiteboardRenderPreservedLastValid, true);
  assert.equal(trace.whiteboardRenderVisibleRevisionAfter, 1);
});

test("projects a first invalid Mermaid revision to an authorized ASCII artifact", async () => {
  const invalidWhiteboard = [
    "```mermaid",
    "flowchart TD",
    "  subgraph Open Constraints & Unclear Scale",
    "```",
  ].join("\n");
  const validation = await validateWhiteboardRenderCandidate({
    whiteboard: invalidWhiteboard,
    operationId: "validation_first_invalid",
  });

  const artifact = updateWhiteboardArtifactFromAnswer({
    parentTaskId: "parent_first_invalid",
    parentQuestionType: "ai-ml-system-design",
    parentTopic: "Design a RAG system",
    finalContent: `Whiteboard:\n${invalidWhiteboard}`,
    phase: "design_framing",
    renderValidation: validation,
    updateSource: "model-output",
    now: 1,
  });

  assert.ok(artifact);
  assert.equal(artifact.revision, 1);
  assert.equal(artifact.renderState?.status, "ascii-fallback");
  assert.equal(
    artifact.renderState?.fallbackKind,
    "deterministic-ascii"
  );
  assert.doesNotMatch(artifact.content, /```mermaid/);
  assert.match(artifact.content, /Open Constraints/);
});

test("uses ASCII fallback when Mermaid validation belongs to different content", async () => {
  const validatedWhiteboard = [
    "```mermaid",
    "flowchart TD",
    "  A --> B",
    "```",
  ].join("\n");
  const validation = await validateWhiteboardRenderCandidate({
    whiteboard: validatedWhiteboard,
    operationId: "validation_mismatch",
  });
  const differentWhiteboard = [
    "```mermaid",
    "flowchart TD",
    "  A --> C",
    "```",
  ].join("\n");

  const artifact = updateWhiteboardArtifactFromAnswer({
    parentTaskId: "parent_mismatch",
    parentQuestionType: "general-system-design",
    parentTopic: "Design a service",
    finalContent: `Whiteboard:\n${differentWhiteboard}`,
    phase: "design_framing",
    renderValidation: validation,
    updateSource: "model-output",
    now: 1,
  });

  assert.ok(artifact);
  assert.equal(artifact.renderState?.status, "ascii-fallback");
  assert.equal(
    artifact.renderState?.parserErrorClass,
    "candidate-validation-mismatch"
  );
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

test("keeps Mermaid parser diagnostics bounded for one-shot repair", async () => {
  const validation = await validateWhiteboardRenderCandidate({
    whiteboard: [
      "```mermaid",
      "flowchart TD",
      "  subgraph Open Constraints & Unclear Scale",
      "  A --> B",
      "```",
    ].join("\n"),
    operationId: "validation_diagnostic",
  });

  assert.equal(validation.valid, false);
  assert.ok(validation.parserErrorDetail);
  assert.ok(validation.parserErrorDetail.length <= 600);
  const trace = formatWhiteboardRenderValidationForTrace({
    decision: validation,
  });
  assert.equal(
    trace.whiteboardRenderParserErrorDetail,
    validation.parserErrorDetail
  );
});
