import type { CanonicalQuestionType } from "./task-taxonomy.js";

export type ScreenPreflightFallbackReason =
  | "timeout"
  | "provider-failure"
  | "parse-failure"
  | "aborted";

export interface ScreenPreflightDeadlineDecision {
  operationId: string;
  leaseRevision: number;
  startedAt: number;
  deadlineAt: number;
  providerCompletedAt?: number;
  parseCompletedAt?: number;
  committedAt: number;
  outcome: "valid-result" | "fallback";
  canonicalQuestionType?: CanonicalQuestionType;
  fallbackReason?: ScreenPreflightFallbackReason;
  lateResultObserved: false;
}

export interface ScreenPreflightParsedCandidate<T> {
  result: T;
  providerCompletedAt?: number;
  parseCompletedAt: number;
  canonicalQuestionType?: CanonicalQuestionType;
  confidence?: number;
}

export interface ScreenPreflightLateResultObservation {
  operationId: string;
  leaseRevision: number;
  observedAt: number;
  providerCompletedAt?: number;
  parseCompletedAt: number;
  canonicalQuestionType?: CanonicalQuestionType;
  confidence?: number;
  committedOutcome: ScreenPreflightDeadlineDecision["outcome"];
  committedFallbackReason?: ScreenPreflightFallbackReason;
}

export interface ScreenPreflightDeadlineResolution<T> {
  decision: Readonly<ScreenPreflightDeadlineDecision>;
  result?: T;
}

type DeadlineTimer = ReturnType<typeof setTimeout>;

export function createScreenPreflightDeadlineArbiter<T>({
  operationId,
  leaseRevision,
  startedAt,
  timeoutMs,
  now = Date.now,
  schedule = (callback, delayMs) => setTimeout(callback, delayMs),
  cancelSchedule = (timer) => clearTimeout(timer),
  onLateResult,
}: {
  operationId: string;
  leaseRevision: number;
  startedAt: number;
  timeoutMs: number;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => DeadlineTimer;
  cancelSchedule?: (timer: DeadlineTimer) => void;
  onLateResult?: (observation: ScreenPreflightLateResultObservation) => void;
}) {
  const deadlineAt = startedAt + Math.max(0, timeoutMs);
  let providerCompletedAt: number | undefined;
  let committed: ScreenPreflightDeadlineResolution<T> | undefined;
  let resolveDecision:
    | ((resolution: ScreenPreflightDeadlineResolution<T>) => void)
    | undefined;
  const decisionPromise = new Promise<ScreenPreflightDeadlineResolution<T>>(
    (resolve) => {
      resolveDecision = resolve;
    }
  );

  const timer = schedule(
    () => observeDeadline(deadlineAt),
    Math.max(0, deadlineAt - now())
  );

  function commit(resolution: ScreenPreflightDeadlineResolution<T>) {
    if (committed) return false;
    committed = {
      ...resolution,
      decision: Object.freeze({ ...resolution.decision }),
    };
    cancelSchedule(timer);
    resolveDecision?.(committed);
    return true;
  }

  function observeProviderCompletion(completedAt: number) {
    if (
      Number.isFinite(completedAt) &&
      (providerCompletedAt === undefined || completedAt < providerCompletedAt)
    ) {
      providerCompletedAt = completedAt;
    }
  }

  function observeParsedResult(candidate: ScreenPreflightParsedCandidate<T>) {
    if (candidate.providerCompletedAt !== undefined) {
      observeProviderCompletion(candidate.providerCompletedAt);
    }

    if (committed) {
      if (committed.decision.outcome === "fallback") {
        onLateResult?.({
          operationId,
          leaseRevision,
          observedAt: now(),
          providerCompletedAt:
            candidate.providerCompletedAt ?? providerCompletedAt,
          parseCompletedAt: candidate.parseCompletedAt,
          canonicalQuestionType: candidate.canonicalQuestionType,
          confidence: candidate.confidence,
          committedOutcome: committed.decision.outcome,
          committedFallbackReason: committed.decision.fallbackReason,
        });
      }
      return false;
    }

    if (candidate.parseCompletedAt > deadlineAt) {
      observeDeadline(deadlineAt);
      onLateResult?.({
        operationId,
        leaseRevision,
        observedAt: now(),
        providerCompletedAt:
          candidate.providerCompletedAt ?? providerCompletedAt,
        parseCompletedAt: candidate.parseCompletedAt,
        canonicalQuestionType: candidate.canonicalQuestionType,
        confidence: candidate.confidence,
        committedOutcome: "fallback",
        committedFallbackReason: "timeout",
      });
      return false;
    }

    return commit({
      decision: {
        operationId,
        leaseRevision,
        startedAt,
        deadlineAt,
        providerCompletedAt:
          candidate.providerCompletedAt ?? providerCompletedAt,
        parseCompletedAt: candidate.parseCompletedAt,
        committedAt: now(),
        outcome: "valid-result",
        canonicalQuestionType: candidate.canonicalQuestionType,
        lateResultObserved: false,
      },
      result: candidate.result,
    });
  }

  function observeFailure(
    fallbackReason: Exclude<ScreenPreflightFallbackReason, "timeout">,
    failedAt = now()
  ) {
    if (committed) return false;
    if (failedAt > deadlineAt) return observeDeadline(deadlineAt);
    return commit({
      decision: {
        operationId,
        leaseRevision,
        startedAt,
        deadlineAt,
        providerCompletedAt,
        committedAt: failedAt,
        outcome: "fallback",
        fallbackReason,
        lateResultObserved: false,
      },
    });
  }

  function observeDeadline(committedAt = now()) {
    if (committed) return false;
    return commit({
      decision: {
        operationId,
        leaseRevision,
        startedAt,
        deadlineAt,
        providerCompletedAt,
        committedAt,
        outcome: "fallback",
        fallbackReason: "timeout",
        lateResultObserved: false,
      },
    });
  }

  return {
    observeProviderCompletion,
    observeParsedResult,
    observeFailure,
    observeDeadline,
    waitForDecision: () => decisionPromise,
    readDecision: () => committed?.decision,
  };
}

export function formatScreenPreflightDeadlineDecisionForTrace(
  decision: ScreenPreflightDeadlineDecision
) {
  return {
    screenPreflightOperationId: decision.operationId,
    screenPreflightLeaseRevision: decision.leaseRevision,
    screenPreflightStartedAt: decision.startedAt,
    screenPreflightDeadlineAt: decision.deadlineAt,
    screenPreflightProviderCompletedAt: decision.providerCompletedAt,
    screenPreflightParseCompletedAt: decision.parseCompletedAt,
    screenPreflightCommittedAt: decision.committedAt,
    screenPreflightDeadlineOutcome: decision.outcome,
    screenPreflightFallbackReason: decision.fallbackReason,
    screenPreflightParsedBeforeDeadline:
      decision.parseCompletedAt !== undefined
        ? decision.parseCompletedAt <= decision.deadlineAt
        : false,
    screenPreflightLateResultObserved: decision.lateResultObserved,
    screenPreflightCommittedQuestionType: decision.canonicalQuestionType,
  };
}

export function formatScreenPreflightLateResultForTrace(
  observation: ScreenPreflightLateResultObservation
) {
  return {
    screenPreflightLateResultObserved: true,
    screenPreflightLateResultObservedAt: observation.observedAt,
    screenPreflightLateProviderCompletedAt:
      observation.providerCompletedAt,
    screenPreflightLateParseCompletedAt: observation.parseCompletedAt,
    screenPreflightLateQuestionType: observation.canonicalQuestionType,
    screenPreflightLateConfidence: observation.confidence,
    screenPreflightLateCommittedOutcome: observation.committedOutcome,
    screenPreflightLateCommittedFallbackReason:
      observation.committedFallbackReason,
  };
}
