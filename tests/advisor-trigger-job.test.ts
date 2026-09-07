import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeAdvisorOutputCommit,
  authorizeAdvisorTaskMutation,
  createAdvisorTriggerJob,
  decideAdvisorPhaseMutation,
  decideAdvisorJobCommit,
  decideAdvisorTaskMutation,
  formatAdvisorTriggerJobForTrace,
  resolveAdvisorLogicalQuestionAuthorizationTarget,
} from "../src/lib/meeting/advisor-trigger-job.js";
import { decideAdvisorTurnIntent } from "../src/lib/meeting/advisor-turn-intent.js";
import type { AdvisorPromptContext } from "../src/lib/meeting/types.js";

function buildPromptContext(): AdvisorPromptContext {
  return {
    transcript: "Them: Design a cache",
    screenContext: "",
    rollingSummary: "",
    userProfileContext: "",
    glossaryText: "",
    taskRuntime: { revision: 0 },
    latestTurn: {
      id: "turn-a",
      speaker: "them",
      source: "system-audio",
      text: "Design a cache",
      startedAt: 10,
      endedAt: 20,
      isFinal: true,
    },
  };
}

test("freezes the prompt inputs owned by an advisor job", () => {
  const promptContext = buildPromptContext();
  const generatedContinuity = [
    {
      id: "capsule-a",
      parentTaskId: "parent-a",
      parentRevision: 1,
      answerRevision: 1,
      sourceSuggestionId: "suggestion-a",
      text: "Choose option A because it reduces latency.",
      source: "generated-continuity" as const,
      createdAt: 1,
    },
  ];
  const job = createAdvisorTriggerJob({
    source: "live-turn",
    mode: "live",
    promptContext,
    generatedContinuity,
    sessionId: "session-a",
    runtimeEpoch: 1,
    snapshotTurnCount: 1,
    taskMutationAuthority: "input-evidence",
  });

  promptContext.transcript = "Them: A newer question";
  if (promptContext.latestTurn) {
    promptContext.latestTurn.text = "A newer question";
  }
  generatedContinuity[0].text = "Mutated continuity";

  assert.equal(job.promptContextSnapshot.transcript, "Them: Design a cache");
  assert.equal(job.promptContextSnapshot.latestTurn?.text, "Design a cache");
  assert.equal(
    job.generatedContinuitySnapshot[0].text,
    "Choose option A because it reduces latency."
  );
});

test("rejects a replaced job and a job from an old meeting session", () => {
  const job = createAdvisorTriggerJob({
    source: "live-turn",
    mode: "live",
    promptContext: buildPromptContext(),
    sessionId: "session-a",
    runtimeEpoch: 1,
    snapshotTurnCount: 1,
    taskMutationAuthority: "input-evidence",
  });

  assert.deepEqual(
    decideAdvisorJobCommit({
      job,
      activeJobId: "newer-job",
      currentRuntime: { runtimeEpoch: 1, sessionId: "session-a" },
    }),
    { authorized: false, reason: "pipeline-owner-mismatch" }
  );
  assert.deepEqual(
    decideAdvisorJobCommit({
      job,
      activeJobId: job.id,
      currentRuntime: { runtimeEpoch: 1, sessionId: "session-b" },
    }),
    { authorized: false, reason: "session-mismatch" }
  );
});

test("emits the job identity needed to reconstruct ownership", () => {
  const job = createAdvisorTriggerJob({
    source: "live-turn",
    mode: "live",
    traceId: "trace-a",
    triggerTurnId: "turn-a",
    promptContext: buildPromptContext(),
    sessionId: "session-a",
    runtimeEpoch: 1,
    snapshotTurnCount: 3,
    taskMutationAuthority: "input-evidence",
  });

  assert.deepEqual(
    formatAdvisorTriggerJobForTrace(job, "stale-commit-rejected", {
      commitAuthorized: false,
      commitAuthorizationReason: "active-job-mismatch",
    }),
    {
      advisorJobId: job.id,
      advisorJobSource: "live-turn",
      advisorJobTriggerTurnId: "turn-a",
      advisorJobExpectedSessionId: "session-a",
      advisorJobExpectedRuntimeEpoch: 1,
      advisorJobExpectedParentId: undefined,
      advisorJobExpectedParentRevision: undefined,
      advisorJobMutationAuthority: "input-evidence",
      refreshAuthority: "automatic-substantive",
      refreshAuthorityAuthorized: true,
      refreshAuthorityReason: "substantive-turn",
      refreshAuthorityHardOverride: false,
      advisorJobManualCorrectionRevision: 0,
      advisorJobResponseActionRevision: 0,
      advisorJobResponseAuthoritySource: "job-native",
      advisorJobAutomaticResponseOpportunityGateBypassed: false,
      advisorJobSnapshotTurnCount: 3,
      advisorJobSnapshotLatestTurnId: "turn-a",
      advisorJobGeneratedContinuityCandidateCount: 0,
      advisorJobGeneratedContinuityCandidateChars: 0,
      advisorJobOutcome: "stale-commit-rejected",
      advisorJobCancellationReason: undefined,
      advisorJobCommitAuthorized: false,
      advisorJobCommitAuthorizationReason: "active-job-mismatch",
    }
  );
});

test("emits inherited question lineage for answer-preserving actions", () => {
  const job = createAdvisorTriggerJob({
    source: "response-action",
    mode: "response-action",
    traceId: "trace-action",
    promptContext: buildPromptContext(),
    sessionId: "session-a",
    runtimeEpoch: 1,
    snapshotTurnCount: 1,
    taskMutationAuthority: "preserve-parent",
    questionLineage: {
      questionInstanceId: "trace:trace-origin",
      questionOriginTraceId: "trace-origin",
      sourceSuggestionId: "suggestion-origin",
    },
  });

  const metadata = formatAdvisorTriggerJobForTrace(job, "scheduled");
  assert.equal(metadata.questionInstanceId, "trace:trace-origin");
  assert.equal(metadata.questionOriginTraceId, "trace-origin");
  assert.equal(metadata.sourceSuggestionId, "suggestion-origin");
});

test("force advise owns answer authority without inheriting an automatic gate", () => {
  const job = createAdvisorTriggerJob({
    source: "force-advise",
    mode: "live",
    promptContext: buildPromptContext(),
    sessionId: "session-a",
    runtimeEpoch: 1,
    snapshotTurnCount: 1,
    taskMutationAuthority: "output-only-current-branch",
    responseOpportunityGenerationGateOperationId: "automatic-gate-a",
  });

  assert.equal(job.responseOpportunityGenerationGateOperationId, undefined);
  assert.equal(job.responseAuthoritySource, "human-force-advise");
  assert.equal(job.taskMutationAuthority, "output-only-current-branch");
  const metadata = formatAdvisorTriggerJobForTrace(job, "scheduled");
  assert.equal(
    metadata.advisorJobAutomaticResponseOpportunityGateBypassed,
    true
  );
  assert.equal(
    metadata.advisorJobResponseAuthoritySource,
    "human-force-advise"
  );
});

test("response actions authorize the LQU frozen by the explicit action", () => {
  const responseActionQuestion = {
    id: "screen-question-a",
    revision: 2,
    sessionId: "session-a",
    runtimeEpoch: 1,
    currentTurnId: "screen:observation-a",
    sourceTurnIds: [],
    sources: [
      {
        turnId: "screen:observation-a",
        text: "Implement an LRU cache",
        startedAt: 10,
        endedAt: 20,
      },
    ],
    normalizedText: "Implement an LRU cache",
    startedAt: 10,
    updatedAt: 20,
    compositionReasons: ["visible-screen-question"],
    boundaryReason: "visible-screen-question" as const,
    truncated: false,
  };

  assert.deepEqual(
    resolveAdvisorLogicalQuestionAuthorizationTarget({
      jobSource: "response-action",
      runtimeCurrent: undefined,
      responseActionTarget: responseActionQuestion,
    }),
    {
      source: "response-action-target",
      logicalQuestionUnit: responseActionQuestion,
    }
  );
});

test("Regenerate authorizes the visible LQU rather than ambient runtime current", () => {
  const visibleQuestion = {
    id: "screen-question-regenerate",
    revision: 3,
    sessionId: "session-a",
    runtimeEpoch: 1,
    currentTurnId: "screen:observation-regenerate",
    sourceTurnIds: [],
    sources: [
      {
        turnId: "screen:observation-regenerate",
        text: "Implement an LRU cache",
        startedAt: 10,
        endedAt: 20,
      },
    ],
    normalizedText: "Implement an LRU cache",
    startedAt: 10,
    updatedAt: 20,
    compositionReasons: ["visible-screen-question"],
    boundaryReason: "visible-screen-question" as const,
    truncated: false,
  };

  assert.deepEqual(
    resolveAdvisorLogicalQuestionAuthorizationTarget({
      jobSource: "regenerate",
      runtimeCurrent: undefined,
      regenerateTarget: visibleQuestion,
    }),
    {
      source: "regenerate-target",
      logicalQuestionUnit: visibleQuestion,
    }
  );
});

test("manual type correction regenerates under its corrected human authority", () => {
  const job = createAdvisorTriggerJob({
    source: "manual-correction",
    mode: "live",
    promptContext: buildPromptContext(),
    sessionId: "session-a",
    runtimeEpoch: 1,
    snapshotTurnCount: 1,
    taskMutationAuthority: "manual-correction",
    responseOpportunityGenerationGateOperationId: "pre-correction-gate",
    manualCorrectionRevision: 7,
  });

  assert.equal(job.responseOpportunityGenerationGateOperationId, undefined);
  assert.equal(job.responseAuthoritySource, "human-type-correction");
  assert.equal(job.manualCorrectionRevision, 7);
  const metadata = formatAdvisorTriggerJobForTrace(job, "scheduled");
  assert.equal(
    metadata.advisorJobResponseAuthoritySource,
    "human-type-correction"
  );
  assert.equal(
    metadata.advisorJobAutomaticResponseOpportunityGateBypassed,
    true
  );
});

test("keeps canonical runtime ownership when prompt context is current-only", () => {
  const job = createAdvisorTriggerJob({
    source: "response-action",
    mode: "live",
    promptContext: buildPromptContext(),
    sessionId: "session-a",
    runtimeEpoch: 1,
    runtimeCommitSnapshot: {
      runtimeEpoch: 1,
      sessionId: "session-a",
      parentId: "parent-preserved",
      parentRevision: 4,
    },
    snapshotTurnCount: 1,
    taskMutationAuthority: "preserve-parent",
  });

  assert.equal(job.expectedParentId, "parent-preserved");
  assert.equal(
    decideAdvisorJobCommit({
      job,
      activeJobId: job.id,
      currentRuntime: {
        runtimeEpoch: 1,
        sessionId: "session-a",
        parentId: "parent-preserved",
        parentRevision: 4,
      },
    }).reason,
    "authorized"
  );
});

test("freezes and traces the bounded logical question owned by a job", () => {
  const logicalQuestionUnit = {
    id: "logical-question-a",
    revision: 2,
    sessionId: "session-a",
    runtimeEpoch: 1,
    currentTurnId: "turn-b",
    sourceTurnIds: ["turn-a", "turn-b"],
    contextSourceTurnIds: ["turn-setup"],
    recentLogicalQuestionSourceTurnIds: ["turn-previous"],
    sources: [
      {
        turnId: "turn-a",
        text: "Implement a queue",
        startedAt: 10,
        endedAt: 20,
      },
      {
        turnId: "turn-b",
        text: "Use two stacks",
        startedAt: 30,
        endedAt: 40,
      },
    ],
    normalizedText: "Implement a queue Use two stacks",
    startedAt: 10,
    updatedAt: 40,
    compositionReasons: ["constraint-or-follow-up"],
    boundaryReason: "bounded-continuation",
    truncated: false,
  };
  const job = createAdvisorTriggerJob({
    source: "live-turn",
    mode: "live",
    promptContext: buildPromptContext(),
    sessionId: "session-a",
    runtimeEpoch: 1,
    snapshotTurnCount: 2,
    taskMutationAuthority: "input-evidence",
    logicalQuestionUnit,
  });

  logicalQuestionUnit.sources[0].text = "mutated";
  logicalQuestionUnit.sourceTurnIds.push("turn-c");
  logicalQuestionUnit.contextSourceTurnIds.push("turn-mutated-setup");
  logicalQuestionUnit.recentLogicalQuestionSourceTurnIds.push(
    "turn-mutated-previous"
  );

  assert.equal(job.logicalQuestionUnit?.sources[0].text, "Implement a queue");
  assert.deepEqual(job.logicalQuestionUnit?.sourceTurnIds, ["turn-a", "turn-b"]);
  assert.deepEqual(job.logicalQuestionUnit?.contextSourceTurnIds, [
    "turn-setup",
  ]);
  assert.deepEqual(job.logicalQuestionUnit?.recentLogicalQuestionSourceTurnIds, [
    "turn-previous",
  ]);
  const metadata = formatAdvisorTriggerJobForTrace(job, "scheduled");
  assert.equal(metadata.logicalQuestionUnitId, "logical-question-a");
  assert.deepEqual(metadata.logicalQuestionSourceTurnIds, ["turn-a", "turn-b"]);
  assert.equal(
    metadata.logicalQuestionChars,
    "Implement a queue Use two stacks".length
  );
});

test("manual correction validates against its current target instead of the runtime voice target", () => {
  const runtimeCurrent = {
    id: "voice-question",
    revision: 1,
    sessionId: "session-a",
    runtimeEpoch: 1,
    currentTurnId: "turn-a",
    sourceTurnIds: ["turn-a"],
    sources: [],
    normalizedText: "Voice question",
    startedAt: 1,
    updatedAt: 1,
    compositionReasons: [],
    boundaryReason: "bounded-continuation" as const,
    truncated: false,
  };
  const manualCorrectionTarget = {
    ...runtimeCurrent,
    id: "screen-question",
    currentTurnId: "screen:observation-a",
    sourceTurnIds: ["screen:observation-a"],
    normalizedText: "Screen question",
  };

  assert.deepEqual(
    resolveAdvisorLogicalQuestionAuthorizationTarget({
      jobSource: "manual-correction",
      runtimeCurrent,
      manualCorrectionTarget,
    }),
    {
      source: "manual-correction-target",
      logicalQuestionUnit: manualCorrectionTarget,
    }
  );
  assert.deepEqual(
    resolveAdvisorLogicalQuestionAuthorizationTarget({
      jobSource: "live-turn",
      runtimeCurrent,
      manualCorrectionTarget,
    }),
    {
      source: "runtime-current",
      logicalQuestionUnit: runtimeCurrent,
    }
  );
  assert.deepEqual(
    resolveAdvisorLogicalQuestionAuthorizationTarget({
      jobSource: "live-turn",
      runtimeCurrent,
      supersessionProtectedTarget: manualCorrectionTarget,
    }),
    {
      source: "supersession-protected",
      logicalQuestionUnit: manualCorrectionTarget,
    }
  );
  assert.deepEqual(
    resolveAdvisorLogicalQuestionAuthorizationTarget({
      jobSource: "force-advise",
      runtimeCurrent,
      responseRecoveryTarget: manualCorrectionTarget,
    }),
    {
      source: "response-recovery-target",
      logicalQuestionUnit: manualCorrectionTarget,
    }
  );
  assert.deepEqual(
    resolveAdvisorLogicalQuestionAuthorizationTarget({
      jobSource: "artifact-regeneration",
      runtimeCurrent,
      artifactRegenerationTarget: manualCorrectionTarget,
    }),
    {
      source: "artifact-regeneration-target",
      logicalQuestionUnit: manualCorrectionTarget,
    }
  );
});

test("explicit response actions preserve the active parent", () => {
  assert.deepEqual(
    decideAdvisorTaskMutation({
      authority: "preserve-parent",
      resolvedRelation: "unknown",
      hasActiveParent: true,
      hasActiveChild: false,
    }),
    {
      relation: "followup-parent",
      commitParent: true,
      preserveActiveTaskType: true,
      allowExplicitRetype: false,
      reason: "explicit-action-preserve-parent",
    }
  );

  assert.equal(
    decideAdvisorTaskMutation({
      authority: "preserve-parent",
      resolvedRelation: "logistics",
      hasActiveParent: true,
      hasActiveChild: true,
    }).relation,
    "resume-parent"
  );
});

test("explicit response actions cannot create a parent without one", () => {
  const decision = decideAdvisorTaskMutation({
    authority: "preserve-parent",
    resolvedRelation: "new-parent",
    hasActiveParent: false,
    hasActiveChild: false,
  });

  assert.equal(decision.commitParent, false);
  assert.equal(decision.allowExplicitRetype, false);
  assert.equal(decision.reason, "explicit-action-without-parent");
});

test("force advise preserves the current branch without mutating topology", () => {
  assert.deepEqual(
    authorizeAdvisorTaskMutation({
      authority: "output-only-current-branch",
    }),
    { authorized: false, reason: "manual-output-only" }
  );
  assert.deepEqual(
    decideAdvisorTaskMutation({
      authority: "output-only-current-branch",
      resolvedRelation: "new-parent",
      hasActiveParent: true,
      hasActiveChild: true,
    }),
    {
      relation: "child-probe",
      commitParent: false,
      preserveActiveTaskType: true,
      allowExplicitRetype: false,
      reason: "explicit-output-only-current-branch",
    }
  );
  assert.deepEqual(
    authorizeAdvisorOutputCommit({
      authority: "output-only-current-branch",
      executionAuthorized: true,
    }),
    { authorized: true, reason: "manual-action-output-authority" }
  );
});

test("manual correction remains the only explicit retype authority", () => {
  const manual = decideAdvisorTaskMutation({
    authority: "manual-correction",
    resolvedRelation: "child-probe",
    hasActiveParent: true,
    hasActiveChild: false,
  });
  const inputEvidence = decideAdvisorTaskMutation({
    authority: "input-evidence",
    resolvedRelation: "new-parent",
    hasActiveParent: true,
    hasActiveChild: false,
  });

  assert.equal(manual.allowExplicitRetype, true);
  assert.equal(manual.relation, "child-probe");
  assert.equal(inputEvidence.allowExplicitRetype, false);
  assert.equal(inputEvidence.relation, "new-parent");
});

test("shadow execution cannot authorize output, task, or phase mutation", () => {
  const turnIntentDecision = decideAdvisorTurnIntent("Kubernetes.", {
    hasActiveTask: true,
  });
  const authorization = authorizeAdvisorTaskMutation({
    authority: "input-evidence",
    turnIntentDecision,
  });
  const taskMutation = decideAdvisorTaskMutation({
    authority: "input-evidence",
    resolvedRelation: "new-parent",
    hasActiveParent: true,
    hasActiveChild: false,
    mutationAuthorized: authorization.authorized,
  });
  const phaseMutation = decideAdvisorPhaseMutation({
    authority: "input-evidence",
    taskMutationAuthorized: authorization.authorized,
    manualPhaseAdvance: false,
    currentPhase: "requirement_clarification",
    hasActiveChild: false,
    automaticDecision: {
      phase: "design_framing",
      flags: ["architecture"],
      requiredArtifacts: ["answer", "whiteboard"],
      action: "advance",
      reason: "automatic-advance",
    },
    manualDecision: {
      phase: "design_framing",
      flags: [],
      requiredArtifacts: ["answer", "whiteboard"],
      action: "advance",
      reason: "manual-next",
    },
  });

  assert.equal(turnIntentDecision.enforcement, "shadow");
  assert.equal(turnIntentDecision.wouldSuppress, true);
  assert.deepEqual(authorization, {
    authorized: false,
    reason: "turn-intent-would-suppress",
  });
  assert.equal(taskMutation.commitParent, false);
  assert.equal(taskMutation.relation, "new-parent");
  assert.equal(taskMutation.preserveActiveTaskType, false);
  assert.equal(taskMutation.reason, "turn-intent-mutation-suppressed");
  assert.equal(phaseMutation.phase, "requirement_clarification");
  assert.equal(phaseMutation.action, "stay");
  assert.deepEqual(
    authorizeAdvisorOutputCommit({
      authority: "input-evidence",
      executionAuthorized: true,
      turnIntentDecision,
    }),
    {
      authorized: false,
      reason: "execution-not-authorized",
    }
  );
});

test("runtime intent answer can commit output without mutating task state", () => {
  const local = decideAdvisorTurnIntent("Kubernetes.", {
    hasActiveTask: true,
  });
  const released = {
    ...local,
    action: "answer-refresh" as const,
    recommendedAction: "answer-refresh" as const,
    enforcement: "allow" as const,
    wouldSuppress: false,
    executionAuthorized: true,
    authoritySource: "runtime-intent-gate" as const,
  };

  assert.deepEqual(
    authorizeAdvisorTaskMutation({
      authority: "runtime-intent-answer",
      turnIntentDecision: released,
    }),
    { authorized: false, reason: "runtime-intent-action-only" }
  );
  assert.deepEqual(
    authorizeAdvisorOutputCommit({
      authority: "runtime-intent-answer",
      executionAuthorized: true,
      turnIntentDecision: released,
    }),
    {
      authorized: true,
      reason: "runtime-intent-answer-output-authority",
    }
  );
});

test("runtime type adjudication authorizes output only", () => {
  const shadow = decideAdvisorTurnIntent("Multi-region failover.", {
    hasActiveTask: true,
  });

  assert.deepEqual(
    authorizeAdvisorTaskMutation({
      authority: "runtime-type-adjudication-output-only",
      turnIntentDecision: shadow,
    }),
    {
      authorized: false,
      reason: "runtime-type-adjudication-output-only",
    }
  );
  assert.deepEqual(
    authorizeAdvisorOutputCommit({
      authority: "runtime-type-adjudication-output-only",
      executionAuthorized: true,
      turnIntentDecision: shadow,
    }),
    {
      authorized: true,
      reason: "runtime-type-adjudication-output-authority",
    }
  );
});

test("output authority follows execution without granting task mutation", () => {
  const allowed = decideAdvisorTurnIntent(
    "How would you design a distributed cache?",
    { hasActiveTask: false }
  );

  assert.deepEqual(
    authorizeAdvisorOutputCommit({
      authority: "input-evidence",
      executionAuthorized: true,
      turnIntentDecision: allowed,
    }),
    { authorized: true, reason: "substantive-output-authority" }
  );
  assert.deepEqual(
    authorizeAdvisorOutputCommit({
      authority: "preserve-parent",
      executionAuthorized: true,
    }),
    { authorized: true, reason: "manual-action-output-authority" }
  );
  assert.deepEqual(
    authorizeAdvisorOutputCommit({
      authority: "output-only-current-branch",
      executionAuthorized: true,
    }),
    { authorized: true, reason: "manual-action-output-authority" }
  );
  assert.deepEqual(
    authorizeAdvisorOutputCommit({
      authority: "input-evidence",
      executionAuthorized: false,
      turnIntentDecision: allowed,
    }),
    { authorized: false, reason: "execution-not-authorized" }
  );
});

test("substantive input and explicit actions retain canonical mutation authority", () => {
  const substantive = decideAdvisorTurnIntent(
    "How would you design a distributed cache?",
    { hasActiveTask: false }
  );

  assert.deepEqual(
    authorizeAdvisorTaskMutation({
      authority: "input-evidence",
      turnIntentDecision: substantive,
    }),
    { authorized: true, reason: "substantive-input-authority" }
  );
  assert.deepEqual(
    authorizeAdvisorTaskMutation({ authority: "preserve-parent" }),
    { authorized: true, reason: "explicit-action-authority" }
  );
  assert.deepEqual(
    authorizeAdvisorTaskMutation({ authority: "manual-correction" }),
    { authorized: true, reason: "manual-correction-authority" }
  );
});

test("regenerate and speakable preserve phase while manual next can advance", () => {
  const automaticDecision = {
    phase: "design_framing" as const,
    flags: ["architecture" as const],
    requiredArtifacts: ["answer" as const, "whiteboard" as const],
    action: "advance" as const,
    reason: "automatic-advance",
  };
  const manualDecision = {
    phase: "design_framing" as const,
    flags: ["whiteboard" as const],
    requiredArtifacts: ["answer" as const, "whiteboard" as const],
    action: "advance" as const,
    reason: "manual-next",
    source: "manual-next" as const,
  };

  assert.equal(
    decideAdvisorPhaseMutation({
      authority: "preserve-parent",
      manualPhaseAdvance: false,
      currentPhase: "requirement_clarification",
      hasActiveChild: false,
      automaticDecision,
      manualDecision,
    }).phase,
    "requirement_clarification"
  );
  assert.equal(
    decideAdvisorPhaseMutation({
      authority: "preserve-parent",
      manualPhaseAdvance: true,
      currentPhase: "requirement_clarification",
      hasActiveChild: false,
      automaticDecision,
      manualDecision,
    }).phase,
    "design_framing"
  );
  assert.deepEqual(
    decideAdvisorPhaseMutation({
      authority: "output-only-current-branch",
      taskMutationAuthorized: false,
      manualPhaseAdvance: true,
      currentPhase: "requirement_clarification",
      hasActiveChild: true,
      automaticDecision,
      manualDecision,
    }),
    {
      phase: "requirement_clarification",
      flags: [],
      requiredArtifacts: ["answer", "whiteboard"],
      action: "stay",
      reason: "explicit-output-only-current-branch-phase",
      source: "automatic",
      targetArtifact: "answer",
      guardStatus: "automatic",
      phaseFrom: "requirement_clarification",
    }
  );
});
