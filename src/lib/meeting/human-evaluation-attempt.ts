export interface HumanEvaluationAttemptIdentityV2 {
  attemptId: string;
  sessionId: string;
  settlementId: string;
  logicalQuestionUnitId: string;
  sourceHash: string;
}

export interface HumanEvaluationAttemptTraceLike {
  id: string;
  metadata?: Record<string, unknown>;
}

export interface HumanEvaluationAttemptSubjectLike {
  attemptId?: string;
  traceIds: string[];
}

export function resolveHumanEvaluationAttemptIdentityV2(
  trace: HumanEvaluationAttemptTraceLike
): HumanEvaluationAttemptIdentityV2 | undefined {
  const metadata = trace.metadata ?? {};
  const sessionId = readString(
    metadata.effectiveCurrentQuestionSettlementSessionId
  );
  const settlementId = readString(
    metadata.effectiveCurrentQuestionSettlementId
  );
  const logicalQuestionUnitId = readString(
    metadata.effectiveCurrentQuestionSettlementUnitId
  );
  const sourceHash = readString(
    metadata.effectiveCurrentQuestionSettlementSourceHash
  );
  if (!sessionId || !settlementId || !logicalQuestionUnitId || !sourceHash) {
    return undefined;
  }
  return {
    attemptId: trace.id,
    sessionId,
    settlementId,
    logicalQuestionUnitId,
    sourceHash,
  };
}

export function validateHumanEvaluationAttemptSubjectV2(input: {
  subject: HumanEvaluationAttemptSubjectLike;
  sourceTraceId?: string;
}) {
  const { attemptId } = input.subject;
  if (!attemptId) {
    return { valid: true } as const;
  }
  if (
    attemptId !== input.sourceTraceId ||
    !input.subject.traceIds.includes(attemptId)
  ) {
    return {
      valid: false,
      reason: "attempt-source-identity-mismatch",
    } as const;
  }
  return { valid: true } as const;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}
