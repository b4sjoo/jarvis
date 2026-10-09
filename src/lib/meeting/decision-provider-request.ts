import type { RuntimeInferenceProviderAdmissionCoordinator, RuntimeInferenceSharedAdmissionReceipt } from "./runtime-inference-provider-admission.js";
import type { RuntimeInferenceLane, RuntimeInferenceProviderTier } from "./runtime-inference.js";

// One physical request, including queue time. The owner supplies the existing
// stage deadline. This function has no retry, fallback decision or stored state.
export async function runDecisionProviderRequest<T>(input: {
  operationId: string;
  admission: RuntimeInferenceProviderAdmissionCoordinator;
  providerConfigFingerprint: string;
  providerTier: RuntimeInferenceProviderTier;
  lane: RuntimeInferenceLane;
  deadlineAt: number;
  signal: AbortSignal;
  execute: (signal: AbortSignal) => Promise<T>;
  onAdmitted?: (receipt: RuntimeInferenceSharedAdmissionReceipt) => void;
}): Promise<T | undefined> {
  input.signal.throwIfAborted();
  if (Date.now() >= input.deadlineAt) return undefined;
  const controller = new AbortController();
  let close!: () => void;
  const closed = new Promise<undefined>(resolve => { close = () => resolve(undefined); });
  const abort = () => { controller.abort();close(); };
  input.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, Math.max(0, input.deadlineAt - Date.now()));
  try {
    const result = await Promise.race([input.admission.run({
      operationId: input.operationId, lane: input.lane, providerTier: input.providerTier,
      providerConfigFingerprint: input.providerConfigFingerprint, signal: controller.signal,
      onAdmitted: input.onAdmitted,
      execute: () => Date.now() >= input.deadlineAt || controller.signal.aborted ? Promise.resolve(undefined)
        : Promise.race([input.execute(controller.signal), closed]),
    }), closed]);
    input.signal.throwIfAborted();
    return result;
  } catch (error) {
    input.signal.throwIfAborted();
    if (controller.signal.aborted) return undefined;
    throw error;
  } finally {
    clearTimeout(timer);input.signal.removeEventListener("abort", abort);
  }
}
