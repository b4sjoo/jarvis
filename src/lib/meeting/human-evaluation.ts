import { STORAGE_KEYS } from "../../config/constants.js";
import { safeLocalStorage } from "../storage/helper.js";
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
  InterviewTaskRelation,
  PersonalStatusDomain,
} from "./types";
import { normalizeMemoryRetrievalEvaluationSnapshot } from "./memory-evaluation.js";
import { resolveHumanEvaluationAttemptIdentityV2 } from "./human-evaluation-attempt.js";
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

export function resolveSettledAttemptEvaluationTarget(input: {
  suggestion: AdvisorSuggestion | null | undefined;
  answerInProgress?: boolean;
  traces: MeetingTrace[];
  currentSessionId?: string;
}): VisibleAnswerEvaluationTarget {
  const attempt = input.traces.find((trace) => {
    const identity = resolveHumanEvaluationAttemptIdentityV2(trace);
    return Boolean(
      identity &&
        (!input.currentSessionId ||
          identity.sessionId === input.currentSessionId)
    );
  });
  if (!attempt) {
    return resolveVisibleAnswerEvaluationTarget({
      suggestion: input.suggestion,
      answerInProgress: input.answerInProgress,
      traces: input.traces,
      latestTraceId: input.traces[0]?.id,
    });
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

export function readTraceHumanEvaluations(): TraceHumanEvaluation[] {
  const stored = safeLocalStorage.getItem(
    STORAGE_KEYS.MEETING_TRACE_HUMAN_EVALUATIONS
  );
  if (!stored) return [];

  try {
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeTraceHumanEvaluation)
      .filter(Boolean)
      .slice(-MAX_HUMAN_EVALUATIONS) as TraceHumanEvaluation[];
  } catch {
    return [];
  }
}

export function persistTraceHumanEvaluations(
  evaluations: TraceHumanEvaluation[]
) {
  safeLocalStorage.setItem(
    STORAGE_KEYS.MEETING_TRACE_HUMAN_EVALUATIONS,
    JSON.stringify(evaluations.slice(-MAX_HUMAN_EVALUATIONS))
  );
}

export function readQuestionHumanEvaluations(): QuestionHumanEvaluation[] {
  const stored = safeLocalStorage.getItem(
    STORAGE_KEYS.MEETING_QUESTION_HUMAN_EVALUATIONS
  );
  if (!stored) return [];

  try {
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeQuestionHumanEvaluation)
      .filter(Boolean)
      .slice(-MAX_QUESTION_HUMAN_EVALUATIONS) as QuestionHumanEvaluation[];
  } catch {
    return [];
  }
}

export function persistQuestionHumanEvaluations(
  evaluations: QuestionHumanEvaluation[]
) {
  safeLocalStorage.setItem(
    STORAGE_KEYS.MEETING_QUESTION_HUMAN_EVALUATIONS,
    JSON.stringify(evaluations.slice(-MAX_QUESTION_HUMAN_EVALUATIONS))
  );
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
}): NonNullable<QuestionHumanEvaluation["advisorIntent"]> {
  const metadata = trace.metadata ?? {};
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
  const observedAction =
    executionAuthorized === true || outputCommitAuthorized === true
      ? "advised"
      : intent === "incomplete"
        ? "buffered"
        : turnAction === "append-only" || turnAction === "state-update"
          ? "append-only"
          : "suppressed";
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
      enforcement: readOptionalString(
        metadata.advisorTurnEnforcement
      ),
      wouldSuppress:
        typeof metadata.advisorWouldSuppress === "boolean"
          ? metadata.advisorWouldSuppress
          : undefined,
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

function normalizeTraceHumanEvaluation(
  value: unknown
): TraceHumanEvaluation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<TraceHumanEvaluation>;
  if (!candidate.traceId || !candidate.traceKind) return undefined;

  return {
    id: typeof candidate.id === "string" ? candidate.id : createHumanEvalId(),
    traceId: candidate.traceId,
    traceKind: candidate.traceKind,
    taskId: typeof candidate.taskId === "string" ? candidate.taskId : undefined,
    parentTaskId:
      typeof candidate.parentTaskId === "string"
        ? candidate.parentTaskId
        : undefined,
    childTaskId:
      typeof candidate.childTaskId === "string"
        ? candidate.childTaskId
        : undefined,
    taskSource:
      candidate.taskSource === "screen" ||
      candidate.taskSource === "voice" ||
      candidate.taskSource === "mixed"
        ? candidate.taskSource
        : undefined,
    questionType: normalizeQuestionTypeAlias(candidate.questionType),
    createdAt:
      typeof candidate.createdAt === "number" ? candidate.createdAt : Date.now(),
    updatedAt:
      typeof candidate.updatedAt === "number" ? candidate.updatedAt : Date.now(),
    correctedQuestionType: normalizeHumanEvalQuestionType(
      candidate.correctedQuestionType
    ),
    correctedCompany: candidate.correctedCompany,
    playbookCorrect: candidate.playbookCorrect,
    playbookWrong: candidate.playbookWrong,
    playbookWrongPhase: candidate.playbookWrongPhase,
    memoryRelevant: candidate.memoryRelevant,
    memoryMissing: candidate.memoryMissing,
    memoryWrong: candidate.memoryWrong,
    advisorGateCorrectlySkipped: candidate.advisorGateCorrectlySkipped,
    advisorGateShouldAdvise: candidate.advisorGateShouldAdvise,
    taskQuality: candidate.taskQuality,
    failureReasons: Array.isArray(candidate.failureReasons)
      ? candidate.failureReasons
      : [],
    notes: candidate.notes,
  };
}

function normalizeQuestionHumanEvaluation(
  value: unknown
): QuestionHumanEvaluation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<QuestionHumanEvaluation>;
  if (!candidate.questionId || !Array.isArray(candidate.traceIds)) {
    return undefined;
  }

  return {
    id: typeof candidate.id === "string" ? candidate.id : createQuestionHumanEvalId(),
    sessionId:
      typeof candidate.sessionId === "string" ? candidate.sessionId : undefined,
    questionId: candidate.questionId,
    taskId: typeof candidate.taskId === "string" ? candidate.taskId : undefined,
    parentTaskId:
      typeof candidate.parentTaskId === "string"
        ? candidate.parentTaskId
        : undefined,
    childTaskId:
      typeof candidate.childTaskId === "string"
        ? candidate.childTaskId
        : undefined,
    taskSource:
      candidate.taskSource === "screen" ||
      candidate.taskSource === "voice" ||
      candidate.taskSource === "mixed"
        ? candidate.taskSource
        : undefined,
    traceIds: uniqueStrings(candidate.traceIds),
    questionType: normalizeHumanEvalQuestionType(candidate.questionType),
    correctedQuestionType: normalizeHumanEvalQuestionType(
      candidate.correctedQuestionType
    ),
    manualQuestionTypeCorrectionId: readOptionalString(
      candidate.manualQuestionTypeCorrectionId
    ),
    manualQuestionTypeCorrectionTraceId: readOptionalString(
      candidate.manualQuestionTypeCorrectionTraceId
    ),
    manualQuestionTypeRegenerationTraceId: readOptionalString(
      candidate.manualQuestionTypeRegenerationTraceId
    ),
    manualQuestionTypeCorrectionSource:
      candidate.manualQuestionTypeCorrectionSource === "focus-mode" ||
      candidate.manualQuestionTypeCorrectionSource === "normal-mode"
        ? candidate.manualQuestionTypeCorrectionSource
        : undefined,
    manualQuestionTypeCorrectionScope:
      candidate.manualQuestionTypeCorrectionScope === "same-question-retype" ||
      candidate.manualQuestionTypeCorrectionScope === "child-retype" ||
      candidate.manualQuestionTypeCorrectionScope === "resume-parent" ||
      candidate.manualQuestionTypeCorrectionScope === "linked-parent-extension" ||
      candidate.manualQuestionTypeCorrectionScope === "independent-new-parent" ||
      candidate.manualQuestionTypeCorrectionScope === "current-only"
        ? candidate.manualQuestionTypeCorrectionScope
        : undefined,
    manualQuestionTypeCorrectionBoundaryReason: readOptionalString(
      candidate.manualQuestionTypeCorrectionBoundaryReason
    ),
    manualQuestionTypeCorrectionPreviousParentId: readOptionalString(
      candidate.manualQuestionTypeCorrectionPreviousParentId
    ),
    manualQuestionTypeCorrectionNextParentId: readOptionalString(
      candidate.manualQuestionTypeCorrectionNextParentId
    ),
    manualTermCorrectionId: readOptionalString(
      candidate.manualTermCorrectionId
    ),
    manualTermCorrectionTraceId: readOptionalString(
      candidate.manualTermCorrectionTraceId
    ),
    manualTermCorrectionRegenerationTraceId: readOptionalString(
      candidate.manualTermCorrectionRegenerationTraceId
    ),
    manualTermCorrectionDisposition:
      candidate.manualTermCorrectionDisposition ===
        "current-question-overlay" ||
      candidate.manualTermCorrectionDisposition === "future-speech-bias" ||
      candidate.manualTermCorrectionDisposition === "stale-rejected"
        ? candidate.manualTermCorrectionDisposition
        : undefined,
    manualTermCorrectionReason:
      candidate.manualTermCorrectionReason === "manual-term-correction"
        ? candidate.manualTermCorrectionReason
        : undefined,
    transientPersonalStatus: normalizeTransientPersonalStatusEvaluation(
      candidate.transientPersonalStatus
    ),
    company: readOptionalString(candidate.company),
    correctedCompany: readOptionalString(candidate.correctedCompany),
    relation: readOptionalString(candidate.relation),
    expectedRelation: normalizeInterviewTaskRelation(
      candidate.expectedRelation
    ),
    expectedParentAction: normalizeExpectedParentAction(
      candidate.expectedParentAction
    ),
    expectedContextTurnIds: Array.isArray(candidate.expectedContextTurnIds)
      ? uniqueStrings(candidate.expectedContextTurnIds.map(readOptionalString))
      : [],
    correctedRelation: normalizeInterviewTaskRelation(
      candidate.correctedRelation
    ),
    primaryAskCorrect:
      typeof candidate.primaryAskCorrect === "boolean"
        ? candidate.primaryAskCorrect
        : undefined,
    clarifyingOptionsVerdict: normalizeClarifyingOptionsVerdict(
      candidate.clarifyingOptionsVerdict
    ),
    playbookId: readOptionalString(candidate.playbookId),
    detectedPlaybookPhase: readOptionalString(candidate.detectedPlaybookPhase),
    correctedPlaybookPhase: readOptionalString(candidate.correctedPlaybookPhase),
    detectedWhiteboardArtifactId: readOptionalString(
      candidate.detectedWhiteboardArtifactId
    ),
    detectedWhiteboardArtifactRevision:
      typeof candidate.detectedWhiteboardArtifactRevision === "number"
        ? candidate.detectedWhiteboardArtifactRevision
        : undefined,
    detectedWhiteboardArtifactDomainTrack: readOptionalString(
      candidate.detectedWhiteboardArtifactDomainTrack
    ),
    detectedManualPhaseFrom: readOptionalString(candidate.detectedManualPhaseFrom),
    detectedManualPhaseTo: readOptionalString(candidate.detectedManualPhaseTo),
    detectedManualPhaseTargetArtifact: readOptionalString(
      candidate.detectedManualPhaseTargetArtifact
    ),
    detectedManualPhaseGuardStatus: readOptionalString(
      candidate.detectedManualPhaseGuardStatus
    ),
    selectedDiagramOverlayIds: Array.isArray(candidate.selectedDiagramOverlayIds)
      ? uniqueStrings(candidate.selectedDiagramOverlayIds)
      : [],
    rejectedDiagramOverlayCount:
      typeof candidate.rejectedDiagramOverlayCount === "number"
        ? candidate.rejectedDiagramOverlayCount
        : undefined,
    classification: normalizeVerdictBlock(candidate.classification),
    playbook: normalizeVerdictBlock(candidate.playbook),
    playbookPhase: normalizeVerdictBlock(candidate.playbookPhase),
    memory: normalizeVerdictBlock(candidate.memory),
    whiteboard: normalizeVerdictBlock(candidate.whiteboard),
    manualPhaseTransition: normalizeVerdictBlock(
      candidate.manualPhaseTransition
    ),
    diagramOverlay: normalizeVerdictBlock(candidate.diagramOverlay),
    guardrail: normalizeVerdictBlock(candidate.guardrail),
    answer: normalizeVerdictBlock(candidate.answer),
    taxonomyAdjudication: normalizeTaxonomyAdjudicationEvaluation(
      candidate.taxonomyAdjudication
    ),
    advisorIntent: normalizeAdvisorIntentEvaluation(candidate.advisorIntent),
    answerSufficiency: normalizeAnswerSufficiencyEvaluation(
      candidate.answerSufficiency
    ),
    currentQuestionSettlement:
      normalizeCurrentQuestionSettlementEvaluation(
        candidate.currentQuestionSettlement
      ),
    whiteboardRender: normalizeWhiteboardRenderEvaluation(
      candidate.whiteboardRender
    ),
    projectTrajectory: normalizeProjectTrajectoryEvaluation(
      candidate.projectTrajectory
    ),
    memoryRetrievalSnapshot: normalizeMemoryRetrievalEvaluationSnapshot(
      candidate.memoryRetrievalSnapshot
    ),
    memoryEntryLabels: normalizeMemoryEntryLabels(candidate.memoryEntryLabels),
    missingExpectedMemory: normalizeMissingExpectedMemory(
      candidate.missingExpectedMemory
    ),
    notes: readOptionalString(candidate.notes),
    createdAt:
      typeof candidate.createdAt === "number" ? candidate.createdAt : Date.now(),
    updatedAt:
      typeof candidate.updatedAt === "number" ? candidate.updatedAt : Date.now(),
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
  return {
    ...existing,
    ...patch,
  };
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

function normalizeWhiteboardRenderEvaluation(
  value: unknown
): QuestionHumanEvaluation["whiteboardRender"] {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const observedOutcome =
    candidate.observedOutcome === "rendered" ||
    candidate.observedOutcome === "repaired" ||
    candidate.observedOutcome === "preserved-last-valid" ||
    candidate.observedOutcome === "ascii-fallback" ||
    candidate.observedOutcome === "error-visible" ||
    candidate.observedOutcome === "missing"
      ? candidate.observedOutcome
      : undefined;
  const repairVerdict =
    candidate.repairVerdict === "correct" ||
    candidate.repairVerdict === "semantic-drift" ||
    candidate.repairVerdict === "failed" ||
    candidate.repairVerdict === "not-observed"
      ? candidate.repairVerdict
      : undefined;
  const fallbackVerdict =
    candidate.fallbackVerdict === "useful" ||
    candidate.fallbackVerdict === "not-useful" ||
    candidate.fallbackVerdict === "not-observed"
      ? candidate.fallbackVerdict
      : undefined;
  const preservationVerdict =
    candidate.preservationVerdict === "correct" ||
    candidate.preservationVerdict === "overwritten" ||
    candidate.preservationVerdict === "not-applicable"
      ? candidate.preservationVerdict
      : undefined;
  const normalized: NonNullable<
    QuestionHumanEvaluation["whiteboardRender"]
  > = {
    artifactId: readOptionalString(candidate.artifactId),
    validationOperationId: readOptionalString(
      candidate.validationOperationId
    ),
    repairOperationId: readOptionalString(candidate.repairOperationId),
    candidateRevision:
      typeof candidate.candidateRevision === "number"
        ? candidate.candidateRevision
        : undefined,
    visibleRevision:
      typeof candidate.visibleRevision === "number"
        ? candidate.visibleRevision
        : undefined,
    observedOutcome,
    repairVerdict,
    fallbackVerdict,
    preservationVerdict,
  };
  return Object.values(normalized).some((entry) => entry !== undefined)
    ? normalized
    : undefined;
}

function normalizeCurrentQuestionSettlementEvaluation(
  value: unknown
): QuestionHumanEvaluation["currentQuestionSettlement"] {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const expectedDisposition =
    candidate.expectedDisposition === "domain-resolved-provisional" ||
    candidate.expectedDisposition === "domain-resolved-unknown" ||
    candidate.expectedDisposition === "unresolved-provisional" ||
    candidate.expectedDisposition === "response-only" ||
    candidate.expectedDisposition === "committed-parent" ||
    candidate.expectedDisposition === "stale-dropped" ||
    candidate.expectedDisposition === "manual-authority"
      ? candidate.expectedDisposition
      : undefined;

  return {
    questionTypeCorrect:
      typeof candidate.questionTypeCorrect === "boolean"
        ? candidate.questionTypeCorrect
        : undefined,
    relationCorrect:
      typeof candidate.relationCorrect === "boolean"
        ? candidate.relationCorrect
        : undefined,
    parentMutationCorrect:
      typeof candidate.parentMutationCorrect === "boolean"
        ? candidate.parentMutationCorrect
        : undefined,
    responseAuthorizationCorrect:
      typeof candidate.responseAuthorizationCorrect === "boolean"
        ? candidate.responseAuthorizationCorrect
        : undefined,
    expectedDisposition,
    notes: readOptionalString(candidate.notes),
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

function normalizeAnswerSufficiencyEvaluation(
  value: unknown
): QuestionHumanEvaluation["answerSufficiency"] {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const observedStatus =
    candidate.observedStatus === "sufficient" ||
    candidate.observedStatus === "insufficient"
      ? candidate.observedStatus
      : undefined;
  const expectedRepair =
    candidate.expectedRepair === "none" ||
    candidate.expectedRepair === "narrow" ||
    candidate.expectedRepair === "enhance" ||
    candidate.expectedRepair === "buffer" ||
    candidate.expectedRepair === "ignore" ||
    candidate.expectedRepair === "wait" ||
    candidate.expectedRepair === "manual-clarification"
      ? candidate.expectedRepair
      : undefined;

  return {
    observedStatus,
    defect: readOptionalString(candidate.defect),
    nearbyContextExisted:
      typeof candidate.nearbyContextExisted === "boolean"
        ? candidate.nearbyContextExisted
        : undefined,
    expectedRepair,
    expectedContextKinds: Array.isArray(candidate.expectedContextKinds)
      ? uniqueStrings(candidate.expectedContextKinds.map(readOptionalString))
      : [],
    repairHelpful:
      typeof candidate.repairHelpful === "boolean"
        ? candidate.repairHelpful
        : undefined,
    repairTimely:
      typeof candidate.repairTimely === "boolean"
        ? candidate.repairTimely
        : undefined,
    staleContextIntroduced:
      typeof candidate.staleContextIntroduced === "boolean"
        ? candidate.staleContextIntroduced
        : undefined,
    operationId: readOptionalString(candidate.operationId),
    answerRevision:
      typeof candidate.answerRevision === "number"
        ? candidate.answerRevision
        : undefined,
  };
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

function normalizeAdvisorIntentEvaluation(
  value: unknown
): QuestionHumanEvaluation["advisorIntent"] {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const verdict =
    candidate.verdict === "ok" ||
    candidate.verdict === "false-positive" ||
    candidate.verdict === "false-negative"
      ? candidate.verdict
      : undefined;
  const expectedAction =
    candidate.expectedAction === "advise" ||
    candidate.expectedAction === "append-context" ||
    candidate.expectedAction === "buffer" ||
    candidate.expectedAction === "ignore"
      ? candidate.expectedAction
      : undefined;
  const observedAction =
    candidate.observedAction === "advised" ||
    candidate.observedAction === "suppressed" ||
    candidate.observedAction === "append-only" ||
    candidate.observedAction === "buffered"
      ? candidate.observedAction
      : undefined;
  const source =
    candidate.source === "explicit-human-label" ||
    candidate.source === "manual-force-advise" ||
    candidate.source === "manual-suppress"
      ? candidate.source
      : undefined;
  const originalTraceId = readOptionalString(candidate.originalTraceId);
  if (
    !verdict ||
    !expectedAction ||
    !observedAction ||
    !source ||
    !originalTraceId
  ) {
    return undefined;
  }

  const failureReason =
    candidate.failureReason === "advisor-false-positive" ||
    candidate.failureReason === "advisor-false-negative" ||
    candidate.failureReason === "wrong-output-authority" ||
    candidate.failureReason === "wrong-context-composition"
      ? candidate.failureReason
      : undefined;
  const preDecision =
    candidate.preDecision && typeof candidate.preDecision === "object"
      ? normalizeAdvisorIntentPreDecision(
          candidate.preDecision as Record<string, unknown>
        )
      : undefined;

  return {
    schemaVersion: 1,
    verdict,
    expectedAction,
    observedAction,
    failureReason,
    source,
    originalTraceId,
    logicalQuestionUnitId: readOptionalString(candidate.logicalQuestionUnitId),
    logicalQuestionUnitRevision:
      typeof candidate.logicalQuestionUnitRevision === "number"
        ? candidate.logicalQuestionUnitRevision
        : undefined,
    sourceTurnIds: Array.isArray(candidate.sourceTurnIds)
      ? uniqueStrings(candidate.sourceTurnIds.map(readOptionalString))
      : [],
    preDecision,
    repairTraceId: readOptionalString(candidate.repairTraceId),
    createdAt:
      typeof candidate.createdAt === "number" ? candidate.createdAt : Date.now(),
    updatedAt:
      typeof candidate.updatedAt === "number" ? candidate.updatedAt : Date.now(),
  };
}

function normalizeAdvisorIntentPreDecision(
  candidate: Record<string, unknown>
): NonNullable<QuestionHumanEvaluation["advisorIntent"]>["preDecision"] {
  const normalized = {
    speechAct: readOptionalString(candidate.speechAct),
    intent: readOptionalString(candidate.intent),
    action: readOptionalString(candidate.action),
    enforcement: readOptionalString(candidate.enforcement),
    wouldSuppress:
      typeof candidate.wouldSuppress === "boolean"
        ? candidate.wouldSuppress
        : undefined,
    executionAuthorized:
      typeof candidate.executionAuthorized === "boolean"
        ? candidate.executionAuthorized
        : undefined,
    outputCommitAuthorized:
      typeof candidate.outputCommitAuthorized === "boolean"
        ? candidate.outputCommitAuthorized
        : undefined,
  };
  return Object.values(normalized).some((entry) => entry !== undefined)
    ? normalized
    : undefined;
}

function normalizeTaxonomyAdjudicationEvaluation(
  value: unknown
): QuestionHumanEvaluation["taxonomyAdjudication"] {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const expectedRelation: NonNullable<
    QuestionHumanEvaluation["taxonomyAdjudication"]
  >["expectedRelation"] = normalizeInterviewTaskRelation(
    candidate.expectedRelation
  );
  const contextOutcome: NonNullable<
    QuestionHumanEvaluation["taxonomyAdjudication"]
  >["contextOutcome"] =
    candidate.contextOutcome === "correct" ||
    candidate.contextOutcome === "contaminated" ||
    candidate.contextOutcome === "missing"
      ? candidate.contextOutcome
      : undefined;
  const repairDisposition: NonNullable<
    QuestionHumanEvaluation["taxonomyAdjudication"]
  >["repairDisposition"] =
    candidate.repairDisposition === "automatic-repair" ||
    candidate.repairDisposition === "suggest-only" ||
    candidate.repairDisposition === "abstain"
      ? candidate.repairDisposition
      : undefined;
  const normalized = {
    needed:
      typeof candidate.needed === "boolean" ? candidate.needed : undefined,
    typeCorrect:
      typeof candidate.typeCorrect === "boolean"
        ? candidate.typeCorrect
        : undefined,
    relationCorrect:
      typeof candidate.relationCorrect === "boolean"
        ? candidate.relationCorrect
        : undefined,
    expectedRelation,
    parentDecisionCorrect:
      typeof candidate.parentDecisionCorrect === "boolean"
        ? candidate.parentDecisionCorrect
        : undefined,
    responseOnlyCorrect:
      typeof candidate.responseOnlyCorrect === "boolean"
        ? candidate.responseOnlyCorrect
        : undefined,
    contextOutcome,
    repairDisposition,
    contextPreserved:
      typeof candidate.contextPreserved === "boolean"
        ? candidate.contextPreserved
        : undefined,
    timely:
      typeof candidate.timely === "boolean" ? candidate.timely : undefined,
  };
  return Object.values(normalized).some((item) => item !== undefined)
    ? normalized
    : undefined;
}

function normalizeInterviewTaskRelation(
  value: unknown
): InterviewTaskRelation | undefined {
  return value === "new-parent" ||
    value === "followup-parent" ||
    value === "child-probe" ||
    value === "resume-parent" ||
    value === "logistics" ||
    value === "correction" ||
    value === "unknown"
    ? value
    : undefined;
}

function normalizeExpectedParentAction(
  value: unknown
): QuestionHumanEvaluation["expectedParentAction"] {
  return value === "create" ||
    value === "preserve" ||
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

function normalizeVerdictBlock(
  value: unknown
): HumanEvaluationVerdictBlock {
  if (!value || typeof value !== "object") return DEFAULT_VERDICT_BLOCK;
  const candidate = value as Partial<HumanEvaluationVerdictBlock>;
  return {
    verdict: isHumanEvaluationVerdict(candidate.verdict)
      ? candidate.verdict
      : "not_applicable",
    reasons: Array.isArray(candidate.reasons)
      ? candidate.reasons.filter((reason): reason is string => typeof reason === "string")
      : [],
    note: readOptionalString(candidate.note),
  };
}

function isHumanEvaluationVerdict(
  value: unknown
): value is HumanEvaluationVerdict {
  return (
    value === "ok" ||
    value === "partial" ||
    value === "wrong" ||
    value === "missing" ||
    value === "forbidden" ||
    value === "not_applicable"
  );
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
