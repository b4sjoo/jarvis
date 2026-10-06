import type {
  HumanEvaluationProjectionV2,
  HumanGroundTruthEventV2,
} from "./human-ground-truth-v2.js";
import type { ManualRuntimeActionEventV1 } from "./manual-runtime-action.js";
import type { RuntimeRegressionStepEventV1 } from "./runtime-regression.js";
import type { ManualCorrectionIntent } from "./manual-correction-intent.js";
import { readManualCorrectionIntent, readCommittedManualCorrectionEvidence, type CommittedManualCorrectionEvidence } from "./task-settlement-tuple.js";

export const SESSION_PROCEDURE_SCHEMA_VERSION = 1 as const;

export type SessionProcedureStepKind =
  | "them-text"
  | "me-text"
  | "screen-input"
  | "term-correction"
  | "term-correction-deactivation"
  | "type-correction"
  | ManualRuntimeActionEventV1["action"];

export type SessionProcedureReplaySupport = "ready" | "capture-only";

export interface SessionProcedureFileRef {
  path: string;
  sha256: string;
  mediaType?: string;
}

export interface SessionProcedureScreenInput {
  image: SessionProcedureFileRef;
  focusImage?: SessionProcedureFileRef;
  metadata?: SessionProcedureFileRef;
}

export interface SessionProcedureTimelineEvent {
  id: string;
  kind: string;
  createdAt: number;
  traceId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
  artifactRefs?: string[];
  screenInput?: SessionProcedureScreenInput;
  evidenceGaps?: string[];
}

export interface SessionProcedureTranscriptTurn {
  id: string;
  speaker: "them" | "me" | "unknown";
  source?: string;
  text: string;
  startedAt: number;
  endedAt: number;
  isFinal?: boolean;
}

export interface SessionProcedureTraceSummary {
  traceId: string;
  [key: string]: unknown;
}

export interface SessionProcedureExpectedEvidenceRef {
  eventId: string;
  factKind: HumanGroundTruthEventV2["fact"]["kind"];
}

export interface SessionProcedureExpectedContract {
  terminalDisposition?: string;
  requestedArtifacts?: string[];
  committedArtifacts?: string[];
  questionType?: string;
  relation?: string;
  parentAction?: string;
  expectedParentId?: string;
  expectedBranchId?: string;
  expectedContextOwnerId?: string;
  runtimeAction?: string;
  contextReadScope?: string;
  artifactIntent?: string;
  answerOutcome?: string;
  expectedProjectId?: string;
  expectedProjectName?: string;
  playbookPhase?: string;
  factAnchorState?: string;
  childContinuity?: string;
  unsupportedFirstPersonClaim?: boolean;
}

export interface SessionProcedureStepV1 {
  id: string;
  ordinal: number;
  kind: SessionProcedureStepKind;
  occurredAt: number;
  delayAfterPreviousMs: number;
  replaySupport: SessionProcedureReplaySupport;
  input: {
    text?: string;
    artifactRefs?: string[];
    screen?: SessionProcedureScreenInput;
    correctedType?: string;
    correctionIntent?: ManualCorrectionIntent;
    correctionText?: string;
    sourceTerm?: string;
    replacementTerm?: string;
  };
  observed?: {
    traceIds: string[];
    terminalDisposition?: string;
    terminalReason?: string;
    logicalQuestionUnitId?: string;
    logicalQuestionUnitRevision?: number;
    primarySourceTurnIds?: string[];
    currentQuestionContextSourceTurnIds?: string[];
    recentLogicalQuestionSourceTurnIds?: string[];
    advisorContextSourceTurnIds?: string[];
    responseOpportunityDecision?: string;
    responseOpportunityDisposition?: string;
    questionType?: string;
    relation?: string;
    parentAction?: string;
    settledParentId?: string;
    settledChildId?: string;
    manualCorrectionEvidence?: CommittedManualCorrectionEvidence;
    contextReadScope?: string;
    settlementDisposition?: string;
    taskMutationCommand?: string;
    taskMutationDisposition?: string;
    requestedArtifacts?: string[];
    stableAnswerCommitDisposition?: string;
    staleCommitRejected?: boolean;
    visibleCommitted?: boolean;
    taskId?: string;
    visibleAnswerRevision?: number;
    correctionDisposition?: string;
    ingressSource?: string;
    ingressReceivedAt?: number;
  };
  expected?: SessionProcedureExpectedContract;
  expectedEvidenceRefs: SessionProcedureExpectedEvidenceRef[];
  reviewStatus: "ready" | "needs-human-labels" | "needs-review";
  evidenceGaps: string[];
  provenance: {
    timelineEventId: string;
    traceIds: string[];
    sourceTurnIds: string[];
    sourceObservationIds?: string[];
    sourceTransport?: string;
    actionId?: string;
    specializedEventId?: string;
  };
}

export interface SessionProcedureV1 {
  schemaVersion: typeof SESSION_PROCEDURE_SCHEMA_VERSION;
  id: string;
  source: {
    recordingSessionId: string;
    folderName: string;
    sourceDigest: string;
    scriptedValidation: true;
    forcedScripted: boolean;
    recordingIntegrityStatus?: string;
  };
  execution: {
    defaultBarrier: "typed-terminal";
  };
  generatedAt: number;
  reviewStatus: "ready" | "needs-human-labels" | "needs-review";
  evidenceGaps: string[];
  steps: SessionProcedureStepV1[];
}

export function buildSessionProcedureV1(input: {
  recordingSessionId: string;
  folderName: string;
  sourceDigest: string;
  scriptedValidation: true;
  forcedScripted: boolean;
  recordingIntegrityStatus?: string;
  timelineEvents: SessionProcedureTimelineEvent[];
  transcriptTurns: SessionProcedureTranscriptTurn[];
  runtimeRegressionSteps?: RuntimeRegressionStepEventV1[];
  manualActions: ManualRuntimeActionEventV1[];
  humanEvaluationProjections: HumanEvaluationProjectionV2[];
  traceSummaries?: SessionProcedureTraceSummary[];
  generatedAt?: number;
}): SessionProcedureV1 {
  const turnsById = new Map(
    input.transcriptTurns.map((turn) => [turn.id, turn])
  );
  const manualActionsById = groupManualActions(input.manualActions);
  const ledgerTypeCorrectionIds = new Set(input.manualActions
    .filter((event) => event.action === "type-correction" && event.specializedEventId)
    .map((event) => `type:${event.specializedEventId}`));
  const ingressTraceIdsByTurnId = collectIngressTraceIdsByTurnId(
    input.timelineEvents
  );
  const ingressTurnIdsByTraceId = new Map<string, string>();
  for (const [turnId, traceIds] of ingressTraceIdsByTurnId) {
    for (const traceId of traceIds) {
      ingressTurnIdsByTraceId.set(traceId, turnId);
    }
  }
  const traceSummariesById = new Map(
    (input.traceSummaries ?? []).map((summary) => [summary.traceId, summary])
  );
  const traceSummaryProjectionEnabled = input.traceSummaries !== undefined;
  const steps: SessionProcedureStepV1[] = [];
  const representedTurnIds = new Set<string>();
  const representedActionIds = new Set<string>();
  const representedSpecializedEventIds = new Set<string>();
  const runtimeStepTraceIds = new Set<string>();

  for (const step of buildRuntimeRegressionTextSteps({
    events: input.runtimeRegressionSteps ?? [],
    traceSummariesById,
    traceSummaryProjectionEnabled,
    projections: input.humanEvaluationProjections,
    turnsById,
    ingressTurnIdsByTraceId,
  })) {
    steps.push(step);
    for (const traceId of step.provenance.traceIds) {
      runtimeStepTraceIds.add(traceId);
    }
    for (const turnId of step.provenance.sourceTurnIds) {
      representedTurnIds.add(turnId);
    }
  }

  const termInputs = new Map<string, SessionProcedureStepV1["input"]>();
  for (const originalEvent of input.timelineEvents) {
    let event = originalEvent;
    if (event.kind === "active-question-term-correction") {
      const id = readString(event.metadata?.manualTermCorrectionId);
      if (id) termInputs.set(id, buildTermCorrectionStep(event).input);
    } else if (event.kind === "speech-correction-deactivation") {
      const id = readString(event.metadata?.correctionId);
      const priorInput = id ? termInputs.get(id) : undefined;
      event = { ...event, metadata: { ...event.metadata,
        sourceTerm: priorInput?.sourceTerm, replacementTerm: priorInput?.replacementTerm } };
    }
    const specializedIdentity = timelineSpecializedIdentity(event);
    if (specializedIdentity && ledgerTypeCorrectionIds.has(specializedIdentity)) continue;
    if (
      specializedIdentity &&
      representedSpecializedEventIds.has(specializedIdentity)
    ) {
      continue;
    }
    const step = buildTimelineStep({
      event,
      turnsById,
      manualActionsById,
      ingressTraceIdsByTurnId,
      traceSummariesById,
      traceSummaryProjectionEnabled,
      projections: input.humanEvaluationProjections,
    });
    if (!step) continue;
    if (
      step.kind === "them-text" &&
      step.provenance.traceIds.some((traceId) =>
        runtimeStepTraceIds.has(traceId)
      )
    ) {
      for (const turnId of step.provenance.sourceTurnIds) {
        representedTurnIds.add(turnId);
      }
      continue;
    }
    if (specializedIdentity) {
      representedSpecializedEventIds.add(specializedIdentity);
    }
    for (const turnId of step.provenance.sourceTurnIds) {
      representedTurnIds.add(turnId);
    }
    if (step.provenance.actionId) {
      representedActionIds.add(step.provenance.actionId);
    }
    steps.push(step);
  }

  for (const turn of input.transcriptTurns) {
    if (representedTurnIds.has(turn.id) || !turn.text.trim()) continue;
    steps.push(
      attachExpectedContract(
        buildTranscriptStep(
          {
            id: `unindexed-turn:${turn.id}`,
            kind: "transcript-turn",
            createdAt: turn.startedAt,
            metadata: { turnId: turn.id },
          },
          turn
        ),
        input.humanEvaluationProjections
      )
    );
  }

  for (const [actionId, events] of manualActionsById) {
    if (representedActionIds.has(actionId)) continue;
    const requested = events.find((event) => event.stage === "requested");
    if (!requested) continue;
    steps.push(
      attachExpectedContract(
        attachRuntimeTraceSummary(buildManualActionStep(
          {
            id: `unindexed-action:${actionId}`,
            kind: "manual-runtime-action",
            createdAt: requested.occurredAt,
            metadata: { actionId },
          },
          events
        ), traceSummariesById, { enabled: traceSummaryProjectionEnabled }),
        input.humanEvaluationProjections
      )
    );
  }

  steps.sort(
    (left, right) =>
      left.occurredAt - right.occurredAt ||
      left.provenance.timelineEventId.localeCompare(
        right.provenance.timelineEventId
      )
  );
  let previousAt = steps[0]?.occurredAt;
  const numberedSteps = steps.map((step, index) => {
    const occurredAt = step.occurredAt;
    const result = {
      ...step,
      id: `step-${index + 1}`,
      ordinal: index + 1,
      delayAfterPreviousMs:
        previousAt === undefined ? 0 : Math.max(0, occurredAt - previousAt),
    };
    previousAt = occurredAt;
    return result;
  });
  const evidenceGaps = collectProcedureEvidenceGaps(
    input.recordingIntegrityStatus,
    numberedSteps
  );
  const reviewStatus = evidenceGaps.length
    ? "needs-review"
    : numberedSteps.some((step) => step.reviewStatus === "needs-human-labels")
      ? "needs-human-labels"
      : "ready";

  return {
    schemaVersion: SESSION_PROCEDURE_SCHEMA_VERSION,
    id: `session-procedure:${input.recordingSessionId}`,
    source: {
      recordingSessionId: input.recordingSessionId,
      folderName: input.folderName,
      sourceDigest: input.sourceDigest,
      scriptedValidation: true,
      forcedScripted: input.forcedScripted,
      recordingIntegrityStatus: input.recordingIntegrityStatus,
    },
    execution: { defaultBarrier: "typed-terminal" },
    generatedAt: input.generatedAt ?? Date.now(),
    reviewStatus,
    evidenceGaps,
    steps: numberedSteps,
  };
}

function buildRuntimeRegressionTextSteps(input: {
  events: RuntimeRegressionStepEventV1[];
  traceSummariesById: Map<string, SessionProcedureTraceSummary>;
  traceSummaryProjectionEnabled: boolean;
  projections: HumanEvaluationProjectionV2[];
  turnsById: Map<string, SessionProcedureTranscriptTurn>;
  ingressTurnIdsByTraceId: Map<string, string>;
}) {
  const eventsByStepId = new Map<string, RuntimeRegressionStepEventV1[]>();
  for (const event of input.events) {
    const events = eventsByStepId.get(event.scenarioStepId) ?? [];
    events.push(event);
    eventsByStepId.set(event.scenarioStepId, events);
  }
  return Array.from(eventsByStepId.values())
    .map((events) => {
      const injected = events.find(
        (event) => event.event === "injected" && event.inputKind === "them-text"
      );
      if (!injected) return undefined;
      const terminal = events.find((event) => event.event === "terminal");
      const traceIds = uniqueStrings(
        events.map((event) => event.traceId).filter(isString)
      );
      const sourceTurnId = injected.traceId
        ? input.ingressTurnIdsByTraceId.get(injected.traceId)
        : undefined;
      const transcriptText = sourceTurnId
        ? input.turnsById.get(sourceTurnId)?.text.trim()
        : undefined;
      const text = injected.text?.trim() || transcriptText;
      const timelineEvent: SessionProcedureTimelineEvent = {
        id: `runtime-regression-step:${injected.scenarioRunId}:${injected.scenarioStepId}`,
        kind: "runtime-regression-step",
        createdAt: injected.occurredAt,
        traceId: injected.traceId,
      };
      let step = baseStep({
        event: timelineEvent,
        kind: "them-text",
        replaySupport: text ? "ready" : "capture-only",
        input: text ? { text } : {},
        traceIds,
        sourceTurnIds: sourceTurnId ? [sourceTurnId] : [],
        sourceTransport: "manual-text",
        observed: {
          traceIds,
          terminalDisposition: terminal?.terminalDisposition,
          terminalReason: terminal?.reason,
          logicalQuestionUnitId: terminal?.logicalQuestionUnitId,
          taskId: undefined,
          visibleAnswerRevision: terminal?.visibleAnswerRevision,
        },
        evidenceGaps: [
          ...(text ? [] : ["runtime-regression-input-text-missing"]),
          ...(terminal ? [] : ["runtime-regression-terminal-missing"]),
        ],
      });
      step = attachRuntimeTraceSummary(step, input.traceSummariesById, {
        enabled: input.traceSummaryProjectionEnabled,
      });
      if (step.observed?.primarySourceTurnIds?.length) {
        step = {
          ...step,
          provenance: {
            ...step.provenance,
            sourceTurnIds: [...step.observed.primarySourceTurnIds],
          },
        };
      }
      return attachExpectedContract(step, input.projections);
    })
    .filter((step): step is SessionProcedureStepV1 => Boolean(step));
}

function buildTimelineStep(input: {
  event: SessionProcedureTimelineEvent;
  turnsById: Map<string, SessionProcedureTranscriptTurn>;
  manualActionsById: Map<string, ManualRuntimeActionEventV1[]>;
  ingressTraceIdsByTurnId: Map<string, string[]>;
  traceSummariesById: Map<string, SessionProcedureTraceSummary>;
  traceSummaryProjectionEnabled: boolean;
  projections: HumanEvaluationProjectionV2[];
}) {
  const metadata = input.event.metadata ?? {};
  let step: SessionProcedureStepV1 | undefined;
  if (input.event.kind === "transcript-turn") {
    const turnId = readString(metadata.turnId);
    const turn = turnId ? input.turnsById.get(turnId) : undefined;
    if (turn?.text.trim()) {
      step = buildTranscriptStep(
        input.event,
        turn,
        input.ingressTraceIdsByTurnId.get(turn.id) ?? []
      );
    }
  } else if (input.event.kind === "screen-capture") {
    step = buildScreenStep(input.event);
  } else if (input.event.kind === "manual-question-type-correction") {
    step = buildTypeCorrectionStep(input.event);
  } else if (input.event.kind === "active-question-term-correction") {
    step = buildTermCorrectionStep(input.event);
  } else if (input.event.kind === "speech-correction-deactivation") {
    step = buildTermCorrectionDeactivationStep(input.event);
  } else if (input.event.kind === "manual-runtime-action") {
    const actionId = readString(metadata.actionId);
    const stage = readString(metadata.stage);
    if (actionId && stage === "requested") {
      const events = input.manualActionsById.get(actionId) ?? [];
      step = buildManualActionStep(input.event, events);
    }
  }
  const observedStep = step
    ? attachRuntimeTraceSummary(step, input.traceSummariesById, {
        enabled: input.traceSummaryProjectionEnabled,
      })
    : undefined;
  return observedStep
    ? attachExpectedContract(observedStep, input.projections)
    : undefined;
}

function buildTranscriptStep(
  event: SessionProcedureTimelineEvent,
  turn: SessionProcedureTranscriptTurn,
  traceIds: string[] = []
): SessionProcedureStepV1 {
  const kind = turn.speaker === "me" ? "me-text" : "them-text";
  return baseStep({
    event,
    kind,
    replaySupport: kind === "them-text" ? "ready" : "capture-only",
    input: {
      text: turn.text,
    },
    traceIds,
    sourceTurnIds: [turn.id],
    sourceTransport: turn.source,
  });
}

function buildScreenStep(
  event: SessionProcedureTimelineEvent
): SessionProcedureStepV1 {
  const observationId = readString(event.metadata?.observationId);
  return baseStep({
    event,
    kind: "screen-input",
    replaySupport: "capture-only",
    input: {
      artifactRefs: [...(event.artifactRefs ?? [])],
      screen: event.screenInput,
    },
    sourceObservationIds: observationId ? [observationId] : [],
    evidenceGaps: uniqueStrings([
      ...(event.evidenceGaps ?? []),
      ...(event.screenInput ? [] : ["screen-primary-image-unresolved"]),
    ]),
  });
}

function buildTypeCorrectionStep(
  event: SessionProcedureTimelineEvent
): SessionProcedureStepV1 {
  const metadata = event.metadata ?? {};
  const correctionIntent = readManualCorrectionIntent(metadata.manualCorrectionIntent ?? metadata.correctionIntent);
  return baseStep({
    event,
    kind: "type-correction",
    replaySupport: "capture-only",
    input: {
      correctedType: readString(metadata.correctedQuestionType),
      ...(correctionIntent ? { correctionIntent } : {}),
    },
    actionId: readString(metadata.manualQuestionTypeCorrectionId),
    traceIds: readStringArray([
      metadata.correctionTraceId,
      metadata.regenerationTraceId,
      metadata.questionOriginTraceId,
    ]),
    sourceTurnIds: readStringArray(metadata.sourceTurnIds),
  });
}

function buildTermCorrectionStep(
  event: SessionProcedureTimelineEvent
): SessionProcedureStepV1 {
  const metadata = event.metadata ?? {};
  const traceIds = readStringArray([
    metadata.correctionTraceId,
    metadata.regenerationTraceId,
  ]);
  return baseStep({
    event,
    kind: "term-correction",
    replaySupport: "capture-only",
    input: {
      correctionText: readString(metadata.manualTermCorrectionRawText),
      sourceTerm: readString(metadata.manualTermCorrectionSourceTerm),
      replacementTerm: readString(
        metadata.manualTermCorrectionNormalizedTerm
      ),
    },
    actionId: readString(metadata.manualTermCorrectionId),
    traceIds,
    sourceTurnIds: readStringArray(metadata.sourceTurnIds),
    observed: {
      traceIds,
      correctionDisposition: readString(
        metadata.manualTermCorrectionDisposition
      ),
    },
  });
}

function buildTermCorrectionDeactivationStep(
  event: SessionProcedureTimelineEvent
): SessionProcedureStepV1 {
  const metadata = event.metadata ?? {};
  const traceIds = uniqueStrings(
    readStringArray([event.traceId, metadata.traceId])
  );
  return baseStep({
    event,
    kind: "term-correction-deactivation",
    replaySupport: "capture-only",
    input: { sourceTerm: readString(metadata.sourceTerm), replacementTerm: readString(metadata.replacementTerm) },
    evidenceGaps: readString(metadata.replacementTerm) ? [] : ["term-deactivation-input-missing"],
    actionId: readString(metadata.correctionId),
    traceIds,
    observed: {
      traceIds,
      correctionDisposition: readString(metadata.outcome),
    },
  });
}

function buildManualActionStep(
  event: SessionProcedureTimelineEvent,
  events: ManualRuntimeActionEventV1[]
): SessionProcedureStepV1 {
  const requested = events.find((candidate) => candidate.stage === "requested");
  const accepted = events.find((candidate) => candidate.stage === "accepted");
  const terminal = [...events]
    .reverse()
    .find((candidate) => candidate.stage === "terminal");
  const source = requested ?? accepted ?? terminal;
  if (!source) {
    return baseStep({
      event,
      kind: "regenerate",
      replaySupport: "capture-only",
      input: {},
      evidenceGaps: ["manual-action-ledger-event-missing"],
    });
  }
  const traceIds = uniqueStrings(
    events.map((candidate) => candidate.traceId).filter(isString)
  );
  const correctionIntent = readManualCorrectionIntent(requested?.correctionIntent ?? source.correctionIntent);
  return baseStep({
    event,
    kind: source.action,
    replaySupport: "capture-only",
    input: source.action === "type-correction" ? {
      correctedType: requested?.correctedType ?? source.correctedType,
      ...(correctionIntent ? { correctionIntent } : {}),
    } : {},
    actionId: source.actionId,
    specializedEventId: events
      .map((candidate) => candidate.specializedEventId)
      .find(isString),
    traceIds,
    observed: {
      traceIds,
      terminalDisposition: terminal?.terminalDisposition,
      terminalReason: terminal?.reason,
      logicalQuestionUnitId:
        terminal?.observedLogicalQuestionUnitId ??
        accepted?.observedLogicalQuestionUnitId,
      logicalQuestionUnitRevision:
        terminal?.observedLogicalQuestionUnitRevision ??
        accepted?.observedLogicalQuestionUnitRevision,
      taskId: terminal?.observedTaskId ?? accepted?.observedTaskId,
      visibleAnswerRevision:
        terminal?.observedVisibleAnswerRevision ??
        accepted?.observedVisibleAnswerRevision,
      ingressSource: requested?.ingressSource,
      ingressReceivedAt: requested?.ingressReceivedAt,
    },
    evidenceGaps: terminal ? [] : ["manual-action-terminal-missing"],
  });
}

function baseStep(input: {
  event: SessionProcedureTimelineEvent;
  kind: SessionProcedureStepKind;
  replaySupport: SessionProcedureReplaySupport;
  input: SessionProcedureStepV1["input"];
  actionId?: string;
  specializedEventId?: string;
  traceIds?: string[];
  sourceTurnIds?: string[];
  sourceObservationIds?: string[];
  sourceTransport?: string;
  observed?: SessionProcedureStepV1["observed"];
  evidenceGaps?: string[];
}): SessionProcedureStepV1 {
  const traceIds = uniqueStrings([
    ...(input.traceIds ?? []),
    ...(input.event.traceId ? [input.event.traceId] : []),
  ]);
  const evidenceGaps = input.evidenceGaps ?? [];
  return {
    id: "unassigned",
    ordinal: 0,
    kind: input.kind,
    occurredAt: input.event.createdAt,
    delayAfterPreviousMs: 0,
    replaySupport: input.replaySupport,
    input: input.input,
    observed: input.observed,
    expectedEvidenceRefs: [],
    reviewStatus: evidenceGaps.length ? "needs-review" : "needs-human-labels",
    evidenceGaps,
    provenance: {
      timelineEventId: input.event.id,
      traceIds,
      sourceTurnIds: input.sourceTurnIds ?? [],
      sourceObservationIds: input.sourceObservationIds,
      sourceTransport: input.sourceTransport,
      actionId: input.actionId,
      specializedEventId: input.specializedEventId,
    },
  };
}

function attachRuntimeTraceSummary(
  step: SessionProcedureStepV1,
  summariesById: Map<string, SessionProcedureTraceSummary>,
  options: { enabled: boolean }
): SessionProcedureStepV1 {
  if (options.enabled && step.kind === "type-correction" && step.input.correctionIntent) {
    return attachManualCorrectionTraceSummary(step, summariesById);
  }
  if (
    !options.enabled ||
    (step.kind !== "them-text" && step.kind !== "screen-input") ||
    step.provenance.traceIds.length === 0
  ) {
    return step;
  }
  const summaries = step.provenance.traceIds
    .map((traceId) => summariesById.get(traceId))
    .filter(
      (summary): summary is SessionProcedureTraceSummary => Boolean(summary)
    );
  if (summaries.length !== 1) {
    const evidenceGaps = uniqueStrings([
      ...step.evidenceGaps,
      summaries.length === 0
        ? "runtime-trace-summary-missing"
        : "ambiguous-runtime-trace-summary-join",
    ]);
    return {
      ...step,
      evidenceGaps,
      reviewStatus: "needs-review",
    };
  }

  const summary = summaries[0];
  const settlement = readRecord(summary.currentQuestionSettlement);
  const plan = readRecord(summary.settledExecutionPlan);
  const taskBoundary = readRecord(summary.taskBoundary);
  const taskMutationCommand = readString(plan?.taskMutationCommand);
  const taskMutationCommittedBeforeAdvisor = readBoolean(
    plan?.taskMutationCommittedBeforeAdvisor
  );
  return {
    ...step,
    observed: removeUndefined({
      ...step.observed,
      traceIds: uniqueStrings([
        ...(step.observed?.traceIds ?? []),
        summary.traceId,
      ]),
      logicalQuestionUnitId:
        readString(summary.logicalQuestionUnitId) ??
        readString(settlement?.logicalQuestionUnitId) ??
        step.observed?.logicalQuestionUnitId,
      logicalQuestionUnitRevision:
        readNumber(summary.logicalQuestionUnitRevision) ??
        readNumber(settlement?.logicalQuestionUnitRevision) ??
        step.observed?.logicalQuestionUnitRevision,
      primarySourceTurnIds: readStringArray(
        summary.primaryAskSourceTurnIds ??
          summary.logicalQuestionSourceTurnIds
      ),
      currentQuestionContextSourceTurnIds: readStringArray(
        summary.logicalQuestionContextSourceTurnIds
      ),
      recentLogicalQuestionSourceTurnIds: readStringArray(
        summary.logicalQuestionRecentLogicalQuestionSourceTurnIds
      ),
      advisorContextSourceTurnIds: readStringArray(
        summary.settledAdvisorContextSourceTurnIds
      ),
      responseOpportunityDecision: readString(
        summary.responseOpportunityDecision
      ),
      responseOpportunityDisposition: readString(
        summary.responseOpportunityDisposition
      ),
      questionType:
        readString(settlement?.questionType) ??
        readString(summary.questionType),
      relation:
        readString(settlement?.relation) ??
        readString(summary.taskRelation),
      contextReadScope:
        readString(plan?.contextReadScope) ??
        readString(settlement?.contextReadScope),
      settlementDisposition: readString(settlement?.disposition),
      taskMutationCommand,
      taskMutationDisposition:
        taskMutationCommand && taskMutationCommittedBeforeAdvisor
          ? "commit-before-advisor"
          : readString(taskBoundary?.mutationDisposition),
      requestedArtifacts: readStringArray(summary.requestedArtifacts),
      stableAnswerCommitDisposition: readString(
        summary.stableAnswerCommitDisposition
      ),
      staleCommitRejected: readBoolean(summary.staleCommitRejected),
      visibleCommitted: readBoolean(summary.advisorOutputCommittedToUi),
      taskId:
        readString(summary.activeMeetingTaskId) ?? step.observed?.taskId,
      visibleAnswerRevision:
        readNumber(summary.visibleAnswerRevisionAfter) ??
        step.observed?.visibleAnswerRevision,
      terminalDisposition: step.observed?.terminalDisposition,
      terminalReason: step.observed?.terminalReason,
      correctionDisposition: step.observed?.correctionDisposition,
      ingressSource: step.observed?.ingressSource,
      ingressReceivedAt: step.observed?.ingressReceivedAt,
    }),
  };
}

function attachManualCorrectionTraceSummary(
  step: SessionProcedureStepV1,
  summariesById: Map<string, SessionProcedureTraceSummary>
): SessionProcedureStepV1 {
  const candidates = step.provenance.traceIds.flatMap(traceId => {
    const summary = summariesById.get(traceId);
    const evidence = readCommittedManualCorrectionEvidence(summary?.manualCorrectionEvidence);
    return evidence && summary ? [{ summary, evidence }] : [];
  });
  const first = candidates[0];
  const conflicting = candidates.some(candidate => JSON.stringify(candidate.evidence) !== JSON.stringify(first?.evidence));
  const sourceMismatch = first && step.observed?.logicalQuestionUnitId &&
    first.evidence.sourceLogicalQuestionUnitId !== step.observed.logicalQuestionUnitId;
  if (!first || conflicting || sourceMismatch) {
    const missingSuccessfulCommit = !first && step.observed?.terminalDisposition === "completed";
    const gap = conflicting || sourceMismatch ? "ambiguous-manual-correction-commit-evidence"
      : missingSuccessfulCommit ? "manual-correction-commit-evidence-missing" : undefined;
    return gap ? { ...step, evidenceGaps: uniqueStrings([...step.evidenceGaps, gap]), reviewStatus: "needs-review" } : step;
  }
  const evidence = first.evidence;
  return { ...step, observed: {
    ...step.observed,
    traceIds: uniqueStrings([...(step.observed?.traceIds ?? []), ...candidates.map(candidate => candidate.summary.traceId)]),
    logicalQuestionUnitId: evidence.sourceLogicalQuestionUnitId,
    relation: evidence.relation, parentAction: evidence.action,
    settledParentId: evidence.parentAfterId, settledChildId: evidence.childAfterId,
    taskId: evidence.parentAfterId, taskMutationCommand: evidence.command,
    taskMutationDisposition: "commit-before-advisor", manualCorrectionEvidence: evidence,
  } };
}

function attachExpectedContract(
  step: SessionProcedureStepV1,
  projections: HumanEvaluationProjectionV2[]
): SessionProcedureStepV1 {
  const match = selectExpectedProjectionMatches(projections, step);
  const matched = match.projections;
  const events = matched.flatMap((projection) =>
    Object.values(projection.activeFacts).filter(
      (event): event is HumanGroundTruthEventV2 =>
        Boolean(event) && humanExpectedEventIsEligible(event!)
    )
  );
  const uniqueEvents = Array.from(
    new Map(events.map((event) => [event.eventId, event])).values()
  );
  const expectedResolution = resolveExpectedContract(uniqueEvents);
  const expected = expectedResolution.expected;
  const evidenceRefs = uniqueEvents.map((event) => ({
    eventId: event.eventId,
    factKind: event.fact.kind,
  }));
  const evidenceGaps = uniqueStrings([
    ...step.evidenceGaps,
    ...match.evidenceGaps,
    ...expectedResolution.evidenceGaps,
  ]);
  return {
    ...step,
    expected: Object.keys(expected).length ? expected : undefined,
    expectedEvidenceRefs: evidenceRefs,
    evidenceGaps,
    reviewStatus: evidenceGaps.length
      ? "needs-review"
      : evidenceRefs.length
        ? "ready"
        : step.kind === "me-text"
          ? "ready"
          : "needs-human-labels",
  };
}

function selectExpectedProjectionMatches(
  projections: HumanEvaluationProjectionV2[],
  step: SessionProcedureStepV1
) {
  const actionMatches = projections.filter((projection) =>
    projectionMatchesAction(projection, step)
  );
  if (actionMatches.length) {
    return { projections: actionMatches, evidenceGaps: [] as string[] };
  }
  if (step.provenance.traceIds.length) {
    const exactAttemptMatches = projections.filter(
      (projection) =>
        projection.subject.attemptId &&
        step.provenance.traceIds.includes(
          projection.subject.attemptId
        )
    );
    if (exactAttemptMatches.length) {
      return {
        projections: exactAttemptMatches,
        evidenceGaps: [] as string[],
      };
    }
    return {
      projections: projections.filter((projection) =>
        projection.subject.traceIds.some((id) =>
          step.provenance.traceIds.includes(id)
        )
      ),
      evidenceGaps: [] as string[],
    };
  }
  const sourceMatches = projections.filter((projection) =>
    projection.subject.sourceTurnIds.some((id) =>
      step.provenance.sourceTurnIds.includes(id)
    )
  );
  const identities = uniqueStrings(
    sourceMatches.map(expectedProjectionIdentity)
  );
  if (identities.length > 1) {
    return {
      projections: [] as HumanEvaluationProjectionV2[],
      evidenceGaps: ["ambiguous-source-turn-evaluation-join"],
    };
  }
  return { projections: sourceMatches, evidenceGaps: [] as string[] };
}

function projectionMatchesAction(
  projection: HumanEvaluationProjectionV2,
  step: SessionProcedureStepV1
) {
  if (
    step.provenance.actionId &&
    Object.values(projection.activeFacts).some(
      (event) => event?.provenance.actionId === step.provenance.actionId
    )
  ) {
    return true;
  }
  if (
    step.provenance.specializedEventId &&
    Object.values(projection.activeFacts).some(
      (event) =>
        event?.provenance.actionId === step.provenance.specializedEventId
    )
  ) {
    return true;
  }
  return false;
}

function expectedProjectionIdentity(
  projection: HumanEvaluationProjectionV2
) {
  if (projection.subject.attemptId) {
    return `attempt:${projection.subject.attemptId}`;
  }
  if (projection.subject.traceIds.length) {
    return `traces:${[...projection.subject.traceIds].sort().join(",")}`;
  }
  if (projection.subject.questionId) {
    return `question:${projection.subject.questionId}`;
  }
  return `projection:${projection.projectionId}`;
}

function humanExpectedEventIsEligible(event: HumanGroundTruthEventV2) {
  return (
    event.confirmation === "confirmed" &&
    (event.provenance.source === "explicit-ui" ||
      event.provenance.source === "imported-legacy")
  );
}

function resolveExpectedContract(events: HumanGroundTruthEventV2[]) {
  const candidates = new Map<
    keyof SessionProcedureExpectedContract,
    Array<{ value: string | boolean; eventId: string }>
  >();
  const add = (
    dimension: keyof SessionProcedureExpectedContract,
    value: string | boolean | undefined,
    eventId: string
  ) => {
    if (value === undefined) return;
    const existing = candidates.get(dimension) ?? [];
    existing.push({ value, eventId });
    candidates.set(dimension, existing);
  };
  for (const event of events) {
    const fact = event.fact;
    if (fact.kind === "expected-task-settlement") {
      add("questionType", fact.expectedQuestionType, event.eventId);
      add("relation", fact.expectedRelation, event.eventId);
      add("parentAction", fact.expectedParentAction, event.eventId);
      add("expectedParentId", fact.expectedParentId, event.eventId);
      add("expectedBranchId", fact.expectedBranchId, event.eventId);
      add(
        "expectedContextOwnerId",
        fact.expectedContextOwnerId,
        event.eventId
      );
    } else if (fact.kind === "expected-question-type") {
      add("questionType", fact.expectedQuestionType, event.eventId);
    } else if (fact.kind === "expected-runtime-action") {
      add("runtimeAction", fact.expectedAction, event.eventId);
    } else if (fact.kind === "expected-context-read-scope") {
      add("contextReadScope", fact.expectedScope, event.eventId);
    } else if (fact.kind === "expected-artifact-intent") {
      add("artifactIntent", fact.expectedIntent, event.eventId);
    } else if (fact.kind === "answer-quality") {
      add("answerOutcome", fact.outcome, event.eventId);
    } else if (fact.kind === "expected-project-trajectory") {
      add("expectedProjectId", fact.expectedProjectId, event.eventId);
      add("expectedProjectName", fact.expectedProjectName, event.eventId);
      add("playbookPhase", fact.expectedPhase, event.eventId);
      add("factAnchorState", fact.expectedFactAnchorState, event.eventId);
      add("childContinuity", fact.expectedChildContinuity, event.eventId);
      add(
        "unsupportedFirstPersonClaim",
        fact.unsupportedFirstPersonClaim,
        event.eventId
      );
    }
  }
  const expected: SessionProcedureExpectedContract = {};
  const evidenceGaps: string[] = [];
  for (const [dimension, values] of candidates) {
    const uniqueValues = Array.from(
      new Set(values.map((candidate) => JSON.stringify(candidate.value)))
    );
    if (uniqueValues.length > 1) {
      evidenceGaps.push(`conflicting-expected-evidence:${dimension}`);
      continue;
    }
    const value = values[0]?.value;
    if (value !== undefined) {
      Object.assign(expected, { [dimension]: value });
    }
  }
  return {
    expected: removeUndefined(expected),
    evidenceGaps: evidenceGaps.sort(),
  };
}

function collectProcedureEvidenceGaps(
  recordingIntegrityStatus: string | undefined,
  steps: SessionProcedureStepV1[]
) {
  const gaps = new Set<string>();
  if (recordingIntegrityStatus !== "complete") {
    gaps.add("recording-integrity-incomplete");
  }
  if (!steps.length) gaps.add("procedure-has-no-input-steps");
  for (const step of steps) {
    for (const gap of step.evidenceGaps) gaps.add(gap);
  }
  return Array.from(gaps).sort();
}

function groupManualActions(events: ManualRuntimeActionEventV1[]) {
  const grouped = new Map<string, ManualRuntimeActionEventV1[]>();
  for (const event of events) {
    const existing = grouped.get(event.actionId) ?? [];
    existing.push(event);
    existing.sort((left, right) => left.occurredAt - right.occurredAt);
    grouped.set(event.actionId, existing);
  }
  return grouped;
}

function collectIngressTraceIdsByTurnId(
  events: SessionProcedureTimelineEvent[]
) {
  const result = new Map<string, string[]>();
  for (const event of events) {
    if (event.kind !== "capture-lifecycle") continue;
    const metadata = event.metadata ?? {};
    if (metadata.stage !== "canonical-turn-ingress-admitted") continue;
    const turnId = readString(metadata.canonicalTurnIngressTurnId);
    const traceId = event.traceId ?? readString(metadata.traceId);
    if (!turnId || !traceId) continue;
    result.set(turnId, uniqueStrings([...(result.get(turnId) ?? []), traceId]));
  }
  return result;
}

function timelineSpecializedIdentity(event: SessionProcedureTimelineEvent) {
  const metadata = event.metadata ?? {};
  if (event.kind === "manual-question-type-correction") {
    const id = readString(metadata.manualQuestionTypeCorrectionId);
    return id ? `type:${id}` : undefined;
  }
  if (event.kind === "active-question-term-correction") {
    const id = readString(metadata.manualTermCorrectionId);
    return id ? `term:${id}` : undefined;
  }
  if (event.kind === "speech-correction-deactivation") {
    const id = readString(metadata.correctionId);
    return id ? `term-deactivation:${id}:${readString(metadata.outcome) ?? "unknown"}` : undefined;
  }
  return undefined;
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values));
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter(isString);
  if (isString(value)) return [value];
  return [];
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value);
}

function removeUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([, candidate]) => candidate !== undefined
    )
  ) as T;
}
