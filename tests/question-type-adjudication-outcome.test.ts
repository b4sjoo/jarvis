import assert from "node:assert/strict";
import test from "node:test";
import {
  createQuestionTypeAdjudicationOutcomeEvent,
} from "../src/lib/meeting/question-type-adjudication.js";
import {
  buildQuestionTypeAdjudicationOutcomeReport,
} from "../src/lib/meeting/question-type-adjudication-outcome.js";

const decision = {
  recordedAt: 10,
  sessionId: "session-a",
  traceId: "trace-a",
  taskId: "task-a",
  metadata: {
    questionTypeAdjudicationOperationId: "operation-a",
    questionTypeAdjudicationUnitId: "lqu-a",
    questionTypeAdjudicationUnitRevision: 2,
    questionTypeAdjudicationRuntimeEpoch: 3,
    questionTypeAdjudicationParseValid: true,
    questionTypeAdjudicationCandidateType: "general-system-design",
    questionTypeAdjudicationEnforcementAuthorized: true,
    questionTypeAdjudicationAppliedToRuntime: false,
  },
};

function outcome(
  stage: "release" | "advisor-start" | "model-complete" | "delivery",
  disposition:
    | "settlement-applied"
    | "advisor-started"
    | "visible-committed",
  recordedAt: number
) {
  return createQuestionTypeAdjudicationOutcomeEvent({
    operationId: "operation-a",
    sessionId: "session-a",
    runtimeEpoch: 3,
    logicalQuestionUnitId: "lqu-a",
    logicalQuestionUnitRevision: 2,
    traceId: "trace-a",
    taskId: "task-a",
    settlementOperationId: "operation-a",
    settlementId: "settlement-a",
    outputAuthorityId: "authority-a",
    advisorJobId: stage === "release" ? undefined : "advisor-a",
    visibleAnswerRevision: stage === "delivery" ? 7 : undefined,
    proposedQuestionType: "general-system-design",
    stage,
    disposition,
    enforcementAuthorized: true,
    settlementApplied: true,
    appliedToSettlement: true,
    appliedToResponse: stage !== "release",
    appliedToParent: false,
    advisorStarted: stage !== "release",
    modelCompleted: stage === "delivery",
    visibleCommitted: stage === "delivery",
    recordedAt,
  });
}

test("joins proposal and post-release outcomes without rewriting the proposal", () => {
  const report = buildQuestionTypeAdjudicationOutcomeReport({
    decisions: [decision],
    outcomes: [
      outcome("release", "settlement-applied", 20),
      outcome("advisor-start", "advisor-started", 30),
      outcome("delivery", "visible-committed", 40),
    ],
    now: 50,
  });

  assert.equal(
    decision.metadata.questionTypeAdjudicationAppliedToRuntime,
    false
  );
  assert.equal(report.metrics.proposalOperations, 1);
  assert.equal(report.metrics.validProposalOperations, 1);
  assert.equal(report.metrics.enforcementAuthorized, 1);
  assert.equal(report.metrics.settlementApplied, 1);
  assert.equal(report.metrics.appliedToSettlement, 1);
  assert.equal(report.metrics.appliedToResponse, 1);
  assert.equal(report.metrics.appliedToParent, 0);
  assert.equal(report.metrics.advisorStarted, 1);
  assert.equal(report.metrics.modelCompleted, 1);
  assert.equal(report.metrics.visibleCommitted, 1);
  assert.equal(report.metrics.joinCoverage, 1);
  assert.equal(report.rows[0]?.advisorJobId, "advisor-a");
  assert.equal(report.rows[0]?.visibleAnswerRevision, 7);
  assert.equal(report.rows[0]?.finalDisposition, "visible-committed");
});

test("rejects outcome rows whose session or logical-question identity drifted", () => {
  const mismatched = createQuestionTypeAdjudicationOutcomeEvent({
    operationId: "operation-a",
    sessionId: "session-b",
    runtimeEpoch: 3,
    logicalQuestionUnitId: "lqu-a",
    logicalQuestionUnitRevision: 2,
    traceId: "trace-a",
    stage: "delivery",
    disposition: "visible-committed",
    visibleCommitted: true,
    recordedAt: 40,
  });
  const orphan = createQuestionTypeAdjudicationOutcomeEvent({
    operationId: "operation-orphan",
    sessionId: "session-a",
    runtimeEpoch: 3,
    logicalQuestionUnitId: "lqu-orphan",
    logicalQuestionUnitRevision: 1,
    traceId: "trace-orphan",
    stage: "delivery",
    disposition: "visible-committed",
    visibleCommitted: true,
    recordedAt: 41,
  });
  const report = buildQuestionTypeAdjudicationOutcomeReport({
    decisions: [decision],
    outcomes: [mismatched, orphan],
  });

  assert.equal(report.metrics.visibleCommitted, 0);
  assert.equal(report.metrics.identityMismatches, 1);
  assert.equal(report.metrics.orphanOutcomes, 1);
  assert.equal(
    report.integrity.firstIdentityMismatch?.field,
    "runtimeSessionId"
  );
});

test("does not confuse the recording envelope with the runtime session", () => {
  const recordedDecision = {
    ...decision,
    sessionId: "session_recording_a",
    metadata: {
      ...decision.metadata,
      runtimeInferenceCircuitSessionId: "meeting-a",
    },
  };
  const runtimeOutcome = {
    ...createQuestionTypeAdjudicationOutcomeEvent({
      operationId: "operation-a",
      sessionId: "meeting-a",
      runtimeEpoch: 3,
      logicalQuestionUnitId: "lqu-a",
      logicalQuestionUnitRevision: 2,
      traceId: "trace-a",
      stage: "release",
      disposition: "settlement-applied",
      enforcementAuthorized: true,
      settlementApplied: true,
    }),
    schemaVersion: 1 as const,
    recordingSessionId: undefined,
    runtimeSessionId: undefined,
    originTraceId: undefined,
  };

  const report = buildQuestionTypeAdjudicationOutcomeReport({
    decisions: [recordedDecision],
    outcomes: [runtimeOutcome],
  });

  assert.equal(report.metrics.settlementApplied, 1);
  assert.equal(report.metrics.identityMismatches, 0);
  assert.equal(report.metrics.joinCoverage, 1);
  assert.equal(report.rows[0]?.recordingSessionId, "session_recording_a");
  assert.equal(report.rows[0]?.runtimeSessionId, "meeting-a");
});

test("reports a shadow proposal as explicitly not applied", () => {
  const report = buildQuestionTypeAdjudicationOutcomeReport({
    decisions: [
      {
        ...decision,
        metadata: {
          ...decision.metadata,
          questionTypeAdjudicationMode: "shadow",
          questionTypeAdjudicationEnforcementAuthorized: false,
        },
      },
    ],
    outcomes: [],
  });

  assert.equal(report.rows[0]?.terminalState, "not-applied-shadow");
  assert.equal(report.metrics.explicitNotApplied, 1);
  assert.equal(report.metrics.unmatchedProposals, 0);
  assert.equal(report.metrics.joinCoverage, 1);
});

test("derives response application from the legacy advisor-start event", () => {
  const legacyOutcome = {
    ...outcome("advisor-start", "advisor-started", 30),
    schemaVersion: 1 as const,
    appliedToResponse: undefined,
    appliedToSettlement: undefined,
    appliedToParent: undefined,
    runtimeSessionId: undefined,
    originTraceId: undefined,
  };
  const report = buildQuestionTypeAdjudicationOutcomeReport({
    decisions: [decision],
    outcomes: [legacyOutcome],
  });

  assert.equal(report.metrics.appliedToResponse, 1);
  assert.equal(report.metrics.appliedToSettlement, 1);
});
