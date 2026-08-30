import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareSourceOwnedTransition,
  createSourceOwnedTransitionCandidate,
  sourceOwnedTransitionSurvivesModelOutcome,
} from "../src/lib/meeting/source-owned-transition-transaction.js";
import {
  decideInterviewerAssumptionAuthorization,
  decidePlaybookPhaseProgression,
} from "../src/lib/meeting/playbook-phase.js";
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

  const result = prepareSourceOwnedTransition({
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
  assert.equal(result.task?.child?.returnCapsule?.parentId, parent.id);
  assert.equal(
    result.task?.child?.returnCapsule?.parentPhase,
    "design_framing"
  );
  assert.equal(result.task?.whiteboardArtifact, parent.whiteboardArtifact);
  assert.equal(
    sourceOwnedTransitionSurvivesModelOutcome(result, "error"),
    true
  );
});

test("preserves active child identity for a settled same-branch follow-up", () => {
  const parent = makeParent({
    child: {
      id: "child-hnsw",
      createdAt: 50,
      updatedAt: 50,
      questionType: "field-knowledge",
      relation: "child-probe",
      intent: "concept-probe",
      question: "What is HNSW?",
      basedOnTurnIds: ["turn-child-root"],
      basedOnObservationIds: [],
      returnCapsule: {
        parentId: "parent-a",
        parentRevisionAtAttach: 2,
        parentPhase: "design_framing",
        projectBindingRevision: 0,
        topicCapsule: "Design a RAG system",
        allowedFactAnchorIds: [],
        artifactCompatibility: {
          policy: "preserve-parent-artifacts",
          whiteboardArtifactId: "whiteboard-a",
        },
        createdAt: 50,
      },
    },
  });
  const candidate = createSourceOwnedTransitionCandidate({
    sessionId: "session-a",
    runtimeEpoch: 3,
    source: "voice",
    sourceTurnIds: ["turn-child-followup"],
    logicalQuestionUnitId: "lqu-child-followup",
    logicalQuestionRevision: 1,
    existingTask: parent,
    preserveChildId: "child-hnsw",
    relation: "child-probe",
    authoritySource: "committed-settlement",
    mutationAuthorized: true,
    questionType: "field-knowledge",
    question: "How does efSearch affect recall?",
    subtaskIntent: "concept-probe",
    now: 100,
  });
  assert.ok(candidate);

  const result = prepareSourceOwnedTransition({
    candidate,
    currentTask: parent,
    currentSessionId: "session-a",
    currentRuntimeEpoch: 3,
    now: 110,
  });

  assert.equal(result.mutationApplied, true);
  assert.equal(result.reason, "child-probe-preserved");
  assert.equal(result.task?.child?.id, "child-hnsw");
  assert.equal(result.task?.child?.createdAt, 50);
  assert.equal(
    result.task?.child?.question,
    "How does efSearch affect recall?"
  );
  assert.deepEqual(result.task?.child?.basedOnTurnIds, [
    "turn-child-followup",
  ]);
  assert.equal(
    result.task?.child?.returnCapsule,
    parent.child?.returnCapsule
  );
  assert.equal(result.task?.whiteboardArtifact, parent.whiteboardArtifact);
});

test("rejects child preservation after the effective owner changes", () => {
  const parent = makeParent({
    child: {
      id: "child-new",
      createdAt: 50,
      updatedAt: 50,
      questionType: "field-knowledge",
      relation: "child-probe",
      intent: "concept-probe",
      question: "What is HNSW?",
      basedOnTurnIds: ["turn-child-root"],
      basedOnObservationIds: [],
    },
  });
  const candidate = createSourceOwnedTransitionCandidate({
    sessionId: "session-a",
    runtimeEpoch: 3,
    source: "voice",
    sourceTurnIds: ["turn-child-followup"],
    existingTask: parent,
    preserveChildId: "child-old",
    relation: "child-probe",
    authoritySource: "committed-settlement",
    mutationAuthorized: true,
    questionType: "field-knowledge",
    question: "How does efSearch affect recall?",
    now: 100,
  });
  assert.ok(candidate);

  const result = prepareSourceOwnedTransition({
    candidate,
    currentTask: parent,
    currentSessionId: "session-a",
    currentRuntimeEpoch: 3,
    now: 110,
  });

  assert.equal(result.candidate.state, "rejected");
  assert.equal(result.mutationApplied, false);
  assert.equal(result.reason, "child-owner-mismatch");
  assert.equal(result.task?.child?.id, "child-new");
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

  const result = prepareSourceOwnedTransition({
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

test("attaches a Field Knowledge detour to General SD and resumes the same parent", () => {
  const parent = makeParent({
    stableKind: "general-system-design",
    topic: "Design a URL shortener",
    playbook: makePlaybook(
      "general_system_design",
      "general-system-design",
      "design_framing"
    ),
  });
  const childCandidate = createSourceOwnedTransitionCandidate({
    sessionId: "session-a",
    runtimeEpoch: 3,
    source: "voice",
    sourceTurnIds: ["turn-redis"],
    existingTask: parent,
    relation: "child-probe",
    authoritySource: "task-relation-runtime-operation",
    mutationAuthorized: true,
    questionType: "field-knowledge",
    question: "Why would Redis help the lookup path?",
    subtaskIntent: "concept-probe",
    now: 100,
  });
  assert.ok(childCandidate);
  const withChild = prepareSourceOwnedTransition({
    candidate: childCandidate,
    currentTask: parent,
    currentSessionId: "session-a",
    currentRuntimeEpoch: 3,
    now: 110,
  });

  assert.equal(withChild.mutationApplied, true);
  assert.equal(withChild.task?.id, parent.id);
  assert.equal(withChild.task?.stableKind, "general-system-design");
  assert.equal(withChild.task?.child?.questionType, "field-knowledge");
  assert.equal(withChild.task?.child?.returnCapsule?.parentId, parent.id);

  const resumeCandidate = createSourceOwnedTransitionCandidate({
    sessionId: "session-a",
    runtimeEpoch: 3,
    source: "voice",
    sourceTurnIds: ["turn-resume-url-shortener"],
    existingTask: withChild.task,
    relation: "resume-parent",
    authoritySource: "task-relation-runtime-operation",
    mutationAuthorized: true,
    questionType: "general-system-design",
    question: "Return to the URL shortener architecture.",
    now: 120,
  });
  assert.ok(resumeCandidate);
  const resumed = prepareSourceOwnedTransition({
    candidate: resumeCandidate,
    currentTask: withChild.task,
    currentSessionId: "session-a",
    currentRuntimeEpoch: 3,
    now: 130,
  });

  assert.equal(resumed.mutationApplied, true);
  assert.equal(resumed.task?.id, parent.id);
  assert.equal(resumed.task?.stableKind, "general-system-design");
  assert.equal(resumed.task?.child, undefined);
  assert.equal(resumed.task?.playbookPhase, parent.playbookPhase);
  assert.deepEqual(resumed.task?.phaseProgress, parent.phaseProgress);
});

test("resumes a child from its bounded parent capsule", () => {
  const parent = makeParent({
    stableKind: "project-deep-dive",
    topic: "Agentic Memory",
    playbook: makePlaybook(
      "project_deep_dive",
      "project-deep-dive",
      "architecture_decision"
    ),
    playbookPhase: "architecture_decision",
    phaseProgress: {
      project_narrative: true,
      architecture_decision: true,
    },
    projectBinding: {
      projectId: "agentic-memory",
      projectName: "Agentic Memory",
      primaryEntryId: "mem-agentic",
      evidenceEntryIds: ["mem-agentic"],
      source: "interviewer-explicit",
      confidence: 1,
      lockedAt: 10,
      revision: 4,
      reason: "explicit-project",
    },
    supportedFactAnchors: ["mem-agentic", "mem-agentic-parser"],
  });
  const childCandidate = createSourceOwnedTransitionCandidate({
    sessionId: "session-a",
    runtimeEpoch: 3,
    source: "voice",
    sourceTurnIds: ["turn-child"],
    existingTask: parent,
    relation: "child-probe",
    authoritySource: "accepted-transcript",
    mutationAuthorized: true,
    questionType: "field-knowledge",
    question: "Why can LLM JSON output be invalid?",
    subtaskIntent: "concept-probe",
    now: 100,
  });
  assert.ok(childCandidate);
  const childResult = prepareSourceOwnedTransition({
    candidate: childCandidate,
    currentTask: parent,
    currentSessionId: "session-a",
    currentRuntimeEpoch: 3,
    now: 110,
  });
  assert.ok(childResult.task);
  assert.equal(
    childResult.task.child?.returnCapsule?.projectBindingRevision,
    4
  );
  assert.equal(
    childResult.task.child?.returnCapsule?.topicCapsule,
    "Agentic Memory"
  );

  const withChildMutation = {
    ...childResult.task,
    playbookPhase: "follow_up" as const,
    supportedFactAnchors: ["child-only-anchor"],
  };
  const resumeCandidate = createSourceOwnedTransitionCandidate({
    sessionId: "session-a",
    runtimeEpoch: 3,
    source: "voice",
    sourceTurnIds: ["turn-resume"],
    existingTask: withChildMutation,
    relation: "resume-parent",
    authoritySource: "accepted-transcript",
    mutationAuthorized: true,
    questionType: "project-deep-dive",
    question: "Let's return to the architecture tradeoff.",
    now: 120,
  });
  assert.ok(resumeCandidate);
  const resumed = prepareSourceOwnedTransition({
    candidate: resumeCandidate,
    currentTask: withChildMutation,
    currentSessionId: "session-a",
    currentRuntimeEpoch: 3,
    now: 130,
  });

  assert.equal(resumed.mutationApplied, true);
  assert.equal(resumed.task?.child, undefined);
  assert.equal(resumed.task?.playbookPhase, "architecture_decision");
  assert.deepEqual(resumed.task?.supportedFactAnchors, [
    "mem-agentic",
    "mem-agentic-parser",
  ]);
  assert.equal(resumed.task?.projectBinding?.projectId, "agentic-memory");
});

test("rejects parent resume after the project binding changes", () => {
  const parent = makeParent({
    stableKind: "project-deep-dive",
    projectBinding: {
      projectId: "agentic-memory",
      projectName: "Agentic Memory",
      primaryEntryId: "mem-agentic",
      evidenceEntryIds: ["mem-agentic"],
      source: "interviewer-explicit",
      confidence: 1,
      lockedAt: 10,
      revision: 2,
      reason: "explicit-project",
    },
  });
  const childCandidate = createSourceOwnedTransitionCandidate({
    sessionId: "session-a",
    runtimeEpoch: 3,
    source: "voice",
    sourceTurnIds: ["turn-child"],
    existingTask: parent,
    relation: "child-probe",
    authoritySource: "accepted-transcript",
    mutationAuthorized: true,
    questionType: "coding",
    question: "Implement a parser helper.",
    subtaskIntent: "implementation-probe",
    now: 100,
  });
  assert.ok(childCandidate);
  const childResult = prepareSourceOwnedTransition({
    candidate: childCandidate,
    currentTask: parent,
    currentSessionId: "session-a",
    currentRuntimeEpoch: 3,
    now: 110,
  });
  assert.ok(childResult.task);
  const rebound = {
    ...childResult.task,
    projectBinding: {
      ...childResult.task.projectBinding!,
      projectId: "throttling",
      projectName: "Throttling",
      revision: 3,
    },
  };
  const resumeCandidate = createSourceOwnedTransitionCandidate({
    sessionId: "session-a",
    runtimeEpoch: 3,
    source: "voice",
    sourceTurnIds: ["turn-resume"],
    existingTask: rebound,
    relation: "resume-parent",
    authoritySource: "accepted-transcript",
    mutationAuthorized: true,
    questionType: "project-deep-dive",
    question: "Back to the project.",
    now: 120,
  });
  assert.ok(resumeCandidate);
  const resumed = prepareSourceOwnedTransition({
    candidate: resumeCandidate,
    currentTask: rebound,
    currentSessionId: "session-a",
    currentRuntimeEpoch: 3,
    now: 130,
  });

  assert.equal(resumed.mutationApplied, false);
  assert.equal(resumed.reason, "parent-return-capsule-binding-mismatch");
  assert.equal(resumed.task?.child?.id, childResult.task.child?.id);
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
      requiredArtifacts: ["answer", "whiteboard"],
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

  const result = prepareSourceOwnedTransition({
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
      requiredArtifacts: ["answer", "whiteboard"],
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
      requiredArtifacts: ["answer", "whiteboard"],
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

  const result = prepareSourceOwnedTransition({
    candidate,
    currentSessionId: "session-a",
    currentRuntimeEpoch: 3,
    now: 110,
  });

  assert.equal(result.task?.source, "screen");
  assert.equal(result.task?.stableKind, "general-system-design");
  assert.equal(result.task?.startObservationId, "screen-a");
  assert.equal(result.task?.latestUsefulAnswer, undefined);
  assert.equal(result.task?.admission?.durability, "durable");
  assert.equal(result.task?.admission?.action, "create-parent");
  assert.equal(
    sourceOwnedTransitionSurvivesModelOutcome(result, "empty-output"),
    true
  );
});

test("reseeds a provisional parent and invalidates stale project state atomically", () => {
  const parent = makeParent({
    stableKind: "project-deep-dive",
    topic: "Throttling",
    projectBinding: {
      projectId: "throttling",
      projectName: "Throttling",
      primaryEntryId: "mem_throttling",
      evidenceEntryIds: ["mem_throttling"],
      source: "memory",
      confidence: 0.9,
      lockedAt: 10,
      revision: 1,
      reason: "legacy-binding",
    },
    supportedFactAnchors: ["mem_throttling"],
    child: {
      id: "child-old",
      createdAt: 20,
      updatedAt: 20,
      questionType: "field-knowledge",
      relation: "child-probe",
      intent: "concept-probe",
      question: "What is a token bucket?",
      basedOnTurnIds: ["turn-old-child"],
      basedOnObservationIds: [],
    },
    admission: {
      durability: "provisional",
      action: "create-parent",
      authoritySource: "legacy-provisional",
      sourceTurnIds: ["turn-old"],
      sourceObservationIds: [],
      reason: "legacy-weak-parent",
      admittedAt: 10,
    },
  });
  const candidate = createSourceOwnedTransitionCandidate({
    sessionId: "session-a",
    runtimeEpoch: 3,
    source: "voice",
    sourceTurnIds: ["turn-agentic"],
    existingTask: parent,
    relation: "new-parent",
    authoritySource: "accepted-transcript",
    mutationAuthorized: true,
    questionType: "project-deep-dive",
    question: "Tell me about the Agentic Memory project.",
    playbook: makePlaybook(
      "project_deep_dive",
      "project-deep-dive",
      "project_narrative"
    ),
    now: 100,
  });
  assert.ok(candidate);
  assert.equal(candidate.kind, "reseed-parent");

  const result = prepareSourceOwnedTransition({
    candidate,
    currentTask: parent,
    currentSessionId: "session-a",
    currentRuntimeEpoch: 3,
    now: 110,
  });

  assert.equal(result.task?.id, parent.id);
  assert.equal(result.task?.topic, "Tell me about the Agentic Memory project.");
  assert.equal(result.task?.projectBinding, undefined);
  assert.deepEqual(result.task?.supportedFactAnchors, []);
  assert.equal(result.task?.whiteboardArtifact, undefined);
  assert.equal(result.task?.child, undefined);
  assert.equal(result.task?.playbookPhase, "project_narrative");
  assert.equal(result.task?.admission?.action, "reseed-parent");
  assert.equal(result.task?.revisions, parent.revisions + 1);
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

  const result = prepareSourceOwnedTransition({
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

test("commits one source-owned assumption phase transition before advisor output", () => {
  const parent = makeParent({
    stableKind: "general-system-design",
    topic: "Design a URL shortener",
    playbook: makePlaybook(
      "general_system_design",
      "general-system-design",
      "requirement_clarification"
    ),
    playbookPhase: "requirement_clarification",
    phaseProgress: {},
    child: undefined,
  });
  const phaseControl = decideInterviewerAssumptionAuthorization({
    text: "You can make the hypothesis by yourself.",
    speaker: "them",
    activeQuestionType: parent.stableKind,
    currentPhase: parent.playbookPhase,
    sourceTurnId: "turn-assumption",
  }).phaseControl;
  assert.ok(phaseControl);
  const phaseDecision = decidePlaybookPhaseProgression({
    questionType: parent.stableKind,
    playbookId: parent.playbook?.id,
    currentPhase: parent.playbookPhase,
    phaseProgress: parent.phaseProgress,
    latestTurnText: "Please continue.",
    relation: "followup-parent",
    phaseControl,
  });
  const candidate = createSourceOwnedTransitionCandidate({
    sessionId: "session-a",
    runtimeEpoch: 3,
    source: "voice",
    sourceTurnIds: ["turn-assumption"],
    logicalQuestionUnitId: "lqu-assumption",
    logicalQuestionRevision: 1,
    existingTask: parent,
    relation: "followup-parent",
    authoritySource: "source-owned-phase-control",
    mutationAuthorized: true,
    questionType: parent.stableKind,
    question: "You can make the hypothesis by yourself.",
    playbook: parent.playbook,
    phaseDecision,
    now: 100,
  });
  assert.ok(candidate);

  const result = prepareSourceOwnedTransition({
    candidate,
    currentTask: parent,
    currentSessionId: "session-a",
    currentRuntimeEpoch: 3,
    now: 110,
  });

  assert.equal(result.candidate.kind, "phase-progress");
  assert.equal(result.candidate.state, "committed");
  assert.equal(result.task?.id, parent.id);
  assert.equal(result.task?.playbookPhase, "design_framing");
  assert.equal(result.task?.phaseProgress.requirements, true);
  assert.equal(result.task?.phaseProgress.requirement_clarification, true);
  assert.equal(result.task?.child, undefined);
  assert.equal(result.task?.whiteboardArtifact, parent.whiteboardArtifact);
  assert.equal(
    sourceOwnedTransitionSurvivesModelOutcome(result, "error"),
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
  const first = prepareSourceOwnedTransition({
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
  const repeated = prepareSourceOwnedTransition({
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

  const result = prepareSourceOwnedTransition({
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

  const result = prepareSourceOwnedTransition({
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
  const first = prepareSourceOwnedTransition({
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
  const repeated = prepareSourceOwnedTransition({
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
