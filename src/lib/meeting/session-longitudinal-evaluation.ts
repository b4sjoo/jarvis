import {
  CANONICAL_QUESTION_TYPES,
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";
import {
  resolveCriticalMomentExpectedFacts,
  type CriticalMomentExpectedFacts,
} from "./critical-moment-ground-truth.js";
import type { HumanEvaluationProjectionV2 } from "./human-ground-truth-v2.js";
import type { TaskRelationAdjudicationReflectionReport } from "./task-relation-adjudication-reflection.js";
import type { TaskRelationAuthorityConvergenceReportV1 } from "./task-relation-authority-convergence.js";
import { projectObservedParentAction } from "./task-settlement-tuple.js";
import type { HumanEvaluationTaskRelation } from "./types.js";

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
  endedAt?: number;
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
  taskMutationCommand?: string;
  taskLifecycleParentBeforeId?: string;
  taskLifecycleParentAfterId?: string;
  taskLifecycleParentBeforeType?: string;
  taskLifecycleParentAfterType?: string;
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
  meetingMetadata?: {
    revision?: number;
    operationId?: string;
    mode?: string;
    disposition?: string;
    proposalCompany?: string;
    committedCompany?: string;
    authoritativeCompany?: string;
    effectiveCompany?: string;
    authoritySource?: string;
    comparisonDisposition?: string;
    staleReason?: string;
    appliedToRuntime?: boolean;
    overrideOccurred?: boolean;
  };
  whiteboard?: {
    artifactId?: string;
    revision?: number;
    domainTrack?: string;
    validationOperationId?: string;
    candidateKind?: string;
    candidateRevision?: number;
    validationDisposition?: string;
    validationDurationMs?: number;
    parserErrorClass?: string;
    sanitationDisposition?: string;
    sanitationChanges?: string[];
    originalParserErrorClass?: string;
    visibleRevisionBefore?: number;
    visibleRevisionAfter?: number;
    preservedLastValid?: boolean;
    renderStatus?: string;
    fallbackKind?: string;
    fallbackReason?: string;
    repairOperationId?: string;
    repairDisposition?: string;
    repairProviderDisposition?: string;
    repairParseDisposition?: string;
    repairQueueWaitMs?: number;
    repairDurationMs?: number;
    repairRevalidationDisposition?: string;
    repairBehaviorMutationBlocked?: boolean;
    formatPreference?: string;
    mermaidEligible?: boolean;
    mermaidRequested?: boolean;
    mermaidCommitted?: boolean;
    formatPolicyMiss?: boolean;
    formatConversionAttempted?: boolean;
    formatConversionDisposition?: string;
    asciiFallback?: boolean;
    asciiFallbackReason?: string;
  };
  projectTrajectory?: {
    joinKey?: string;
    parentId?: string;
    parentRevision?: number;
    projectId?: string;
    projectName?: string;
    projectBindingRevision?: number;
    phase?: string;
    factAnchorState?: string;
    unsupportedClaimRisk?: string;
    claimSupportAllowCount?: number;
    claimSupportRejectCount?: number;
    claimSupportClarificationCount?: number;
    transitionKind?: string;
    childId?: string;
    childIntent?: string;
    returnParentId?: string;
    returnPhase?: string;
    returnProjectBindingRevision?: number;
  };
  timingsMs?: {
    model?: number;
    advisor?: number;
  };
}

export interface LongitudinalCriticalMomentCandidate {
  momentId: string;
  sessionId: string;
  sourceTurnIds: string[];
  sourceText?: string;
  opportunityStartAt?: number;
  opportunityEndAt?: number;
  candidateSource?: string;
  candidateReasons?: string[];
  proposedTraceIds: string[];
  proposedQuestionType?: string;
  traceJoinStatus?: "none" | "exact" | "proposed" | "ambiguous";
  createdAt?: number;
  updatedAt?: number;
}

export interface LongitudinalCriticalMomentEvaluation {
  momentId: string;
  sessionId: string;
  sourceTurnIds: string[];
  traceIds: string[];
  eligibility?: "critical" | "not-critical" | "uncertain";
  expectedQuestionType?: string;
  expectedAdvisorAction?: "advise" | "clarify" | "append-context" | "ignore";
  expectedRelation?: string;
  expectedContextTurnIds?: string[];
  opportunityEndAt?: number;
  selectedUsefulTraceId?: string;
  firstUsefulAt?: number;
  userSpeechStartAt?: number;
  useful?: boolean;
  trustworthy?: boolean;
  naturalStart?: boolean;
  waitedForJarvis?: boolean;
  readFromJarvis?: boolean;
  interactionRequired?: boolean;
  failureReasons?: string[];
  notes?: string;
  createdAt?: number;
  updatedAt?: number;
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
  criticalMomentCandidates?: LongitudinalCriticalMomentCandidate[];
  criticalMomentEvaluations?: LongitudinalCriticalMomentEvaluation[];
  humanEvaluationProjectionsV2?: HumanEvaluationProjectionV2[];
  taskRelationAdjudicationReport?: TaskRelationAdjudicationReflectionReport;
  taskRelationConvergenceReport?: TaskRelationAuthorityConvergenceReportV1;
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
  version: 2;
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
  productOutcomes: {
    candidateCount: number;
    reviewedCandidateCount: number;
    criticalMomentCount: number;
    notCriticalMomentCount: number;
    uncertainMomentCount: number;
    unresolvedCandidateCount: number;
    cmsr: RateMetric;
    strictSuccessCount: number;
    timingNotEvaluableCount: number;
    zeroTraceOpportunityMissRate: RateMetric;
    falseActivationRate: RateMetric;
    ttugMs: DistributionMetric;
    guidanceBeforeSpeechCoverage: RateMetric;
    guidanceBeforeSpeechSuccess: RateMetric;
    naturalStartRate: RateMetric;
    waitedForJarvisRate: RateMetric;
    readFromJarvisRate: RateMetric;
    interactionRequiredRate: RateMetric;
    usefulButUntrustworthyCount: number;
    trustworthyButLateCount: number;
    manyTraceMomentCount: number;
    ambiguousJoinCount: number;
    evaluationsWithoutCandidate: number;
    expectedFactJoins: {
      exactMoment: number;
      exactSourceTurns: number;
      legacyFallback: number;
      missing: number;
      ambiguous: number;
      conflicting: number;
    };
    failureReasons: Record<string, number>;
    denominatorAuthority: "explicit-human-eligibility";
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
  relationAdjudicationFunnel: {
    sessionsObserved: number;
    operations: number;
    candidateAvailable: number;
    humanLabeled: number;
    deterministicAgreement: RateMetric;
    llmAccuracy: RateMetric;
    deterministicAccuracy: RateMetric;
    newParentPrecision: RateMetric;
    falseParent: number;
    falseChild: number;
    falseResume: number;
    contextLoss: number;
    contextContamination: number;
    stale: number;
    mutationApplied: number;
    unmatchedEvaluationCount: number;
    structuredOutputValidity: RateMetric;
    counterfactualAccuracy: RateMetric;
    counterfactualNewParentPrecision: RateMetric;
    counterfactualRescues: number;
    counterfactualRegressions: number;
    semanticCorrectProductionInapplicable: number;
    humanPathInapplicable: number;
    relationContextLossRisk: number;
    relationContaminationRisk: number;
    graduation: Record<
      "insufficient-evidence" | "blocked" | "eligible-for-manual-review",
      number
    >;
    latencyMs: DistributionMetric;
  };
  meetingMetadataFunnel: {
    operationsObserved: number;
    proposalCount: number;
    committedCount: number;
    abstentionCount: number;
    humanLabeled: number;
    proposalPrecision: RateMetric;
    proposalRecall: RateMetric;
    effectiveTargetPrecision: RateMetric;
    effectiveTargetRecall: RateMetric;
    effectiveTargetAccuracy: RateMetric;
    mutationAccuracy: RateMetric;
    conflictRate: RateMetric;
    staleRate: RateMetric;
    unauthorizedOverrideCount: number;
    errorKinds: Record<string, number>;
    denominatorAuthority: "explicit-human-three-fact-metadata";
  };
  whiteboardRenderFunnel: {
    observedCandidates: number;
    invalidCandidates: number;
    sanitationAttempts: number;
    sanitationSuccesses: number;
    repairAttempts: number;
    settledRepairAttempts: number;
    successfulShadowRepairs: number;
    preservedLastValidCount: number;
    asciiFallbackCount: number;
    mermaidEligibleCount: number;
    mermaidRequestedCount: number;
    mermaidCommittedCount: number;
    formatPolicyMissCount: number;
    formatConversionAttemptCount: number;
    formatAsciiFallbackCount: number;
    mermaidCommitRate: RateMetric;
    formatPolicyMissRate: RateMetric;
    formatConversionAttemptRate: RateMetric;
    validationFailureRate: RateMetric;
    repairAttemptRate: RateMetric;
    repairSuccessRate: RateMetric;
    preservedLastValidRate: RateMetric;
    asciiFallbackRate: RateMetric;
    validationLatencyMs: DistributionMetric;
    repairQueueWaitMs: DistributionMetric;
    repairDurationMs: DistributionMetric;
  };
  projectTrajectoryFunnel: {
    observedTraces: number;
    humanLabeled: number;
    projectAgreement: RateMetric;
    phaseAgreement: RateMetric;
    factSupportAgreement: RateMetric;
    childContinuityAgreement: RateMetric;
    unsupportedFirstPersonClaimCount: number;
    wrongProjectFactSupportCount: number;
    phaseRestartCount: number;
    childResumeObserved: number;
    childResumeSuccessRate: RateMetric;
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

interface JoinedCriticalMoment {
  session: LongitudinalSessionInput;
  candidate: LongitudinalCriticalMomentCandidate;
  evaluation?: LongitudinalCriticalMomentEvaluation;
  expectedFacts: CriticalMomentExpectedFacts;
  traces: LongitudinalTraceSummary[];
}

export function buildSessionLongitudinalEvaluationReport(
  inputs: LongitudinalSessionInput[]
): SessionLongitudinalEvaluationReport {
  const production: JoinedTrace[] = [];
  const criticalMomentRows: JoinedCriticalMoment[] = [];
  let syntheticTraceCount = 0;
  let interviewerTurnCount = 0;
  let labelsWithoutMatchingTrace = 0;
  let evaluationsWithoutCandidate = 0;
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
    const candidates = buildLongitudinalCriticalMomentCandidates(session);
    const evaluationsByMoment = indexLatestMomentEvaluations(
      session.criticalMomentEvaluations ?? []
    );
    const candidatesById = new Map(
      candidates.map((candidate) => [candidate.momentId, candidate])
    );
    evaluationsWithoutCandidate += (
      session.criticalMomentEvaluations ?? []
    ).filter((evaluation) => !candidatesById.has(evaluation.momentId)).length;
    const tracesById = new Map(
      session.traceSummaries.map((trace) => [trace.traceId, trace])
    );
    for (const candidate of candidates) {
      const evaluation = evaluationsByMoment.get(candidate.momentId);
      const traceIds = uniqueStrings([
        ...candidate.proposedTraceIds,
        ...(evaluation?.traceIds ?? []),
      ]);
      criticalMomentRows.push({
        session,
        candidate,
        evaluation,
        expectedFacts: resolveCriticalMomentExpectedFacts({
          candidate,
          projections: session.humanEvaluationProjectionsV2 ?? [],
          legacyEvaluation: evaluation,
        }),
        traces: traceIds
          .map((traceId) => tracesById.get(traceId))
          .filter(
            (trace): trace is LongitudinalTraceSummary => Boolean(trace)
          ),
      });
    }
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
  const productOutcomes = buildProductOutcomes(
    criticalMomentRows,
    evaluationsWithoutCandidate
  );
  const whiteboardCandidates = production.filter(({ trace }) =>
    Boolean(trace.whiteboard?.validationOperationId)
  );
  const invalidWhiteboardCandidates = whiteboardCandidates.filter(
    ({ trace }) =>
      trace.whiteboard?.validationDisposition === "invalid-mermaid"
  );
  const whiteboardSanitationAttempts = whiteboardCandidates.filter(
    ({ trace }) =>
      trace.whiteboard?.sanitationDisposition === "applied" ||
      trace.whiteboard?.sanitationDisposition === "failed"
  );
  const whiteboardSanitationSuccesses = whiteboardCandidates.filter(
    ({ trace }) => trace.whiteboard?.sanitationDisposition === "applied"
  );
  const whiteboardRepairAttempts = invalidWhiteboardCandidates.filter(
    ({ trace }) => Boolean(trace.whiteboard?.repairOperationId)
  );
  const settledWhiteboardRepairAttempts = whiteboardRepairAttempts.filter(
    ({ trace }) =>
      Boolean(trace.whiteboard?.repairDisposition) &&
      trace.whiteboard?.repairDisposition !== "scheduled"
  );
  const successfulShadowRepairs =
    settledWhiteboardRepairAttempts.filter(
      ({ trace }) =>
        trace.whiteboard?.repairDisposition === "shadow-valid" &&
        trace.whiteboard?.repairRevalidationDisposition === "valid-mermaid"
    );
  const preservedLastValid = invalidWhiteboardCandidates.filter(
    ({ trace }) =>
      trace.whiteboard?.preservedLastValid === true ||
      trace.whiteboard?.renderStatus === "preserved-last-valid"
  );
  const asciiFallbacks = invalidWhiteboardCandidates.filter(
    ({ trace }) =>
      trace.whiteboard?.fallbackKind === "deterministic-ascii" ||
      trace.whiteboard?.renderStatus === "ascii-fallback"
  );
  const mermaidEligibleWhiteboards = production.filter(
    ({ trace }) => trace.whiteboard?.mermaidEligible === true
  );
  const mermaidRequestedWhiteboards = mermaidEligibleWhiteboards.filter(
    ({ trace }) => trace.whiteboard?.mermaidRequested === true
  );
  const mermaidCommittedWhiteboards = mermaidRequestedWhiteboards.filter(
    ({ trace }) => trace.whiteboard?.mermaidCommitted === true
  );
  const whiteboardFormatPolicyMisses = mermaidRequestedWhiteboards.filter(
    ({ trace }) => trace.whiteboard?.formatPolicyMiss === true
  );
  const whiteboardFormatConversionAttempts =
    whiteboardFormatPolicyMisses.filter(
      ({ trace }) => trace.whiteboard?.formatConversionAttempted === true
    );
  const whiteboardFormatAsciiFallbacks = mermaidEligibleWhiteboards.filter(
    ({ trace }) => trace.whiteboard?.asciiFallback === true
  );
  const relationReports = inputs
    .map((input) => input.taskRelationAdjudicationReport)
    .filter(
      (
        report
      ): report is TaskRelationAdjudicationReflectionReport =>
        Boolean(report)
    );
  const relationConvergenceReports = inputs
    .map((input) => input.taskRelationConvergenceReport)
    .filter(
      (
        report
      ): report is TaskRelationAuthorityConvergenceReportV1 =>
        Boolean(report)
    );
  const projectTrajectoryTraces = production.filter(({ trace }) =>
    Boolean(trace.projectTrajectory)
  );
  const projectTrajectoryProjections = inputs.flatMap((input) =>
    (input.humanEvaluationProjectionsV2 ?? []).filter(
      (projection) =>
        projection.activeFacts["expected-project-trajectory"]?.fact.kind ===
        "expected-project-trajectory"
    )
  );
  const childResumeTraces = projectTrajectoryTraces.filter(
    ({ trace }) =>
      trace.projectTrajectory?.transitionKind === "resume-parent"
  );
  const meetingMetadataTraces = production.filter(
    ({ trace }) => trace.meetingMetadata?.operationId
  );
  const meetingMetadataProjections = Array.from(
    new Map(
      inputs
        .flatMap((input) => input.humanEvaluationProjectionsV2 ?? [])
        .filter(
          (projection) =>
            projection.activeFacts["expected-meeting-metadata"]?.fact.kind ===
              "expected-meeting-metadata" &&
            projection.observed?.meetingMetadata?.operationObserved
        )
        .map((projection) => [projection.projectionId, projection])
    ).values()
  );
  const metadataSourceLabeled = meetingMetadataProjections.filter(
    (projection) =>
      projection.activeFacts["expected-meeting-metadata"]?.fact.kind ===
        "expected-meeting-metadata" &&
      projection.activeFacts["expected-meeting-metadata"]?.fact
        .sourceCompany !== undefined
  );
  const metadataSourceExpectedPositive = metadataSourceLabeled.filter(
    (projection) =>
      projection.activeFacts["expected-meeting-metadata"]?.fact.kind ===
        "expected-meeting-metadata" &&
      projection.activeFacts["expected-meeting-metadata"]?.fact
        .sourceCompany !== null
  );
  const metadataProposalPositive = metadataSourceLabeled.filter(
    (projection) => Boolean(projection.observed?.meetingMetadata?.proposalCompany)
  );
  const metadataProposalTruePositive = metadataProposalPositive.filter(
    (projection) => projection.verdicts.meetingMetadataProposalCorrect === true
  );
  const metadataEffectiveLabeled = meetingMetadataProjections.filter(
    (projection) =>
      projection.activeFacts["expected-meeting-metadata"]?.fact.kind ===
        "expected-meeting-metadata" &&
      projection.activeFacts["expected-meeting-metadata"]?.fact
        .expectedEffectiveCompany !== undefined
  );
  const metadataEffectiveExpectedPositive = metadataEffectiveLabeled.filter(
    (projection) =>
      projection.activeFacts["expected-meeting-metadata"]?.fact.kind ===
        "expected-meeting-metadata" &&
      projection.activeFacts["expected-meeting-metadata"]?.fact
        .expectedEffectiveCompany !== null
  );
  const metadataTargetPositive = metadataEffectiveLabeled.filter(
    (projection) => Boolean(projection.observed?.meetingMetadata?.effectiveCompany)
  );
  const metadataTargetTruePositive = metadataTargetPositive.filter(
    (projection) => projection.verdicts.meetingMetadataTargetCorrect === true
  );
  const metadataMutationLabeled = meetingMetadataProjections.filter(
    (projection) =>
      projection.activeFacts["expected-meeting-metadata"]?.fact.kind ===
        "expected-meeting-metadata" &&
      projection.activeFacts["expected-meeting-metadata"]?.fact
        .expectedMutationDisposition !== undefined
  );
  const metadataComparisonTraces = meetingMetadataTraces.filter(
    ({ trace }) =>
      Boolean(
        trace.meetingMetadata?.proposalCompany &&
          trace.meetingMetadata.authoritativeCompany
      )
  );
  const meetingMetadataErrorKinds: Record<string, number> = {};
  for (const projection of meetingMetadataProjections) {
    const fact = projection.activeFacts["expected-meeting-metadata"]?.fact;
    if (fact?.kind !== "expected-meeting-metadata" || !fact.errorKind) {
      continue;
    }
    meetingMetadataErrorKinds[fact.errorKind] =
      (meetingMetadataErrorKinds[fact.errorKind] ?? 0) + 1;
  }

  return {
    version: 2,
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
    productOutcomes,
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
    relationAdjudicationFunnel: {
      sessionsObserved: relationReports.length,
      operations: sum(
        relationReports.map((report) => report.metrics.operations)
      ),
      candidateAvailable: sum(
        relationReports.map(
          (report) => report.metrics.candidateAvailable
        )
      ),
      humanLabeled: sum(
        relationReports.map((report) => report.metrics.labeled)
      ),
      deterministicAgreement: aggregateRates(
        relationReports.map(
          (report) => report.metrics.deterministicAgreement
        )
      ),
      llmAccuracy: aggregateRates(
        relationReports.map((report) => report.metrics.llmAccuracy)
      ),
      deterministicAccuracy: aggregateRates(
        relationReports.map(
          (report) => report.metrics.deterministicAccuracy
        )
      ),
      newParentPrecision: aggregateRates(
        relationReports.map(
          (report) => report.metrics.newParentPrecision
        )
      ),
      falseParent: sum(
        relationReports.map((report) => report.metrics.falseParent)
      ),
      falseChild: sum(
        relationReports.map((report) => report.metrics.falseChild)
      ),
      falseResume: sum(
        relationReports.map((report) => report.metrics.falseResume)
      ),
      contextLoss: sum(
        relationReports.map((report) => report.metrics.contextLoss)
      ),
      contextContamination: sum(
        relationReports.map(
          (report) => report.metrics.contextContamination
        )
      ),
      stale: sum(
        relationReports.map((report) => report.metrics.stale)
      ),
      mutationApplied: sum(
        relationReports.map((report) => report.metrics.mutationApplied)
      ),
      unmatchedEvaluationCount: sum(
        relationReports.map(
          (report) => report.metrics.unmatchedEvaluationCount
        )
      ),
      structuredOutputValidity: aggregateRates(
        relationConvergenceReports.map(
          (report) => report.metrics.structuredOutputValidity
        )
      ),
      counterfactualAccuracy: aggregateRates(
        relationConvergenceReports.map(
          (report) => report.metrics.counterfactual.accuracy
        )
      ),
      counterfactualNewParentPrecision: aggregateRates(
        relationConvergenceReports.map(
          (report) =>
            report.metrics.counterfactual.newParentPrecision
        )
      ),
      counterfactualRescues: sum(
        relationConvergenceReports.map(
          (report) => report.metrics.counterfactualRescues
        )
      ),
      counterfactualRegressions: sum(
        relationConvergenceReports.map(
          (report) => report.metrics.counterfactualRegressions
        )
      ),
      semanticCorrectProductionInapplicable: sum(
        relationConvergenceReports.map(
          (report) =>
            report.metrics.semanticCorrectProductionInapplicable
        )
      ),
      humanPathInapplicable: sum(
        relationConvergenceReports.map(
          (report) => report.metrics.humanPathInapplicable
        )
      ),
      relationContextLossRisk: sum(
        relationConvergenceReports.map(
          (report) => report.metrics.relationContextLossRisk
        )
      ),
      relationContaminationRisk: sum(
        relationConvergenceReports.map(
          (report) => report.metrics.relationContaminationRisk
        )
      ),
      graduation: {
        "insufficient-evidence": relationConvergenceReports.filter(
          (report) =>
            report.graduation.status === "insufficient-evidence"
        ).length,
        blocked: relationConvergenceReports.filter(
          (report) => report.graduation.status === "blocked"
        ).length,
        "eligible-for-manual-review": relationConvergenceReports.filter(
          (report) =>
            report.graduation.status ===
            "eligible-for-manual-review"
        ).length,
      },
      latencyMs: distribution(
        relationReports.flatMap((report) =>
          report.rows.map((row) => row.durationMs)
        )
      ),
    },
    meetingMetadataFunnel: {
      operationsObserved: meetingMetadataTraces.length,
      proposalCount: meetingMetadataTraces.filter(({ trace }) =>
        Boolean(trace.meetingMetadata?.proposalCompany)
      ).length,
      committedCount: meetingMetadataTraces.filter(
        ({ trace }) => trace.meetingMetadata?.appliedToRuntime === true
      ).length,
      abstentionCount: meetingMetadataTraces.filter(
        ({ trace }) =>
          !trace.meetingMetadata?.proposalCompany &&
          trace.meetingMetadata?.disposition !== "ineligible"
      ).length,
      humanLabeled: meetingMetadataProjections.length,
      proposalPrecision: rate(
        metadataProposalTruePositive.length,
        metadataProposalPositive.length
      ),
      proposalRecall: rate(
        metadataProposalTruePositive.length,
        metadataSourceExpectedPositive.length
      ),
      effectiveTargetPrecision: rate(
        metadataTargetTruePositive.length,
        metadataTargetPositive.length
      ),
      effectiveTargetRecall: rate(
        metadataTargetTruePositive.length,
        metadataEffectiveExpectedPositive.length
      ),
      effectiveTargetAccuracy: rate(
        metadataEffectiveLabeled.filter(
          (projection) =>
            projection.verdicts.meetingMetadataTargetCorrect === true
        ).length,
        metadataEffectiveLabeled.length
      ),
      mutationAccuracy: rate(
        metadataMutationLabeled.filter(
          (projection) =>
            projection.verdicts.meetingMetadataMutationCorrect === true
        ).length,
        metadataMutationLabeled.length
      ),
      conflictRate: rate(
        metadataComparisonTraces.filter(
          ({ trace }) =>
            trace.meetingMetadata?.comparisonDisposition === "conflict"
        ).length,
        metadataComparisonTraces.length
      ),
      staleRate: rate(
        meetingMetadataTraces.filter(
          ({ trace }) =>
            Boolean(trace.meetingMetadata?.staleReason) ||
            trace.meetingMetadata?.disposition === "stale"
        ).length,
        meetingMetadataTraces.length
      ),
      unauthorizedOverrideCount: meetingMetadataTraces.filter(
        ({ trace }) => trace.meetingMetadata?.overrideOccurred === true
      ).length,
      errorKinds: meetingMetadataErrorKinds,
      denominatorAuthority: "explicit-human-three-fact-metadata",
    },
    whiteboardRenderFunnel: {
      observedCandidates: whiteboardCandidates.length,
      invalidCandidates: invalidWhiteboardCandidates.length,
      sanitationAttempts: whiteboardSanitationAttempts.length,
      sanitationSuccesses: whiteboardSanitationSuccesses.length,
      repairAttempts: whiteboardRepairAttempts.length,
      settledRepairAttempts: settledWhiteboardRepairAttempts.length,
      successfulShadowRepairs: successfulShadowRepairs.length,
      preservedLastValidCount: preservedLastValid.length,
      asciiFallbackCount: asciiFallbacks.length,
      mermaidEligibleCount: mermaidEligibleWhiteboards.length,
      mermaidRequestedCount: mermaidRequestedWhiteboards.length,
      mermaidCommittedCount: mermaidCommittedWhiteboards.length,
      formatPolicyMissCount: whiteboardFormatPolicyMisses.length,
      formatConversionAttemptCount:
        whiteboardFormatConversionAttempts.length,
      formatAsciiFallbackCount: whiteboardFormatAsciiFallbacks.length,
      mermaidCommitRate: rate(
        mermaidCommittedWhiteboards.length,
        mermaidRequestedWhiteboards.length
      ),
      formatPolicyMissRate: rate(
        whiteboardFormatPolicyMisses.length,
        mermaidRequestedWhiteboards.length
      ),
      formatConversionAttemptRate: rate(
        whiteboardFormatConversionAttempts.length,
        whiteboardFormatPolicyMisses.length
      ),
      validationFailureRate: rate(
        invalidWhiteboardCandidates.length,
        whiteboardCandidates.length
      ),
      repairAttemptRate: rate(
        whiteboardRepairAttempts.length,
        invalidWhiteboardCandidates.length
      ),
      repairSuccessRate: rate(
        successfulShadowRepairs.length,
        settledWhiteboardRepairAttempts.length
      ),
      preservedLastValidRate: rate(
        preservedLastValid.length,
        invalidWhiteboardCandidates.length
      ),
      asciiFallbackRate: rate(
        asciiFallbacks.length,
        invalidWhiteboardCandidates.length
      ),
      validationLatencyMs: distribution(
        whiteboardCandidates.map(
          ({ trace }) => trace.whiteboard?.validationDurationMs
        )
      ),
      repairQueueWaitMs: distribution(
        settledWhiteboardRepairAttempts.map(
          ({ trace }) => trace.whiteboard?.repairQueueWaitMs
        )
      ),
      repairDurationMs: distribution(
        settledWhiteboardRepairAttempts.map(
          ({ trace }) => trace.whiteboard?.repairDurationMs
        )
      ),
    },
    projectTrajectoryFunnel: {
      observedTraces: projectTrajectoryTraces.length,
      humanLabeled: projectTrajectoryProjections.length,
      projectAgreement: verdictRate(
        projectTrajectoryProjections,
        "projectCorrect"
      ),
      phaseAgreement: verdictRate(
        projectTrajectoryProjections,
        "playbookPhaseCorrect"
      ),
      factSupportAgreement: verdictRate(
        projectTrajectoryProjections,
        "factSupportCorrect"
      ),
      childContinuityAgreement: verdictRate(
        projectTrajectoryProjections,
        "childContinuityCorrect"
      ),
      unsupportedFirstPersonClaimCount:
        projectTrajectoryProjections.filter(
          (projection) =>
            projection.verdicts.unsupportedFirstPersonClaim === true
        ).length,
      wrongProjectFactSupportCount:
        projectTrajectoryProjections.filter(
          (projection) =>
            projection.verdicts.projectCorrect === false &&
            (projection.observed?.factAnchorState === "strong-anchor" ||
              projection.observed?.factAnchorState === "weak-anchor")
        ).length,
      phaseRestartCount: countProjectPhaseRestarts(
        projectTrajectoryTraces
      ),
      childResumeObserved: childResumeTraces.length,
      childResumeSuccessRate: rate(
        childResumeTraces.filter(({ trace }) => {
          const trajectory = trace.projectTrajectory;
          return Boolean(
            trajectory?.parentId &&
              trajectory.returnParentId === trajectory.parentId &&
              trajectory?.phase &&
              trajectory.returnPhase === trajectory.phase &&
              (trajectory.returnProjectBindingRevision === undefined ||
                trajectory.projectBindingRevision ===
                  trajectory.returnProjectBindingRevision)
          );
        }).length,
        childResumeTraces.length
      ),
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

function buildProductOutcomes(
  rows: JoinedCriticalMoment[],
  evaluationsWithoutCandidate: number
): SessionLongitudinalEvaluationReport["productOutcomes"] {
  const reviewed = rows.filter(({ evaluation }) =>
    Boolean(evaluation?.eligibility)
  );
  const critical = reviewed.filter(
    ({ evaluation }) => evaluation?.eligibility === "critical"
  );
  const notCritical = reviewed.filter(
    ({ evaluation }) => evaluation?.eligibility === "not-critical"
  );
  const uncertain = reviewed.filter(
    ({ evaluation }) => evaluation?.eligibility === "uncertain"
  );
  const strictSuccesses = critical.filter(({ evaluation }) => {
    if (!evaluation?.useful || !evaluation.trustworthy) return false;
    if (evaluation.naturalStart === false) return false;
    return !isGuidanceLate(evaluation);
  });
  const timingComparable = critical.filter(({ evaluation }) =>
    hasGuidanceBeforeSpeechEvidence(evaluation)
  );
  const ttugValues = critical.map(({ candidate, evaluation }) => {
    const firstUsefulAt = finiteNumber(evaluation?.firstUsefulAt);
    const opportunityEndAt = finiteNumber(
      evaluation?.opportunityEndAt ?? candidate.opportunityEndAt
    );
    return firstUsefulAt !== undefined && opportunityEndAt !== undefined
      ? firstUsefulAt - opportunityEndAt
      : undefined;
  });
  const zeroTraceMoments = critical.filter(
    ({ candidate, evaluation }) =>
      uniqueStrings([
        ...candidate.proposedTraceIds,
        ...(evaluation?.traceIds ?? []),
      ]).length === 0
  );
  const falseActivations = notCritical.filter(momentActivated);
  const failureReasons: Record<string, number> = {};
  for (const { evaluation } of reviewed) {
    for (const reason of evaluation?.failureReasons ?? []) {
      failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
    }
  }
  const expectedFactJoins = {
    exactMoment: rows.filter(
      ({ expectedFacts }) =>
        expectedFacts.joinStatus === "exact-moment"
    ).length,
    exactSourceTurns: rows.filter(
      ({ expectedFacts }) =>
        expectedFacts.joinStatus === "exact-source-turns"
    ).length,
    legacyFallback: rows.filter(
      ({ expectedFacts }) =>
        expectedFacts.joinStatus === "legacy-fallback"
    ).length,
    missing: rows.filter(
      ({ expectedFacts }) => expectedFacts.joinStatus === "missing"
    ).length,
    ambiguous: rows.filter(
      ({ expectedFacts }) => expectedFacts.joinStatus === "ambiguous"
    ).length,
    conflicting: rows.filter(
      ({ expectedFacts }) => expectedFacts.conflictFactKinds.length > 0
    ).length,
  };

  return {
    candidateCount: rows.length,
    reviewedCandidateCount: reviewed.length,
    criticalMomentCount: critical.length,
    notCriticalMomentCount: notCritical.length,
    uncertainMomentCount: uncertain.length,
    unresolvedCandidateCount:
      rows.length - critical.length - notCritical.length,
    cmsr: rate(strictSuccesses.length, critical.length),
    strictSuccessCount: strictSuccesses.length,
    timingNotEvaluableCount: critical.filter(({ evaluation }) => {
      if (!evaluation?.useful || !evaluation.trustworthy) return false;
      return !hasGuidanceBeforeSpeechEvidence(evaluation);
    }).length,
    zeroTraceOpportunityMissRate: rate(
      zeroTraceMoments.length,
      critical.length
    ),
    falseActivationRate: rate(falseActivations.length, notCritical.length),
    ttugMs: distribution(ttugValues),
    guidanceBeforeSpeechCoverage: rate(
      timingComparable.length,
      critical.length
    ),
    guidanceBeforeSpeechSuccess: rate(
      timingComparable.filter(
        ({ evaluation }) => !isGuidanceLate(evaluation)
      ).length,
      timingComparable.length
    ),
    naturalStartRate: explicitBooleanRate(
      critical.map(({ evaluation }) => evaluation?.naturalStart)
    ),
    waitedForJarvisRate: explicitBooleanRate(
      critical.map(({ evaluation }) => evaluation?.waitedForJarvis)
    ),
    readFromJarvisRate: explicitBooleanRate(
      critical.map(({ evaluation }) => evaluation?.readFromJarvis)
    ),
    interactionRequiredRate: explicitBooleanRate(
      critical.map(({ evaluation }) => evaluation?.interactionRequired)
    ),
    usefulButUntrustworthyCount: critical.filter(
      ({ evaluation }) =>
        evaluation?.useful === true && evaluation.trustworthy === false
    ).length,
    trustworthyButLateCount: critical.filter(
      ({ evaluation }) =>
        evaluation?.trustworthy === true && isGuidanceLate(evaluation)
    ).length,
    manyTraceMomentCount: rows.filter(
      ({ candidate, evaluation }) =>
        uniqueStrings([
          ...candidate.proposedTraceIds,
          ...(evaluation?.traceIds ?? []),
        ]).length > 1
    ).length,
    ambiguousJoinCount: rows.filter(
      ({ candidate }) => candidate.traceJoinStatus === "ambiguous"
    ).length,
    evaluationsWithoutCandidate,
    expectedFactJoins,
    failureReasons,
    denominatorAuthority: "explicit-human-eligibility",
  };
}

function buildLongitudinalCriticalMomentCandidates(
  session: LongitudinalSessionInput
) {
  const persisted = (session.criticalMomentCandidates ?? []).filter(
    (candidate) =>
      Boolean(candidate.momentId) && candidate.sourceTurnIds.length > 0
  );
  const coveredTurnIds = new Set(
    persisted.flatMap((candidate) => candidate.sourceTurnIds)
  );
  const fallback = buildFallbackCriticalMomentCandidates(
    session,
    coveredTurnIds
  );
  return [...persisted, ...fallback];
}

function buildFallbackCriticalMomentCandidates(
  session: LongitudinalSessionInput,
  excludedTurnIds: Set<string>
): LongitudinalCriticalMomentCandidate[] {
  const sessionId =
    session.manifest.sessionId ??
    session.manifest.folderName ??
    session.directory;
  const turns = session.transcriptTurns
    .filter(
      (turn) =>
        turn.speaker === "them" &&
        Boolean(turn.id && turn.text?.trim()) &&
        !excludedTurnIds.has(turn.id)
    )
    .sort(
      (left, right) =>
        (left.startedAt ?? 0) - (right.startedAt ?? 0) ||
        left.id.localeCompare(right.id)
    );
  if (!turns.length) return [];

  const turnById = new Map(turns.map((turn) => [turn.id, turn]));
  const parentByTurnId = new Map(turns.map((turn) => [turn.id, turn.id]));
  const find = (turnId: string): string => {
    const parent = parentByTurnId.get(turnId) ?? turnId;
    if (parent === turnId) return parent;
    const root = find(parent);
    parentByTurnId.set(turnId, root);
    return root;
  };
  const union = (leftId: string, rightId: string) => {
    const leftRoot = find(leftId);
    const rightRoot = find(rightId);
    if (leftRoot !== rightRoot) parentByTurnId.set(rightRoot, leftRoot);
  };

  for (const trace of session.traceSummaries) {
    const sourceTurnIds = uniqueStrings(
      trace.logicalQuestionSourceTurnIds ?? []
    ).filter((turnId) => turnById.has(turnId));
    const [firstTurnId, ...remainingTurnIds] = sourceTurnIds;
    if (!firstTurnId) continue;
    for (const turnId of remainingTurnIds) union(firstTurnId, turnId);
  }
  for (let index = 1; index < turns.length; index += 1) {
    const previous = turns[index - 1];
    const current = turns[index];
    if (shouldComposeLongitudinalTurns(previous, current)) {
      union(previous.id, current.id);
    }
  }

  const groups = new Map<string, LongitudinalTranscriptTurn[]>();
  for (const turn of turns) {
    const root = find(turn.id);
    groups.set(root, [...(groups.get(root) ?? []), turn]);
  }
  return Array.from(groups.values()).map((group) => {
    const ordered = [...group].sort(
      (left, right) =>
        (left.startedAt ?? 0) - (right.startedAt ?? 0) ||
        left.id.localeCompare(right.id)
    );
    const sourceTurnIds = ordered.map((turn) => turn.id);
    const sourceTurnIdSet = new Set(sourceTurnIds);
    const traces = session.traceSummaries.filter((trace) =>
      (trace.logicalQuestionSourceTurnIds ?? []).some((turnId) =>
        sourceTurnIdSet.has(turnId)
      )
    );
    const exactTraceCount = traces.filter((trace) =>
      (trace.logicalQuestionSourceTurnIds ?? []).every((turnId) =>
        sourceTurnIdSet.has(turnId)
      )
    ).length;
    const questionTypes = uniqueStrings(
      traces
        .map((trace) =>
          normalizeCanonicalQuestionType(
            trace.canonicalQuestionType ?? trace.questionType
          )
        )
        .filter(Boolean)
    );
    return {
      momentId: createLongitudinalMomentId(sessionId, sourceTurnIds),
      sessionId,
      sourceTurnIds,
      sourceText: ordered.map((turn) => turn.text?.trim()).filter(Boolean).join(" "),
      opportunityStartAt: ordered[0]?.startedAt,
      opportunityEndAt: ordered[ordered.length - 1]?.endedAt,
      candidateSource: traces.some((trace) => trace.logicalQuestionUnitId)
        ? "runtime-lqu"
        : "transcript-rule",
      candidateReasons: traces.length
        ? ["legacy-transcript-reconstruction"]
        : ["legacy-transcript-reconstruction", "zero-trace-opportunity"],
      proposedTraceIds: uniqueStrings(traces.map((trace) => trace.traceId)),
      proposedQuestionType:
        questionTypes.length === 1 ? questionTypes[0] : undefined,
      traceJoinStatus:
        traces.length === 0
          ? "none"
          : traces.length === 1 && exactTraceCount === 1
            ? "exact"
            : traces.length > 1 || exactTraceCount > 1
              ? "ambiguous"
              : "proposed",
      createdAt: ordered[0]?.startedAt,
      updatedAt: ordered[ordered.length - 1]?.endedAt,
    };
  });
}

function indexLatestMomentEvaluations(
  evaluations: LongitudinalCriticalMomentEvaluation[]
) {
  const byMoment = new Map<string, LongitudinalCriticalMomentEvaluation>();
  for (const evaluation of evaluations) {
    const current = byMoment.get(evaluation.momentId);
    if (
      !current ||
      (evaluation.updatedAt ?? 0) >= (current.updatedAt ?? 0)
    ) {
      byMoment.set(evaluation.momentId, evaluation);
    }
  }
  return byMoment;
}

function momentActivated({ traces }: JoinedCriticalMoment) {
  return traces.some(
    (trace) =>
      trace.advisorExecutionAuthorized === true ||
      trace.advisorOutputCommittedToUi === true ||
      trace.visibleAnswerChanged === true ||
      isCommittedDisposition(trace.advisorOutputDisposition)
  );
}

function hasGuidanceBeforeSpeechEvidence(
  evaluation: LongitudinalCriticalMomentEvaluation | undefined
) {
  return (
    finiteNumber(evaluation?.firstUsefulAt) !== undefined &&
    finiteNumber(evaluation?.userSpeechStartAt) !== undefined
  );
}

function isGuidanceLate(
  evaluation: LongitudinalCriticalMomentEvaluation | undefined
) {
  const firstUsefulAt = finiteNumber(evaluation?.firstUsefulAt);
  const userSpeechStartAt = finiteNumber(evaluation?.userSpeechStartAt);
  return (
    firstUsefulAt !== undefined &&
    userSpeechStartAt !== undefined &&
    firstUsefulAt > userSpeechStartAt
  );
}

function explicitBooleanRate(values: Array<boolean | undefined>) {
  const labeled = values.filter(
    (value): value is boolean => typeof value === "boolean"
  );
  return rate(
    labeled.filter((value) => value).length,
    labeled.length
  );
}

function createLongitudinalMomentId(
  sessionId: string,
  sourceTurnIds: string[]
) {
  return `critical_moment_${stableHash(
    `${sessionId}\u0000${uniqueStrings(sourceTurnIds)
      .sort()
      .join("\u0000")}`
  )}`;
}

function shouldComposeLongitudinalTurns(
  previous: LongitudinalTranscriptTurn,
  current: LongitudinalTranscriptTurn
) {
  const previousEndedAt = finiteNumber(previous.endedAt);
  const currentStartedAt = finiteNumber(current.startedAt);
  if (previousEndedAt === undefined || currentStartedAt === undefined) {
    return false;
  }
  const gapMs = currentStartedAt - previousEndedAt;
  if (gapMs < 0 || gapMs > 5_000) return false;
  const previousText = previous.text?.trim() ?? "";
  const currentText = current.text?.trim() ?? "";
  if (!previousText || !currentText || /[?？.!。！]$/.test(previousText)) {
    return false;
  }
  return (
    /[,，:：;；\-—]$/.test(previousText) ||
    /^(?:and|or|but|because|so|then|also|which|that|where|when|how|what|why|who|can|could|would|should|do|does|did|is|are|was|were)\b/i.test(
      currentText
    ) ||
    /^[a-z]/.test(currentText)
  );
}

function stableHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function uniqueStrings(values: Array<string | undefined>) {
  return Array.from(
    new Set(
      values.filter(
        (value): value is string =>
          typeof value === "string" && Boolean(value.trim())
      )
    )
  );
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
    "## Product Outcomes",
    "",
    `Critical moment candidates: ${report.productOutcomes.candidateCount}`,
    `Reviewed candidates: ${report.productOutcomes.reviewedCandidateCount}`,
    `Critical / not critical / uncertain / unresolved: ${report.productOutcomes.criticalMomentCount} / ${report.productOutcomes.notCriticalMomentCount} / ${report.productOutcomes.uncertainMomentCount} / ${report.productOutcomes.unresolvedCandidateCount}`,
    `Critical Moment Success Rate: ${formatRate(report.productOutcomes.cmsr)}`,
    `Zero-trace opportunity miss rate: ${formatRate(report.productOutcomes.zeroTraceOpportunityMissRate)}`,
    `False activation on reviewed non-critical moments: ${formatRate(report.productOutcomes.falseActivationRate)}`,
    `Time to useful guidance: ${formatDistribution(report.productOutcomes.ttugMs)}`,
    `Guidance-before-speech coverage: ${formatRate(report.productOutcomes.guidanceBeforeSpeechCoverage)}`,
    `Guidance-before-speech success: ${formatRate(report.productOutcomes.guidanceBeforeSpeechSuccess)}`,
    `Natural start: ${formatRate(report.productOutcomes.naturalStartRate)}`,
    `Waited for Jarvis: ${formatRate(report.productOutcomes.waitedForJarvisRate)}`,
    `Read from Jarvis: ${formatRate(report.productOutcomes.readFromJarvisRate)}`,
    `Interaction required: ${formatRate(report.productOutcomes.interactionRequiredRate)}`,
    `Timing not evaluable: ${report.productOutcomes.timingNotEvaluableCount}`,
    `Useful but untrustworthy / trustworthy but late: ${report.productOutcomes.usefulButUntrustworthyCount} / ${report.productOutcomes.trustworthyButLateCount}`,
    `Many-trace moments / ambiguous joins: ${report.productOutcomes.manyTraceMomentCount} / ${report.productOutcomes.ambiguousJoinCount}`,
    `Evaluations without candidate evidence: ${report.productOutcomes.evaluationsWithoutCandidate}`,
    `Expected-fact joins (moment / source turns / legacy / missing / ambiguous / conflicts): ${report.productOutcomes.expectedFactJoins.exactMoment} / ${report.productOutcomes.expectedFactJoins.exactSourceTurns} / ${report.productOutcomes.expectedFactJoins.legacyFallback} / ${report.productOutcomes.expectedFactJoins.missing} / ${report.productOutcomes.expectedFactJoins.ambiguous} / ${report.productOutcomes.expectedFactJoins.conflicting}`,
    `Denominator authority: ${report.productOutcomes.denominatorAuthority}`,
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
    "## Relation Adjudication Shadow",
    "",
    `Sessions / operations / candidates / labeled: ${report.relationAdjudicationFunnel.sessionsObserved} / ${report.relationAdjudicationFunnel.operations} / ${report.relationAdjudicationFunnel.candidateAvailable} / ${report.relationAdjudicationFunnel.humanLabeled}`,
    `Deterministic/LLM agreement: ${formatRate(report.relationAdjudicationFunnel.deterministicAgreement)}`,
    `LLM / deterministic accuracy: ${formatRate(report.relationAdjudicationFunnel.llmAccuracy)} / ${formatRate(report.relationAdjudicationFunnel.deterministicAccuracy)}`,
    `New-parent precision: ${formatRate(report.relationAdjudicationFunnel.newParentPrecision)}`,
    `Structured output validity: ${formatRate(report.relationAdjudicationFunnel.structuredOutputValidity)}`,
    `Counterfactual accuracy / new-parent precision: ${formatRate(report.relationAdjudicationFunnel.counterfactualAccuracy)} / ${formatRate(report.relationAdjudicationFunnel.counterfactualNewParentPrecision)}`,
    `Counterfactual rescues / regressions: ${report.relationAdjudicationFunnel.counterfactualRescues} / ${report.relationAdjudicationFunnel.counterfactualRegressions}`,
    `Semantic-correct but production-inapplicable / human-path-inapplicable: ${report.relationAdjudicationFunnel.semanticCorrectProductionInapplicable} / ${report.relationAdjudicationFunnel.humanPathInapplicable}`,
    `Relation context-loss / contamination risk: ${report.relationAdjudicationFunnel.relationContextLossRisk} / ${report.relationAdjudicationFunnel.relationContaminationRisk}`,
    `False parent / child / resume: ${report.relationAdjudicationFunnel.falseParent} / ${report.relationAdjudicationFunnel.falseChild} / ${report.relationAdjudicationFunnel.falseResume}`,
    `Context loss / contamination / stale: ${report.relationAdjudicationFunnel.contextLoss} / ${report.relationAdjudicationFunnel.contextContamination} / ${report.relationAdjudicationFunnel.stale}`,
    `Runtime mutation applied: ${report.relationAdjudicationFunnel.mutationApplied}`,
    `Latency: ${formatDistribution(report.relationAdjudicationFunnel.latencyMs)}`,
    "",
    "## Meeting Metadata",
    "",
    `Operations / proposals / committed / abstained / human labeled: ${report.meetingMetadataFunnel.operationsObserved} / ${report.meetingMetadataFunnel.proposalCount} / ${report.meetingMetadataFunnel.committedCount} / ${report.meetingMetadataFunnel.abstentionCount} / ${report.meetingMetadataFunnel.humanLabeled}`,
    `Proposal precision / recall: ${formatRate(report.meetingMetadataFunnel.proposalPrecision)} / ${formatRate(report.meetingMetadataFunnel.proposalRecall)}`,
    `Effective target precision / recall / accuracy: ${formatRate(report.meetingMetadataFunnel.effectiveTargetPrecision)} / ${formatRate(report.meetingMetadataFunnel.effectiveTargetRecall)} / ${formatRate(report.meetingMetadataFunnel.effectiveTargetAccuracy)}`,
    `Mutation accuracy: ${formatRate(report.meetingMetadataFunnel.mutationAccuracy)}`,
    `Conflict / stale rate: ${formatRate(report.meetingMetadataFunnel.conflictRate)} / ${formatRate(report.meetingMetadataFunnel.staleRate)}`,
    `Unauthorized overrides: ${report.meetingMetadataFunnel.unauthorizedOverrideCount}`,
    `Error kinds: ${formatCountMap(report.meetingMetadataFunnel.errorKinds)}`,
    `Denominator authority: ${report.meetingMetadataFunnel.denominatorAuthority}`,
    "",
    "## Whiteboard Render Integrity",
    "",
    `Candidates -> invalid -> repair attempts -> settled -> successful shadow repairs: ${report.whiteboardRenderFunnel.observedCandidates} -> ${report.whiteboardRenderFunnel.invalidCandidates} -> ${report.whiteboardRenderFunnel.repairAttempts} -> ${report.whiteboardRenderFunnel.settledRepairAttempts} -> ${report.whiteboardRenderFunnel.successfulShadowRepairs}`,
    `Deterministic sanitation attempts / successes: ${report.whiteboardRenderFunnel.sanitationAttempts} / ${report.whiteboardRenderFunnel.sanitationSuccesses}`,
    `Validation failure rate: ${formatRate(report.whiteboardRenderFunnel.validationFailureRate)}`,
    `Repair attempt rate: ${formatRate(report.whiteboardRenderFunnel.repairAttemptRate)}`,
    `Repair success rate: ${formatRate(report.whiteboardRenderFunnel.repairSuccessRate)}`,
    `Preserved last valid: ${formatRate(report.whiteboardRenderFunnel.preservedLastValidRate)}`,
    `ASCII fallback: ${formatRate(report.whiteboardRenderFunnel.asciiFallbackRate)}`,
    `Mermaid eligible / requested / committed: ${report.whiteboardRenderFunnel.mermaidEligibleCount} / ${report.whiteboardRenderFunnel.mermaidRequestedCount} / ${report.whiteboardRenderFunnel.mermaidCommittedCount}`,
    `Mermaid commit rate: ${formatRate(report.whiteboardRenderFunnel.mermaidCommitRate)}`,
    `Format policy misses / conversions / ASCII fallbacks: ${report.whiteboardRenderFunnel.formatPolicyMissCount} / ${report.whiteboardRenderFunnel.formatConversionAttemptCount} / ${report.whiteboardRenderFunnel.formatAsciiFallbackCount}`,
    `Format policy miss / conversion attempt rate: ${formatRate(report.whiteboardRenderFunnel.formatPolicyMissRate)} / ${formatRate(report.whiteboardRenderFunnel.formatConversionAttemptRate)}`,
    `Validation latency: ${formatDistribution(report.whiteboardRenderFunnel.validationLatencyMs)}`,
    `Repair queue wait: ${formatDistribution(report.whiteboardRenderFunnel.repairQueueWaitMs)}`,
    `Repair duration: ${formatDistribution(report.whiteboardRenderFunnel.repairDurationMs)}`,
    "",
    "## Project Trajectory Grounding",
    "",
    `Observed / human labeled: ${report.projectTrajectoryFunnel.observedTraces} / ${report.projectTrajectoryFunnel.humanLabeled}`,
    `Project agreement: ${formatRate(report.projectTrajectoryFunnel.projectAgreement)}`,
    `Phase agreement: ${formatRate(report.projectTrajectoryFunnel.phaseAgreement)}`,
    `Fact-support agreement: ${formatRate(report.projectTrajectoryFunnel.factSupportAgreement)}`,
    `Child/resume agreement: ${formatRate(report.projectTrajectoryFunnel.childContinuityAgreement)}`,
    `Child resume success: ${formatRate(report.projectTrajectoryFunnel.childResumeSuccessRate)}`,
    `Phase restarts / wrong-project fact support / unsupported first-person claims: ${report.projectTrajectoryFunnel.phaseRestartCount} / ${report.projectTrajectoryFunnel.wrongProjectFactSupportCount} / ${report.projectTrajectoryFunnel.unsupportedFirstPersonClaimCount}`,
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
  const projected = projectObservedParentAction({
    relation: normalizeObservedRelation(trace.taskRelation),
    mutationAuthorized: trace.taskMutationAuthorized,
    lifecycleCommand: trace.taskMutationCommand,
    currentOnly: trace.taskRelation === "none",
    parentBeforeId:
      trace.taskLifecycleParentBeforeId ??
      trace.taskBoundary?.parentBeforeId,
    parentAfterId:
      trace.taskLifecycleParentAfterId ??
      trace.taskBoundary?.parentAfterId,
    parentBeforeType: normalizeCanonicalQuestionType(
      trace.taskLifecycleParentBeforeType
    ),
    parentAfterType: normalizeCanonicalQuestionType(
      trace.taskLifecycleParentAfterType
    ),
  });
  return projected ??
    (trace.taskBoundary?.mutationDisposition === "commit-before-advisor"
      ? "create"
      : undefined);
}

function normalizeObservedRelation(
  value: string | undefined
): HumanEvaluationTaskRelation | undefined {
  return value === "new-parent" ||
    value === "followup-parent" ||
    value === "child-probe" ||
    value === "resume-parent" ||
    value === "logistics" ||
    value === "correction" ||
    value === "unknown" ||
    value === "none"
    ? value
    : undefined;
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

function aggregateRates(metrics: RateMetric[]): RateMetric {
  return rate(
    sum(metrics.map((metric) => metric.numerator)),
    sum(metrics.map((metric) => metric.denominator))
  );
}

function verdictRate(
  projections: HumanEvaluationProjectionV2[],
  key:
    | "projectCorrect"
    | "playbookPhaseCorrect"
    | "factSupportCorrect"
    | "childContinuityCorrect"
) {
  const comparable = projections
    .map((projection) => projection.verdicts[key])
    .filter((value): value is boolean => typeof value === "boolean");
  return rate(
    comparable.filter(Boolean).length,
    comparable.length
  );
}

function countProjectPhaseRestarts(rows: JoinedTrace[]) {
  const phaseRank = new Map([
    ["project_narrative", 0],
    ["architecture_decision", 1],
    ["validation_reliability", 2],
    ["impact_lessons", 3],
  ]);
  const highestByParent = new Map<string, number>();
  let restarts = 0;
  for (const { trace } of [...rows].sort(
    (left, right) =>
      (left.trace.startedAt ?? 0) - (right.trace.startedAt ?? 0)
  )) {
    const parentId = trace.projectTrajectory?.parentId;
    const phase = trace.projectTrajectory?.phase;
    const rank = phase ? phaseRank.get(phase) : undefined;
    if (!parentId || rank === undefined) continue;
    const highest = highestByParent.get(parentId);
    if (
      highest !== undefined &&
      rank < highest &&
      trace.projectTrajectory?.transitionKind !== "child-probe"
    ) {
      restarts += 1;
    }
    highestByParent.set(parentId, Math.max(highest ?? rank, rank));
  }
  return restarts;
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

function formatCountMap(values: Record<string, number>) {
  const entries = Object.entries(values).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return entries.length
    ? entries.map(([key, count]) => `${key}=${count}`).join(", ")
    : "none";
}
