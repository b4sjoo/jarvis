import {
  CANONICAL_QUESTION_TYPES,
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";

export interface LongitudinalSessionManifest {
  sessionId?: string;
  folderName?: string;
  startedAt?: number;
  endedAt?: number;
  build?: {
    appVersion?: string;
    gitCommit?: string;
    gitDirty?: boolean;
    buildTimestamp?: string;
  };
}

export interface LongitudinalTranscriptTurn {
  id: string;
  speaker?: string;
  text?: string;
  startedAt?: number;
  endedAt?: number;
}

export interface LongitudinalTraceSummary {
  traceId: string;
  traceKind?: string;
  status?: string;
  startedAt?: number;
  durationMs?: number;
  syntheticValidation?: boolean;
  questionType?: string;
  rawQuestionType?: string;
  canonicalQuestionType?: string;
  taskRelation?: string;
  turnGateAction?: string;
  advisorTurnIntent?: string;
  advisorWouldSuppress?: boolean;
  advisorExecutionAuthorized?: boolean;
  taskMutationAuthorized?: boolean;
  advisorOutputDisposition?: string;
  advisorOutputCommittedToUi?: boolean;
  visibleAnswerChanged?: boolean;
  manualQuestionTypeCorrectionId?: string;
  logicalQuestionUnitId?: string;
  logicalQuestionCurrentTurnId?: string;
  logicalQuestionSourceTurnIds?: string[];
  logicalQuestionCompositionReasons?: string[];
  logicalQuestionTruncated?: boolean;
  advisorPromptIncludedLogicalQuestion?: boolean;
  taskBoundary?: {
    mutationDisposition?: string;
    authoritySource?: string;
    sourceTurnIds?: string[];
    parentBeforeId?: string;
    parentAfterId?: string;
  };
  semanticTaxonomy?: {
    keywordType?: string;
    semanticCandidateType?: string;
    semanticTopCandidateType?: string;
    hybridOutcome?: string;
    hybridEffectiveType?: string;
    rescueApplied?: boolean;
    durationMs?: number;
  };
  taxonomyAdjudication?: {
    candidateType?: string;
    relation?: string;
    providerConfigurationStatus?: string;
    providerDisposition?: string;
    parseValid?: boolean;
    durationMs?: number;
  };
  timingsMs?: {
    model?: number;
    advisor?: number;
  };
}

export interface LongitudinalQuestionEvaluation {
  id: string;
  questionId: string;
  traceIds: string[];
  questionType?: string;
  correctedQuestionType?: string;
  manualQuestionTypeCorrectionId?: string;
  relation?: string;
  correctedRelation?: string;
  classification?: {
    verdict?: string;
  };
  advisorIntent?: {
    verdict?: "ok" | "false-positive" | "false-negative";
    expectedAction?: "advise" | "append-context" | "buffer" | "ignore";
    observedAction?: "advised" | "suppressed" | "append-only" | "buffered";
    source?: "explicit-human-label" | "manual-force-advise" | "manual-suppress";
    originalTraceId?: string;
    repairTraceId?: string;
  };
  expectedRelation?: string;
  expectedParentAction?: string;
  expectedContextTurnIds?: string[];
  substantive?: boolean;
  samplingReason?: string;
  updatedAt?: number;
}

export interface LongitudinalSessionInput {
  directory: string;
  manifest: LongitudinalSessionManifest;
  transcriptTurns: LongitudinalTranscriptTurn[];
  traceSummaries: LongitudinalTraceSummary[];
  questionEvaluations: LongitudinalQuestionEvaluation[];
}

export interface RateMetric {
  numerator: number;
  denominator: number;
  rate: number | null;
}

type TypeStage =
  | "keyword"
  | "semantic"
  | "hybrid"
  | "llmAdjudication"
  | "runtime";

export interface SessionLongitudinalEvaluationReport {
  version: 1;
  generatedAt: number;
  sessions: Array<{
    sessionId: string;
    directory: string;
    startedAt?: number;
    endedAt?: number;
    build: LongitudinalSessionManifest["build"];
    productionTraceCount: number;
    labeledTraceCount: number;
  }>;
  cohort: {
    sessionCount: number;
    productionTraceCount: number;
    syntheticTraceCount: number;
    interviewerTurnCount: number;
    buildProvenanceCoverage: RateMetric;
    labeledTraceCoverage: RateMetric;
  };
  typeFunnel: {
    stageCoverage: Record<TypeStage, RateMetric>;
    unknownRate: Record<TypeStage, RateMetric>;
    agreementWithHuman: Record<TypeStage, RateMetric>;
    confusion: Record<TypeStage, Record<string, Record<string, number>>>;
    runtimePrecisionRecall: Record<
      CanonicalQuestionType,
      {
        precision: RateMetric;
        recall: RateMetric;
      }
    >;
    inheritedRuntimeCount: number;
    freshRuntimeCount: number;
    manualCorrectionCount: number;
    semanticLatencyMs: DistributionMetric;
    adjudicationLatencyMs: DistributionMetric;
  };
  intentFunnel: {
    observed: number;
    recommendedSuppression: number;
    executionAuthorized: number;
    outputCommitted: number;
    visibleAnswerChanged: number;
    taskMutationAuthorized: number;
    humanLabeled: number;
    falseActivation: RateMetric;
    falseSuppression: RateMetric;
    ignoredTurnModelCalls: number;
    ignoredTurnModelDurationMs: number;
    behaviorEvidenceCoverage: RateMetric;
  };
  continuityFunnel: {
    interviewerTurns: number;
    logicalQuestionUnits: number;
    relationObserved: number;
    parentActionObserved: number;
    promptCoverageObserved: number;
    promptIncludedLogicalQuestion: RateMetric;
    referentialCompletionCount: number;
    truncatedLogicalQuestionCount: number;
    humanLabeled: number;
    relationAgreement: RateMetric;
    parentActionAgreement: RateMetric;
    expectedContextCoverage: RateMetric;
  };
  evidenceGaps: {
    unlabeledProductionTraces: number;
    tracesWithoutBuildProvenance: number;
    tracesWithoutIntentCommitEvidence: number;
    logicalUnitsWithoutRelation: number;
    labelsWithoutMatchingTrace: number;
  };
}

export interface DistributionMetric {
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

interface JoinedTrace {
  session: LongitudinalSessionInput;
  trace: LongitudinalTraceSummary;
  evaluation?: LongitudinalQuestionEvaluation;
}

export function buildSessionLongitudinalEvaluationReport(
  inputs: LongitudinalSessionInput[]
): SessionLongitudinalEvaluationReport {
  const production: JoinedTrace[] = [];
  let syntheticTraceCount = 0;
  let interviewerTurnCount = 0;
  let labelsWithoutMatchingTrace = 0;
  const sessionRows = inputs.map((session) => {
    const evaluationsByTrace = indexLatestEvaluations(session.questionEvaluations);
    const traceIds = new Set(session.traceSummaries.map((trace) => trace.traceId));
    labelsWithoutMatchingTrace += session.questionEvaluations.filter(
      (evaluation) =>
        evaluation.traceIds.length > 0 &&
        !evaluation.traceIds.some((traceId) => traceIds.has(traceId))
    ).length;
    interviewerTurnCount += session.transcriptTurns.filter(
      (turn) => turn.speaker === "them"
    ).length;
    let productionTraceCount = 0;
    let labeledTraceCount = 0;
    for (const trace of session.traceSummaries) {
      if (trace.syntheticValidation) {
        syntheticTraceCount += 1;
        continue;
      }
      productionTraceCount += 1;
      const evaluation = evaluationsByTrace.get(trace.traceId);
      if (evaluation) labeledTraceCount += 1;
      production.push({ session, trace, evaluation });
    }
    return {
      sessionId:
        session.manifest.sessionId ??
        session.manifest.folderName ??
        session.directory,
      directory: session.directory,
      startedAt: session.manifest.startedAt,
      endedAt: session.manifest.endedAt,
      build: session.manifest.build,
      productionTraceCount,
      labeledTraceCount,
    };
  });

  const stagePredictions = Object.fromEntries(
    TYPE_STAGES.map((stage) => [
      stage,
      production.map(({ trace }) => predictionForStage(trace, stage)),
    ])
  ) as Record<TypeStage, CanonicalQuestionType[]>;
  const expectedTypes = production.map(({ evaluation }) =>
    expectedQuestionType(evaluation)
  );
  const stageCoverage = Object.fromEntries(
    TYPE_STAGES.map((stage) => [
      stage,
      rate(
        stagePredictions[stage].filter((prediction) => prediction !== "unknown")
          .length,
        production.length
      ),
    ])
  ) as Record<TypeStage, RateMetric>;
  const unknownRate = Object.fromEntries(
    TYPE_STAGES.map((stage) => [
      stage,
      rate(
        stagePredictions[stage].filter((prediction) => prediction === "unknown")
          .length,
        production.length
      ),
    ])
  ) as Record<TypeStage, RateMetric>;
  const agreementWithHuman = Object.fromEntries(
    TYPE_STAGES.map((stage) => {
      let matches = 0;
      let labeled = 0;
      for (let index = 0; index < production.length; index += 1) {
        const expected = expectedTypes[index];
        if (!expected) continue;
        labeled += 1;
        if (stagePredictions[stage][index] === expected) matches += 1;
      }
      return [stage, rate(matches, labeled)];
    })
  ) as Record<TypeStage, RateMetric>;
  const confusion = Object.fromEntries(
    TYPE_STAGES.map((stage) => [
      stage,
      buildConfusion(stagePredictions[stage], expectedTypes),
    ])
  ) as Record<TypeStage, Record<string, Record<string, number>>>;

  const intentObserved = production.filter(hasIntentEvidence);
  const intentLabeled = intentObserved.filter(
    ({ evaluation }) => evaluation?.advisorIntent?.expectedAction
  );
  const expectedIgnore = intentLabeled.filter(
    ({ evaluation }) => evaluation?.advisorIntent?.expectedAction !== "advise"
  );
  const expectedAdvise = intentLabeled.filter(
    ({ evaluation }) => evaluation?.advisorIntent?.expectedAction === "advise"
  );
  const falseActivations = expectedIgnore.filter(
    ({ trace }) =>
      trace.advisorExecutionAuthorized ||
      trace.advisorOutputCommittedToUi ||
      isCommittedDisposition(trace.advisorOutputDisposition)
  );
  const falseSuppressions = expectedAdvise.filter(
    ({ trace }) => trace.advisorExecutionAuthorized === false
  );

  const logicalUnits = production.filter(
    ({ trace }) => Boolean(trace.logicalQuestionUnitId)
  );
  const continuityLabeled = logicalUnits.filter(
    ({ evaluation }) =>
      evaluation?.expectedRelation ||
      evaluation?.expectedParentAction ||
      evaluation?.expectedContextTurnIds?.length
  );
  const expectedContextMetrics = continuityLabeled
    .map(({ trace, evaluation }) =>
      contextCoverage(
        trace.logicalQuestionSourceTurnIds ?? [],
        evaluation?.expectedContextTurnIds ?? []
      )
    )
    .filter((value): value is number => value !== undefined);

  const sessionsWithProvenance = sessionRows.filter(
    (session) =>
      session.build?.gitCommit &&
      session.build.gitCommit !== "unknown" &&
      session.build?.appVersion &&
      session.build.appVersion !== "unknown"
  ).length;
  const tracesWithoutBuildProvenance = sessionRows.reduce(
    (total, session) =>
      total +
      (session.build?.gitCommit && session.build.gitCommit !== "unknown"
        ? 0
        : session.productionTraceCount),
    0
  );

  return {
    version: 1,
    generatedAt: Date.now(),
    sessions: sessionRows,
    cohort: {
      sessionCount: sessionRows.length,
      productionTraceCount: production.length,
      syntheticTraceCount,
      interviewerTurnCount,
      buildProvenanceCoverage: rate(
        sessionsWithProvenance,
        sessionRows.length
      ),
      labeledTraceCoverage: rate(
        production.filter(({ evaluation }) => Boolean(evaluation)).length,
        production.length
      ),
    },
    typeFunnel: {
      stageCoverage,
      unknownRate,
      agreementWithHuman,
      confusion,
      runtimePrecisionRecall: buildPrecisionRecall(
        stagePredictions.runtime,
        expectedTypes
      ),
      inheritedRuntimeCount: production.filter(({ trace }) =>
        isInheritedRelation(trace.taskRelation)
      ).length,
      freshRuntimeCount: production.filter(
        ({ trace }) => trace.taskRelation === "new-parent"
      ).length,
      manualCorrectionCount: production.filter(
        ({ trace, evaluation }) =>
          Boolean(
            trace.manualQuestionTypeCorrectionId ??
              evaluation?.manualQuestionTypeCorrectionId
          )
      ).length,
      semanticLatencyMs: distribution(
        production.map(({ trace }) => trace.semanticTaxonomy?.durationMs)
      ),
      adjudicationLatencyMs: distribution(
        production.map(({ trace }) => trace.taxonomyAdjudication?.durationMs)
      ),
    },
    intentFunnel: {
      observed: intentObserved.length,
      recommendedSuppression: intentObserved.filter(
        ({ trace }) => trace.advisorWouldSuppress
      ).length,
      executionAuthorized: intentObserved.filter(
        ({ trace }) => trace.advisorExecutionAuthorized
      ).length,
      outputCommitted: intentObserved.filter(
        ({ trace }) =>
          trace.advisorOutputCommittedToUi ??
          isCommittedDisposition(trace.advisorOutputDisposition)
      ).length,
      visibleAnswerChanged: intentObserved.filter(
        ({ trace }) => trace.visibleAnswerChanged
      ).length,
      taskMutationAuthorized: intentObserved.filter(
        ({ trace }) => trace.taskMutationAuthorized
      ).length,
      humanLabeled: intentLabeled.length,
      falseActivation: rate(falseActivations.length, expectedIgnore.length),
      falseSuppression: rate(falseSuppressions.length, expectedAdvise.length),
      ignoredTurnModelCalls: falseActivations.length,
      ignoredTurnModelDurationMs: sum(
        falseActivations.map(
          ({ trace }) => trace.timingsMs?.model ?? trace.timingsMs?.advisor
        )
      ),
      behaviorEvidenceCoverage: rate(
        intentObserved.filter(
          ({ trace }) =>
            trace.advisorOutputCommittedToUi !== undefined ||
            trace.advisorOutputDisposition !== undefined
        ).length,
        intentObserved.length
      ),
    },
    continuityFunnel: {
      interviewerTurns: interviewerTurnCount,
      logicalQuestionUnits: logicalUnits.length,
      relationObserved: logicalUnits.filter(({ trace }) => trace.taskRelation)
        .length,
      parentActionObserved: logicalUnits.filter(({ trace }) =>
        actualParentAction(trace)
      ).length,
      promptCoverageObserved: logicalUnits.filter(
        ({ trace }) =>
          trace.advisorPromptIncludedLogicalQuestion !== undefined
      ).length,
      promptIncludedLogicalQuestion: rate(
        logicalUnits.filter(
          ({ trace }) => trace.advisorPromptIncludedLogicalQuestion
        ).length,
        logicalUnits.filter(
          ({ trace }) =>
            trace.advisorPromptIncludedLogicalQuestion !== undefined
        ).length
      ),
      referentialCompletionCount: logicalUnits.filter(({ trace }) =>
        trace.logicalQuestionCompositionReasons?.some((reason) =>
          reason.includes("referential")
        )
      ).length,
      truncatedLogicalQuestionCount: logicalUnits.filter(
        ({ trace }) => trace.logicalQuestionTruncated
      ).length,
      humanLabeled: continuityLabeled.length,
      relationAgreement: agreementRate(
        continuityLabeled.map(({ trace, evaluation }) => [
          evaluation?.expectedRelation,
          trace.taskRelation,
        ])
      ),
      parentActionAgreement: agreementRate(
        continuityLabeled.map(({ trace, evaluation }) => [
          evaluation?.expectedParentAction,
          actualParentAction(trace),
        ])
      ),
      expectedContextCoverage: averageRate(expectedContextMetrics),
    },
    evidenceGaps: {
      unlabeledProductionTraces: production.filter(
        ({ evaluation }) => !evaluation
      ).length,
      tracesWithoutBuildProvenance,
      tracesWithoutIntentCommitEvidence: intentObserved.filter(
        ({ trace }) =>
          trace.advisorOutputCommittedToUi === undefined &&
          trace.advisorOutputDisposition === undefined
      ).length,
      logicalUnitsWithoutRelation: logicalUnits.filter(
        ({ trace }) => !trace.taskRelation
      ).length,
      labelsWithoutMatchingTrace,
    },
  };
}

export function renderSessionLongitudinalEvaluationMarkdown(
  report: SessionLongitudinalEvaluationReport
) {
  const lines = [
    "# Jarvis Longitudinal Evaluation",
    "",
    `Generated: ${new Date(report.generatedAt).toISOString()}`,
    `Sessions: ${report.cohort.sessionCount}`,
    `Production traces: ${report.cohort.productionTraceCount}`,
    `Human-labeled trace coverage: ${formatRate(report.cohort.labeledTraceCoverage)}`,
    "",
    "## Type Funnel",
    "",
    "| Stage | Concrete coverage | Unknown rate | Human agreement |",
    "| --- | ---: | ---: | ---: |",
    ...TYPE_STAGES.map(
      (stage) =>
        `| ${stage} | ${formatRate(report.typeFunnel.stageCoverage[stage])} | ${formatRate(report.typeFunnel.unknownRate[stage])} | ${formatRate(report.typeFunnel.agreementWithHuman[stage])} |`
    ),
    "",
    `Manual corrections: ${report.typeFunnel.manualCorrectionCount}`,
    `Fresh / inherited runtime classifications: ${report.typeFunnel.freshRuntimeCount} / ${report.typeFunnel.inheritedRuntimeCount}`,
    `Semantic latency: ${formatDistribution(report.typeFunnel.semanticLatencyMs)}`,
    `LLM adjudication latency: ${formatDistribution(report.typeFunnel.adjudicationLatencyMs)}`,
    "",
    "## Intent Funnel",
    "",
    `Observed -> suppress recommended -> executed -> committed -> visible change -> task mutation: ${report.intentFunnel.observed} -> ${report.intentFunnel.recommendedSuppression} -> ${report.intentFunnel.executionAuthorized} -> ${report.intentFunnel.outputCommitted} -> ${report.intentFunnel.visibleAnswerChanged} -> ${report.intentFunnel.taskMutationAuthorized}`,
    `Human intent labels: ${report.intentFunnel.humanLabeled}`,
    `False activation: ${formatRate(report.intentFunnel.falseActivation)}`,
    `False suppression: ${formatRate(report.intentFunnel.falseSuppression)}`,
    `Known wasted model calls / time on human-labeled ignored turns: ${report.intentFunnel.ignoredTurnModelCalls} / ${report.intentFunnel.ignoredTurnModelDurationMs} ms`,
    "",
    "## Continuity Funnel",
    "",
    `Interviewer turns -> logical units -> relation observed -> parent action observed -> prompt coverage observed: ${report.continuityFunnel.interviewerTurns} -> ${report.continuityFunnel.logicalQuestionUnits} -> ${report.continuityFunnel.relationObserved} -> ${report.continuityFunnel.parentActionObserved} -> ${report.continuityFunnel.promptCoverageObserved}`,
    `Prompt includes logical question: ${formatRate(report.continuityFunnel.promptIncludedLogicalQuestion)}`,
    `Relation agreement: ${formatRate(report.continuityFunnel.relationAgreement)}`,
    `Parent-action agreement: ${formatRate(report.continuityFunnel.parentActionAgreement)}`,
    `Expected context-turn coverage: ${formatRate(report.continuityFunnel.expectedContextCoverage)}`,
    `Referential completions / truncated units: ${report.continuityFunnel.referentialCompletionCount} / ${report.continuityFunnel.truncatedLogicalQuestionCount}`,
    "",
    "## Evidence Gaps",
    "",
    `- Unlabeled production traces: ${report.evidenceGaps.unlabeledProductionTraces}`,
    `- Traces without build provenance: ${report.evidenceGaps.tracesWithoutBuildProvenance}`,
    `- Traces without intent commit evidence: ${report.evidenceGaps.tracesWithoutIntentCommitEvidence}`,
    `- Logical units without relation: ${report.evidenceGaps.logicalUnitsWithoutRelation}`,
    `- Labels without a matching trace: ${report.evidenceGaps.labelsWithoutMatchingTrace}`,
    "",
    "Rates show N/A when no valid human-labeled denominator exists.",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

const TYPE_STAGES: TypeStage[] = [
  "keyword",
  "semantic",
  "hybrid",
  "llmAdjudication",
  "runtime",
];

function predictionForStage(
  trace: LongitudinalTraceSummary,
  stage: TypeStage
): CanonicalQuestionType {
  if (stage === "keyword") {
    return normalizeType(
      trace.semanticTaxonomy?.keywordType ?? trace.rawQuestionType
    );
  }
  if (stage === "semantic") {
    return normalizeType(
      trace.semanticTaxonomy?.semanticTopCandidateType ??
        trace.semanticTaxonomy?.semanticCandidateType
    );
  }
  if (stage === "hybrid") {
    const effective = normalizeType(
      trace.semanticTaxonomy?.hybridEffectiveType
    );
    if (effective !== "unknown") return effective;
    const keyword = normalizeType(
      trace.semanticTaxonomy?.keywordType ?? trace.rawQuestionType
    );
    const semantic = normalizeType(
      trace.semanticTaxonomy?.semanticCandidateType
    );
    return trace.semanticTaxonomy?.rescueApplied && semantic !== "unknown"
      ? semantic
      : keyword;
  }
  if (stage === "llmAdjudication") {
    return normalizeType(trace.taxonomyAdjudication?.candidateType);
  }
  return normalizeType(trace.canonicalQuestionType ?? trace.questionType);
}

function normalizeType(value: string | undefined): CanonicalQuestionType {
  return normalizeCanonicalQuestionType(value) ?? "unknown";
}

function expectedQuestionType(
  evaluation: LongitudinalQuestionEvaluation | undefined
) {
  if (!evaluation) return undefined;
  const detected = normalizeCanonicalQuestionType(evaluation.questionType);
  const corrected = normalizeCanonicalQuestionType(
    evaluation.correctedQuestionType
  );
  if (
    corrected &&
    (evaluation.classification?.verdict === "wrong" ||
      Boolean(evaluation.manualQuestionTypeCorrectionId) ||
      (detected && detected !== corrected))
  ) {
    return corrected;
  }
  if (
    evaluation.classification?.verdict === "ok" ||
    evaluation.classification?.verdict === "partial"
  ) {
    return corrected ?? detected;
  }
  return undefined;
}

function indexLatestEvaluations(
  evaluations: LongitudinalQuestionEvaluation[]
) {
  const byTrace = new Map<string, LongitudinalQuestionEvaluation>();
  for (const evaluation of evaluations) {
    for (const traceId of evaluation.traceIds) {
      const current = byTrace.get(traceId);
      if (
        !current ||
        (evaluation.updatedAt ?? 0) >= (current.updatedAt ?? 0)
      ) {
        byTrace.set(traceId, evaluation);
      }
    }
  }
  return byTrace;
}

function buildConfusion(
  predicted: CanonicalQuestionType[],
  expected: Array<CanonicalQuestionType | undefined>
) {
  const matrix: Record<string, Record<string, number>> = {};
  for (let index = 0; index < predicted.length; index += 1) {
    const truth = expected[index];
    if (!truth) continue;
    matrix[truth] ??= {};
    matrix[truth][predicted[index]] =
      (matrix[truth][predicted[index]] ?? 0) + 1;
  }
  return matrix;
}

function buildPrecisionRecall(
  predicted: CanonicalQuestionType[],
  expected: Array<CanonicalQuestionType | undefined>
) {
  return Object.fromEntries(
    CANONICAL_QUESTION_TYPES.map((type) => {
      let truePositive = 0;
      let predictedPositive = 0;
      let actualPositive = 0;
      for (let index = 0; index < predicted.length; index += 1) {
        const truth = expected[index];
        if (!truth) continue;
        if (predicted[index] === type) predictedPositive += 1;
        if (truth === type) actualPositive += 1;
        if (predicted[index] === type && truth === type) truePositive += 1;
      }
      return [
        type,
        {
          precision: rate(truePositive, predictedPositive),
          recall: rate(truePositive, actualPositive),
        },
      ];
    })
  ) as SessionLongitudinalEvaluationReport["typeFunnel"]["runtimePrecisionRecall"];
}

function hasIntentEvidence({ trace }: JoinedTrace) {
  return Boolean(
    trace.advisorTurnIntent ||
      trace.turnGateAction ||
      trace.advisorWouldSuppress !== undefined ||
      trace.advisorExecutionAuthorized !== undefined
  );
}

function actualParentAction(trace: LongitudinalTraceSummary) {
  if (trace.taskBoundary?.mutationDisposition) {
    return trace.taskBoundary.mutationDisposition;
  }
  if (trace.taskRelation === "new-parent") return "new-parent";
  if (isInheritedRelation(trace.taskRelation)) return "preserve-parent";
  return undefined;
}

function isInheritedRelation(relation: string | undefined) {
  return (
    relation === "followup-parent" ||
    relation === "resume-parent" ||
    relation === "child-probe"
  );
}

function isCommittedDisposition(disposition: string | undefined) {
  return disposition === "committed" || disposition === "shadow-visible";
}

function contextCoverage(actual: string[], expected: string[]) {
  if (!expected.length) return undefined;
  const actualSet = new Set(actual);
  return (
    expected.filter((turnId) => actualSet.has(turnId)).length / expected.length
  );
}

function agreementRate(pairs: Array<[string | undefined, string | undefined]>) {
  const comparable = pairs.filter(
    (pair): pair is [string, string] => Boolean(pair[0] && pair[1])
  );
  return rate(
    comparable.filter(([expected, actual]) => expected === actual).length,
    comparable.length
  );
}

function averageRate(values: number[]): RateMetric {
  if (!values.length) return rate(0, 0);
  return {
    numerator: values.reduce((total, value) => total + value, 0),
    denominator: values.length,
    rate: values.reduce((total, value) => total + value, 0) / values.length,
  };
}

function rate(numerator: number, denominator: number): RateMetric {
  return {
    numerator,
    denominator,
    rate: denominator > 0 ? numerator / denominator : null,
  };
}

function distribution(values: Array<number | undefined>): DistributionMetric {
  const sorted = values
    .filter((value): value is number => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (!sorted.length) {
    return { samples: 0, p50Ms: null, p95Ms: null, maxMs: null };
  }
  return {
    samples: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1],
  };
}

function percentile(sorted: number[], quantile: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))];
}

function sum(values: Array<number | undefined>) {
  return values.reduce<number>(
    (total, value) => total + (Number.isFinite(value) ? value! : 0),
    0
  );
}

function formatRate(metric: RateMetric) {
  return metric.rate === null
    ? `N/A (0/${metric.denominator})`
    : `${(metric.rate * 100).toFixed(1)}% (${metric.numerator}/${metric.denominator})`;
}

function formatDistribution(metric: DistributionMetric) {
  return metric.samples
    ? `p50=${metric.p50Ms} ms, p95=${metric.p95Ms} ms, max=${metric.maxMs} ms, n=${metric.samples}`
    : "N/A";
}
