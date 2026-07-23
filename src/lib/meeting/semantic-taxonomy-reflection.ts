import {
  CANONICAL_QUESTION_TYPES,
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";

export interface SemanticTaxonomyRecordedDecision {
  recordedAt: number;
  sessionId?: string;
  traceId: string;
  taskId?: string;
  metadata: Record<string, unknown>;
}

export interface SemanticTaxonomyEvaluationLabel {
  id: string;
  questionId: string;
  traceIds: string[];
  questionType?: string;
  correctedQuestionType?: string;
  manualQuestionTypeCorrectionId?: string;
  classification?: {
    verdict?: "ok" | "partial" | "wrong" | "not_applicable";
  };
  updatedAt: number;
}

export interface SemanticTaxonomyRuntimeTrace {
  id: string;
  status: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  metadata: Record<string, unknown>;
  steps?: Array<{
    name: string;
    status: string;
    error?: string;
  }>;
}

export type SemanticTaxonomyTrajectoryFailureKind =
  | "classification-correct-but-mutation-lost"
  | "late-parent-missing-question-context"
  | "stale-parent-continuity-after-switch"
  | "manual-correction-required"
  | "unlabeled-insufficient-evidence";

export interface SemanticTaxonomyReflectionRow {
  key: string;
  sessionId?: string;
  turnId?: string;
  traceIds: string[];
  taskIds: string[];
  mode?: string;
  lexicalType: CanonicalQuestionType;
  lexicalConfidence?: number;
  lexicalMargin?: number;
  semanticCandidateType?: CanonicalQuestionType;
  semanticTopCandidateType?: CanonicalQuestionType;
  semanticTopCandidateScore?: number;
  semanticRunnerUpType?: CanonicalQuestionType;
  semanticRunnerUpScore?: number;
  semanticRejectionReasons: string[];
  semanticConfidence?: number;
  semanticMargin?: number;
  hybridOutcome?: string;
  hybridRecommendedType?: CanonicalQuestionType;
  effectiveType: CanonicalQuestionType;
  wouldRescue: boolean;
  rescueApplied: boolean;
  parentMutationBlocked: boolean;
  enforcementReason?: string;
  embeddingStatus?: string;
  embeddingDurationMs?: number;
  cacheHit?: boolean;
  evaluationId?: string;
  questionId?: string;
  expectedType?: CanonicalQuestionType;
  labelOutcome: "confirmed" | "corrected" | "unlabeled";
  rescueCorrect?: boolean;
  correctionAfterRescue: boolean;
}

export interface SemanticTaxonomyTrajectoryRow {
  key: string;
  sessionId?: string;
  questionId?: string;
  turnIds: string[];
  traceIds: string[];
  detectedType: CanonicalQuestionType;
  expectedType?: CanonicalQuestionType;
  classificationCorrect?: boolean;
  taskRelation?: string;
  taskMutationRequested: boolean;
  taskMutationApplied: boolean;
  runtimeCommitAuthorized: boolean;
  advisorOutcomes: string[];
  parentBeforeId?: string;
  parentAfterId?: string;
  parentBeforeType?: CanonicalQuestionType;
  parentAfterType?: CanonicalQuestionType;
  logicalQuestionSourceTurnIds: string[];
  canonicalQuestionSourceTurnIds: string[];
  currentLogicalQuestionCoverage?: number;
  questionContextCoverage?: number;
  inheritedParentQuestionAvailable: boolean;
  boundedHandoffAvailable: boolean;
  advisorPromptIncludedLogicalQuestion?: boolean;
  manualCorrectionApplied: boolean;
  failureKinds: SemanticTaxonomyTrajectoryFailureKind[];
}

export interface SemanticTaxonomyReflectionReport {
  version: 2;
  generatedAt: number;
  sessions: string[];
  metrics: {
    decisions: number;
    labeled: number;
    unlabeled: number;
    missingSemanticEvidenceForLabels: number;
    wouldRescue: number;
    rescueApplied: number;
    labeledRescueApplied: number;
    correctRescueApplied: number;
    rescuePrecision: number | null;
    rescueRecall: number | null;
    correctionAfterRescue: number;
    parentMutationBlocked: number;
    embeddingStatus: Record<string, number>;
    cacheHitRate: number | null;
    embeddingLatency: {
      samples: number;
      p50Ms: number;
      p95Ms: number;
      maxMs: number;
    };
    trajectory: {
      questions: number;
      labeled: number;
      classificationCorrectButMutationLost: number;
      lateParentMissingQuestionContext: number;
      staleParentContinuityAfterSwitch: number;
      manualCorrectionRequired: number;
      unlabeledInsufficientEvidence: number;
    };
  };
  confusionMatrix: Record<
    CanonicalQuestionType,
    Record<CanonicalQuestionType, number>
  >;
  rows: SemanticTaxonomyReflectionRow[];
  trajectoryRows: SemanticTaxonomyTrajectoryRow[];
  unmatchedLabeledQuestions: Array<{
    evaluationId: string;
    questionId: string;
    expectedType?: CanonicalQuestionType;
    traceIds: string[];
    reason: "missing-semantic-taxonomy-evidence";
  }>;
  reviewProposals: {
    reviewOnly: true;
    automaticMutationAllowed: false;
    prototypeCandidates: Array<{
      expectedType: CanonicalQuestionType;
      observedType?: CanonicalQuestionType;
      evidenceKeys: string[];
      recommendation: string;
    }>;
    thresholdCandidates: Array<{
      candidateType: CanonicalQuestionType;
      evidenceKeys: string[];
      recommendation: string;
    }>;
  };
}

export function buildSemanticTaxonomyReflectionReport({
  decisions,
  evaluations,
  runtimeTraces = [],
}: {
  decisions: SemanticTaxonomyRecordedDecision[];
  evaluations: SemanticTaxonomyEvaluationLabel[];
  runtimeTraces?: SemanticTaxonomyRuntimeTrace[];
}): SemanticTaxonomyReflectionReport {
  const grouped = groupDecisions(decisions);
  const matchedEvaluationIds = new Set<string>();
  const rows = Array.from(grouped.entries())
    .map(([key, records]) => {
      const traceIds = unique(records.map((record) => record.traceId));
      const evaluation = findEvaluationForTraces(evaluations, traceIds);
      if (evaluation) matchedEvaluationIds.add(evaluation.id);
      return buildReflectionRow(key, records, evaluation);
    })
    .sort((left, right) => left.key.localeCompare(right.key));

  const unmatchedLabeledQuestions = evaluations
    .filter((evaluation) => !matchedEvaluationIds.has(evaluation.id))
    .map((evaluation) => ({
      evaluationId: evaluation.id,
      questionId: evaluation.questionId,
      expectedType: resolveExpectedType(evaluation),
      traceIds: unique(evaluation.traceIds),
      reason: "missing-semantic-taxonomy-evidence" as const,
    }));
  const labeledRows = rows.filter((row) => row.expectedType);
  const appliedRescues = rows.filter((row) => row.rescueApplied);
  const labeledAppliedRescues = appliedRescues.filter((row) => row.expectedType);
  const correctAppliedRescues = labeledAppliedRescues.filter(
    (row) => row.rescueCorrect
  );
  const rescueOpportunities = labeledRows.filter(
    (row) => row.lexicalType === "unknown" && row.expectedType !== "unknown"
  );
  const correctRescues = rescueOpportunities.filter(
    (row) => row.rescueApplied && row.rescueCorrect
  );
  const successfulEmbeddings = rows.filter(
    (row) => row.embeddingStatus === "success"
  );
  const embeddingDurations = rows
    .map((row) => row.embeddingDurationMs)
    .filter((value): value is number => typeof value === "number");
  const trajectoryRows = buildTrajectoryRows(rows, evaluations, runtimeTraces);

  return {
    version: 2,
    generatedAt: Date.now(),
    sessions: unique(rows.map((row) => row.sessionId).filter(isString)),
    metrics: {
      decisions: rows.length,
      labeled: labeledRows.length,
      unlabeled: rows.length - labeledRows.length,
      missingSemanticEvidenceForLabels: unmatchedLabeledQuestions.length,
      wouldRescue: rows.filter((row) => row.wouldRescue).length,
      rescueApplied: appliedRescues.length,
      labeledRescueApplied: labeledAppliedRescues.length,
      correctRescueApplied: correctAppliedRescues.length,
      rescuePrecision: ratioOrNull(
        correctAppliedRescues.length,
        labeledAppliedRescues.length
      ),
      rescueRecall: ratioOrNull(
        correctRescues.length,
        rescueOpportunities.length
      ),
      correctionAfterRescue: rows.filter((row) => row.correctionAfterRescue)
        .length,
      parentMutationBlocked: rows.filter((row) => row.parentMutationBlocked)
        .length,
      embeddingStatus: countStrings(
        rows.map((row) => row.embeddingStatus ?? "unknown")
      ),
      cacheHitRate: ratioOrNull(
        successfulEmbeddings.filter((row) => row.cacheHit).length,
        successfulEmbeddings.length
      ),
      embeddingLatency: summarizeLatency(embeddingDurations),
      trajectory: {
        questions: trajectoryRows.length,
        labeled: trajectoryRows.filter((row) => row.expectedType).length,
        classificationCorrectButMutationLost: countTrajectoryFailure(
          trajectoryRows,
          "classification-correct-but-mutation-lost"
        ),
        lateParentMissingQuestionContext: countTrajectoryFailure(
          trajectoryRows,
          "late-parent-missing-question-context"
        ),
        staleParentContinuityAfterSwitch: countTrajectoryFailure(
          trajectoryRows,
          "stale-parent-continuity-after-switch"
        ),
        manualCorrectionRequired: countTrajectoryFailure(
          trajectoryRows,
          "manual-correction-required"
        ),
        unlabeledInsufficientEvidence: countTrajectoryFailure(
          trajectoryRows,
          "unlabeled-insufficient-evidence"
        ),
      },
    },
    confusionMatrix: buildConfusionMatrix(labeledRows),
    rows,
    trajectoryRows,
    unmatchedLabeledQuestions,
    reviewProposals: buildReviewProposals(rows),
  };
}

export function renderSemanticTaxonomyReflectionMarkdown(
  report: SemanticTaxonomyReflectionReport
) {
  const percent = (value: number | null) =>
    value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
  const lines = [
    "# Semantic Taxonomy Reflection",
    "",
    `Generated: ${new Date(report.generatedAt).toISOString()}`,
    `Sessions: ${report.sessions.join(", ") || "-"}`,
    "",
    "## Summary",
    "",
    `- Decisions: ${report.metrics.decisions}`,
    `- Labeled / unlabeled: ${report.metrics.labeled} / ${report.metrics.unlabeled}`,
    `- Missing semantic evidence for labels: ${report.metrics.missingSemanticEvidenceForLabels}`,
    `- Would rescue / applied: ${report.metrics.wouldRescue} / ${report.metrics.rescueApplied}`,
    `- Rescue precision / recall: ${percent(report.metrics.rescuePrecision)} / ${percent(report.metrics.rescueRecall)}`,
    `- Correction after rescue: ${report.metrics.correctionAfterRescue}`,
    `- Parent mutation blocked: ${report.metrics.parentMutationBlocked}`,
    `- Trajectory questions / labeled: ${report.metrics.trajectory.questions} / ${report.metrics.trajectory.labeled}`,
    `- Classification correct but mutation lost: ${report.metrics.trajectory.classificationCorrectButMutationLost}`,
    `- Late parent missing question context: ${report.metrics.trajectory.lateParentMissingQuestionContext}`,
    `- Stale parent continuity after switch: ${report.metrics.trajectory.staleParentContinuityAfterSwitch}`,
    `- Embedding p50 / p95: ${report.metrics.embeddingLatency.p50Ms.toFixed(1)}ms / ${report.metrics.embeddingLatency.p95Ms.toFixed(1)}ms`,
    "",
    "## Decision Evidence",
    "",
    "| Turn | Lexical | Semantic accepted | Semantic top | Effective | Rescue | Parent block | HITL | Latency |",
    "|---|---|---|---|---|---|---|---|---|",
    ...report.rows.map(
      (row) =>
        `| ${escapeCell(row.turnId ?? row.key)} | ${row.lexicalType} | ${row.semanticCandidateType ?? "-"} | ${formatSemanticTopCandidate(row)} | ${row.effectiveType} | ${row.rescueApplied ? "applied" : row.wouldRescue ? "would" : "-"} | ${row.parentMutationBlocked ? "yes" : "no"} | ${row.expectedType ? `${row.labelOutcome}:${row.expectedType}` : "unlabeled"} | ${row.embeddingDurationMs?.toFixed(1) ?? "-"}ms |`
    ),
    "",
    "## Question Trajectory",
    "",
    "| Question | Turns | Detected / expected | Relation | Mutation | Parent before / after | Advisor | Context | Failures |",
    "|---|---|---|---|---|---|---|---|---|",
    ...report.trajectoryRows.map(
      (row) =>
        `| ${escapeCell(row.questionId ?? row.key)} | ${row.turnIds.length} | ${row.detectedType} / ${row.expectedType ?? "unlabeled"} | ${row.taskRelation ?? "-"} | ${row.taskMutationRequested ? (row.taskMutationApplied ? "applied" : "requested-only") : "-"} | ${row.parentBeforeType ?? "-"}:${shortId(row.parentBeforeId)} / ${row.parentAfterType ?? "-"}:${shortId(row.parentAfterId)} | ${row.advisorOutcomes.join(", ") || "-"} | ${row.questionContextCoverage === undefined ? "N/A" : percent(row.questionContextCoverage)} | ${row.failureKinds.join(", ") || "-"} |`
    ),
    "",
    "## Review Proposals",
    "",
    "These are review-only proposals. This report never mutates runtime prototypes or thresholds.",
    "",
    ...report.reviewProposals.prototypeCandidates.map(
      (proposal) =>
        `- Prototype: ${proposal.recommendation} Evidence: ${proposal.evidenceKeys.join(", ")}.`
    ),
    ...report.reviewProposals.thresholdCandidates.map(
      (proposal) =>
        `- Threshold: ${proposal.recommendation} Evidence: ${proposal.evidenceKeys.join(", ")}.`
    ),
  ];
  if (
    !report.reviewProposals.prototypeCandidates.length &&
    !report.reviewProposals.thresholdCandidates.length
  ) {
    lines.push("- No reviewed change proposal from the available labels.");
  }
  if (report.unmatchedLabeledQuestions.length) {
    lines.push("", "## Joinability Gaps", "");
    for (const item of report.unmatchedLabeledQuestions) {
      lines.push(
        `- ${item.evaluationId}: ${item.reason}; traces=${item.traceIds.join(", ") || "-"}.`
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function groupDecisions(decisions: SemanticTaxonomyRecordedDecision[]) {
  const grouped = new Map<string, SemanticTaxonomyRecordedDecision[]>();
  for (const decision of decisions) {
    const turnId = readString(decision.metadata, "semanticTaxonomyTurnId");
    const sessionId =
      readString(decision.metadata, "semanticTaxonomySessionId") ??
      decision.sessionId ??
      "unknown-session";
    const key = `${sessionId}:${turnId ?? decision.traceId}`;
    const records = grouped.get(key) ?? [];
    records.push(decision);
    grouped.set(key, records);
  }
  for (const records of grouped.values()) {
    records.sort((left, right) => left.recordedAt - right.recordedAt);
  }
  return grouped;
}

function buildReflectionRow(
  key: string,
  records: SemanticTaxonomyRecordedDecision[],
  evaluation?: SemanticTaxonomyEvaluationLabel
): SemanticTaxonomyReflectionRow {
  const metadata = records.map((record) => record.metadata).reverse();
  const lexicalType =
    readCanonical(metadata, "taxonomyKeywordType") ?? "unknown";
  const effectiveType =
    readCanonical(metadata, "taxonomyHybridEffectiveType") ?? lexicalType;
  const expectedType = evaluation ? resolveExpectedType(evaluation) : undefined;
  const rescueApplied = readBoolean(metadata, "taxonomySemanticRescueApplied");
  const corrected = Boolean(
    evaluation?.manualQuestionTypeCorrectionId ||
      (expectedType && expectedType !== effectiveType)
  );
  const semanticScores = readNumberRecord(
    metadata,
    "taxonomySemanticPerTypeScores"
  );
  const semanticRanking = rankCanonicalScores(semanticScores);
  return {
    key,
    sessionId:
      readFirst(metadata, "semanticTaxonomySessionId") ?? records[0]?.sessionId,
    turnId: readFirst(metadata, "semanticTaxonomyTurnId"),
    traceIds: unique(records.map((record) => record.traceId)),
    taskIds: unique(records.map((record) => record.taskId).filter(isString)),
    mode: readFirst(metadata, "semanticTaxonomyMode"),
    lexicalType,
    lexicalConfidence: readNumber(metadata, "taxonomyKeywordConfidence"),
    lexicalMargin: readNumber(metadata, "taxonomyKeywordMargin"),
    semanticCandidateType: readCanonical(
      metadata,
      "taxonomySemanticCandidateType"
    ),
    semanticTopCandidateType: semanticRanking[0]?.type,
    semanticTopCandidateScore: semanticRanking[0]?.score,
    semanticRunnerUpType: semanticRanking[1]?.type,
    semanticRunnerUpScore: semanticRanking[1]?.score,
    semanticRejectionReasons: readStringArray(
      metadata,
      "taxonomySemanticRejectionReasons"
    ),
    semanticConfidence: readNumber(metadata, "taxonomySemanticConfidence"),
    semanticMargin: readNumber(metadata, "taxonomySemanticMargin"),
    hybridOutcome: readFirst(metadata, "taxonomyHybridOutcome"),
    hybridRecommendedType: readCanonical(
      metadata,
      "taxonomyHybridRecommendedType"
    ),
    effectiveType,
    wouldRescue: readBoolean(metadata, "taxonomyHybridWouldRescue"),
    rescueApplied,
    parentMutationBlocked: readBoolean(
      metadata,
      "taxonomySemanticParentMutationBlocked"
    ),
    enforcementReason: readFirst(
      metadata,
      "taxonomySemanticEnforcementReason"
    ),
    embeddingStatus: readFirst(metadata, "taxonomySemanticEmbeddingStatus"),
    embeddingDurationMs: readNumber(metadata, "taxonomySemanticDurationMs"),
    cacheHit: readBoolean(metadata, "taxonomySemanticCacheHit"),
    evaluationId: evaluation?.id,
    questionId: evaluation?.questionId,
    expectedType,
    labelOutcome: expectedType
      ? corrected
        ? "corrected"
        : "confirmed"
      : "unlabeled",
    rescueCorrect:
      rescueApplied && expectedType
        ? effectiveType === expectedType
        : undefined,
    correctionAfterRescue:
      rescueApplied && corrected && expectedType !== effectiveType,
  };
}

function buildTrajectoryRows(
  rows: SemanticTaxonomyReflectionRow[],
  evaluations: SemanticTaxonomyEvaluationLabel[],
  runtimeTraces: SemanticTaxonomyRuntimeTrace[]
) {
  const traceById = new Map(runtimeTraces.map((trace) => [trace.id, trace]));
  const evaluationById = new Map(
    evaluations.map((evaluation) => [evaluation.id, evaluation])
  );
  const groups = new Map<
    string,
    {
      rows: SemanticTaxonomyReflectionRow[];
      traceIds: Set<string>;
      evaluation?: SemanticTaxonomyEvaluationLabel;
    }
  >();
  for (const row of rows) {
    const evaluation = row.evaluationId
      ? evaluationById.get(row.evaluationId)
      : undefined;
    const runtimeQuestionId = row.traceIds
      .map((traceId) => traceById.get(traceId))
      .map((trace) =>
        trace ? readString(trace.metadata, "questionInstanceId") : undefined
      )
      .find(isString);
    const key = row.questionId ?? runtimeQuestionId ?? row.key;
    const group = groups.get(key) ?? {
      rows: [],
      traceIds: new Set<string>(),
      evaluation,
    };
    group.rows.push(row);
    for (const traceId of row.traceIds) group.traceIds.add(traceId);
    for (const traceId of evaluation?.traceIds ?? []) group.traceIds.add(traceId);
    group.evaluation = newerEvaluation(group.evaluation, evaluation);
    groups.set(key, group);
  }

  return Array.from(groups.entries())
    .map(([key, group]) => {
      const traces = Array.from(group.traceIds)
        .map((traceId) => traceById.get(traceId))
        .filter((trace): trace is SemanticTaxonomyRuntimeTrace => Boolean(trace))
        .sort(
          (left, right) =>
            (left.startedAt ?? 0) - (right.startedAt ?? 0)
        );
      const metadata = traces.map((trace) => trace.metadata).reverse();
      const latestRow = group.rows[group.rows.length - 1];
      const expectedType = group.evaluation
        ? resolveExpectedType(group.evaluation)
        : group.rows.map((row) => row.expectedType).find(isCanonical);
      const detectedType =
        readCanonical(metadata, "questionType") ??
        readCanonical(metadata, "questionTypeInferenceType") ??
        latestRow?.effectiveType ??
        "unknown";
      const taskRelation = readFirst(metadata, "taskRelation");
      const taskMutationRequested = readBoolean(
        metadata,
        "advisorTaskMutationCommitParent"
      );
      const taskMutationApplied =
        readBoolean(metadata, "startedNewInterviewParent") ||
        readBoolean(metadata, "taskBoundaryMutationApplied");
      const runtimeCommitAuthorized = readBoolean(
        metadata,
        "runtimeCommitAuthorized"
      );
      const advisorOutcomes = unique(
        traces
          .flatMap((trace) => [
            readString(trace.metadata, "advisorJobOutcome"),
            trace.steps?.find((step) => step.name === "Advisor model response")
              ?.status,
          ])
          .filter(isString)
      );
      const logicalQuestionSourceTurnIds = unique(
        metadata.flatMap((source) =>
          readStringArrayFromSource(source, "logicalQuestionSourceTurnIds")
        )
      );
      const canonicalQuestionSourceTurnIds = unique(
        metadata.flatMap((source) =>
          readStringArrayFromSource(
            source,
            "canonicalQuestionSourceTurnIds"
          )
        )
      );
      const questionContextCoverage = calculateContextCoverage(
        logicalQuestionSourceTurnIds,
        canonicalQuestionSourceTurnIds
      );
      const parentBeforeId =
        readFirst(metadata, "runtimeExpectedParentId") ??
        readFirst(metadata, "advisorJobExpectedParentId");
      const parentAfterId =
        readFirst(metadata, "newParentId") ??
        readFirst(metadata, "activeMeetingParentId");
      const inheritedParentQuestionAvailable = Boolean(
        taskRelation === "followup-parent" &&
          parentBeforeId &&
          parentAfterId &&
          parentBeforeId === parentAfterId
      );
      const boundedHandoffAvailable = Boolean(
        readFirst(metadata, "parentContextHandoffSourceId") ??
          readFirst(metadata, "activeMeetingParentHandoffSourceId")
      );
      const advisorPromptIncludedLogicalQuestion = readOptionalBoolean(
        metadata,
        "advisorPromptIncludedLogicalQuestion"
      );
      const manualCorrectionApplied = Boolean(
        group.evaluation?.manualQuestionTypeCorrectionId ||
          readFirst(metadata, "manualQuestionTypeCorrectionId") ||
          readBoolean(metadata, "manualQuestionTypeCorrectionApplied") ||
          (expectedType && expectedType !== detectedType)
      );
      const failureKinds: SemanticTaxonomyTrajectoryFailureKind[] = [];
      const advisorCancelled = advisorOutcomes.some((outcome) =>
        /cancel|replaced/i.test(outcome)
      );
      if (
        taskRelation === "new-parent" &&
        taskMutationRequested &&
        runtimeCommitAuthorized &&
        !taskMutationApplied &&
        advisorCancelled
      ) {
        failureKinds.push("classification-correct-but-mutation-lost");
      }
      if (
        advisorPromptIncludedLogicalQuestion === false
      ) {
        failureKinds.push("late-parent-missing-question-context");
      }
      if (
        expectedType &&
        expectedType !== detectedType &&
        taskRelation === "followup-parent"
      ) {
        failureKinds.push("stale-parent-continuity-after-switch");
      }
      if (manualCorrectionApplied) {
        failureKinds.push("manual-correction-required");
      }
      if (!expectedType) {
        failureKinds.push("unlabeled-insufficient-evidence");
      }
      return {
        key,
        sessionId: latestRow?.sessionId,
        questionId: group.evaluation?.questionId ?? key,
        turnIds: unique(group.rows.map((row) => row.turnId).filter(isString)),
        traceIds: Array.from(group.traceIds),
        detectedType,
        expectedType,
        classificationCorrect:
          expectedType === undefined ? undefined : expectedType === detectedType,
        taskRelation,
        taskMutationRequested,
        taskMutationApplied,
        runtimeCommitAuthorized,
        advisorOutcomes,
        parentBeforeId,
        parentAfterId,
        parentBeforeType:
          readCanonical(metadata, "runtimeExpectedParentType") ??
          readCanonical(metadata, "parentTaskKind"),
        parentAfterType: readCanonical(
          metadata,
          "activeMeetingParentQuestionType"
        ),
        logicalQuestionSourceTurnIds,
        canonicalQuestionSourceTurnIds,
        currentLogicalQuestionCoverage: questionContextCoverage,
        questionContextCoverage,
        inheritedParentQuestionAvailable,
        boundedHandoffAvailable,
        advisorPromptIncludedLogicalQuestion,
        manualCorrectionApplied,
        failureKinds: unique(failureKinds),
      } satisfies SemanticTaxonomyTrajectoryRow;
    })
    .sort((left, right) => left.key.localeCompare(right.key));
}

function findEvaluationForTraces(
  evaluations: SemanticTaxonomyEvaluationLabel[],
  traceIds: string[]
) {
  const traceSet = new Set(traceIds);
  return evaluations
    .filter((evaluation) =>
      evaluation.traceIds.some((traceId) => traceSet.has(traceId))
    )
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

function resolveExpectedType(evaluation: SemanticTaxonomyEvaluationLabel) {
  const corrected = normalizeCanonicalQuestionType(
    evaluation.correctedQuestionType
  );
  if (corrected) return corrected;
  if (evaluation.classification?.verdict !== "ok") return undefined;
  return normalizeCanonicalQuestionType(evaluation.questionType);
}

function buildConfusionMatrix(rows: SemanticTaxonomyReflectionRow[]) {
  const matrix = Object.fromEntries(
    CANONICAL_QUESTION_TYPES.map((expected) => [
      expected,
      Object.fromEntries(
        CANONICAL_QUESTION_TYPES.map((observed) => [observed, 0])
      ),
    ])
  ) as Record<
    CanonicalQuestionType,
    Record<CanonicalQuestionType, number>
  >;
  for (const row of rows) {
    if (row.expectedType) matrix[row.expectedType][row.effectiveType] += 1;
  }
  return matrix;
}

function buildReviewProposals(rows: SemanticTaxonomyReflectionRow[]) {
  const falseRescues = rows.filter(
    (row) =>
      (row.rescueApplied || row.wouldRescue) &&
      row.expectedType &&
      row.hybridRecommendedType &&
      row.hybridRecommendedType !== row.expectedType
  );
  const missed = rows.filter(
    (row) =>
      row.lexicalType === "unknown" &&
      row.expectedType &&
      row.expectedType !== "unknown" &&
      !row.wouldRescue
  );
  const thresholdGroups = groupBy(
    falseRescues,
    (row) => row.hybridRecommendedType ?? row.semanticCandidateType
  );
  const prototypeGroups = groupBy(missed, (row) => row.expectedType);
  return {
    reviewOnly: true as const,
    automaticMutationAllowed: false as const,
    prototypeCandidates: Array.from(prototypeGroups.entries()).map(
      ([expectedType, evidence]) => ({
        expectedType,
        observedType: evidence[0]?.semanticCandidateType,
        evidenceKeys: evidence.map((row) => row.key),
        recommendation: `Review positive prototypes or hard negatives for ${expectedType}; do not auto-add session text.`,
      })
    ),
    thresholdCandidates: Array.from(thresholdGroups.entries()).map(
      ([candidateType, evidence]) => ({
        candidateType,
        evidenceKeys: evidence.map((row) => row.key),
        recommendation: `Review ${candidateType} calibration because labeled evidence disagreed with a proposed rescue.`,
      })
    ),
  };
}

function groupBy(
  rows: SemanticTaxonomyReflectionRow[],
  keyOf: (row: SemanticTaxonomyReflectionRow) => CanonicalQuestionType | undefined
) {
  const grouped = new Map<CanonicalQuestionType, SemanticTaxonomyReflectionRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    const values = grouped.get(key) ?? [];
    values.push(row);
    grouped.set(key, values);
  }
  return grouped;
}

function summarizeLatency(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.length ? sorted[sorted.length - 1] : 0,
  };
}

function percentile(sorted: number[], percentileValue: number) {
  if (!sorted.length) return 0;
  return sorted[Math.ceil((sorted.length - 1) * percentileValue)] ?? 0;
}

function countStrings(values: string[]) {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function countTrajectoryFailure(
  rows: SemanticTaxonomyTrajectoryRow[],
  failureKind: SemanticTaxonomyTrajectoryFailureKind
) {
  return rows.filter((row) => row.failureKinds.includes(failureKind)).length;
}

function formatSemanticTopCandidate(row: SemanticTaxonomyReflectionRow) {
  if (!row.semanticTopCandidateType) return "-";
  const score = row.semanticTopCandidateScore?.toFixed(3) ?? "?";
  const rejected = row.semanticCandidateType ? "" : " (rejected)";
  const reasons = row.semanticRejectionReasons.length
    ? `: ${row.semanticRejectionReasons.join(", ")}`
    : "";
  return `${row.semanticTopCandidateType} ${score}${rejected}${reasons}`;
}

function shortId(value?: string) {
  if (!value) return "-";
  return value.length > 18 ? `${value.slice(0, 15)}...` : value;
}

function readNumberRecord(
  sources: Record<string, unknown>[],
  key: string
) {
  for (const source of sources) {
    const value = source[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entries = Object.entries(value)
      .map(([entryKey, entryValue]) => [
        entryKey,
        readSemanticScoreValue(entryValue),
      ] as const)
      .filter(
        (entry): entry is readonly [string, number] =>
          entry[1] !== undefined
      );
    if (entries.length) return Object.fromEntries(entries);
  }
  return {};
}

function readSemanticScoreValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  for (const key of ["positiveScore", "score", "calibratedConfidence"]) {
    const nested = candidate[key];
    if (typeof nested === "number" && Number.isFinite(nested)) return nested;
  }
  return undefined;
}

function readOptionalBoolean(
  sources: Record<string, unknown>[],
  key: string
) {
  for (const source of sources) {
    if (typeof source[key] === "boolean") return source[key] as boolean;
  }
  return undefined;
}

function rankCanonicalScores(scores: Record<string, number>) {
  return Object.entries(scores)
    .map(([type, score]) => ({
      type: normalizeCanonicalQuestionType(type),
      score,
    }))
    .filter(
      (entry): entry is { type: CanonicalQuestionType; score: number } =>
        Boolean(entry.type)
    )
    .sort((left, right) => right.score - left.score);
}

function readStringArray(sources: Record<string, unknown>[], key: string) {
  for (const source of sources) {
    const values = readStringArrayFromSource(source, key);
    if (values.length) return values;
  }
  return [];
}

function readStringArrayFromSource(
  source: Record<string, unknown>,
  key: string
) {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && Boolean(item.trim())
  );
}

function calculateContextCoverage(
  logicalQuestionSourceTurnIds: string[],
  canonicalQuestionSourceTurnIds: string[]
) {
  if (!logicalQuestionSourceTurnIds.length) return undefined;
  const included = new Set(canonicalQuestionSourceTurnIds);
  return (
    logicalQuestionSourceTurnIds.filter((turnId) => included.has(turnId)).length /
    logicalQuestionSourceTurnIds.length
  );
}

function newerEvaluation(
  current?: SemanticTaxonomyEvaluationLabel,
  candidate?: SemanticTaxonomyEvaluationLabel
) {
  if (!candidate) return current;
  if (!current || candidate.updatedAt > current.updatedAt) return candidate;
  return current;
}

function isCanonical(
  value: CanonicalQuestionType | undefined
): value is CanonicalQuestionType {
  return Boolean(value);
}

function readCanonical(
  sources: Record<string, unknown>[],
  key: string
) {
  return normalizeCanonicalQuestionType(readFirst(sources, key));
}

function readFirst(sources: Record<string, unknown>[], key: string) {
  for (const source of sources) {
    const value = readString(source, key);
    if (value) return value;
  }
  return undefined;
}

function readString(source: Record<string, unknown>, key: string) {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(sources: Record<string, unknown>[], key: string) {
  for (const source of sources) {
    if (typeof source[key] === "boolean") return source[key] as boolean;
  }
  return false;
}

function readNumber(sources: Record<string, unknown>[], key: string) {
  for (const source of sources) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function ratioOrNull(numerator: number, denominator: number) {
  return denominator ? numerator / denominator : null;
}

function unique<T>(values: T[]) {
  return Array.from(new Set(values));
}

function isString(value: string | undefined): value is string {
  return Boolean(value);
}

function escapeCell(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
