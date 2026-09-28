
import type {
  AdvisorSuggestion,
  HumanEvalQuestionType,
  HumanEvaluationVerdict,
  HumanEvaluationVerdictBlock,
  MemoryEntryEvaluationLabel,
  MissingExpectedMemoryLabel,
  MeetingTrace,
  MeetingTraceKind,
  QuestionHumanEvaluation,
  TraceHumanEvaluation,
  QuestionInstanceLineage,
  HumanEvaluationTaskRelation,
  PersonalStatusDomain,
} from "./types";
import { normalizeMemoryRetrievalEvaluationSnapshot } from "./memory-evaluation.js";
import {
  resolveHumanEvaluationAttemptIdentityV2,
  resolveHumanEvaluationAttemptRevisionV2,
} from "./human-evaluation-attempt.js";
import {
  buildHumanGroundTruthSubjectV2,
  type HumanGroundTruthEvaluationTargetV2,
} from "./human-ground-truth-v2.js";
import type { AdviseDisplayTarget } from "./manual-advise-display.js";
import { projectObservedAdvisorAttempt } from "./observed-advisor-outcome.js";
import {
  fromHumanEvalQuestionType,
  normalizeCanonicalQuestionType,
  normalizeQuestionTypeAlias,
  toHumanEvalQuestionType,
} from "./task-taxonomy.js";

const MAX_HUMAN_EVALUATIONS = 500;
const MAX_QUESTION_HUMAN_EVALUATIONS = 500;

const DEFAULT_VERDICT_BLOCK: HumanEvaluationVerdictBlock = {
  verdict: "not_applicable",
  reasons: [],
};

export interface QuestionEvaluationIdentity {
  sessionId?: string;
  questionId?: string;
  traceId: string;
  traceKind: MeetingTraceKind;
  taskId?: string;
  parentTaskId?: string;
  childTaskId?: string;
  taskSource?: "screen" | "voice" | "mixed";
  questionType?: HumanEvalQuestionType;
  company?: string;
  relation?: string;
  playbookId?: string;
  playbookPhase?: string;
  phaseOwnerKind?: "parent" | "child";
  phaseOwnerId?: string;
  phaseOwnerRevision?: number;
  whiteboardArtifactId?: string;
  whiteboardArtifactRevision?: number;
  whiteboardArtifactDomainTrack?: string;
  whiteboardRender?: QuestionHumanEvaluation["whiteboardRender"];
  projectTrajectory?: QuestionHumanEvaluation["projectTrajectory"];
  manualPhaseFrom?: string;
  manualPhaseTo?: string;
  manualPhaseTargetArtifact?: string;
  manualPhaseGuardStatus?: string;
  selectedDiagramOverlayIds?: string[];
  rejectedDiagramOverlayCount?: number;
  memoryRetrievalSnapshot?: QuestionHumanEvaluation["memoryRetrievalSnapshot"];
}

export type VisibleAnswerEvaluationTargetStatus =
  | "ready"
  | "trace-only"
  | "pending"
  | "unavailable"
  | "none";

export interface VisibleAnswerEvaluationTarget {
  status: VisibleAnswerEvaluationTargetStatus;
  traceId?: string;
  reason:
    | "visible-answer-source"
    | "latest-settled-attempt"
    | "settled-attempt-in-progress"
    | "latest-trace-without-suggestion"
    | "partial-answer-in-progress"
    | "suggestion-source-trace-missing"
    | "suggestion-source-id-missing"
    | "no-evaluation-target";
}

export interface CurrentQuestionEvaluationIdentity {
  sessionId: string;
  logicalQuestionUnitId: string;
  logicalQuestionRevision: number;
}

export interface HumanEvaluationSelectionSnapshot {
  currentSessionId?: string;
  currentQuestion?: CurrentQuestionEvaluationIdentity;
  locked: boolean;
  displayTarget: AdviseDisplayTarget;
  target: VisibleAnswerEvaluationTarget;
  attempt?: {
    attemptId: string;
    sessionId: string;
    logicalQuestionUnitId: string;
    logicalQuestionRevision?: number;
    status: MeetingTrace["status"];
  };
}

export function buildHumanEvaluationSelectionSnapshot(input: {
  target: VisibleAnswerEvaluationTarget;
  currentSessionId?: string;
  currentQuestion?: CurrentQuestionEvaluationIdentity;
  locked: boolean;
  displayTarget: AdviseDisplayTarget;
  trace?: MeetingTrace;
}): HumanEvaluationSelectionSnapshot {
  const { currentQuestion, displayTarget, target } = input;
  const trace = input.trace?.id === target.traceId ? input.trace : undefined;
  const identity = trace && resolveHumanEvaluationAttemptIdentityV2(trace);
  // Whitelist identity fields so token/text updates cannot change the observation.
  return {
    currentSessionId: input.currentSessionId,
    currentQuestion: currentQuestion && {
      sessionId: currentQuestion.sessionId,
      logicalQuestionUnitId: currentQuestion.logicalQuestionUnitId,
      logicalQuestionRevision: currentQuestion.logicalQuestionRevision,
    },
    locked: input.locked,
    displayTarget: {
      sessionId: displayTarget.sessionId,
      logicalQuestionUnitId: displayTarget.logicalQuestionUnitId,
      logicalQuestionRevision: displayTarget.logicalQuestionRevision,
      suggestionId: displayTarget.suggestionId,
      traceId: displayTarget.traceId,
      generationId: displayTarget.generationId,
      stableRevision: displayTarget.stableRevision,
    },
    target: {
      status: target.status,
      reason: target.reason,
      traceId: target.traceId,
    },
    attempt: identity && trace ? {
      attemptId: identity.attemptId,
      sessionId: identity.sessionId,
      logicalQuestionUnitId: identity.logicalQuestionUnitId,
      logicalQuestionRevision: resolveHumanEvaluationAttemptRevisionV2(trace),
      status: trace.status,
    } : undefined,
  };
}

export function captureHumanGroundTruthEvaluationTarget(input: {
  trace: MeetingTrace;
  evaluation?: QuestionHumanEvaluation;
  frozenAt: number;
}): HumanGroundTruthEvaluationTargetV2 {
  const subject = buildHumanGroundTruthSubjectV2(input);
  const identity = resolveHumanEvaluationAttemptIdentityV2(input.trace);
  return {
    attemptId: input.trace.id,
    questionId: subject.questionId,
    taskId: subject.taskId,
    logicalQuestionUnitId: identity?.logicalQuestionUnitId,
    logicalQuestionUnitRevision: resolveHumanEvaluationAttemptRevisionV2(input.trace),
    currentTurnId:
      readMetadataString(input.trace.metadata, "currentTurnId") ??
      readMetadataString(input.trace.metadata, "logicalQuestionCurrentTurnId"),
    sourceTurnIds: [...subject.sourceTurnIds],
    sourceTraceId: input.trace.id,
    frozenAt: input.frozenAt,
  };
}

export function findQuestionHumanEvaluationForTrace(
  evaluations: QuestionHumanEvaluation[],
  traceId: string
): QuestionHumanEvaluation | undefined {
  return evaluations.find(
    (evaluation) =>
      evaluation.traceIds.includes(traceId) ||
      evaluation.questionId === `trace:${traceId}`
  );
}

export function resolveSettledAttemptEvaluationTarget(input: {
  suggestion: AdvisorSuggestion | null | undefined;
  answerInProgress?: boolean;
  traces: MeetingTrace[];
  currentSessionId?: string;
  currentQuestion?: CurrentQuestionEvaluationIdentity;
  pinnedDisplay?: { suggestion: AdvisorSuggestion | null; streaming: boolean; traceId?: string };
}): VisibleAnswerEvaluationTarget {
  if (input.pinnedDisplay) {
    if (input.pinnedDisplay.streaming) return {
      status: "pending", traceId: input.pinnedDisplay.traceId,
      reason: "partial-answer-in-progress",
    };
    return resolveVisibleAnswerEvaluationTarget({
      suggestion: input.pinnedDisplay.suggestion,
      traces: input.traces,
    });
  }
  const current = input.currentQuestion;
  if (!current && !input.suggestion && !input.answerInProgress) {
    return { status: "none", reason: "no-evaluation-target" };
  }
  if (current && (
    !current.sessionId.trim() ||
    !current.logicalQuestionUnitId.trim() ||
    !Number.isSafeInteger(current.logicalQuestionRevision) ||
    current.logicalQuestionRevision < 0 ||
    (input.currentSessionId && current.sessionId !== input.currentSessionId)
  )) {
    return { status: "unavailable", reason: "no-evaluation-target" };
  }
  const attempt = current ? input.traces.find((trace) => {
    const identity = resolveHumanEvaluationAttemptIdentityV2(trace);
    return Boolean(
      identity &&
        identity.sessionId === current.sessionId &&
        identity.logicalQuestionUnitId === current.logicalQuestionUnitId &&
        resolveHumanEvaluationAttemptRevisionV2(trace) === current.logicalQuestionRevision
    );
  }) : undefined;
  if (!attempt) {
    return input.answerInProgress
      ? { status: "pending", reason: "partial-answer-in-progress" }
      : { status: "unavailable", reason: "no-evaluation-target" };
  }

  if (attempt.status === "running") {
    return {
      status: "pending",
      traceId: attempt.id,
      reason: "settled-attempt-in-progress",
    };
  }

  if (input.suggestion?.sourceTraceId === attempt.id) {
    return {
      status: "ready",
      traceId: attempt.id,
      reason: "visible-answer-source",
    };
  }

  return {
    status: "trace-only",
    traceId: attempt.id,
    reason: "latest-settled-attempt",
  };
}

export function resolveVisibleAnswerEvaluationTarget(input: {
  suggestion: AdvisorSuggestion | null | undefined;
  answerInProgress?: boolean;
  traces: Array<Pick<MeetingTrace, "id">>;
  latestTraceId?: string;
}): VisibleAnswerEvaluationTarget {
  if (input.answerInProgress) {
    return {
      status: "pending",
      reason: "partial-answer-in-progress",
    };
  }

  if (input.suggestion) {
    const sourceTraceId = input.suggestion.sourceTraceId;
    if (!sourceTraceId) {
      return {
        status: "unavailable",
        reason: "suggestion-source-id-missing",
      };
    }

    if (!input.traces.some((trace) => trace.id === sourceTraceId)) {
      return {
        status: "unavailable",
        traceId: sourceTraceId,
        reason: "suggestion-source-trace-missing",
      };
    }

    return {
      status: "ready",
      traceId: sourceTraceId,
      reason: "visible-answer-source",
    };
  }

  if (
    input.latestTraceId &&
    input.traces.some((trace) => trace.id === input.latestTraceId)
  ) {
    return {
      status: "trace-only",
      traceId: input.latestTraceId,
      reason: "latest-trace-without-suggestion",
    };
  }

  return {
    status: "none",
    reason: "no-evaluation-target",
  };
}

export function resolveSuggestionQuestionLineage(input: {
  suggestion: AdvisorSuggestion | null | undefined;
  traces: Array<Pick<MeetingTrace, "id" | "metadata">>;
}): QuestionInstanceLineage | undefined {
  const suggestion = input.suggestion;
  const sourceTraceId = suggestion?.sourceTraceId;
  if (!suggestion || !sourceTraceId) return undefined;

  if (suggestion.questionLineage) {
    return {
      ...suggestion.questionLineage,
      sourceSuggestionId: suggestion.id,
    };
  }

  const sourceTrace = input.traces.find((trace) => trace.id === sourceTraceId);
  const explicitQuestionId = readMetadataString(
    sourceTrace?.metadata,
    "questionInstanceId"
  );
  const explicitOriginTraceId = readMetadataString(
    sourceTrace?.metadata,
    "questionOriginTraceId"
  );

  return {
    questionInstanceId: explicitQuestionId ?? `trace:${sourceTraceId}`,
    questionOriginTraceId: explicitOriginTraceId ?? sourceTraceId,
    sourceSuggestionId: suggestion.id,
  };
}

function readMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string
) {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function upsertTraceHumanEvaluation(
  evaluations: TraceHumanEvaluation[],
  traceId: string,
  traceKind: MeetingTraceKind,
  patch: Partial<TraceHumanEvaluation>
) {
  const now = Date.now();
  const existingIndex = evaluations.findIndex(
    (evaluation) => evaluation.traceId === traceId
  );
  const existing =
    existingIndex >= 0 ? evaluations[existingIndex] : undefined;
  const next: TraceHumanEvaluation = {
    id: existing?.id ?? createHumanEvalId(),
    traceId,
    traceKind,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...existing,
    ...normalizeHumanEvaluationPatch(patch),
    failureReasons: patch.failureReasons ?? existing?.failureReasons ?? [],
  };

  if (existingIndex >= 0) {
    return [
      ...evaluations.slice(0, existingIndex),
      next,
      ...evaluations.slice(existingIndex + 1),
    ].slice(-MAX_HUMAN_EVALUATIONS);
  }

  return [...evaluations, next].slice(-MAX_HUMAN_EVALUATIONS);
}

export function upsertQuestionHumanEvaluation(
  evaluations: QuestionHumanEvaluation[],
  identity: QuestionEvaluationIdentity,
  patch: Partial<QuestionHumanEvaluation>
) {
  const now = Date.now();
  const explicitQuestionId = patch.questionId ?? identity.questionId;
  const legacyTraceMatch = explicitQuestionId
    ? undefined
    : evaluations.find((evaluation) =>
        evaluation.traceIds.includes(identity.traceId)
      );
  const questionId =
    explicitQuestionId ??
    legacyTraceMatch?.questionId ??
    resolveQuestionId(identity);
  const existingIndex = evaluations.findIndex(
    (evaluation) => evaluation.questionId === questionId
  );
  const existing =
    existingIndex >= 0 ? evaluations[existingIndex] : undefined;

  const next: QuestionHumanEvaluation = {
    id: existing?.id ?? createQuestionHumanEvalId(),
    sessionId: patch.sessionId ?? existing?.sessionId ?? identity.sessionId,
    questionId,
    taskId: patch.taskId ?? existing?.taskId ?? identity.taskId,
    parentTaskId:
      patch.parentTaskId ?? existing?.parentTaskId ?? identity.parentTaskId,
    childTaskId:
      patch.childTaskId ?? existing?.childTaskId ?? identity.childTaskId,
    taskSource:
      patch.taskSource ?? existing?.taskSource ?? identity.taskSource,
    traceIds: uniqueStrings([
      ...(existing?.traceIds ?? []),
      identity.traceId,
      ...(patch.traceIds ?? []),
    ]),
    questionType:
      normalizeHumanEvalQuestionType(patch.questionType) ??
      existing?.questionType ??
      normalizeHumanEvalQuestionType(identity.questionType),
    correctedQuestionType:
      normalizeHumanEvalQuestionType(patch.correctedQuestionType) ??
      existing?.correctedQuestionType,
    manualQuestionTypeCorrectionId:
      patch.manualQuestionTypeCorrectionId ??
      existing?.manualQuestionTypeCorrectionId,
    manualQuestionTypeCorrectionTraceId:
      patch.manualQuestionTypeCorrectionTraceId ??
      existing?.manualQuestionTypeCorrectionTraceId,
    manualQuestionTypeRegenerationTraceId:
      patch.manualQuestionTypeRegenerationTraceId ??
      existing?.manualQuestionTypeRegenerationTraceId,
    manualQuestionTypeCorrectionSource:
      patch.manualQuestionTypeCorrectionSource ??
      existing?.manualQuestionTypeCorrectionSource,
    manualQuestionTypeCorrectionScope:
      patch.manualQuestionTypeCorrectionScope ??
      existing?.manualQuestionTypeCorrectionScope,
    manualQuestionTypeCorrectionBoundaryReason:
      patch.manualQuestionTypeCorrectionBoundaryReason ??
      existing?.manualQuestionTypeCorrectionBoundaryReason,
    manualQuestionTypeCorrectionPreviousParentId:
      patch.manualQuestionTypeCorrectionPreviousParentId ??
      existing?.manualQuestionTypeCorrectionPreviousParentId,
    manualQuestionTypeCorrectionNextParentId:
      patch.manualQuestionTypeCorrectionNextParentId ??
      existing?.manualQuestionTypeCorrectionNextParentId,
    manualTermCorrectionId:
      patch.manualTermCorrectionId ?? existing?.manualTermCorrectionId,
    manualTermCorrectionTraceId:
      patch.manualTermCorrectionTraceId ??
      existing?.manualTermCorrectionTraceId,
    manualTermCorrectionRegenerationTraceId:
      patch.manualTermCorrectionRegenerationTraceId ??
      existing?.manualTermCorrectionRegenerationTraceId,
    manualTermCorrectionDisposition:
      patch.manualTermCorrectionDisposition ??
      existing?.manualTermCorrectionDisposition,
    manualTermCorrectionReason:
      patch.manualTermCorrectionReason ??
      existing?.manualTermCorrectionReason,
    transientPersonalStatus: mergeTransientPersonalStatusEvaluation(
      existing?.transientPersonalStatus,
      patch.transientPersonalStatus
    ),
    company: patch.company ?? existing?.company ?? identity.company,
    correctedCompany:
      patch.correctedCompany ?? existing?.correctedCompany,
    relation: patch.relation ?? existing?.relation ?? identity.relation,
    expectedRelation:
      normalizeInterviewTaskRelation(patch.expectedRelation) ??
      existing?.expectedRelation,
    expectedParentAction:
      normalizeExpectedParentAction(patch.expectedParentAction) ??
      existing?.expectedParentAction,
    expectedParentId:
      patch.expectedParentId ?? existing?.expectedParentId,
    expectedBranchId:
      patch.expectedBranchId ?? existing?.expectedBranchId,
    expectedContextOwnerId:
      patch.expectedContextOwnerId ?? existing?.expectedContextOwnerId,
    expectedContextTurnIds:
      patch.expectedContextTurnIds !== undefined
        ? uniqueStrings(patch.expectedContextTurnIds)
        : existing?.expectedContextTurnIds ?? [],
    correctedRelation:
      normalizeInterviewTaskRelation(patch.correctedRelation) ??
      normalizeInterviewTaskRelation(existing?.correctedRelation),
    primaryAskCorrect:
      patch.primaryAskCorrect ?? existing?.primaryAskCorrect,
    clarifyingOptionsVerdict:
      normalizeClarifyingOptionsVerdict(patch.clarifyingOptionsVerdict) ??
      existing?.clarifyingOptionsVerdict,
    playbookId:
      patch.playbookId ?? existing?.playbookId ?? identity.playbookId,
    detectedPlaybookPhase:
      patch.detectedPlaybookPhase ??
      existing?.detectedPlaybookPhase ??
      identity.playbookPhase,
    detectedPhaseOwnerKind:
      patch.detectedPhaseOwnerKind ??
      existing?.detectedPhaseOwnerKind ??
      identity.phaseOwnerKind,
    detectedPhaseOwnerId:
      patch.detectedPhaseOwnerId ??
      existing?.detectedPhaseOwnerId ??
      identity.phaseOwnerId,
    detectedPhaseOwnerRevision:
      patch.detectedPhaseOwnerRevision ??
      existing?.detectedPhaseOwnerRevision ??
      identity.phaseOwnerRevision,
    correctedPlaybookPhase:
      patch.correctedPlaybookPhase ?? existing?.correctedPlaybookPhase,
    detectedWhiteboardArtifactId:
      patch.detectedWhiteboardArtifactId ??
      existing?.detectedWhiteboardArtifactId ??
      identity.whiteboardArtifactId,
    detectedWhiteboardArtifactRevision:
      patch.detectedWhiteboardArtifactRevision ??
      existing?.detectedWhiteboardArtifactRevision ??
      identity.whiteboardArtifactRevision,
    detectedWhiteboardArtifactDomainTrack:
      patch.detectedWhiteboardArtifactDomainTrack ??
      existing?.detectedWhiteboardArtifactDomainTrack ??
      identity.whiteboardArtifactDomainTrack,
    detectedManualPhaseFrom:
      patch.detectedManualPhaseFrom ??
      existing?.detectedManualPhaseFrom ??
      identity.manualPhaseFrom,
    detectedManualPhaseTo:
      patch.detectedManualPhaseTo ??
      existing?.detectedManualPhaseTo ??
      identity.manualPhaseTo,
    detectedManualPhaseTargetArtifact:
      patch.detectedManualPhaseTargetArtifact ??
      existing?.detectedManualPhaseTargetArtifact ??
      identity.manualPhaseTargetArtifact,
    detectedManualPhaseGuardStatus:
      patch.detectedManualPhaseGuardStatus ??
      existing?.detectedManualPhaseGuardStatus ??
      identity.manualPhaseGuardStatus,
    selectedDiagramOverlayIds: uniqueStrings([
      ...(existing?.selectedDiagramOverlayIds ?? []),
      ...(identity.selectedDiagramOverlayIds ?? []),
      ...(patch.selectedDiagramOverlayIds ?? []),
    ]),
    rejectedDiagramOverlayCount:
      patch.rejectedDiagramOverlayCount ??
      existing?.rejectedDiagramOverlayCount ??
      identity.rejectedDiagramOverlayCount,
    classification: mergeVerdictBlock(
      existing?.classification,
      patch.classification
    ),
    playbook: mergeVerdictBlock(existing?.playbook, patch.playbook),
    playbookPhase: mergeVerdictBlock(
      existing?.playbookPhase,
      patch.playbookPhase
    ),
    memory: mergeVerdictBlock(existing?.memory, patch.memory),
    whiteboard: mergeVerdictBlock(existing?.whiteboard, patch.whiteboard),
    manualPhaseTransition: mergeVerdictBlock(
      existing?.manualPhaseTransition,
      patch.manualPhaseTransition
    ),
    diagramOverlay: mergeVerdictBlock(
      existing?.diagramOverlay,
      patch.diagramOverlay
    ),
    guardrail: mergeVerdictBlock(existing?.guardrail, patch.guardrail),
    answer: mergeVerdictBlock(existing?.answer, patch.answer),
    taxonomyAdjudication: mergeTaxonomyAdjudicationEvaluation(
      existing?.taxonomyAdjudication,
      patch.taxonomyAdjudication
    ),
    advisorIntent: mergeAdvisorIntentEvaluation(
      existing?.advisorIntent,
      patch.advisorIntent
    ),
    answerSufficiency: mergeAnswerSufficiencyEvaluation(
      existing?.answerSufficiency,
      patch.answerSufficiency
    ),
    currentQuestionSettlement: mergeCurrentQuestionSettlementEvaluation(
      existing?.currentQuestionSettlement,
      patch.currentQuestionSettlement
    ),
    whiteboardRender: mergeWhiteboardRenderEvaluation(
      existing?.whiteboardRender,
      identity.whiteboardRender || patch.whiteboardRender
        ? {
            ...identity.whiteboardRender,
            ...patch.whiteboardRender,
          }
        : undefined
    ),
    projectTrajectory: mergeProjectTrajectoryEvaluation(
      existing?.projectTrajectory,
      identity.projectTrajectory || patch.projectTrajectory
        ? {
            ...identity.projectTrajectory,
            ...patch.projectTrajectory,
          }
        : undefined
    ),
    memoryRetrievalSnapshot:
      normalizeMemoryRetrievalEvaluationSnapshot(
        patch.memoryRetrievalSnapshot
      ) ??
      existing?.memoryRetrievalSnapshot ??
      identity.memoryRetrievalSnapshot,
    memoryEntryLabels: mergeMemoryEntryLabels(
      existing?.memoryEntryLabels ?? [],
      patch.memoryEntryLabels ?? []
    ),
    missingExpectedMemory: mergeMissingExpectedMemory(
      existing?.missingExpectedMemory ?? [],
      patch.missingExpectedMemory ?? []
    ),
    notes: patch.notes ?? existing?.notes,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  if (existingIndex >= 0) {
    return [
      ...evaluations.slice(0, existingIndex),
      next,
      ...evaluations.slice(existingIndex + 1),
    ].slice(-MAX_QUESTION_HUMAN_EVALUATIONS);
  }

  return [...evaluations, next].slice(-MAX_QUESTION_HUMAN_EVALUATIONS);
}

export function buildQuestionEvaluationPatchFromTrace(
  evaluation: TraceHumanEvaluation
): Partial<QuestionHumanEvaluation> {
  const patch: Partial<QuestionHumanEvaluation> = {
    taskId: evaluation.taskId,
    parentTaskId: evaluation.parentTaskId,
    childTaskId: evaluation.childTaskId,
    taskSource: evaluation.taskSource,
    questionType: normalizeToHumanEvalQuestionType(evaluation.questionType),
    correctedQuestionType: evaluation.correctedQuestionType,
    correctedCompany: evaluation.correctedCompany,
    classification: buildClassificationVerdict(evaluation),
    playbook: buildPlaybookVerdict(evaluation),
    playbookPhase: buildPlaybookPhaseVerdict(evaluation),
    memory: buildMemoryVerdict(evaluation),
    answer: buildAnswerVerdict(evaluation),
    advisorIntent: buildLegacyAdvisorIntentEvaluation(evaluation),
  };

  return patch;
}

export function buildAdvisorIntentEvaluationFromTrace({
  trace,
  expectedAction,
  source = "explicit-human-label",
  now = Date.now(),
}: {
  trace: MeetingTrace;
  expectedAction: NonNullable<
    QuestionHumanEvaluation["advisorIntent"]
  >["expectedAction"];
  source?: NonNullable<
    QuestionHumanEvaluation["advisorIntent"]
  >["source"];
  now?: number;
}): NonNullable<QuestionHumanEvaluation["advisorIntent"]> | undefined {
  const metadata = trace.metadata ?? {};
  const observedAttempt = projectObservedAdvisorAttempt(metadata);
  if (!observedAttempt.runtimeAction) return undefined;
  const executionAuthorized =
    typeof metadata.advisorExecutionAuthorized === "boolean"
      ? metadata.advisorExecutionAuthorized
      : undefined;
  const outputCommitAuthorized =
    typeof metadata.advisorOutputCommitAuthorized === "boolean"
      ? metadata.advisorOutputCommitAuthorized
      : undefined;
  const turnAction = readOptionalString(
    metadata.turnGateAction ?? metadata.advisorTurnAction
  );
  const intent = readOptionalString(metadata.advisorTurnIntent);
  const observedAction = {
    advise: "advised",
    "append-context": "append-only",
    buffer: "buffered",
    ignore: "suppressed",
  }[observedAttempt.runtimeAction] as NonNullable<
    QuestionHumanEvaluation["advisorIntent"]
  >["observedAction"];
  const expectedAdvice = expectedAction === "advise";
  const observedAdvice = observedAction === "advised";
  const verdict =
    expectedAdvice === observedAdvice
      ? "ok"
      : expectedAdvice
        ? "false-negative"
        : "false-positive";
  const logicalQuestionSourceTurnIds = Array.isArray(
    metadata.logicalQuestionSourceTurnIds
  )
    ? metadata.logicalQuestionSourceTurnIds.map(readOptionalString)
    : [];
  const triggerTurnId = readOptionalString(
    metadata.triggerTurnId ?? metadata.questionTriggerTurnId
  );

  return {
    schemaVersion: 1,
    verdict,
    expectedAction,
    observedAction,
    failureReason:
      verdict === "false-negative"
        ? "advisor-false-negative"
        : verdict === "false-positive"
          ? "advisor-false-positive"
          : undefined,
    source,
    originalTraceId: trace.id,
    logicalQuestionUnitId: readOptionalString(
      metadata.logicalQuestionUnitId
    ),
    logicalQuestionUnitRevision:
      typeof metadata.logicalQuestionRevision === "number"
        ? metadata.logicalQuestionRevision
        : typeof metadata.logicalQuestionUnitRevision === "number"
          ? metadata.logicalQuestionUnitRevision
          : undefined,
    sourceTurnIds: uniqueStrings([
      ...logicalQuestionSourceTurnIds,
      triggerTurnId,
    ]),
    preDecision: {
      intent,
      action: turnAction,
      executionAuthorized,
      outputCommitAuthorized,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeHumanEvaluationPatch(
  patch: Partial<TraceHumanEvaluation>
): Partial<TraceHumanEvaluation> {
  const questionType = normalizeQuestionTypeAlias(patch.questionType);
  if (!patch.correctedQuestionType) {
    return {
      ...patch,
      questionType,
    };
  }
  const correctedQuestionType = normalizeHumanEvalQuestionType(
    patch.correctedQuestionType
  );
  return {
    ...patch,
    questionType,
    correctedQuestionType,
  };
}

function normalizeClarifyingOptionsVerdict(value: unknown) {
  return value === "correct" ||
    value === "misleading" ||
    value === "missing"
    ? value
    : undefined;
}

function mergeTaxonomyAdjudicationEvaluation(
  existing: QuestionHumanEvaluation["taxonomyAdjudication"],
  patch: QuestionHumanEvaluation["taxonomyAdjudication"]
) {
  if (!existing && !patch) return undefined;
  const merged = {
    ...existing,
    ...patch,
  };
  const expectedRelation = normalizeInterviewTaskRelation(
    merged.expectedRelation
  );
  const { expectedRelation: _legacyExpectedRelation, ...rest } = merged;
  return expectedRelation ? { ...rest, expectedRelation } : rest;
}

function mergeProjectTrajectoryEvaluation(
  existing: QuestionHumanEvaluation["projectTrajectory"],
  patch: QuestionHumanEvaluation["projectTrajectory"]
): QuestionHumanEvaluation["projectTrajectory"] {
  if (!existing && !patch) return undefined;
  return normalizeProjectTrajectoryEvaluation({
    ...existing,
    ...patch,
  });
}

function normalizeProjectTrajectoryEvaluation(
  value: QuestionHumanEvaluation["projectTrajectory"]
): QuestionHumanEvaluation["projectTrajectory"] {
  if (!value || typeof value !== "object") return undefined;
  const detectedPhase = normalizeProjectTrajectoryPhase(value.detectedPhase);
  const expectedPhase = normalizeProjectTrajectoryPhase(value.expectedPhase);
  const detectedFactAnchorState = normalizeFactAnchorState(
    value.detectedFactAnchorState
  );
  const expectedFactAnchorState = normalizeFactAnchorState(
    value.expectedFactAnchorState
  );
  const detectedChildContinuity = normalizeProjectChildContinuity(
    value.detectedChildContinuity
  );
  const expectedChildContinuity = normalizeProjectChildContinuity(
    value.expectedChildContinuity
  );
  const normalized = {
    detectedProjectId: readOptionalString(value.detectedProjectId),
    detectedProjectName: readOptionalString(value.detectedProjectName),
    detectedProjectBindingRevision:
      typeof value.detectedProjectBindingRevision === "number" &&
      Number.isFinite(value.detectedProjectBindingRevision)
        ? value.detectedProjectBindingRevision
        : undefined,
    expectedProjectId: readOptionalString(value.expectedProjectId),
    expectedProjectName: readOptionalString(value.expectedProjectName),
    detectedPhase,
    expectedPhase,
    detectedFactAnchorState,
    expectedFactAnchorState,
    detectedChildContinuity,
    expectedChildContinuity,
    projectCorrect: readOptionalBoolean(value.projectCorrect),
    phaseCorrect: readOptionalBoolean(value.phaseCorrect),
    factSupportCorrect: readOptionalBoolean(value.factSupportCorrect),
    childContinuityCorrect: readOptionalBoolean(
      value.childContinuityCorrect
    ),
    unsupportedFirstPersonClaim: readOptionalBoolean(
      value.unsupportedFirstPersonClaim
    ),
  };
  return Object.values(normalized).some((candidate) => candidate !== undefined)
    ? normalized
    : undefined;
}

function mergeTransientPersonalStatusEvaluation(
  existing: QuestionHumanEvaluation["transientPersonalStatus"],
  patch: QuestionHumanEvaluation["transientPersonalStatus"]
): QuestionHumanEvaluation["transientPersonalStatus"] {
  if (!existing && !patch) return undefined;
  return normalizeTransientPersonalStatusEvaluation({
    ...existing,
    ...patch,
  });
}

function mergeAdvisorIntentEvaluation(
  existing: QuestionHumanEvaluation["advisorIntent"],
  patch: QuestionHumanEvaluation["advisorIntent"]
): QuestionHumanEvaluation["advisorIntent"] {
  if (!existing && !patch) return undefined;
  if (!existing) return patch;
  if (!patch) return existing;
  return {
    ...existing,
    ...patch,
    sourceTurnIds: uniqueStrings([
      ...existing.sourceTurnIds,
      ...patch.sourceTurnIds,
    ]),
    preDecision:
      existing.preDecision || patch.preDecision
        ? {
            ...existing.preDecision,
            ...patch.preDecision,
          }
        : undefined,
  };
}

function mergeAnswerSufficiencyEvaluation(
  existing: QuestionHumanEvaluation["answerSufficiency"],
  patch: QuestionHumanEvaluation["answerSufficiency"]
): QuestionHumanEvaluation["answerSufficiency"] {
  if (!existing && !patch) return undefined;
  if (!existing) return patch;
  if (!patch) return existing;
  return {
    ...existing,
    ...patch,
    expectedContextKinds: uniqueStrings([
      ...existing.expectedContextKinds,
      ...patch.expectedContextKinds,
    ]),
  };
}

function mergeCurrentQuestionSettlementEvaluation(
  existing: QuestionHumanEvaluation["currentQuestionSettlement"],
  patch: QuestionHumanEvaluation["currentQuestionSettlement"]
): QuestionHumanEvaluation["currentQuestionSettlement"] {
  if (!existing && !patch) return undefined;
  return {
    ...existing,
    ...patch,
  };
}

function mergeWhiteboardRenderEvaluation(
  existing: QuestionHumanEvaluation["whiteboardRender"],
  patch: QuestionHumanEvaluation["whiteboardRender"]
): QuestionHumanEvaluation["whiteboardRender"] {
  if (!existing && !patch) return undefined;
  return {
    ...existing,
    ...patch,
  };
}

function normalizeTransientPersonalStatusEvaluation(
  value: unknown
): QuestionHumanEvaluation["transientPersonalStatus"] {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const normalized = {
    detectedDomain: normalizePersonalStatusDomain(candidate.detectedDomain),
    expectedDomain: normalizePersonalStatusDomain(candidate.expectedDomain),
    policyApplicable:
      typeof candidate.policyApplicable === "boolean"
        ? candidate.policyApplicable
        : undefined,
    profileOnlyEvidenceCorrect:
      typeof candidate.profileOnlyEvidenceCorrect === "boolean"
        ? candidate.profileOnlyEvidenceCorrect
        : undefined,
    parentPreserved:
      typeof candidate.parentPreserved === "boolean"
        ? candidate.parentPreserved
        : undefined,
    artifactsPreserved:
      typeof candidate.artifactsPreserved === "boolean"
        ? candidate.artifactsPreserved
        : undefined,
  };
  return Object.values(normalized).some((entry) => entry !== undefined)
    ? normalized
    : undefined;
}

function buildLegacyAdvisorIntentEvaluation(
  evaluation: TraceHumanEvaluation
): QuestionHumanEvaluation["advisorIntent"] {
  if (
    !evaluation.advisorGateCorrectlySkipped &&
    !evaluation.advisorGateShouldAdvise
  ) {
    return undefined;
  }
  const now = evaluation.updatedAt || evaluation.createdAt || Date.now();
  const falseNegative = evaluation.advisorGateShouldAdvise === true;
  return {
    schemaVersion: 1,
    verdict: falseNegative ? "false-negative" : "ok",
    expectedAction: falseNegative ? "advise" : "ignore",
    observedAction: "suppressed",
    failureReason: falseNegative ? "advisor-false-negative" : undefined,
    source: "explicit-human-label",
    originalTraceId: evaluation.traceId,
    sourceTurnIds: [],
    createdAt: evaluation.createdAt || now,
    updatedAt: now,
  };
}

function normalizeInterviewTaskRelation(
  value: unknown
): HumanEvaluationTaskRelation | undefined {
  return value === "new-parent" ||
    value === "followup-parent" ||
    value === "child-probe" ||
    value === "resume-parent" ||
    value === "none"
    ? value
    : value === "logistics" || value === "correction" || value === "unknown"
      ? "none"
    : undefined;
}

function normalizeExpectedParentAction(
  value: unknown
): QuestionHumanEvaluation["expectedParentAction"] {
  return value === "create" ||
    value === "preserve" ||
    value === "retype" ||
    value === "resume" ||
    value === "attach-child" ||
    value === "none"
    ? value
    : undefined;
}

function normalizePersonalStatusDomain(
  value: unknown
): PersonalStatusDomain | undefined {
  return value === "relocation" ||
    value === "compensation" ||
    value === "work-authorization" ||
    value === "start-date"
    ? value
    : undefined;
}

function normalizeHumanEvalQuestionType(
  questionType: HumanEvalQuestionType | undefined
): HumanEvalQuestionType | undefined {
  const canonical = fromHumanEvalQuestionType(questionType);
  return canonical ? toHumanEvalQuestionType(canonical) : undefined;
}

function normalizeToHumanEvalQuestionType(
  questionType: unknown
): HumanEvalQuestionType | undefined {
  const canonical = normalizeCanonicalQuestionType(
    normalizeQuestionTypeAlias(questionType)
  );
  return canonical ? toHumanEvalQuestionType(canonical) : undefined;
}

function createHumanEvalId() {
  return `human_eval_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function createQuestionHumanEvalId() {
  return `question_eval_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function resolveQuestionId(
  identity: QuestionEvaluationIdentity
) {
  return `trace:${identity.traceId}`;
}

function buildClassificationVerdict(
  evaluation: TraceHumanEvaluation
): HumanEvaluationVerdictBlock {
  if (evaluation.failureReasons.includes("wrong-question-type")) {
    return makeVerdict("wrong", ["wrong-question-type"]);
  }
  if (evaluation.correctedQuestionType) {
    const detected = normalizeToHumanEvalQuestionType(evaluation.questionType);
    return makeVerdict(
      detected === evaluation.correctedQuestionType ? "ok" : "wrong",
      detected === evaluation.correctedQuestionType ? ["confirmed"] : ["corrected"]
    );
  }
  return DEFAULT_VERDICT_BLOCK;
}

function buildPlaybookVerdict(
  evaluation: TraceHumanEvaluation
): HumanEvaluationVerdictBlock {
  if (evaluation.playbookWrong) return makeVerdict("wrong", ["wrong-playbook"]);
  if (evaluation.failureReasons.includes("wrong-playbook")) {
    return makeVerdict("wrong", ["wrong-playbook"]);
  }
  if (evaluation.playbookCorrect) return makeVerdict("ok", ["confirmed"]);
  return DEFAULT_VERDICT_BLOCK;
}

function buildPlaybookPhaseVerdict(
  evaluation: TraceHumanEvaluation
): HumanEvaluationVerdictBlock {
  if (evaluation.playbookWrongPhase) {
    return makeVerdict("wrong", ["wrong-playbook-phase"]);
  }
  if (evaluation.failureReasons.includes("wrong-playbook-phase")) {
    return makeVerdict("wrong", ["wrong-playbook-phase"]);
  }
  if (evaluation.playbookCorrect) return makeVerdict("ok", ["playbook-ok"]);
  return DEFAULT_VERDICT_BLOCK;
}

function buildMemoryVerdict(
  evaluation: TraceHumanEvaluation
): HumanEvaluationVerdictBlock {
  if (evaluation.memoryWrong) return makeVerdict("forbidden", ["wrong-memory"]);
  if (evaluation.memoryMissing) return makeVerdict("missing", ["missing-memory"]);
  if (evaluation.failureReasons.includes("wrong-memory")) {
    return makeVerdict("forbidden", ["wrong-memory"]);
  }
  if (evaluation.failureReasons.includes("missing-memory")) {
    return makeVerdict("missing", ["missing-memory"]);
  }
  if (evaluation.memoryRelevant) return makeVerdict("ok", ["confirmed"]);
  return DEFAULT_VERDICT_BLOCK;
}

function buildAnswerVerdict(
  evaluation: TraceHumanEvaluation
): HumanEvaluationVerdictBlock {
  if (evaluation.taskQuality === "success") return makeVerdict("ok", ["useful"]);
  if (evaluation.taskQuality === "partial") {
    return makeVerdict("partial", ["partially-useful"]);
  }
  if (evaluation.taskQuality === "fail") return makeVerdict("wrong", ["failed"]);
  if (evaluation.failureReasons.includes("wrong-answer")) {
    return makeVerdict("wrong", ["wrong-answer"]);
  }
  if (evaluation.failureReasons.includes("too-short")) {
    return makeVerdict("partial", ["too-short"]);
  }
  return DEFAULT_VERDICT_BLOCK;
}

function makeVerdict(
  verdict: HumanEvaluationVerdict,
  reasons: string[] = []
): HumanEvaluationVerdictBlock {
  return { verdict, reasons };
}

function mergeVerdictBlock(
  existing: HumanEvaluationVerdictBlock | undefined,
  patch: HumanEvaluationVerdictBlock | undefined
): HumanEvaluationVerdictBlock {
  if (!patch) return existing ?? DEFAULT_VERDICT_BLOCK;
  return {
    verdict: patch.verdict ?? existing?.verdict ?? "not_applicable",
    reasons: patch.reasons ?? existing?.reasons ?? [],
    note: patch.note ?? existing?.note,
  };
}

function mergeMemoryEntryLabels(
  existing: MemoryEntryEvaluationLabel[],
  patch: MemoryEntryEvaluationLabel[]
) {
  if (!patch.length) return existing;
  const byId = new Map(existing.map((item) => [item.memoryId, item]));
  for (const item of normalizeMemoryEntryLabels(patch)) {
    byId.set(item.memoryId, { ...byId.get(item.memoryId), ...item });
  }
  return Array.from(byId.values());
}

function normalizeMemoryEntryLabels(
  value: unknown
): MemoryEntryEvaluationLabel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): MemoryEntryEvaluationLabel[] => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<MemoryEntryEvaluationLabel>;
    if (!candidate.memoryId || !isMemoryEntryLabel(candidate.label)) return [];
    return [
      {
        memoryId: candidate.memoryId,
        title: readOptionalString(candidate.title),
        label: candidate.label,
        reason: readOptionalString(candidate.reason),
      },
    ];
  });
}

function isMemoryEntryLabel(
  value: unknown
): value is MemoryEntryEvaluationLabel["label"] {
  return value === "relevant" || value === "irrelevant" || value === "forbidden";
}

function mergeMissingExpectedMemory(
  existing: MissingExpectedMemoryLabel[],
  patch: MissingExpectedMemoryLabel[]
) {
  const normalized = normalizeMissingExpectedMemory(patch);
  if (!normalized.length) return existing;
  const key = (item: MissingExpectedMemoryLabel) =>
    item.id ? `id:${item.id}` : `note:${item.note ?? ""}`;
  const byKey = new Map(existing.map((item) => [key(item), item]));
  for (const item of normalized) byKey.set(key(item), item);
  return Array.from(byKey.values());
}

function normalizeMissingExpectedMemory(
  value: unknown
): MissingExpectedMemoryLabel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): MissingExpectedMemoryLabel[] => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<MissingExpectedMemoryLabel>;
    const id = readOptionalString(candidate.id);
    const note = readOptionalString(candidate.note);
    if (!id && !note) return [];
    return [{ id, note }];
  });
}

function normalizeProjectTrajectoryPhase(
  value: unknown
): NonNullable<
  QuestionHumanEvaluation["projectTrajectory"]
>["detectedPhase"] {
  return value === "story_selection" ||
    value === "baseline_reasoning" ||
    value === "optimized_pseudocode" ||
    value === "implementation_validation" ||
    value === "solution_planning" ||
    value === "requirement_clarification" ||
    value === "design_framing" ||
    value === "project_summary" ||
    value === "project_QA" ||
    value === "project_narrative" ||
    value === "architecture_decision" ||
    value === "validation_reliability" ||
    value === "impact_lessons" ||
    value === "concept_explanation" ||
    value === "follow_up"
    ? value
    : undefined;
}

function normalizeFactAnchorState(
  value: unknown
): NonNullable<
  QuestionHumanEvaluation["projectTrajectory"]
>["detectedFactAnchorState"] {
  return value === "strong-anchor" ||
    value === "weak-anchor" ||
    value === "no-anchor" ||
    value === "not-required"
    ? value
    : undefined;
}

function normalizeProjectChildContinuity(
  value: unknown
): NonNullable<
  QuestionHumanEvaluation["projectTrajectory"]
>["detectedChildContinuity"] {
  return value === "none" ||
    value === "child-attached" ||
    value === "parent-resumed"
    ? value
    : undefined;
}

function readOptionalBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function readOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function uniqueStrings(values: Array<string | undefined>) {
  return Array.from(
    new Set(values.filter((value): value is string => Boolean(value)))
  );
}
