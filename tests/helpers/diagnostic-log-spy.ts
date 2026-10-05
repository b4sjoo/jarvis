// Task 178 LG test helper: the real frontend logger with its delivery boundary
// replaced, and the field ledger of every logger call site in src.
//
// Real: the logger leaf src/lib/meeting/diagnostic-log.ts, as compiled for the
// tests. Each spy evaluates its own instance of that code, as a page load does,
// so the level filter, the lazy detail, the bounds, the queue and the batching
// that an entry goes through are the production ones.
// Controlled: the four things the leaf reaches outside itself. The Tauri invoke
// entry it imports is the spy: it records each call as the JSON that would
// cross the boundary and answers a version 1 receipt, as the wire contract says
// native does. Its timers are private to the spy, so a harness that asserts
// exact timer counts on its own clock never sees a flush timer. Its clock is
// the caller's. Its console mirror is collected, not printed.
// `delivery` makes that boundary fail in one of the ways a call can: native
// rejects it, never answers it, answers something that is not a receipt, or
// the invoke entry itself throws. A call site test repeats its comparison with
// a failing delivery, so a call site that came to depend on delivery fails it.
// Not run: the real Tauri round trip and the native sink.
//
// A Hook callback that a harness evaluates with an explicit identifier
// environment gets `spy.logDiagnostic` under the name `logDiagnostic`. The
// trace store imports the leaf itself: `createTraceStoreModule` evaluates the
// compiled store with the spy's logger as that import.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type * as Leaf from "../../src/lib/meeting/diagnostic-log.js";
import type * as TraceStore from "../../src/lib/meeting/trace.js";

type Logger = typeof Leaf;
type Entry = Leaf.DiagnosticLogEntry;
type Level = Leaf.DiagnosticLogLevel;

export const DIAGNOSTIC_LOG_SPY_LEVELS = ["error", "warn", "info", "debug", "trace"] as const;

let leafCode: string | undefined;
// The compiled leaf as a CommonJS body, so its one import can be supplied.
function compiledLeaf(): string {
  if (leafCode === undefined) {
    const compiled = readFileSync(new URL("../../src/lib/meeting/diagnostic-log.js", import.meta.url), "utf8");
    leafCode = ts.transpileModule(compiled, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
  }
  return leafCode;
}

export interface DiagnosticLogSpyCall { command: string; level: Level; entries: Entry[] }

// How the delivery boundary answers a call. "ok" is the receipt of the wire contract.
export const DIAGNOSTIC_LOG_SPY_DELIVERIES = ["ok", "reject", "never", "malformed", "throw"] as const;
export type DiagnosticLogSpyDelivery = (typeof DIAGNOSTIC_LOG_SPY_DELIVERIES)[number];
export const DIAGNOSTIC_LOG_SPY_FAILING_DELIVERIES = DIAGNOSTIC_LOG_SPY_DELIVERIES.filter((delivery) => delivery !== "ok");

export function createDiagnosticLogSpy(options: { threshold?: Level; now?: () => number; delivery?: DiagnosticLogSpyDelivery } = {}) {
  const delivery = options.delivery ?? "ok";
  assert.ok(DIAGNOSTIC_LOG_SPY_DELIVERIES.includes(delivery), `delivery ${delivery}`);
  const calls: DiagnosticLogSpyCall[] = [];
  const mirrored: Array<{ method: string; entry: Entry }> = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  // The delivery boundary. What crosses it is JSON; the reply is a receipt for
  // exactly the level and the entries of the call, given at once. A failing
  // delivery still records what the logger handed over, so the same entries
  // can be read while nothing is delivered.
  const invoke = (command: string, args: { level: Level; entries: Entry[] }) => {
    const wire = JSON.parse(JSON.stringify(args)) as { level: Level; entries: Entry[] };
    calls.push({ command, level: wire.level, entries: wire.entries });
    const receipt = { v: 1, appliedLevel: wire.level, accepted: wire.entries.length, filtered: 0, rejected: 0, dropped: 0,
      sink: { state: "ready", droppedTotal: 0, writeFailures: 0, unsavedAtExit: 0 } };
    if (delivery === "throw") throw new Error("the invoke entry threw");
    if (delivery === "reject") return { then: (_resolved: unknown, rejected: (reason: unknown) => void) => { rejected(new Error("native rejected the call")); } };
    // No reply: the logger's own reply timeout ends the call.
    if (delivery === "never") return { then: () => {} };
    if (delivery === "malformed") return { then: (resolved: (value: unknown) => void) => { resolved({ accepted: "all" }); } };
    return { then: (resolved: (value: unknown) => void) => { resolved(receipt); } };
  };
  const exports = {} as Logger;
  const consoleSpy = Object.fromEntries(["error", "warn", "info", "debug", "log", "trace"].map((method) =>
    [method, (_label: unknown, entry: Entry) => { mirrored.push({ method, entry }); }]));
  new Function("exports", "require", "setTimeout", "clearTimeout", "Date", "console", compiledLeaf())(
    exports,
    (name: string) => {
      assert.equal(name, "@tauri-apps/api/core", "the leaf imports the Tauri invoke entry alone");
      return { invoke };
    },
    (callback: () => void) => { const id = ++nextTimer; timers.set(id, callback); return id; },
    (id: number) => { timers.delete(id); },
    { now: () => (options.now ?? Date.now)() },
    consoleSpy,
  );
  if (options.threshold) assert.equal(exports.setDiagnosticLogThreshold(options.threshold), true);
  // Runs the instance's own timers until nothing is queued: every accepted
  // entry has then crossed the boundary.
  const deliver = () => {
    for (let round = 0; timers.size > 0; round += 1) {
      assert.ok(round < 10_000, "the diagnostic log did not drain");
      const [id, callback] = timers.entries().next().value as [number, () => void];
      timers.delete(id);
      callback();
    }
    const snapshot = exports.readDiagnosticLogSnapshot();
    assert.deepEqual([snapshot.queued, snapshot.inFlight], [0, false], "the diagnostic log is drained");
  };
  return {
    delivery,
    logger: exports,
    logDiagnostic: exports.logDiagnostic,
    calls,
    mirrored,
    setThreshold(level: Level) { assert.equal(exports.setDiagnosticLogThreshold(level), true); },
    // Every entry delivered so far, in order.
    entries(): Entry[] { deliver(); return calls.flatMap((call) => call.entries); },
    // Forgets what was delivered, not the counters.
    clear() { deliver(); calls.length = 0; mirrored.length = 0; },
    snapshot: () => exports.readDiagnosticLogSnapshot(),
    pendingTimers: () => timers.size,
  };
}
export type DiagnosticLogSpy = ReturnType<typeof createDiagnosticLogSpy>;

let traceStoreCode: string | undefined;
// The real trace store, as compiled for the tests, with the spy's logger as the
// leaf it imports. Controlled: its identifier source, so that two runs give the
// same identifiers, and its clock.
export function createTraceStoreModule(spy: Pick<DiagnosticLogSpy, "logger">, options: { now?: () => number } = {}): typeof TraceStore {
  if (traceStoreCode === undefined) {
    const compiled = readFileSync(new URL("../../src/lib/meeting/trace.js", import.meta.url), "utf8");
    traceStoreCode = ts.transpileModule(compiled, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
  }
  let nextId = 0;
  const clock = options.now ?? Date.now;
  const exports = {} as typeof TraceStore;
  new Function("exports", "require", "Date", traceStoreCode)(
    exports,
    (name: string) => {
      if (name === "./diagnostic-log.js") return spy.logger;
      if (name === "./meeting-id.js") return { createMeetingId: (prefix: string) => `${prefix}_${++nextId}` };
      return assert.fail(`the trace store imports ${name}`);
    },
    class extends Date { static now() { return clock(); } },
  );
  return exports;
}

// ---- the field ledger ----
//
// One row per entry, which is one `logDiagnostic(` call in src, or the number of
// calls its `callSites` states: where it is, its fixed tags, the levels it can
// use and every field it can carry with the values that field can take. An
// entry holds nothing else: no message, no other reference, no other data key,
// and no string that is not one of the listed values. The one free text is the
// field `cause` of a row whose call sits in a catch of a native command or of
// local persistence: the bounded summary of the caught error.

type FieldKind =
  | "boolean"
  // A whole number that is not negative.
  | "count"
  // A duration or a limit in milliseconds.
  | "ms"
  // A fixed code of the producer: lower-case words joined by hyphens.
  | "code"
  // An identifier the runtime or native made: one token of printable ASCII.
  | "identifier"
  // A fixed label written in the source: words, digits, spaces and hyphens.
  | "label"
  // The summary of a caught error of a native command or of local persistence, as the leaf's diagnosticLogCause makes
  // it (decisions A8): at most 160 UTF-16 code units. The one kind that may hold a path or a device name, and the kind
  // of the key `cause` alone.
  | "bounded-text"
  | readonly string[];

// Task 178 LG, commit 3: what a migrated call site printed before, and what it
// still does beside its one logger call.
export interface DiagnosticLogMigration {
  // The row of the migration list (decisions A7) the site belongs to.
  // "added" is an entry A7 or A8 adds where nothing was printed.
  id: "M1" | "M2" | "M3" | "M4" | "M5" | "M6" | "M7" | "M8" | "M10" | "added";
  // The old output: the console method with its fixed text, and the string IPC where the site had one.
  oldOutput: string;
  // Fixed text of that old output. It is in no source file any more.
  removedText: readonly string[];
  // The typed value each level is read from, where the site has more than one level.
  levelBy?: string;
  // The Session Recording, trace store, human-evaluation and other calls of the site: made as before, in this order.
  kept: readonly string[];
  // The test file that drives the site through its production code.
  test: string;
}

// Decisions A8, item 1: what a call site that sits in a catch does with the error it caught.
export interface DiagnosticLogCaughtError {
  // Whether the entry carries the bounded field `cause`, made from the caught value inside the lazy detail.
  cause: boolean;
  // With a cause: what the caught error comes from, a native command or local persistence. Without one: why not.
  from: string;
  // The calls the catch guards, as its try block or its promise chain writes them (compared without whitespace).
  guards: readonly string[];
}

export interface DiagnosticLogLedgerRow {
  // The file and the named declaration of that file the call is in.
  file: string;
  owner: string;
  // How many `logDiagnostic(` calls of that declaration make this entry, when it is more than one branch.
  callSites?: number;
  source: string;
  event: string;
  levels: readonly Level[];
  refs: readonly (keyof Leaf.DiagnosticLogRefs)[];
  data: Readonly<Record<string, FieldKind>>;
  // The typed fact each level is read from.
  factSource: string;
  // What the entry is known not to tell apart, where that is so.
  knownLimits?: readonly string[];
  // Present on a call site that replaced an existing print (commit 3).
  migration?: DiagnosticLogMigration;
  // Present on a call site that sits in a catch.
  caught?: DiagnosticLogCaughtError;
}

const SELECTION_REASONS = ["intelligent-valid", "intelligent-invalid-fast-valid", "candidates-ended-unusable", "client-error",
  "candidate-deadline-expired"] as const;
const RUNTIME_DISPOSITIONS = ["completed", "error", "superseded", "budget-exhausted", "operation-mismatch", "disposed"] as const;
const PROVIDER_STATUSES = ["success", "empty", "failed", "timed-out", "aborted"] as const;
const FAILURE_CLASSES = ["configuration", "transport", "authentication", "rate-limit", "provider-http", "provider-response-parse",
  "stream-unavailable", "stream-read", "unexpected"] as const;
const HOOK = "src/hooks/useMeetingAssistant.ts";
const TRACE_STORE = "src/lib/meeting/trace.ts";
const MIGRATION_TEST = "tests/diagnostic-log-migration.test.ts";
const SHUTDOWN_TEST = "tests/app-shutdown-hook.test.ts";
const EVALUATION_TEST = "tests/human-evaluation-store.test.ts";
// Typed values of the migrated call sites (commit 3).
export const TRACE_STORE_CHANGE_LEVELS = { "debug-mode": "info", "traces-cleared": "info", "trace-started": "debug", "step-finished": "debug",
  "trace-finished": "debug", "step-started": "trace", "input-recorded": "trace", "output-recorded": "trace", "trace-metadata-updated": "trace" } as const;
const TRACE_KINDS = ["screen", "voice"] as const;
const TRACE_STATUSES = ["running", "success", "error", "cancelled"] as const;
export const CAPTURE_LIFECYCLE_STAGE_LEVELS = { claimed: "info", finished: "info", "stale-cleanup-failed": "warn", coalesced: "debug", dequeued: "debug",
  "skipped-before-run": "debug", "authorization-checked": "debug", "native-completed": "debug", "stale-cleanup-started": "debug",
  "stale-cleanup-finished": "debug" } as const;
const CAPTURE_ACTIONS = ["start", "resume", "pause", "stop"] as const;
// Every detail code a caller of the capture lifecycle coordinator passes in the Hook.
export const CAPTURE_LIFECYCLE_DETAILS = ["shutdown-terminal-accepted", "shutdown-native-status-read", "stop_meeting_audio_session", "native-stop-error",
  "prepare-stop-reset", "commit-stop-state", "stop_for_missing_stt_provider", "missing-provider-native-stop-error", "commit-provider-error",
  "blocked-stt-provider-missing", "check_system_audio_access", "stop_before_start", "start_meeting_audio_session", "late-native-start-completion",
  "commit-start-error", "native-pause-error", "commit-pause-state"] as const;
const CAPTURE_OWNERS = ["meeting", "system"] as const;
const ENVELOPE_REASONS = ["invalid-envelope", "no-active-native-session", "capture-session-mismatch", "capture-owner-mismatch",
  "capture-generation-mismatch"] as const;
// Every stage a caller of the raw-zero probe report passes in the Hook: eight literals and the episode dispositions that carry a warning.
export const RAW_ZERO_PROBE_STAGES = ["deferred-before-claim", "deferred-before-native-stop", "native-restart-started", "native-restart-completed",
  "requested", "request-finished", "screen-wait-reset", "signal-restored", "inactive", "probe-used", "screen-wait", "screen-deferred", "probe-ready"] as const;
// Decisions A8, item 2: the stages that report an action of the probe are info; every other stage is debug.
export const RAW_ZERO_PROBE_ACTION_STAGES = ["requested", "native-restart-started", "native-restart-completed", "signal-restored"] as const;
export const RAW_ZERO_PROBE_STAGE_LEVELS = Object.fromEntries(RAW_ZERO_PROBE_STAGES.map((stage) =>
  [stage, (RAW_ZERO_PROBE_ACTION_STAGES as readonly string[]).includes(stage) ? "info" : "debug"])) as Record<(typeof RAW_ZERO_PROBE_STAGES)[number], "info" | "debug">;
// The episode's own disposition as the probe report reads it: without the Screen state, so never "screen-deferred".
export const RAW_ZERO_EPISODE_DISPOSITIONS = ["waiting", "probe-used", "screen-wait", "probe-ready"] as const;
// The metadata keys a caller of the probe report may pass (RawZeroProbeReportMetadata in the Hook). The entry reads the
// first seven by name; the capture, the warning and the probe flag are never read from a caller.
export const RAW_ZERO_PROBE_METADATA_KEYS = ["recoveryAttemptId", "operationId", "previousCaptureSessionId", "previousCaptureGeneration", "signalRestored",
  "snapshotSequence", "screenOperationId", "disposition"] as const;
// Decisions A8, item 1. The known limit of every entry that carries `cause`.
export const CAUSE_LIMIT = "cause is the name and the message of the caught error as the native command or the local store gave them, cut at 160 UTF-16 code units, without the stack: it can name a path or a device, and an error that quotes its own input would carry that quote. The logger's shape backstop leaves the field out, and keeps the entry, when that text holds a credential shape or a run of 96 or more characters of an encoded blob: letters, digits, '/', '+', '=', '_' and '-'. A long path with no dot, space or colon in it is such a run, so an error that names one loses its cause";
// The known limit of the two catches that carry no cause.
export const NO_CAUSE_ON_PROVIDER_PATH = "the entry carries no cause and no error text: the rejection of a queued segment can carry a speech-to-text provider's response. The old console print was the only copy of the caught error, so the cause of this failure is in no output";
// What the caught error of a row with a cause comes from.
const FROM_CAPTURE_MANAGER = "native commands of STT Evaluation Capture, through its manager";
const FROM_NATIVE_STOP = "the native stop command of the meeting capture";
const FROM_PROVIDER_PATH = "no cause: the catch guards processQueuedSpeechSegment, which awaits the speech-to-text provider (transcribeMeetingAudio)";
const UI_SURFACES = ["meeting-response-actions", "normal-mode", "focus-mode"] as const;
// Every reason a caller of the Hook's stopSessionRecording passes: its default and four literals.
export const RECORDING_STOP_REASONS = ["manual", "meeting-assistant-stopped", "scenario-runner-stopped", "application-shutdown", "manual-close-retry"] as const;

export const DIAGNOSTIC_LOG_LEDGER: readonly DiagnosticLogLedgerRow[] = [
  { file: HOOK, owner: "resolveOrderedTaskRelationWithinWindow", source: "meeting.relation", event: "formal-operation-settled",
    levels: ["warn", "debug"], refs: ["traceId"],
    factSource: "typed values of this operation alone: the Ordered operation's single metadata write (operation authorized, client error, each stage disposition compared with 'available') and its own handle (a formal model operation, and stageSelections: per stage the selector's reason and whether it selected a tier, written by that operation's stage settles before their terminals resolved); nothing is read from the trace",
    knownLimits: ["a provider client error is warn, although Voice then shows a configuration error and hands nothing to the Advisor",
      "whether a request was dispatched is not in the entry: it stays in the 178A provider-request-started events and the recorded candidate rows"],
    data: { sourceKind: ["voice", "screen", "mixed"], operationAuthorized: "boolean", clientError: "boolean",
      stage: ["runtime-matrix", "canonical-relation", "source-topology-null-hypothesis"], reason: "code",
      waitDisposition: ["affinity-settled", "affinity-unavailable", "canonical-skipped-no-budget", "canonical-settled", "canonical-unresolved"],
      waitMs: "ms",
      childUsable: "boolean", childSelection: SELECTION_REASONS, childTierSelected: "boolean",
      parentUsable: "boolean", parentSelection: SELECTION_REASONS, parentTierSelected: "boolean",
      canonicalUsable: "boolean", canonicalSelection: SELECTION_REASONS, canonicalTierSelected: "boolean" } },
  { file: HOOK, owner: "scheduleTaskRelationSplitRuntime", source: "meeting.relation", event: "observation-stage-settled",
    levels: ["warn", "debug"], refs: ["traceId"],
    factSource: "the stage settle of a non-formal operation: lease authorization, runtime disposition, the selection's reason and parse result",
    data: { stage: ["child-affinity", "parent-affinity", "canonical"], disposition: RUNTIME_DISPOSITIONS, current: "boolean",
      selection: SELECTION_REASONS, tier: ["intelligent", "fast"], parseValid: "boolean", providerStatus: PROVIDER_STATUSES, durationMs: "ms" } },
  { file: HOOK, owner: "scheduleAdvisorAfterQuestionTypeWindow", source: "meeting.question-type", event: "foreground-deadline-finalized",
    levels: ["warn", "debug"], refs: ["traceId"],
    factSource: "the wait-timer branch: a Type window was requested and its outcome was still pending at the foreground deadline",
    knownLimits: ["the entry reports the deadline finalization, not the handoff: the dispatch call of that branch returns no value, so a turn finalized in a meeting that is no longer active (its trace ends cancelled and nothing is handed to the Advisor) is still warn"],
    data: { typeWindowRequested: "boolean", typeOutcomePending: "boolean", relationWindowRequested: "boolean", typeWaitBudgetMs: "ms",
      foregroundBudgetMs: "ms", waitMs: "ms" } },
  { file: HOOK, owner: "scheduleAdvisorAfterQuestionTypeWindow", source: "meeting.question-type", event: "late-result-discarded",
    levels: ["debug"], refs: ["traceId"],
    factSource: "the late-result branch of the Type outcome: the turn was already released or finalized",
    data: { providerTimedOut: "boolean", leaseAuthorized: "boolean", waitMs: "ms" } },
  { file: HOOK, owner: "runAdvisor", source: "meeting.advisor", event: "request-ended",
    levels: ["error", "debug"], refs: ["traceId", "operationId", "requestId"],
    factSource: "the catch branch that ends the request: abort, commit decision not authorized, commit authorized with the meeting no longer active, or the user-visible error",
    data: { ending: ["visible-error", "aborted", "commit-not-authorized", "meeting-inactive"], status: PROVIDER_STATUSES, failureClass: FAILURE_CLASSES,
      httpStatus: "count", budgetKind: ["first-content", "content-idle", "total-elapsed"], budgetLimitMs: "ms", attemptNumber: "count",
      maxAttempts: "count", chunkCount: "count", durationMs: "ms", commitAuthorized: "boolean",
      commitReason: ["authorized", "runtime-epoch-mismatch", "session-mismatch", "parent-presence-mismatch", "parent-id-mismatch",
        "parent-revision-mismatch", "pipeline-owner-mismatch"], meetingActive: "boolean" } },
  { file: HOOK, owner: "useMeetingAssistant", source: "meeting.fact-risk-review", event: "review-ended",
    levels: ["warn", "debug"], refs: ["traceId", "runtimeSessionId"],
    factSource: "the review runtime's event: stage, and for a settled review its status",
    data: { stage: ["settled", "cancelled", "discarded", "late-result-discarded"], status: ["completed", "failed", "skipped"],
      cause: ["deadline-exceeded", "answer-retired", "runtime-invalidated"], flagCount: "count", durationMs: "ms", answerRevision: "count" } },
  { file: HOOK, owner: "scheduleMeetingMetadataInference", source: "meeting.metadata-inference", event: "inference-settled",
    levels: ["warn", "debug"], refs: ["traceId"],
    factSource: "the settle: runtime disposition, lease authorization and the typed provider status",
    data: { disposition: RUNTIME_DISPOSITIONS, leaseAuthorized: "boolean", providerStatus: PROVIDER_STATUSES, failureClass: FAILURE_CLASSES,
      parseValid: "boolean", committed: "boolean", durationMs: "ms", queueWaitMs: "ms" } },
  { file: HOOK, owner: "scheduleWhiteboardSyntaxRepairShadow", source: "meeting.whiteboard-repair", event: "repair-settled",
    levels: ["warn", "debug"], refs: ["traceId"],
    factSource: "the settle: runtime disposition, lease authorization and the typed provider status",
    data: { disposition: RUNTIME_DISPOSITIONS, leaseAuthorized: "boolean", providerStatus: PROVIDER_STATUSES, failureClass: FAILURE_CLASSES,
      parseValid: "boolean", durationMs: "ms", queueWaitMs: "ms" } },

  // ---- commit 3: the migrated call sites ----
  { file: TRACE_STORE, owner: "log", source: "meeting.trace", event: "store-event", levels: ["info", "debug", "trace"], refs: ["traceId"],
    factSource: "the kind of change the store method passes, a literal of each of its nine call sites: TRACE_STORE_CHANGE_LEVELS. A status of 'error' never raises the level",
    knownLimits: ["a step or trace that ends with the status 'error' is debug: the store cannot tell a failed attempt from an operation that recovered",
      "the label of a recorded input or output and the step identifier are not in the entry"],
    data: { change: Object.keys(TRACE_STORE_CHANGE_LEVELS), kind: TRACE_KINDS, step: "label", status: TRACE_STATUSES, durationMs: "ms", valueChars: "count",
      metadataKeys: "count", enabled: "boolean" },
    migration: { id: "M1", test: MIGRATION_TEST,
      oldOutput: "with Debug Mode on only: console.info('[<ISO time>] [meeting-trace] <event> <JSON with whole metadata and error text>') and the string IPC write_meeting_trace_log with the same line, one call per line",
      removedText: ["[meeting-trace]", "write_meeting_trace_log"], levelBy: "the kind of change",
      kept: ["the store mutation itself and its change notification to the subscriber"] } },
  { file: HOOK, owner: "scheduleTraceMetricsPersistence", source: "meeting.trace-metrics", event: "persist-failed", levels: ["warn", "debug"], refs: [],
    factSource: "the retry branch of the catch: debug when the retry timer is scheduled (first attempt, no shutdown), warn otherwise",
    data: { attempt: "count", retryScheduled: "boolean", cause: "bounded-text" },
    knownLimits: [CAUSE_LIMIT,
      "retryScheduled says that the 750 ms retry timer was set, not that the retry ran: the timer writes again only if the payload is unchanged when it fires. A scheduled retry that a changed payload supersedes leaves that payload unsaved with a debug entry only, so a write that keeps failing while the traces keep changing gives no warn until the payload stays the same for 750 ms"],
    caught: { cause: true, from: "the native command write_meeting_trace_metrics", guards: ['invoke("write_meeting_trace_metrics",'] },
    migration: { id: "M2", test: MIGRATION_TEST,
      oldOutput: "console.warn('Failed to persist meeting trace metrics', error) and the string IPC write_meeting_trace_log with '[meeting-trace] trace-metrics-persist-failed {attempt, error text}'",
      removedText: ["Failed to persist meeting trace metrics", "trace-metrics-persist-failed"], levelBy: "whether a retry is scheduled",
      kept: ["invoke('write_meeting_trace_metrics')", "the 750 ms retry timer"] } },
  { file: HOOK, owner: "useMeetingAssistant", source: "meeting.capture-lifecycle", event: "stage-reported", levels: ["info", "warn", "debug"], refs: [],
    factSource: "the typed stage of the coordinator's event: CAPTURE_LIFECYCLE_STAGE_LEVELS",
    data: { stage: Object.keys(CAPTURE_LIFECYCLE_STAGE_LEVELS), action: CAPTURE_ACTIONS, authorized: "boolean", captureOperationId: "count",
      detail: CAPTURE_LIFECYCLE_DETAILS },
    migration: { id: "M3", test: MIGRATION_TEST,
      oldOutput: "console.info('[<ISO time>] [capture-lifecycle] <stage>', JSON of the event with its error text)",
      removedText: ["[capture-lifecycle]"], levelBy: "the stage", kept: ["sessionRecordingManagerRef.current?.recordCaptureLifecycle(metadata)"] } },
  { file: HOOK, owner: "setupListeners", source: "meeting.native-audio", event: "stall-marker-ack-failed", levels: ["warn"], refs: [],
    factSource: "the rejection branch of the acknowledge_native_stall_marker call",
    data: { captureSessionId: "identifier", captureGeneration: "count", snapshotSequence: "count", cause: "bounded-text" },
    knownLimits: [CAUSE_LIMIT],
    caught: { cause: true, from: "the native command acknowledge_native_stall_marker", guards: ['invoke<boolean>("acknowledge_native_stall_marker",'] },
    migration: { id: "M4", test: MIGRATION_TEST, oldOutput: "console.warn('Native stall marker ACK failed', error)",
      removedText: ["Native stall marker ACK failed"], kept: ["invoke('acknowledge_native_stall_marker')", "recordAudioInputLiveness(metadata)"] } },
  { file: HOOK, owner: "setupListeners", source: "meeting.native-audio", event: "liveness-rejected", levels: ["debug"], refs: [],
    factSource: "the branch for a liveness event that is not authorized",
    data: { reason: [...ENVELOPE_REASONS, "capture-source-mismatch", "non-monotonic-snapshot"], captureSessionId: "identifier", captureGeneration: "count",
      snapshotSequence: "count" },
    migration: { id: "M4", test: MIGRATION_TEST, oldOutput: "console.info('[<ISO time>] [native-audio-liveness] rejected', JSON of the liveness metadata)",
      removedText: ["[native-audio-liveness]"], kept: ["recordAudioInputLiveness(metadata)"] } },
  { file: HOOK, owner: "setupListeners", source: "meeting.native-audio", event: "speech-start-rejected", levels: ["debug"], refs: [],
    factSource: "the branch for a speech-start event that is not authorized",
    data: { reason: [...ENVELOPE_REASONS, "capture-source-mismatch", "non-monotonic-candidate"], captureSessionId: "identifier", captureGeneration: "count",
      candidateSegmentSequence: "count" },
    migration: { id: "M4", test: MIGRATION_TEST, oldOutput: "console.info('[<ISO time>] [native-speech-start] rejected', JSON of the speech-start metadata)",
      removedText: ["[native-speech-start]"], kept: ["recordNativeSpeechEvent(metadata)"] } },
  { file: HOOK, owner: "setupListeners", source: "meeting.native-audio", event: "speech-segment-observed", levels: ["debug"], refs: ["traceId"],
    factSource: "the branch for a segment that repeats a sequence or arrives out of order",
    data: { reason: ["duplicate-sequence", "non-monotonic-sequence"], captureSessionId: "identifier", captureGeneration: "count", segmentSequence: "count",
      observationDisposition: ["first-observation", "duplicate-observation"], observationCount: "count", duplicateObservationCount: "count",
      canonicalDisposition: ["accepted", "prompt-echo-retry-accepted", "prompt-echo-retry-rejected", "stt-error", "stale", "duplicate", "invalid-sequence"] },
    migration: { id: "M4", test: MIGRATION_TEST, oldOutput: "console.info('[<ISO time>] [native-speech-event] observed', JSON of the reason and the observation)",
      removedText: ["[native-speech-event] observed"],
      kept: ["audioSegmentDispositionLedgerRef.current.settle(...)", "traceStoreRef.current.updateMetadata(settlement.traceId, settlementMetadata)",
        "recordAudioSegmentDisposition({ traceId, metadata })"] } },
  { file: HOOK, owner: "setupListeners", source: "meeting.native-audio", event: "speech-segment-rejected", levels: ["debug"], refs: [],
    factSource: "the branch for a segment that is not authorized and is not a repeat",
    data: { reason: [...ENVELOPE_REASONS, "duplicate-sequence", "non-monotonic-sequence"], authority: ["open-drain", "active-capture"],
      captureSessionId: "identifier", captureGeneration: "count", segmentSequence: "count" },
    migration: { id: "M4", test: MIGRATION_TEST, oldOutput: "console.info('[<ISO time>] [native-speech-event] rejected', JSON of the metadata)",
      removedText: ["[native-speech-event] rejected"], kept: ["recordNativeSpeechEvent(metadata)"] } },
  { file: HOOK, owner: "setupListeners", source: "meeting.native-audio", event: "segment-dropped", levels: ["warn", "debug"], refs: [],
    factSource: "the boolean the listener computes: the dropped segment belongs to the current meeting capture",
    data: { authorized: "boolean", envelopeValid: "boolean", owner: CAPTURE_OWNERS, captureSessionId: "identifier", captureGeneration: "count",
      attemptedSegmentSequence: "count" },
    migration: { id: "M4", test: MIGRATION_TEST, oldOutput: "console.warn('[<ISO time>] [native-audio-segment-dropped]', JSON with the native reason and message)",
      removedText: ["[native-audio-segment-dropped]"], levelBy: "authorized", kept: ["recordCaptureLifecycle(metadata)"] } },
  { file: HOOK, owner: "setupListeners", source: "meeting.native-audio", event: "lifecycle-event", levels: ["info", "warn", "debug"], refs: [],
    factSource: "the authorization result and, for an authorized event, its typed event type: started and stopped info, error warn; not authorized debug",
    knownLimits: ["an authorized error event is warn at its receipt: what the end of the stream means for the meeting is decided after it and is not in the entry"],
    data: { authorized: "boolean", rejectionReason: ENVELOPE_REASONS, eventType: ["started", "stopped", "error"], owner: CAPTURE_OWNERS,
      captureSessionId: "identifier", captureGeneration: "count", expected: "boolean", recoverability: ["not-applicable", "retry-once", "manual"] },
    migration: { id: "M4", test: MIGRATION_TEST, oldOutput: "console.info('[<ISO time>] [native-audio-lifecycle]', JSON with the native reason and message)",
      removedText: ["[native-audio-lifecycle]"], levelBy: "authorized, then the event type", kept: ["recordCaptureLifecycle(metadata)"] } },
  { file: HOOK, owner: "useMeetingAssistant", source: "meeting.native-audio", event: "listener-setup-failed", levels: ["error"], refs: [],
    factSource: "the rejection branch of the listener setup", data: { cause: "bounded-text" },
    knownLimits: [CAUSE_LIMIT],
    caught: { cause: true, from: "the native event subscriptions (listen) of the listener setup", guards: ["setupListeners()"] },
    migration: { id: "M4", test: MIGRATION_TEST, oldOutput: "console.warn('Failed to setup meeting speech listener', error)",
      removedText: ["Failed to setup meeting speech listener"], kept: [] } },
  { file: HOOK, owner: "stop", source: "meeting.capture", event: "stop-native-failed", levels: ["warn"], refs: [],
    factSource: "the catch of the native stop inside Stop: warn whether Quit rethrows or a normal Stop goes on",
    data: { captureOperationId: "count", shutdownRequested: "boolean", cause: "bounded-text" },
    knownLimits: [CAUSE_LIMIT],
    caught: { cause: true, from: "the native status and stop commands of Stop, or the block's own two errors (capture still active, Stop superseded while awaiting its terminal event)",
      guards: ['invoke<MeetingAudioStatus>("get_meeting_audio_status")', 'invoke<NativeAudioStopResult>("stop_system_audio_capture",', "stopNativeMeetingCapture(lease)",
        "stopNativeMeetingCapture(nativeLeaseAtInvocation)"] },
    migration: { id: "M5", test: SHUTDOWN_TEST, oldOutput: "console.warn('Failed to stop meeting audio capture', error)",
      removedText: ["Failed to stop meeting audio capture"], kept: ["the rethrow under Quit", "coordinator.authorize(lifecycleOperation, 'native-stop-error')"] } },
  { file: HOOK, owner: "stop", source: "meeting.stt-evaluation-capture", event: "meeting-stop-failed", levels: ["warn"], refs: [],
    factSource: "the catch of the evaluation capture stop inside Stop",
    data: { captureOperationId: "count", shutdownRequested: "boolean", cause: "bounded-text" },
    knownLimits: [CAUSE_LIMIT],
    caught: { cause: true, from: FROM_CAPTURE_MANAGER + ", or the shutdown check that the capture finalized",
      guards: ["stopShutdownEvaluationCapture(sttEvaluationCaptureManagerRef.current)", "sttEvaluationCaptureManagerRef.current?.drain()",
        'sttEvaluationCaptureManagerRef.current?.stop("meeting-assistant-stopped")'] },
    migration: { id: "M5", test: SHUTDOWN_TEST, oldOutput: "console.warn('Failed to stop STT evaluation capture', error)",
      removedText: ["Failed to stop STT evaluation capture"], kept: ["the rethrow under Quit"] } },
  { file: HOOK, owner: "processQueuedSpeechSegment", source: "meeting.capture", event: "missing-provider-stop-failed", levels: ["warn"], refs: ["traceId"],
    factSource: "the catch of the native stop that follows a missing STT provider",
    data: { captureOperationId: "count", cause: "bounded-text" },
    knownLimits: [CAUSE_LIMIT],
    caught: { cause: true, from: FROM_NATIVE_STOP, guards: ["stopNativeMeetingCapture()"] },
    migration: { id: "M5", test: MIGRATION_TEST, oldOutput: "console.warn('Failed to stop meeting audio capture', error)",
      removedText: ["Failed to stop meeting audio capture"],
      kept: ["coordinator.authorize(lifecycleOperation, 'missing-provider-native-stop-error')", "traceStoreRef.current.finishTrace(traceId, 'error', MISSING_STT_MESSAGE)"] } },
  { file: HOOK, owner: "pause", source: "meeting.capture", event: "pause-native-failed", levels: ["warn"], refs: [],
    factSource: "the catch of the native stop inside Pause", data: { captureOperationId: "count", cause: "bounded-text" },
    knownLimits: [CAUSE_LIMIT],
    caught: { cause: true, from: FROM_NATIVE_STOP, guards: ["stopNativeMeetingCapture(nativeLeaseToStop)"] },
    migration: { id: "M5", test: MIGRATION_TEST, oldOutput: "console.warn('Failed to pause meeting audio capture', error)",
      removedText: ["Failed to pause meeting audio capture"], kept: ["coordinator.authorize(lifecycleOperation, 'native-pause-error')"] } },
  { file: HOOK, owner: "enqueueSpeechDetected", source: "meeting.audio-queue", event: "system-segment-failed", levels: ["warn"], refs: ["traceId"],
    factSource: "the rejection branch of the queued system-audio segment", data: { segmentSequence: "count" },
    knownLimits: [NO_CAUSE_ON_PROVIDER_PATH],
    caught: { cause: false, from: FROM_PROVIDER_PATH, guards: ["processQueuedSpeechSegment(segment)"] },
    migration: { id: "M5", test: MIGRATION_TEST, oldOutput: "console.warn('Failed to process queued system audio segment', error)",
      removedText: ["Failed to process queued system audio segment"],
      kept: ["traceStoreRef.current.startTrace / startStep / updateMetadata of the queued segment", "processQueuedSpeechSegment(segment)"] } },
  { file: HOOK, owner: "enqueueMicrophoneSpeech", source: "meeting.audio-queue", event: "microphone-segment-failed", levels: ["warn"], refs: ["traceId"],
    factSource: "the rejection branch of the queued microphone segment", data: { segmentSequence: "count" },
    knownLimits: [NO_CAUSE_ON_PROVIDER_PATH],
    caught: { cause: false, from: FROM_PROVIDER_PATH, guards: ["processQueuedSpeechSegment(segment)"] },
    migration: { id: "M5", test: MIGRATION_TEST, oldOutput: "console.warn('Failed to process queued microphone segment', error)",
      removedText: ["Failed to process queued microphone segment"],
      kept: ["traceStoreRef.current.startTrace / startStep / updateMetadata of the queued segment", "processQueuedSpeechSegment(segment)"] } },
  { file: HOOK, owner: "reportRawZeroProbe", source: "meeting.raw-zero-input", event: "probe-observed", levels: ["info", "debug"], refs: [],
    factSource: "the stage its caller passes, a fixed code: RAW_ZERO_PROBE_STAGE_LEVELS. The four stages that report an action of the probe (requested, native-restart-started, native-restart-completed, signal-restored) are info, every other stage debug. The capture, the active Screen operation and the episode are the values the report reads itself, before the caller's metadata is merged into the observation; the other fields are read by name from the caller's typed metadata",
    knownLimits: ["by A8, at the default level Info the run log holds the four action stages of the probe, whether or not a recording is active (Task 145). The reports that state the warning or a deferral without an action (screen-wait, probe-ready, probe-used, screen-deferred, inactive, deferred-before-claim, deferred-before-native-stop, screen-wait-reset, request-finished) are debug: at Info the warning is in the log only as the `warning` flag of an action entry, and a warning that no probe action follows has no entry there",
      "episodeDisposition is the episode's own value, read without the Screen state, so it is never 'screen-deferred'; the disposition a caller acted on, which accounts for an active Screen and an inactive capture, is the stage of that report",
      "the start of the zero input and the end of the wait are durations from the moment of the report, never below 0 (zeroDurationMs, waitRemainingMs), not the two times the old print carried",
      "the capture operation is captureOperationId here and operationId in the recorded observation"],
    data: { stage: RAW_ZERO_PROBE_STAGES, captureSessionId: "identifier", captureGeneration: "count", captureOperationId: "count",
      screenOperationId: "identifier", recoveryAttemptId: "identifier", previousCaptureSessionId: "identifier", previousCaptureGeneration: "count",
      snapshotSequence: "count", signalRestored: "boolean", warning: "boolean", episodeDisposition: RAW_ZERO_EPISODE_DISPOSITIONS, probeUsed: "boolean",
      zeroDurationMs: "ms", waitRemainingMs: "ms" },
    migration: { id: "M6", test: MIGRATION_TEST, oldOutput: "console.info('[raw-zero-input]', JSON of the observation)",
      removedText: ["[raw-zero-input]"], levelBy: "the stage", kept: ["sessionRecordingManagerRef.current?.recordCaptureLifecycle(observation)"] } },
  { file: HOOK, owner: "commitHumanGroundTruthV2", source: "meeting.evaluation", event: "persistence-failed", levels: ["error"], refs: ["runtimeSessionId"],
    factSource: "the catch of the evaluation commit: the evaluation was not saved", data: { eventId: "identifier", cause: "bounded-text" },
    knownLimits: [CAUSE_LIMIT],
    caught: { cause: true, from: "the local evaluation store (SQLite, through its native commands)", guards: ["humanEvaluationStore.commit(event, frozenObserved)"] },
    migration: { id: "M7", test: EVALUATION_TEST, oldOutput: "console.error('Evaluation persistence failed', { eventId, sessionId, error text })",
      removedText: ["Evaluation persistence failed"], kept: ["humanEvaluationStore.commit(event, frozenObserved)", "save.error and the persistence state of the panel"] } },
  { file: HOOK, owner: "commitHumanGroundTruthV2", source: "meeting.evaluation", event: "recording-closed-before-mirror", levels: ["warn"],
    refs: ["runtimeSessionId", "recordingSessionId"],
    factSource: "the branch for a committed evaluation whose recording is no longer the active one", data: { eventId: "identifier" },
    migration: { id: "M7", test: EVALUATION_TEST,
      oldOutput: "console.warn('Evaluation committed to SQLite; recording closed before mirror', { eventId, sessionId, recordingId })",
      removedText: ["recording closed before mirror"], kept: ["humanEvaluationStore.commit(event, frozenObserved)", "no recorder call: the mirror is skipped as before"] } },
  { file: HOOK, owner: "refreshHumanEvaluationObservedProjectionForTrace", source: "meeting.evaluation", event: "observed-projection-persist-failed",
    levels: ["warn"], refs: ["traceId"], factSource: "the rejection branch of the observed projection save",
    data: { projectionId: "identifier", cause: "bounded-text" },
    knownLimits: [CAUSE_LIMIT],
    caught: { cause: true, from: "the local evaluation store (SQLite, through its native commands)", guards: ["humanEvaluationStore.saveObservation(result.projection)"] },
    migration: { id: "M7", test: MIGRATION_TEST, oldOutput: "console.warn('Evaluation observed projection persistence failed', { projectionId, error text })",
      removedText: ["Evaluation observed projection persistence failed"],
      kept: ["humanEvaluationStore.saveObservation(result.projection)", "sessionRecordingManagerRef.current?.recordHumanEvaluationProjectionV2(result.projection)"] } },
  { file: HOOK, owner: "loadPersistedTraceMetrics", source: "meeting.trace-metrics", event: "load-failed", levels: ["warn"], refs: [],
    factSource: "the catch of the trace metrics load at mount", data: { cause: "bounded-text" },
    knownLimits: [CAUSE_LIMIT],
    caught: { cause: true, from: "the native command read_meeting_trace_metrics, or the reading and hydration of what it returned",
      guards: ['invoke<string>("read_meeting_trace_metrics")'] },
    migration: { id: "M7", test: MIGRATION_TEST, oldOutput: "console.warn('Failed to load meeting trace metrics', error)",
      removedText: ["Failed to load meeting trace metrics"], kept: ["invoke('read_meeting_trace_metrics')", "scheduleTraceMetricsPersistence()"] } },
  { file: HOOK, owner: "maybeAutoExportTraces", source: "meeting.trace-export", event: "auto-export-failed", levels: ["warn"], refs: ["traceId"],
    factSource: "the rejection branch of the automatic trace export", data: { kind: TRACE_KINDS, status: TRACE_STATUSES, cause: "bounded-text" },
    knownLimits: [CAUSE_LIMIT],
    caught: { cause: true, from: "the native command export_meeting_trace, or the local serialisation of the trace before it",
      guards: ["exportTraceObject(trace, getAutoExportTrigger(trace))"] },
    migration: { id: "M7", test: MIGRATION_TEST, oldOutput: "console.warn('Failed to auto-export meeting trace', error)",
      removedText: ["Failed to auto-export meeting trace"], kept: ["exportTraceObject(trace, getAutoExportTrigger(trace))"] } },
  { file: HOOK, owner: "useMeetingAssistant", source: "meeting.stt-evaluation-capture", event: "initialize-failed", levels: ["warn"], refs: [],
    factSource: "the rejection branch of the capture cleanup and refresh at mount", data: { cause: "bounded-text" },
    knownLimits: [CAUSE_LIMIT],
    caught: { cause: true, from: FROM_CAPTURE_MANAGER, guards: ["sttEvaluationCaptureManagerRef.current?.cleanupExpired()", "sttEvaluationCaptureManagerRef.current?.refresh()"] },
    migration: { id: "M7", test: MIGRATION_TEST, oldOutput: "console.warn('Failed to initialize STT evaluation capture', error)",
      removedText: ["Failed to initialize STT evaluation capture"], kept: ["cleanupExpired() then refresh()"] } },
  { file: HOOK, owner: "intervalId", source: "meeting.stt-evaluation-capture", event: "refresh-failed", levels: ["debug"], refs: [],
    factSource: "the rejection branch of the two-second refresh while a capture is active", data: { cause: "bounded-text" },
    knownLimits: [CAUSE_LIMIT, "a refresh that keeps failing gives one debug entry every two seconds: the logger keeps no first-failure state"],
    caught: { cause: true, from: FROM_CAPTURE_MANAGER, guards: ["sttEvaluationCaptureManagerRef.current?.refresh()"] },
    migration: { id: "M7", test: MIGRATION_TEST, oldOutput: "console.warn('Failed to refresh STT evaluation capture', error)",
      removedText: ["Failed to refresh STT evaluation capture"], kept: ["refresh()"] } },
  { file: HOOK, owner: "useMeetingAssistant", source: "meeting.stt-evaluation-capture", event: "authorization-stop-failed", levels: ["warn"], refs: [],
    factSource: "the rejection branch of the stop that follows a lost authorization source", data: { cause: "bounded-text" },
    knownLimits: [CAUSE_LIMIT],
    caught: { cause: true, from: FROM_CAPTURE_MANAGER, guards: ['?.stop("authorization-source-disabled")'] },
    migration: { id: "M7", test: MIGRATION_TEST, oldOutput: "console.warn('Failed to stop STT evaluation capture', error)",
      removedText: ["Failed to stop STT evaluation capture"], kept: ["stop('authorization-source-disabled')"] } },
  { file: HOOK, owner: "setSttEvaluationCaptureEnabled", source: "meeting.stt-evaluation-capture", event: "update-failed", levels: ["warn"], refs: [],
    factSource: "the rejection branch of the capture start or stop the user asked for", data: { enabled: "boolean", cause: "bounded-text" },
    knownLimits: [CAUSE_LIMIT],
    caught: { cause: true, from: FROM_CAPTURE_MANAGER, guards: ["manager.start(72)", 'manager.stop("manual")'] },
    migration: { id: "M7", test: MIGRATION_TEST, oldOutput: "console.warn('Failed to update STT evaluation capture', error)",
      removedText: ["Failed to update STT evaluation capture"], kept: ["manager.start(72) or manager.stop('manual')"] } },
  { file: HOOK, owner: "deleteSttEvaluationCapture", source: "meeting.stt-evaluation-capture", event: "delete-failed", levels: ["warn"], refs: [],
    factSource: "the rejection branch of the capture delete", data: { cause: "bounded-text" },
    knownLimits: [CAUSE_LIMIT],
    caught: { cause: true, from: FROM_CAPTURE_MANAGER, guards: ["sttEvaluationCaptureManagerRef.current?.deleteCurrent()"] },
    migration: { id: "M7", test: MIGRATION_TEST, oldOutput: "console.warn('Failed to delete STT evaluation capture', error)",
      removedText: ["Failed to delete STT evaluation capture"], kept: ["deleteCurrent()"] } },
  { file: HOOK, owner: "queueNativeStallDiagnostics", source: "meeting.native-stall-diagnostics", event: "request-failed", levels: ["warn"],
    refs: ["recordingSessionId"], factSource: "the catch of the set_native_stall_diagnostics call, for an arm and for a disarm",
    data: { enabled: "boolean", requestSequence: "count", cause: "bounded-text" },
    knownLimits: [CAUSE_LIMIT],
    caught: { cause: true, from: "the native command set_native_stall_diagnostics", guards: ['invoke<string | null>("set_native_stall_diagnostics",'] },
    migration: { id: "M8", test: "tests/native-stall-diagnostics-receipt.test.ts", oldOutput: "console.warn('Native stall diagnostics could not be armed', message)",
      removedText: ["Native stall diagnostics could not be armed"],
      kept: ["settle({ message }): the receipt the panel shows", "recordCaptureLifecycle({ stage: 'native-stall-diagnostics-error', ... })"] } },
  { file: HOOK, owner: "recordManualRuntimeAction", source: "meeting.manual-action", event: "type-correction-recorded", levels: ["info"],
    refs: ["traceId", "operationId"], factSource: "the branch for the action 'type-correction', at each of its stages",
    knownLimits: ["the corrected type and the reason are not in the entry: both are typed as text at this call site"],
    data: { stage: ["requested", "accepted", "terminal"], uiSurface: UI_SURFACES, ingressSource: ["ui", "shortcut"],
      terminalDisposition: ["completed", "rejected", "stale", "failed", "cancelled"] },
    migration: { id: "M10", test: MIGRATION_TEST, oldOutput: "console.info('[manual-runtime-action]', the whole input object)",
      removedText: ["[manual-runtime-action]"], kept: ["createManualRuntimeActionEvent(...)", "the recorded manual action event"] } },
  { file: HOOK, owner: "setInterviewSessionBrief", source: "meeting.interview-brief", event: "brief-updated", levels: ["info"], refs: [],
    factSource: "every Interview Brief update",
    data: { uiSurface: ["normal-mode", "focus-mode"], briefPresent: "boolean", interviewTypeCount: "count" },
    migration: { id: "M10", test: MIGRATION_TEST, oldOutput: "console.info('[interview-brief]', { stage, uiSurface, interviewTypes, priorOnly })",
      removedText: ["[interview-brief]"], kept: ["sessionRecordingManagerRef.current?.recordCaptureLifecycle(observation)", "persistInterviewSessionBrief(normalizedBrief)"] } },
  { file: HOOK, owner: "startCapture", callSites: 2, source: "meeting.capture", event: "start-failed", levels: ["error"], refs: [],
    factSource: "two branches of one start, one call each (decisions A8, item 5). The catch of a capture start whose operation is still authorized: the entry has the cause and no block. The branch for a start that is blocked because no speech-to-text provider is configured, before any native call: the entry names the block, says that no native start was attempted and has no cause, since nothing was caught",
    knownLimits: [CAUSE_LIMIT],
    data: { mode: ["fresh-start", "resume", "automatic-recovery", "manual-recovery"], captureOperationId: "count", nativeStartAttempted: "boolean",
      automaticRecovery: "boolean", manualRecovery: "boolean", silentSourceProbe: "boolean", blocked: ["stt-provider-missing"], cause: "bounded-text" },
    caught: { cause: true, from: "the native permission, stop and start commands of the capture start, or the block's own two errors (permission missing, started without a capture session id)",
      guards: ['invoke<boolean>("check_system_audio_access")', "stopNativeMeetingCapture(previousNativeLease)", 'invoke<MeetingAudioStatus>("start_meeting_audio_session",'] },
    migration: { id: "added", test: "tests/raw-zero-input-probe.test.ts", oldOutput: "nothing: a failed start reached only the panel and an active recording",
      removedText: [], kept: ["recordCaptureLifecycle of the automatic or manual recovery failure", "reconcileCaptureStartFailure(message)",
        "on the blocked branch: reconcileCaptureStartFailure(MISSING_STT_MESSAGE), coordinator.authorize(lifecycleOperation, 'blocked-stt-provider-missing') and the manual recovery record (tests/local-model-retirement.test.ts)"] } },
  { file: HOOK, owner: "stopSessionRecording", source: "meeting.recording", event: "close-failed", levels: ["error"], refs: ["recordingSessionId"],
    factSource: "the catch of the recording manager's stop (decisions A8, item 4): any rejection of that call is a Session Recording close that failed. The reason is the fixed code the caller of the stop gave",
    knownLimits: [CAUSE_LIMIT,
      "the entry does not tell which step of the close failed (the aggregates, the terminal manifest, or a stop asked of an owner that must be abandoned): that is in the cause text and in the recording's own state, which the panel shows"],
    data: { reason: RECORDING_STOP_REASONS, cause: "bounded-text" },
    caught: { cause: true, from: "local persistence: the Session Recording manager's stop, which writes the aggregates and the terminal manifest",
      guards: ["sessionRecordingManagerRef.current?.stop(reason)"] },
    migration: { id: "added", test: MIGRATION_TEST, oldOutput: "nothing: a failed close reached only the panel and the recording's own state",
      removedText: [], kept: ["sessionRecordingManagerRef.current?.recordError(error)", "setState with the message and the recording state", "the rethrow when the caller asked for it"] } },
];

// What commit 3 leaves as it is, each with the text that is still in the source. Log Level does not control any of it.
export const DIAGNOSTIC_LOG_NOT_MIGRATED = [
  { id: "preparation", what: "Preparation: write_preparation_trace_log and its callers, and the material import summary",
    present: [["src/lib/preparation/app-service.ts", 'invoke("write_preparation_trace_log"'], ["src-tauri/src/lib.rs", "fn write_preparation_trace_log("],
      ["src-tauri/src/lib.rs", "fn log_preparation_material_import_summary("]] },
  { id: "focus-window-and-meeting-ui", what: "the focus window and meeting window prints",
    present: [["src/pages/app/components/meeting/focus-window.tsx", "[type-correction-focus-requested]"], ["src/pages/app/components/meeting/focus-window.tsx", "console.error("],
      ["src/pages/app/components/meeting/index.tsx", "console.error("]] },
  { id: "library-callback-warnings", what: "the two library callback warnings that tests pin",
    present: [["src/lib/meeting/task-relation-provider-candidates.ts", 'console.warn("Relation candidate observation callback failed", error)'],
      ["src/lib/meeting/semantic-taxonomy-runtime.ts", 'console.warn("Semantic embedding telemetry callback failed", error)']] },
  { id: "provider-function-layer", what: "the shared provider function layer", present: [["src/lib/functions/ai-response.function.ts", "console.warn("]] },
  { id: "shutdown-hook", what: "the shutdown hook", present: [["src/hooks/useApplicationShutdown.ts", "console.error("]] },
  { id: "task-runtime-transitions", what: "the task-runtime transition and clear rejections (M9)",
    present: [[HOOK, 'console.warn("Meeting task runtime transition rejected", {'], [HOOK, 'console.warn("Meeting task runtime clear rejected", {']] },
  { id: "memory-and-preflight-fallbacks", what: "the memory retrieval and Screen preflight fallback warnings",
    present: [[HOOK, 'console.warn("Failed to retrieve meeting memory context", error)'], [HOOK, "Screen preflight failed; continuing without it"]] },
  { id: "native-prints", what: "native eprintln and println lines, the two inside the realtime audio callback and the two raw receipt lines included",
    present: [["src-tauri/src/app_shutdown.rs", "ApplicationShutdownReceipt "], ["src-tauri/src/native_app_smoke.rs", "NativeSmokeObservation "],
      ["src-tauri/src/speaker/macos.rs", "eprintln!("]] },
] as const;

// Entries the rulings name that this commit does not add, with the reason. None since A8: the error entry of a failed
// Session Recording close, which was listed here, is the row `meeting.recording close-failed`.
export const DIAGNOSTIC_LOG_NOT_ADDED: readonly { id: string; what: string; why: string }[] = [];

// What this slice does not grade, with what the log then holds: an entry at
// debug, or no entry because that path has no logger call.
export const DIAGNOSTIC_LOG_NOT_GRADED = [
  { id: "relation-mixed", entry: "debug", what: "formal Relation: one stage usable and another lost" },
  { id: "relation-runtime-budget-refused", entry: "debug",
    what: "formal Relation: every stage refused by the runtime budget, so no selector ran and no stage has a selection" },
  { id: "relation-internal-failure", entry: "none", what: "formal Relation that fails internally: the Ordered operation rejects before its metadata write" },
  { id: "relation-no-window", entry: "none", what: "a turn with no Relation release window: its consumers never call the Ordered operation" },
  { id: "observation-relation-not-deadline", entry: "debug",
    what: "observation Relation stage that ends unusable before its deadline or with a client error" },
  { id: "auxiliary-not-timeout", entry: "debug", what: "Meeting Metadata inference or Whiteboard repair that fails without a typed provider timeout" },
  { id: "screen-answer", entry: "none", what: "a failed or abandoned Screen answer (the Screen path's own catch) and the Screen solver window" },
  { id: "other-operation-timeouts", entry: "none",
    what: "Coding, Response Opportunity, Project Selection, Evidence Requirement, Source Linkage and Answer Recovery timeouts" },
  { id: "advisor-total-elapsed-observation", entry: "none", what: "the 30 s total-elapsed observation of the Advisor" },
] as const;
export const notGraded = (id: (typeof DIAGNOSTIC_LOG_NOT_GRADED)[number]["id"]) => {
  const row = DIAGNOSTIC_LOG_NOT_GRADED.find((candidate) => candidate.id === id);
  assert.ok(row, `${id} is listed as not graded`);
  return row;
};

const CODE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
// An identifier as the logger takes one: a single token of printable ASCII.
const IDENTIFIER = /^[\x21-\x7e]{1,128}$/;
// A fixed label of the source, such as a trace step name: words, digits, spaces and hyphens.
export const LABEL = /^[A-Za-z][A-Za-z0-9 -]{0,63}$/;
// The cut of the leaf's diagnosticLogCause (DIAGNOSTIC_LOG_CAUSE_CHARS); tests/diagnostic-log.test.ts compares the two.
export const CAUSE_CHARS = 160;

export function ledgerRowOf(entry: Pick<Entry, "source" | "event">): DiagnosticLogLedgerRow {
  const rows = DIAGNOSTIC_LOG_LEDGER.filter((row) => row.source === entry.source && row.event === entry.event);
  assert.equal(rows.length, 1, `exactly one ledger row for ${entry.source} ${entry.event}`);
  return rows[0]!;
}

// LG4 from a call site: the entry holds the ledger's fields and nothing else.
export function assertEntryInLedger(entry: Entry, label = `${entry.source} ${entry.event}`) {
  const row = ledgerRowOf(entry);
  assert.deepEqual(Object.keys(entry).filter((key) => !["v", "at", "level", "source", "event", "refs", "data"].includes(key)), [],
    `${label}: no message and no other part`);
  assert.equal(entry.v, 1, label);
  assert.ok(Number.isFinite(entry.at), label);
  assert.ok(row.levels.includes(entry.level), `${label}: level ${entry.level} is one the ledger lists`);
  for (const [key, value] of Object.entries(entry.refs ?? {})) {
    assert.ok((row.refs as readonly string[]).includes(key), `${label}: reference ${key} is in the ledger`);
    assert.match(value as string, IDENTIFIER, `${label}: reference ${key} is one identifier`);
  }
  for (const [key, value] of Object.entries(entry.data ?? {})) {
    const kind = row.data[key];
    assert.ok(kind, `${label}: data key ${key} is in the ledger`);
    if (kind === "boolean") assert.equal(typeof value, "boolean", `${label}: ${key}`);
    else if (kind === "count") assert.ok(Number.isSafeInteger(value) && (value as number) >= 0, `${label}: ${key} is a count`);
    else if (kind === "ms") assert.ok(typeof value === "number" && Number.isFinite(value) && value >= 0, `${label}: ${key} is a duration`);
    else if (kind === "code") assert.match(value as string, CODE, `${label}: ${key} is a fixed code`);
    else if (kind === "identifier") assert.match(value as string, IDENTIFIER, `${label}: ${key} is one identifier`);
    else if (kind === "label") assert.match(value as string, LABEL, `${label}: ${key} is a fixed label`);
    else if (kind === "bounded-text") {
      assert.equal(key, "cause", `${label}: bounded text is the kind of the key cause alone`);
      assert.ok(typeof value === "string" && value.length <= CAUSE_CHARS, `${label}: ${key} is a text of at most ${CAUSE_CHARS} UTF-16 code units`);
    }
    else assert.ok(typeof value === "string" && kind.includes(value), `${label}: ${key} is one of ${kind.join(", ")}, not ${JSON.stringify(value)}`);
  }
}

// LG4: nothing planted in a scenario's inputs reaches any part of any entry.
export function assertNothingPlanted(entries: readonly Entry[], planted: readonly string[], label: string) {
  const text = JSON.stringify(entries);
  for (const value of planted) {
    assert.ok(value.length >= 8, "a planted value is long enough to be searched for");
    assert.equal(text.includes(value), false, `${label}: ${JSON.stringify(value.slice(0, 24))} is in no entry`);
    // Its first words alone are not there either: a cut text is still that text.
    assert.equal(text.includes(value.slice(0, 12)), false, `${label}: no part of ${JSON.stringify(value.slice(0, 24))} is in an entry`);
  }
}

// Planted in scenario inputs by the call-site tests: a provider error text, a
// transcript sentence, a value in the shape of a secret, a device label, a
// file path and an answer sentence.
export const PLANTED = {
  providerError: "Upstream said: quota exhausted for org-PLANTED-1234, retry after 31s",
  transcript: "Tell me about the PLANTED payments migration you led last spring",
  secret: "sk-PLANTED0123456789abcdefABCDEF",
  deviceLabel: "PLANTED Studio Display Speakers of Jordan",
  filePath: "/Users/planted-user/Recordings/PLANTED-session/manifest.json",
  answer: "I led the PLANTED ledger cutover and kept both systems in step for a month",
} as const;
export const PLANTED_VALUES: readonly string[] = Object.values(PLANTED);
// Decisions A8, item 1: what may be where. A provider error body, a transcript sentence, an answer sentence and a
// value in the shape of an API key are in no part of any entry. A device label and a file path may be in the field
// `cause`, which holds the error text of a native command or of local persistence, and in no other part.
export const PLANTED_NOWHERE: readonly string[] = [PLANTED.providerError, PLANTED.transcript, PLANTED.answer, PLANTED.secret];
export const PLANTED_IN_CAUSE_ONLY: readonly string[] = [PLANTED.deviceLabel, PLANTED.filePath];
export function assertPlantedOnlyInCause(entries: readonly Entry[], label: string) {
  assertNothingPlanted(entries, PLANTED_NOWHERE, label);
  const outsideCause = entries.map((entry) => {
    if (entry.data === undefined || !("cause" in entry.data)) return entry;
    const { cause: _cause, ...data } = entry.data;
    return { ...entry, data };
  });
  assertNothingPlanted(outsideCause, PLANTED_IN_CAUSE_ONLY, `${label}, outside cause`);
}

// ---- every logger call site in src ----

export interface DiagnosticLogCallSite { file: string; owner: string; source: string; event: string; lazyDetail: boolean; awaited: boolean; line: number }

// Reads src and lists each `logDiagnostic(...)` call with the named declaration
// of its file that contains it. Tags that are not string literals are reported
// as they are written, so a computed tag cannot match a ledger row.
export function listDiagnosticLogCallSites(root = "src"): DiagnosticLogCallSite[] {
  const sites: DiagnosticLogCallSite[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const text = readFileSync(file, "utf8");
      if (!text.includes("logDiagnostic")) continue;
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, entry.name.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && node.expression.getText(source) === "logDiagnostic") {
          // The outermost named declaration below the module's top-level function, or that function.
          const owners: string[] = [];
          for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
            // A class and its method count like a function and a declaration inside it.
            if ((ts.isVariableDeclaration(current) || ts.isFunctionDeclaration(current) || ts.isClassDeclaration(current) ||
              ts.isMethodDeclaration(current)) && current.name && ts.isIdentifier(current.name)) {
              owners.push(current.name.text);
            }
          }
          const literal = (argument: ts.Expression | undefined) =>
            argument && ts.isStringLiteralLike(argument) ? argument.text : `<${argument?.getText(source) ?? "missing"}>`;
          const detail = node.arguments[3];
          sites.push({ file: file.split(path.sep).join("/"), owner: owners.length > 1 ? owners[owners.length - 2]! : owners[0] ?? "<module>",
            source: literal(node.arguments[1]), event: literal(node.arguments[2]),
            lazyDetail: detail === undefined || ts.isArrowFunction(detail) || ts.isFunctionExpression(detail),
            awaited: ts.isAwaitExpression(node.parent),
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  };
  walk(root);
  return sites;
}
