import assert from "node:assert/strict";
import test from "node:test";
import {
  createAdvisorTriggerJob,
  decideAdvisorPhaseMutation,
  decideAdvisorJobCommit,
  decideAdvisorTaskMutation,
  formatAdvisorTriggerJobForTrace,
} from "../src/lib/meeting/advisor-trigger-job.js";
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
    snapshotTurnCount: 1,
    taskMutationAuthority: "input-evidence",
  });

  assert.deepEqual(
    decideAdvisorJobCommit({
      job,
      activeJobId: "newer-job",
      currentSessionId: "session-a",
    }),
    { authorized: false, reason: "active-job-mismatch" }
  );
  assert.deepEqual(
    decideAdvisorJobCommit({
      job,
      activeJobId: job.id,
      currentSessionId: "session-b",
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
      advisorJobExpectedParentId: undefined,
      advisorJobExpectedParentRevision: undefined,
      advisorJobMutationAuthority: "input-evidence",
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

test("regenerate and speakable preserve phase while manual next can advance", () => {
  const automaticDecision = {
    phase: "design_framing" as const,
    flags: ["architecture" as const],
    action: "advance" as const,
    reason: "automatic-advance",
  };
  const manualDecision = {
    phase: "design_framing" as const,
    flags: ["whiteboard" as const],
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
