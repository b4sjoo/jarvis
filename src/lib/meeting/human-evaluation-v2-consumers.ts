import type {
  HumanEvaluationProjectionV2,
  HumanGroundTruthFactV2,
} from "./human-ground-truth-v2.js";
import { toHumanEvalQuestionType } from "./task-taxonomy.js";
import type {
  AdvisorIntentHumanEvaluation,
  HumanEvaluationVerdict,
  HumanEvaluationVerdictBlock,
  QuestionHumanEvaluation,
} from "./types.js";

const COMPATIBILITY_REPORT_VERSION = 2 as const;

type CompatibilityDimension =
  | "questionType"
  | "relation"
  | "parentAction"
  | "runtimeAction"
  | "observedRuntimeAction"
  | "answerOutcome"
  | "contextReadScope"
  | "artifactIntent"
  | "meetingMetadata";

export interface HumanEvaluationDimensionParity {
  v1Labeled: number;
  v2Labeled: number;
  overlap: number;
  agreement: number;
  disagreement: number;
  v1Only: number;
  v2Only: number;
}

export interface HumanEvaluationV2CompatibilityReport {
  version: typeof COMPATIBILITY_REPORT_VERSION;
  generatedAt: number;
  derivationVersions: string[];
  v1EvaluationCount: number;
  v2ProjectionCount: number;
  matchedProjectionCount: number;
  v1OnlyEvaluationCount: number;
  v2OnlyProjectionCount: number;
  conflictProjectionCount: number;
  projectionsWithTraceHashes: number;
  semanticInputEventCount: number;
  interventionOnlyEventCount: number;
  interaction: {
    measuredProjectionCount: number;
    durationP50Ms?: number;
    durationP90Ms?: number;
    clickCountP50?: number;
    clickCountP90?: number;
    expertAuditExpandedCount: number;
  };
  dimensions: Record<
    CompatibilityDimension,
    HumanEvaluationDimensionParity
  >;
  unmatchedV1EvaluationIds: string[];
  unmatchedV2ProjectionIds: string[];
  warnings: Array<{
    code:
      | "v1-only-evaluation"
      | "v2-only-projection"
      | "v2-conflicting-facts"
      | "v1-lossy-field"
      | "observed-runtime-mismatch";
    subjectId: string;
    detail: string;
  }>;
}

export interface HumanEvaluationV2ConsumerProjection {
  evaluations: QuestionHumanEvaluation[];
  report: HumanEvaluationV2CompatibilityReport;
}

export function projectHumanEvaluationsForLegacyConsumers(input: {
  evaluations: QuestionHumanEvaluation[];
  projections: HumanEvaluationProjectionV2[];
  now?: number;
}): HumanEvaluationV2ConsumerProjection {
  const evaluations = input.evaluations.map(cloneQuestionEvaluation);
  const matchedEvaluationIds = new Set<string>();
  const matchedProjectionIds = new Set<string>();

  for (const projection of [...input.projections].sort(
    (left, right) => left.computedAt - right.computedAt
  )) {
    const index = findMatchingEvaluationIndex(evaluations, projection);
    if (index >= 0) {
      const existing = evaluations[index];
      evaluations[index] = applyProjectionToQuestionEvaluation(
        existing,
        projection
      );
      matchedEvaluationIds.add(existing.id);
      matchedProjectionIds.add(projection.projectionId);
      continue;
    }

    evaluations.push(createQuestionEvaluationFromProjection(projection));
  }

  return {
    evaluations,
    report: buildHumanEvaluationV2CompatibilityReport({
      evaluations: input.evaluations,
      projections: input.projections,
      matchedEvaluationIds,
      matchedProjectionIds,
      now: input.now,
    }),
  };
}

export function buildHumanEvaluationV2CompatibilityReport(input: {
  evaluations: QuestionHumanEvaluation[];
  projections: HumanEvaluationProjectionV2[];
  matchedEvaluationIds?: Set<string>;
  matchedProjectionIds?: Set<string>;
  now?: number;
}): HumanEvaluationV2CompatibilityReport {
  const pairs = matchEvaluationPairs(input.evaluations, input.projections);
  const matchedEvaluationIds =
    input.matchedEvaluationIds ??
    new Set(pairs.map(({ evaluation }) => evaluation.id));
  const matchedProjectionIds =
    input.matchedProjectionIds ??
    new Set(pairs.map(({ projection }) => projection.projectionId));
  const dimensions = createEmptyDimensionReport();

  for (const dimension of Object.keys(
    dimensions
  ) as CompatibilityDimension[]) {
    const v1Labels = new Map<string, string>();
    for (const evaluation of input.evaluations) {
      const value = readV1Dimension(evaluation, dimension);
      if (value) v1Labels.set(evaluation.id, value);
    }
    const v2Labels = new Map<string, string>();
    for (const projection of input.projections) {
      const value = readV2Dimension(projection, dimension);
      if (value) v2Labels.set(projection.projectionId, value);
    }
    const metric = dimensions[dimension];
    metric.v1Labeled = v1Labels.size;
    metric.v2Labeled = v2Labels.size;

    for (const { evaluation, projection } of pairs) {
      const v1 = v1Labels.get(evaluation.id);
      const v2 = v2Labels.get(projection.projectionId);
      if (v1 && v2) {
        metric.overlap += 1;
        if (v1 === v2) metric.agreement += 1;
        else metric.disagreement += 1;
      } else if (v1) {
        metric.v1Only += 1;
      } else if (v2) {
        metric.v2Only += 1;
      }
    }
    metric.v1Only += Array.from(v1Labels.keys()).filter(
      (id) => !matchedEvaluationIds.has(id)
    ).length;
    metric.v2Only += Array.from(v2Labels.keys()).filter(
      (id) => !matchedProjectionIds.has(id)
    ).length;
  }

  const unmatchedV1EvaluationIds = input.evaluations
    .filter((evaluation) => !matchedEvaluationIds.has(evaluation.id))
    .map((evaluation) => evaluation.id);
  const unmatchedV2ProjectionIds = input.projections
    .filter(
      (projection) => !matchedProjectionIds.has(projection.projectionId)
    )
    .map((projection) => projection.projectionId);
  const warnings: HumanEvaluationV2CompatibilityReport["warnings"] = [
    ...unmatchedV1EvaluationIds.map((id) => ({
      code: "v1-only-evaluation" as const,
      subjectId: id,
      detail: "No exact V2 question or trace identity matched this V1 label.",
    })),
    ...unmatchedV2ProjectionIds.map((id) => ({
      code: "v2-only-projection" as const,
      subjectId: id,
      detail:
        "No V1 evaluation matched; consumers receive a synthetic compatibility view.",
    })),
    ...input.projections
      .filter((projection) => projection.conflicts.length > 0)
      .map((projection) => ({
        code: "v2-conflicting-facts" as const,
        subjectId: projection.projectionId,
        detail: projection.conflicts
          .map((conflict) => conflict.factKind)
          .join(", "),
      })),
    ...input.evaluations
      .filter(hasLossyV1CorrectnessOnlyField)
      .map((evaluation) => ({
        code: "v1-lossy-field" as const,
        subjectId: evaluation.id,
        detail:
          "A V1 correctness boolean has no exact expected value and was not promoted to V2 ground truth.",
      })),
    ...pairs
      .filter(({ evaluation, projection }) => {
        const legacyObserved = readV1Dimension(
          evaluation,
          "observedRuntimeAction"
        );
        const finalObserved = readV2Dimension(
          projection,
          "observedRuntimeAction"
        );
        return Boolean(
          legacyObserved &&
            finalObserved &&
            legacyObserved !== finalObserved
        );
      })
      .map(({ evaluation, projection }) => ({
        code: "observed-runtime-mismatch" as const,
        subjectId: projection.projectionId,
        detail: `Legacy observed action ${readV1Dimension(
          evaluation,
          "observedRuntimeAction"
        )} conflicts with final trace action ${readV2Dimension(
          projection,
          "observedRuntimeAction"
        )}.`,
      })),
  ];

  return {
    version: COMPATIBILITY_REPORT_VERSION,
    generatedAt: input.now ?? Date.now(),
    derivationVersions: Array.from(
      new Set(input.projections.map((projection) => projection.derivationVersion))
    ).sort(),
    v1EvaluationCount: input.evaluations.length,
    v2ProjectionCount: input.projections.length,
    matchedProjectionCount: matchedProjectionIds.size,
    v1OnlyEvaluationCount: unmatchedV1EvaluationIds.length,
    v2OnlyProjectionCount: unmatchedV2ProjectionIds.length,
    conflictProjectionCount: input.projections.filter(
      (projection) => projection.conflicts.length > 0
    ).length,
    projectionsWithTraceHashes: input.projections.filter(
      (projection) => projection.inputTraceHashes.length > 0
    ).length,
    semanticInputEventCount: new Set(
      input.projections.flatMap(
        (projection) => projection.semanticInputEventIds ?? []
      )
    ).size,
    interventionOnlyEventCount: new Set(
      input.projections.flatMap(
        (projection) => projection.interventionOnlyEventIds ?? []
      )
    ).size,
    interaction: buildInteractionSummary(input.projections),
    dimensions,
    unmatchedV1EvaluationIds,
    unmatchedV2ProjectionIds,
    warnings,
  };
}

function buildInteractionSummary(
  projections: HumanEvaluationProjectionV2[]
): HumanEvaluationV2CompatibilityReport["interaction"] {
  const measured = projections
    .map((projection) => projection.interaction)
    .filter(
      (
        interaction
      ): interaction is NonNullable<
        HumanEvaluationProjectionV2["interaction"]
      > => interaction !== undefined
    );
  return {
    measuredProjectionCount: measured.length,
    durationP50Ms: percentile(
      measured.map((interaction) => interaction.durationMs),
      0.5
    ),
    durationP90Ms: percentile(
      measured.map((interaction) => interaction.durationMs),
      0.9
    ),
    clickCountP50: percentile(
      measured.map((interaction) => interaction.clickCount),
      0.5
    ),
    clickCountP90: percentile(
      measured.map((interaction) => interaction.clickCount),
      0.9
    ),
    expertAuditExpandedCount: measured.filter((interaction) =>
      interaction.expandedRegions.includes("expert-audit")
    ).length,
  };
}

function percentile(values: number[], quantile: number) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil((sorted.length - 1) * quantile)];
}

function applyProjectionToQuestionEvaluation(
  evaluation: QuestionHumanEvaluation,
  projection: HumanEvaluationProjectionV2
): QuestionHumanEvaluation {
  const settlement =
    projection.activeFacts["expected-task-settlement"]?.fact;
  const typeOnly = projection.activeFacts["expected-question-type"]?.fact;
  const expectedType =
    settlement?.kind === "expected-task-settlement"
      ? settlement.expectedQuestionType
      : typeOnly?.kind === "expected-question-type"
        ? typeOnly.expectedQuestionType
        : undefined;
  const runtime = projection.activeFacts["expected-runtime-action"]?.fact;
  const answer = projection.activeFacts["answer-quality"]?.fact;
  const primaryAsk = projection.activeFacts["primary-ask-correction"]?.fact;
  const meetingMetadata =
    projection.activeFacts["expected-meeting-metadata"]?.fact;

  return {
    ...evaluation,
    sessionId: projection.sessionId || evaluation.sessionId,
    questionId: projection.subject.questionId ?? evaluation.questionId,
    taskId: projection.subject.taskId ?? evaluation.taskId,
    traceIds: uniqueStrings([
      ...evaluation.traceIds,
      ...projection.subject.traceIds,
    ]),
    questionType:
      projection.observed?.questionType !== undefined
        ? toHumanEvalQuestionType(projection.observed.questionType)
        : evaluation.questionType,
    correctedQuestionType: expectedType
      ? toHumanEvalQuestionType(expectedType)
      : evaluation.correctedQuestionType,
    company:
      projection.observed?.meetingMetadata?.effectiveCompany ??
      evaluation.company,
    correctedCompany:
      meetingMetadata?.kind === "expected-meeting-metadata" &&
      meetingMetadata.expectedCompany !== null
        ? meetingMetadata.expectedCompany
        : evaluation.correctedCompany,
    expectedRelation:
      settlement?.kind === "expected-task-settlement"
        ? settlement.expectedRelation
        : evaluation.expectedRelation,
    expectedParentAction:
      settlement?.kind === "expected-task-settlement"
        ? settlement.expectedParentAction
        : evaluation.expectedParentAction,
    relation: projection.observed?.relation ?? evaluation.relation,
    classification:
      projection.verdicts.questionTypeCorrect === undefined
        ? evaluation.classification
        : verdictBlockFromBoolean(
            projection.verdicts.questionTypeCorrect,
            "v2-question-type"
          ),
    currentQuestionSettlement: {
      ...evaluation.currentQuestionSettlement,
      questionTypeCorrect:
        projection.verdicts.questionTypeCorrect ??
        evaluation.currentQuestionSettlement?.questionTypeCorrect,
      relationCorrect:
        projection.verdicts.relationCorrect ??
        evaluation.currentQuestionSettlement?.relationCorrect,
      parentMutationCorrect:
        projection.verdicts.parentActionCorrect ??
        evaluation.currentQuestionSettlement?.parentMutationCorrect,
    },
    advisorIntent:
      runtime?.kind === "expected-runtime-action"
        ? buildAdvisorIntentCompatibility(projection, runtime.expectedAction)
        : evaluation.advisorIntent,
    answer:
      answer?.kind === "answer-quality"
        ? answerVerdictBlock(answer.outcome, answer.failureReasons)
        : evaluation.answer,
    primaryAskCorrect:
      primaryAsk?.kind === "primary-ask-correction"
        ? false
        : evaluation.primaryAskCorrect,
    updatedAt: Math.max(evaluation.updatedAt, projection.computedAt),
  };
}

function createQuestionEvaluationFromProjection(
  projection: HumanEvaluationProjectionV2
): QuestionHumanEvaluation {
  const empty = emptyVerdictBlock();
  return applyProjectionToQuestionEvaluation(
    {
      id: `v2-compat:${projection.projectionId}`,
      sessionId: projection.sessionId,
      questionId:
        projection.subject.questionId ??
        projection.subject.momentId ??
        projection.projectionId,
      taskId: projection.subject.taskId,
      traceIds: [...projection.subject.traceIds],
      selectedDiagramOverlayIds: [],
      classification: { ...empty },
      playbook: { ...empty },
      playbookPhase: { ...empty },
      memory: { ...empty },
      whiteboard: { ...empty },
      manualPhaseTransition: { ...empty },
      diagramOverlay: { ...empty },
      guardrail: { ...empty },
      answer: { ...empty },
      memoryEntryLabels: [],
      missingExpectedMemory: [],
      createdAt: projection.computedAt,
      updatedAt: projection.computedAt,
    },
    projection
  );
}

function buildAdvisorIntentCompatibility(
  projection: HumanEvaluationProjectionV2,
  expectedAction: AdvisorIntentHumanEvaluation["expectedAction"]
): AdvisorIntentHumanEvaluation {
  const observedAction = {
    advise: "advised",
    "append-context": "append-only",
    buffer: "buffered",
    ignore: "suppressed",
  }[projection.observed?.runtimeAction ?? "ignore"] as
    AdvisorIntentHumanEvaluation["observedAction"];
  const correct = projection.verdicts.runtimeActionCorrect;
  const verdict =
    correct === true
      ? "ok"
      : expectedAction === "advise"
        ? "false-negative"
        : "false-positive";
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
    source: "explicit-human-label",
    originalTraceId:
      projection.observed?.traceId ??
      projection.subject.traceIds[0] ??
      `projection:${projection.projectionId}`,
    sourceTurnIds: [...projection.subject.sourceTurnIds],
    createdAt: projection.computedAt,
    updatedAt: projection.computedAt,
  };
}

function matchEvaluationPairs(
  evaluations: QuestionHumanEvaluation[],
  projections: HumanEvaluationProjectionV2[]
) {
  const pairs: Array<{
    evaluation: QuestionHumanEvaluation;
    projection: HumanEvaluationProjectionV2;
  }> = [];
  const consumed = new Set<string>();
  for (const projection of projections) {
    const candidates = evaluations.filter(
      (evaluation) =>
        !consumed.has(evaluation.id) &&
        evaluationMatchesProjection(evaluation, projection)
    );
    if (candidates.length !== 1) continue;
    consumed.add(candidates[0].id);
    pairs.push({ evaluation: candidates[0], projection });
  }
  return pairs;
}

function findMatchingEvaluationIndex(
  evaluations: QuestionHumanEvaluation[],
  projection: HumanEvaluationProjectionV2
) {
  const questionId = projection.subject.questionId;
  if (questionId) {
    const exact = evaluations.findIndex(
      (evaluation) =>
        evaluation.questionId === questionId &&
        sessionMatches(evaluation.sessionId, projection.sessionId)
    );
    if (exact >= 0) return exact;
  }
  const traceMatches = evaluations
    .map((evaluation, index) => ({ evaluation, index }))
    .filter(
      ({ evaluation }) =>
        sessionMatches(evaluation.sessionId, projection.sessionId) &&
        evaluation.traceIds.some((traceId) =>
          projection.subject.traceIds.includes(traceId)
        )
    );
  return traceMatches.length === 1 ? traceMatches[0].index : -1;
}

function evaluationMatchesProjection(
  evaluation: QuestionHumanEvaluation,
  projection: HumanEvaluationProjectionV2
) {
  if (!sessionMatches(evaluation.sessionId, projection.sessionId)) {
    return false;
  }
  if (
    projection.subject.questionId &&
    evaluation.questionId === projection.subject.questionId
  ) {
    return true;
  }
  return evaluation.traceIds.some((traceId) =>
    projection.subject.traceIds.includes(traceId)
  );
}

function sessionMatches(left: string | undefined, right: string) {
  return !left || left === right;
}

function readV1Dimension(
  evaluation: QuestionHumanEvaluation,
  dimension: CompatibilityDimension
) {
  if (dimension === "questionType") {
    if (evaluation.correctedQuestionType) {
      return evaluation.correctedQuestionType;
    }
    if (
      evaluation.classification.verdict === "ok" &&
      evaluation.questionType
    ) {
      return evaluation.questionType;
    }
  }
  if (dimension === "relation") {
    if (evaluation.expectedRelation) return evaluation.expectedRelation;
    if (
      evaluation.currentQuestionSettlement?.relationCorrect === true &&
      evaluation.relation
    ) {
      return evaluation.relation;
    }
  }
  if (dimension === "parentAction") {
    return evaluation.expectedParentAction;
  }
  if (dimension === "runtimeAction") {
    return evaluation.advisorIntent?.expectedAction;
  }
  if (dimension === "observedRuntimeAction") {
    const observed = evaluation.advisorIntent?.observedAction;
    return observed === "advised"
      ? "advise"
      : observed === "append-only"
        ? "append-context"
        : observed === "buffered"
          ? "buffer"
          : observed === "suppressed"
            ? "ignore"
            : undefined;
  }
  if (
    dimension === "answerOutcome" &&
    evaluation.answer.verdict !== "not_applicable"
  ) {
    return mapAnswerVerdictToOutcome(evaluation.answer.verdict);
  }
  if (dimension === "meetingMetadata") {
    return evaluation.correctedCompany;
  }
  return undefined;
}

function readV2Dimension(
  projection: HumanEvaluationProjectionV2,
  dimension: CompatibilityDimension
) {
  const settlement =
    projection.activeFacts["expected-task-settlement"]?.fact;
  const typeOnly = projection.activeFacts["expected-question-type"]?.fact;
  if (dimension === "questionType") {
    return settlement?.kind === "expected-task-settlement"
      ? settlement.expectedQuestionType
      : typeOnly?.kind === "expected-question-type"
        ? typeOnly.expectedQuestionType
        : undefined;
  }
  if (
    (dimension === "relation" || dimension === "parentAction") &&
    settlement?.kind === "expected-task-settlement"
  ) {
    return dimension === "relation"
      ? settlement.expectedRelation
      : settlement.expectedParentAction;
  }
  if (dimension === "observedRuntimeAction") {
    return projection.observed?.runtimeAction;
  }
  if (dimension === "meetingMetadata") {
    const fact = projection.activeFacts["expected-meeting-metadata"]?.fact;
    return fact?.kind === "expected-meeting-metadata"
      ? fact.expectedCompany ?? "__unknown__"
      : undefined;
  }
  return readSimpleV2Fact(projection, dimension);
}

function readSimpleV2Fact(
  projection: HumanEvaluationProjectionV2,
  dimension: CompatibilityDimension
) {
  const factKind: Partial<
    Record<CompatibilityDimension, HumanGroundTruthFactV2["kind"]>
  > = {
    runtimeAction: "expected-runtime-action",
    answerOutcome: "answer-quality",
    contextReadScope: "expected-context-read-scope",
    artifactIntent: "expected-artifact-intent",
  };
  const fact = factKind[dimension]
    ? projection.activeFacts[factKind[dimension]!]?.fact
    : undefined;
  if (fact?.kind === "expected-runtime-action") return fact.expectedAction;
  if (fact?.kind === "answer-quality") return fact.outcome;
  if (fact?.kind === "expected-context-read-scope") return fact.expectedScope;
  if (fact?.kind === "expected-artifact-intent") return fact.expectedIntent;
  return undefined;
}

function createEmptyDimensionReport() {
  const create = (): HumanEvaluationDimensionParity => ({
    v1Labeled: 0,
    v2Labeled: 0,
    overlap: 0,
    agreement: 0,
    disagreement: 0,
    v1Only: 0,
    v2Only: 0,
  });
  return {
    questionType: create(),
    relation: create(),
    parentAction: create(),
    runtimeAction: create(),
    observedRuntimeAction: create(),
    answerOutcome: create(),
    contextReadScope: create(),
    artifactIntent: create(),
    meetingMetadata: create(),
  };
}

function answerVerdictBlock(
  outcome: "useful" | "partial" | "wrong" | "no-answer",
  reasons: string[]
): HumanEvaluationVerdictBlock {
  const verdict: HumanEvaluationVerdict = {
    useful: "ok",
    partial: "partial",
    wrong: "wrong",
    "no-answer": "missing",
  }[outcome] as HumanEvaluationVerdict;
  return {
    verdict,
    reasons: uniqueStrings(reasons.length ? reasons : [`v2-${outcome}`]),
  };
}

function verdictBlockFromBoolean(
  correct: boolean,
  reason: string
): HumanEvaluationVerdictBlock {
  return {
    verdict: correct ? "ok" : "wrong",
    reasons: [correct ? `${reason}-correct` : `${reason}-wrong`],
  };
}

function emptyVerdictBlock(): HumanEvaluationVerdictBlock {
  return { verdict: "not_applicable", reasons: [] };
}

function mapAnswerVerdictToOutcome(
  verdict: HumanEvaluationVerdict
): "useful" | "partial" | "wrong" | "no-answer" | undefined {
  if (verdict === "ok") return "useful";
  if (verdict === "partial") return "partial";
  if (verdict === "wrong") return "wrong";
  if (verdict === "missing") return "no-answer";
  return undefined;
}

function hasLossyV1CorrectnessOnlyField(
  evaluation: QuestionHumanEvaluation
) {
  return Boolean(
    (evaluation.currentQuestionSettlement?.questionTypeCorrect !== undefined &&
      !evaluation.correctedQuestionType &&
      !(
        evaluation.currentQuestionSettlement.questionTypeCorrect &&
        evaluation.questionType
      )) ||
      (evaluation.currentQuestionSettlement?.relationCorrect !== undefined &&
        !evaluation.expectedRelation &&
        !(evaluation.currentQuestionSettlement.relationCorrect &&
          evaluation.relation)) ||
      (evaluation.currentQuestionSettlement?.parentMutationCorrect !==
        undefined &&
        !evaluation.expectedParentAction)
  );
}

function cloneQuestionEvaluation(
  evaluation: QuestionHumanEvaluation
): QuestionHumanEvaluation {
  return {
    ...evaluation,
    traceIds: [...evaluation.traceIds],
    selectedDiagramOverlayIds: [...evaluation.selectedDiagramOverlayIds],
    memoryEntryLabels: [...evaluation.memoryEntryLabels],
    missingExpectedMemory: [...evaluation.missingExpectedMemory],
  };
}

function uniqueStrings(values: Array<string | undefined>) {
  return Array.from(
    new Set(values.filter((value): value is string => Boolean(value)))
  );
}
