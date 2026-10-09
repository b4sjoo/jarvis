import type { AIResponseExecutionIdentityInput } from "../functions/ai-response-events.js";
import type { RuntimeInferenceModelRouteResolution } from "./meeting-model-route.js";
import type { RuntimeInferenceLane, RuntimeInferenceProviderTier } from "./runtime-inference.js";
import type { RuntimeInferenceAdmissionClock, RuntimeInferenceProviderAdmissionCoordinator, RuntimeInferenceSharedAdmissionReceipt } from "./runtime-inference-provider-admission.js";
import type { requestTaskRelationSplitShadow, TaskRelationCandidateSelectionReason, TaskRelationSplitShadowRequestResult } from "./task-relation-split-shadow-request.js";
import type { TaskRelationAffinityRequest, TaskRelationCanonicalShadowRequest } from "./task-relation-split-shadow.js";
import type { RuntimeInferenceProviderResponse } from "./runtime-inference-response.js";

export interface TaskRelationCandidateObservation {
  operationId: string;
  requestId: string;
  providerTier: RuntimeInferenceProviderTier;
  providerId?: string;
  configFingerprint: string;
  deadlineAt: number;
  queuedAt: number;
  at: number;
  event: "queued" | "admitted" | "completed" | "selected" | "cancelled";
  admission?: RuntimeInferenceSharedAdmissionReceipt;
  result?: TaskRelationSplitShadowRequestResult;
  error?: string;
  role?: "decision" | "evidence";
  evidenceResponse?: RuntimeInferenceProviderResponse;
}

export interface TaskRelationCandidateSelection extends TaskRelationSplitShadowRequestResult {
  selectedProviderTier?: RuntimeInferenceProviderTier;
  stageDeadlineAt: number;
  selectionReason: TaskRelationCandidateSelectionReason;
}

const CLOCK: RuntimeInferenceAdmissionClock = {
  now: () => Date.now(), schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const abortError = () => Object.assign(new Error("Relation operation cancelled"), { name: "AbortError" });

// One logical operation owns publication; each physical candidate owns admission.
export function requestTaskRelationProviderCandidates(input: {
  request: TaskRelationAffinityRequest | TaskRelationCanonicalShadowRequest;
  operationId: string;
  routes: Record<RuntimeInferenceProviderTier, RuntimeInferenceModelRouteResolution>;
  admission: RuntimeInferenceProviderAdmissionCoordinator;
  lane: RuntimeInferenceLane;
  deadlineAt: number;
  signal: AbortSignal;
  executionIdentity: AIResponseExecutionIdentityInput;
  onObservation?: (event: TaskRelationCandidateObservation) => void;
}, dependencies: {
  clock?: RuntimeInferenceAdmissionClock;
  request: typeof requestTaskRelationSplitShadow;
}): Promise<TaskRelationCandidateSelection> {
  const clock = dependencies.clock ?? CLOCK;
  const request = dependencies.request;
  const queuedAt = clock.now();
  const controllers = { intelligent: new AbortController(), fast: new AbortController() };
  const outcomes: Partial<Record<RuntimeInferenceProviderTier, TaskRelationSplitShadowRequestResult>> = {};
  const completedAt: Partial<Record<RuntimeInferenceProviderTier, number>> = {};
  const ended = new Set<RuntimeInferenceProviderTier>();
  let closed = false;
  let timer: unknown;
  // Observations are evidence only: a failing sink can neither leave the stage
  // unsettled nor change which candidate is selected. The failure is reported.
  const observe = (tier: RuntimeInferenceProviderTier, event: TaskRelationCandidateObservation["event"], extra: Partial<TaskRelationCandidateObservation> = {}) => {
    try {
      const route = input.routes[tier];
      input.onObservation?.({ operationId: input.operationId, requestId: `${input.operationId}:${tier}`,
        providerTier: tier, providerId: route.resolvedProviderId, configFingerprint: route.configFingerprint,
        deadlineAt: input.deadlineAt, queuedAt, at: extra.at ?? clock.now(), event, ...extra });
    } catch (error) {
      console.warn("Relation candidate observation callback failed", error);
    }
  };
  return new Promise((resolve, reject) => {
    const close = () => {
      closed = true;
      if (timer !== undefined) clock.cancel(timer);
      input.signal.removeEventListener("abort", cancel);
      for (const tier of ["intelligent", "fast"] as const) {
        if (!ended.has(tier)) observe(tier, "cancelled");
        controllers[tier].abort();
      }
    };
    const fail = (error: unknown) => { if (!closed) { close(); reject(error); } };
    const cancel = () => fail(abortError());
    // The reason is an argument only: each call site names the branch it is in.
    const finish = (tier: RuntimeInferenceProviderTier | undefined, selectionReason: TaskRelationCandidateSelectionReason) => {
      if (closed) return;
      if (input.signal.aborted) { cancel(); return; }
      const result = tier ? outcomes[tier] : outcomes.intelligent ?? outcomes.fast;
      if (tier) observe(tier, "selected", { result });
      close();
      resolve({ ...(result ?? {
        rawOutput: "", parsed: { ok: false as const, reason: "candidate-deadline-expired", errorKind: "provider" as const, evidenceSpansValid: false as const },
        providerDisposition: "provider-error-content" as const, parseDisposition: "candidate-deadline-expired", completedAt: clock.now(),
      }), selectedProviderTier: tier, selectedCandidateCompletedAt: tier ? completedAt[tier] : undefined,
        stageDeadlineAt: input.deadlineAt, selectionReason });
    };
    if (input.signal.aborted) { cancel(); return; }
    if (queuedAt >= input.deadlineAt) { finish(undefined, "candidate-deadline-expired"); return; }
    input.signal.addEventListener("abort", cancel, { once: true });
    // The deadline is absolute: time already spent before this registration is not regained.
    timer = clock.schedule(() => finish(outcomes.fast?.parsed.ok ? "fast" : undefined, "candidate-deadline-expired"),
      Math.max(0, input.deadlineAt - clock.now()));
    for (const tier of ["intelligent", "fast"] as const) {
      const route = input.routes[tier];
      if (!route.provider) { fail(new Error(`Relation ${tier} provider configuration unavailable`)); return; }
      observe(tier, "queued");
      void input.admission.run({ operationId: `${input.operationId}:${tier}`, providerTier: tier, lane: input.lane,
        signal: controllers[tier].signal,
        onAdmitted: admission => observe(tier, "admitted", { admission }),
        execute: () => {
          const remaining = input.deadlineAt - clock.now();
          if (closed || input.signal.aborted) throw abortError();
          if (remaining <= 0) {
            finish(outcomes.fast?.parsed.ok ? "fast" : undefined, "candidate-deadline-expired");
            throw abortError();
          }
          return request({ request: input.request, provider: route.provider, selectedProvider: route.selectedProvider,
            signal: controllers[tier].signal, timeoutMs: remaining,
            executionIdentity: { ...input.executionIdentity, requestId: `${input.operationId}:${tier}`, modelId: undefined } });
        },
      }).then(result => {
        // One clock read per completion callback, taken before the observation
        // sink runs: within this callback the observation, the deadline check and
        // the completion stamp use that one value, so this callback's own sink
        // cost cannot change its candidate's fate. A sink cost that delays a
        // sibling candidate's callback past the deadline is event-loop delay and
        // is treated like any other late callback.
        const at = clock.now();
        ended.add(tier);
        observe(tier, "completed", { result, at });
        if (closed) return;
        if (input.signal.aborted) { cancel(); return; }
        if (at >= input.deadlineAt) {
          finish(outcomes.fast?.parsed.ok ? "fast" : undefined, "candidate-deadline-expired");
          return;
        }
        const failure = result.providerOutcome?.failureClass;
        if (failure === "unexpected") { fail(new Error(result.providerOutcome?.safeErrorSummary ?? "Internal Relation candidate failure")); return; }
        outcomes[tier] = result;
        completedAt[tier] = at;
        if (failure === "authentication" || failure === "configuration" || result.providerDisposition === "provider-auth-error") {
          finish(tier, "client-error"); return;
        }
        if (outcomes.intelligent?.parsed.ok) { finish("intelligent", "intelligent-valid"); return; }
        if (ended.has("intelligent") && outcomes.fast?.parsed.ok) { finish("fast", "intelligent-invalid-fast-valid"); return; }
        if (ended.size === 2) finish(undefined, "candidates-ended-unusable");
      }, error => {
        ended.add(tier);
        observe(tier, "completed", { error: error instanceof Error ? error.message : String(error) });
        if (!closed) fail(error);
      });
    }
  });
}
