import type { RuntimeInferenceOperationKind } from "./runtime-inference.js";

export type RuntimeInferenceCircuitReason =
  | "provider-auth-error"
  | "provider-configuration-error";

export interface RuntimeInferenceCircuitState {
  operationKind: RuntimeInferenceOperationKind;
  sessionId: string;
  open: boolean;
  reason?: RuntimeInferenceCircuitReason;
  detail?: string;
  openedAt?: number;
}

export class RuntimeInferenceSessionCircuitBreaker {
  private states = new Map<
    RuntimeInferenceOperationKind,
    RuntimeInferenceCircuitState
  >();

  read(
    operationKind: RuntimeInferenceOperationKind,
    sessionId: string
  ): RuntimeInferenceCircuitState {
    this.ensureSession(operationKind, sessionId);
    return { ...this.states.get(operationKind)! };
  }

  open(input: {
    operationKind: RuntimeInferenceOperationKind;
    sessionId: string;
    reason: RuntimeInferenceCircuitReason;
    detail?: string;
    now?: number;
  }) {
    this.ensureSession(input.operationKind, input.sessionId);
    const current = this.states.get(input.operationKind)!;
    if (current.open) {
      return { state: { ...current }, newlyOpened: false };
    }
    const state: RuntimeInferenceCircuitState = {
      operationKind: input.operationKind,
      sessionId: input.sessionId,
      open: true,
      reason: input.reason,
      detail: input.detail,
      openedAt: input.now ?? Date.now(),
    };
    this.states.set(input.operationKind, state);
    return { state: { ...state }, newlyOpened: true };
  }

  private ensureSession(
    operationKind: RuntimeInferenceOperationKind,
    sessionId: string
  ) {
    const current = this.states.get(operationKind);
    if (current?.sessionId === sessionId) return;
    this.states.set(operationKind, {
      operationKind,
      sessionId,
      open: false,
    });
  }
}

export function formatRuntimeInferenceCircuitForTrace(
  state: RuntimeInferenceCircuitState,
  newlyOpened = false
) {
  return {
    runtimeInferenceCircuitOperationKind: state.operationKind,
    runtimeInferenceCircuitSessionId: state.sessionId,
    runtimeInferenceCircuitOpen: state.open,
    runtimeInferenceCircuitReason: state.reason,
    runtimeInferenceCircuitDetail: state.detail,
    runtimeInferenceCircuitOpenedAt: state.openedAt,
    runtimeInferenceCircuitNewlyOpened: newlyOpened,
  };
}
