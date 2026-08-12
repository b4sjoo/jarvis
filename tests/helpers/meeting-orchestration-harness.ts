import { createHash } from "node:crypto";
import { MeetingContextManager } from "../../src/lib/meeting/context-manager.js";
import {
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "../../src/lib/meeting/task-taxonomy.js";
import type {
  InterviewPlaybookPhase,
} from "../../src/lib/meeting/types.js";
import {
  createDeferredOperation,
  type DeferredOperationController,
} from "./deferred-operation.js";
import { ManualScheduler } from "./manual-scheduler.js";

export type OrchestrationOperationKind =
  | "advisor"
  | "screen"
  | "memory"
  | "correction"
  | "recording"
  | "runtime";

export type OrchestrationOperationOutcome = "committed" | "rejected";

export interface RuntimeStateDigest {
  runtimeEpoch: number;
  sessionId: string;
  parentId?: string;
  parentRevision?: number;
  parentQuestionType?: CanonicalQuestionType;
  childId?: string;
  playbookPhase?: InterviewPlaybookPhase;
  screenTaskId?: string;
  projectBindingRevision?: number;
  whiteboardRevision?: number;
  latestSuggestionTraceId?: string;
  recordingSessionId?: string;
  generationOwnerId?: string;
  generationRevision?: number;
  activeAdvisorJobId?: string;
  activeOperationIds?: Partial<Record<OrchestrationOperationKind, string>>;
}

export interface OrchestrationCommitResult {
  outcome: OrchestrationOperationOutcome;
  reason: string;
}

export interface OrchestrationJournalEntry {
  order: number;
  operationId: string;
  kind: OrchestrationOperationKind;
  event:
    | "started"
    | "resolved"
    | "committed"
    | "rejected"
    | "failed"
    | "checkpoint";
  occurredAt: number;
  reason?: string;
  state: RuntimeStateDigest;
}

export interface ControlledOrchestrationOperation<T> {
  id: string;
  kind: OrchestrationOperationKind;
  startedFrom: RuntimeStateDigest;
  completion: Promise<OrchestrationCommitResult>;
  resolve(value: T): void;
  reject(error: unknown): void;
  isSettled(): boolean;
}

interface StartOperationInput<T> {
  id: string;
  kind: OrchestrationOperationKind;
  commit(input: {
    value: T;
    startedFrom: RuntimeStateDigest;
    contextManager: MeetingContextManager;
    harness: MeetingOrchestrationHarness;
  }): OrchestrationCommitResult | Promise<OrchestrationCommitResult>;
}

export interface OrchestrationReplayStep {
  id: string;
  atMs: number;
  run(harness: MeetingOrchestrationHarness): void | Promise<void>;
}

export interface CanonicalOrchestrationDigest {
  schemaVersion: 1;
  algorithm: "sha256";
  hash: string;
  canonicalPayload: string;
}

/**
 * Deterministic async driver for runtime characterization tests.
 *
 * It controls completion order and records state transitions, but delegates all
 * authorization and mutation decisions to production modules supplied by each
 * scenario.
 */
export class MeetingOrchestrationHarness {
  readonly contextManager: MeetingContextManager;
  readonly scheduler = new ManualScheduler();

  private activeAdvisorJobId?: string;
  private readonly activeOperationIds = new Map<
    OrchestrationOperationKind,
    string
  >();
  private runtimeEpoch = 1;
  private latestSuggestionTraceId?: string;
  private recordingSessionId?: string;
  private generationOwnerId?: string;
  private generationRevision?: number;
  private journalSequence = 0;
  private readonly journal: OrchestrationJournalEntry[] = [];

  constructor(contextManager = new MeetingContextManager()) {
    this.contextManager = contextManager;
  }

  startOperation<T>(
    input: StartOperationInput<T>
  ): ControlledOrchestrationOperation<T> {
    const deferred: DeferredOperationController<T> = createDeferredOperation<T>();
    const startedFrom = this.getStateDigest();
    this.record(input.id, input.kind, "started");

    const completion = deferred.promise.then(
      async (value) => {
        this.record(input.id, input.kind, "resolved");
        try {
          const result = await input.commit({
            value,
            startedFrom,
            contextManager: this.contextManager,
            harness: this,
          });
          this.record(
            input.id,
            input.kind,
            result.outcome,
            result.reason
          );
          return result;
        } catch (error) {
          this.record(
            input.id,
            input.kind,
            "failed",
            error instanceof Error ? error.message : String(error)
          );
          throw error;
        }
      },
      (error) => {
        this.record(
          input.id,
          input.kind,
          "failed",
          error instanceof Error ? error.message : String(error)
        );
        throw error;
      }
    );

    return {
      id: input.id,
      kind: input.kind,
      startedFrom,
      completion,
      resolve: deferred.resolve,
      reject: deferred.reject,
      isSettled: deferred.isSettled,
    };
  }

  activateAdvisorJob(jobId: string) {
    this.activeAdvisorJobId = jobId;
    this.activateOperation("advisor", jobId);
  }

  releaseAdvisorJob(jobId: string) {
    if (this.activeAdvisorJobId === jobId) {
      this.activeAdvisorJobId = undefined;
      this.releaseOperation("advisor", jobId);
    }
  }

  getActiveAdvisorJobId() {
    return this.activeAdvisorJobId;
  }

  activateOperation(kind: OrchestrationOperationKind, operationId: string) {
    this.activeOperationIds.set(kind, operationId);
  }

  releaseOperation(kind: OrchestrationOperationKind, operationId: string) {
    if (this.activeOperationIds.get(kind) === operationId) {
      this.activeOperationIds.delete(kind);
    }
  }

  getActiveOperationId(kind: OrchestrationOperationKind) {
    return this.activeOperationIds.get(kind);
  }

  getRuntimeEpoch() {
    return this.runtimeEpoch;
  }

  advanceRuntimeEpoch() {
    this.runtimeEpoch += 1;
    this.activeAdvisorJobId = undefined;
    this.activeOperationIds.clear();
    this.generationOwnerId = undefined;
    this.generationRevision = undefined;
    return this.runtimeEpoch;
  }

  setLatestSuggestionTraceId(traceId: string | undefined) {
    this.latestSuggestionTraceId = traceId;
  }

  setRecordingSessionId(sessionId: string | undefined) {
    this.recordingSessionId = sessionId;
  }

  setGenerationOwner(ownerId: string | undefined, revision?: number) {
    this.generationOwnerId = ownerId;
    this.generationRevision = ownerId ? revision : undefined;
  }

  recordCheckpoint(id: string, reason?: string) {
    this.record(id, "runtime", "checkpoint", reason);
  }

  getStateDigest(): RuntimeStateDigest {
    const state = this.contextManager.getState();
    const task = state.activeMeetingTask;
    return {
      runtimeEpoch: this.runtimeEpoch,
      sessionId: state.sessionId,
      parentId: task?.parent.id,
      parentRevision: task?.parent.revisions,
      parentQuestionType: task
        ? normalizeCanonicalQuestionType(task.parent.questionType) ?? "unknown"
        : undefined,
      childId: task?.child?.id,
      playbookPhase: task?.parent.playbookPhase,
      screenTaskId: task?.screen?.activeScreenTaskId,
      projectBindingRevision: task?.parent.projectBinding?.revision,
      whiteboardRevision: task?.parent.whiteboardArtifact?.revision,
      latestSuggestionTraceId: this.latestSuggestionTraceId,
      recordingSessionId: this.recordingSessionId,
      generationOwnerId: this.generationOwnerId,
      generationRevision: this.generationRevision,
      activeAdvisorJobId: this.activeAdvisorJobId,
      activeOperationIds: Object.fromEntries(
        [...this.activeOperationIds].sort(([left], [right]) =>
          left.localeCompare(right)
        )
      ),
    };
  }

  getCanonicalDigest(): CanonicalOrchestrationDigest {
    const aliases = new Map<string, string>();
    const aliasSession = (sessionId: string) => {
      let alias = aliases.get(sessionId);
      if (!alias) {
        alias = `session-${aliases.size + 1}`;
        aliases.set(sessionId, alias);
      }
      return alias;
    };
    const normalizeState = (state: RuntimeStateDigest) => ({
      ...state,
      sessionId: aliasSession(state.sessionId),
    });
    const journal = this.getJournal().map((entry) => ({
        ...entry,
        state: normalizeState(entry.state),
      }));
    const payload = {
      state: normalizeState(this.getStateDigest()),
      journal,
    };
    const canonicalPayload = canonicalJson(payload);
    return {
      schemaVersion: 1,
      algorithm: "sha256",
      hash: createHash("sha256").update(canonicalPayload).digest("hex"),
      canonicalPayload,
    };
  }

  getJournal() {
    return this.journal.map((entry) => ({
      ...entry,
      state: { ...entry.state },
    }));
  }

  getOperationEvents(operationId: string) {
    return this.getJournal().filter(
      (entry) => entry.operationId === operationId
    );
  }

  private record(
    operationId: string,
    kind: OrchestrationOperationKind,
    event: OrchestrationJournalEntry["event"],
    reason?: string
  ) {
    this.journal.push({
      order: ++this.journalSequence,
      operationId,
      kind,
      event,
      occurredAt: this.scheduler.now(),
      reason,
      state: this.getStateDigest(),
    });
  }
}

export async function replayOrchestrationSteps(
  harness: MeetingOrchestrationHarness,
  steps: OrchestrationReplayStep[]
) {
  let previousAt = harness.scheduler.now();
  const ordered = steps
    .map((step, index) => ({ step, index }))
    .sort(
      (left, right) =>
        left.step.atMs - right.step.atMs || left.index - right.index
    );
  for (const { step } of ordered) {
    if (!Number.isFinite(step.atMs) || step.atMs < previousAt) {
      throw new Error(`Replay step ${step.id} has an invalid time ${step.atMs}`);
    }
    harness.scheduler.advanceBy(step.atMs - harness.scheduler.now());
    harness.recordCheckpoint(step.id, "before");
    await step.run(harness);
    await Promise.resolve();
    harness.recordCheckpoint(step.id, "after");
    previousAt = step.atMs;
  }
  return harness.getCanonicalDigest();
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)])
  );
}
