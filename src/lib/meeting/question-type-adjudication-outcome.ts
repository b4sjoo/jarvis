import type {
  QuestionTypeAdjudicationOutcomeDisposition,
  QuestionTypeAdjudicationOutcomeEvent,
  QuestionTypeAdjudicationOutcomeStage,
} from "./question-type-adjudication.js";
import type { CanonicalQuestionType } from "./task-taxonomy.js";
import { normalizeCanonicalQuestionType } from "./task-taxonomy.js";
import type { HumanEvaluationProjectionV2, HumanGroundTruthEventV2 } from "./human-ground-truth-v2.js";

export interface QuestionTypeAdjudicationRecordedDecision {
  recordedAt: number;
  sessionId?: string;
  recordingSessionId?: string;
  runtimeSessionId?: string;
  runtimeEpoch?: number;
  traceId: string;
  taskId?: string;
  metadata: Record<string, unknown>;
}

export type QuestionTypeAdjudicationTerminalState =
  | "not-applied-shadow"
  | "not-applied-enforcement-denied"
  | "settlement-applied"
  | "advisor-started"
  | "model-completed"
  | "delivery-pending"
  | "visible-committed"
  | "suppressed"
  | "stale-dropped"
  | "cancelled"
  | "error"
  | "outcome-missing";

export interface QuestionTypeAdjudicationIdentityMismatch {
  operationId: string;
  outcomeId: string;
  stage: QuestionTypeAdjudicationOutcomeStage;
  field:
    | "recordingSessionId"
    | "runtimeSessionId"
    | "runtimeEpoch"
    | "logicalQuestionUnitId"
    | "logicalQuestionUnitRevision"
    | "originTraceId";
  expected: string | number;
  actual: string | number;
}

export interface QuestionTypeAdjudicationOutcomeRow {
  operationId: string;
  recordingSessionId?: string;
  runtimeSessionId?: string;
  runtimeEpoch?: number;
  traceId?: string;
  originTraceId?: string;
  taskId?: string;
  logicalQuestionUnitId?: string;
  logicalQuestionUnitRevision?: number;
  settlementOperationId?: string;
  settlementId?: string;
  outputAuthorityId?: string;
  advisorJobId?: string;
  visibleAnswerRevision?: number;
  proposedQuestionType?: CanonicalQuestionType;
  rawProposedQuestionType?: unknown;
  settledCurrentQuestionType?: CanonicalQuestionType;
  parentQuestionType?: CanonicalQuestionType;
  consumerQuestionType?: CanonicalQuestionType;
  proposalValid?: boolean;
  enforcementAuthorized?: boolean;
  settlementApplied?: boolean;
  appliedToResponse?: boolean;
  appliedToSettlement?: boolean;
  appliedToParent?: boolean;
  advisorStarted?: boolean;
  modelCompleted?: boolean;
  deliveryPending?: boolean;
  visibleCommitted?: boolean;
  finalStage?: QuestionTypeAdjudicationOutcomeStage;
  finalDisposition?: QuestionTypeAdjudicationOutcomeDisposition;
  finalReason?: string;
  terminalState: QuestionTypeAdjudicationTerminalState;
  joinedOrExplicitTerminal: boolean;
  outcomeCount: number;
  identityMismatchCount: number;
  terminalComplete: boolean;
  consumerTraceIds: string[];
  outcomeOriginTraceIds: string[];
  expectedQuestionType?: CanonicalQuestionType;
  typeCorrect?: boolean;
  settledTypeCorrect?: boolean;
  truthSubjectId?: string;
  truthEventIds: string[];
  truthDiagnostic: string;
}

export interface QuestionTypeAdjudicationOutcomeReport {
  version: 2;
  derivationVersion: "task152-offline-v3";
  metricContract: { candidateUnit: string; productUnit: string; exclusions: string[] };
  generatedAt: number;
  rows: QuestionTypeAdjudicationOutcomeRow[];
  metrics: {
    proposalOperations: number;
    validProposalOperations: number;
    enforcementAuthorized: number;
    settlementApplied: number;
    appliedToResponse: number;
    appliedToSettlement: number;
    appliedToParent: number;
    advisorStarted: number;
    modelCompleted: number;
    deliveryPending: number;
    visibleCommitted: number;
    deniedOrDropped: number;
    staleDropped: number;
    cancelled: number;
    errors: number;
    explicitNotApplied: number;
    joinedOrExplicitTerminal: number;
    joinCoverage: number | null;
    terminalCoverage: number | null;
    terminalComplete: number;
    labeledProposals: number;
    typePrecision: number | null;
    evaluatedSubjects: number;
    settledLabeledSubjects: number;
    settledTypePrecision: number | null;
    unmatchedProposals: number;
    unmatchedOutcomes: number;
    orphanOutcomes: number;
    identityMismatches: number;
  };
  integrity: {
    missingInputs?: string[];
    unmatchedProposalOperationIds: string[];
    unmatchedOutcomeIds: string[];
    firstIdentityMismatch?: QuestionTypeAdjudicationIdentityMismatch;
    diagnostics: Array<{ input: string; reason: string }>;
    duplicateOutcomes: number;
  };
}

interface DecisionIdentity {
  recordingSessionId?: string;
  runtimeSessionId?: string;
  runtimeEpoch?: number;
  logicalQuestionUnitId?: string;
  logicalQuestionUnitRevision?: number;
  originTraceId?: string;
}

export function buildQuestionTypeAdjudicationOutcomeReport(input: {
  decisions: QuestionTypeAdjudicationRecordedDecision[];
  outcomes: QuestionTypeAdjudicationOutcomeEvent[];
  settlements?: QuestionTypeAdjudicationRecordedDecision[];
  projections?: HumanEvaluationProjectionV2[];
  missingInputs?: string[];
  now?: number;
}): QuestionTypeAdjudicationOutcomeReport {
  const decisionsByOperation = new Map<
    string,
    QuestionTypeAdjudicationRecordedDecision
  >();
  for (const decision of input.decisions) {
    const operationId = readString(
      decision.metadata.questionTypeAdjudicationOperationId
    );
    if (!operationId) continue;
    const id = readOfflineDecisionIdentity(decision);
    const key = JSON.stringify([operationId, id.recordingSessionId, id.sessionId, id.epoch, id.unitId, id.revision, id.sourceTurnIdsHash ?? id.sourceHash ?? id.sourceTurnIds, id.originTraceId]);
    const current = decisionsByOperation.get(key);
    if (!current || current.recordedAt <= decision.recordedAt) {
      decisionsByOperation.set(key, decision);
    }
  }

  const uniqueOutcomes = deduplicateOutcomes(input.outcomes);
  const outcomeIdentities = new Map<string, number>();
  const outcomeKey = (outcome: QuestionTypeAdjudicationOutcomeEvent) => JSON.stringify([outcome.recordingSessionId, outcome.runtimeSessionId ?? outcome.sessionId, outcome.outcomeId]);
  for (const outcome of uniqueOutcomes) outcomeIdentities.set(outcomeKey(outcome), (outcomeIdentities.get(outcomeKey(outcome)) ?? 0) + 1);
  const joinedOutcomes = new Set<QuestionTypeAdjudicationOutcomeEvent>();
  const referencedOutcomes = new Set<QuestionTypeAdjudicationOutcomeEvent>();
  const diagnostics: Array<{ input: string; reason: string }> = input.decisions
    .filter(decision => !readString(decision.metadata.questionTypeAdjudicationOperationId))
    .map(decision => ({ input: decision.traceId, reason: "missing-operation-id" }));

  const mismatches: QuestionTypeAdjudicationIdentityMismatch[] = [];
  const rows = Array.from(decisionsByOperation.entries())
    .map(([, decision]) => {
      const operationId = readString(decision.metadata.questionTypeAdjudicationOperationId)!;
      const expectedIdentity = readDecisionIdentity(decision);
      const links = (input.settlements ?? []).filter(link =>
        link.metadata.runtimeSettlementTypeOperationId === operationId &&
        offlineIdentityMatches(decision, link)
      );
      const allOutcomes = uniqueOutcomes.filter(outcome => outcome.operationId === operationId || links.some(link =>
        link.metadata.runtimeSettlementOperationId === outcome.operationId &&
        readString(link.metadata.currentQuestionSettlementId) !== undefined &&
        link.metadata.currentQuestionSettlementId === outcome.settlementId
      ));
      const matchingOutcomes: QuestionTypeAdjudicationOutcomeEvent[] = [];
      for (const outcome of allOutcomes) {
        referencedOutcomes.add(outcome);
        if (outcomeIdentities.get(outcomeKey(outcome))! > 1) {
          diagnostics.push({ input: outcome.outcomeId, reason: "conflicting-outcome-id" });
          continue;
        }
        const owners = Array.from(decisionsByOperation.values()).filter(other => {
          const otherId = other.metadata.questionTypeAdjudicationOperationId;
          const otherLinks = (input.settlements ?? []).filter(link =>
            link.metadata.runtimeSettlementTypeOperationId === otherId &&
            link.metadata.runtimeSettlementOperationId === outcome.operationId &&
            link.metadata.currentQuestionSettlementId === outcome.settlementId &&
            offlineIdentityMatches(other, link));
          const references = otherId === outcome.operationId || otherLinks.length > 0;
          return references && !findIdentityMismatch(String(otherId), outcome, identityForLinkedOutcome(other, outcome, otherLinks));
        });
        if (owners.length > 1) {
          diagnostics.push({ input: outcome.outcomeId, reason: "ambiguous-proposal-identity" });
          continue;
        }
        const mismatch = findIdentityMismatch(
          operationId,
          outcome,
          identityForLinkedOutcome(decision, outcome, links)
        );
        if (mismatch) {
          mismatches.push(mismatch);
        } else {
          matchingOutcomes.push(outcome);
          joinedOutcomes.add(outcome);
        }
      }
      matchingOutcomes.sort((left, right) => left.recordedAt - right.recordedAt);
      const latest = matchingOutcomes.at(-1);
      const enforcementAuthorized = observedBoolean(matchingOutcomes, "enforcementAuthorized") ??
        readBoolean(decision.metadata.questionTypeAdjudicationEnforcementAuthorized);
      const terminalState = resolveTerminalState({
        decision,
        latest,
        enforcementAuthorized: enforcementAuthorized === true,
      });
      const joinedOrExplicitTerminal =
        matchingOutcomes.length > 0 ||
        terminalState === "not-applied-shadow" ||
        terminalState === "not-applied-enforcement-denied";
      const terminalComplete = matchingOutcomes.some(outcome => [
        "visible-committed", "suppressed", "stale-dropped", "cancelled-by-new-job",
        "cancelled-by-runtime-boundary", "error", "enforcement-denied",
      ].includes(outcome.disposition));
      const truth = resolveOfflineHumanTruth(decision, input.projections ?? [], links);
      const proposedQuestionType = normalizeQuestionType(decision.metadata.questionTypeAdjudicationCandidateType);
      const finalMetadata = [...links].sort((a, b) => b.recordedAt - a.recordedAt)[0]?.metadata ?? {};

      return {
        operationId,
        recordingSessionId: expectedIdentity.recordingSessionId,
        runtimeSessionId: expectedIdentity.runtimeSessionId,
        runtimeEpoch: expectedIdentity.runtimeEpoch,
        traceId: decision.traceId,
        originTraceId: expectedIdentity.originTraceId,
        taskId: decision.taskId,
        logicalQuestionUnitId: expectedIdentity.logicalQuestionUnitId,
        logicalQuestionUnitRevision:
          expectedIdentity.logicalQuestionUnitRevision,
        settlementOperationId: readLatestString(
          matchingOutcomes,
          "settlementOperationId"
        ),
        settlementId: readLatestString(matchingOutcomes, "settlementId"),
        outputAuthorityId: readLatestString(
          matchingOutcomes,
          "outputAuthorityId"
        ),
        advisorJobId: readLatestString(matchingOutcomes, "advisorJobId"),
        visibleAnswerRevision: readLatestNumber(
          matchingOutcomes,
          "visibleAnswerRevision"
        ),
        proposedQuestionType,
        rawProposedQuestionType: decision.metadata.questionTypeAdjudicationCandidateType,
        settledCurrentQuestionType: normalizeQuestionType(finalMetadata.effectiveCurrentQuestionSettlementQuestionType ?? finalMetadata.currentQuestionSettlementType),
        parentQuestionType: normalizeQuestionType(finalMetadata.currentQuestionSettlementParentAfterType),
        consumerQuestionType: normalizeQuestionType(finalMetadata.settledExecutionPlanQuestionType),
        proposalValid: readBoolean(decision.metadata.questionTypeAdjudicationParseValid),
        enforcementAuthorized,
        settlementApplied: observedBoolean(matchingOutcomes, "settlementApplied"),
        appliedToResponse: observedBoolean(matchingOutcomes, "appliedToResponse") ??
          (matchingOutcomes.some(outcome => outcome.schemaVersion === 1 && outcome.advisorStarted) ? true : undefined),
        appliedToSettlement: observedBoolean(matchingOutcomes, "appliedToSettlement") ??
          (matchingOutcomes.some(outcome => outcome.schemaVersion === 1 && outcome.settlementApplied) ? true : undefined),
        appliedToParent: observedBoolean(matchingOutcomes, "appliedToParent"),
        advisorStarted: observedBoolean(matchingOutcomes, "advisorStarted"),
        modelCompleted: observedBoolean(matchingOutcomes, "modelCompleted"),
        deliveryPending: observedBoolean(matchingOutcomes, "deliveryPending"),
        visibleCommitted: observedBoolean(matchingOutcomes, "visibleCommitted"),
        finalStage: latest?.stage,
        finalDisposition: latest?.disposition,
        finalReason: latest?.reason,
        terminalState,
        joinedOrExplicitTerminal,
        outcomeCount: matchingOutcomes.length,
        identityMismatchCount:
          allOutcomes.length - matchingOutcomes.length,
        terminalComplete,
        consumerTraceIds: [...new Set(matchingOutcomes.map(outcome => outcome.traceId))],
        outcomeOriginTraceIds: [...new Set(matchingOutcomes.map(outcome => outcome.originTraceId ?? outcome.traceId))],
        expectedQuestionType: truth.expectedQuestionType,
        typeCorrect: truth.expectedQuestionType && truth.expectedQuestionType !== "unknown" && proposedQuestionType && proposedQuestionType !== "unknown" && decision.metadata.questionTypeAdjudicationParseValid !== false
          ? truth.expectedQuestionType === proposedQuestionType : undefined,
        settledTypeCorrect: truth.expectedQuestionType && normalizeQuestionType(finalMetadata.effectiveCurrentQuestionSettlementQuestionType ?? finalMetadata.currentQuestionSettlementType)
          ? truth.expectedQuestionType === normalizeQuestionType(finalMetadata.effectiveCurrentQuestionSettlementQuestionType ?? finalMetadata.currentQuestionSettlementType) : undefined,
        truthSubjectId: truth.subjectId,
        truthEventIds: truth.eventIds,
        truthDiagnostic: truth.diagnostic,
      } satisfies QuestionTypeAdjudicationOutcomeRow;
    })
    .sort((left, right) => left.operationId.localeCompare(right.operationId));

  const unmatchedOutcomeEvents = uniqueOutcomes.filter(outcome => !joinedOutcomes.has(outcome));
  const unmatchedProposalRows = rows.filter(
    (row) => !row.joinedOrExplicitTerminal
  );
  const deniedOrDropped = rows.filter((row) =>
    isDeniedOrDropped(row.finalDisposition, row.terminalState)
  ).length;
  const joinedOrExplicitTerminal = count(
    rows,
    (row) => row.joinedOrExplicitTerminal
  );
  const settledSubjects = [...new Map(rows.filter(row => row.truthSubjectId && row.settledTypeCorrect !== undefined).map(row => [row.truthSubjectId, row])).values()];

  return {
    version: 2,
    derivationVersion: "task152-offline-v3",
    metricContract: { candidateUnit: "Type operation with exact recorded identity", productUnit: "confirmed human attempt/source subject", exclusions: ["Missing or conflicting identity/truth is unscored", "Release-only is joined but not terminal-complete", "Unknown application is not false"] },
    generatedAt: input.now ?? Date.now(),
    rows,
    metrics: {
      proposalOperations: rows.length,
      validProposalOperations: count(rows, (row) => row.proposalValid === true),
      enforcementAuthorized: count(rows, (row) => row.enforcementAuthorized === true),
      settlementApplied: count(rows, (row) => row.settlementApplied === true),
      appliedToResponse: count(rows, (row) => row.appliedToResponse === true),
      appliedToSettlement: count(rows, (row) => row.appliedToSettlement === true),
      appliedToParent: count(rows, (row) => row.appliedToParent === true),
      advisorStarted: count(rows, (row) => row.advisorStarted === true),
      modelCompleted: count(rows, (row) => row.modelCompleted === true),
      deliveryPending: count(rows, (row) => row.deliveryPending === true),
      visibleCommitted: count(rows, (row) => row.visibleCommitted === true),
      deniedOrDropped,
      staleDropped: count(
        rows,
        (row) => row.terminalState === "stale-dropped"
      ),
      cancelled: count(rows, (row) => row.terminalState === "cancelled"),
      errors: count(rows, (row) => row.terminalState === "error"),
      explicitNotApplied: count(
        rows,
        (row) =>
          row.terminalState === "not-applied-shadow" ||
          row.terminalState === "not-applied-enforcement-denied"
      ),
      joinedOrExplicitTerminal,
      joinCoverage:
        rows.length === 0 ? null : count(rows, row => row.outcomeCount > 0) / rows.length,
      terminalCoverage: rows.length ? count(rows, row => row.terminalComplete) / rows.length : null,
      terminalComplete: count(rows, row => row.terminalComplete),
      labeledProposals: count(rows, row => row.typeCorrect !== undefined),
      typePrecision: rows.some(row => row.typeCorrect !== undefined)
        ? count(rows, row => row.typeCorrect === true) / count(rows, row => row.typeCorrect !== undefined) : null,
      evaluatedSubjects: new Set(rows.map(row => row.truthSubjectId).filter(Boolean)).size,
      settledLabeledSubjects: settledSubjects.length,
      settledTypePrecision: settledSubjects.length ? count(settledSubjects, row => row.settledTypeCorrect === true) / settledSubjects.length : null,
      unmatchedProposals: unmatchedProposalRows.length,
      unmatchedOutcomes: unmatchedOutcomeEvents.length,
      orphanOutcomes: uniqueOutcomes.filter(outcome => !referencedOutcomes.has(outcome)).length,
      identityMismatches: mismatches.length,
    },
    integrity: {
      missingInputs: input.missingInputs,
      unmatchedProposalOperationIds: unmatchedProposalRows.map(
        (row) => row.operationId
      ),
      unmatchedOutcomeIds: unmatchedOutcomeEvents.map(
        (outcome) => outcome.outcomeId
      ),
      firstIdentityMismatch: mismatches[0],
      duplicateOutcomes: input.outcomes.length - uniqueOutcomes.length,
      diagnostics: [...diagnostics, ...unmatchedOutcomeEvents.map(outcome => ({ input: outcome.outcomeId, reason: "unresolved-outcome-identity-or-link" })), ...rows.filter(row => row.rawProposedQuestionType !== undefined && !row.proposedQuestionType).map(row => ({ input: row.operationId, reason: `unsupported-question-type:${String(row.rawProposedQuestionType)}` }))],
    },
  };
}

export function renderQuestionTypeAdjudicationOutcomeMarkdown(
  report: QuestionTypeAdjudicationOutcomeReport
) {
  const metrics = report.metrics;
  const lines = [
    "# Question Type Adjudication Outcomes",
    "",
    `Generated: ${new Date(report.generatedAt).toISOString()}`,
    "",
    "## Funnel",
    "",
    `- Proposal operations: ${metrics.proposalOperations}`,
    `- Valid proposals: ${metrics.validProposalOperations}`,
    `- Enforcement authorized: ${metrics.enforcementAuthorized}`,
    `- Applied to response: ${metrics.appliedToResponse}`,
    `- Applied to settlement: ${metrics.appliedToSettlement}`,
    `- Applied to parent: ${metrics.appliedToParent}`,
    `- Advisor started: ${metrics.advisorStarted}`,
    `- Model completed: ${metrics.modelCompleted}`,
    `- Delivery pending: ${metrics.deliveryPending}`,
    `- Visible committed: ${metrics.visibleCommitted}`,
    "",
    "## Integrity",
    "",
    `- Joined or explicit terminal: ${metrics.joinedOrExplicitTerminal}`,
    `- Join coverage: ${metrics.joinCoverage === null ? "N/A" : `${(metrics.joinCoverage * 100).toFixed(1)}%`}`,
    `- Terminal coverage: ${metrics.terminalCoverage === null ? "N/A" : `${(metrics.terminalCoverage * 100).toFixed(1)}%`}`,
    `- Explicit not applied: ${metrics.explicitNotApplied}`,
    `- Denied or dropped: ${metrics.deniedOrDropped}`,
    `- Stale dropped: ${metrics.staleDropped}`,
    `- Cancelled: ${metrics.cancelled}`,
    `- Errors: ${metrics.errors}`,
    `- Unmatched proposals: ${metrics.unmatchedProposals}`,
    `- Unmatched outcomes: ${metrics.unmatchedOutcomes}`,
    `- Identity mismatches: ${metrics.identityMismatches}`,
  ];
  if (report.integrity.firstIdentityMismatch) {
    const mismatch = report.integrity.firstIdentityMismatch;
    lines.push(
      "",
      "## First Identity Mismatch",
      "",
      `- Operation: ${mismatch.operationId}`,
      `- Outcome: ${mismatch.outcomeId}`,
      `- Field: ${mismatch.field}`,
      `- Expected: ${String(mismatch.expected)}`,
      `- Actual: ${String(mismatch.actual)}`
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function readDecisionIdentity(
  decision: QuestionTypeAdjudicationRecordedDecision
): DecisionIdentity {
  const recordingSessionId =
    decision.recordingSessionId ??
    (isRecordingSessionId(decision.sessionId)
      ? decision.sessionId
      : undefined);
  const runtimeSessionId =
    decision.runtimeSessionId ??
    readString(decision.metadata.questionTypeAdjudicationRuntimeSessionId) ??
    readString(decision.metadata.currentQuestionSessionId) ??
    readString(decision.metadata.currentQuestionSettlementSessionId) ??
    readString(decision.metadata.runtimeInferenceCircuitSessionId) ??
    (!recordingSessionId ? decision.sessionId : undefined);
  return {
    recordingSessionId,
    runtimeSessionId,
    logicalQuestionUnitId: readString(
      decision.metadata.questionTypeAdjudicationUnitId ??
        decision.metadata.logicalQuestionUnitId
    ),
    logicalQuestionUnitRevision: readNumber(
      decision.metadata.questionTypeAdjudicationUnitRevision ??
        decision.metadata.logicalQuestionUnitRevision
    ),
    runtimeEpoch:
      decision.runtimeEpoch ??
      readNumber(decision.metadata.questionTypeAdjudicationRuntimeEpoch),
    originTraceId:
      readString(decision.metadata.questionTypeAdjudicationOriginTraceId) ??
      decision.traceId,
  };
}

function findIdentityMismatch(
  operationId: string,
  outcome: QuestionTypeAdjudicationOutcomeEvent,
  identity: DecisionIdentity
): QuestionTypeAdjudicationIdentityMismatch | undefined {
  const checks: Array<{
    field: QuestionTypeAdjudicationIdentityMismatch["field"];
    expected: string | number | undefined;
    actual: string | number | undefined;
  }> = [
    {
      field: "recordingSessionId",
      expected: identity.recordingSessionId,
      actual: outcome.recordingSessionId,
    },
    {
      field: "runtimeSessionId",
      expected: identity.runtimeSessionId,
      actual: outcome.runtimeSessionId ?? outcome.sessionId,
    },
    {
      field: "runtimeEpoch",
      expected: identity.runtimeEpoch,
      actual: outcome.runtimeEpoch,
    },
    {
      field: "logicalQuestionUnitId",
      expected: identity.logicalQuestionUnitId,
      actual: outcome.logicalQuestionUnitId,
    },
    {
      field: "logicalQuestionUnitRevision",
      expected: identity.logicalQuestionUnitRevision,
      actual: outcome.logicalQuestionUnitRevision,
    },
    {
      field: "originTraceId",
      expected: identity.originTraceId,
      actual: outcome.originTraceId ?? outcome.traceId,
    },
  ];
  const mismatch = checks.find(check =>
    check.field === "recordingSessionId" && (check.expected === undefined || (outcome.schemaVersion === 1 && check.actual === undefined))
      ? false : check.expected === undefined || check.actual === undefined || check.expected !== check.actual);
  if (!mismatch) {
    return undefined;
  }
  return {
    operationId,
    outcomeId: outcome.outcomeId,
    stage: outcome.stage,
    field: mismatch.field,
    expected: mismatch.expected ?? "missing",
    actual: mismatch.actual ?? "missing",
  };
}

function identityForLinkedOutcome(
  decision: QuestionTypeAdjudicationRecordedDecision,
  outcome: QuestionTypeAdjudicationOutcomeEvent,
  verifiedLinks: QuestionTypeAdjudicationRecordedDecision[]
) {
  const identity = readDecisionIdentity(decision);
  const origin = outcome.originTraceId ?? outcome.traceId;
  if (verifiedLinks.some(link => link.traceId === origin &&
    link.metadata.currentQuestionSettlementId === outcome.settlementId &&
    link.metadata.runtimeSettlementOperationId === outcome.operationId)) {
    return { ...identity, originTraceId: origin };
  }
  return identity;
}

function resolveTerminalState(input: {
  decision: QuestionTypeAdjudicationRecordedDecision;
  latest?: QuestionTypeAdjudicationOutcomeEvent;
  enforcementAuthorized: boolean;
}): QuestionTypeAdjudicationTerminalState {
  if (!input.latest) {
    return "outcome-missing";
  }
  switch (input.latest.disposition) {
    case "visible-committed":
      return "visible-committed";
    case "delivery-pending":
      return "delivery-pending";
    case "model-completed":
      return "model-completed";
    case "advisor-started":
      return "advisor-started";
    case "settlement-applied":
      return "settlement-applied";
    case "enforcement-denied":
      return "not-applied-enforcement-denied";
    case "suppressed":
      return "suppressed";
    case "stale-dropped":
      return "stale-dropped";
    case "cancelled-by-new-job":
    case "cancelled-by-runtime-boundary":
      return "cancelled";
    case "error":
      return "error";
  }
}

function isDeniedOrDropped(
  disposition: QuestionTypeAdjudicationOutcomeDisposition | undefined,
  terminalState: QuestionTypeAdjudicationTerminalState
) {
  return (
    terminalState === "not-applied-enforcement-denied" ||
    disposition === "suppressed" ||
    disposition === "stale-dropped" ||
    disposition === "cancelled-by-new-job" ||
    disposition === "cancelled-by-runtime-boundary" ||
    disposition === "error"
  );
}

function deduplicateOutcomes(outcomes: QuestionTypeAdjudicationOutcomeEvent[]) {
  const byId = new Map<string, QuestionTypeAdjudicationOutcomeEvent>();
  for (const outcome of outcomes) {
    byId.set(JSON.stringify(outcome), outcome);
  }
  return Array.from(byId.values());
}

function readLatestString<
  K extends keyof QuestionTypeAdjudicationOutcomeEvent,
>(outcomes: QuestionTypeAdjudicationOutcomeEvent[], key: K) {
  for (let index = outcomes.length - 1; index >= 0; index -= 1) {
    const value = outcomes[index]?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function readLatestNumber<
  K extends keyof QuestionTypeAdjudicationOutcomeEvent,
>(outcomes: QuestionTypeAdjudicationOutcomeEvent[], key: K) {
  for (let index = outcomes.length - 1; index >= 0; index -= 1) {
    const value = outcomes[index]?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function isRecordingSessionId(value: string | undefined) {
  return value?.startsWith("session_recording_") === true;
}

function normalizeQuestionType(
  value: unknown
): CanonicalQuestionType | undefined {
  return normalizeCanonicalQuestionType(value);
}

function readBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function observedBoolean(outcomes: QuestionTypeAdjudicationOutcomeEvent[], key: keyof QuestionTypeAdjudicationOutcomeEvent) {
  const values = outcomes.map(outcome => outcome[key]).filter(value => typeof value === "boolean");
  return values.length ? values.some(value => value === true) : undefined;
}

// These are recorded identity aliases, not an inference or nearest-trace join.
export function readOfflineDecisionIdentity(decision: QuestionTypeAdjudicationRecordedDecision) {
  const m = decision.metadata;
  const read = (...keys: string[]) => keys.map(key => m[key]).find(value => value !== undefined);
  return {
    recordingSessionId: decision.recordingSessionId ?? (isRecordingSessionId(decision.sessionId) ? decision.sessionId : undefined),
    sessionId: decision.runtimeSessionId ?? read("questionTypeAdjudicationRuntimeSessionId", "currentQuestionSessionId", "currentQuestionSettlementSessionId", "effectiveCurrentQuestionSettlementSessionId") ?? (!isRecordingSessionId(decision.sessionId) ? decision.sessionId : undefined),
    epoch: decision.runtimeEpoch ?? read("questionTypeAdjudicationRuntimeEpoch", "currentQuestionRuntimeEpoch", "currentQuestionSettlementRuntimeEpoch"),
    unitId: read("questionTypeAdjudicationUnitId", "taskRelationAdjudicationUnitId", "currentQuestionUnitId", "currentQuestionSettlementUnitId", "logicalQuestionUnitId"),
    revision: read("questionTypeAdjudicationUnitRevision", "taskRelationAdjudicationUnitRevision", "currentQuestionRevision", "currentQuestionSettlementRevision", "logicalQuestionUnitRevision"),
    sourceHash: read("currentQuestionSourceHash", "taskRelationAdjudicationSourceHash", "currentQuestionSettlementSourceHash", "effectiveCurrentQuestionSettlementSourceHash"),
    sourceTurnIds: read("currentQuestionSourceTurnIds", "currentQuestionSettlementSourceTurnIds", "effectiveCurrentQuestionSettlementSourceTurnIds"),
    sourceTurnIdsHash: m.questionTypeAdjudicationSourceTurnIdsHash,
    originTraceId: read("questionTypeAdjudicationOriginTraceId") ?? decision.traceId,
  };
}

export function offlineIdentityMatches(left: QuestionTypeAdjudicationRecordedDecision, right: QuestionTypeAdjudicationRecordedDecision) {
  const a = readOfflineDecisionIdentity(left);
  const b = readOfflineDecisionIdentity(right);
  for (const key of ["sessionId", "epoch", "unitId", "revision"] as const) {
    if (a[key] === undefined || b[key] === undefined || a[key] !== b[key]) return false;
  }
  if (a.sourceHash !== undefined || b.sourceHash !== undefined) {
    // Type-only records may carry only their source-turn hash; the link must preserve it.
    if (a.sourceHash !== b.sourceHash && !(a.sourceHash === undefined && a.sourceTurnIdsHash !== undefined && a.sourceTurnIdsHash === b.sourceTurnIdsHash)) return false;
  } else if (!(a.sourceTurnIdsHash !== undefined && a.sourceTurnIdsHash === b.sourceTurnIdsHash) && !sameSources(a.sourceTurnIds, b.sourceTurnIds)) return false;
  for (const key of ["recordingSessionId", "sourceTurnIdsHash"] as const) {
    if ((a[key] !== undefined || b[key] !== undefined) && a[key] !== b[key]) return false;
  }
  if (a.sourceTurnIds !== undefined && b.sourceTurnIds !== undefined && !sameSources(a.sourceTurnIds, b.sourceTurnIds)) return false;
  // A copied Type identity cannot hide a contradictory current-source identity.
  for (const record of [left, right]) {
    const m = record.metadata;
    const id = readOfflineDecisionIdentity(record);
    const aliases = { currentQuestionSessionId: id.sessionId, currentQuestionRuntimeEpoch: id.epoch,
      currentQuestionUnitId: id.unitId, currentQuestionRevision: id.revision,
      taskRelationAdjudicationUnitId: id.unitId, taskRelationAdjudicationUnitRevision: id.revision };
    for (const [key, expected] of Object.entries(aliases)) {
      if (m[key] !== undefined && m[key] !== expected) return false;
    }
  }
  return true;
}

export function resolveOfflineHumanTruth(
  decision: QuestionTypeAdjudicationRecordedDecision,
  projections: HumanEvaluationProjectionV2[],
  linkedDecisions: QuestionTypeAdjudicationRecordedDecision[] = []
) {
  const evidence = [decision, ...linkedDecisions.filter(link => offlineIdentityMatches(decision, link))]
    .filter(record => offlineIdentityMatches(record, record));
  const matches = projections.filter(projection => evidence.some(record => {
    const id = readOfflineDecisionIdentity(record);
    return projection.sessionId === id.sessionId &&
      projection.subject.attemptId === record.traceId &&
      projection.subject.traceIds.includes(record.traceId) &&
      sameSources(projection.subject.sourceTurnIds, id.sourceTurnIds);
  }));
  const subjects = new Set(matches.map(p => `${p.sessionId}:${p.subject.attemptId}:${JSON.stringify([...new Set(p.subject.sourceTurnIds)].sort())}`));
  const empty = { eventIds: [] as string[], diagnostic: "missing-confirmed-human-truth" };
  if (subjects.size > 1) return { ...empty, diagnostic: "ambiguous-human-subject" };
  const facts = new Map<string, HumanGroundTruthEventV2>();
  for (const projection of matches) {
    if (projection.conflicts.some(conflict => ["expected-question-type", "expected-task-settlement"].includes(conflict.factKind))) {
      return { ...empty, diagnostic: "conflicting-human-truth" };
    }
    for (const kind of ["expected-question-type", "expected-task-settlement"] as const) {
      const event = projection.activeFacts[kind];
      if (!event || event.confirmation !== "confirmed") continue;
      const target = event.provenance.evaluationTarget;
      const valid = evidence.some(record => {
        const id = readOfflineDecisionIdentity(record);
        return event.sessionId === id.sessionId && event.subject.attemptId === record.traceId &&
          event.subject.traceIds.includes(record.traceId) && sameSources(event.subject.sourceTurnIds, id.sourceTurnIds) &&
          (event.provenance.sourceTraceId === undefined || event.provenance.sourceTraceId === record.traceId) &&
          (target && ((target.attemptId === undefined || target.attemptId === record.traceId) &&
            (target.sourceTraceId === undefined || target.sourceTraceId === record.traceId) &&
            target.logicalQuestionUnitId !== undefined && target.logicalQuestionUnitId === id.unitId &&
            target.logicalQuestionUnitRevision !== undefined && target.logicalQuestionUnitRevision === id.revision &&
            sameSources(target.sourceTurnIds, id.sourceTurnIds)));
      });
      if (valid) {
        const existing = facts.get(event.eventId);
        if (existing && JSON.stringify(existing.fact) !== JSON.stringify(event.fact)) return { ...empty, diagnostic: "conflicting-human-event-id" };
        facts.set(event.eventId, event);
      }
    }
  }
  const values = [...facts.values()];
  const types = new Set(values.map(event => "expectedQuestionType" in event.fact ? event.fact.expectedQuestionType : undefined));
  if (types.size > 1) return { ...empty, diagnostic: "conflicting-human-truth" };
  const settlement = values.find(event => event.fact.kind === "expected-task-settlement")?.fact;
  return {
    expectedQuestionType: normalizeQuestionType([...types][0]),
    expectedRelation: settlement?.kind === "expected-task-settlement" ? settlement.expectedRelation : undefined,
    expectedParentAction: settlement?.kind === "expected-task-settlement" ? settlement.expectedParentAction : undefined,
    expectedParentId: settlement?.kind === "expected-task-settlement" ? settlement.expectedParentId : undefined,
    expectedBranchId: settlement?.kind === "expected-task-settlement" ? settlement.expectedBranchId : undefined,
    expectedContextOwnerId: settlement?.kind === "expected-task-settlement" ? settlement.expectedContextOwnerId : undefined,
    subjectId: values.length ? [...subjects][0] : undefined,
    eventIds: values.map(event => event.eventId),
    diagnostic: values.length ? "confirmed-human-truth" : empty.diagnostic,
  };
}

function sameSources(left: unknown, right: unknown) {
  return Array.isArray(left) && left.length > 0 && Array.isArray(right) &&
    JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function count<T>(values: T[], predicate: (value: T) => boolean) {
  return values.filter(predicate).length;
}
