import type { MemoryRejectSummary } from "@/lib/memory";
import type { MeetingTrace, QuestionHumanEvaluation } from "./types";

export const SESSION_TASK_REVIEW_INDEX_SCHEMA_VERSION = 5;

export interface TaskReviewTraceSummary {
  version: number;
  sessionId: string;
  traceId: string;
  traceKind: MeetingTrace["kind"];
  status: MeetingTrace["status"];
  startedAt: number;
  endedAt?: number;
  taskIds: string[];
  primaryTaskId?: string;
  activeScreenTaskId?: string;
  activeMeetingTaskId?: string;
  activeMeetingTaskSource?: string;
  activeMeetingParentId?: string;
  activeMeetingChildId?: string;
  activeInterviewParentId?: string;
  activeInterviewChildId?: string;
  questionType?: string;
  askFrame?: string;
  topicDomain?: string;
  projectAnchor?: string;
  playbookId?: string;
  playbookPhase?: string;
  turnGateAction?: string;
  turnGateReason?: string;
  advisorTurnIntent?: string;
  advisorTurnEnforcement?: string;
  advisorWouldSuppress?: boolean;
  advisorExecutionAuthorized?: boolean;
  taskMutationAuthorized?: boolean;
  taskMutationAuthorizationReason?: string;
  currentQuestionSettlement?: {
    settlementId?: string;
    questionType?: string;
    relation?: string;
    authority?: string;
    disposition?: string;
    parentMutationAuthorized?: boolean;
    responseAuthorized?: boolean;
  };
  settledExecutionPlan?: {
    planId?: string;
    settlementId?: string;
    questionType?: string;
    modelRoute?: string;
    playbookId?: string;
    memoryUseCase?: string;
    authorized?: boolean;
    authorizationStage?: string;
  };
  advisorOutputDisposition?: string;
  adjacentConstraintInherited?: boolean;
  adjacentConstraintDecisionReason?: string;
  adjacentConstraintKinds?: string;
  adjacentConstraintDeltaMs?: number;
  adjacentQuestionOriginTraceId?: string;
  sentenceBufferOperationId?: string;
  sentenceBufferOperationRole?: string;
  sentenceBufferOutcome?: string;
  sentenceBufferDisposition?: string;
  sentenceBufferFlushReason?: string;
  sentenceBufferFragmentCount?: number;
  sentenceBufferAddedLatencyMs?: number;
  modelRoute?: string;
  memory?: {
    selectedEntries?: number;
    rejectedCount?: number;
    rejectSummary?: MemoryRejectSummary[];
    totalChars?: number;
    useCase?: string;
  };
  whiteboard?: {
    artifactId?: string;
    revision?: number;
    domainTrack?: string;
  };
  manualPhase?: {
    from?: string;
    to?: string;
    targetArtifact?: string;
    guardStatus?: string;
    committed?: boolean;
  };
  diagramOverlay?: {
    selectedEntryIds: string[];
    rejectedCount?: number;
    rejectSummary?: MemoryRejectSummary[];
  };
  artifacts: {
    traceExportPath: string;
    summaryPath: string;
  };
}

export interface SessionTaskReviewIndex {
  version: number;
  sessionId: string;
  savedAt: number;
  taskCount: number;
  tasks: SessionTaskReviewSummary[];
}

export interface SessionTaskReviewSummary {
  version: number;
  sessionId: string;
  taskId: string;
  traceIds: string[];
  traceCount: number;
  traceKinds: string[];
  statuses: string[];
  firstTraceStartedAt?: number;
  lastTraceEndedAt?: number;
  primaryQuestionType?: string;
  questionTypes: string[];
  taskSources: string[];
  askFrames: string[];
  topicDomains: string[];
  projectAnchors: string[];
  playbookIds: string[];
  playbookPhases: string[];
  turnGateActions: string[];
  turnGateReasons: string[];
  advisorTurnIntents: string[];
  advisorExecutionSuppressedCount: number;
  advisorShadowDecisionCount: number;
  taskMutationSuppressedCount: number;
  settlementDispositions: string[];
  settlementQuestionTypes: string[];
  settlementStaleDropCount: number;
  settledExecutionPlanIds: string[];
  adjacentConstraintInheritanceCount: number;
  sentenceBufferOperationCount: number;
  sentenceBufferMergedCount: number;
  sentenceBufferTimeoutCount: number;
  sentenceBufferAddedLatencyMsTotal: number;
  modelRoutes: string[];
  memoryUseCases: string[];
  memorySelectedEntriesTotal?: number;
  memoryRejectedCountTotal?: number;
  whiteboardArtifactIds: string[];
  manualPhaseTransitions: SessionTaskReviewManualPhase[];
  diagramOverlayIds: string[];
  diagramOverlayRejectedCountTotal?: number;
  humanEvaluation?: SessionTaskReviewHumanEvaluation;
  artifacts: {
    reviewSummaryPath: string;
    traceExportPaths: string[];
    traceSummaryPaths: string[];
  };
}

export interface SessionTaskReviewManualPhase {
  traceId: string;
  from?: string;
  to?: string;
  targetArtifact?: string;
  guardStatus?: string;
  committed?: boolean;
}

export interface SessionTaskReviewHumanEvaluation {
  questionIds: string[];
  traceIds: string[];
  classificationVerdicts: string[];
  playbookVerdicts: string[];
  playbookPhaseVerdicts: string[];
  memoryVerdicts: string[];
  whiteboardVerdicts: string[];
  manualPhaseTransitionVerdicts: string[];
  diagramOverlayVerdicts: string[];
  answerVerdicts: string[];
  settlementQuestionTypeLabels: string[];
  settlementRelationLabels: string[];
  settlementParentMutationLabels: string[];
  memoryEntryLabelCounts: Record<string, number>;
  missingExpectedMemoryCount: number;
  notesCount: number;
}

export function buildSessionTaskReviewIndex(
  sessionId: string,
  traceSummaries: TaskReviewTraceSummary[],
  questionEvaluations: QuestionHumanEvaluation[]
): SessionTaskReviewIndex {
  const tracesById = new Map(
    traceSummaries.map((summary) => [summary.traceId, summary])
  );
  const tracesByTaskId = new Map<string, TaskReviewTraceSummary[]>();
  const evaluationsByTaskId = new Map<string, QuestionHumanEvaluation[]>();

  for (const summary of traceSummaries) {
    for (const taskId of collectTaskIdsFromTraceSummary(summary)) {
      const traces = tracesByTaskId.get(taskId) ?? [];
      traces.push(summary);
      tracesByTaskId.set(taskId, traces);
    }
  }

  for (const evaluation of questionEvaluations) {
    const taskIds = uniqueStrings([
      ...collectTaskIdsFromEvaluation(evaluation),
      ...evaluation.traceIds.flatMap((traceId) =>
        collectTaskIdsFromTraceSummary(tracesById.get(traceId))
      ),
    ]);
    for (const taskId of taskIds) {
      const evaluations = evaluationsByTaskId.get(taskId) ?? [];
      evaluations.push(evaluation);
      evaluationsByTaskId.set(taskId, evaluations);
    }
  }

  const taskIds = uniqueStrings([
    ...Array.from(tracesByTaskId.keys()),
    ...Array.from(evaluationsByTaskId.keys()),
  ]).sort();
  const tasks = taskIds
    .map((taskId) =>
      buildSessionTaskReviewSummary({
        sessionId,
        taskId,
        traceSummaries: tracesByTaskId.get(taskId) ?? [],
        questionEvaluations: evaluationsByTaskId.get(taskId) ?? [],
      })
    )
    .sort(
      (left, right) =>
        (left.firstTraceStartedAt ?? Number.MAX_SAFE_INTEGER) -
          (right.firstTraceStartedAt ?? Number.MAX_SAFE_INTEGER) ||
        left.taskId.localeCompare(right.taskId)
    );

  return {
    version: SESSION_TASK_REVIEW_INDEX_SCHEMA_VERSION,
    sessionId,
    savedAt: Date.now(),
    taskCount: tasks.length,
    tasks,
  };
}

function buildSessionTaskReviewSummary({
  sessionId,
  taskId,
  traceSummaries,
  questionEvaluations,
}: {
  sessionId: string;
  taskId: string;
  traceSummaries: TaskReviewTraceSummary[];
  questionEvaluations: QuestionHumanEvaluation[];
}): SessionTaskReviewSummary {
  const traces = [...traceSummaries].sort(
    (left, right) => left.startedAt - right.startedAt
  );
  const traceIds = traces.map((trace) => trace.traceId);
  const reviewSummaryPath = `tasks/${sanitizeFilePart(taskId)}/review-summary.json`;
  const traceEndTimes = traces
    .map((trace) => trace.endedAt)
    .filter((value): value is number => typeof value === "number");
  const memorySelectedEntriesTotal = sumDefined(
    traces.map((trace) => trace.memory?.selectedEntries)
  );
  const memoryRejectedCountTotal = sumDefined(
    traces.map((trace) => trace.memory?.rejectedCount)
  );
  const diagramOverlayRejectedCountTotal = sumDefined(
    traces.map((trace) => trace.diagramOverlay?.rejectedCount)
  );
  const sentenceBufferOperations = collectSentenceBufferOperations(traces);

  return {
    version: SESSION_TASK_REVIEW_INDEX_SCHEMA_VERSION,
    sessionId,
    taskId,
    traceIds,
    traceCount: traces.length,
    traceKinds: uniqueStrings(traces.map((trace) => trace.traceKind)),
    statuses: uniqueStrings(traces.map((trace) => trace.status)),
    firstTraceStartedAt: traces[0]?.startedAt,
    lastTraceEndedAt: traceEndTimes[traceEndTimes.length - 1],
    primaryQuestionType: firstDefined(
      traces.map((trace) => trace.questionType)
    ),
    questionTypes: uniqueStrings(traces.map((trace) => trace.questionType)),
    taskSources: uniqueStrings(
      traces.map((trace) => trace.activeMeetingTaskSource)
    ),
    askFrames: uniqueStrings(traces.map((trace) => trace.askFrame)),
    topicDomains: uniqueStrings(traces.map((trace) => trace.topicDomain)),
    projectAnchors: uniqueStrings(traces.map((trace) => trace.projectAnchor)),
    playbookIds: uniqueStrings(traces.map((trace) => trace.playbookId)),
    playbookPhases: uniqueStrings(traces.map((trace) => trace.playbookPhase)),
    turnGateActions: uniqueStrings(traces.map((trace) => trace.turnGateAction)),
    turnGateReasons: uniqueStrings(traces.map((trace) => trace.turnGateReason)),
    advisorTurnIntents: uniqueStrings(
      traces.map((trace) => trace.advisorTurnIntent)
    ),
    advisorExecutionSuppressedCount: traces.filter(
      (trace) => trace.advisorExecutionAuthorized === false
    ).length,
    advisorShadowDecisionCount: traces.filter(
      (trace) => trace.advisorTurnEnforcement === "shadow"
    ).length,
    taskMutationSuppressedCount: traces.filter(
      (trace) => trace.taskMutationAuthorized === false
    ).length,
    settlementDispositions: uniqueStrings(
      traces.map(
        (trace) => trace.currentQuestionSettlement?.disposition
      )
    ),
    settlementQuestionTypes: uniqueStrings(
      traces.map(
        (trace) => trace.currentQuestionSettlement?.questionType
      )
    ),
    settlementStaleDropCount: traces.filter(
      (trace) =>
        trace.currentQuestionSettlement?.disposition ===
        "stale-dropped"
    ).length,
    settledExecutionPlanIds: uniqueStrings(
      traces.map((trace) => trace.settledExecutionPlan?.planId)
    ),
    adjacentConstraintInheritanceCount: traces.filter(
      (trace) => trace.adjacentConstraintInherited === true
    ).length,
    sentenceBufferOperationCount: sentenceBufferOperations.length,
    sentenceBufferMergedCount: sentenceBufferOperations.filter(
      (trace) => getSentenceBufferOutcome(trace) === "merged"
    ).length,
    sentenceBufferTimeoutCount: sentenceBufferOperations.filter(
      (trace) => getSentenceBufferOutcome(trace) === "timeout"
    ).length,
    sentenceBufferAddedLatencyMsTotal: sentenceBufferOperations.reduce(
      (total, trace) => total + (trace.sentenceBufferAddedLatencyMs ?? 0),
      0
    ),
    modelRoutes: uniqueStrings(traces.map((trace) => trace.modelRoute)),
    memoryUseCases: uniqueStrings(
      traces.map((trace) => trace.memory?.useCase)
    ),
    memorySelectedEntriesTotal,
    memoryRejectedCountTotal,
    whiteboardArtifactIds: uniqueStrings(
      traces.map((trace) => trace.whiteboard?.artifactId)
    ),
    manualPhaseTransitions: traces.flatMap((trace) =>
      trace.manualPhase
        ? [
            {
              traceId: trace.traceId,
              from: trace.manualPhase.from,
              to: trace.manualPhase.to,
              targetArtifact: trace.manualPhase.targetArtifact,
              guardStatus: trace.manualPhase.guardStatus,
              committed: trace.manualPhase.committed,
            },
          ]
        : []
    ),
    diagramOverlayIds: uniqueStrings(
      traces.flatMap((trace) => trace.diagramOverlay?.selectedEntryIds ?? [])
    ),
    diagramOverlayRejectedCountTotal,
    humanEvaluation: questionEvaluations.length
      ? buildSessionTaskReviewHumanEvaluation(questionEvaluations)
      : undefined,
    artifacts: {
      reviewSummaryPath,
      traceExportPaths: uniqueStrings(
        traces.map((trace) => trace.artifacts.traceExportPath)
      ),
      traceSummaryPaths: uniqueStrings(
        traces.map((trace) => trace.artifacts.summaryPath)
      ),
    },
  };
}

function buildSessionTaskReviewHumanEvaluation(
  evaluations: QuestionHumanEvaluation[]
): SessionTaskReviewHumanEvaluation {
  return {
    questionIds: uniqueStrings(evaluations.map((evaluation) => evaluation.questionId)),
    traceIds: uniqueStrings(evaluations.flatMap((evaluation) => evaluation.traceIds)),
    classificationVerdicts: uniqueStrings(
      evaluations.map((evaluation) => evaluation.classification.verdict)
    ),
    playbookVerdicts: uniqueStrings(
      evaluations.map((evaluation) => evaluation.playbook.verdict)
    ),
    playbookPhaseVerdicts: uniqueStrings(
      evaluations.map((evaluation) => evaluation.playbookPhase.verdict)
    ),
    memoryVerdicts: uniqueStrings(
      evaluations.map((evaluation) => evaluation.memory.verdict)
    ),
    whiteboardVerdicts: uniqueStrings(
      evaluations.map((evaluation) => evaluation.whiteboard.verdict)
    ),
    manualPhaseTransitionVerdicts: uniqueStrings(
      evaluations.map((evaluation) => evaluation.manualPhaseTransition.verdict)
    ),
    diagramOverlayVerdicts: uniqueStrings(
      evaluations.map((evaluation) => evaluation.diagramOverlay.verdict)
    ),
    answerVerdicts: uniqueStrings(
      evaluations.map((evaluation) => evaluation.answer.verdict)
    ),
    settlementQuestionTypeLabels: booleanLabels(
      evaluations.map(
        (evaluation) =>
          evaluation.currentQuestionSettlement?.questionTypeCorrect
      )
    ),
    settlementRelationLabels: booleanLabels(
      evaluations.map(
        (evaluation) =>
          evaluation.currentQuestionSettlement?.relationCorrect
      )
    ),
    settlementParentMutationLabels: booleanLabels(
      evaluations.map(
        (evaluation) =>
          evaluation.currentQuestionSettlement?.parentMutationCorrect
      )
    ),
    memoryEntryLabelCounts: countMemoryEntryLabels(evaluations),
    missingExpectedMemoryCount: evaluations.reduce(
      (total, evaluation) => total + evaluation.missingExpectedMemory.length,
      0
    ),
    notesCount: evaluations.filter((evaluation) => evaluation.notes?.trim())
      .length,
  };
}

function collectTaskIdsFromTraceSummary(
  summary: TaskReviewTraceSummary | undefined
) {
  if (!summary) return [];

  return uniqueStrings([
    ...summary.taskIds,
    summary.primaryTaskId,
    summary.activeMeetingTaskId,
    summary.activeMeetingParentId,
    summary.activeMeetingChildId,
    summary.activeScreenTaskId,
    summary.activeInterviewParentId,
    summary.activeInterviewChildId,
  ]);
}

function collectTaskIdsFromEvaluation(evaluation: QuestionHumanEvaluation) {
  return uniqueStrings([
    evaluation.taskId,
    evaluation.parentTaskId,
    evaluation.childTaskId,
  ]);
}

function collectSentenceBufferOperations(traces: TaskReviewTraceSummary[]) {
  const operations = new Map<string, TaskReviewTraceSummary>();

  for (const trace of traces) {
    if (!isSentenceBufferTerminalTrace(trace)) continue;

    const operationKey =
      trace.sentenceBufferOperationId ?? `legacy:${trace.traceId}`;
    if (!operations.has(operationKey)) {
      operations.set(operationKey, trace);
    }
  }

  return Array.from(operations.values());
}

function isSentenceBufferTerminalTrace(trace: TaskReviewTraceSummary) {
  if (trace.sentenceBufferOperationRole) {
    return trace.sentenceBufferOperationRole === "terminal";
  }

  if (trace.sentenceBufferDisposition === "merged-into-next") return false;
  if (trace.sentenceBufferDisposition?.startsWith("merged")) return true;
  if (trace.sentenceBufferFlushReason === "timeout") return true;
  return trace.sentenceBufferDisposition === "cancelled";
}

function getSentenceBufferOutcome(trace: TaskReviewTraceSummary) {
  if (trace.sentenceBufferOutcome) return trace.sentenceBufferOutcome;
  if (trace.sentenceBufferFlushReason === "timeout") return "timeout";
  if (trace.sentenceBufferDisposition?.startsWith("merged")) return "merged";
  if (trace.sentenceBufferDisposition === "cancelled") return "cancelled";
  return "flushed";
}

function countMemoryEntryLabels(evaluations: QuestionHumanEvaluation[]) {
  const counts: Record<string, number> = {};
  for (const evaluation of evaluations) {
    for (const label of evaluation.memoryEntryLabels) {
      counts[label.label] = (counts[label.label] ?? 0) + 1;
    }
  }

  return counts;
}

function booleanLabels(values: Array<boolean | undefined>) {
  return uniqueStrings(
    values.map((value) =>
      value === true ? "correct" : value === false ? "wrong" : undefined
    )
  );
}

function sumDefined(values: Array<number | undefined>) {
  let total = 0;
  let seen = false;
  for (const value of values) {
    if (typeof value !== "number") continue;
    total += value;
    seen = true;
  }

  return seen ? total : undefined;
}

function firstDefined(values: Array<string | undefined>) {
  return values.find((value): value is string => Boolean(value));
}

function sanitizeFilePart(value: string) {
  const sanitized = value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "artifact";
}

function uniqueStrings(values: Array<string | undefined>) {
  return Array.from(
    new Set(values.filter((value): value is string => Boolean(value)))
  );
}
