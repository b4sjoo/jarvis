import {
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";

export const TAXONOMY_ADJUDICATION_TRIGGER_RATE_REVIEW_THRESHOLD = 0.15;

export interface TaxonomyAdjudicationRecordedDecision {
  recordedAt: number;
  sessionId?: string;
  traceId: string;
  taskId?: string;
  metadata: Record<string, unknown>;
}

export interface TaxonomyAdjudicationEvaluationLabel {
  id: string;
  questionId: string;
  traceIds: string[];
  questionType?: string;
  correctedQuestionType?: string;
  relation?: string;
  correctedRelation?: string;
  taxonomyAdjudication?: {
    needed?: boolean;
    typeCorrect?: boolean;
    relationCorrect?: boolean;
    repairDisposition?: "automatic-repair" | "suggest-only" | "abstain";
    contextPreserved?: boolean;
    timely?: boolean;
  };
  updatedAt: number;
}

export interface TaxonomyAdjudicationCompactTrace {
  sessionId: string;
  traceId: string;
  canonicalQuestionType?: string;
  questionType?: string;
  semanticTaxonomy?: {
    keywordType?: string;
    semanticCandidateType?: string;
    hybridOutcome?: string;
    wouldRescue?: boolean;
    rescueApplied?: boolean;
  };
  taxonomyAdjudication?: {
    eligible?: boolean;
    skipReason?: string;
    operationId?: string;
    unitId?: string;
    unitRevision?: number;
    providerId?: string;
    modelId?: string;
    disposition?: string;
    providerDisposition?: string;
    parseDisposition?: string;
    staleReason?: string;
    candidateType?: string;
    relation?: string;
    parseValid?: boolean;
    arrivalStage?: string;
    wouldRepair?: boolean;
    repairApplied?: boolean;
    durationMs?: number;
    inputChars?: number;
    outputChars?: number;
  };
}

export interface TaxonomyAdjudicationReflectionRow {
  key: string;
  sessionId?: string;
  traceId: string;
  taskId?: string;
  unitId?: string;
  unitRevision?: number;
  eligible: boolean;
  skipReason?: string;
  triggerReasons: string[];
  providerId?: string;
  modelId?: string;
  disposition?: string;
  providerDisposition?: string;
  parseDisposition?: string;
  staleReason?: string;
  lexicalType: CanonicalQuestionType;
  localSemanticType?: CanonicalQuestionType;
  localHybridOutcome?: string;
  llmCandidateType?: CanonicalQuestionType;
  llmRelation?: string;
  runtimeType?: CanonicalQuestionType;
  expectedType?: CanonicalQuestionType;
  expectedRelation?: string;
  typeCorrect?: boolean;
  relationCorrect?: boolean;
  adjudicationNeeded?: boolean;
  repairDisposition?: "automatic-repair" | "suggest-only" | "abstain";
  contextPreserved?: boolean;
  timely?: boolean;
  parseValid?: boolean;
  arrivalStage?: string;
  wouldRepair: boolean;
  repairApplied: boolean;
  durationMs?: number;
  inputChars?: number;
  outputChars?: number;
}

export interface TaxonomyAdjudicationReflectionReport {
  version: 2;
  generatedAt: number;
  sessions: string[];
  funnel: {
    transcriptionUnits: EvaluationFunnelStage;
    substantiveUnits: EvaluationFunnelStage;
    eligibleUnits: EvaluationFunnelStage;
    triggeredCalls: EvaluationFunnelStage;
    providerValidOutputs: EvaluationFunnelStage;
    joinedHumanLabels: EvaluationFunnelStage;
    taxonomyAgreements: EvaluationFunnelStage;
    trajectoryAgreements: EvaluationFunnelStage;
  };
  metrics: {
    observedUnits: number;
    substantiveUnits: number;
    eligible: number;
    triggeredCalls: number;
    skipped: number;
    triggerRate: number | null;
    triggerRateTarget: number;
    triggerRateWarning: boolean;
    triggerReasons: Record<string, number>;
    dispositions: Record<string, number>;
    providerDispositions: Record<string, number>;
    parseDispositions: Record<string, number>;
    validOutputs: number;
    invalidOutputs: number;
    staleOrSuperseded: number;
    wouldRepair: number;
    repairApplied: number;
    correctButOperationallyUnusable: number;
    labeledTypeProposals: number;
    typePrecision: number | null;
    labeledRelationProposals: number;
    relationPrecision: number | null;
    labeledNeeded: number;
    neededRate: number | null;
    repairRecommendations: Record<string, number>;
    arrivalStages: Record<string, number>;
    providers: Record<string, number>;
    models: Record<string, number>;
    latency: { p50Ms: number; p95Ms: number };
    inputChars: number;
    outputChars: number;
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    exactTokenUsageAvailable: false;
    costEstimateAvailable: false;
  };
  typeConfusion: Record<string, Record<string, number>>;
  relationConfusion: Record<string, Record<string, number>>;
  rows: TaxonomyAdjudicationReflectionRow[];
  unmatchedEvaluations: Array<{
    evaluationId: string;
    questionId: string;
    traceIds: string[];
    expectedType?: CanonicalQuestionType;
    expectedRelation?: string;
    reason: "missing-recorded-decision" | "trace-not-selected";
  }>;
}

export interface EvaluationFunnelStage {
  count: number;
  denominator: number;
  rate: number | null;
}

export function buildTaxonomyAdjudicationReflectionReport(input: {
  decisions: TaxonomyAdjudicationRecordedDecision[];
  traces: TaxonomyAdjudicationCompactTrace[];
  evaluations: TaxonomyAdjudicationEvaluationLabel[];
}): TaxonomyAdjudicationReflectionReport {
  const traceById = new Map(input.traces.map((trace) => [trace.traceId, trace]));
  const evaluationByTraceId = new Map<string, TaxonomyAdjudicationEvaluationLabel>();
  for (const evaluation of [...input.evaluations].sort(
    (left, right) => left.updatedAt - right.updatedAt
  )) {
    for (const traceId of evaluation.traceIds) {
      evaluationByTraceId.set(traceId, evaluation);
    }
  }

  const rows = selectLatestUnitDecisions(input.decisions).map((decision) => {
    const metadata = decision.metadata;
    const trace = traceById.get(decision.traceId);
    const summary = trace?.taxonomyAdjudication;
    const evaluation = evaluationByTraceId.get(decision.traceId);
    const human = evaluation?.taxonomyAdjudication;
    const llmCandidateType = normalizeType(
      readString(metadata, "taxonomyAdjudicationCandidateType") ??
        summary?.candidateType
    );
    const expectedType = normalizeType(
      evaluation?.correctedQuestionType ?? evaluation?.questionType
    );
    const llmRelation =
      readString(metadata, "taxonomyAdjudicationRelation") ?? summary?.relation;
    const expectedRelation =
      evaluation?.correctedRelation ?? evaluation?.relation;
    const disposition =
      readString(metadata, "taxonomyAdjudicationDisposition") ??
      summary?.disposition;
    const unitId =
      readString(metadata, "taxonomyAdjudicationUnitId") ?? summary?.unitId;
    const unitRevision =
      readNumber(metadata, "taxonomyAdjudicationUnitRevision") ??
      summary?.unitRevision;
    const parseValid =
      readBoolean(metadata, "taxonomyAdjudicationParseValid") ??
      summary?.parseValid;
    const eligible =
      readBoolean(metadata, "taxonomyAdjudicationEligible") ??
      summary?.eligible ??
      false;
    const typeCorrect =
      human?.typeCorrect ??
      (expectedType && llmCandidateType
        ? expectedType === llmCandidateType
        : undefined);
    const relationCorrect =
      human?.relationCorrect ??
      (expectedRelation && llmRelation
        ? expectedRelation === llmRelation
        : undefined);

    return {
      key: `${decision.sessionId ?? trace?.sessionId ?? "unknown"}:${unitId ?? decision.traceId}:${unitRevision ?? 0}`,
      sessionId: decision.sessionId ?? trace?.sessionId,
      traceId: decision.traceId,
      taskId: decision.taskId,
      unitId,
      unitRevision,
      eligible,
      skipReason:
        readString(metadata, "taxonomyAdjudicationSkipReason") ??
        summary?.skipReason,
      triggerReasons: readStringArray(
        metadata,
        "taxonomyAdjudicationTriggerReasons"
      ),
      providerId:
        readString(metadata, "taxonomyAdjudicationProviderId") ??
        summary?.providerId,
      modelId:
        readString(metadata, "taxonomyAdjudicationModelId") ?? summary?.modelId,
      disposition,
      providerDisposition:
        readString(metadata, "taxonomyAdjudicationProviderDisposition") ??
        summary?.providerDisposition,
      parseDisposition:
        readString(metadata, "taxonomyAdjudicationParseDisposition") ??
        summary?.parseDisposition,
      staleReason:
        readString(metadata, "taxonomyAdjudicationStaleReason") ??
        summary?.staleReason,
      lexicalType:
        normalizeType(trace?.semanticTaxonomy?.keywordType) ?? "unknown",
      localSemanticType: normalizeType(
        trace?.semanticTaxonomy?.semanticCandidateType
      ),
      localHybridOutcome: trace?.semanticTaxonomy?.hybridOutcome,
      llmCandidateType,
      llmRelation,
      runtimeType: normalizeType(
        trace?.canonicalQuestionType ?? trace?.questionType
      ),
      expectedType,
      expectedRelation,
      typeCorrect,
      relationCorrect,
      adjudicationNeeded: human?.needed,
      repairDisposition: human?.repairDisposition,
      contextPreserved: human?.contextPreserved,
      timely: human?.timely,
      parseValid,
      arrivalStage:
        readString(metadata, "taxonomyAdjudicationArrivalStage") ??
        summary?.arrivalStage,
      wouldRepair:
        readBoolean(metadata, "taxonomyAdjudicationWouldRepair") ??
        summary?.wouldRepair ??
        false,
      repairApplied:
        readBoolean(metadata, "taxonomyAdjudicationRepairApplied") ??
        summary?.repairApplied ??
        false,
      durationMs:
        readNumber(metadata, "taxonomyAdjudicationDurationMs") ??
        summary?.durationMs,
      inputChars:
        readNumber(metadata, "taxonomyAdjudicationInputChars") ??
        summary?.inputChars,
      outputChars:
        readNumber(metadata, "taxonomyAdjudicationOutputChars") ??
        summary?.outputChars,
    } satisfies TaxonomyAdjudicationReflectionRow;
  });

  const substantiveRows = rows.filter(isSubstantiveObservedUnit);
  const eligibleRows = substantiveRows.filter((row) => row.eligible);
  const triggeredRows = eligibleRows.filter(isTriggeredRow);
  const providerValidRows = triggeredRows.filter(isProviderValidRow);
  const joinedHumanRows = providerValidRows.filter((row) =>
    hasTaxonomyEvaluation(evaluationByTraceId.get(row.traceId))
  );
  const typeLabeled = joinedHumanRows.filter(
    (row) => row.typeCorrect !== undefined
  );
  const relationLabeled = joinedHumanRows.filter(
    (row) => row.relationCorrect !== undefined
  );
  const neededLabeled = rows.filter(
    (row) => row.adjudicationNeeded !== undefined
  );
  const durations = triggeredRows
    .map((row) => row.durationMs)
    .filter((value): value is number => value !== undefined);
  const sessions = Array.from(
    new Set(rows.map((row) => row.sessionId).filter(Boolean))
  ) as string[];
  const matchedEvaluationIds = new Set(
    rows
      .map((row) => evaluationByTraceId.get(row.traceId)?.id)
      .filter(Boolean)
  );
  const inputChars = sum(rows.map((row) => row.inputChars));
  const outputChars = sum(rows.map((row) => row.outputChars));
  const triggerRate = ratio(triggeredRows.length, substantiveRows.length);
  const traceIdsWithDecisions = new Set(rows.map((row) => row.traceId));
  const knownTraceIds = new Set(input.traces.map((trace) => trace.traceId));
  const taxonomyAgreements = typeLabeled.filter((row) => row.typeCorrect).length;
  const trajectoryAgreements = relationLabeled.filter(
    (row) => row.relationCorrect
  ).length;

  return {
    version: 2,
    generatedAt: Date.now(),
    sessions,
    funnel: {
      transcriptionUnits: funnelStage(rows.length, rows.length),
      substantiveUnits: funnelStage(substantiveRows.length, rows.length),
      eligibleUnits: funnelStage(eligibleRows.length, substantiveRows.length),
      triggeredCalls: funnelStage(triggeredRows.length, eligibleRows.length),
      providerValidOutputs: funnelStage(
        providerValidRows.length,
        triggeredRows.length
      ),
      joinedHumanLabels: funnelStage(
        joinedHumanRows.length,
        providerValidRows.length
      ),
      taxonomyAgreements: funnelStage(
        taxonomyAgreements,
        typeLabeled.length
      ),
      trajectoryAgreements: funnelStage(
        trajectoryAgreements,
        relationLabeled.length
      ),
    },
    metrics: {
      observedUnits: rows.length,
      substantiveUnits: substantiveRows.length,
      eligible: eligibleRows.length,
      triggeredCalls: triggeredRows.length,
      skipped: rows.filter((row) => !row.eligible || !row.durationMs).length,
      triggerRate,
      triggerRateTarget:
        TAXONOMY_ADJUDICATION_TRIGGER_RATE_REVIEW_THRESHOLD,
      triggerRateWarning:
        triggerRate !== null &&
        triggerRate > TAXONOMY_ADJUDICATION_TRIGGER_RATE_REVIEW_THRESHOLD,
      triggerReasons: countStrings(
        rows.flatMap((row) => row.triggerReasons)
      ),
      dispositions: countStrings(rows.map((row) => row.disposition)),
      providerDispositions: countStrings(
        triggeredRows.map((row) => row.providerDisposition)
      ),
      parseDispositions: countStrings(
        triggeredRows.map((row) => row.parseDisposition)
      ),
      validOutputs: providerValidRows.length,
      invalidOutputs: triggeredRows.filter((row) => row.parseValid === false)
        .length,
      staleOrSuperseded: rows.filter(
        (row) => row.disposition === "stale" || row.disposition === "superseded"
      ).length,
      wouldRepair: rows.filter((row) => row.wouldRepair).length,
      repairApplied: rows.filter((row) => row.repairApplied).length,
      correctButOperationallyUnusable: rows.filter(
        (row) =>
          row.typeCorrect === true &&
          (row.disposition === "stale" ||
            row.disposition === "superseded" ||
            row.disposition === "invalid-output" ||
            row.disposition === "provider-error-output" ||
            row.arrivalStage === "post-visible-answer")
      ).length,
      labeledTypeProposals: typeLabeled.length,
      typePrecision: ratio(
        typeLabeled.filter((row) => row.typeCorrect).length,
        typeLabeled.length
      ),
      labeledRelationProposals: relationLabeled.length,
      relationPrecision: ratio(
        relationLabeled.filter((row) => row.relationCorrect).length,
        relationLabeled.length
      ),
      labeledNeeded: neededLabeled.length,
      neededRate: ratio(
        neededLabeled.filter((row) => row.adjudicationNeeded).length,
        neededLabeled.length
      ),
      repairRecommendations: countStrings(
        rows.map((row) => row.repairDisposition)
      ),
      arrivalStages: countStrings(rows.map((row) => row.arrivalStage)),
      providers: countStrings(triggeredRows.map((row) => row.providerId)),
      models: countStrings(triggeredRows.map((row) => row.modelId)),
      latency: {
        p50Ms: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
      },
      inputChars,
      outputChars,
      estimatedInputTokens: Math.ceil(inputChars / 4),
      estimatedOutputTokens: Math.ceil(outputChars / 4),
      exactTokenUsageAvailable: false,
      costEstimateAvailable: false,
    },
    typeConfusion: buildConfusion(
      rows.map((row) => [row.expectedType, row.llmCandidateType])
    ),
    relationConfusion: buildConfusion(
      rows.map((row) => [row.expectedRelation, row.llmRelation])
    ),
    rows,
    unmatchedEvaluations: input.evaluations
      .filter(
        (evaluation) =>
          hasTaxonomyEvaluation(evaluation) &&
          !matchedEvaluationIds.has(evaluation.id)
      )
      .map((evaluation) => ({
        evaluationId: evaluation.id,
        questionId: evaluation.questionId,
        traceIds: evaluation.traceIds,
        expectedType: normalizeType(
          evaluation.correctedQuestionType ?? evaluation.questionType
        ),
        expectedRelation:
          evaluation.correctedRelation ?? evaluation.relation,
        reason: evaluation.traceIds.some((traceId) =>
          knownTraceIds.has(traceId)
        )
          ? ("trace-not-selected" as const)
          : evaluation.traceIds.some((traceId) =>
                traceIdsWithDecisions.has(traceId)
              )
            ? ("trace-not-selected" as const)
            : ("missing-recorded-decision" as const),
      })),
  };
}

export function renderTaxonomyAdjudicationReflectionMarkdown(
  report: TaxonomyAdjudicationReflectionReport
) {
  const percent = (value: number | null) =>
    value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
  const lines = [
    "# LLM Taxonomy Adjudication Reflection",
    "",
    `Generated: ${new Date(report.generatedAt).toISOString()}`,
    `Sessions: ${report.sessions.join(", ") || "-"}`,
    "",
    "## Summary",
    "",
    `- Observed / substantive units: ${report.metrics.observedUnits} / ${report.metrics.substantiveUnits}`,
    `- Eligible / triggered calls: ${report.metrics.eligible} / ${report.metrics.triggeredCalls}`,
    `- Trigger rate: ${percent(report.metrics.triggerRate)}`,
    `- Trigger-rate review: ${report.metrics.triggerRateWarning ? "WARNING" : "within target"} (target <= ${percent(report.metrics.triggerRateTarget)})`,
    `- Valid / invalid outputs: ${report.metrics.validOutputs} / ${report.metrics.invalidOutputs}`,
    `- Stale or superseded: ${report.metrics.staleOrSuperseded}`,
    `- Would repair / applied: ${report.metrics.wouldRepair} / ${report.metrics.repairApplied}`,
    `- Type precision: ${percent(report.metrics.typePrecision)} (${report.metrics.labeledTypeProposals} labeled)`,
    `- Relation precision: ${percent(report.metrics.relationPrecision)} (${report.metrics.labeledRelationProposals} labeled)`,
    `- Correct but operationally unusable: ${report.metrics.correctButOperationallyUnusable}`,
    `- Latency p50 / p95: ${report.metrics.latency.p50Ms.toFixed(1)}ms / ${report.metrics.latency.p95Ms.toFixed(1)}ms`,
    `- Estimated input / output tokens: ${report.metrics.estimatedInputTokens} / ${report.metrics.estimatedOutputTokens}`,
    "- Exact token usage and cost: unavailable from the current provider stream contract",
    "",
    "## Evaluation Funnel",
    "",
    ...formatFunnel(report.funnel),
    "",
    "## Decision Comparison",
    "",
    "| Unit | Lexical | Local semantic | LLM | Runtime | Relation | Disposition | Repair | Human | Timing |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...report.rows.map(
      (row) =>
        `| ${escapeCell(`${row.unitId ?? row.traceId}@${row.unitRevision ?? 0}`)} | ${row.lexicalType} | ${row.localSemanticType ?? "-"} | ${row.llmCandidateType ?? "-"} | ${row.runtimeType ?? "-"} | ${row.llmRelation ?? "-"} | ${row.disposition ?? row.skipReason ?? "-"} | ${row.repairApplied ? "applied" : row.wouldRepair ? "would" : "-"} | ${formatHumanVerdict(row)} | ${row.arrivalStage ?? "-"} |`
    ),
    "",
    "## Dispositions",
    "",
    ...formatCountMap(report.metrics.dispositions),
    "",
    "## Trigger Reasons",
    "",
    ...formatCountMap(report.metrics.triggerReasons),
    "",
    "## Provider / Parser Diagnostics",
    "",
    "### Provider Dispositions",
    "",
    ...formatCountMap(report.metrics.providerDispositions),
    "",
    "### Parse Dispositions",
    "",
    ...formatCountMap(report.metrics.parseDispositions),
    "",
    "## Type Confusion",
    "",
    ...formatConfusion(report.typeConfusion),
    "",
    "## Relation Confusion",
    "",
    ...formatConfusion(report.relationConfusion),
    "",
    "## Rollout Interpretation",
    "",
    "This report is Shadow evidence only. A correct LLM proposal is not counted as product success when it is stale, superseded, invalid, or arrives after a visible answer. No threshold, prototype, task boundary, model route, answer, Code artifact, or Whiteboard artifact is mutated by this reflection command.",
  ];
  if (report.unmatchedEvaluations.length) {
    lines.push("", "## Joinability Gaps", "");
    for (const evaluation of report.unmatchedEvaluations) {
      lines.push(
        `- ${evaluation.evaluationId}: ${evaluation.reason}; question=${evaluation.questionId}; expected=${evaluation.expectedType ?? "-"} / ${evaluation.expectedRelation ?? "-"}; traces=${evaluation.traceIds.join(", ") || "-"}.`
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function selectLatestUnitDecisions(
  decisions: TaxonomyAdjudicationRecordedDecision[]
) {
  const latest = new Map<string, TaxonomyAdjudicationRecordedDecision>();
  for (const decision of [...decisions].sort(
    (left, right) => left.recordedAt - right.recordedAt
  )) {
    const unitId = readString(decision.metadata, "taxonomyAdjudicationUnitId");
    const revision = readNumber(
      decision.metadata,
      "taxonomyAdjudicationUnitRevision"
    );
    const key = `${decision.sessionId ?? "unknown"}:${unitId ?? decision.traceId}:${revision ?? 0}`;
    latest.set(key, decision);
  }
  return Array.from(latest.values()).sort(
    (left, right) => left.recordedAt - right.recordedAt
  );
}

function isSubstantiveObservedUnit(row: TaxonomyAdjudicationReflectionRow) {
  const reason = row.skipReason ?? "";
  return !(
    reason.startsWith("turn-gate-") ||
    reason === "speaker-is-not-interviewer" ||
    reason === "question-unit-too-short" ||
    reason === "unsafe-question-projection" ||
    reason === "evaluation-surface-inactive" ||
    reason === "taxonomy-adjudication-disabled"
  );
}

function normalizeType(value: unknown): CanonicalQuestionType | undefined {
  return normalizeCanonicalQuestionType(value);
}

function readString(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readBoolean(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "boolean" ? value : undefined;
}

function readStringArray(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && Boolean(item)
      )
    : [];
}

function ratio(numerator: number, denominator: number) {
  return denominator ? numerator / denominator : null;
}

function funnelStage(count: number, denominator: number): EvaluationFunnelStage {
  return {
    count,
    denominator,
    rate: ratio(count, denominator),
  };
}

function sum(values: Array<number | undefined>) {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function percentile(values: number[], percentileValue: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(percentileValue * sorted.length) - 1)
  );
  return sorted[index] ?? 0;
}

function countStrings(values: Array<string | undefined>) {
  const counts: Record<string, number> = {};
  for (const value of values) {
    if (!value) continue;
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function buildConfusion(
  pairs: Array<[string | undefined, string | undefined]>
) {
  const confusion: Record<string, Record<string, number>> = {};
  for (const [expected, actual] of pairs) {
    if (!expected || !actual) continue;
    confusion[expected] ??= {};
    confusion[expected][actual] = (confusion[expected][actual] ?? 0) + 1;
  }
  return confusion;
}

function formatHumanVerdict(row: TaxonomyAdjudicationReflectionRow) {
  const labels = [
    row.typeCorrect === undefined
      ? undefined
      : row.typeCorrect
        ? "type-ok"
        : "type-wrong",
    row.relationCorrect === undefined
      ? undefined
      : row.relationCorrect
        ? "relation-ok"
        : "relation-wrong",
    row.repairDisposition,
  ].filter(Boolean);
  return labels.join(", ") || "unlabeled";
}

function formatCountMap(values: Record<string, number>) {
  const entries = Object.entries(values).sort((left, right) =>
    left[0].localeCompare(right[0])
  );
  return entries.length
    ? entries.map(([key, value]) => `- ${key}: ${value}`)
    : ["- No data."];
}

function formatFunnel(
  funnel: TaxonomyAdjudicationReflectionReport["funnel"]
) {
  return Object.entries(funnel).map(([name, stage]) => {
    const rate =
      stage.rate === null ? "N/A" : `${(stage.rate * 100).toFixed(1)}%`;
    return `- ${name}: ${stage.count} / ${stage.denominator} (${rate})`;
  });
}

function isTriggeredRow(row: TaxonomyAdjudicationReflectionRow) {
  return Boolean(
    row.durationMs !== undefined ||
      row.providerDisposition ||
      row.parseDisposition ||
      row.disposition === "provider-error-output" ||
      row.disposition === "invalid-output" ||
      row.disposition === "completed" ||
      row.disposition === "stale" ||
      row.disposition === "superseded"
  );
}

function isProviderValidRow(row: TaxonomyAdjudicationReflectionRow) {
  return (
    row.parseValid === true &&
    row.providerDisposition !== "provider-auth-error" &&
    row.providerDisposition !== "provider-configuration-error"
  );
}

function hasTaxonomyEvaluation(
  evaluation: TaxonomyAdjudicationEvaluationLabel | undefined
) {
  return Boolean(
    evaluation &&
      (evaluation.taxonomyAdjudication ||
        normalizeType(
          evaluation.correctedQuestionType ?? evaluation.questionType
        ) ||
        evaluation.correctedRelation ||
        evaluation.relation)
  );
}

function formatConfusion(values: Record<string, Record<string, number>>) {
  const rows = Object.entries(values).flatMap(([expected, actuals]) =>
    Object.entries(actuals).map(
      ([actual, count]) => `- expected=${expected}, proposed=${actual}: ${count}`
    )
  );
  return rows.length ? rows : ["- No labeled pairs."];
}

function escapeCell(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
