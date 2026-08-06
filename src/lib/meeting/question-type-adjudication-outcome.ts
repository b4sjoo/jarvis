import type {
  QuestionTypeAdjudicationOutcomeDisposition,
  QuestionTypeAdjudicationOutcomeEvent,
  QuestionTypeAdjudicationOutcomeStage,
} from "./question-type-adjudication.js";
import type { CanonicalQuestionType } from "./task-taxonomy.js";

export interface QuestionTypeAdjudicationRecordedDecision {
  recordedAt: number;
  sessionId?: string;
  runtimeEpoch?: number;
  traceId: string;
  taskId?: string;
  metadata: Record<string, unknown>;
}

export interface QuestionTypeAdjudicationOutcomeRow {
  operationId: string;
  sessionId?: string;
  runtimeEpoch?: number;
  traceId?: string;
  taskId?: string;
  logicalQuestionUnitId?: string;
  logicalQuestionUnitRevision?: number;
  proposedQuestionType?: CanonicalQuestionType;
  proposalValid: boolean;
  enforcementAuthorized: boolean;
  settlementApplied: boolean;
  advisorStarted: boolean;
  modelCompleted: boolean;
  deliveryPending: boolean;
  visibleCommitted: boolean;
  finalStage?: QuestionTypeAdjudicationOutcomeStage;
  finalDisposition?: QuestionTypeAdjudicationOutcomeDisposition;
  finalReason?: string;
  outcomeCount: number;
  identityMismatchCount: number;
}

export interface QuestionTypeAdjudicationOutcomeReport {
  version: 1;
  generatedAt: number;
  rows: QuestionTypeAdjudicationOutcomeRow[];
  metrics: {
    proposalOperations: number;
    validProposalOperations: number;
    enforcementAuthorized: number;
    settlementApplied: number;
    advisorStarted: number;
    modelCompleted: number;
    deliveryPending: number;
    visibleCommitted: number;
    deniedOrDropped: number;
    staleDropped: number;
    cancelled: number;
    errors: number;
    orphanOutcomes: number;
    identityMismatches: number;
  };
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
  for (const outcome of input.outcomes) {
    const existing = outcomesByOperation.get(outcome.operationId) ?? [];
    existing.push(outcome);
    outcomesByOperation.set(outcome.operationId, existing);
  }

  const rows = Array.from(decisionsByOperation.entries())
    .map(([operationId, decision]) => {
      const expectedIdentity = readDecisionIdentity(decision);
      const allOutcomes = outcomesByOperation.get(operationId) ?? [];
      const matchingOutcomes = allOutcomes
        .filter((outcome) => outcomeMatchesDecision(outcome, expectedIdentity))
        .sort((left, right) => left.recordedAt - right.recordedAt);
      const latest = matchingOutcomes.at(-1);
      return {
        operationId,
        sessionId: expectedIdentity.sessionId,
        runtimeEpoch: expectedIdentity.runtimeEpoch,
        traceId: decision.traceId,
        taskId: decision.taskId,
        logicalQuestionUnitId: expectedIdentity.logicalQuestionUnitId,
        logicalQuestionUnitRevision:
          expectedIdentity.logicalQuestionUnitRevision,
        proposedQuestionType: normalizeQuestionType(
          decision.metadata.questionTypeAdjudicationCandidateType
        ),
        proposalValid:
          decision.metadata.questionTypeAdjudicationParseValid === true,
        enforcementAuthorized:
          decision.metadata
            .questionTypeAdjudicationEnforcementAuthorized === true ||
          matchingOutcomes.some((outcome) => outcome.enforcementAuthorized),
        settlementApplied: matchingOutcomes.some(
          (outcome) => outcome.settlementApplied
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
        outcomeCount: matchingOutcomes.length,
        identityMismatchCount:
          allOutcomes.length - matchingOutcomes.length,
      } satisfies QuestionTypeAdjudicationOutcomeRow;
    })
    .sort((left, right) => left.operationId.localeCompare(right.operationId));

  const joinedOperationIds = new Set(decisionsByOperation.keys());
  const orphanOutcomes = input.outcomes.filter(
    (outcome) => !joinedOperationIds.has(outcome.operationId)
  ).length;
  const deniedOrDropped = rows.filter((row) =>
    isDeniedOrDropped(row.finalDisposition)
  ).length;

  return {
    version: 1,
    generatedAt: input.now ?? Date.now(),
    rows,
    metrics: {
      proposalOperations: rows.length,
      validProposalOperations: count(rows, (row) => row.proposalValid),
      enforcementAuthorized: count(
        rows,
        (row) => row.enforcementAuthorized
      ),
      settlementApplied: count(rows, (row) => row.settlementApplied),
      advisorStarted: count(rows, (row) => row.advisorStarted),
      modelCompleted: count(rows, (row) => row.modelCompleted),
      deliveryPending: count(rows, (row) => row.deliveryPending),
      visibleCommitted: count(rows, (row) => row.visibleCommitted),
      deniedOrDropped,
      staleDropped: count(
        rows,
        (row) => row.finalDisposition === "stale-dropped"
      ),
      cancelled: count(
        rows,
        (row) =>
          row.finalDisposition === "cancelled-by-new-job" ||
          row.finalDisposition === "cancelled-by-runtime-boundary"
      ),
      errors: count(rows, (row) => row.finalDisposition === "error"),
      orphanOutcomes,
      identityMismatches: rows.reduce(
        (total, row) => total + row.identityMismatchCount,
        0
      ),
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
    `- Settlement applied: ${metrics.settlementApplied}`,
    `- Advisor started: ${metrics.advisorStarted}`,
    `- Model completed: ${metrics.modelCompleted}`,
    `- Delivery pending: ${metrics.deliveryPending}`,
    `- Visible committed: ${metrics.visibleCommitted}`,
    "",
    "## Integrity",
    "",
    `- Denied or dropped: ${metrics.deniedOrDropped}`,
    `- Stale dropped: ${metrics.staleDropped}`,
    `- Cancelled: ${metrics.cancelled}`,
    `- Errors: ${metrics.errors}`,
    `- Orphan outcomes: ${metrics.orphanOutcomes}`,
    `- Identity mismatches: ${metrics.identityMismatches}`,
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function readDecisionIdentity(
  decision: QuestionTypeAdjudicationRecordedDecision
) {
  return {
    sessionId:
      decision.sessionId ??
      readString(decision.metadata.runtimeInferenceSessionId),
    logicalQuestionUnitId: readString(
      decision.metadata.questionTypeAdjudicationUnitId ??
        decision.metadata.logicalQuestionUnitId
    ),
    logicalQuestionUnitRevision: readNumber(
      decision.metadata.questionTypeAdjudicationUnitRevision ??
        decision.metadata.logicalQuestionUnitRevision
    ),
    runtimeEpoch: readNumber(
      decision.metadata.questionTypeAdjudicationRuntimeEpoch
    ),
  };
}

function outcomeMatchesDecision(
  outcome: QuestionTypeAdjudicationOutcomeEvent,
  identity: ReturnType<typeof readDecisionIdentity>
) {
  if (identity.sessionId && outcome.sessionId !== identity.sessionId) {
    return false;
  }
  if (
    identity.runtimeEpoch !== undefined &&
    outcome.runtimeEpoch !== identity.runtimeEpoch
  ) {
    return false;
  }
  if (
    identity.logicalQuestionUnitId &&
    outcome.logicalQuestionUnitId !== identity.logicalQuestionUnitId
  ) {
    return false;
  }
  if (
    identity.logicalQuestionUnitRevision !== undefined &&
    outcome.logicalQuestionUnitRevision !==
      identity.logicalQuestionUnitRevision
  ) {
    return false;
  }
  return true;
}

function isDeniedOrDropped(
  disposition: QuestionTypeAdjudicationOutcomeDisposition | undefined
) {
  return (
    disposition === "enforcement-denied" ||
    disposition === "suppressed" ||
    disposition === "stale-dropped" ||
    disposition === "cancelled-by-new-job" ||
    disposition === "cancelled-by-runtime-boundary" ||
    disposition === "error"
  );
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
