export type ObservedAdvisorRuntimeAction =
  | "advise"
  | "append-context"
  | "buffer"
  | "ignore";

export type ObservedAdvisorOutcome =
  | "suppressed"
  | "model-completed"
  | "delivery-pending"
  | "visible-committed"
  | "stale-dropped"
  | "cancelled-by-new-job"
  | "cancelled-by-runtime-boundary"
  | "error";

export interface ObservedAdvisorAttemptProjection {
  runtimeAction?: ObservedAdvisorRuntimeAction;
  outcome?: ObservedAdvisorOutcome;
  answerCommitted?: boolean;
  candidateFormed: boolean;
  modelExecuted: boolean;
}

/**
 * Projects evaluation facts from final generation/publication metadata. An
 * execution authorization alone is intentionally not an observed action.
 */
export function projectObservedAdvisorAttempt(
  metadata: Record<string, unknown>
): ObservedAdvisorAttemptProjection {
  const advisorVisible = readBoolean(metadata.advisorOutputCommittedToUi);
  const screenVisible = readBoolean(metadata.screenOutputCommittedToUi);
  const visibleRevisionBefore = readNumber(metadata.visibleAnswerRevisionBefore);
  const visibleRevisionAfter = readNumber(metadata.visibleAnswerRevisionAfter);
  const visibleRevisionGrew = Boolean(
    visibleRevisionBefore !== undefined &&
      visibleRevisionAfter !== undefined &&
      visibleRevisionAfter > visibleRevisionBefore
  );
  const commitDisposition = readString(
    metadata.generationResultCommitDisposition
  );
  const projectionDisposition = readString(
    metadata.generationResultProjectionDisposition
  );
  const outputDisposition = readString(metadata.advisorOutputDisposition);
  const terminalDisposition = readString(
    metadata.generationResultTerminalDisposition
  );
  const candidateValidation = readString(
    metadata.generationResultCandidateValidation
  );
  const candidateFormed = Boolean(
    readBoolean(metadata.generationResultTerminalCandidateFormed) === true ||
      candidateValidation === "accepted" ||
      candidateValidation === "rejected"
  );
  const modelExecuted = Boolean(
    candidateFormed ||
      (readNumber(metadata.generationResultAttemptCount) ?? 0) > 0 ||
      readBoolean(metadata.questionTypeAdjudicationOutcomeModelCompleted) ===
        true ||
      outputDisposition === "empty-or-silent" ||
      outputDisposition === "output-commit-not-authorized"
  );
  const answerCommitted =
    advisorVisible === true ||
    screenVisible === true ||
    visibleRevisionGrew ||
    commitDisposition === "committed" ||
    projectionDisposition === "current-visible";
  if (answerCommitted) {
    return {
      runtimeAction: "advise",
      outcome: "visible-committed",
      answerCommitted: true,
      candidateFormed,
      modelExecuted: true,
    };
  }

  const deliveryPending = Boolean(
    outputDisposition === "pending-delivery" ||
      commitDisposition === "pending" ||
      projectionDisposition === "pending" ||
      readBoolean(metadata.questionTypeAdjudicationOutcomeDeliveryPending) ===
        true
  );
  if (deliveryPending) {
    return {
      runtimeAction: "advise",
      outcome: "delivery-pending",
      answerCommitted: false,
      candidateFormed,
      modelExecuted: true,
    };
  }

  const staleOutcome = resolveStaleOutcome(metadata, terminalDisposition);
  if (staleOutcome) {
    return {
      outcome: staleOutcome,
      answerCommitted: false,
      candidateFormed,
      modelExecuted,
    };
  }

  if (candidateFormed || modelExecuted) {
    return {
      runtimeAction: "advise",
      outcome:
        terminalDisposition === "failed" ||
        terminalDisposition === "timed-out" ||
        readString(metadata.advisorJobOutcome) === "error"
          ? "error"
          : "model-completed",
      answerCommitted: false,
      candidateFormed,
      modelExecuted: true,
    };
  }

  const turnAction = readString(
    metadata.turnGateAction ?? metadata.advisorTurnAction
  );
  if (turnAction === "append-only" || turnAction === "state-update") {
    return {
      runtimeAction: "append-context",
      answerCommitted: false,
      candidateFormed: false,
      modelExecuted: false,
    };
  }
  if (
    turnAction === "buffer" ||
    readString(metadata.advisorTurnIntent) === "incomplete"
  ) {
    return {
      runtimeAction: "buffer",
      answerCommitted: false,
      candidateFormed: false,
      modelExecuted: false,
    };
  }

  const explicitlySuppressed = Boolean(
    readString(metadata.advisorJobOutcome) === "suppressed" ||
      readString(metadata.questionTypeAdjudicationOutcomeDisposition) ===
        "suppressed" ||
      readBoolean(metadata.advisorExecutionAuthorized) === false
  );
  if (explicitlySuppressed) {
    return {
      runtimeAction: "ignore",
      outcome: "suppressed",
      answerCommitted: false,
      candidateFormed: false,
      modelExecuted: false,
    };
  }

  return {
    answerCommitted: false,
    candidateFormed: false,
    modelExecuted: false,
  };
}

function resolveStaleOutcome(
  metadata: Record<string, unknown>,
  terminalDisposition: string | undefined
): ObservedAdvisorOutcome | undefined {
  const advisorJobOutcome = readString(metadata.advisorJobOutcome);
  if (
    advisorJobOutcome === "cancelled-by-new-job" ||
    advisorJobOutcome === "replaced-before-execution" ||
    terminalDisposition === "superseded"
  ) {
    return "cancelled-by-new-job";
  }
  if (
    advisorJobOutcome === "cancelled-by-runtime-boundary" ||
    terminalDisposition === "cancelled" ||
    terminalDisposition === "aborted"
  ) {
    return "cancelled-by-runtime-boundary";
  }
  if (advisorJobOutcome === "stale-commit-rejected") {
    return "stale-dropped";
  }
  return undefined;
}

function readBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}
