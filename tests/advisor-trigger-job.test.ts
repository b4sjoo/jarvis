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
  const job = createAdvisorTriggerJob({
    source: "live-turn",
    mode: "live",
    promptContext,
    sessionId: "session-a",
    runtimeEpoch: 1,
    snapshotTurnCount: 1,
    taskMutationAuthority: "input-evidence",
  });

  promptContext.transcript = "Them: A newer question";
  if (promptContext.latestTurn) {
    promptContext.latestTurn.text = "A newer question";
  }

  assert.equal(job.promptContextSnapshot.transcript, "Them: Design a cache");
  assert.equal(job.promptContextSnapshot.latestTurn?.text, "Design a cache");
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
      advisorJobSnapshotTurnCount: 3,
      advisorJobSnapshotLatestTurnId: "turn-a",
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

test("freezes and traces the bounded logical question owned by a job", () => {
  const logicalQuestionUnit = {
    id: "logical-question-a",
    revision: 2,
    sessionId: "session-a",
    runtimeEpoch: 1,
    currentTurnId: "turn-b",
    sourceTurnIds: ["turn-a", "turn-b"],
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

  assert.equal(job.logicalQuestionUnit?.sources[0].text, "Implement a queue");
  assert.deepEqual(job.logicalQuestionUnit?.sourceTurnIds, ["turn-a", "turn-b"]);
  const metadata = formatAdvisorTriggerJobForTrace(job, "scheduled");
  assert.equal(metadata.logicalQuestionUnitId, "logical-question-a");
  assert.deepEqual(metadata.logicalQuestionSourceTurnIds, ["turn-a", "turn-b"]);
  assert.equal(
    metadata.logicalQuestionChars,
    "Implement a queue Use two stacks".length
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
      preserveParentType: true,
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

test("shadow execution cannot authorize canonical task or phase mutation", () => {
  const turnIntentDecision = decideAdvisorTurnIntent("Hmm.", {
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
  assert.equal(taskMutation.relation, "unknown");
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
      authorized: true,
      reason: "shadow-fail-open-output-authority",
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
});
