import {
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";

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
  advisorIntent?: {
    expectedAction?: "advise" | "append-context" | "buffer" | "ignore";
  };
  updatedAt: number;
}

export interface TaxonomyAdjudicationCompactTrace {
  sessionId: string;
  traceId: string;
  startedAt?: number;
  canonicalQuestionType?: string;
  questionType?: string;
  logicalQuestionUnitId?: string;
  logicalQuestionUnitRevision?: number;
  logicalQuestionBoundaryReason?: string;
  currentQuestionTerminalNoAnswer?: {
    disposition?: string;
    authorized?: boolean;
    applied?: boolean;
    applyReason?: string;
    logicalQuestionUnitId?: string;
    logicalQuestionUnitRevision?: number;
    advisorCancelled?: boolean;
    memoryStarted?: boolean;
    modelStarted?: boolean;
    avoidedMemoryOpportunity?: boolean;
    avoidedModelOpportunity?: boolean;
  };
  semanticTaxonomy?: {
    keywordType?: string;
    semanticCandidateType?: string;
    hybridOutcome?: string;
    wouldRescue?: boolean;
    rescueApplied?: boolean;
  };
  interviewerIntentSemantic?: {
    speechAct?: string;
    relation?: string;
    evidenceMode?: string;
  };
  interviewerIntentLlm?: {
    speechAct?: string;
    questionType?: string;
    relation?: string;
    evidenceMode?: string;
    action?: string;
    parseErrorKind?: string;
    outputEnvelope?: string;
    budgetSlot?: string;
    budgetReason?: string;
    sourceOwnedSubstantive?: boolean;
    budgetStartsBefore?: number;
    budgetStartsAfter?: number;
    budgetLimit?: number;
    budgetRemaining?: number;
    ambientStarts?: number;
    substantiveStarts?: number;
    reservedSubstantiveAvailable?: boolean;
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
    parseErrorKind?: string;
    outputEnvelope?: string;
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
    budgetSlot?: string;
    budgetReason?: string;
    sourceOwnedSubstantive?: boolean;
    budgetStartsBefore?: number;
    budgetStartsAfter?: number;
    budgetLimit?: number;
    budgetRemaining?: number;
    ambientStarts?: number;
    substantiveStarts?: number;
    reservedSubstantiveAvailable?: boolean;
  };
}

export interface TaxonomyAdjudicationReflectionRow {
  key: string;
  operationId?: string;
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
  parseErrorKind?: string;
  outputEnvelope?: string;
  staleReason?: string;
  lexicalType: CanonicalQuestionType;
  localSemanticType?: CanonicalQuestionType;
  localHybridOutcome?: string;
  localSemanticSpeechAct?: string;
  localSemanticRelation?: string;
  localSemanticEvidenceMode?: string;
  llmSpeechAct?: string;
  llmCandidateType?: CanonicalQuestionType;
  llmRelation?: string;
  llmEvidenceMode?: string;
  llmAction?: string;
  runtimeType?: CanonicalQuestionType;
  expectedType?: CanonicalQuestionType;
  expectedRelation?: string;
  expectedAction?: string;
  typeCorrect?: boolean;
  relationCorrect?: boolean;
  actionCorrect?: boolean;
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
  budgetSlot?: string;
  budgetReason?: string;
  sourceOwnedSubstantive?: boolean;
  budgetStartsBefore?: number;
  budgetStartsAfter?: number;
  budgetLimit?: number;
  budgetRemaining?: number;
  ambientStarts?: number;
  substantiveStarts?: number;
  reservedSubstantiveAvailable?: boolean;
  terminalNoAnswerDisposition?: string;
  terminalNoAnswerAuthorized?: boolean;
  terminalNoAnswerApplied?: boolean;
  terminalNoAnswerApplyReason?: string;
  terminalNoAnswerAdvisorCancelled?: boolean;
  terminalNoAnswerMemoryStarted?: boolean;
  terminalNoAnswerModelStarted?: boolean;
  terminalNoAnswerAvoidedMemoryOpportunity?: boolean;
  terminalNoAnswerAvoidedModelOpportunity?: boolean;
}

export interface TaxonomyAdjudicationReflectionReport {
  version: 5;
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
    actionAgreements: EvaluationFunnelStage;
  };
  metrics: {
    observedOperations: number;
    observedUnits: number;
    operationsWithId: number;
    legacyFallbackOperations: number;
    retriedUnits: number;
    retryOperations: number;
    maxOperationsPerUnit: number;
    substantiveUnits: number;
    eligible: number;
    triggeredCalls: number;
    skipped: number;
    triggerRate: number | null;
    callRateSemantics: "reason-coded-observational";
    triggerReasons: Record<string, number>;
    dispositions: Record<string, number>;
    providerDispositions: Record<string, number>;
    parseDispositions: Record<string, number>;
    parseErrorKinds: Record<string, number>;
    outputEnvelopes: Record<string, number>;
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
    labeledActionProposals: number;
    actionPrecision: number | null;
    speechActProposals: Record<string, number>;
    evidenceModeProposals: Record<string, number>;
    actionProposals: Record<string, number>;
    budgetSlots: Record<string, number>;
    budgetReasons: Record<string, number>;
    ambientTriggeredCalls: number;
    substantiveTriggeredCalls: number;
    ambientBudgetExhausted: number;
    substantiveBudgetExhausted: number;
    ambientCallsPreservingSubstantiveReservation: number;
    substantiveCallsAfterAmbientStart: number;
    terminalNoAnswerCandidates: number;
    terminalNoAnswerAuthorized: number;
    terminalNoAnswerApplied: number;
    terminalNoAnswerFailOpen: number;
    terminalNoAnswerPostVisible: number;
    terminalNoAnswerAdvisorCancelled: number;
    terminalNoAnswerAvoidedMemoryOpportunity: number;
    terminalNoAnswerAvoidedModelOpportunity: number;
    terminalNoAnswerDispositions: Record<string, number>;
    terminalNoAnswerApplyReasons: Record<string, number>;
    logicalQuestionBoundaryReasons: Record<string, number>;
    terminalNoAnswerAmbientContinuations: number;
    terminalNoAnswerSubstantiveBoundaries: number;
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

  const rows = selectLatestOperationDecisions(input.decisions).map((decision) => {
    const metadata = decision.metadata;
    const trace = traceById.get(decision.traceId);
    const summary = trace?.taxonomyAdjudication;
    const intentSummary = trace?.interviewerIntentLlm;
    const terminalSummary = trace?.currentQuestionTerminalNoAnswer;
    const evaluation = evaluationByTraceId.get(decision.traceId);
    const human = evaluation?.taxonomyAdjudication;
    const llmCandidateType = normalizeType(
      readString(metadata, "interviewerIntentLlmQuestionType") ??
        intentSummary?.questionType ??
        readString(metadata, "taxonomyAdjudicationCandidateType") ??
        summary?.candidateType
    );
    const expectedType = normalizeType(
      evaluation?.correctedQuestionType ?? evaluation?.questionType
    );
    const llmRelation =
      readString(metadata, "interviewerIntentLlmRelation") ??
      intentSummary?.relation ??
      readString(metadata, "taxonomyAdjudicationRelation") ??
      summary?.relation;
    const llmAction =
      readString(metadata, "interviewerIntentLlmAction") ??
      intentSummary?.action;
    const expectedAction = evaluation?.advisorIntent?.expectedAction;
    const actionCorrect =
      expectedAction && llmAction
        ? normalizeExpectedAction(expectedAction) === llmAction
        : undefined;
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
    const operationId =
      readString(metadata, "taxonomyAdjudicationOperationId") ??
      readString(metadata, "interviewerIntentLlmOperationId") ??
      summary?.operationId;
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
      key: buildDecisionSelectionKey(decision),
      operationId,
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
      parseErrorKind:
        readString(metadata, "taxonomyAdjudicationParseErrorKind") ??
        readString(metadata, "interviewerIntentLlmParseErrorKind") ??
        summary?.parseErrorKind ??
        intentSummary?.parseErrorKind,
      outputEnvelope:
        readString(metadata, "taxonomyAdjudicationOutputEnvelope") ??
        readString(metadata, "interviewerIntentLlmOutputEnvelope") ??
        summary?.outputEnvelope ??
        intentSummary?.outputEnvelope,
      staleReason:
        readString(metadata, "taxonomyAdjudicationStaleReason") ??
        summary?.staleReason,
      lexicalType:
        normalizeType(trace?.semanticTaxonomy?.keywordType) ?? "unknown",
      localSemanticType: normalizeType(
        trace?.semanticTaxonomy?.semanticCandidateType
      ),
      localHybridOutcome: trace?.semanticTaxonomy?.hybridOutcome,
      localSemanticSpeechAct:
        trace?.interviewerIntentSemantic?.speechAct,
      localSemanticRelation:
        trace?.interviewerIntentSemantic?.relation,
      localSemanticEvidenceMode:
        trace?.interviewerIntentSemantic?.evidenceMode,
      llmSpeechAct:
        readString(metadata, "interviewerIntentLlmSpeechAct") ??
        intentSummary?.speechAct,
      llmCandidateType,
      llmRelation,
      llmEvidenceMode:
        readString(metadata, "interviewerIntentLlmEvidenceMode") ??
        intentSummary?.evidenceMode,
      llmAction,
      runtimeType: normalizeType(
        trace?.canonicalQuestionType ?? trace?.questionType
      ),
      expectedType,
      expectedRelation,
      expectedAction,
      typeCorrect,
      relationCorrect,
      actionCorrect,
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
      budgetSlot:
        readString(metadata, "taxonomyAdjudicationBudgetSlot") ??
        readString(metadata, "interviewerIntentLlmBudgetSlot") ??
        summary?.budgetSlot ??
        intentSummary?.budgetSlot,
      budgetReason:
        readString(metadata, "taxonomyAdjudicationBudgetReason") ??
        readString(metadata, "interviewerIntentLlmBudgetReason") ??
        summary?.budgetReason ??
        intentSummary?.budgetReason,
      sourceOwnedSubstantive:
        readBoolean(metadata, "taxonomyAdjudicationSourceOwnedSubstantive") ??
        readBoolean(metadata, "interviewerIntentLlmSourceOwnedSubstantive") ??
        summary?.sourceOwnedSubstantive ??
        intentSummary?.sourceOwnedSubstantive,
      budgetStartsBefore:
        readNumber(metadata, "taxonomyAdjudicationBudgetStartsBefore") ??
        summary?.budgetStartsBefore ??
        intentSummary?.budgetStartsBefore,
      budgetStartsAfter:
        readNumber(metadata, "taxonomyAdjudicationBudgetStartsAfter") ??
        summary?.budgetStartsAfter ??
        intentSummary?.budgetStartsAfter,
      budgetLimit:
        readNumber(metadata, "taxonomyAdjudicationBudgetLimit") ??
        summary?.budgetLimit ??
        intentSummary?.budgetLimit,
      budgetRemaining:
        readNumber(metadata, "taxonomyAdjudicationBudgetRemaining") ??
        summary?.budgetRemaining ??
        intentSummary?.budgetRemaining,
      ambientStarts:
        readNumber(metadata, "taxonomyAdjudicationAmbientStarts") ??
        summary?.ambientStarts ??
        intentSummary?.ambientStarts,
      substantiveStarts:
        readNumber(metadata, "taxonomyAdjudicationSubstantiveStarts") ??
        summary?.substantiveStarts ??
        intentSummary?.substantiveStarts,
      reservedSubstantiveAvailable:
        readBoolean(
          metadata,
          "taxonomyAdjudicationReservedSubstantiveAvailable"
        ) ??
        readBoolean(
          metadata,
          "interviewerIntentLlmReservedSubstantiveAvailable"
        ) ??
        summary?.reservedSubstantiveAvailable ??
        intentSummary?.reservedSubstantiveAvailable,
      terminalNoAnswerDisposition:
        readString(
          metadata,
          "currentQuestionTerminalNoAnswerDisposition"
        ) ?? terminalSummary?.disposition,
      terminalNoAnswerAuthorized:
        readBoolean(
          metadata,
          "currentQuestionTerminalNoAnswerAuthorized"
        ) ?? terminalSummary?.authorized,
      terminalNoAnswerApplied:
        readBoolean(
          metadata,
          "interviewerIntentLlmTerminalNoAnswerApplied"
        ) ?? terminalSummary?.applied,
      terminalNoAnswerApplyReason:
        readString(
          metadata,
          "interviewerIntentLlmTerminalNoAnswerApplyReason"
        ) ?? terminalSummary?.applyReason,
      terminalNoAnswerAdvisorCancelled:
        readBoolean(
          metadata,
          "interviewerIntentLlmTerminalNoAnswerAdvisorCancelled"
        ) ?? terminalSummary?.advisorCancelled,
      terminalNoAnswerMemoryStarted:
        readBoolean(
          metadata,
          "taxonomyAdjudicationTerminalNoAnswerMemoryStarted"
        ) ?? terminalSummary?.memoryStarted,
      terminalNoAnswerModelStarted:
        readBoolean(
          metadata,
          "taxonomyAdjudicationTerminalNoAnswerModelStarted"
        ) ?? terminalSummary?.modelStarted,
      terminalNoAnswerAvoidedMemoryOpportunity:
        readBoolean(
          metadata,
          "taxonomyAdjudicationTerminalNoAnswerAvoidedMemoryOpportunity"
        ) ?? terminalSummary?.avoidedMemoryOpportunity,
      terminalNoAnswerAvoidedModelOpportunity:
        readBoolean(
          metadata,
          "taxonomyAdjudicationTerminalNoAnswerAvoidedModelOpportunity"
        ) ?? terminalSummary?.avoidedModelOpportunity,
    } satisfies TaxonomyAdjudicationReflectionRow;
  });

  const substantiveRows = rows.filter(isSubstantiveObservedUnit);
  const eligibleRows = substantiveRows.filter((row) => row.eligible);
  const triggeredRows = eligibleRows.filter(isTriggeredRow);
  const ambientTriggeredRows = rows.filter(
    (row) => row.budgetSlot === "ambient" && isTriggeredRow(row)
  );
  const substantiveTriggeredRows = rows.filter(
    (row) => row.budgetSlot === "substantive" && isTriggeredRow(row)
  );
  const terminalNoAnswerRows = rows.filter(
    (row) => row.terminalNoAnswerDisposition !== undefined
  );
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
  const actionLabeled = providerValidRows.filter(
    (row) => row.actionCorrect !== undefined
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
  const operationCountsByUnit = countOperationsByUnit(rows);
  const operationCounts = Array.from(operationCountsByUnit.values());
  const observedUnits = operationCountsByUnit.size;
  const retriedUnits = operationCounts.filter((count) => count > 1).length;
  const retryOperations = operationCounts.reduce(
    (total, count) => total + Math.max(0, count - 1),
    0
  );
  const traceIdsWithDecisions = new Set(rows.map((row) => row.traceId));
  const knownTraceIds = new Set(input.traces.map((trace) => trace.traceId));
  const taxonomyAgreements = typeLabeled.filter((row) => row.typeCorrect).length;
  const trajectoryAgreements = relationLabeled.filter(
    (row) => row.relationCorrect
  ).length;
  const actionAgreements = actionLabeled.filter(
    (row) => row.actionCorrect
  ).length;
  const logicalQuestionBoundaryReasons = countStrings(
    input.traces.map((trace) => trace.logicalQuestionBoundaryReason)
  );

  return {
    version: 5,
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
      actionAgreements: funnelStage(
        actionAgreements,
        actionLabeled.length
      ),
    },
    metrics: {
      observedOperations: rows.length,
      observedUnits,
      operationsWithId: rows.filter((row) => Boolean(row.operationId)).length,
      legacyFallbackOperations: rows.filter((row) => !row.operationId).length,
      retriedUnits,
      retryOperations,
      maxOperationsPerUnit: operationCounts.length
        ? Math.max(...operationCounts)
        : 0,
      substantiveUnits: substantiveRows.length,
      eligible: eligibleRows.length,
      triggeredCalls: triggeredRows.length,
      skipped: rows.filter((row) => !row.eligible || !row.durationMs).length,
      triggerRate,
      callRateSemantics: "reason-coded-observational",
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
      parseErrorKinds: countStrings(
        triggeredRows.map((row) => row.parseErrorKind)
      ),
      outputEnvelopes: countStrings(
        triggeredRows.map((row) => row.outputEnvelope)
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
      labeledActionProposals: actionLabeled.length,
      actionPrecision: ratio(actionAgreements, actionLabeled.length),
      speechActProposals: countStrings(rows.map((row) => row.llmSpeechAct)),
      evidenceModeProposals: countStrings(
        rows.map((row) => row.llmEvidenceMode)
      ),
      actionProposals: countStrings(rows.map((row) => row.llmAction)),
      budgetSlots: countStrings(rows.map((row) => row.budgetSlot)),
      budgetReasons: countStrings(rows.map((row) => row.budgetReason)),
      ambientTriggeredCalls: ambientTriggeredRows.length,
      substantiveTriggeredCalls: substantiveTriggeredRows.length,
      ambientBudgetExhausted: rows.filter(
        (row) =>
          row.budgetSlot === "ambient" &&
          row.disposition === "budget-exhausted"
      ).length,
      substantiveBudgetExhausted: rows.filter(
        (row) =>
          row.budgetSlot === "substantive" &&
          row.disposition === "budget-exhausted"
      ).length,
      ambientCallsPreservingSubstantiveReservation:
        ambientTriggeredRows.filter(
          (row) => row.reservedSubstantiveAvailable === true
        ).length,
      substantiveCallsAfterAmbientStart:
        substantiveTriggeredRows.filter(
          (row) => (row.ambientStarts ?? 0) > 0
        ).length,
      terminalNoAnswerCandidates: terminalNoAnswerRows.length,
      terminalNoAnswerAuthorized: terminalNoAnswerRows.filter(
        (row) => row.terminalNoAnswerAuthorized
      ).length,
      terminalNoAnswerApplied: terminalNoAnswerRows.filter(
        (row) => row.terminalNoAnswerApplied
      ).length,
      terminalNoAnswerFailOpen: terminalNoAnswerRows.filter(
        (row) => !row.terminalNoAnswerAuthorized
      ).length,
      terminalNoAnswerPostVisible: terminalNoAnswerRows.filter(
        (row) =>
          row.terminalNoAnswerApplyReason ===
          "visible-answer-already-started"
      ).length,
      terminalNoAnswerAdvisorCancelled: terminalNoAnswerRows.filter(
        (row) => row.terminalNoAnswerAdvisorCancelled
      ).length,
      terminalNoAnswerAvoidedMemoryOpportunity:
        terminalNoAnswerRows.filter(
          (row) => row.terminalNoAnswerAvoidedMemoryOpportunity
        ).length,
      terminalNoAnswerAvoidedModelOpportunity:
        terminalNoAnswerRows.filter(
          (row) => row.terminalNoAnswerAvoidedModelOpportunity
        ).length,
      terminalNoAnswerDispositions: countStrings(
        terminalNoAnswerRows.map(
          (row) => row.terminalNoAnswerDisposition
        )
      ),
      terminalNoAnswerApplyReasons: countStrings(
        terminalNoAnswerRows.map(
          (row) => row.terminalNoAnswerApplyReason
        )
      ),
      logicalQuestionBoundaryReasons,
      terminalNoAnswerAmbientContinuations:
        logicalQuestionBoundaryReasons[
          "terminal-no-answer-ambient-continuation"
        ] ?? 0,
      terminalNoAnswerSubstantiveBoundaries:
        logicalQuestionBoundaryReasons[
          "terminal-no-answer-substantive-boundary"
        ] ?? 0,
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
    `- Observed operations / unique units: ${report.metrics.observedOperations} / ${report.metrics.observedUnits}`,
    `- Operation IDs / legacy fallbacks: ${report.metrics.operationsWithId} / ${report.metrics.legacyFallbackOperations}`,
    `- Retried units / retry operations / max operations per unit: ${report.metrics.retriedUnits} / ${report.metrics.retryOperations} / ${report.metrics.maxOperationsPerUnit}`,
    `- Substantive operation rows: ${report.metrics.substantiveUnits}`,
    `- Eligible / triggered calls: ${report.metrics.eligible} / ${report.metrics.triggeredCalls}`,
    `- Observational call rate: ${percent(report.metrics.triggerRate)} (reason-coded; not a pass/fail target)`,
    `- Valid / invalid outputs: ${report.metrics.validOutputs} / ${report.metrics.invalidOutputs}`,
    `- Stale or superseded: ${report.metrics.staleOrSuperseded}`,
    `- Would repair / applied: ${report.metrics.wouldRepair} / ${report.metrics.repairApplied}`,
    `- Ambient / substantive calls: ${report.metrics.ambientTriggeredCalls} / ${report.metrics.substantiveTriggeredCalls}`,
    `- Ambient calls preserving the substantive reservation: ${report.metrics.ambientCallsPreservingSubstantiveReservation}`,
    `- Substantive calls after an ambient start: ${report.metrics.substantiveCallsAfterAmbientStart}`,
    `- Terminal no-answer candidates / authorized / applied: ${report.metrics.terminalNoAnswerCandidates} / ${report.metrics.terminalNoAnswerAuthorized} / ${report.metrics.terminalNoAnswerApplied}`,
    `- Terminal no-answer fail-open / post-visible: ${report.metrics.terminalNoAnswerFailOpen} / ${report.metrics.terminalNoAnswerPostVisible}`,
    `- Advisor cancellations / avoided memory / avoided model opportunities: ${report.metrics.terminalNoAnswerAdvisorCancelled} / ${report.metrics.terminalNoAnswerAvoidedMemoryOpportunity} / ${report.metrics.terminalNoAnswerAvoidedModelOpportunity}`,
    `- Terminal ambient continuations / fresh substantive boundaries: ${report.metrics.terminalNoAnswerAmbientContinuations} / ${report.metrics.terminalNoAnswerSubstantiveBoundaries}`,
    `- Type precision: ${percent(report.metrics.typePrecision)} (${report.metrics.labeledTypeProposals} labeled)`,
    `- Relation precision: ${percent(report.metrics.relationPrecision)} (${report.metrics.labeledRelationProposals} labeled)`,
    `- Advisor-action precision: ${percent(report.metrics.actionPrecision)} (${report.metrics.labeledActionProposals} labeled)`,
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
    "| Unit | Operation | Lexical | Local semantic | LLM | Speech act | Relation | Evidence mode | Action | Runtime | Disposition | Repair | Human | Timing |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...report.rows.map(
      (row) =>
        `| ${escapeCell(`${row.unitId ?? row.traceId}@${row.unitRevision ?? 0}`)} | ${escapeCell(row.operationId ?? "legacy")} | ${row.lexicalType} | ${row.localSemanticType ?? "-"} | ${row.llmCandidateType ?? "-"} | ${row.llmSpeechAct ?? "-"} | ${row.llmRelation ?? "-"} | ${row.llmEvidenceMode ?? "-"} | ${row.llmAction ?? "-"} | ${row.runtimeType ?? "-"} | ${row.disposition ?? row.skipReason ?? "-"} | ${row.repairApplied ? "applied" : row.wouldRepair ? "would" : "-"} | ${formatHumanVerdict(row)} | ${row.arrivalStage ?? "-"} |`
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
    "### Parse Error Kinds",
    "",
    ...formatCountMap(report.metrics.parseErrorKinds),
    "",
    "### Output Envelopes",
    "",
    ...formatCountMap(report.metrics.outputEnvelopes),
    "",
    "## Type Confusion",
    "",
    ...formatConfusion(report.typeConfusion),
    "",
    "## Relation Confusion",
    "",
    ...formatConfusion(report.relationConfusion),
    "",
    "## Intent Head Distributions",
    "",
    "### Speech Act",
    "",
    ...formatCountMap(report.metrics.speechActProposals),
    "",
    "### Evidence Mode",
    "",
    ...formatCountMap(report.metrics.evidenceModeProposals),
    "",
    "### Advisor Action",
    "",
    ...formatCountMap(report.metrics.actionProposals),
    "",
    "## Runtime Budget And Terminal Boundaries",
    "",
    "### Budget Slots",
    "",
    ...formatCountMap(report.metrics.budgetSlots),
    "",
    "### Budget Reasons",
    "",
    ...formatCountMap(report.metrics.budgetReasons),
    "",
    "### Terminal No-answer Dispositions",
    "",
    ...formatCountMap(report.metrics.terminalNoAnswerDispositions),
    "",
    "### Terminal No-answer Apply Reasons",
    "",
    ...formatCountMap(report.metrics.terminalNoAnswerApplyReasons),
    "",
    "### Logical-question Boundaries",
    "",
    ...formatCountMap(report.metrics.logicalQuestionBoundaryReasons),
    "",
    "## Rollout Interpretation",
    "",
    "This report is Shadow evidence only for broad semantic repair and preserves its distinction from the narrow terminal no-answer runtime boundary. Terminal application, Advisor cancellation, and LQU boundary counts never increment repairApplied. Call rate is observational and must be interpreted through reason-coded trigger distributions; a high rate alone is not a failure. A correct LLM proposal is not counted as product success when it is stale, superseded, invalid, or arrives after a visible answer. No threshold, prototype, task boundary, model route, answer, Code artifact, or Whiteboard artifact is mutated by this reflection command.",
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

function selectLatestOperationDecisions(
  decisions: TaxonomyAdjudicationRecordedDecision[]
) {
  const latest = new Map<string, TaxonomyAdjudicationRecordedDecision>();
  for (const decision of [...decisions].sort(
    (left, right) => left.recordedAt - right.recordedAt
  )) {
    latest.set(buildDecisionSelectionKey(decision), decision);
  }
  return Array.from(latest.values()).sort(
    (left, right) => left.recordedAt - right.recordedAt
  );
}

function buildDecisionSelectionKey(
  decision: TaxonomyAdjudicationRecordedDecision
) {
  const sessionId = decision.sessionId ?? "unknown";
  const operationId =
    readString(decision.metadata, "taxonomyAdjudicationOperationId") ??
    readString(decision.metadata, "interviewerIntentLlmOperationId");
  if (operationId) return `${sessionId}:operation:${operationId}`;
  const unitId = readString(
    decision.metadata,
    "taxonomyAdjudicationUnitId"
  );
  const revision = readNumber(
    decision.metadata,
    "taxonomyAdjudicationUnitRevision"
  );
  return `${sessionId}:legacy:${unitId ?? decision.traceId}:${revision ?? 0}`;
}

function countOperationsByUnit(rows: TaxonomyAdjudicationReflectionRow[]) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.sessionId ?? "unknown"}:${row.unitId ?? row.traceId}:${row.unitRevision ?? 0}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function isSubstantiveObservedUnit(row: TaxonomyAdjudicationReflectionRow) {
  if (row.sourceOwnedSubstantive !== undefined) {
    return row.sourceOwnedSubstantive;
  }
  if (row.budgetSlot) {
    return row.budgetSlot === "substantive";
  }
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

function normalizeExpectedAction(value: string) {
  return value === "advise" ? "answer" : value;
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
