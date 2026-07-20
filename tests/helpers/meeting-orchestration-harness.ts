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
  | "recording";

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
}

export interface OrchestrationCommitResult {
  outcome: OrchestrationOperationOutcome;
  reason: string;
}

export interface OrchestrationJournalEntry {
  order: number;
  operationId: string;
  kind: OrchestrationOperationKind;
  event: "started" | "resolved" | "committed" | "rejected" | "failed";
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
    return this.runtimeEpoch;
  }

  setLatestSuggestionTraceId(traceId: string | undefined) {
    this.latestSuggestionTraceId = traceId;
  }

  setRecordingSessionId(sessionId: string | undefined) {
    this.recordingSessionId = sessionId;
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
      reason,
      state: this.getStateDigest(),
    });
  }
}
