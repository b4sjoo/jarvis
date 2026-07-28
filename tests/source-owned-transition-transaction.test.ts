import assert from "node:assert/strict";
import test from "node:test";
import {
  commitSourceOwnedTransition,
  createSourceOwnedTransitionCandidate,
  sourceOwnedTransitionSurvivesModelOutcome,
} from "../src/lib/meeting/source-owned-transition-transaction.js";
import type {
  ActiveInterviewParent,
  InterviewPlaybookId,
  InterviewPlaybookPhase,
  SelectedInterviewPlaybook,
} from "../src/lib/meeting/types.js";

test("commits a child before output and preserves parent artifacts", () => {
  const parent = makeParent();
  const candidate = createSourceOwnedTransitionCandidate({
    sessionId: "session-a",
    runtimeEpoch: 3,
    source: "voice",
    sourceTurnIds: ["turn-child"],
    logicalQuestionUnitId: "lqu-child",
    logicalQuestionRevision: 2,
    existingTask: parent,
    relation: "child-probe",
    authoritySource: "accepted-transcript",
    mutationAuthorized: true,
    questionType: "coding",
    question: "Implement the loss function.",
    subtaskIntent: "implementation-probe",
    now: 100,
  });
  assert.ok(candidate);

  const result = commitSourceOwnedTransition({
    candidate,
    currentTask: parent,
    currentSessionId: "session-a",
    currentRuntimeEpoch: 3,
    now: 110,
  });

  assert.equal(result.candidate.state, "committed");
  assert.equal(result.mutationApplied, true);
  assert.equal(result.task?.id, parent.id);
  assert.equal(result.task?.child?.questionType, "coding");
  assert.equal(result.task?.whiteboardArtifact, parent.whiteboardArtifact);
  assert.equal(
    sourceOwnedTransitionSurvivesModelOutcome(result, "error"),
    true
  );
});

test("resumes a parent without restarting its phase", () => {
  const parent = makeParent({
    child: {
      id: "child-a",
      createdAt: 50,
      updatedAt: 50,
      questionType: "field-knowledge",
      relation: "child-probe",
      intent: "concept-probe",
      question: "What is HNSW?",
      basedOnTurnIds: ["turn-child"],
      basedOnObservationIds: [],
    },
  });
  const candidate = createSourceOwnedTransitionCandidate({
    sessionId: "session-a",
    runtimeEpoch: 3,
    source: "voice",
    sourceTurnIds: ["turn-resume"],
    existingTask: parent,
    relation: "resume-parent",
    authoritySource: "accepted-transcript",
    mutationAuthorized: true,
    questionType: "ai-ml-system-design",
    question: "Back to evaluation metrics.",
    now: 100,
  });
  assert.ok(candidate);

  const result = commitSourceOwnedTransition({
    candidate,
    currentTask: parent,
    currentSessionId: "session-a",
    currentRuntimeEpoch: 3,
    now: 110,
  });

  assert.equal(result.task?.child, undefined);
  assert.equal(result.task?.playbookPhase, "design_framing");
  assert.deepEqual(result.task?.phaseProgress, parent.phaseProgress);
});

test("commits source-supported phase progress before model output", () => {
  const parent = makeParent();
  const candidate = createSourceOwnedTransitionCandidate({
    sessionId: "session-a",
    runtimeEpoch: 3,
    source: "voice",
    sourceTurnIds: ["turn-requirements"],
    existingTask: parent,
    relation: "followup-parent",
    authoritySource: "accepted-transcript",
    mutationAuthorized: true,
    questionType: "ai-ml-system-design",
    question: "Use p95 latency under 300ms and support 10 million users.",
    playbook: makePlaybook(
      "aiml_system_design",
      "ai-ml-system-design",
      "design_framing"
    ),
    phaseDecision: {
      phase: "design_framing",
      phaseFrom: "requirement_clarification",
      flags: ["requirements"],
      completedFlags: ["requirements"],
      action: "advance",
      reason: "requirements supplied",
      source: "automatic",
      requirementTrack: "ai-ml-system-design",
      observedRequirementCategories: ["scale_qps", "latency_sla"],
      missingRequirementCategories: [],
      requirementsReady: true,
    },
    now: 100,
  });
  assert.ok(candidate);

  const result = commitSourceOwnedTransition({
    candidate,
    currentTask: parent,
    currentSessionId: "session-a",
    currentRuntimeEpoch: 3,
    now: 110,
  });

  assert.equal(result.candidate.kind, "phase-progress");
  assert.equal(result.task?.playbookPhase, "design_framing");
  assert.equal(result.task?.phaseProgress.requirements, true);
  assert.equal(
    result.task?.phaseProgress["requirement_evidence:scale_qps"],
    true
  );
  assert.equal(
    result.task?.phaseProgress["requirement_evidence:latency_sla"],
    true
  );
});

test("does not synthesize phase progress from an unresolved relation", () => {
  const parent = makeParent();
  const candidate = createSourceOwnedTransitionCandidate({
    sessionId: "session-a",
    runtimeEpoch: 3,
    source: "voice",
    sourceTurnIds: ["turn-unresolved"],
    existingTask: parent,
    relation: "unknown",
    authoritySource: "accepted-transcript",
    mutationAuthorized: true,
    questionType: "ai-ml-system-design",
    question: "Use p95 latency under 300ms.",
    playbook: makePlaybook(
      "aiml_system_design",
      "ai-ml-system-design",
      "design_framing"
    ),
    phaseDecision: {
      phase: "design_framing",
      phaseFrom: "requirement_clarification",
      flags: ["requirements"],
      completedFlags: ["requirements"],
      action: "advance",
      reason: "requirements supplied",
      source: "automatic",
      requirementTrack: "ai-ml-system-design",
      observedRequirementCategories: ["latency_sla"],
      missingRequirementCategories: [],
      requirementsReady: true,
    },
    now: 100,
  });

  assert.equal(candidate, undefined);
});

test("creates a screen parent before its model produces an answer", () => {
  const candidate = createSourceOwnedTransitionCandidate({
    sessionId: "session-a",
    runtimeEpoch: 3,
    source: "screen",
    sourceObservationIds: ["screen-a"],
    relation: "new-parent",
    authoritySource: "screen-preflight",
    mutationAuthorized: true,
    questionType: "general-system-design",
    question: "Design a ticket selling system.",
    playbook: makePlaybook(
      "general_system_design",
      "general-system-design",
      "requirement_clarification"
    ),
    phaseDecision: {
      phase: "requirement_clarification",
      flags: [],
      action: "stay",
      reason: "requirements missing",
      source: "automatic",
      requirementTrack: "general-system-design",
      observedRequirementCategories: [],
      missingRequirementCategories: ["scale_qps"],
      requirementsReady: false,
    },
    now: 100,
  });
  assert.ok(candidate);

  const result = commitSourceOwnedTransition({
    candidate,
    currentSessionId: "session-a",
    currentRuntimeEpoch: 3,
    now: 110,
  });

  assert.equal(result.task?.source, "screen");
  assert.equal(result.task?.stableKind, "general-system-design");
  assert.equal(result.task?.startObservationId, "screen-a");
  assert.equal(result.task?.latestUsefulAnswer, undefined);
  assert.equal(
    sourceOwnedTransitionSurvivesModelOutcome(result, "empty-output"),
    true
  );
});

test("keeps a screen child committed when the model is cancelled", () => {
  const parent = makeParent();
  const candidate = createSourceOwnedTransitionCandidate({
    sessionId: "session-a",
    runtimeEpoch: 3,
    source: "screen",
    sourceObservationIds: ["screen-child"],
    existingTask: parent,
    relation: "child-probe",
    authoritySource: "screen-preflight",
    mutationAuthorized: true,
    questionType: "field-knowledge",
    question: "How does HNSW search work?",
    subtaskIntent: "concept-probe",
    now: 100,
  });
  assert.ok(candidate);

  const result = commitSourceOwnedTransition({
    candidate,
    currentTask: parent,
    currentSessionId: "session-a",
    currentRuntimeEpoch: 3,
    now: 110,
  });

  assert.equal(result.task?.id, parent.id);
  assert.equal(result.task?.child?.questionType, "field-knowledge");
  assert.deepEqual(
    result.task?.child?.basedOnObservationIds,
    ["screen-child"]
  );
  assert.equal(
    sourceOwnedTransitionSurvivesModelOutcome(result, "cancelled"),
    true
  );
});

test("does not recreate a screen parent for the same observation", () => {
  const firstCandidate = createSourceOwnedTransitionCandidate({
    sessionId: "session-a",
    runtimeEpoch: 3,
    source: "screen",
    sourceObservationIds: ["screen-a"],
    relation: "new-parent",
    authoritySource: "screen-preflight",
    mutationAuthorized: true,
    questionType: "general-system-design",
    question: "Design a ticket selling system.",
    now: 100,
  });
  assert.ok(firstCandidate);
  const first = commitSourceOwnedTransition({
    candidate: firstCandidate,
    currentSessionId: "session-a",
    currentRuntimeEpoch: 3,
    now: 110,
  });
  assert.ok(first.task);

  const repeatedCandidate = createSourceOwnedTransitionCandidate({
    sessionId: "session-a",
    runtimeEpoch: 3,
    source: "screen",
    sourceObservationIds: ["screen-a"],
    existingTask: first.task,
    relation: "new-parent",
    authoritySource: "screen-preflight",
    mutationAuthorized: true,
    questionType: "general-system-design",
    question: "Design a ticket selling system.",
    now: 120,
  });
  assert.ok(repeatedCandidate);
  const repeated = commitSourceOwnedTransition({
    candidate: repeatedCandidate,
    currentTask: first.task,
    currentSessionId: "session-a",
    currentRuntimeEpoch: 3,
    now: 130,
  });

  assert.equal(repeated.mutationApplied, false);
  assert.equal(repeated.reason, "already-applied");
  assert.equal(repeated.task?.id, first.task.id);
});

test("rejects an unknown screen new parent", () => {
  const candidate = createSourceOwnedTransitionCandidate({
    sessionId: "session-a",
    runtimeEpoch: 3,
    source: "screen",
    sourceObservationIds: ["screen-unknown"],
    relation: "new-parent",
    authoritySource: "screen-preflight",
    mutationAuthorized: true,
    questionType: "unknown",
    question: "Untyped content",
    now: 100,
  });
  assert.ok(candidate);

  const result = commitSourceOwnedTransition({
    candidate,
    currentSessionId: "session-a",
    currentRuntimeEpoch: 3,
    now: 110,
  });

  assert.equal(result.candidate.state, "rejected");
  assert.equal(result.reason, "new-parent-type-not-eligible");
  assert.equal(result.task, undefined);
});

test("rejects stale parent revisions and keeps current state", () => {
  const parent = makeParent();
  const candidate = createSourceOwnedTransitionCandidate({
    sessionId: "session-a",
    runtimeEpoch: 3,
    source: "voice",
    sourceTurnIds: ["turn-child"],
    existingTask: parent,
    relation: "child-probe",
    authoritySource: "accepted-transcript",
    mutationAuthorized: true,
    questionType: "coding",
    question: "Implement the loss function.",
    now: 100,
  });
  assert.ok(candidate);
  const newerParent = { ...parent, revisions: parent.revisions + 1 };

  const result = commitSourceOwnedTransition({
    candidate,
    currentTask: newerParent,
    currentSessionId: "session-a",
    currentRuntimeEpoch: 3,
    now: 110,
  });

  assert.equal(result.candidate.state, "rejected");
  assert.equal(result.reason, "parent-revision-mismatch");
  assert.equal(result.task, newerParent);
});

test("repeated source revision is idempotent", () => {
  const parent = makeParent();
  const candidate = createSourceOwnedTransitionCandidate({
    sessionId: "session-a",
    runtimeEpoch: 3,
    source: "voice",
    sourceTurnIds: ["turn-child"],
    existingTask: parent,
    relation: "child-probe",
    authoritySource: "accepted-transcript",
    mutationAuthorized: true,
    questionType: "coding",
    question: "Implement the loss function.",
    now: 100,
  });
  assert.ok(candidate);
  const first = commitSourceOwnedTransition({
    candidate,
    currentTask: parent,
    currentSessionId: "session-a",
    currentRuntimeEpoch: 3,
    now: 110,
  });
  assert.ok(first.task);
  const repeatedCandidate = createSourceOwnedTransitionCandidate({
    sessionId: "session-a",
    runtimeEpoch: 3,
    source: "voice",
    sourceTurnIds: ["turn-child"],
    existingTask: first.task,
    relation: "child-probe",
    authoritySource: "accepted-transcript",
    mutationAuthorized: true,
    questionType: "coding",
    question: "Implement the loss function.",
    now: 120,
  });
  assert.ok(repeatedCandidate);
  const repeated = commitSourceOwnedTransition({
    candidate: repeatedCandidate,
    currentTask: first.task,
    currentSessionId: "session-a",
    currentRuntimeEpoch: 3,
    now: 130,
  });

  assert.equal(repeated.mutationApplied, false);
  assert.equal(repeated.reason, "already-applied");
  assert.equal(repeated.task?.child?.id, first.task.child?.id);
});

function makeParent(
  patch: Partial<ActiveInterviewParent> = {}
): ActiveInterviewParent {
  return {
    id: "parent-a",
    source: "voice",
    stableKind: "ai-ml-system-design",
    topic: "Design a RAG system",
    playbook: makePlaybook(
      "aiml_system_design",
      "ai-ml-system-design",
      "design_framing"
    ),
    playbookPhase: "design_framing",
    phaseProgress: { requirement_clarification: true },
    supportedFactAnchors: [],
    whiteboardArtifact: {
      id: "whiteboard-a",
      parentTaskId: "parent-a",
      domainTrack: "ml_sd",
      archetypeIds: [],
      selectedOverlayIds: [],
      currentPhase: "design_framing",
      title: "RAG system",
      content: "Query -> Retriever -> Generator",
      summary: "RAG system",
      revision: 1,
      updateSource: "model-output",
      updatedAt: 10,
      createdAt: 10,
    },
    createdAt: 10,
    updatedAt: 10,
    revisions: 2,
    ...patch,
  };
}

function makePlaybook(
  id: InterviewPlaybookId,
  questionType: SelectedInterviewPlaybook["questionType"],
  phase: InterviewPlaybookPhase
): SelectedInterviewPlaybook {
  return {
    id,
    label: "Test playbook",
    phase,
    questionType,
    confidence: 1,
    reason: "test",
    memoryPolicy: { id: "test" },
    firstMove: "test",
    clarifyingStrategy: "test",
    outputContract: "test",
    followUpPolicy: "test",
  };
}
