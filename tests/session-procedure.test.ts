import assert from "node:assert/strict";
import test from "node:test";
import type {
  HumanEvaluationProjectionV2,
  HumanGroundTruthEventV2,
} from "../src/lib/meeting/human-ground-truth-v2.js";
import {
  buildSessionProcedureV1,
  type SessionProcedureTimelineEvent,
} from "../src/lib/meeting/session-procedure.js";
import { createManualRuntimeActionEvent } from "../src/lib/meeting/manual-runtime-action.js";

test("compiles ordered source and action steps without injecting resolved targets", () => {
  const manualActions = [
    createManualRuntimeActionEvent({
      actionId: "action-1",
      action: "force-advise",
      stage: "requested",
      runtimeSessionId: "meeting-1",
      runtimeEpoch: 2,
      observedLogicalQuestionUnitId: "original-lqu",
      occurredAt: 200,
    }),
    createManualRuntimeActionEvent({
      actionId: "action-1",
      action: "force-advise",
      stage: "terminal",
      runtimeSessionId: "meeting-1",
      runtimeEpoch: 2,
      traceId: "trace-force",
      observedLogicalQuestionUnitId: "original-lqu",
      observedTaskId: "original-parent",
      terminalDisposition: "completed",
      occurredAt: 250,
    }),
  ];
  const timeline: SessionProcedureTimelineEvent[] = [
    {
      id: "timeline-ingress",
      kind: "capture-lifecycle",
      createdAt: 95,
      metadata: {
        stage: "canonical-turn-ingress-admitted",
        canonicalTurnIngressTurnId: "turn-1",
        traceId: "trace-initial",
      },
    },
    {
      id: "timeline-turn",
      kind: "transcript-turn",
      createdAt: 100,
      metadata: { turnId: "turn-1" },
    },
    {
      id: "timeline-action-requested",
      kind: "manual-runtime-action",
      createdAt: 200,
      metadata: { actionId: "action-1", stage: "requested" },
    },
    {
      id: "timeline-action-terminal",
      kind: "manual-runtime-action",
      createdAt: 250,
      metadata: { actionId: "action-1", stage: "terminal" },
    },
    {
      id: "timeline-type-correction",
      kind: "manual-question-type-correction",
      createdAt: 300,
      metadata: {
        manualQuestionTypeCorrectionId: "type-correction-1",
        correctedQuestionType: "coding",
      },
    },
    {
      id: "timeline-screen",
      kind: "screen-capture",
      createdAt: 400,
      traceId: "trace-screen",
      metadata: { observationId: "screen-1" },
      artifactRefs: ["screenshots/screen-1.png"],
      screenInput: {
        image: {
          path: "screenshots/screen-1.png",
          sha256: "sha256:screen-1",
          mediaType: "image/png",
        },
      },
    },
  ];
  const procedure = buildSessionProcedureV1({
    recordingSessionId: "recording-1",
    folderName: "session-one",
    sourceDigest: "digest",
    scriptedValidation: true,
    forcedScripted: false,
    recordingIntegrityStatus: "complete",
    timelineEvents: timeline,
    transcriptTurns: [
      {
        id: "turn-1",
        speaker: "them",
        source: "system-audio",
        text: "Implement an LRU cache.",
        startedAt: 90,
        endedAt: 95,
        isFinal: true,
      },
    ],
    manualActions,
    humanEvaluationProjections: [
      projectionForTurn(
        "turn-1",
        "trace-initial",
        explicitSettlementEvent("turn-1", "trace-initial")
      ),
      projectionForTurn(
        "turn-1",
        "trace-later-correction",
        explicitSettlementEvent(
          "turn-1",
          "trace-later-correction",
          "ai-ml-system-design"
        )
      ),
    ],
    generatedAt: 500,
  });

  assert.deepEqual(
    procedure.steps.map((step) => step.kind),
    ["them-text", "force-advise", "type-correction", "screen-input"]
  );
  assert.equal(procedure.execution.defaultBarrier, "typed-terminal");
  assert.deepEqual(procedure.steps[1]?.input, {});
  assert.equal(
    procedure.steps[1]?.observed?.logicalQuestionUnitId,
    "original-lqu"
  );
  assert.equal(
    "targetStepId" in (procedure.steps[1]?.input ?? {}),
    false
  );
  assert.equal(procedure.steps[0]?.expected?.questionType, "coding");
  assert.equal(procedure.steps[0]?.expected?.relation, "new-parent");
  assert.deepEqual(procedure.steps[0]?.expectedEvidenceRefs, [
    {
      eventId: "truth-settlement",
      factKind: "expected-task-settlement",
    },
  ]);
  assert.equal(procedure.steps[0]?.replaySupport, "ready");
  assert.equal(procedure.steps[3]?.replaySupport, "capture-only");
  assert.deepEqual(procedure.steps[3]?.input.screen, {
    image: {
      path: "screenshots/screen-1.png",
      sha256: "sha256:screen-1",
      mediaType: "image/png",
    },
  });
  assert.deepEqual(
    procedure.steps[3]?.provenance.sourceObservationIds,
    ["screen-1"]
  );
});

test("does not promote action-derived observations into expected truth", () => {
  const actionId = "action-2";
  const procedure = buildSessionProcedureV1({
    recordingSessionId: "recording-2",
    folderName: "session-two",
    sourceDigest: "digest",
    scriptedValidation: true,
    forcedScripted: true,
    recordingIntegrityStatus: "complete",
    timelineEvents: [
      {
        id: "timeline-action-requested",
        kind: "manual-runtime-action",
        createdAt: 100,
        metadata: { actionId, stage: "requested" },
      },
    ],
    transcriptTurns: [],
    manualActions: [
      createManualRuntimeActionEvent({
        actionId,
        action: "next-phase",
        stage: "requested",
        runtimeSessionId: "meeting-2",
        runtimeEpoch: 1,
        occurredAt: 100,
      }),
    ],
    humanEvaluationProjections: [
      projectionForAction(
        actionId,
        expectedRuntimeActionEvent(actionId, "manual-context-action")
      ),
    ],
    generatedAt: 200,
  });

  assert.equal(procedure.steps[0]?.expected, undefined);
  assert.deepEqual(procedure.steps[0]?.expectedEvidenceRefs, []);
  assert.equal(procedure.steps[0]?.reviewStatus, "needs-review");
  assert.deepEqual(procedure.evidenceGaps, [
    "manual-action-terminal-missing",
  ]);
});

test("fails closed when exact expected evidence conflicts", () => {
  const procedure = buildSessionProcedureV1({
    recordingSessionId: "recording-conflict",
    folderName: "session-conflict",
    sourceDigest: "digest",
    scriptedValidation: true,
    forcedScripted: false,
    recordingIntegrityStatus: "complete",
    timelineEvents: [
      {
        id: "timeline-ingress",
        kind: "capture-lifecycle",
        createdAt: 90,
        metadata: {
          stage: "canonical-turn-ingress-admitted",
          canonicalTurnIngressTurnId: "turn-conflict",
          traceId: "trace-conflict",
        },
      },
      {
        id: "timeline-turn",
        kind: "transcript-turn",
        createdAt: 100,
        metadata: { turnId: "turn-conflict" },
      },
    ],
    transcriptTurns: [
      {
        id: "turn-conflict",
        speaker: "them",
        text: "Design this system.",
        startedAt: 100,
        endedAt: 100,
      },
    ],
    manualActions: [],
    humanEvaluationProjections: [
      projectionForTurn(
        "turn-conflict",
        "trace-conflict",
        explicitSettlementEvent("turn-conflict", "trace-conflict", "coding")
      ),
      projectionForTurn(
        "turn-conflict",
        "trace-conflict",
        explicitSettlementEvent(
          "turn-conflict",
          "trace-conflict",
          "ai-ml-system-design"
        )
      ),
    ],
    generatedAt: 500,
  });

  assert.equal(procedure.steps[0]?.expected?.questionType, undefined);
  assert.equal(procedure.steps[0]?.expected?.relation, "new-parent");
  assert.deepEqual(procedure.steps[0]?.evidenceGaps, [
    "conflicting-expected-evidence:questionType",
  ]);
  assert.equal(procedure.steps[0]?.reviewStatus, "needs-review");
});

test("does not guess across multiple source-turn evaluation attempts", () => {
  const procedure = buildSessionProcedureV1({
    recordingSessionId: "recording-ambiguous",
    folderName: "session-ambiguous",
    sourceDigest: "digest",
    scriptedValidation: true,
    forcedScripted: false,
    recordingIntegrityStatus: "complete",
    timelineEvents: [
      {
        id: "timeline-turn",
        kind: "transcript-turn",
        createdAt: 100,
        metadata: { turnId: "turn-ambiguous" },
      },
    ],
    transcriptTurns: [
      {
        id: "turn-ambiguous",
        speaker: "them",
        text: "Design this system.",
        startedAt: 100,
        endedAt: 100,
      },
    ],
    manualActions: [],
    humanEvaluationProjections: [
      projectionForTurn(
        "turn-ambiguous",
        "trace-one",
        explicitSettlementEvent("turn-ambiguous", "trace-one", "coding")
      ),
      projectionForTurn(
        "turn-ambiguous",
        "trace-two",
        explicitSettlementEvent(
          "turn-ambiguous",
          "trace-two",
          "ai-ml-system-design"
        )
      ),
    ],
    generatedAt: 500,
  });

  assert.equal(procedure.steps[0]?.expected, undefined);
  assert.deepEqual(procedure.steps[0]?.expectedEvidenceRefs, []);
  assert.deepEqual(procedure.steps[0]?.evidenceGaps, [
    "ambiguous-source-turn-evaluation-join",
  ]);
  assert.equal(procedure.reviewStatus, "needs-review");
});

test("compiles Regenerate Artifacts with its terminal and expected intent", () => {
  const actionId = "artifact-action-1";
  const procedure = buildSessionProcedureV1({
    recordingSessionId: "recording-artifact",
    folderName: "session-artifact",
    sourceDigest: "digest",
    scriptedValidation: true,
    forcedScripted: true,
    recordingIntegrityStatus: "complete",
    timelineEvents: [
      {
        id: "timeline-artifact-request",
        kind: "manual-runtime-action",
        createdAt: 100,
        metadata: { actionId, stage: "requested" },
      },
    ],
    transcriptTurns: [],
    manualActions: [
      createManualRuntimeActionEvent({
        actionId,
        action: "regenerate-artifacts",
        stage: "requested",
        runtimeSessionId: "meeting-1",
        runtimeEpoch: 2,
        observedVisibleAnswerRevision: 4,
        occurredAt: 100,
      }),
      createManualRuntimeActionEvent({
        actionId,
        action: "regenerate-artifacts",
        stage: "terminal",
        runtimeSessionId: "meeting-1",
        runtimeEpoch: 2,
        traceId: "trace-artifact",
        observedVisibleAnswerRevision: 5,
        terminalDisposition: "completed",
        reason: "visible-answer-committed",
        occurredAt: 200,
      }),
    ],
    humanEvaluationProjections: [
      projectionForAction(actionId, explicitArtifactIntentEvent(actionId)),
    ],
    generatedAt: 300,
  });

  assert.equal(procedure.steps[0]?.kind, "regenerate-artifacts");
  assert.equal(
    procedure.steps[0]?.observed?.terminalDisposition,
    "completed"
  );
  assert.equal(procedure.steps[0]?.observed?.visibleAnswerRevision, 5);
  assert.equal(
    procedure.steps[0]?.expected?.artifactIntent,
    "revise-whiteboard"
  );
});

function projectionForTurn(
  turnId: string,
  traceId: string,
  event: HumanGroundTruthEventV2
): HumanEvaluationProjectionV2 {
  return projection({ sourceTurnIds: [turnId], traceIds: [traceId] }, event);
}

function projectionForAction(
  actionId: string,
  event: HumanGroundTruthEventV2
): HumanEvaluationProjectionV2 {
  return projection({ sourceTurnIds: [], traceIds: [] }, {
    ...event,
    provenance: { ...event.provenance, actionId },
  });
}

function projection(
  subject: { sourceTurnIds: string[]; traceIds: string[] },
  event: HumanGroundTruthEventV2
): HumanEvaluationProjectionV2 {
  return {
    schemaVersion: 2,
    projectionId: `projection:${event.eventId}`,
    sessionId: "meeting-1",
    subject,
    derivationVersion: "human-evaluation-v2.11",
    inputEventIds: [event.eventId],
    semanticInputEventIds: [event.eventId],
    interventionOnlyEventIds: [],
    inputTraceHashes: [],
    activeFacts: { [event.fact.kind]: event },
    verdicts: {},
    conflicts: [],
    computedAt: 500,
  };
}

function explicitSettlementEvent(
  turnId: string,
  traceId: string,
  questionType: "coding" | "ai-ml-system-design" = "coding"
): HumanGroundTruthEventV2 {
  return {
    schemaVersion: 2,
    eventId:
      questionType === "coding"
        ? "truth-settlement"
        : "truth-settlement-ai-ml",
    sessionId: "meeting-1",
    subject: { traceIds: [traceId], sourceTurnIds: [turnId] },
    fact: {
      kind: "expected-task-settlement",
      expectedQuestionType: questionType,
      expectedRelation: "new-parent",
      expectedParentAction: "create",
    },
    provenance: {
      source: "explicit-ui",
      actor: "human",
      collection: "scripted-validation",
      recordedAt: 450,
    },
    confirmation: "confirmed",
  };
}

function expectedRuntimeActionEvent(
  actionId: string,
  source: "manual-context-action"
): HumanGroundTruthEventV2 {
  return {
    schemaVersion: 2,
    eventId: "truth-action",
    sessionId: "meeting-2",
    subject: { traceIds: [], sourceTurnIds: [] },
    fact: {
      kind: "expected-runtime-action",
      expectedAction: "advise",
    },
    provenance: {
      source,
      actor: "human",
      collection: "scripted-validation",
      actionId,
      recordedAt: 150,
    },
    confirmation: "confirmed",
  };
}

function explicitArtifactIntentEvent(
  actionId: string
): HumanGroundTruthEventV2 {
  return {
    schemaVersion: 2,
    eventId: "truth-artifact-intent",
    sessionId: "meeting-1",
    subject: { traceIds: ["trace-artifact"], sourceTurnIds: [] },
    fact: {
      kind: "expected-artifact-intent",
      expectedIntent: "revise-whiteboard",
    },
    provenance: {
      source: "explicit-ui",
      actor: "human",
      collection: "scripted-validation",
      actionId,
      recordedAt: 250,
    },
    confirmation: "confirmed",
  };
}
