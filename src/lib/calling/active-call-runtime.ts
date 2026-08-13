import {
  authorizeOperationCommit,
  createOperationLease,
  type ModelRouteKind,
  type OperationLease,
  type RuntimeOperationEnvelope,
} from "./operation-authority.js";
import { applyAdvisorAuthority } from "./advisor-authority.js";
import { StableGuidanceStore, type GuidanceReceipt } from "./stable-guidance.js";
import type {
  CallSessionState,
  CallTranscriptTurn,
  CallTurnSettlement,
  GuidanceFrame,
  GuidanceEvaluationFact,
  RuntimePreparationContext,
} from "./types.js";

export interface ActiveCallRuntimeState {
  callSessionId: string;
  state: CallSessionState;
  runtimeEpoch: number;
  evidenceRevision: number;
  logicalRevision: number;
  activeMomentUnitId?: string;
  transcript: CallTranscriptTurn[];
  latestSettlement?: CallTurnSettlement;
  visibleGuidance: GuidanceFrame | null;
  guidanceRevision: number;
  activeOperations: Record<ModelRouteKind, string | null>;
  receipts: GuidanceReceipt[];
  humanEvaluations: GuidanceEvaluationFact[];
  preparation: RuntimePreparationContext;
  lastError?: string;
  updatedAt: number;
}

export type ActiveCallCommand =
  | { type: "StartCall"; occurredAt: number }
  | { type: "CaptureStarted"; occurredAt: number }
  | { type: "StartFailed"; error: string; occurredAt: number }
  | { type: "PauseCall"; occurredAt: number }
  | { type: "ResumeCall"; occurredAt: number }
  | { type: "RequireRecovery"; error: string; occurredAt: number }
  | { type: "SubmitTranscriptTurn"; turn: CallTranscriptTurn; momentUnitId: string }
  | { type: "ApplyRuntimeSettlement"; settlement: CallTurnSettlement }
  | { type: "SelectOperation"; route: ModelRouteKind; operationId: string; occurredAt: number }
  | { type: "RecordReceipt"; receipt: GuidanceReceipt }
  | { type: "CommitGuidance"; frame: GuidanceFrame; occurredAt: number }
  | { type: "RecordHumanOverride"; reason: string; occurredAt: number }
  | { type: "RecordHumanEvaluation"; fact: GuidanceEvaluationFact }
  | { type: "CloseCall"; occurredAt: number }
  | { type: "CloseSucceeded"; occurredAt: number }
  | { type: "CloseFailed"; error: string; occurredAt: number }
  | { type: "RetryCloseCall"; occurredAt: number }
  | { type: "AbandonCall"; occurredAt: number };

export interface ActiveCallTransition {
  command: ActiveCallCommand;
  before: ActiveCallRuntimeState;
  after: ActiveCallRuntimeState;
}

export type ActiveCallTransitionObserver = (
  transition: ActiveCallTransition
) => void;

export interface ActiveCallTransitionObserverBinding {
  ownerToken: string;
  detach: () => boolean;
}

const noOperations = (): Record<ModelRouteKind, string | null> => ({
  runtime: null,
  advisor: null,
  complex: null,
});

export function createActiveCallRuntimeState(input: {
  callSessionId: string;
  createdAt: number;
  preparation?: RuntimePreparationContext;
}): ActiveCallRuntimeState {
  const preparation = input.preparation ?? {
    mode: "neutral" as const,
    callSessionId: input.callSessionId,
    boundAt: input.createdAt,
  };
  if (preparation.callSessionId !== input.callSessionId) {
    throw new Error("Preparation context belongs to another CallSession.");
  }
  return {
    callSessionId: input.callSessionId,
    state: "planned",
    runtimeEpoch: 0,
    evidenceRevision: 0,
    logicalRevision: 0,
    transcript: [],
    visibleGuidance: null,
    guidanceRevision: 0,
    activeOperations: noOperations(),
    receipts: [],
    humanEvaluations: [],
    preparation: structuredClone(preparation),
    updatedAt: input.createdAt,
  };
}

const requireState = (
  state: ActiveCallRuntimeState,
  allowed: CallSessionState[],
  command: ActiveCallCommand["type"]
) => {
  if (!allowed.includes(state.state)) {
    throw new Error(`${command} is invalid while call is ${state.state}.`);
  }
};

export function reduceActiveCallRuntime(
  state: ActiveCallRuntimeState,
  command: ActiveCallCommand
): ActiveCallRuntimeState {
  switch (command.type) {
    case "StartCall":
      requireState(state, ["planned", "start-failed"], command.type);
      return { ...state, state: "starting", lastError: undefined, updatedAt: command.occurredAt };
    case "CaptureStarted":
      requireState(state, ["starting", "recovering"], command.type);
      return { ...state, state: "live", lastError: undefined, updatedAt: command.occurredAt };
    case "StartFailed":
      requireState(state, ["starting"], command.type);
      return { ...state, state: "start-failed", lastError: command.error, updatedAt: command.occurredAt };
    case "PauseCall":
      requireState(state, ["live"], command.type);
      return { ...state, state: "paused", runtimeEpoch: state.runtimeEpoch + 1, activeOperations: noOperations(), updatedAt: command.occurredAt };
    case "ResumeCall":
      requireState(state, ["paused", "recovering"], command.type);
      return { ...state, state: "recovering", runtimeEpoch: state.runtimeEpoch + 1, activeOperations: noOperations(), lastError: undefined, updatedAt: command.occurredAt };
    case "RequireRecovery":
      requireState(state, ["live", "starting", "recovering"], command.type);
      return { ...state, state: "recovering", runtimeEpoch: state.runtimeEpoch + 1, activeOperations: noOperations(), lastError: command.error, updatedAt: command.occurredAt };
    case "SubmitTranscriptTurn":
      requireState(state, ["live", "paused"], command.type);
      return {
        ...state,
        activeMomentUnitId: command.momentUnitId,
        evidenceRevision: state.evidenceRevision + 1,
        logicalRevision: state.logicalRevision + 1,
        transcript: [...state.transcript, structuredClone(command.turn)].slice(-80),
        activeOperations: noOperations(),
        updatedAt: command.turn.occurredAt,
      };
    case "ApplyRuntimeSettlement":
      if (
        command.settlement.callSessionId !== state.callSessionId ||
        command.settlement.momentUnitId !== state.activeMomentUnitId ||
        command.settlement.evidenceRevision !== state.evidenceRevision
      ) {
        return state;
      }
      return {
        ...state,
        latestSettlement: structuredClone(
          applyAdvisorAuthority(command.settlement)
        ),
        updatedAt: command.settlement.settledAt,
      };
    case "SelectOperation":
      return {
        ...state,
        activeOperations: { ...state.activeOperations, [command.route]: command.operationId },
        updatedAt: command.occurredAt,
      };
    case "RecordReceipt":
      return {
        ...state,
        receipts: [...state.receipts, { ...command.receipt }].slice(-500),
        updatedAt: command.receipt.occurredAt,
      };
    case "CommitGuidance":
      return {
        ...state,
        visibleGuidance: structuredClone(command.frame),
        guidanceRevision: state.guidanceRevision + 1,
        updatedAt: command.occurredAt,
      };
    case "RecordHumanOverride": {
      const receipt: GuidanceReceipt = {
        requestId: `human:${state.runtimeEpoch + 1}`,
        status: "cancelled",
        occurredAt: command.occurredAt,
        reason: command.reason,
      };
      return {
        ...state,
        runtimeEpoch: state.runtimeEpoch + 1,
        activeOperations: noOperations(),
        receipts: [...state.receipts, receipt].slice(-500),
        updatedAt: command.occurredAt,
      };
    }
    case "RecordHumanEvaluation":
      if (
        command.fact.callSessionId !== state.callSessionId ||
        command.fact.guidanceRevision < 1 ||
        command.fact.guidanceRevision > state.guidanceRevision
      ) {
        return state;
      }
      if (
        state.humanEvaluations.some(
          (candidate) =>
            candidate.guidanceRevision === command.fact.guidanceRevision
        )
      ) {
        return state;
      }
      return {
        ...state,
        humanEvaluations: [
          ...state.humanEvaluations,
          structuredClone(command.fact),
        ].slice(-500),
        updatedAt: command.fact.occurredAt,
      };
    case "CloseCall":
      requireState(state, ["live", "paused", "recovering", "start-failed"], command.type);
      return { ...state, state: "closing", runtimeEpoch: state.runtimeEpoch + 1, activeOperations: noOperations(), updatedAt: command.occurredAt };
    case "CloseSucceeded":
      requireState(state, ["closing"], command.type);
      return { ...state, state: "closed", lastError: undefined, updatedAt: command.occurredAt };
    case "CloseFailed":
      requireState(state, ["closing"], command.type);
      return { ...state, state: "close-failed", lastError: command.error, updatedAt: command.occurredAt };
    case "RetryCloseCall":
      requireState(state, ["close-failed"], command.type);
      return { ...state, state: "closing", lastError: undefined, updatedAt: command.occurredAt };
    case "AbandonCall":
      requireState(state, ["close-failed"], command.type);
      return { ...state, state: "abandoned", updatedAt: command.occurredAt };
  }
}

export class ActiveCallRuntime {
  #state: ActiveCallRuntimeState;
  readonly #guidance = new StableGuidanceStore();
  #transitionObserver?: {
    ownerToken: string;
    observer: ActiveCallTransitionObserver;
  };

  constructor(input: {
    callSessionId: string;
    createdAt?: number;
    preparation?: RuntimePreparationContext;
    onTransition?: ActiveCallTransitionObserver;
  }) {
    this.#state = createActiveCallRuntimeState({
      callSessionId: input.callSessionId,
      createdAt: input.createdAt ?? Date.now(),
      preparation: input.preparation,
    });
    if (input.onTransition) {
      this.#transitionObserver = {
        ownerToken: "constructor",
        observer: input.onTransition,
      };
    }
  }

  snapshot() {
    return structuredClone(this.#state);
  }

  bindTransitionObserver(
    ownerToken: string,
    observer: ActiveCallTransitionObserver
  ): ActiveCallTransitionObserverBinding {
    const normalizedOwnerToken = ownerToken.trim();
    if (!normalizedOwnerToken) {
      throw new Error("Transition observer owner token is required.");
    }
    const registration = { ownerToken: normalizedOwnerToken, observer };
    this.#transitionObserver = registration;
    return {
      ownerToken: normalizedOwnerToken,
      detach: () => {
        if (this.#transitionObserver !== registration) return false;
        this.#transitionObserver = undefined;
        return true;
      },
    };
  }

  dispatch(command: ActiveCallCommand) {
    const before = this.snapshot();
    this.#state = reduceActiveCallRuntime(this.#state, command);
    const after = this.snapshot();
    this.#transitionObserver?.observer({
      command: structuredClone(command),
      before,
      after,
    });
    return after;
  }

  selectOperation<TInput>(input: {
    operationId: string;
    operationKind: string;
    route: ModelRouteKind;
    contextSnapshotHash: string;
    timeoutMs: number;
    input: TInput;
    occurredAt?: number;
  }): RuntimeOperationEnvelope<TInput> {
    const envelope: RuntimeOperationEnvelope<TInput> = {
      operationId: input.operationId,
      operationKind: input.operationKind,
      route: input.route,
      callSessionId: this.#state.callSessionId,
      runtimeEpoch: this.#state.runtimeEpoch,
      momentUnitId: this.#state.activeMomentUnitId,
      evidenceRevision: this.#state.evidenceRevision,
      logicalRevision: this.#state.logicalRevision,
      contextSnapshotHash: input.contextSnapshotHash,
      timeoutMs: input.timeoutMs,
      input: structuredClone(input.input),
    };
    this.dispatch({
      type: "SelectOperation",
      route: input.route,
      operationId: input.operationId,
      occurredAt: input.occurredAt ?? Date.now(),
    });
    return envelope;
  }

  authorize(lease: OperationLease, route: ModelRouteKind) {
    return authorizeOperationCommit({
      lease,
      current: {
        callSessionId: this.#state.callSessionId,
        runtimeEpoch: this.#state.runtimeEpoch,
        momentUnitId: this.#state.activeMomentUnitId,
        evidenceRevision: this.#state.evidenceRevision,
        logicalRevision: this.#state.logicalRevision,
      },
      activeOperationId: this.#state.activeOperations[route],
      expectedRoute: route,
    });
  }

  commitGuidance(input: {
    envelope: RuntimeOperationEnvelope<unknown>;
    frame: unknown;
    occurredAt?: number;
  }) {
    const occurredAt = input.occurredAt ?? Date.now();
    const authorization = this.authorize(createOperationLease({ envelope: input.envelope }), "advisor");
    const committed = this.#guidance.commit({
      requestId: input.envelope.operationId,
      frame: input.frame,
      authorized: authorization.authorized,
      occurredAt,
    });
    const receipts = this.#guidance.receipts;
    const receipt = receipts[receipts.length - 1];
    if (receipt) this.dispatch({ type: "RecordReceipt", receipt });
    if (committed && this.#guidance.visible) {
      this.dispatch({ type: "CommitGuidance", frame: this.#guidance.visible, occurredAt });
    }
    return { committed, authorization };
  }
}
