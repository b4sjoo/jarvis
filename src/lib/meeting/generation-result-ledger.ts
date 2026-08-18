import type { AIResponseTerminalOutcome } from "../functions/ai-response-events.js";

export interface GenerationResultLease {
  id: string;
  sessionId: string;
  runtimeEpoch: number;
  taskId: string | null;
  logicalQuestionUnitId: string | null;
  logicalQuestionRevision: number | null;
  modelRoute: string;
  startedAt: number;
}

export interface GenerationLeaseAuthorization {
  authorized: boolean;
  reason: string;
  rejectedArtifacts: readonly string[];
}

export type GenerationCandidateValidationDisposition =
  | "not-evaluated"
  | "accepted"
  | "rejected";

export type GenerationCommitDisposition =
  | "started"
  | "pending"
  | "committed"
  | "rejected"
  | "failed";

export type GenerationResultProjectionDisposition =
  | "none"
  | "current-visible"
  | "pending"
  | "historical";

export interface GenerationResultLedgerKey {
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  logicalQuestionRevision: number;
}

export interface GenerationResultProviderAttempt {
  requestId: string;
  attemptId: string;
  attemptNumber: number;
  maxAttempts: number;
  status: AIResponseTerminalOutcome["status"];
  disposition: AIResponseTerminalOutcome["disposition"];
  failureClass?: AIResponseTerminalOutcome["failureClass"];
  retryable: boolean;
  final: boolean;
  providerId: string;
  modelId: string;
  startedAt: number;
  firstContentAt?: number;
  finishedAt: number;
  chunkCount: number;
  statusCode?: number;
  safeErrorSummary?: string;
}

export interface GenerationResultLedgerEntry {
  id: string;
  key: GenerationResultLedgerKey;
  generationLeaseId: string;
  taskId: string | null;
  modelRoute: string;
  traceId?: string;
  providerAttempts: GenerationResultProviderAttempt[];
  terminalOutcome?: GenerationResultProviderAttempt;
  candidateValidation: GenerationCandidateValidationDisposition;
  candidateValidationReason?: string;
  commitDisposition: GenerationCommitDisposition;
  commitReason: string;
  visibleAnswerRevision?: number;
  startedAt: number;
  updatedAt: number;
  committedAt?: number;
  commitDurationMs?: number;
}

export interface GenerationResultProjection {
  disposition: GenerationResultProjectionDisposition;
  key?: GenerationResultLedgerKey;
  generationLeaseId?: string;
  taskId?: string | null;
  commitDisposition?: GenerationCommitDisposition;
  visibleAnswerRevision?: number;
  updatedAt?: number;
}

export type GenerationDerivedCommitReason = string;

export interface GenerationDerivedCommitResult<T> {
  committed: boolean;
  reason: GenerationDerivedCommitReason;
  leaseAuthorization: GenerationLeaseAuthorization;
  value?: T;
  entry: GenerationResultLedgerEntry;
}

interface BeginGenerationInput {
  lease: GenerationResultLease;
  traceId?: string;
  now?: number;
}

interface RecordCandidateValidationInput {
  lease: GenerationResultLease;
  disposition: Exclude<GenerationCandidateValidationDisposition, "not-evaluated">;
  reason: string;
  now?: number;
}

interface RecordCommitDispositionInput {
  lease: GenerationResultLease;
  disposition: GenerationCommitDisposition;
  reason: string;
  visibleAnswerRevision?: number;
  commitDurationMs?: number;
  now?: number;
}

export class GenerationResultLedger {
  private readonly entries: GenerationResultLedgerEntry[] = [];

  constructor(private readonly maxEntries = 160) {}

  begin(input: BeginGenerationInput) {
    const existing = this.findByLease(input.lease.id);
    if (existing) return cloneEntry(existing);

    const now = input.now ?? Date.now();
    const entry: GenerationResultLedgerEntry = {
      id: `generation_result:${input.lease.id}`,
      key: generationResultLedgerKey(input.lease),
      generationLeaseId: input.lease.id,
      taskId: input.lease.taskId,
      modelRoute: input.lease.modelRoute,
      traceId: input.traceId,
      providerAttempts: [],
      candidateValidation: "not-evaluated",
      commitDisposition: "started",
      commitReason: "generation-started",
      startedAt: input.lease.startedAt,
      updatedAt: now,
    };
    this.entries.push(entry);
    this.trim();
    return cloneEntry(entry);
  }

  recordProviderAttempt(
    lease: GenerationResultLease,
    outcome: Readonly<AIResponseTerminalOutcome>,
    now = Date.now()
  ) {
    const entry = this.ensure(lease, now);
    const attempt = toSafeAttempt(outcome);
    const existingIndex = entry.providerAttempts.findIndex(
      (candidate) => candidate.attemptId === attempt.attemptId
    );
    if (existingIndex >= 0) {
      entry.providerAttempts[existingIndex] = attempt;
    } else {
      entry.providerAttempts.push(attempt);
    }
    if (attempt.final) entry.terminalOutcome = attempt;
    entry.updatedAt = now;
    return cloneEntry(entry);
  }

  recordCandidateValidation(input: RecordCandidateValidationInput) {
    const now = input.now ?? Date.now();
    const entry = this.ensure(input.lease, now);
    entry.candidateValidation = input.disposition;
    entry.candidateValidationReason = input.reason;
    entry.updatedAt = now;
    return cloneEntry(entry);
  }

  recordCommitDisposition(input: RecordCommitDispositionInput) {
    const now = input.now ?? Date.now();
    const entry = this.ensure(input.lease, now);
    entry.commitDisposition = input.disposition;
    entry.commitReason = input.reason;
    entry.visibleAnswerRevision = input.visibleAnswerRevision;
    entry.commitDurationMs = input.commitDurationMs;
    entry.committedAt =
      input.disposition === "committed" ? now : entry.committedAt;
    entry.updatedAt = now;
    return cloneEntry(entry);
  }

  project(input: {
    sessionId: string;
    runtimeEpoch: number;
    logicalQuestionUnitId?: string | null;
    logicalQuestionRevision?: number | null;
    visibleAnswerRevision: number;
  }): GenerationResultProjection {
    const currentKey =
      input.logicalQuestionUnitId &&
      input.logicalQuestionRevision !== null &&
      input.logicalQuestionRevision !== undefined
        ? serializeLedgerKey({
            sessionId: input.sessionId,
            runtimeEpoch: input.runtimeEpoch,
            logicalQuestionUnitId: input.logicalQuestionUnitId,
            logicalQuestionRevision: input.logicalQuestionRevision,
          })
        : undefined;
    const currentEntries = currentKey
      ? this.entries.filter(
          (entry) => serializeLedgerKey(entry.key) === currentKey
        )
      : [];
    const current = currentEntries[currentEntries.length - 1];
    if (current) {
      return toProjection(
        current,
        current.commitDisposition === "pending" ||
          current.commitDisposition === "started"
          ? "pending"
          : current.commitDisposition === "committed" &&
              current.visibleAnswerRevision === input.visibleAnswerRevision
            ? "current-visible"
            : "historical"
      );
    }

    const visible = [...this.entries]
      .reverse()
      .find(
        (entry) =>
          entry.commitDisposition === "committed" &&
          entry.visibleAnswerRevision === input.visibleAnswerRevision
      );
    return visible
      ? toProjection(visible, "historical")
      : { disposition: "none" };
  }

  getEntry(generationLeaseId: string) {
    const entry = this.findByLease(generationLeaseId);
    return entry ? cloneEntry(entry) : undefined;
  }

  listEntries() {
    return this.entries.map(cloneEntry);
  }

  clear() {
    this.entries.length = 0;
  }

  private ensure(lease: GenerationResultLease, now: number) {
    const existing = this.findByLease(lease.id);
    if (existing) return existing;
    this.begin({ lease, now });
    return this.findByLease(lease.id)!;
  }

  private findByLease(generationLeaseId: string) {
    return this.entries.find(
      (entry) => entry.generationLeaseId === generationLeaseId
    );
  }

  private trim() {
    if (this.entries.length <= this.maxEntries) return;
    this.entries.splice(0, this.entries.length - this.maxEntries);
  }
}

export class GenerationDerivedCommitCoordinator {
  constructor(readonly ledger: GenerationResultLedger) {}

  markPending(input: {
    lease: GenerationResultLease;
    leaseAuthorization: GenerationLeaseAuthorization;
    expectedTaskRuntimeRevision: number;
    currentTaskRuntimeRevision: number;
    candidateAccepted: boolean;
    reason: string;
    now?: number;
  }) {
    const authorization = authorizeGenerationDerivedCommit(input);
    if (!authorization.authorized) {
      return this.ledger.recordCommitDisposition({
        lease: input.lease,
        disposition: "rejected",
        reason: authorization.reason,
        now: input.now,
      });
    }
    return this.ledger.recordCommitDisposition({
      lease: input.lease,
      disposition: "pending",
      reason: input.reason,
      now: input.now,
    });
  }

  commit<T>(input: {
    lease: GenerationResultLease;
    leaseAuthorization: GenerationLeaseAuthorization;
    expectedTaskRuntimeRevision: number;
    currentTaskRuntimeRevision: number;
    candidateAccepted: boolean;
    visibleAnswerRevision: number;
    apply: () => T;
    now?: number;
  }): GenerationDerivedCommitResult<T> {
    const authorization = authorizeGenerationDerivedCommit(input);
    if (!authorization.authorized) {
      const entry = this.ledger.recordCommitDisposition({
        lease: input.lease,
        disposition: "rejected",
        reason: authorization.reason,
        now: input.now,
      });
      return {
        committed: false,
        reason: authorization.reason,
        leaseAuthorization: authorization.leaseAuthorization,
        entry,
      };
    }
    const existing = this.ledger.getEntry(input.lease.id);
    if (existing?.commitDisposition === "committed") {
      return {
        committed: false,
        reason: "duplicate-generation-commit",
        leaseAuthorization: authorization.leaseAuthorization,
        entry: existing,
      };
    }

    const startedAt = monotonicNow();
    try {
      const value = input.apply();
      const entry = this.ledger.recordCommitDisposition({
        lease: input.lease,
        disposition: "committed",
        reason: "authorized",
        visibleAnswerRevision: input.visibleAnswerRevision,
        commitDurationMs: Math.max(0, monotonicNow() - startedAt),
        now: input.now,
      });
      return {
        committed: true,
        reason: "authorized",
        leaseAuthorization: authorization.leaseAuthorization,
        value,
        entry,
      };
    } catch (error) {
      const entry = this.ledger.recordCommitDisposition({
        lease: input.lease,
        disposition: "failed",
        reason: "apply-failed",
        commitDurationMs: Math.max(0, monotonicNow() - startedAt),
        now: input.now,
      });
      return {
        committed: false,
        reason: "apply-failed",
        leaseAuthorization: authorization.leaseAuthorization,
        entry,
      };
    }
  }
}

export function generationResultLedgerKey(
  lease: GenerationResultLease
): GenerationResultLedgerKey {
  return {
    sessionId: lease.sessionId,
    runtimeEpoch: lease.runtimeEpoch,
    logicalQuestionUnitId:
      lease.logicalQuestionUnitId ?? `unscoped:${lease.id}`,
    logicalQuestionRevision: lease.logicalQuestionRevision ?? -1,
  };
}

export function formatGenerationResultLedgerForTrace(
  entry: GenerationResultLedgerEntry | undefined,
  projection?: GenerationResultProjection
) {
  return {
    generationResultLedgerEntryId: entry?.id,
    generationResultLedgerKey: entry
      ? serializeLedgerKey(entry.key)
      : undefined,
    generationResultAttemptCount: entry?.providerAttempts.length,
    generationResultProviderAttempts: entry?.providerAttempts.map(
      (attempt) => ({
        requestId: attempt.requestId,
        attemptId: attempt.attemptId,
        attemptNumber: attempt.attemptNumber,
        maxAttempts: attempt.maxAttempts,
        status: attempt.status,
        disposition: attempt.disposition,
        failureClass: attempt.failureClass,
        retryable: attempt.retryable,
        final: attempt.final,
        providerId: attempt.providerId,
        modelId: attempt.modelId,
        startedAt: attempt.startedAt,
        firstContentAt: attempt.firstContentAt,
        finishedAt: attempt.finishedAt,
        chunkCount: attempt.chunkCount,
        statusCode: attempt.statusCode,
        safeErrorSummary: attempt.safeErrorSummary,
      })
    ),
    generationResultTerminalStatus: entry?.terminalOutcome?.status,
    generationResultCandidateValidation:
      entry?.candidateValidation,
    generationResultCandidateValidationReason:
      entry?.candidateValidationReason,
    generationResultCommitDisposition: entry?.commitDisposition,
    generationResultCommitReason: entry?.commitReason,
    generationResultVisibleAnswerRevision:
      entry?.visibleAnswerRevision,
    generationResultCommitDurationMs: entry?.commitDurationMs,
    generationResultProjectionDisposition:
      projection?.disposition,
  };
}

function authorizeGenerationDerivedCommit(input: {
  lease: GenerationResultLease;
  leaseAuthorization: GenerationLeaseAuthorization;
  expectedTaskRuntimeRevision: number;
  currentTaskRuntimeRevision: number;
  candidateAccepted: boolean;
}): {
  authorized: boolean;
  reason: GenerationDerivedCommitReason;
  leaseAuthorization: GenerationLeaseAuthorization;
} {
  const leaseAuthorization = input.leaseAuthorization;
  if (!leaseAuthorization.authorized) {
    return {
      authorized: false,
      reason: leaseAuthorization.reason,
      leaseAuthorization,
    };
  }
  if (!input.candidateAccepted) {
    return {
      authorized: false,
      reason: "candidate-not-accepted",
      leaseAuthorization,
    };
  }
  if (
    input.expectedTaskRuntimeRevision !==
    input.currentTaskRuntimeRevision
  ) {
    return {
      authorized: false,
      reason: "task-runtime-revision-mismatch",
      leaseAuthorization,
    };
  }
  return {
    authorized: true,
    reason: "authorized",
    leaseAuthorization,
  };
}

function toSafeAttempt(
  outcome: Readonly<AIResponseTerminalOutcome>
): GenerationResultProviderAttempt {
  return {
    requestId: outcome.requestId,
    attemptId: outcome.attemptId,
    attemptNumber: outcome.attemptNumber,
    maxAttempts: outcome.maxAttempts,
    status: outcome.status,
    disposition: outcome.disposition,
    failureClass: outcome.failureClass,
    retryable: outcome.retryable,
    final: outcome.final,
    providerId: outcome.providerId,
    modelId: outcome.modelId,
    startedAt: outcome.startedAt,
    firstContentAt: outcome.firstContentAt,
    finishedAt: outcome.finishedAt,
    chunkCount: outcome.chunkCount,
    statusCode: outcome.statusCode,
    safeErrorSummary: outcome.safeErrorSummary?.slice(0, 500),
  };
}

function serializeLedgerKey(key: GenerationResultLedgerKey) {
  return [
    key.sessionId,
    key.runtimeEpoch,
    key.logicalQuestionUnitId,
    key.logicalQuestionRevision,
  ].join(":");
}

function toProjection(
  entry: GenerationResultLedgerEntry,
  disposition: Exclude<GenerationResultProjectionDisposition, "none">
): GenerationResultProjection {
  return {
    disposition,
    key: { ...entry.key },
    generationLeaseId: entry.generationLeaseId,
    taskId: entry.taskId,
    commitDisposition: entry.commitDisposition,
    visibleAnswerRevision: entry.visibleAnswerRevision,
    updatedAt: entry.updatedAt,
  };
}

function cloneEntry(
  entry: GenerationResultLedgerEntry
): GenerationResultLedgerEntry {
  return {
    ...entry,
    key: { ...entry.key },
    providerAttempts: entry.providerAttempts.map((attempt) => ({
      ...attempt,
    })),
    terminalOutcome: entry.terminalOutcome
      ? { ...entry.terminalOutcome }
      : undefined,
  };
}

function monotonicNow() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
