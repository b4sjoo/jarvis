// Task 178A: minimal critical runtime event contract.
//
// A leaf module. It owns the event value, the bounded read-only delivery and
// the journal reader. It never reads or writes business state: producers hand
// it an already confirmed fact, and nothing in the runtime reads this stream to
// decide its next step.
//
// Lifecycle. bind() where a runtime session id comes into being; a different
// id ends the previous session, discards what was still queued for its
// subscribers and restarts the sequence. closeSubscriptions() at Stop: the
// stopped run's subscribers get one closed marker, the session keeps accepting
// its own later facts. release() at unmount drops everything, with no marker.

export const RUNTIME_CRITICAL_EVENT_SCHEMA_VERSION = 1 as const;

export const RUNTIME_CRITICAL_EVENT_JOURNAL_PATH =
  "runtime-events/critical-events.v1.jsonl";

export const RUNTIME_CRITICAL_FACT_KINDS = [
  "input-accepted",
  "lqu-committed",
  "type-settled",
  "relation-settled",
  "lifecycle-committed",
  "generation-admitted",
  "provider-request-started",
  "stable-answer-committed",
  "artifact-committed",
  "first-visible-content",
  "stable-answer-applied",
  "terminal",
] as const;

export type RuntimeCriticalFactKind =
  (typeof RUNTIME_CRITICAL_FACT_KINDS)[number];

export type RuntimeCriticalEventPurpose = "formal" | "observation";

export const RUNTIME_CRITICAL_TERMINAL_OBJECTS = [
  "provider-request",
  "generation",
  "screen-operation",
  "manual-action",
  "lifecycle-transition",
  "turn-input",
] as const;

export type RuntimeCriticalTerminalObject =
  (typeof RUNTIME_CRITICAL_TERMINAL_OBJECTS)[number];

// Frozen from the bounded arrival shape. A test asserts every value exactly.
export const RUNTIME_CRITICAL_EVENT_LIMITS = Object.freeze({
  queueCapacity: 256,
  deliveryBatchSize: 32,
  maxEventJsonChars: 2048,
  maxReferenceChars: 128,
  maxSourceReferences: 8,
  maxSubscribers: 2,
  maxFailureDetails: 8,
  maxFailureDetailChars: 120,
  // Per first-key family, most recently used first-keys kept.
  maxFirstKeys: 512,
  // The longest owner identifier still carried, as a bounded digest.
  maxIdentifierSourceChars: 512,
});

export type RuntimeCriticalEventLimits = {
  -readonly [Key in keyof typeof RUNTIME_CRITICAL_EVENT_LIMITS]: number;
};

const GAP_REASONS = ["queue-overflow", "payload-limit"] as const;

// The hard bound of the delivery queue. Events are queued only below
// queueCapacity. Markers may exceed it by a fixed amount: one subscription
// cohort holds at most one gap marker per reason at its tail plus one closed
// marker, and at most maxSubscribers cohorts can be waiting for delivery.
// With the frozen limits that is 256 + (2 + 1) * 2 = 262 items.
export function runtimeCriticalEventQueueDepthBound(
  limits: Pick<
    RuntimeCriticalEventLimits,
    "queueCapacity" | "maxSubscribers"
  > = RUNTIME_CRITICAL_EVENT_LIMITS
) {
  return limits.queueCapacity + (GAP_REASONS.length + 1) * limits.maxSubscribers;
}

// Owner identifiers. One longer than the bound is carried as a bounded digest.
const IDENTIFIER_REFERENCE_KEYS = [
  "traceId",
  "operationId",
  "requestId",
  "attemptId",
  "executionPlanId",
  "turnId",
  "logicalQuestionUnitId",
  "settlementId",
  "receiptId",
  "taskId",
  "generationLeaseId",
  "advisorJobId",
  "suggestionId",
  "generationId",
  "manualActionId",
  "scenarioRunId",
  "scenarioStepId",
] as const;

// Short owner codes. Anything that is not shaped like a code is refused.
const CODE_REFERENCE_KEYS = [
  "operationKind",
  "providerTier",
  "sourceKind",
  "transport",
  "speaker",
  "questionType",
  "relation",
  "authoritySource",
  "transition",
  "artifact",
  "displaySurface",
  "manualAction",
] as const;

const NUMBER_REFERENCE_KEYS = [
  "logicalQuestionRevision",
  "taskRuntimeRevision",
  "stableRevision",
  "artifactRevision",
  "attemptNumber",
] as const;

const LIST_REFERENCE_KEYS = ["sourceTurnIds", "sourceObservationIds"] as const;

type IdentifierReferenceKey = (typeof IDENTIFIER_REFERENCE_KEYS)[number];
type StringReferenceKey =
  | IdentifierReferenceKey
  | (typeof CODE_REFERENCE_KEYS)[number];
type NumberReferenceKey = (typeof NUMBER_REFERENCE_KEYS)[number];
type ListReferenceKey = (typeof LIST_REFERENCE_KEYS)[number];

// References only: identifiers, revisions and short owner codes. Never a
// Trace, Context, Prompt, Answer, media payload, secret or live object.
export type RuntimeCriticalEventRefs = {
  readonly [Key in StringReferenceKey]?: string;
} & {
  readonly [Key in NumberReferenceKey]?: number;
} & {
  readonly [Key in ListReferenceKey]?: readonly string[];
};

export type RuntimeCriticalEventRefsInput = {
  [Key in StringReferenceKey]?: string | null;
} & {
  [Key in NumberReferenceKey]?: number | null;
} & {
  [Key in ListReferenceKey]?: readonly string[] | null;
};

export interface RuntimeCriticalEventTerminal {
  readonly object: RuntimeCriticalTerminalObject;
  readonly disposition: string;
  readonly reason?: string;
}

// Reading the facts. Each one is what its owner confirmed, no more.
// - turn-input terminals come from the canonical input's own non-generation
//   exits (including deferred buffer release/cancellation). They do not predict
//   a model result or the later effects of another input.
// - stable-answer-applied is the display owner's ACK of an exact stable version,
//   including a later reapplication after unlock. first-visible-content keeps
//   its separate first-frame meaning; neither is inferred from a commit.
// - provider-request-started is followed by a provider-request terminal only
//   when the owner's terminal callback ran. A request whose consumer left its
//   stream first (a stale partial output) has no provider terminal: its end is
//   the generation terminal that carries the same generationLeaseId. A wait
//   for the end of a started request ends on either.
// - type-settled and relation-settled name a settlement and the value one
//   assignment of the session's current settlement adopted. A fact is produced
//   when the assignment changes that settlement's adopted Type or Relation,
//   and when it adopts another settlement than the one last adopted in this
//   runtime session, also one whose values were announced before (a
//   regenerate that adopts an earlier settlement again). Assigning the current
//   settlement again with the value already announced says nothing. So the
//   last type-settled and the last relation-settled fact of a session name
//   the session's current settlement and the value it adopts now.
// - a run can assign its settlement more than once. Stage settlement-adopted
//   is an assignment of the run's own settlement, effective-settlement-adopted
//   an assignment of the run's effective view of it, and
//   manual-retype-projection follows a manual retype of the settlement's
//   owner. A run that adopts at once announces its own settlement first and
//   then its effective view, when that changes a value. A run whose adoption
//   waited for its Response Opportunity adopts once, after its effective view
//   replaced its own settlement: that one announcement carries
//   effective-settlement-adopted. A wait for one adopted value names the value
//   or the stage, not the first fact.
// - a claimed Screen operation ends with one screen-operation terminal, the
//   first one its flow reached, unless the runtime session changed before the
//   flow ended (the terminal is then refused like any fact of an ended
//   session). Disposition released is the operation leaving the slot it still
//   owned. With no reason its flow ran to its end, and the facts before the
//   terminal say what it produced. A reason names a flow that did not:
//   capture-failed (the capture failed), capture-not-completed (it ended
//   before an observation existed, with no error), operation-error (it ended
//   with an error after the capture) or cancelled (it ended after the capture
//   with no error, before its flow's end). Dispositions superseded and
//   stale-rejected name an operation that lost its authority, with the reason
//   its flow read: under stage screen-operation-authorization at one of the
//   flow's boundaries, under stage screen-operation-exit when the flow ended
//   after a newer capture, Pause, Stop or Clear Task had taken its slot.
export interface RuntimeCriticalEventV1 {
  readonly schemaVersion: typeof RUNTIME_CRITICAL_EVENT_SCHEMA_VERSION;
  readonly eventId: string;
  // Order in which this interface observed facts of one runtime session. It is
  // not a business priority, a cross-thread clock or a causal claim.
  readonly sequence: number;
  readonly occurredAt: number;
  readonly runtimeSessionId: string;
  readonly runtimeEpoch?: number;
  readonly fact: RuntimeCriticalFactKind;
  readonly stage: string;
  readonly purpose: RuntimeCriticalEventPurpose;
  readonly terminal?: RuntimeCriticalEventTerminal;
  readonly refs: RuntimeCriticalEventRefs;
  // Names of references the producer held but the bounded contract refused.
  readonly omittedRefs?: readonly string[];
  // Names of identifier references carried as a bounded digest of the owner's
  // longer identifier. Equal identifiers give equal digests, so a start still
  // pairs with its terminal; the value is not the owner's raw identifier.
  readonly digestedRefs?: readonly string[];
}

export interface RuntimeCriticalEventInput {
  fact: RuntimeCriticalFactKind;
  stage: string;
  purpose: RuntimeCriticalEventPurpose;
  // The fact's own session and epoch, from its token, job, lease or receipt.
  runtimeSessionId: string | null | undefined;
  runtimeEpoch?: number | null;
  // The owner's own time for the fact. Defaults to the injected clock.
  occurredAt?: number | null;
  terminal?: {
    object: RuntimeCriticalTerminalObject;
    disposition: string;
    reason?: string | null;
  };
  refs?: RuntimeCriticalEventRefsInput;
}

export type RuntimeCriticalEventGapReason = (typeof GAP_REASONS)[number];

// One marker for a run of lost deliveries of one reason. The sequences span
// the run; count is how many of them were lost for this reason.
export interface RuntimeCriticalEventGapV1 {
  readonly kind: "gap";
  readonly schemaVersion: typeof RUNTIME_CRITICAL_EVENT_SCHEMA_VERSION;
  readonly runtimeSessionId: string;
  readonly reason: RuntimeCriticalEventGapReason;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly count: number;
}

// The end of a subscription, delivered once. After Stop the subscription first
// receives what was queued for it, and discarded is 0. After a session change
// it does not: a consumer is never handed a fact of a session that has ended
// once the next session is bound. discarded then counts the facts it was not
// handed: the events still queued for it and the events of each gap marker
// still queued. The reason is the first thing that ended the subscription. An
// unmount (release) delivers no closed marker: the subscription just ends.
export interface RuntimeCriticalEventClosedV1 {
  readonly kind: "closed";
  readonly schemaVersion: typeof RUNTIME_CRITICAL_EVENT_SCHEMA_VERSION;
  readonly runtimeSessionId: string;
  readonly reason: string;
  readonly lastSequence: number;
  readonly discarded: number;
}

export interface RuntimeCriticalEventDeliveredV1 {
  readonly kind: "event";
  readonly event: RuntimeCriticalEventV1;
}

export type RuntimeCriticalEventDelivery =
  | RuntimeCriticalEventDeliveredV1
  | RuntimeCriticalEventGapV1
  | RuntimeCriticalEventClosedV1;

// A listener may be async. One that throws, or whose returned promise rejects,
// is cut off: it receives nothing further and one failure is counted.
export type RuntimeCriticalEventListener = (
  delivery: RuntimeCriticalEventDelivery
) => void | PromiseLike<void>;

export interface RuntimeCriticalEventSubscription {
  readonly accepted: boolean;
  readonly reason?: "not-accepting" | "subscriber-limit";
  readonly runtimeSessionId?: string;
  unsubscribe(): void;
}

export interface RuntimeCriticalEventClock {
  now(): number;
  // One macrotask. Delivery never runs inside the producer's stack.
  schedule(callback: () => void): unknown;
  cancel(handle: unknown): void;
}

// What the Recording owner answered synchronously. "accepted" means its write
// queue took the line; it does not mean the line is on disk. A write that
// fails later is reported only by the recording's own integrity block.
export type RuntimeCriticalEventRecordingDisposition =
  | "accepted"
  | "not-recording"
  | "rejected-late"
  | "failed";

export interface RuntimeCriticalEventFailureDetail {
  readonly kind: "construction" | "subscriber" | "recording" | "schedule";
  readonly message: string;
}

export interface RuntimeCriticalEventStats {
  readonly boundSessionId?: string;
  readonly accepting: boolean;
  readonly lastSequence: number;
  readonly produced: number;
  readonly delivered: number;
  readonly duplicateSuppressed: number;
  readonly staleSessionRejected: number;
  readonly unboundRejected: number;
  readonly lateAfterClose: number;
  readonly missingIdentityRejected: number;
  readonly constructionFailures: number;
  readonly payloadDropped: number;
  readonly overflowDropped: number;
  readonly referencesOmitted: number;
  readonly referencesDigested: number;
  readonly gapMarkers: number;
  readonly subscriberFailures: number;
  readonly subscriberRejected: number;
  readonly scheduleFailures: number;
  readonly discardedUndelivered: number;
  readonly subscribers: number;
  readonly queueDepth: number;
  readonly queuePeak: number;
  // Entries of the first-key guard: the keys of the four families and, per
  // settlement fact and purpose, the settlement last adopted (at most four).
  readonly retainedFirstKeys: number;
  // First-keys that left the bounded guard. A repeat of an evicted key is
  // produced again, so a non-zero value marks the first-only evidence as
  // bounded to the most recently used keys.
  readonly firstKeysEvicted: number;
  readonly drainsScheduled: number;
  readonly recording: Readonly<
    Record<RuntimeCriticalEventRecordingDisposition, number>
  >;
  readonly failureDetails: readonly RuntimeCriticalEventFailureDetail[];
  readonly failureDetailsTruncated: boolean;
}

const SYSTEM_CLOCK: RuntimeCriticalEventClock = {
  now: () => Date.now(),
  schedule: (callback) => setTimeout(callback, 0),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const FACT_KINDS = new Set<string>(RUNTIME_CRITICAL_FACT_KINDS);
const TERMINAL_OBJECTS = new Set<string>(RUNTIME_CRITICAL_TERMINAL_OBJECTS);

// The reference that identifies the terminal object in its owner's terms.
const TERMINAL_OBJECT_REFERENCE: Record<
  RuntimeCriticalTerminalObject,
  readonly StringReferenceKey[]
> = {
  "provider-request": ["attemptId", "requestId"],
  generation: ["generationLeaseId"],
  "screen-operation": ["operationId"],
  "manual-action": ["manualActionId"],
  "lifecycle-transition": ["receiptId"],
  "turn-input": ["traceId"],
};

// Subscriptions belong to a cohort. Stop and a session change end the cohort
// with one closed marker and nothing produced later: after Stop its subscribers
// first receive what was queued for them, after a session change they do not.
// Release ends it with nothing. A subscriber that joins afterwards is in the
// next cohort and never sees the previous cohort's deliveries.
interface Subscriber {
  cohort: number;
  sessionId: string;
  listener: RuntimeCriticalEventListener;
  failed: boolean;
}

type MutableGap = {
  -readonly [Key in keyof RuntimeCriticalEventGapV1]: RuntimeCriticalEventGapV1[Key];
};

type QueueItem =
  | RuntimeCriticalEventDeliveredV1
  | MutableGap
  | RuntimeCriticalEventClosedV1;

interface QueueEntry {
  cohort: number;
  item: QueueItem;
}

const FIRST_KEY_FAMILIES = ["lqu", "settlement", "visible", "terminal"] as const;
type FirstKeyFamily = (typeof FIRST_KEY_FAMILIES)[number];

// A key and the value announced under it. For a first-only fact the value is
// constant: the key is produced once. For a settlement the value is the adopted
// Type or Relation last announced for that settlement, and adoption names the
// settlement this assignment makes the current one of its fact and purpose.
type FirstKeyResolution =
  | { kind: "none" }
  | { kind: "missing" }
  | {
      kind: "key";
      family: FirstKeyFamily;
      key: string;
      value: string;
      adoption?: { scope: string; settlementId: string };
    };

const FIRST_ONLY = "";

function newFirstKeys(): Record<FirstKeyFamily, Map<string, string>> {
  return {
    lqu: new Map(),
    settlement: new Map(),
    visible: new Map(),
    terminal: new Map(),
  };
}

// A short owner code: a stage, a disposition, a reason or a kind. Free text,
// such as an error message, has spaces and is not a code.
const OWNER_CODE = /^[A-Za-z0-9][A-Za-z0-9._:/+@#=-]*$/;

const DIGEST_CHARS = 16;

// Deterministic 64-bit text digest (two mixed 32-bit lanes). It only has to
// keep equal identifiers equal and different ones apart within one session.
function digestText(value: string) {
  let high = 0xdeadbeef;
  let low = 0x41c6ce57;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    high = Math.imul(high ^ code, 2654435761);
    low = Math.imul(low ^ code, 1597334677);
  }
  high =
    Math.imul(high ^ (high >>> 16), 2246822507) ^
    Math.imul(low ^ (low >>> 13), 3266489909);
  low =
    Math.imul(low ^ (low >>> 16), 2246822507) ^
    Math.imul(high ^ (high >>> 13), 3266489909);
  return (
    (low >>> 0).toString(16).padStart(8, "0") +
    (high >>> 0).toString(16).padStart(8, "0")
  );
}

function boundIdentifierText(
  value: string,
  limits: Pick<
    RuntimeCriticalEventLimits,
    "maxReferenceChars" | "maxIdentifierSourceChars"
  >
) {
  const max = limits.maxReferenceChars;
  if (value.length <= max) return { text: value, digested: false };
  if (value.length > limits.maxIdentifierSourceChars || max <= DIGEST_CHARS + 1) {
    return undefined;
  }
  return {
    text: `${value.slice(0, max - DIGEST_CHARS - 1)}~${digestText(value)}`,
    digested: true,
  };
}

// The reference under which an event carries an owner identifier: the
// identifier itself when it fits the bound, its bounded digest when it is
// longer, undefined when it is too long to carry. Pure. A reader that holds
// the owner's raw identifier (from a trace file) uses it to find the journal
// lines that name that identifier.
export function runtimeCriticalEventIdentifierReference(
  identifier: string,
  limits: Pick<
    RuntimeCriticalEventLimits,
    "maxReferenceChars" | "maxIdentifierSourceChars"
  > = RUNTIME_CRITICAL_EVENT_LIMITS
): string | undefined {
  if (typeof identifier !== "string" || !identifier) return undefined;
  return boundIdentifierText(identifier, limits)?.text;
}

export class RuntimeCriticalEventStream {
  private readonly clock: RuntimeCriticalEventClock;
  private readonly limits: Readonly<RuntimeCriticalEventLimits>;
  private boundSessionId: string | undefined;
  private accepting = false;
  private sequence = 0;
  private cohort = 0;
  private firstKeys = newFirstKeys();
  // The settlement last adopted in this runtime session, per settlement fact
  // and purpose: at most four entries, each a bounded identifier.
  private lastAdoptedSettlement = new Map<string, string>();
  private subscribers: Subscriber[] = [];
  private queue: QueueEntry[] = [];
  private drainHandle: unknown;
  private drainScheduled = false;
  private failureDetails: RuntimeCriticalEventFailureDetail[] = [];
  private failureDetailsTruncated = false;
  private counters = {
    produced: 0,
    delivered: 0,
    duplicateSuppressed: 0,
    staleSessionRejected: 0,
    unboundRejected: 0,
    lateAfterClose: 0,
    missingIdentityRejected: 0,
    constructionFailures: 0,
    payloadDropped: 0,
    overflowDropped: 0,
    referencesOmitted: 0,
    referencesDigested: 0,
    gapMarkers: 0,
    subscriberFailures: 0,
    subscriberRejected: 0,
    scheduleFailures: 0,
    discardedUndelivered: 0,
    queuePeak: 0,
    firstKeysEvicted: 0,
    drainsScheduled: 0,
  };
  private recording: Record<RuntimeCriticalEventRecordingDisposition, number> = {
    accepted: 0,
    "not-recording": 0,
    "rejected-late": 0,
    failed: 0,
  };

  constructor(
    options: {
      clock?: RuntimeCriticalEventClock;
      limits?: Partial<RuntimeCriticalEventLimits>;
    } = {}
  ) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.limits = Object.freeze({
      ...RUNTIME_CRITICAL_EVENT_LIMITS,
      ...options.limits,
    });
  }

  // Bind where the runtime session id comes into being. A different session
  // closes the previous one, discards what was still queued for the previous
  // session's subscribers and restarts the sequence. The same session is
  // accepted again and continues its sequence and its first-key guard.
  bind(runtimeSessionId: string) {
    if (typeof runtimeSessionId !== "string" || !runtimeSessionId) return false;
    if (this.boundSessionId === runtimeSessionId) {
      this.accepting = true;
      return true;
    }
    if (this.accepting) this.close("session-rebound");
    this.discardQueuedFacts();
    this.boundSessionId = runtimeSessionId;
    this.accepting = true;
    this.sequence = 0;
    this.firstKeys = newFirstKeys();
    this.lastAdoptedSettlement = new Map();
    return true;
  }

  // Stop: the current subscriptions end. They still receive what is queued for
  // them and then one closed marker. The runtime session id has not changed,
  // so its later facts (an idle Screen capture, the terminal of work that Stop
  // cancelled) are still facts of this session: they stay accepted, keep the
  // sequence and reach the Recording owner, and no ended subscription sees them.
  closeSubscriptions(reason: string) {
    if (!this.accepting || this.boundSessionId === undefined) return false;
    this.endCohort(reason);
    return true;
  }

  // Stop accepting. What is already queued is still delivered asynchronously,
  // followed by one closed marker; the session's subscribers are then dropped.
  close(reason: string) {
    if (!this.accepting || this.boundSessionId === undefined) return false;
    this.accepting = false;
    this.endCohort(reason);
    return true;
  }

  // Stop accepting and drop subscribers, queue, first keys and timer at once.
  // Nothing is delivered afterwards, not even a closed marker.
  release(reason: string) {
    const closed = this.close(reason);
    for (const entry of this.queue) {
      if (entry.item.kind === "event") this.counters.discardedUndelivered += 1;
    }
    this.queue = [];
    this.subscribers = [];
    this.firstKeys = newFirstKeys();
    this.lastAdoptedSettlement = new Map();
    this.cancelDrain();
    return closed;
  }

  subscribe(
    listener: RuntimeCriticalEventListener
  ): RuntimeCriticalEventSubscription {
    const rejected = (
      reason: "not-accepting" | "subscriber-limit"
    ): RuntimeCriticalEventSubscription => {
      this.counters.subscriberRejected += 1;
      return { accepted: false, reason, unsubscribe: () => undefined };
    };
    if (!this.accepting || this.boundSessionId === undefined) {
      return rejected("not-accepting");
    }
    // An ended subscription counts until its closed marker is delivered.
    if (this.subscribers.length >= this.limits.maxSubscribers) {
      return rejected("subscriber-limit");
    }
    const subscriber: Subscriber = {
      cohort: this.cohort,
      sessionId: this.boundSessionId,
      listener,
      failed: false,
    };
    this.subscribers.push(subscriber);
    return {
      accepted: true,
      runtimeSessionId: subscriber.sessionId,
      unsubscribe: () => this.removeSubscriber(subscriber),
    };
  }

  // Total: never throws into the producer, never awaits, never re-enters.
  emit(input: RuntimeCriticalEventInput): RuntimeCriticalEventV1 | undefined {
    try {
      return this.emitUnsafe(input);
    } catch (error) {
      this.counters.constructionFailures += 1;
      this.noteFailure("construction", error);
      return undefined;
    }
  }

  // The synchronous Recording outcome of one produced event, for the counters.
  noteRecording(disposition: RuntimeCriticalEventRecordingDisposition) {
    if (typeof disposition === "string" && Object.hasOwn(this.recording, disposition)) {
      this.recording[disposition] += 1;
    }
  }

  noteRecordingFailure(error: unknown) {
    this.recording.failed += 1;
    this.noteFailure("recording", error);
  }

  getStats(): RuntimeCriticalEventStats {
    let retainedFirstKeys = this.lastAdoptedSettlement.size;
    for (const family of FIRST_KEY_FAMILIES) {
      retainedFirstKeys += this.firstKeys[family].size;
    }
    return Object.freeze({
      boundSessionId: this.boundSessionId,
      accepting: this.accepting,
      lastSequence: this.sequence,
      ...this.counters,
      subscribers: this.subscribers.length,
      queueDepth: this.queue.length,
      retainedFirstKeys,
      recording: Object.freeze({ ...this.recording }),
      failureDetails: Object.freeze([...this.failureDetails]),
      failureDetailsTruncated: this.failureDetailsTruncated,
    });
  }

  private emitUnsafe(
    input: RuntimeCriticalEventInput
  ): RuntimeCriticalEventV1 | undefined {
    if (this.boundSessionId === undefined) {
      this.counters.unboundRejected += 1;
      return undefined;
    }
    const runtimeSessionId = input.runtimeSessionId;
    if (typeof runtimeSessionId !== "string" || !runtimeSessionId) {
      this.counters.missingIdentityRejected += 1;
      return undefined;
    }
    if (runtimeSessionId !== this.boundSessionId) {
      this.counters.staleSessionRejected += 1;
      return undefined;
    }
    if (!this.accepting) {
      this.counters.lateAfterClose += 1;
      return undefined;
    }
    if (!FACT_KINDS.has(input.fact)) {
      throw new Error(`unknown critical fact: ${String(input.fact)}`);
    }
    if (input.purpose !== "formal" && input.purpose !== "observation") {
      throw new Error("critical event purpose must be formal or observation");
    }
    const omitted: string[] = [];
    const digested: string[] = [];
    const stage = this.readCode(input.stage, "stage", omitted);
    if (stage === undefined) throw new Error("critical event stage is required");
    const terminal = this.readTerminal(input, omitted);
    if ((input.fact === "terminal") !== (terminal !== undefined)) {
      throw new Error("a terminal fact and only a terminal fact names its object");
    }
    const refs = this.readRefs(input.refs, omitted, digested);
    const occurredAt =
      typeof input.occurredAt === "number" && Number.isFinite(input.occurredAt)
        ? input.occurredAt
        : this.clock.now();
    const firstKey = this.resolveFirstKey(input);
    if (firstKey.kind === "missing") {
      this.counters.missingIdentityRejected += 1;
      return undefined;
    }
    if (firstKey.kind === "key" && this.isRepeat(firstKey)) {
      this.counters.duplicateSuppressed += 1;
      return undefined;
    }

    // The sequence is assigned before any drop decision, so a dropped event
    // leaves a visible hole instead of a silently renumbered stream.
    this.sequence += 1;
    const sequence = this.sequence;
    const event: RuntimeCriticalEventV1 = Object.freeze({
      schemaVersion: RUNTIME_CRITICAL_EVENT_SCHEMA_VERSION,
      eventId: `rce:${runtimeSessionId}:${sequence}`,
      sequence,
      occurredAt,
      runtimeSessionId,
      ...(typeof input.runtimeEpoch === "number" &&
      Number.isFinite(input.runtimeEpoch)
        ? { runtimeEpoch: input.runtimeEpoch }
        : {}),
      fact: input.fact,
      stage,
      purpose: input.purpose,
      ...(terminal ? { terminal } : {}),
      refs,
      ...(omitted.length ? { omittedRefs: Object.freeze([...omitted]) } : {}),
      ...(digested.length ? { digestedRefs: Object.freeze([...digested]) } : {}),
    });
    this.counters.referencesOmitted += omitted.length;
    this.counters.referencesDigested += digested.length;

    if (JSON.stringify(event).length > this.limits.maxEventJsonChars) {
      // The key is not remembered: a fact dropped for its size was not
      // announced, so a later emission of it is still a first one.
      this.counters.payloadDropped += 1;
      this.enqueueGap("payload-limit", runtimeSessionId, sequence);
      return undefined;
    }
    if (firstKey.kind === "key") this.rememberFirstKey(firstKey);
    this.counters.produced += 1;
    if (this.hasSubscriberIn(this.cohort)) {
      if (this.queue.length >= this.limits.queueCapacity) {
        // Only the in-memory delivery is incomplete. The value itself is
        // returned so the Recording owner still saves it.
        this.counters.overflowDropped += 1;
        this.enqueueGap("queue-overflow", runtimeSessionId, sequence);
      } else {
        this.queue.push({ cohort: this.cohort, item: { kind: "event", event } });
        this.noteQueuePeak();
        this.scheduleDrain();
      }
    }
    return event;
  }

  // A repeat says nothing. A first-only key repeats once it was produced. A
  // settlement repeats when it is still the one last adopted and its adopted
  // value is the one already announced.
  private isRepeat(firstKey: FirstKeyResolution & { kind: "key" }) {
    const keys = this.firstKeys[firstKey.family];
    if (keys.get(firstKey.key) !== firstKey.value) return false;
    if (
      firstKey.adoption &&
      this.lastAdoptedSettlement.get(firstKey.adoption.scope) !==
        firstKey.adoption.settlementId
    ) {
      return false;
    }
    // Every use refreshes the key, so a fact that is still being repeated
    // (a displayed target, a re-projected terminal, the current settlement)
    // is never the one evicted.
    keys.delete(firstKey.key);
    keys.set(firstKey.key, firstKey.value);
    return true;
  }

  // Called only for an event that passed the payload check.
  private rememberFirstKey(firstKey: FirstKeyResolution & { kind: "key" }) {
    const keys = this.firstKeys[firstKey.family];
    const known = keys.delete(firstKey.key);
    keys.set(firstKey.key, firstKey.value);
    if (!known && keys.size > this.limits.maxFirstKeys) {
      const leastRecent = keys.keys().next().value;
      if (leastRecent !== undefined) keys.delete(leastRecent);
      this.counters.firstKeysEvicted += 1;
    }
    if (firstKey.adoption) {
      this.lastAdoptedSettlement.set(
        firstKey.adoption.scope,
        firstKey.adoption.settlementId
      );
    }
  }

  // First-key guards live here, not in Trace metadata or business state. They
  // read the producer's own identifiers. The purpose is part of every key: an
  // observation fact can never stand in for a formal one. Each family keeps
  // its maxFirstKeys most recently used keys. Three families are first-only
  // (LQU, first visible, terminal); the settlement family announces a change.
  private resolveFirstKey(input: RuntimeCriticalEventInput): FirstKeyResolution {
    const source = (input.refs ?? {}) as Record<string, unknown>;
    const scope = `${input.fact}|${input.purpose}`;
    if (input.fact === "lqu-committed") {
      const id = this.readKeyPart(source, "logicalQuestionUnitId");
      const revision = this.readKeyPart(source, "logicalQuestionRevision");
      return id !== undefined && revision !== undefined
        ? {
            kind: "key",
            family: "lqu",
            key: `${scope}|${id}|${revision}`,
            value: FIRST_ONLY,
          }
        : { kind: "missing" };
    }
    if (input.fact === "type-settled" || input.fact === "relation-settled") {
      // The guard remembers, per settlement, the Type and the Relation last
      // announced for it, and which settlement was adopted last. Assigning
      // that settlement again with the value already announced says nothing.
      // An assignment that changes the adopted value (the run's effective
      // view, a manual retype, a re-run that adopts the raw settlement again)
      // is announced every time, also when the value returns to an earlier
      // one. So is an assignment that adopts another settlement than the last
      // one, whatever was announced for it before. The last fact of a session
      // therefore names its current settlement and the value adopted now.
      const settlementId = this.readKeyPart(source, "settlementId");
      if (settlementId === undefined) return { kind: "missing" };
      const adopted = this.readKeyPart(
        source,
        input.fact === "type-settled" ? "questionType" : "relation"
      );
      return {
        kind: "key",
        family: "settlement",
        key: `${scope}|${settlementId}`,
        value: `=${adopted ?? ""}`,
        adoption: { scope, settlementId },
      };
    }
    if (input.fact === "stable-answer-applied") {
      const suggestion = this.readKeyPart(source, "suggestionId");
      const revision = this.readKeyPart(source, "stableRevision");
      return suggestion !== undefined && revision !== undefined
        // Re-applying the same version after unlock is a new display receipt.
        ? { kind: "none" }
        : { kind: "missing" };
    }
    if (input.fact === "first-visible-content") {
      // The display target is the generation's content, whichever way it first
      // became visible. A stable acknowledgement after a streaming one of the
      // same generation, a later revision of it and a repeated acknowledgement
      // are not a first. A target with no generation identity shows no content.
      const generation =
        this.readKeyPart(source, "generationId") ??
        this.readKeyPart(source, "suggestionId");
      return generation !== undefined
        ? {
            kind: "key",
            family: "visible",
            key: `${scope}|${generation}`,
            value: FIRST_ONLY,
          }
        : { kind: "missing" };
    }
    if (input.fact === "terminal") {
      const object = input.terminal?.object;
      if (!object || !TERMINAL_OBJECTS.has(object)) return { kind: "missing" };
      // The task writer answers each call once, and several distinct calls can
      // share one operation id: every rejection is its own terminal.
      if (object === "lifecycle-transition") return { kind: "none" };
      for (const reference of TERMINAL_OBJECT_REFERENCE[object]) {
        const value = this.readKeyPart(source, reference);
        if (value !== undefined) {
          return {
            kind: "key",
            family: "terminal",
            key: `${scope}|${object}|${value}`,
            value: FIRST_ONLY,
          };
        }
      }
      return { kind: "missing" };
    }
    return { kind: "none" };
  }

  // A key part is bounded like a reference, so the guard's memory is bounded
  // by count and by size.
  private readKeyPart(source: Record<string, unknown>, key: string) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value !== "string" || !value) return undefined;
    return this.boundIdentifier(value)?.text;
  }

  private boundIdentifier(value: string) {
    return boundIdentifierText(value, this.limits);
  }

  private readCode(value: unknown, name: string, omitted: string[]) {
    if (value === undefined || value === null || value === "") return undefined;
    if (
      typeof value !== "string" ||
      value.length > this.limits.maxReferenceChars ||
      !OWNER_CODE.test(value)
    ) {
      omitted.push(name);
      return undefined;
    }
    return value;
  }

  private readTerminal(
    input: RuntimeCriticalEventInput,
    omitted: string[]
  ): RuntimeCriticalEventTerminal | undefined {
    if (!input.terminal) return undefined;
    if (!TERMINAL_OBJECTS.has(input.terminal.object)) {
      throw new Error("unknown critical terminal object");
    }
    const disposition = this.readCode(
      input.terminal.disposition,
      "terminal.disposition",
      omitted
    );
    if (disposition === undefined) {
      throw new Error("critical terminal disposition is required");
    }
    // An owner reason that is free text (an error message) is refused and
    // named: it stays in the owner's own ledger and never enters an event.
    const reason = this.readCode(
      input.terminal.reason,
      "terminal.reason",
      omitted
    );
    return Object.freeze({
      object: input.terminal.object,
      disposition,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  // Copies whitelisted primitive references only. Anything else the producer
  // passes, including an object, is refused and named in omittedRefs.
  private readRefs(
    input: RuntimeCriticalEventRefsInput | undefined,
    omitted: string[],
    digested: string[]
  ): RuntimeCriticalEventRefs {
    const refs: Record<string, string | number | readonly string[]> = {};
    if (!input) return Object.freeze(refs) as RuntimeCriticalEventRefs;
    const source = input as Record<string, unknown>;
    for (const key of IDENTIFIER_REFERENCE_KEYS) {
      const value = source[key];
      if (value === undefined || value === null) continue;
      const bounded =
        typeof value === "string" && value
          ? this.boundIdentifier(value)
          : undefined;
      if (!bounded) {
        omitted.push(key);
        continue;
      }
      refs[key] = bounded.text;
      if (bounded.digested) digested.push(key);
    }
    for (const key of CODE_REFERENCE_KEYS) {
      const value = source[key];
      if (value === undefined || value === null) continue;
      const code = this.readCode(value, key, omitted);
      if (code !== undefined) refs[key] = code;
      else if (value === "") omitted.push(key);
    }
    for (const key of NUMBER_REFERENCE_KEYS) {
      const value = source[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        omitted.push(key);
        continue;
      }
      refs[key] = value;
    }
    let remaining = this.limits.maxSourceReferences;
    for (const key of LIST_REFERENCE_KEYS) {
      const value = source[key];
      if (value === undefined || value === null) continue;
      if (!Array.isArray(value)) {
        omitted.push(key);
        continue;
      }
      const kept: string[] = [];
      let refused = false;
      for (const entry of value) {
        if (
          typeof entry !== "string" ||
          !entry ||
          entry.length > this.limits.maxReferenceChars ||
          remaining <= 0
        ) {
          refused = true;
          continue;
        }
        kept.push(entry);
        remaining -= 1;
      }
      if (refused) omitted.push(key);
      if (kept.length) refs[key] = Object.freeze(kept);
    }
    return Object.freeze(refs) as RuntimeCriticalEventRefs;
  }

  private hasSubscriberIn(cohort: number) {
    for (const subscriber of this.subscribers) {
      if (subscriber.cohort === cohort) return true;
    }
    return false;
  }

  // Ends the current cohort. Its subscribers are dropped when its one closed
  // marker is delivered; a cohort with no subscriber leaves nothing behind.
  private endCohort(reason: string) {
    const cohort = this.cohort;
    this.cohort += 1;
    if (this.boundSessionId === undefined || !this.hasSubscriberIn(cohort)) return;
    this.queue.push({
      cohort,
      item: {
        kind: "closed",
        schemaVersion: RUNTIME_CRITICAL_EVENT_SCHEMA_VERSION,
        runtimeSessionId: this.boundSessionId,
        reason: boundText(reason, this.limits.maxReferenceChars),
        lastSequence: this.sequence,
        discarded: 0,
      },
    });
    this.noteQueuePeak();
    this.scheduleDrain();
  }

  // A session change. Every event and gap marker still queued belongs to a
  // subscription of a session that has ended. They are dropped, and the one
  // closed marker of that subscription's cohort says how many facts it was
  // not handed.
  private discardQueuedFacts() {
    const lost = new Map<number, number>();
    const closed: QueueEntry[] = [];
    for (const entry of this.queue) {
      const { item } = entry;
      if (item.kind === "closed") {
        closed.push(entry);
        continue;
      }
      if (item.kind === "event") this.counters.discardedUndelivered += 1;
      lost.set(
        entry.cohort,
        (lost.get(entry.cohort) ?? 0) + (item.kind === "gap" ? item.count : 1)
      );
    }
    if (lost.size === 0) return;
    this.queue = closed.map((entry) => {
      const count = lost.get(entry.cohort);
      return count === undefined || entry.item.kind !== "closed"
        ? entry
        : {
            cohort: entry.cohort,
            item: { ...entry.item, discarded: entry.item.discarded + count },
          };
    });
  }

  // One marker per reason for a run of drops. The run is the cohort's gap
  // markers at the tail of the queue: the one with this reason is widened, so
  // drops that alternate between reasons never add an item per lost event.
  private enqueueGap(
    reason: RuntimeCriticalEventGapReason,
    runtimeSessionId: string,
    sequence: number
  ) {
    const cohort = this.cohort;
    if (!this.hasSubscriberIn(cohort)) return;
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const entry = this.queue[index]!;
      if (entry.cohort !== cohort || entry.item.kind !== "gap") break;
      if (entry.item.reason === reason) {
        entry.item.lastSequence = sequence;
        entry.item.count += 1;
        return;
      }
    }
    this.counters.gapMarkers += 1;
    this.queue.push({
      cohort,
      item: {
        kind: "gap",
        schemaVersion: RUNTIME_CRITICAL_EVENT_SCHEMA_VERSION,
        runtimeSessionId,
        reason,
        firstSequence: sequence,
        lastSequence: sequence,
        count: 1,
      },
    });
    this.noteQueuePeak();
    this.scheduleDrain();
  }

  private noteQueuePeak() {
    if (this.queue.length > this.counters.queuePeak) {
      this.counters.queuePeak = this.queue.length;
    }
  }

  private scheduleDrain() {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    this.counters.drainsScheduled += 1;
    try {
      this.drainHandle = this.clock.schedule(this.drain);
    } catch (error) {
      this.drainScheduled = false;
      this.drainHandle = undefined;
      this.counters.scheduleFailures += 1;
      this.noteFailure("schedule", error);
    }
  }

  private cancelDrain() {
    if (!this.drainScheduled) return;
    this.drainScheduled = false;
    const handle = this.drainHandle;
    this.drainHandle = undefined;
    try {
      this.clock.cancel(handle);
    } catch (error) {
      this.counters.scheduleFailures += 1;
      this.noteFailure("schedule", error);
    }
  }

  // At most one batch per macrotask. A subscriber may submit new work through
  // an original production entry here; this stack is never a producer's stack.
  private readonly drain = () => {
    this.drainScheduled = false;
    this.drainHandle = undefined;
    let budget = this.limits.deliveryBatchSize;
    while (budget > 0 && this.queue.length > 0) {
      budget -= 1;
      this.deliver(this.queue.shift()!);
    }
    this.dropUnsubscribedItems();
    if (this.queue.length > 0) this.scheduleDrain();
  };

  private deliver(entry: QueueEntry) {
    const { cohort, item } = entry;
    const delivery: RuntimeCriticalEventDelivery =
      item.kind === "gap" ? Object.freeze({ ...item }) : Object.freeze(item);
    for (const subscriber of [...this.subscribers]) {
      if (subscriber.cohort !== cohort) continue;
      if (!this.subscribers.includes(subscriber)) continue;
      try {
        const returned: unknown = subscriber.listener(delivery);
        this.counters.delivered += 1;
        this.cutOffWhenRejected(subscriber, returned);
      } catch (error) {
        this.cutOff(subscriber, error);
      }
    }
    if (item.kind === "closed") {
      this.subscribers = this.subscribers.filter(
        (candidate) => candidate.cohort !== cohort
      );
    }
  }

  // A failed subscriber is cut off first: no retry, no further delivery, no
  // event about the failure, whatever the thrown value turns out to be. One
  // failure is counted per subscriber.
  private cutOff(subscriber: Subscriber, error: unknown) {
    if (subscriber.failed) return;
    subscriber.failed = true;
    this.subscribers = this.subscribers.filter(
      (candidate) => candidate !== subscriber
    );
    this.counters.subscriberFailures += 1;
    this.noteFailure("subscriber", error);
  }

  // An async listener fails by rejecting. The rejection is handled here and
  // never awaited: delivery goes on, and when the promise rejects the
  // subscriber is cut off like one that threw. What a batch had already handed
  // to it before the rejection ran stays delivered.
  private cutOffWhenRejected(subscriber: Subscriber, returned: unknown) {
    if (
      returned === null ||
      (typeof returned !== "object" && typeof returned !== "function")
    ) {
      return;
    }
    const then: unknown = (returned as { then?: unknown }).then;
    if (typeof then !== "function") return;
    then.call(returned, undefined, (error: unknown) => {
      this.cutOff(subscriber, error);
      this.dropUnsubscribedItems();
      if (this.queue.length === 0) this.cancelDrain();
    });
  }

  private removeSubscriber(subscriber: Subscriber) {
    if (!this.subscribers.includes(subscriber)) return;
    this.subscribers = this.subscribers.filter(
      (candidate) => candidate !== subscriber
    );
    this.dropUnsubscribedItems();
    if (this.queue.length === 0) this.cancelDrain();
  }

  // Nothing is retained for a cohort that has no subscriber left.
  private dropUnsubscribedItems() {
    if (this.queue.length === 0) return;
    const kept: QueueEntry[] = [];
    for (const entry of this.queue) {
      if (this.hasSubscriberIn(entry.cohort)) {
        kept.push(entry);
      } else if (entry.item.kind === "event") {
        this.counters.discardedUndelivered += 1;
      }
    }
    this.queue = kept;
  }

  // Total: describing a failure never raises another one. A thrown value
  // whose message cannot be read or converted is recorded as unreadable.
  private noteFailure(
    kind: RuntimeCriticalEventFailureDetail["kind"],
    error: unknown
  ) {
    try {
      if (this.failureDetails.length >= this.limits.maxFailureDetails) {
        this.failureDetailsTruncated = true;
        return;
      }
      this.failureDetails.push(
        Object.freeze({
          kind,
          message: boundText(
            readFailureMessage(error),
            this.limits.maxFailureDetailChars
          ),
        })
      );
    } catch {
      this.failureDetailsTruncated = true;
    }
  }
}

const UNREADABLE_TEXT = "unreadable failure";

// Text of any value, without trusting its conversion.
function safeText(value: unknown) {
  try {
    const text = typeof value === "string" ? value : String(value);
    return typeof text === "string" ? text : UNREADABLE_TEXT;
  } catch {
    return UNREADABLE_TEXT;
  }
}

function readFailureMessage(error: unknown) {
  try {
    return safeText(error instanceof Error ? error.message : error);
  } catch {
    return UNREADABLE_TEXT;
  }
}

function boundText(value: unknown, maxChars: number) {
  const text = safeText(value);
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

// One persisted line: the event value plus the Recording generation it was
// bound to when it was produced.
export interface RuntimeCriticalEventJournalRecord extends RuntimeCriticalEventV1 {
  readonly recordingSessionId?: string;
  readonly recordingGenerationId?: string;
}

export interface RuntimeCriticalEventJournalGap {
  // Sequences that the journal does not hold, inclusive.
  readonly firstMissingSequence: number;
  readonly lastMissingSequence: number;
}

export interface RuntimeCriticalEventJournalSession {
  readonly runtimeSessionId: string;
  readonly events: readonly RuntimeCriticalEventJournalRecord[];
  readonly gaps: readonly RuntimeCriticalEventJournalGap[];
  readonly orderViolations: number;
  readonly firstSequence: number;
  readonly lastSequence: number;
}

export type RuntimeCriticalEventJournalReadResult =
  | { readonly status: "not-provided" }
  | {
      readonly status: "unsupported-version";
      readonly schemaVersion: unknown;
      readonly line: number;
    }
  | {
      readonly status: "ok";
      readonly sessions: readonly RuntimeCriticalEventJournalSession[];
      readonly eventCount: number;
      readonly malformedLines: number;
      // False when a line is unreadable or a session has a hole or disorder.
      // A lost tail after the last line is not detectable from the journal.
      readonly contiguous: boolean;
    };

// Every field a version 1 event always has. A line that lacks one is counted
// as malformed and is never returned as an event.
function isJournalRecord(
  record: Partial<RuntimeCriticalEventJournalRecord>
): record is RuntimeCriticalEventJournalRecord {
  if (
    typeof record.runtimeSessionId !== "string" ||
    !record.runtimeSessionId ||
    typeof record.eventId !== "string" ||
    !record.eventId ||
    typeof record.sequence !== "number" ||
    !Number.isSafeInteger(record.sequence) ||
    record.sequence < 1 ||
    typeof record.occurredAt !== "number" ||
    !Number.isFinite(record.occurredAt) ||
    typeof record.fact !== "string" ||
    !FACT_KINDS.has(record.fact) ||
    typeof record.stage !== "string" ||
    !record.stage ||
    (record.purpose !== "formal" && record.purpose !== "observation") ||
    !record.refs ||
    typeof record.refs !== "object" ||
    Array.isArray(record.refs)
  ) {
    return false;
  }
  const terminal: unknown = record.terminal;
  if (record.fact !== "terminal") return terminal === undefined;
  if (!terminal || typeof terminal !== "object") return false;
  const { object, disposition } = terminal as Record<string, unknown>;
  return (
    typeof object === "string" &&
    TERMINAL_OBJECTS.has(object) &&
    typeof disposition === "string" &&
    disposition.length > 0
  );
}

// Pure reader. A recording made before this contract has no journal and reads
// as not-provided; nothing is mined from other files to stand in for it.
export function parseRuntimeCriticalEventJournal(
  text: string | null | undefined
): RuntimeCriticalEventJournalReadResult {
  if (typeof text !== "string") return { status: "not-provided" };
  const sessions = new Map<
    string,
    {
      events: RuntimeCriticalEventJournalRecord[];
      gaps: RuntimeCriticalEventJournalGap[];
      orderViolations: number;
      lastSequence: number;
    }
  >();
  let malformedLines = 0;
  let eventCount = 0;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      malformedLines += 1;
      continue;
    }
    const record = value as Partial<RuntimeCriticalEventJournalRecord>;
    // A line that names no version is a damaged line. Only a line that names
    // another version says the journal was written under another contract.
    if (record.schemaVersion === undefined) {
      malformedLines += 1;
      continue;
    }
    if (record.schemaVersion !== RUNTIME_CRITICAL_EVENT_SCHEMA_VERSION) {
      return {
        status: "unsupported-version",
        schemaVersion: record.schemaVersion,
        line: index + 1,
      };
    }
    if (!isJournalRecord(record)) {
      malformedLines += 1;
      continue;
    }
    let session = sessions.get(record.runtimeSessionId);
    if (!session) {
      session = { events: [], gaps: [], orderViolations: 0, lastSequence: 0 };
      sessions.set(record.runtimeSessionId, session);
    }
    if (record.sequence <= session.lastSequence) {
      session.orderViolations += 1;
    } else {
      if (record.sequence !== session.lastSequence + 1) {
        session.gaps.push({
          firstMissingSequence: session.lastSequence + 1,
          lastMissingSequence: record.sequence - 1,
        });
      }
      session.lastSequence = record.sequence;
    }
    session.events.push(record);
    eventCount += 1;
  }
  const grouped: RuntimeCriticalEventJournalSession[] = [];
  let contiguous = malformedLines === 0;
  for (const [runtimeSessionId, session] of sessions) {
    if (session.gaps.length || session.orderViolations) contiguous = false;
    grouped.push({
      runtimeSessionId,
      events: session.events,
      gaps: session.gaps,
      orderViolations: session.orderViolations,
      firstSequence: session.events[0]?.sequence ?? 0,
      lastSequence: session.lastSequence,
    });
  }
  return {
    status: "ok",
    sessions: grouped,
    eventCount,
    malformedLines,
    contiguous,
  };
}
