import type {
  QuestionTypeAdjudicationOutcomeDisposition,
  QuestionTypeAdjudicationOutcomeEvent,
  QuestionTypeAdjudicationOutcomeStage,
} from "./question-type-adjudication.js";
import type { CanonicalQuestionType } from "./task-taxonomy.js";

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
  proposalValid: boolean;
  enforcementAuthorized: boolean;
  settlementApplied: boolean;
  appliedToResponse: boolean;
  appliedToSettlement: boolean;
  appliedToParent: boolean;
  advisorStarted: boolean;
  modelCompleted: boolean;
  deliveryPending: boolean;
  visibleCommitted: boolean;
  finalStage?: QuestionTypeAdjudicationOutcomeStage;
  finalDisposition?: QuestionTypeAdjudicationOutcomeDisposition;
  finalReason?: string;
  terminalState: QuestionTypeAdjudicationTerminalState;
  joinedOrExplicitTerminal: boolean;
  outcomeCount: number;
  identityMismatchCount: number;
}

export interface QuestionTypeAdjudicationOutcomeReport {
  version: 2;
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
    joinCoverage: number;
    unmatchedProposals: number;
    unmatchedOutcomes: number;
    orphanOutcomes: number;
    identityMismatches: number;
  };
  integrity: {
    unmatchedProposalOperationIds: string[];
    unmatchedOutcomeIds: string[];
    firstIdentityMismatch?: QuestionTypeAdjudicationIdentityMismatch;
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
    const current = decisionsByOperation.get(operationId);
    if (!current || current.recordedAt <= decision.recordedAt) {
      decisionsByOperation.set(operationId, decision);
    }
  }

  const outcomesByOperation = new Map<
    string,
    QuestionTypeAdjudicationOutcomeEvent[]
  >();
  for (const outcome of deduplicateOutcomes(input.outcomes)) {
    const existing = outcomesByOperation.get(outcome.operationId) ?? [];
    existing.push(outcome);
    outcomesByOperation.set(outcome.operationId, existing);
  }

  const mismatches: QuestionTypeAdjudicationIdentityMismatch[] = [];
  const rows = Array.from(decisionsByOperation.entries())
    .map(([operationId, decision]) => {
      const expectedIdentity = readDecisionIdentity(decision);
      const allOutcomes = outcomesByOperation.get(operationId) ?? [];
      const matchingOutcomes: QuestionTypeAdjudicationOutcomeEvent[] = [];
      for (const outcome of allOutcomes) {
        const mismatch = findIdentityMismatch(
          operationId,
          outcome,
          expectedIdentity
        );
        if (mismatch) {
          mismatches.push(mismatch);
        } else {
          matchingOutcomes.push(outcome);
        }
      }
      matchingOutcomes.sort((left, right) => left.recordedAt - right.recordedAt);
      const latest = matchingOutcomes.at(-1);
      const enforcementAuthorized =
        decision.metadata.questionTypeAdjudicationEnforcementAuthorized ===
          true ||
        matchingOutcomes.some((outcome) => outcome.enforcementAuthorized);
      const terminalState = resolveTerminalState({
        decision,
        latest,
        enforcementAuthorized,
      });
      const joinedOrExplicitTerminal =
        matchingOutcomes.length > 0 ||
        terminalState === "not-applied-shadow" ||
        terminalState === "not-applied-enforcement-denied";

      return {
        operationId,
        recordingSessionId: expectedIdentity.recordingSessionId,
        runtimeSessionId: expectedIdentity.runtimeSessionId,
        runtimeEpoch: expectedIdentity.runtimeEpoch,
        traceId: decision.traceId,
        originTraceId:
          readLatestString(matchingOutcomes, "originTraceId") ??
          expectedIdentity.originTraceId,
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
        proposedQuestionType: normalizeQuestionType(
          decision.metadata.questionTypeAdjudicationCandidateType
        ),
        proposalValid:
          decision.metadata.questionTypeAdjudicationParseValid === true,
        enforcementAuthorized,
        settlementApplied: matchingOutcomes.some(
          (outcome) => outcome.settlementApplied
        ),
        appliedToResponse: matchingOutcomes.some(
          (outcome) =>
            outcome.appliedToResponse === true ||
            (outcome.schemaVersion === 1 && outcome.advisorStarted === true)
        ),
        appliedToSettlement: matchingOutcomes.some(
          (outcome) =>
            outcome.appliedToSettlement === true ||
            outcome.settlementApplied === true
        ),
        appliedToParent: matchingOutcomes.some(
          (outcome) => outcome.appliedToParent === true
        ),
        advisorStarted: matchingOutcomes.some(
          (outcome) => outcome.advisorStarted
        ),
        modelCompleted: matchingOutcomes.some(
          (outcome) => outcome.modelCompleted
        ),
        deliveryPending: matchingOutcomes.some(
          (outcome) => outcome.deliveryPending
        ),
        visibleCommitted: matchingOutcomes.some(
          (outcome) => outcome.visibleCommitted
        ),
        finalStage: latest?.stage,
        finalDisposition: latest?.disposition,
        finalReason: latest?.reason,
        terminalState,
        joinedOrExplicitTerminal,
        outcomeCount: matchingOutcomes.length,
        identityMismatchCount:
          allOutcomes.length - matchingOutcomes.length,
      } satisfies QuestionTypeAdjudicationOutcomeRow;
    })
    .sort((left, right) => left.operationId.localeCompare(right.operationId));

  const joinedOperationIds = new Set(decisionsByOperation.keys());
  const unmatchedOutcomeEvents = input.outcomes.filter(
    (outcome) => !joinedOperationIds.has(outcome.operationId)
  );
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

  return {
    version: 2,
    generatedAt: input.now ?? Date.now(),
    rows,
    metrics: {
      proposalOperations: rows.length,
      validProposalOperations: count(rows, (row) => row.proposalValid),
      enforcementAuthorized: count(rows, (row) => row.enforcementAuthorized),
      settlementApplied: count(rows, (row) => row.settlementApplied),
      appliedToResponse: count(rows, (row) => row.appliedToResponse),
      appliedToSettlement: count(rows, (row) => row.appliedToSettlement),
      appliedToParent: count(rows, (row) => row.appliedToParent),
      advisorStarted: count(rows, (row) => row.advisorStarted),
      modelCompleted: count(rows, (row) => row.modelCompleted),
      deliveryPending: count(rows, (row) => row.deliveryPending),
      visibleCommitted: count(rows, (row) => row.visibleCommitted),
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
        rows.length === 0 ? 1 : joinedOrExplicitTerminal / rows.length,
      unmatchedProposals: unmatchedProposalRows.length,
      unmatchedOutcomes: unmatchedOutcomeEvents.length,
      orphanOutcomes: unmatchedOutcomeEvents.length,
      identityMismatches: mismatches.length,
    },
    integrity: {
      unmatchedProposalOperationIds: unmatchedProposalRows.map(
        (row) => row.operationId
      ),
      unmatchedOutcomeIds: unmatchedOutcomeEvents.map(
        (outcome) => outcome.outcomeId
      ),
      firstIdentityMismatch: mismatches[0],
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
    `- Join coverage: ${(metrics.joinCoverage * 100).toFixed(1)}%`,
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
  const mismatch = checks.find(
    (check) =>
      check.expected !== undefined &&
      check.actual !== undefined &&
      check.expected !== check.actual
  );
  if (!mismatch || mismatch.expected === undefined || mismatch.actual === undefined) {
    return undefined;
  }
  return {
    operationId,
    outcomeId: outcome.outcomeId,
    stage: outcome.stage,
    field: mismatch.field,
    expected: mismatch.expected,
    actual: mismatch.actual,
  };
}

function resolveTerminalState(input: {
  decision: QuestionTypeAdjudicationRecordedDecision;
  latest?: QuestionTypeAdjudicationOutcomeEvent;
  enforcementAuthorized: boolean;
}): QuestionTypeAdjudicationTerminalState {
  if (!input.latest) {
    if (input.enforcementAuthorized) return "outcome-missing";
    return readString(input.decision.metadata.questionTypeAdjudicationMode) ===
      "shadow"
      ? "not-applied-shadow"
      : "not-applied-enforcement-denied";
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
    byId.set(outcome.outcomeId, outcome);
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
  return typeof value === "string" &&
    [
      "behavioral",
      "coding",
      "general-system-design",
      "ai-ml-system-design",
      "project-deep-dive",
      "field-knowledge",
      "unknown",
    ].includes(value)
    ? (value as CanonicalQuestionType)
    : undefined;
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
