import type {
  RuntimeCriticalEventDelivery,
  RuntimeCriticalEventListener,
  RuntimeCriticalEventSubscription,
  RuntimeCriticalEventV1,
} from "./runtime-critical-event.js";

export type RuntimeRegressionCompletionRoot =
  | { traceId: string }
  | { manualAction: string }
  | { screen: true };

export interface RuntimeRegressionCompletion {
  disposition: "visible" | "committed-hidden" | "completed" | "suppressed" | "error" | "rejected" | "cancelled" | "stale";
  traceId?: string;
  stableRevision?: number;
  suggestionId?: string;
  reason?: string;
  facts: readonly RuntimeCriticalEventV1[];
}

// A test consumer of existing owner receipts. It cannot authorize work or infer
// a completion from a Trace/UI snapshot. Subscribe before dispatching the input.
export function waitForRuntimeRegressionCompletion(input: {
  subscribe: (listener: RuntimeCriticalEventListener) => RuntimeCriticalEventSubscription;
  runtimeSessionId: string;
  runtimeEpoch: number;
  root: RuntimeRegressionCompletionRoot;
  waitForDisplay: boolean;
  timeoutMs?: number;
}) {
  const events: RuntimeCriticalEventV1[] = [];
  let root: RuntimeCriticalEventV1 | undefined;
  let subscription: RuntimeCriticalEventSubscription | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  let displayTarget: { suggestionId: string; stableRevision: number } | undefined;
  let dispatched = false;
  let resolve!: (value: RuntimeRegressionCompletion) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<RuntimeRegressionCompletion>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => undefined);
  const finish = (value: RuntimeRegressionCompletion | Error) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    subscription?.unsubscribe();
    if (value instanceof Error) reject(value);
    else resolve(value);
  };
  const matchesRoot = (event: RuntimeCriticalEventV1) => {
    if ("traceId" in input.root) return event.refs.traceId === input.root.traceId;
    if ("manualAction" in input.root) return event.refs.manualAction === input.root.manualAction && Boolean(event.refs.manualActionId);
    return event.fact === "input-accepted" && event.refs.sourceKind === "screen" && Boolean(event.refs.operationId);
  };
  const check = () => {
    if (!dispatched || !root || done) return;
    const command = events.find(event => event.fact === "terminal" && (
      "traceId" in input.root ? event.terminal?.object === "turn-input" && event.refs.traceId === input.root.traceId
        : "manualAction" in input.root ? event.terminal?.object === "manual-action" && event.refs.manualActionId === root!.refs.manualActionId
        : event.terminal?.object === "screen-operation" && event.refs.operationId === root!.refs.operationId
    ));
    const traceId = command?.refs.traceId ?? root.refs.traceId;
    const admitted = events.find(event => event.fact === "generation-admitted" && event.refs.traceId === traceId);
    const terminal = admitted ? events.find(event => event.fact === "terminal" && event.terminal?.object === "generation" &&
      event.refs.generationLeaseId === admitted.refs.generationLeaseId) : undefined;
    const stable = events.find(event => event.fact === "stable-answer-committed" && event.refs.traceId === traceId);
    const outcome = terminal?.terminal?.disposition ?? command?.terminal?.disposition;
    if (!outcome) return;
    if (["failed", "error", "rejected", "timed-out", "cancelled", "aborted", "superseded", "stale", "stale-rejected"].includes(outcome)) {
      finish({ disposition: ["stale", "stale-rejected", "superseded"].includes(outcome) ? "stale"
        : ["cancelled", "aborted"].includes(outcome) ? "cancelled" : outcome === "rejected" ? "rejected" : "error",
        traceId, reason: terminal?.terminal?.reason ?? command?.terminal?.reason ?? outcome, facts: events.slice() });
      return;
    }
    if (admitted && (!terminal || !stable)) return;
    if (!("traceId" in input.root) && !command) return;
    if (admitted ? outcome !== "committed" : !["completed", "released"].includes(outcome)) {
      finish(new Error(`Unsupported replay terminal: ${outcome}.`));
      return;
    }
    if (command?.terminal?.object === "screen-operation" && command.terminal.reason) {
      finish({ disposition: "error", traceId, reason: command.terminal.reason, facts: events.slice() });
      return;
    }
    const target = displayTarget ?? (stable?.refs.suggestionId && stable.refs.stableRevision !== undefined
      ? { suggestionId: stable.refs.suggestionId, stableRevision: stable.refs.stableRevision } : undefined);
    const applied = target && events.find(event => event.fact === "stable-answer-applied" &&
      event.refs.suggestionId === target.suggestionId && event.refs.stableRevision === target.stableRevision);
    if (input.waitForDisplay && (stable || displayTarget) && !applied) return;
    finish({ disposition: stable ? (applied ? "visible" : "committed-hidden")
      : "traceId" in input.root ? "suppressed" : "completed", traceId,
      stableRevision: target?.stableRevision, suggestionId: target?.suggestionId, facts: events.slice() });
  };
  const receive = (delivery: RuntimeCriticalEventDelivery) => {
    if (done) return;
    if (delivery.kind !== "event") {
      finish(new Error(`Replay event subscription ${delivery.kind}.`));
      return;
    }
    const event = delivery.event;
    if (event.runtimeSessionId !== input.runtimeSessionId || event.purpose !== "formal" ||
      (event.runtimeEpoch !== undefined && event.runtimeEpoch !== input.runtimeEpoch)) return;
    if (!["input-accepted", "generation-admitted", "stable-answer-committed", "stable-answer-applied", "terminal"].includes(event.fact) ||
      (event.fact === "terminal" && !["generation", "turn-input", "screen-operation", "manual-action"].includes(event.terminal!.object))) return;
    const correlationKeys = ["traceId", "operationId", "manualActionId", "generationLeaseId", "suggestionId", "stableRevision"];
    if (events.length >= 256 || [...(event.omittedRefs ?? []), ...(event.digestedRefs ?? [])].some(key => correlationKeys.includes(key))) {
      finish(new Error("Replay completion evidence is incomplete."));
      return;
    }
    events.push(event);
    root ??= matchesRoot(event) ? event : undefined;
    check();
  };
  subscription = input.subscribe(receive);
  if (done) subscription.unsubscribe();
  else if (!subscription.accepted || subscription.runtimeSessionId !== input.runtimeSessionId) {
    finish(new Error(`Replay subscription refused: ${subscription.reason ?? "session-mismatch"}.`));
  } else {
    timer = setTimeout(() => finish(new Error("Runtime regression step timed out.")), input.timeoutMs ?? 180_000);
  }
  return {
    accepted: !done && subscription.accepted,
    promise,
    // This only releases the callback stack; the owner's terminal is still mandatory.
    dispatched(target?: { suggestionId: string; stableRevision: number }) { displayTarget = target; dispatched = true; check(); },
    cancel(reason = "Runtime regression run stopped.") { finish(new Error(reason)); },
  };
}
