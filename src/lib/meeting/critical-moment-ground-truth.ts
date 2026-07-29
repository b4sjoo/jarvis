import type {
  CriticalMomentAdvisorAction,
  CriticalMomentCandidate,
} from "./critical-moment-evaluation.js";
import type {
  HumanEvaluationProjectionV2,
  HumanGroundTruthFactV2,
  HumanGroundTruthSubjectV2,
} from "./human-ground-truth-v2.js";
import {
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";
import type {
  ExpectedAdvisorAction,
  HumanExpectedParentAction,
  InterviewTaskRelation,
} from "./types.js";

export type CriticalMomentGroundTruthJoinStatus =
  | "exact-moment"
  | "exact-source-turns"
  | "legacy-fallback"
  | "missing"
  | "ambiguous";

export interface CriticalMomentExpectedFacts {
  authority: "v2" | "legacy" | "none";
  joinStatus: CriticalMomentGroundTruthJoinStatus;
  projectionId?: string;
  expectedQuestionType?: CanonicalQuestionType;
  expectedRuntimeAction?: ExpectedAdvisorAction;
  expectedRelation?: InterviewTaskRelation;
  expectedParentAction?: HumanExpectedParentAction;
  expectedContextTurnIds: string[];
  legacyExpectedAdvisorAction?: CriticalMomentAdvisorAction;
  conflictFactKinds: HumanGroundTruthFactV2["kind"][];
  warnings: string[];
}

export interface LegacyCriticalMomentExpectedFacts {
  expectedQuestionType?: string;
  expectedAdvisorAction?: CriticalMomentAdvisorAction;
  expectedRelation?: string;
  expectedContextTurnIds?: string[];
}

export function buildCriticalMomentGroundTruthSubject(
  candidate: Pick<
    CriticalMomentCandidate,
    "momentId" | "sourceTurnIds" | "proposedTraceIds"
  >
): HumanGroundTruthSubjectV2 {
  return {
    momentId: candidate.momentId,
    traceIds: uniqueStrings(candidate.proposedTraceIds),
    sourceTurnIds: uniqueStrings(candidate.sourceTurnIds),
  };
}

export function resolveCriticalMomentExpectedFacts(input: {
  candidate: Pick<
    CriticalMomentCandidate,
    "momentId" | "sessionId" | "sourceTurnIds" | "proposedTraceIds"
  >;
  projections: HumanEvaluationProjectionV2[];
  legacyEvaluation?: LegacyCriticalMomentExpectedFacts;
}): CriticalMomentExpectedFacts {
  const projections = latestUniqueProjections(
    input.projections.filter(
      (projection) => projection.sessionId === input.candidate.sessionId
    )
  );
  const exactMoment = projections.filter(
    (projection) =>
      projection.subject.momentId === input.candidate.momentId
  );
  if (exactMoment.length > 1) {
    return ambiguousResult(
      "Multiple V2 projections matched the same critical-moment id."
    );
  }
  if (exactMoment.length === 1) {
    return projectV2Facts(
      exactMoment[0],
      "exact-moment",
      input.legacyEvaluation
    );
  }

  const sourceTurnMatches = input.candidate.sourceTurnIds.length
    ? projections.filter((projection) =>
        sameStringSet(
          projection.subject.sourceTurnIds,
          input.candidate.sourceTurnIds
        )
      )
    : [];
  if (sourceTurnMatches.length > 1) {
    return ambiguousResult(
      "Multiple V2 projections matched the complete critical-moment source-turn set."
    );
  }
  if (sourceTurnMatches.length === 1) {
    return projectV2Facts(
      sourceTurnMatches[0],
      "exact-source-turns",
      input.legacyEvaluation
    );
  }

  const traceOverlapExists = projections.some((projection) =>
    projection.subject.traceIds.some((traceId) =>
      input.candidate.proposedTraceIds.includes(traceId)
    )
  );
  const legacy = projectLegacyFacts(input.legacyEvaluation);
  if (legacy) {
    return {
      ...legacy,
      warnings: [
        ...(traceOverlapExists
          ? [
              "A trace-overlap V2 proposal was ignored because trace overlap is not authoritative for critical-moment truth.",
            ]
          : []),
        ...legacy.warnings,
      ],
    };
  }

  return {
    authority: "none",
    joinStatus: "missing",
    expectedContextTurnIds: [],
    conflictFactKinds: [],
    warnings: traceOverlapExists
      ? [
          "A trace-overlap V2 proposal was ignored because trace overlap is not authoritative for critical-moment truth.",
        ]
      : [],
  };
}

function projectV2Facts(
  projection: HumanEvaluationProjectionV2,
  joinStatus: "exact-moment" | "exact-source-turns",
  legacyEvaluation: LegacyCriticalMomentExpectedFacts | undefined
): CriticalMomentExpectedFacts {
  const conflictFactKinds = projection.conflicts.map(
    (conflict) => conflict.factKind
  );
  const conflictSet = new Set(conflictFactKinds);
  const settlement = conflictSet.has("expected-task-settlement")
    ? undefined
    : projection.activeFacts["expected-task-settlement"]?.fact;
  const typeOnly = conflictSet.has("expected-question-type")
    ? undefined
    : projection.activeFacts["expected-question-type"]?.fact;
  const runtime = conflictSet.has("expected-runtime-action")
    ? undefined
    : projection.activeFacts["expected-runtime-action"]?.fact;
  const answer = conflictSet.has("answer-quality")
    ? undefined
    : projection.activeFacts["answer-quality"]?.fact;
  const settlementType =
    settlement?.kind === "expected-task-settlement"
      ? settlement.expectedQuestionType
      : undefined;
  const typeOnlyValue =
    typeOnly?.kind === "expected-question-type"
      ? typeOnly.expectedQuestionType
      : undefined;
  const crossFactTypeConflict = Boolean(
    settlementType &&
      typeOnlyValue &&
      settlementType !== typeOnlyValue
  );
  const expectedQuestionType = crossFactTypeConflict
    ? undefined
    : settlementType ?? typeOnlyValue;
  const expectedRuntimeAction =
    runtime?.kind === "expected-runtime-action"
      ? runtime.expectedAction
      : undefined;
  const expectedRelation =
    settlement?.kind === "expected-task-settlement"
      ? settlement.expectedRelation
      : undefined;
  const expectedParentAction =
    settlement?.kind === "expected-task-settlement"
      ? settlement.expectedParentAction
      : undefined;
  const expectedContextTurnIds =
    answer?.kind === "answer-quality"
      ? [...answer.expectedContextTurnIds]
      : [];
  const warnings = [
    ...(crossFactTypeConflict
      ? [
          "V2 task-settlement and question-type facts disagree; expected question type remains unresolved.",
        ]
      : []),
    ...legacyCompatibilityWarnings({
      legacyEvaluation,
      expectedQuestionType,
      expectedRuntimeAction,
      expectedRelation,
      expectedContextTurnIds,
    }),
  ];

  return {
    authority: "v2",
    joinStatus,
    projectionId: projection.projectionId,
    expectedQuestionType,
    expectedRuntimeAction,
    expectedRelation,
    expectedParentAction,
    expectedContextTurnIds,
    legacyExpectedAdvisorAction:
      legacyEvaluation?.expectedAdvisorAction,
    conflictFactKinds,
    warnings,
  };
}

function projectLegacyFacts(
  evaluation: LegacyCriticalMomentExpectedFacts | undefined
): CriticalMomentExpectedFacts | undefined {
  if (!evaluation) return undefined;
  const expectedQuestionType = normalizeCanonicalQuestionType(
    evaluation.expectedQuestionType
  );
  const expectedRuntimeAction = mapLegacyAdvisorAction(
    evaluation.expectedAdvisorAction
  );
  const expectedRelation = normalizeLegacyRelation(
    evaluation.expectedRelation
  );
  const expectedContextTurnIds = uniqueStrings(
    evaluation.expectedContextTurnIds ?? []
  );
  const hasExpectedFact = Boolean(
    expectedQuestionType ||
      evaluation.expectedAdvisorAction ||
      expectedRelation ||
      expectedContextTurnIds.length
  );
  if (!hasExpectedFact) return undefined;

  return {
    authority: "legacy",
    joinStatus: "legacy-fallback",
    expectedQuestionType,
    expectedRuntimeAction,
    expectedRelation,
    expectedContextTurnIds,
    legacyExpectedAdvisorAction: evaluation.expectedAdvisorAction,
    conflictFactKinds: [],
    warnings: [
      "Expected facts were read from the legacy mutable Critical Moment evaluation.",
      ...(evaluation.expectedAdvisorAction === "clarify"
        ? [
            "Legacy clarify is an advice mode, not a V2 runtime action, so it was not promoted.",
          ]
        : []),
    ],
  };
}

function legacyCompatibilityWarnings(input: {
  legacyEvaluation: LegacyCriticalMomentExpectedFacts | undefined;
  expectedQuestionType: CanonicalQuestionType | undefined;
  expectedRuntimeAction: ExpectedAdvisorAction | undefined;
  expectedRelation: InterviewTaskRelation | undefined;
  expectedContextTurnIds: string[];
}) {
  const legacy = input.legacyEvaluation;
  if (!legacy) return [];
  const warnings: string[] = [];
  const legacyType = normalizeCanonicalQuestionType(
    legacy.expectedQuestionType
  );
  const legacyRuntimeAction = mapLegacyAdvisorAction(
    legacy.expectedAdvisorAction
  );
  if (
    legacyType &&
    input.expectedQuestionType &&
    legacyType !== input.expectedQuestionType
  ) {
    warnings.push(
      "Legacy and V2 expected question types disagree; V2 remains authoritative."
    );
  }
  if (
    legacyRuntimeAction &&
    input.expectedRuntimeAction &&
    legacyRuntimeAction !== input.expectedRuntimeAction
  ) {
    warnings.push(
      "Legacy and V2 expected runtime actions disagree; V2 remains authoritative."
    );
  }
  if (
    normalizeLegacyRelation(legacy.expectedRelation) &&
    input.expectedRelation &&
    normalizeLegacyRelation(legacy.expectedRelation) !==
      input.expectedRelation
  ) {
    warnings.push(
      "Legacy and V2 expected relations disagree; V2 remains authoritative."
    );
  }
  if (
    legacy.expectedContextTurnIds?.length &&
    input.expectedContextTurnIds.length &&
    !sameStringSet(
      legacy.expectedContextTurnIds,
      input.expectedContextTurnIds
    )
  ) {
    warnings.push(
      "Legacy and V2 expected context turns disagree; V2 remains authoritative."
    );
  }
  return warnings;
}

function mapLegacyAdvisorAction(
  action: CriticalMomentAdvisorAction | undefined
): ExpectedAdvisorAction | undefined {
  if (
    action === "advise" ||
    action === "append-context" ||
    action === "ignore"
  ) {
    return action;
  }
  return undefined;
}

function normalizeLegacyRelation(
  relation: string | undefined
): InterviewTaskRelation | undefined {
  return relation === "new-parent" ||
    relation === "followup-parent" ||
    relation === "child-probe" ||
    relation === "resume-parent" ||
    relation === "logistics" ||
    relation === "correction" ||
    relation === "unknown"
    ? relation
    : undefined;
}

function ambiguousResult(warning: string): CriticalMomentExpectedFacts {
  return {
    authority: "none",
    joinStatus: "ambiguous",
    expectedContextTurnIds: [],
    conflictFactKinds: [],
    warnings: [warning],
  };
}

function latestUniqueProjections(
  projections: HumanEvaluationProjectionV2[]
) {
  const byId = new Map<string, HumanEvaluationProjectionV2>();
  for (const projection of projections) {
    const previous = byId.get(projection.projectionId);
    if (!previous || previous.computedAt <= projection.computedAt) {
      byId.set(projection.projectionId, projection);
    }
  }
  return Array.from(byId.values());
}

function sameStringSet(left: string[], right: string[]) {
  const canonicalLeft = uniqueStrings(left).sort();
  const canonicalRight = uniqueStrings(right).sort();
  return (
    canonicalLeft.length === canonicalRight.length &&
    canonicalLeft.every(
      (value, index) => value === canonicalRight[index]
    )
  );
}

function uniqueStrings(values: string[]) {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean))
  );
}
