import type {
  HumanExpectedParentAction,
  InterviewTaskRelation,
  QuestionHumanEvaluation,
} from "./types.js";
import type {
  TaskRelationProductionApplicability,
  TaskRelationSemanticValidity,
} from "./task-relation-counterfactual-branch.js";
import type { HumanEvaluationProjectionV2 } from "./human-ground-truth-v2.js";
import { offlineIdentityMatches, readOfflineDecisionIdentity, resolveOfflineHumanTruth } from "./question-type-adjudication-outcome.js";

export interface TaskRelationAdjudicationRecordedDecision {
  recordedAt: number;
  sessionId?: string;
  traceId: string;
  taskId?: string;
  metadata: Record<string, unknown>;
}

export interface TaskRelationAdjudicationReflectionRow {
  key: string;
  recordedAt: number;
  sessionId?: string;
  traceId: string;
  taskId?: string;
  operationId?: string;
  operationFamily: "child" | "parent" | "canonical" | "legacy";
  rawCandidateRelation?: unknown;
  truthSubjectId?: string;
  truthEventIds: string[];
  truthDiagnostic?: string;
  orderedRelation?: InterviewTaskRelation;
  orderedStatus?: string;
  settledRelation?: InterviewTaskRelation;
  settlementId?: string;
  settlementOperationId?: string;
  predecessorOperationIds: string[];
  predecessorDiagnostics: string[];
  rawCandidate?: unknown;
  firstTokenAt?: number;
  completedAt?: number;
  parseDisposition?: string;
  leaseAuthorized?: boolean;
  predecessorsAuthorized?: boolean;
  logicalQuestionUnitId?: string;
  logicalQuestionUnitRevision?: number;
  parentId?: string;
  parentRevision?: number;
  activeChildId?: string;
  observedParentId?: string;
  observedChildId?: string;
  observedBranchId?: string;
  observedContextOwnerId?: string;
  sourceTurnIds: string[];
  disposition?: string;
  deterministicRelation?: InterviewTaskRelation;
  candidateRelation?: InterviewTaskRelation;
  candidateConfidence?: number;
  childAffinityDecision?: "related" | "unrelated" | "unclear";
  childAffinityConfidence?: number;
  parentAffinityDecision?: "related" | "independent" | "unclear";
  parentAffinityConfidence?: number;
  splitCanonicalRelation?: InterviewTaskRelation;
  splitCanonicalConfidence?: number;
  firstBatchReleasedRelation?: InterviewTaskRelation;
  parseAttempted: boolean;
  parseValid?: boolean;
  evidenceSpansValid?: boolean;
  semanticValidity: TaskRelationSemanticValidity;
  productionApplicability: TaskRelationProductionApplicability;
  productionApplicabilityReason?: string;
  comparisonOutcome?: string;
  comparisonEligible: boolean;
  expectedQuestionType?: string;
  expectedRelation?: InterviewTaskRelation;
  expectedParentAction?: HumanExpectedParentAction;
  expectedParentId?: string;
  expectedBranchId?: string;
  expectedContextOwnerId?: string;
  deterministicCorrect?: boolean;
  candidateCorrect?: boolean;
  splitCanonicalCorrect?: boolean;
  firstBatchReleaseCorrect?: boolean;
  parentIdentityCorrect?: boolean;
  branchIdentityCorrect?: boolean;
  contextOwnerCorrect?: boolean;
  contextOutcome?: "correct" | "contaminated" | "missing";
  stale: boolean;
  mutationApplied?: boolean;
  durationMs?: number;
}

export interface TaskRelationRateMetric {
  numerator: number;
  denominator: number;
  rate: number | null;
}

export interface TaskRelationLatencyMetric {
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export interface TaskRelationAdjudicationReflectionReport {
  version: 1;
  derivationVersion: "task152-offline-v3";
  diagnostics: Array<{ traceId: string; reason: string }>;
  inputRecords: number;
  duplicateRecords: number;
  missingInputs?: string[];
  metricContract: { candidateUnit: string; productUnit: string; exclusions: string[] };
  generatedAt: number;
  metrics: {
    operations: number;
    currentOperations: number;
    legacyOperations: number;
    operationFamilies: Record<string, number>;
    evaluatedSubjects: number;
    orderedAccuracy: TaskRelationRateMetric;
    currentCandidateAccuracy: TaskRelationRateMetric;
    eligible: number;
    candidateAvailable: number;
    deterministicComparisonEligible: number;
    deterministicAgreement: TaskRelationRateMetric;
    labeled: number;
    llmAccuracy: TaskRelationRateMetric;
    deterministicAccuracy: TaskRelationRateMetric;
    splitCanonicalAccuracy: TaskRelationRateMetric;
    firstBatchReleaseAccuracy: TaskRelationRateMetric;
    newParentPrecision: TaskRelationRateMetric;
    splitNewParentPrecision: TaskRelationRateMetric;
    childAffinityAvailable: number;
    parentAffinityAvailable: number;
    splitCanonicalAvailable: number;
    firstBatchReleaseAvailable: number;
    activeChildOperations: number;
    activeChildAffinityCoverage: TaskRelationRateMetric;
    parentIdentityAccuracy: TaskRelationRateMetric;
    branchIdentityAccuracy: TaskRelationRateMetric;
    contextOwnerAccuracy: TaskRelationRateMetric;
    falseParent: number;
    falseChild: number;
    falseResume: number;
    contextLoss: number;
    contextContamination: number;
    stale: number;
    mutationApplied: number;
    disposition: Record<string, number>;
    expectedRelation: Record<string, number>;
    candidateRelation: Record<string, number>;
    latencyMs: TaskRelationLatencyMetric;
    unmatchedEvaluationCount: number;
  };
  rows: TaskRelationAdjudicationReflectionRow[];
  unmatchedEvaluations: Array<{
    evaluationId: string;
    questionId: string;
    traceIds: string[];
  }>;
}

export function buildTaskRelationAdjudicationReflectionReport(input: {
  decisions: TaskRelationAdjudicationRecordedDecision[];
  evaluations: QuestionHumanEvaluation[];
  projections?: HumanEvaluationProjectionV2[];
  settlements?: TaskRelationAdjudicationRecordedDecision[];
  missingInputs?: string[];
  now?: number;
}): TaskRelationAdjudicationReflectionReport {
  const decisions = dedupeLatestDecisions(input.decisions);
  const evaluationByTrace = indexLatestEvaluations(input.evaluations);
  const matchedEvaluationIds = new Set<string>();
  const rows = decisions.map((decision) => {
    const metadata = decision.metadata ?? {};
    const prefix = decision.reflectionPrefix;
    const current = prefix !== undefined;
    const linked = [...input.decisions, ...input.settlements ?? []].filter(link => current && offlineIdentityMatches(decision, link) &&
      link.metadata[`${prefix}OperationId`] === metadata[`${prefix}OperationId`]);
    const truth = resolveOfflineHumanTruth(decision, input.projections ?? [], linked);
    const legacyEvaluation = evaluationByTrace.get(`${decision.sessionId ?? ""}:${decision.traceId}`) ?? evaluationByTrace.get(`:${decision.traceId}`);
    const evaluation = input.projections?.some(projection => projection.subject.traceIds.includes(decision.traceId)) || current ? undefined : legacyEvaluation;
    if (evaluation) matchedEvaluationIds.add(evaluation.id);
    const deterministicRelation = current ? undefined : normalizeRelation(
      metadata.taskRelationAdjudicationDeterministicRelation
    );
    const rawCandidate = current ? metadata[`${prefix}${prefix === "taskRelationSplitCanonical" ? "ParsedRelation" : "ParsedDecision"}`] : undefined;
    const candidateRelation = normalizeRelation(current
      ? prefix === "taskRelationSplitCanonical" ? rawCandidate ?? metadata.taskRelationSplitCanonicalRelation : undefined
      : metadata.taskRelationAdjudicationCandidateRelation);
    const expectedRelation =
      (truth.expectedRelation ?? evaluation?.expectedRelation) === "none"
        ? undefined
        : normalizeRelation(truth.expectedRelation ?? evaluation?.expectedRelation);
    const expectedParentAction = truth.expectedParentAction ?? evaluation?.expectedParentAction;
    const expectedParentId = truth.expectedParentId ?? evaluation?.expectedParentId;
    const expectedBranchId = truth.expectedBranchId ?? evaluation?.expectedBranchId;
    const expectedContextOwnerId = truth.expectedContextOwnerId ?? evaluation?.expectedContextOwnerId;
    const candidateConfidence = readNumber(
      current ? metadata[`${prefix}Confidence`] : metadata.taskRelationAdjudicationConfidence
    );
    const childAffinityDecision = normalizeChildAffinity(
      current && prefix !== "taskRelationChildAffinity" ? undefined : rawCandidate ?? metadata.taskRelationChildAffinityDecision
    );
    const parentAffinityDecision = normalizeParentAffinity(
      current && prefix !== "taskRelationParentAffinity" ? undefined : rawCandidate ?? metadata.taskRelationParentAffinityDecision
    );
    const splitCanonicalRelation = normalizeRelation(
      current ? candidateRelation : metadata.taskRelationSplitCanonicalRelation
    );
    const firstBatchReleasedRelation = current ? undefined : normalizeRelation(
      metadata.taskRelationFirstBatchReleasedRelation
    );
    const parseDisposition = readString(
      current ? metadata[`${prefix}ParseDisposition`] : metadata.taskRelationAdjudicationParseDisposition
    );
    const parseAttempted =
      Boolean(candidateRelation) ||
      Boolean(
        parseDisposition &&
          !parseDisposition.startsWith("not-run")
      );
    const parseValid = readBoolean(
      current ? metadata[`${prefix}ParseValid`] : metadata.taskRelationAdjudicationParseValid
    );
    const evidenceSpansValid = readBoolean(
      current ? metadata[`${prefix}EvidenceSpansValid`] : metadata.taskRelationAdjudicationEvidenceSpansValid
    );
    const semanticValidity = current ? (parseValid === undefined ? "unavailable" : parseValid ? "valid" : "invalid") : deriveSemanticValidity({
      candidateRelation,
      parseAttempted,
      parseValid,
      evidenceSpansValid,
    });
    const stale =
      current ? metadata[`${prefix}LeaseAuthorized`] === false || metadata[`${prefix}Disposition`] === "stale" :
        readString(metadata.taskRelationAdjudicationDisposition) === "stale" || Boolean(readString(metadata.taskRelationAdjudicationStaleReason));
    const effects = current ? [...linked].sort((a, b) => b.recordedAt - a.recordedAt)[0]?.metadata ?? {} : metadata;
    const activeChildId = readString(
      metadata.taskRelationAdjudicationActiveChildId
    );
    const observedParentId = readString(
      effects.effectiveCurrentQuestionSettlementParentId ??
        effects.settledExecutionPlanPostMutationParentId ??
        effects.sourceTransitionParentAfterId ??
        effects.currentQuestionSettlementParentAfterId ??
        (current ? undefined : metadata.activeMeetingParentId ?? metadata.taskRelationAdjudicationParentId)
    );
    const observedChildId = readString(
      effects.effectiveCurrentQuestionSettlementChildId ??
        (current ? undefined : metadata.activeMeetingChildId ?? metadata.taskRelationAdjudicationActiveChildId)
    );
    const effectiveRelation =
      readBoolean(metadata.effectiveAdvisorCurrentOnly) === true
        ? undefined
        : normalizeRelation(
            effects.effectiveCurrentQuestionSettlementRelation ??
              effects.settledExecutionPlanTaskRelation ??
              effects.currentQuestionSettlementRelation
          );
    const observedBranchId =
      effectiveRelation === "child-probe" && observedChildId
        ? observedChildId
        : observedParentId;
    const contextReadScope = readString(
      effects.effectiveCurrentQuestionContextReadScope ??
        effects.responseOnlyContextReadScope
    );
    const observedContextOwnerId =
      contextReadScope === "active-child-read"
        ? observedChildId
        : contextReadScope === "active-parent-read"
          ? observedParentId
          : readString(
              effects.effectiveCurrentQuestionSettlementUnitId ??
                effects.currentQuestionSettlementUnitId ??
                (current ? undefined : metadata.logicalQuestionUnitId)
            );
    const productionApplicability = current ? { applicability: "not-evaluated" as const, reason: "current-operation-uses-recorded-ordered-effects" } : deriveProductionApplicability({
      candidateRelation,
      semanticValidity,
      stale,
      activeChildId,
    });
    const contextOutcome =
      evaluation?.taxonomyAdjudication?.contextOutcome;
    return {
      key: decisionKey(decision),
      recordedAt: decision.recordedAt,
      sessionId: decision.sessionId,
      traceId: decision.traceId,
      taskId: decision.taskId,
      operationId: readString(
        current ? metadata[`${prefix}OperationId`] : metadata.taskRelationAdjudicationOperationId
      ),
      operationFamily: prefix === "taskRelationChildAffinity" ? "child" : prefix === "taskRelationParentAffinity" ? "parent" : prefix === "taskRelationSplitCanonical" ? "canonical" : "legacy",
      truthSubjectId: truth.subjectId,
      truthEventIds: truth.eventIds,
      truthDiagnostic: truth.diagnostic,
      rawCandidate,
      rawCandidateRelation: current ? (prefix === "taskRelationSplitCanonical" ? rawCandidate ?? metadata.taskRelationSplitCanonicalRelation : undefined) : metadata.taskRelationAdjudicationCandidateRelation,
      parseDisposition,
      firstTokenAt: current ? readNumber(metadata[`${prefix}FirstTokenAt`]) : undefined,
      completedAt: current ? readNumber(metadata[`${prefix}CompletedAt`]) : undefined,
      leaseAuthorized: current ? readBoolean(metadata[`${prefix}LeaseAuthorized`]) : undefined,
      predecessorsAuthorized: current ? readBoolean(metadata[`${prefix}PredecessorsAuthorized`]) : undefined,
      orderedRelation: current ? normalizeRelation(effects.taskRelationOrderedResolutionRelation) : undefined,
      orderedStatus: current ? readString(effects.taskRelationOrderedResolutionStatus) : undefined,
      settledRelation: current ? effectiveRelation : undefined,
      settlementId: readString(effects.currentQuestionSettlementId),
      settlementOperationId: readString(effects.runtimeSettlementOperationId),
      predecessorOperationIds: prefix === "taskRelationSplitCanonical" ? [metadata.taskRelationSplitChildPredecessorOperationId, metadata.taskRelationSplitParentPredecessorOperationId].filter((id): id is string => typeof id === "string") : [],
      predecessorDiagnostics: prefix === "taskRelationSplitCanonical" ? [metadata.taskRelationSplitChildPredecessorOperationId, metadata.taskRelationSplitParentPredecessorOperationId].filter((id): id is string => typeof id === "string").filter(id => !decisions.some(other =>
        other.reflectionPrefix && other.metadata[`${other.reflectionPrefix}OperationId`] === id && offlineIdentityMatches(decision, other)
      )).map(id => `unresolved-predecessor:${id}`) : [],
      logicalQuestionUnitId: readString(
        metadata.taskRelationAdjudicationUnitId
      ),
      logicalQuestionUnitRevision: readNumber(
        metadata.taskRelationAdjudicationUnitRevision
      ),
      parentId: readString(
        metadata.taskRelationAdjudicationParentId
      ),
      parentRevision: readNumber(
        metadata.taskRelationAdjudicationParentRevision
      ),
      activeChildId,
      observedParentId,
      observedChildId,
      observedBranchId,
      observedContextOwnerId,
      sourceTurnIds: readStringArray(
        metadata.taskRelationAdjudicationRecentSourceEvidenceTurnIds
      ),
      disposition: readString(
        current ? metadata[`${prefix}Disposition`] : metadata.taskRelationAdjudicationDisposition
      ),
      deterministicRelation,
      candidateRelation,
      candidateConfidence,
      childAffinityDecision,
      childAffinityConfidence: readNumber(
        current && prefix !== "taskRelationChildAffinity" ? undefined : metadata.taskRelationChildAffinityConfidence
      ),
      parentAffinityDecision,
      parentAffinityConfidence: readNumber(
        current && prefix !== "taskRelationParentAffinity" ? undefined : metadata.taskRelationParentAffinityConfidence
      ),
      splitCanonicalRelation,
      splitCanonicalConfidence: readNumber(
        current && prefix !== "taskRelationSplitCanonical" ? undefined : metadata.taskRelationSplitCanonicalConfidence
      ),
      firstBatchReleasedRelation,
      parseAttempted,
      parseValid,
      evidenceSpansValid,
      semanticValidity,
      productionApplicability:
        productionApplicability.applicability,
      productionApplicabilityReason: productionApplicability.reason,
      comparisonOutcome: readString(
        metadata.taskRelationAdjudicationComparisonOutcome
      ),
      comparisonEligible:
        !current && metadata.taskRelationAdjudicationComparisonEligible === true,
      expectedQuestionType:
        truth.expectedQuestionType ?? evaluation?.correctedQuestionType,
      expectedRelation,
      expectedParentAction,
      expectedParentId,
      expectedBranchId,
      expectedContextOwnerId,
      deterministicCorrect:
        deterministicRelation && expectedRelation
          ? deterministicRelation === expectedRelation
          : undefined,
      candidateCorrect:
        candidateRelation && candidateRelation !== "unknown" && expectedRelation && (!current || parseValid !== false)
          ? candidateRelation === expectedRelation
          : undefined,
      splitCanonicalCorrect:
        splitCanonicalRelation && splitCanonicalRelation !== "unknown" && expectedRelation && (!current || parseValid !== false)
          ? splitCanonicalRelation === expectedRelation
          : undefined,
      firstBatchReleaseCorrect:
        firstBatchReleasedRelation && expectedRelation
          ? firstBatchReleasedRelation === expectedRelation
          : undefined,
      parentIdentityCorrect: expectedParentId && observedParentId
        ? observedParentId === expectedParentId
        : undefined,
      branchIdentityCorrect: expectedBranchId && observedBranchId
        ? observedBranchId === expectedBranchId
        : undefined,
      contextOwnerCorrect: expectedContextOwnerId && observedContextOwnerId
        ? observedContextOwnerId === expectedContextOwnerId
        : undefined,
      contextOutcome,
      stale,
      mutationApplied: current ? (effects.sourceTransitionDurableAuthorized === true ? readBoolean(effects.sourceTransitionDurableMutationApplied) : undefined) :
        metadata.taskRelationAdjudicationAppliedToRuntime === true || metadata.taskRelationAdjudicationBehaviorMutationBlocked === false,
      durationMs: readNumber(
        current ? metadata[`${prefix}DurationMs`] : metadata.taskRelationAdjudicationDurationMs
      ),
    } satisfies TaskRelationAdjudicationReflectionRow;
  });
  const labeledRows = rows.filter((row) => row.expectedRelation);
  const llmLabeledRows = labeledRows.filter((row) => row.operationFamily === "legacy" && row.candidateRelation);
  const deterministicLabeledRows = labeledRows.filter(
    (row) => row.deterministicRelation
  );
  const splitCanonicalLabeledRows = labeledRows.filter(
    (row) => row.operationFamily === "legacy" && row.splitCanonicalCorrect !== undefined
  );
  const firstBatchReleaseLabeledRows = labeledRows.filter(
    (row) => row.firstBatchReleasedRelation
  );
  const comparisonRows = rows.filter(
    (row) =>
      row.comparisonEligible &&
      row.deterministicRelation &&
      row.candidateRelation
  );
  const newParentRows = llmLabeledRows.filter(
    (row) => row.candidateRelation === "new-parent"
  );
  const splitNewParentRows = splitCanonicalLabeledRows.filter(
    (row) => row.splitCanonicalRelation === "new-parent"
  );
  const activeChildRows = rows.filter((row) => row.activeChildId);
  const subjects = new Map(rows.filter(row => row.truthSubjectId).map(row => [row.truthSubjectId!, row]));
  const productRows = [...rows.filter(row => row.operationFamily === "legacy"), ...subjects.values()];
  const parentIdentityRows = productRows.filter(
    (row) => row.parentIdentityCorrect !== undefined
  );
  const branchIdentityRows = productRows.filter(
    (row) => row.branchIdentityCorrect !== undefined
  );
  const contextOwnerRows = productRows.filter(
    (row) => row.contextOwnerCorrect !== undefined
  );
  const unmatchedEvaluations = input.evaluations
    .filter(
      (evaluation) =>
        evaluation.expectedRelation &&
        !matchedEvaluationIds.has(evaluation.id)
    )
    .map((evaluation) => ({
      evaluationId: evaluation.id,
      questionId: evaluation.questionId,
      traceIds: [...evaluation.traceIds],
    }));
  const currentCandidates = rows.filter(row => row.operationFamily !== "legacy" && row.candidateCorrect !== undefined);
  const orderedSubjects = [...subjects.values()].filter(row => row.orderedRelation && row.expectedRelation);

  return {
    version: 1,
    derivationVersion: "task152-offline-v3",
    metricContract: { candidateUnit: "Child/Parent/Canonical operation identity; legacy Direct separate", productUnit: "confirmed human attempt/source subject", exclusions: ["Unknown parse is not invalid", "Candidate is not Ordered or durable effect", "Missing/conflicting identity or truth is unscored"] },
    inputRecords: input.decisions.length,
    duplicateRecords: input.decisions.length - new Set(input.decisions.map(decision => JSON.stringify(decision))).size,
    missingInputs: input.missingInputs,
    diagnostics: [
      ...input.decisions.filter(decision => isCurrentOnlyWithoutOperation(decision)).map(decision => ({ traceId: decision.traceId, reason: "missing-operation-identity" })),
      ...rows.filter(row => row.rawCandidateRelation !== undefined && !normalizeRelation(row.rawCandidateRelation)).map(row => ({ traceId: row.traceId, reason: `unsupported-relation:${String(row.rawCandidateRelation)}` })),
      ...rows.flatMap(row => row.predecessorDiagnostics.map(reason => ({ traceId: row.traceId, reason }))),
    ],
    generatedAt: input.now ?? Date.now(),
    metrics: {
      operations: rows.length,
      currentOperations: rows.filter(row => row.operationFamily !== "legacy").length,
      legacyOperations: rows.filter(row => row.operationFamily === "legacy").length,
      operationFamilies: countValues(rows.map(row => row.operationFamily)),
      evaluatedSubjects: subjects.size,
      orderedAccuracy: rate(orderedSubjects.filter(row => row.orderedRelation === row.expectedRelation).length, orderedSubjects.length),
      currentCandidateAccuracy: rate(currentCandidates.filter(row => row.candidateCorrect).length, currentCandidates.length),
      eligible: rows.filter(
        (row) =>
          row.disposition !== "not-eligible" &&
          row.disposition !== "disabled"
      ).length,
      candidateAvailable: rows.filter((row) => row.candidateRelation).length,
      deterministicComparisonEligible: comparisonRows.length,
      deterministicAgreement: rate(
        comparisonRows.filter(
          (row) => row.deterministicRelation === row.candidateRelation
        ).length,
        comparisonRows.length
      ),
      labeled: labeledRows.length,
      llmAccuracy: rate(
        llmLabeledRows.filter((row) => row.candidateCorrect).length,
        llmLabeledRows.length
      ),
      deterministicAccuracy: rate(
        deterministicLabeledRows.filter((row) => row.deterministicCorrect)
          .length,
        deterministicLabeledRows.length
      ),
      splitCanonicalAccuracy: rate(
        splitCanonicalLabeledRows.filter(
          (row) => row.splitCanonicalCorrect
        ).length,
        splitCanonicalLabeledRows.length
      ),
      firstBatchReleaseAccuracy: rate(
        firstBatchReleaseLabeledRows.filter(
          (row) => row.firstBatchReleaseCorrect
        ).length,
        firstBatchReleaseLabeledRows.length
      ),
      newParentPrecision: rate(
        newParentRows.filter((row) => row.candidateCorrect).length,
        newParentRows.length
      ),
      splitNewParentPrecision: rate(
        splitNewParentRows.filter((row) => row.splitCanonicalCorrect).length,
        splitNewParentRows.length
      ),
      childAffinityAvailable: rows.filter((row) => row.childAffinityDecision)
        .length,
      parentAffinityAvailable: rows.filter((row) => row.parentAffinityDecision)
        .length,
      splitCanonicalAvailable: rows.filter(
        (row) => row.splitCanonicalRelation
      ).length,
      firstBatchReleaseAvailable: rows.filter(
        (row) => row.firstBatchReleasedRelation
      ).length,
      activeChildOperations: activeChildRows.length,
      activeChildAffinityCoverage: rate(
        activeChildRows.filter((row) => row.childAffinityDecision).length,
        activeChildRows.length
      ),
      parentIdentityAccuracy: rate(
        parentIdentityRows.filter((row) => row.parentIdentityCorrect).length,
        parentIdentityRows.length
      ),
      branchIdentityAccuracy: rate(
        branchIdentityRows.filter((row) => row.branchIdentityCorrect).length,
        branchIdentityRows.length
      ),
      contextOwnerAccuracy: rate(
        contextOwnerRows.filter((row) => row.contextOwnerCorrect).length,
        contextOwnerRows.length
      ),
      falseParent: countFalseRelation(rows, "new-parent"),
      falseChild: countFalseRelation(rows, "child-probe"),
      falseResume: countFalseRelation(rows, "resume-parent"),
      contextLoss: rows.filter((row) => row.contextOutcome === "missing")
        .length,
      contextContamination: rows.filter(
        (row) => row.contextOutcome === "contaminated"
      ).length,
      stale: rows.filter((row) => row.stale).length,
      mutationApplied: [...new Map(rows.filter(row => row.mutationApplied).map(row => [row.settlementId ?? row.key, row])).values()].length,
      disposition: countValues(rows.map((row) => row.disposition)),
      expectedRelation: countValues(
        rows.map((row) => row.expectedRelation)
      ),
      candidateRelation: countValues(
        rows.map((row) => row.candidateRelation)
      ),
      latencyMs: distribution(
        rows.map((row) => row.durationMs).filter(isNumber)
      ),
      unmatchedEvaluationCount: unmatchedEvaluations.length,
    },
    rows,
    unmatchedEvaluations,
  };
}

export function renderTaskRelationAdjudicationReflectionMarkdown(
  report: TaskRelationAdjudicationReflectionReport
) {
  const metrics = report.metrics;
  const lines = [
    "# Task Relation Adjudication Reflection",
    "",
    `- Operations: ${metrics.operations}`,
    `- Current / legacy operations: ${metrics.currentOperations} / ${metrics.legacyOperations}`,
    `- Current candidate accuracy: ${formatRate(metrics.currentCandidateAccuracy)}`,
    `- Ordered accuracy (unique human subjects): ${formatRate(metrics.orderedAccuracy)}`,
    `- Candidate available: ${metrics.candidateAvailable}`,
    `- Human-labeled: ${metrics.labeled}`,
    `- Deterministic/LLM agreement: ${formatRate(metrics.deterministicAgreement)}`,
    `- LLM accuracy: ${formatRate(metrics.llmAccuracy)}`,
    `- Deterministic accuracy: ${formatRate(metrics.deterministicAccuracy)}`,
    `- Split Canonical accuracy: ${formatRate(metrics.splitCanonicalAccuracy)}`,
    `- First-batch release accuracy: ${formatRate(metrics.firstBatchReleaseAccuracy)}`,
    `- New-parent precision: ${formatRate(metrics.newParentPrecision)}`,
    `- Split new-parent precision: ${formatRate(metrics.splitNewParentPrecision)}`,
    `- Child / Parent / Canonical available: ${metrics.childAffinityAvailable} / ${metrics.parentAffinityAvailable} / ${metrics.splitCanonicalAvailable}`,
    `- Active-child affinity coverage: ${formatRate(metrics.activeChildAffinityCoverage)}`,
    `- Parent / branch / context-owner identity accuracy: ${formatRate(metrics.parentIdentityAccuracy)} / ${formatRate(metrics.branchIdentityAccuracy)} / ${formatRate(metrics.contextOwnerAccuracy)}`,
    `- False parent / child / resume: ${metrics.falseParent} / ${metrics.falseChild} / ${metrics.falseResume}`,
    `- Context loss / contamination: ${metrics.contextLoss} / ${metrics.contextContamination}`,
    `- Stale: ${metrics.stale}`,
    `- Runtime mutation applied: ${metrics.mutationApplied}`,
    `- Latency P50 / P95: ${formatMs(metrics.latencyMs.p50Ms)} / ${formatMs(metrics.latencyMs.p95Ms)}`,
    `- Unmatched expected-relation labels: ${metrics.unmatchedEvaluationCount}`,
    "",
    "## Rows",
    "",
    "| Trace | Deterministic | Monolithic | Split | Released | Expected | Owner | Disposition |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of report.rows) {
    lines.push(
      `| ${row.traceId} | ${row.deterministicRelation ?? "-"} | ${row.candidateRelation ?? "-"} | ${row.splitCanonicalRelation ?? "-"} | ${row.firstBatchReleasedRelation ?? "-"} | ${row.expectedRelation ?? "-"} | ${formatIdentityVerdict(row)} | ${row.disposition ?? "-"} |`
    );
  }
  return `${lines.join("\n")}\n`;
}

function dedupeLatestDecisions(
  decisions: TaskRelationAdjudicationRecordedDecision[]
) {
  const latest = new Map<string, TaskRelationAdjudicationRecordedDecision & { reflectionPrefix?: string }>();
  for (const record of decisions) {
    const prefixes = ["taskRelationChildAffinity", "taskRelationParentAffinity", "taskRelationSplitCanonical"].filter(prefix => readString(record.metadata[`${prefix}OperationId`]));
    const candidates: Array<TaskRelationAdjudicationRecordedDecision & { reflectionPrefix?: string }> = prefixes.map(reflectionPrefix => ({ ...record, reflectionPrefix }));
    if (readString(record.metadata.taskRelationAdjudicationOperationId) || (!prefixes.length && !isCurrentOnlyWithoutOperation(record))) candidates.push(record);
    for (const decision of candidates) {
    const key = decisionKey(decision);
    const existing = latest.get(key);
    if (!existing || decision.recordedAt >= existing.recordedAt) {
      latest.set(key, decision);
    }
    }
  }
  return Array.from(latest.values()).sort(
    (left, right) => left.recordedAt - right.recordedAt
  );
}

function isCurrentOnlyWithoutOperation(record: TaskRelationAdjudicationRecordedDecision) {
  return !readString(record.metadata.taskRelationAdjudicationOperationId) &&
    !["taskRelationChildAffinity", "taskRelationParentAffinity", "taskRelationSplitCanonical"].some(prefix => readString(record.metadata[`${prefix}OperationId`])) &&
    Object.keys(record.metadata).some(key => key.startsWith("taskRelationOrderedResolution") || key.startsWith("taskRelationChildAffinity") || key.startsWith("taskRelationParentAffinity") || key.startsWith("taskRelationSplitCanonical") || key === "runtimeSettlementOperationId");
}

function decisionKey(decision: TaskRelationAdjudicationRecordedDecision & { reflectionPrefix?: string }) {
  return JSON.stringify([
    decision.sessionId ?? "session",
    readString(
      decision.reflectionPrefix ? decision.metadata[`${decision.reflectionPrefix}OperationId`] : decision.metadata.taskRelationAdjudicationOperationId
    ) ?? `trace:${decision.traceId}`,
    decision.reflectionPrefix,
    decision.reflectionPrefix ? readOfflineDecisionIdentity(decision) : undefined,
  ]);
}

function indexLatestEvaluations(evaluations: QuestionHumanEvaluation[]) {
  const byTrace = new Map<string, QuestionHumanEvaluation>();
  for (const evaluation of [...evaluations].sort(
    (left, right) => left.updatedAt - right.updatedAt
  )) {
    for (const traceId of evaluation.traceIds) {
      byTrace.set(`${evaluation.sessionId ?? ""}:${traceId}`, evaluation);
    }
  }
  return byTrace;
}

function countFalseRelation(
  rows: TaskRelationAdjudicationReflectionRow[],
  relation: InterviewTaskRelation
) {
  return rows.filter(
    (row) =>
      row.candidateRelation === relation &&
      row.expectedRelation &&
      row.expectedRelation !== relation
  ).length;
}

function rate(numerator: number, denominator: number): TaskRelationRateMetric {
  return {
    numerator,
    denominator,
    rate: denominator ? numerator / denominator : null,
  };
}

function distribution(values: number[]): TaskRelationLatencyMetric {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.length ? sorted[sorted.length - 1] : null,
  };
}

function percentile(values: number[], quantile: number) {
  if (!values.length) return null;
  const index = Math.min(
    values.length - 1,
    Math.max(0, Math.ceil(values.length * quantile) - 1)
  );
  return values[index];
}

function countValues(values: Array<string | undefined>) {
  const counts: Record<string, number> = {};
  for (const value of values) {
    if (!value) continue;
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function normalizeRelation(
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

function normalizeChildAffinity(value: unknown) {
  return value === "related" || value === "unrelated" || value === "unclear"
    ? value
    : undefined;
}

function normalizeParentAffinity(value: unknown) {
  return value === "related" || value === "independent" || value === "unclear"
    ? value
    : undefined;
}

function formatIdentityVerdict(row: TaskRelationAdjudicationReflectionRow) {
  const values = [
    row.parentIdentityCorrect,
    row.branchIdentityCorrect,
    row.contextOwnerCorrect,
  ].filter((value): value is boolean => value !== undefined);
  if (!values.length) return "-";
  return values.every(Boolean) ? "correct" : "wrong";
}

function deriveSemanticValidity(input: {
  candidateRelation?: InterviewTaskRelation;
  parseAttempted: boolean;
  parseValid?: boolean;
  evidenceSpansValid?: boolean;
}): TaskRelationSemanticValidity {
  if (
    input.candidateRelation &&
    input.parseValid !== false &&
    input.evidenceSpansValid !== false
  ) {
    return "valid";
  }
  return input.parseAttempted ? "invalid" : "unavailable";
}

function deriveProductionApplicability(input: {
  candidateRelation?: InterviewTaskRelation;
  semanticValidity: TaskRelationSemanticValidity;
  stale: boolean;
  activeChildId?: string;
}): {
  applicability: TaskRelationProductionApplicability;
  reason?: string;
} {
  if (input.stale) {
    return {
      applicability: "not-evaluated",
      reason: "stale-operation",
    };
  }
  if (
    input.semanticValidity !== "valid" ||
    !input.candidateRelation ||
    input.candidateRelation === "unknown"
  ) {
    return {
      applicability: "not-evaluated",
      reason: "semantic-candidate-unavailable",
    };
  }
  if (
    input.candidateRelation === "resume-parent" &&
    !input.activeChildId
  ) {
    return {
      applicability: "inapplicable",
      reason: "resume-requires-active-child-binding",
    };
  }
  if (
    input.candidateRelation === "child-probe" &&
    input.activeChildId
  ) {
    return {
      applicability: "inapplicable",
      reason: "child-cannot-replace-active-child",
    };
  }
  return { applicability: "applicable" };
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function readBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? value
        .map(readString)
        .filter((item): item is string => Boolean(item))
    : [];
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isNumber(value: number | undefined): value is number {
  return value !== undefined;
}

function formatRate(metric: TaskRelationRateMetric) {
  return metric.rate === null
    ? "-"
    : `${(metric.rate * 100).toFixed(1)}% (${metric.numerator}/${metric.denominator})`;
}

function formatMs(value: number | null) {
  return value === null ? "-" : `${Math.round(value)} ms`;
}
