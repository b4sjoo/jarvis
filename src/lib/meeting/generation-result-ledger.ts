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
  | "failed"
  | "timed-out"
  | "aborted"
  | "cancelled"
  | "superseded";

export type GenerationTerminalDisposition = Exclude<
  GenerationCommitDisposition,
  "started" | "pending"
>;

export interface GenerationResultTerminalization {
  disposition: GenerationTerminalDisposition;
  reason: string;
  source: string;
  authority: string;
  targetLogicalQuestionRevision?: number;
  candidateFormed: boolean;
  terminalizedAt: number;
}

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
  terminalization?: GenerationResultTerminalization;
  candidateValidation: GenerationCandidateValidationDisposition;
  candidateValidationReason?: string;
  commitDisposition: GenerationCommitDisposition;
  commitReason: string;
  visibleAnswerRevision?: number;
  startedAt: number;
  updatedAt: number;
  committedAt?: number;
  commitDurationMs?: number;
  prepareDurationMs?: number;
  installDurationMs?: number;
  applyFailure?: GenerationDerivedApplyFailure;
}

export type GenerationDerivedApplyStage =
  | "task-transition"
  | "stable-answer-publication";

export interface GenerationDerivedApplyFailure {
  stage: GenerationDerivedApplyStage;
  reason: string;
  transitionKind?: string;
  expectedTaskRuntimeRevision: number;
  currentTaskRuntimeRevision: number;
  errorClass?: string;
  safeErrorSummary?: string;
  rollbackAttempted?: boolean;
  rollbackSucceeded?: boolean;
}

export interface GenerationDerivedTaskTransitionResult {
  authorized: boolean;
  reason: string;
}

export interface GenerationDerivedPreparedTransition<T> {
  authorized: boolean;
  reason: string;
  value: T;
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
  prepareDurationMs?: number;
  installDurationMs?: number;
  applyFailure?: GenerationDerivedApplyFailure;
  now?: number;
}

interface TerminalizeGenerationInput {
  generationLeaseId: string;
  disposition: GenerationTerminalDisposition;
  reason: string;
  source: string;
  authority: string;
  targetLogicalQuestionRevision?: number;
  candidateFormed?: boolean;
  now?: number;
}

export interface GenerationAuthorizationRejectionInput<
  TLease extends GenerationResultLease = GenerationResultLease,
> {
  lease?: TLease;
  reason: string;
  source: string;
  authority: string;
  targetLogicalQuestionRevision?: number;
}

export function buildGenerationAuthorizationRejection<
  TLease extends GenerationResultLease,
>(input: GenerationAuthorizationRejectionInput<TLease>) {
  if (!input.lease) return undefined;
  return {
    lease: input.lease,
    disposition: "rejected" as const,
    reason: input.reason,
    source: input.source,
    authority: input.authority,
    targetLogicalQuestionRevision:
      input.targetLogicalQuestionRevision,
    candidateFormed: false,
  };
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
    if (entry.terminalization) return cloneEntry(entry);
    entry.candidateValidation = input.disposition;
    entry.candidateValidationReason = input.reason;
    entry.updatedAt = now;
    return cloneEntry(entry);
  }

  recordCommitDisposition(input: RecordCommitDispositionInput) {
    const now = input.now ?? Date.now();
    const entry = this.ensure(input.lease, now);
    if (entry.terminalization) return cloneEntry(entry);
    entry.commitDisposition = input.disposition;
    entry.commitReason = input.reason;
    entry.visibleAnswerRevision = input.visibleAnswerRevision;
    entry.commitDurationMs = input.commitDurationMs;
    entry.prepareDurationMs = input.prepareDurationMs;
    entry.installDurationMs = input.installDurationMs;
    entry.applyFailure = input.applyFailure
      ? { ...input.applyFailure }
      : entry.applyFailure;
    entry.committedAt =
      input.disposition === "committed" ? now : entry.committedAt;
    if (isTerminalGenerationDisposition(input.disposition)) {
      entry.terminalization = {
        disposition: input.disposition,
        reason: input.reason,
        source: "commit-disposition",
        authority: "generation-commit-coordinator",
        candidateFormed:
          entry.candidateValidation !== "not-evaluated",
        terminalizedAt: now,
      };
    }
    entry.updatedAt = now;
    return cloneEntry(entry);
  }

  terminalize(input: TerminalizeGenerationInput) {
    const entry = this.findByLease(input.generationLeaseId);
    if (!entry) return undefined;
    if (entry.terminalization) return cloneEntry(entry);
    const now = input.now ?? Date.now();
    entry.commitDisposition = input.disposition;
    entry.commitReason = input.reason;
    entry.terminalization = {
      disposition: input.disposition,
      reason: input.reason,
      source: input.source,
      authority: input.authority,
      targetLogicalQuestionRevision:
        input.targetLogicalQuestionRevision,
      candidateFormed:
        input.candidateFormed ??
        entry.candidateValidation !== "not-evaluated",
      terminalizedAt: now,
    };
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
    if (existing?.terminalization) {
      return {
        committed: false,
        reason:
          existing.commitDisposition === "committed"
            ? "duplicate-generation-commit"
            : `generation-already-terminal:${existing.commitDisposition}`,
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

  commitStaged<TTransition, TPublication, T>(input: {
    lease: GenerationResultLease;
    leaseAuthorization: GenerationLeaseAuthorization;
    expectedTaskRuntimeRevision: number;
    currentTaskRuntimeRevision: number;
    candidateAccepted: boolean;
    visibleAnswerRevision: number;
    transition?: {
      kind: string;
      prepare: () => GenerationDerivedPreparedTransition<TTransition>;
      install: (prepared: TTransition) => GenerationDerivedTaskTransitionResult;
      rollback: (prepared: TTransition) => boolean;
    };
    publication: {
      prepare: () => TPublication;
      install: (prepared: TPublication) => T;
      rollback: (prepared: TPublication) => boolean;
    };
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
    if (existing?.terminalization) {
      return {
        committed: false,
        reason:
          existing.commitDisposition === "committed"
            ? "duplicate-generation-commit"
            : `generation-already-terminal:${existing.commitDisposition}`,
        leaseAuthorization: authorization.leaseAuthorization,
        entry: existing,
      };
    }

    const startedAt = monotonicNow();
    const prepareStartedAt = monotonicNow();
    let preparedTransition:
      | GenerationDerivedPreparedTransition<TTransition>
      | undefined;
    if (input.transition) {
      try {
        preparedTransition = input.transition.prepare();
      } catch (error) {
        return this.recordStagedApplyFailure({
          input,
          startedAt,
          prepareDurationMs: Math.max(
            0,
            monotonicNow() - prepareStartedAt
          ),
          stage: "task-transition",
          reason: "task-transition-prepare-exception",
          transitionKind: input.transition.kind,
          error,
        });
      }
      if (!preparedTransition.authorized) {
        return this.recordStagedApplyFailure({
          input,
          startedAt,
          prepareDurationMs: Math.max(
            0,
            monotonicNow() - prepareStartedAt
          ),
          stage: "task-transition",
          reason: `task-transition-rejected:${preparedTransition.reason}`,
          transitionKind: input.transition.kind,
          disposition: "rejected",
        });
      }
    }

    let preparedPublication: TPublication;
    try {
      preparedPublication = input.publication.prepare();
    } catch (error) {
      return this.recordStagedApplyFailure({
        input,
        startedAt,
        prepareDurationMs: Math.max(
          0,
          monotonicNow() - prepareStartedAt
        ),
        stage: "stable-answer-publication",
        reason: "stable-answer-publication-prepare-exception",
        error,
      });
    }
    const prepareDurationMs = Math.max(
      0,
      monotonicNow() - prepareStartedAt
    );
    const installStartedAt = monotonicNow();
    let transitionInstalled = false;
    if (input.transition && preparedTransition) {
      let transitionResult: GenerationDerivedTaskTransitionResult;
      try {
        transitionResult = input.transition.install(
          preparedTransition.value
        );
        transitionInstalled = transitionResult.authorized;
      } catch (error) {
        const rollbackSucceeded = attemptRollback(() =>
          input.transition!.rollback(preparedTransition!.value)
        );
        return this.recordStagedApplyFailure({
          input,
          startedAt,
          prepareDurationMs,
          installDurationMs: Math.max(
            0,
            monotonicNow() - installStartedAt
          ),
          stage: "task-transition",
          reason: "task-transition-install-exception",
          transitionKind: input.transition.kind,
          error,
          rollbackAttempted: true,
          rollbackSucceeded,
        });
      }
      if (!transitionResult.authorized) {
        return this.recordStagedApplyFailure({
          input,
          startedAt,
          prepareDurationMs,
          installDurationMs: Math.max(
            0,
            monotonicNow() - installStartedAt
          ),
          stage: "task-transition",
          reason: `task-transition-rejected:${transitionResult.reason}`,
          transitionKind: input.transition.kind,
          disposition: "rejected",
        });
      }
    }

    try {
      const value = input.publication.install(preparedPublication);
      const installDurationMs = Math.max(
        0,
        monotonicNow() - installStartedAt
      );
      const entry = this.ledger.recordCommitDisposition({
        lease: input.lease,
        disposition: "committed",
        reason: "authorized",
        visibleAnswerRevision: input.visibleAnswerRevision,
        commitDurationMs: Math.max(0, monotonicNow() - startedAt),
        prepareDurationMs,
        installDurationMs,
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
      const publicationRollbackSucceeded = attemptRollback(() =>
        input.publication.rollback(preparedPublication)
      );
      const transitionRollbackSucceeded =
        !transitionInstalled || !input.transition || !preparedTransition
          ? true
          : attemptRollback(() =>
              input.transition!.rollback(preparedTransition!.value)
            );
      return this.recordStagedApplyFailure({
        input,
        startedAt,
        prepareDurationMs,
        installDurationMs: Math.max(
          0,
          monotonicNow() - installStartedAt
        ),
        stage: "stable-answer-publication",
        reason: "stable-answer-publication-install-exception",
        error,
        rollbackAttempted: true,
        rollbackSucceeded:
          publicationRollbackSucceeded && transitionRollbackSucceeded,
      });
    }
  }

  private recordStagedApplyFailure<T>(input: {
    input: {
      lease: GenerationResultLease;
      leaseAuthorization: GenerationLeaseAuthorization;
      expectedTaskRuntimeRevision: number;
      currentTaskRuntimeRevision: number;
      now?: number;
    };
    startedAt: number;
    stage: GenerationDerivedApplyStage;
    reason: string;
    transitionKind?: string;
    error?: unknown;
    disposition?: "rejected" | "failed";
    prepareDurationMs?: number;
    installDurationMs?: number;
    rollbackAttempted?: boolean;
    rollbackSucceeded?: boolean;
  }): GenerationDerivedCommitResult<T> {
    const applyFailure: GenerationDerivedApplyFailure = {
      stage: input.stage,
      reason: input.reason,
      transitionKind: input.transitionKind,
      expectedTaskRuntimeRevision:
        input.input.expectedTaskRuntimeRevision,
      currentTaskRuntimeRevision:
        input.input.currentTaskRuntimeRevision,
      ...(input.rollbackAttempted !== undefined
        ? { rollbackAttempted: input.rollbackAttempted }
        : {}),
      ...(input.rollbackSucceeded !== undefined
        ? { rollbackSucceeded: input.rollbackSucceeded }
        : {}),
      ...safeApplyError(input.error),
    };
    const entry = this.ledger.recordCommitDisposition({
      lease: input.input.lease,
      disposition: input.disposition ?? "failed",
      reason: input.reason,
      commitDurationMs: Math.max(0, monotonicNow() - input.startedAt),
      prepareDurationMs: input.prepareDurationMs,
      installDurationMs: input.installDurationMs,
      applyFailure,
      now: input.input.now,
    });
    return {
      committed: false,
      reason: input.reason,
      leaseAuthorization: input.input.leaseAuthorization,
      entry,
    };
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
    generationResultTerminalDisposition:
      entry?.terminalization?.disposition,
    generationResultTerminalReason: entry?.terminalization?.reason,
    generationResultTerminalSource: entry?.terminalization?.source,
    generationResultTerminalAuthority:
      entry?.terminalization?.authority,
    generationResultTerminalTargetLogicalQuestionRevision:
      entry?.terminalization?.targetLogicalQuestionRevision,
    generationResultTerminalCandidateFormed:
      entry?.terminalization?.candidateFormed,
    generationResultTerminalizedAt:
      entry?.terminalization?.terminalizedAt,
    generationResultCandidateValidation:
      entry?.candidateValidation,
    generationResultCandidateValidationReason:
      entry?.candidateValidationReason,
    generationResultCommitDisposition: entry?.commitDisposition,
    generationResultCommitReason: entry?.commitReason,
    generationResultVisibleAnswerRevision:
      entry?.visibleAnswerRevision,
    generationResultCommitDurationMs: entry?.commitDurationMs,
    generationResultPrepareDurationMs: entry?.prepareDurationMs,
    generationResultInstallDurationMs: entry?.installDurationMs,
    generationResultApplyFailureStage: entry?.applyFailure?.stage,
    generationResultApplyFailureReason: entry?.applyFailure?.reason,
    generationResultApplyFailureTransitionKind:
      entry?.applyFailure?.transitionKind,
    generationResultApplyFailureExpectedTaskRuntimeRevision:
      entry?.applyFailure?.expectedTaskRuntimeRevision,
    generationResultApplyFailureCurrentTaskRuntimeRevision:
      entry?.applyFailure?.currentTaskRuntimeRevision,
    generationResultApplyFailureErrorClass:
      entry?.applyFailure?.errorClass,
    generationResultApplyFailureSafeErrorSummary:
      entry?.applyFailure?.safeErrorSummary,
    generationResultRollbackAttempted:
      entry?.applyFailure?.rollbackAttempted,
    generationResultRollbackSucceeded:
      entry?.applyFailure?.rollbackSucceeded,
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
    terminalization: entry.terminalization
      ? { ...entry.terminalization }
      : undefined,
    applyFailure: entry.applyFailure
      ? { ...entry.applyFailure }
      : undefined,
  };
}

function safeApplyError(error: unknown) {
  if (!error) return {};
  const errorClass =
    error instanceof Error ? error.name || "Error" : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  return {
    errorClass: errorClass.slice(0, 80),
    safeErrorSummary: message.replace(/\s+/gu, " ").trim().slice(0, 240),
  };
}

function attemptRollback(rollback: () => boolean) {
  try {
    return rollback();
  } catch {
    return false;
  }
}

export function isTerminalGenerationDisposition(
  disposition: GenerationCommitDisposition
): disposition is GenerationTerminalDisposition {
  return disposition !== "started" && disposition !== "pending";
}

export function generationFailureDispositionFromProviderStatus(
  status: AIResponseTerminalOutcome["status"] | undefined
): "failed" | "timed-out" | "aborted" {
  if (status === "timed-out") return "timed-out";
  if (status === "aborted") return "aborted";
  return "failed";
}

function monotonicNow() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
