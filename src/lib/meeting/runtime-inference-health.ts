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
  providerConfigFingerprint?: string;
}

export class RuntimeInferenceSessionCircuitBreaker {
  private states = new Map<
    string,
    RuntimeInferenceCircuitState
  >();

  read(
    operationKind: RuntimeInferenceOperationKind,
    sessionId: string,
    providerConfigFingerprint?: string
  ): RuntimeInferenceCircuitState {
    const key = this.ensureSession(operationKind, sessionId, providerConfigFingerprint);
    return { ...this.states.get(key)! };
  }

  open(input: {
    operationKind: RuntimeInferenceOperationKind;
    sessionId: string;
    reason: RuntimeInferenceCircuitReason;
    detail?: string;
    now?: number;
    providerConfigFingerprint?: string;
  }) {
    const key = this.ensureSession(input.operationKind, input.sessionId, input.providerConfigFingerprint);
    const current = this.states.get(key)!;
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
      ...(input.providerConfigFingerprint ? { providerConfigFingerprint: input.providerConfigFingerprint } : {}),
    };
    this.states.set(key, state);
    return { state: { ...state }, newlyOpened: true };
  }

  private ensureSession(
    operationKind: RuntimeInferenceOperationKind,
    sessionId: string,
    providerConfigFingerprint?: string
  ) {
    for (const [key, state] of this.states) {
      if (state.operationKind === operationKind && state.sessionId !== sessionId) this.states.delete(key);
    }
    const key = `${operationKind}:${providerConfigFingerprint ?? "default"}`;
    if (!this.states.has(key)) this.states.set(key, {
      operationKind, sessionId, open: false,
      ...(providerConfigFingerprint ? { providerConfigFingerprint } : {}),
    });
    return key;
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
    ...(state.providerConfigFingerprint ? { runtimeInferenceCircuitProviderConfigFingerprint: state.providerConfigFingerprint } : {}),
  };
}
