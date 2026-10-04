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
// environment gets `spy.logDiagnostic` under the name `logDiagnostic`.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type * as Leaf from "../../src/lib/meeting/diagnostic-log.js";

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

// ---- the field ledger ----
//
// One row per `logDiagnostic(` call in src: where it is, its fixed tags, the
// levels it can use and every field it can carry with the values that field
// can take. An entry holds nothing else: no message, no other reference, no
// other data key, and no string that is not one of the listed values.

type FieldKind =
  | "boolean"
  // A whole number that is not negative.
  | "count"
  // A duration or a limit in milliseconds.
  | "ms"
  // A fixed code of the producer: lower-case words joined by hyphens.
  | "code"
  | readonly string[];

export interface DiagnosticLogLedgerRow {
  // The file and the named declaration of that file the call is in.
  file: string;
  owner: string;
  source: string;
  event: string;
  levels: readonly Level[];
  refs: readonly (keyof Leaf.DiagnosticLogRefs)[];
  data: Readonly<Record<string, FieldKind>>;
  // The typed fact each level is read from.
  factSource: string;
  // What the entry is known not to tell apart, where that is so.
  knownLimits?: readonly string[];
}

const SELECTION_REASONS = ["intelligent-valid", "intelligent-invalid-fast-valid", "candidates-ended-unusable", "client-error",
  "candidate-deadline-expired"] as const;
const RUNTIME_DISPOSITIONS = ["completed", "error", "superseded", "budget-exhausted", "operation-mismatch", "disposed"] as const;
const PROVIDER_STATUSES = ["success", "empty", "failed", "timed-out", "aborted"] as const;
const FAILURE_CLASSES = ["configuration", "transport", "authentication", "rate-limit", "provider-http", "provider-response-parse",
  "stream-unavailable", "stream-read", "unexpected"] as const;
const HOOK = "src/hooks/useMeetingAssistant.ts";

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
];

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
// transcript sentence and a value in the shape of a secret.
export const PLANTED = {
  providerError: "Upstream said: quota exhausted for org-PLANTED-1234, retry after 31s",
  transcript: "Tell me about the PLANTED payments migration you led last spring",
  secret: "sk-PLANTED0123456789abcdefABCDEF",
} as const;
export const PLANTED_VALUES: readonly string[] = Object.values(PLANTED);

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
            if ((ts.isVariableDeclaration(current) || ts.isFunctionDeclaration(current)) && current.name && ts.isIdentifier(current.name)) {
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
