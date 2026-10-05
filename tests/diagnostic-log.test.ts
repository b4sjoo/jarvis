// Task 178 LG, frontend logger: LG1 (level contract and filtering), LG4 (privacy
// and bounds), LG5 (bounded queue and failures) and LG8 (frontend cost).
//
// Real: src/lib/meeting/diagnostic-log.ts and the Tauri invoke entry it imports
// (@tauri-apps/api/core). Every test loads its own instance of the module, as a
// page load does, so no test reads another test's queue or counters.
// Controlled: the native side of the IPC boundary (window.__TAURI_INTERNALS__,
// the object the real invoke entry calls), the timers, the clock and the console
// methods. The native stand-in answers a version 1 receipt for the level and
// the entries it was sent, as the frozen wire contract says native does.
// What is asserted about "the wire" is the JSON of the invoke arguments, written
// with the replacer rule of Tauri 2's own message serialiser.
// The real Tauri round trip and the native sink are not run here.
// Shared with native: tests/fixtures/diagnostic-log-wire-v1.json is every call
// the real logger makes for the fixed inputs of the fixture test below, with
// the receipt each call is answered with, and
// src-tauri/src/diagnostic_log_tests.rs feeds that file to the native command
// and to a real sink over a temporary directory, which has to answer exactly
// those receipts.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import v8 from "node:v8";
import vm from "node:vm";
import {
  DEFAULT_DIAGNOSTIC_LOG_LEVEL,
  DIAGNOSTIC_LOG_INVALID_LEVEL_MESSAGE,
  DIAGNOSTIC_LOG_LEVELS,
  DIAGNOSTIC_LOG_LIMITS,
  DIAGNOSTIC_LOG_MALFORMED_RECEIPT_MESSAGE,
  DIAGNOSTIC_LOG_NO_REPLY_MESSAGE,
  DIAGNOSTIC_LOG_REJECTED_MESSAGE,
  diagnosticLogLevelIncludes,
  isDiagnosticLogLevel,
  readDiagnosticLogReceipt,
  type DiagnosticLogDetail,
  type DiagnosticLogDetailInput,
  type DiagnosticLogEntry,
  type DiagnosticLogLevel,
  type DiagnosticLogReceipt,
  type DiagnosticLogSnapshot,
} from "../src/lib/meeting/diagnostic-log.js";
import { CAUSE_CHARS } from "./helpers/diagnostic-log-spy.js";

type Logger = typeof import("../src/lib/meeting/diagnostic-log.js");

const LEVELS = ["error", "warn", "info", "debug", "trace"] as const;
// Written out, not computed: the levels each threshold lets through.
const PASSES: Record<DiagnosticLogLevel, readonly DiagnosticLogLevel[]> = {
  error: ["error"],
  warn: ["error", "warn"],
  info: ["error", "warn", "info"],
  debug: ["error", "warn", "info", "debug"],
  trace: ["error", "warn", "info", "debug", "trace"],
};
const CONSOLE_METHOD: Record<DiagnosticLogLevel, "error" | "warn" | "info" | "debug"> = {
  error: "error", warn: "warn", info: "info", debug: "debug", trace: "debug",
};
const CLOCK = Date.UTC(2026, 9, 4, 12, 0, 0);
// Text of an exact length made of short words, and an identifier of an exact length made of dotted segments.
// Neither is one unbroken run of 96 or more base64 characters, which the logger treats as an encoded blob.
const words = (length: number, word = "lorem") => `${word} `.repeat(Math.ceil(length / (word.length + 1))).slice(0, length);
const dotted = (length: number, segment: string) => `${segment}.`.repeat(Math.ceil(length / (segment.length + 1))).slice(0, length);
const INVALID_LEVEL = "Diagnostic log level is not one of error, warn, info, debug, trace";
const FIXTURE = "tests/fixtures/diagnostic-log-wire-v1.json";

let instances = 0;
// A fresh module instance: its own threshold, queue and counters, as after a page load.
async function loadLogger(): Promise<Logger> {
  const url = new URL(`../src/lib/meeting/diagnostic-log.js?instance=${++instances}`, import.meta.url);
  return (await import(url.href)) as Logger;
}

interface WireCall { command: string; level: unknown; entries: any[]; json: string }
interface HeldCall { call: WireCall; resolve(value: unknown): void; reject(error: unknown): void }
type Reply = "receipt" | "reject" | "reject-unprintable" | "hold" | "malformed" | "throw";
// The member Tauri 2's message serialiser looks for in every object it writes (tauri 2.8.2,
// scripts/process-ipc-message-fn.js): when an object has it, the serialiser calls it.
const TAURI_SERIALIZE_HOOK = "__TAURI_TO_IPC_KEY__";
const tauriReplacer = (_key: string, value: unknown) =>
  typeof value === "object" && value !== null && TAURI_SERIALIZE_HOOK in value ? (value as Record<string, () => unknown>)[TAURI_SERIALIZE_HOOK]!() : value;

const receiptFor = (level: unknown, entries: unknown[], patch: Partial<DiagnosticLogReceipt> = {}): DiagnosticLogReceipt => ({
  v: 1, appliedLevel: level as DiagnosticLogLevel, accepted: entries.length, filtered: 0, rejected: 0, dropped: 0,
  sink: { state: "ready", droppedTotal: 0, writeFailures: 0, unsavedAtExit: 0 }, ...patch,
});

// One test's world: a logger instance, the native side of the boundary, timers, clock and console.
// `measured` leaves the real clock in place and gives the console plain functions, so that a timing
// reads the logger and not the test doubles.
async function world(t: TestContext, options: { measured?: boolean } = {}) {
  if (options.measured) t.mock.timers.enable({ apis: ["setTimeout"] });
  else t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: CLOCK });
  // The timers the logger holds, counted at the two global functions it calls.
  const liveTimers = new Set<unknown>();
  const mockedSetTimeout = globalThis.setTimeout;
  const mockedClearTimeout = globalThis.clearTimeout;
  const countingSetTimeout = ((callback: () => void, ms?: number) => {
    const id: unknown = mockedSetTimeout(() => { liveTimers.delete(id); callback(); }, ms);
    liveTimers.add(id);
    return id;
  }) as unknown as typeof setTimeout;
  const countingClearTimeout = ((id: unknown) => { liveTimers.delete(id); mockedClearTimeout(id as never); }) as typeof clearTimeout;
  globalThis.setTimeout = countingSetTimeout;
  globalThis.clearTimeout = countingClearTimeout;
  t.after(() => {
    if (globalThis.setTimeout === countingSetTimeout) globalThis.setTimeout = mockedSetTimeout;
    if (globalThis.clearTimeout === countingClearTimeout) globalThis.clearTimeout = mockedClearTimeout;
  });
  const calls: WireCall[] = [];
  const held: HeldCall[] = [];
  const control: { reply: Reply; receipt?: (call: WireCall) => unknown; onArguments?: (args: { entries: object[] }) => void } = { reply: "receipt" };
  const nativeInvoke = (command: string, args: unknown) => {
    control.onArguments?.(args as { entries: object[] });
    // What crosses the boundary is JSON, written as Tauri's serialiser writes it. As there, a failure
    // to write it rejects the call.
    let json: string;
    try { json = JSON.stringify(args, tauriReplacer); } catch (error) { return Promise.reject(error); }
    const wire = JSON.parse(json) as { level: unknown; entries: any[] };
    const call: WireCall = { command, level: wire.level, entries: wire.entries, json };
    calls.push(call);
    if (control.reply === "throw") throw new Error("the boundary threw");
    if (control.reply === "reject") return Promise.reject("native rejected the call");
    // A reason that cannot be turned into text.
    if (control.reply === "reject-unprintable") return Promise.reject(Object.create(null));
    if (control.reply === "malformed") return Promise.resolve({ ok: true });
    if (control.reply === "hold") return new Promise((resolve, reject) => { held.push({ call, resolve, reject }); });
    if (!LEVELS.includes(wire.level as DiagnosticLogLevel)) return Promise.reject(INVALID_LEVEL);
    return Promise.resolve(control.receipt ? control.receipt(call) : receiptFor(wire.level, wire.entries));
  };
  (globalThis as any).window = { __TAURI_INTERNALS__: { invoke: nativeInvoke } };
  t.after(() => { delete (globalThis as any).window; });

  const mirrored: Array<{ method: string; args: unknown[] }> = [];
  let printed = 0;
  for (const method of ["error", "warn", "info", "debug", "log", "trace"] as const) {
    if (options.measured) {
      const original = console[method];
      console[method] = () => { printed += 1; };
      t.after(() => { console[method] = original; });
    } else t.mock.method(console, method, (...args: unknown[]) => { mirrored.push({ method, args }); });
  }

  const logger = await loadLogger();
  const microtasks = async () => { for (let turn = 0; turn < 20; turn += 1) await Promise.resolve(); };
  const advance = async (ms: number) => { t.mock.timers.tick(ms); await microtasks(); };
  // The next task: a real turn of the event loop, in which a timer that is due runs. No time passes.
  const task = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); await advance(0); };
  // Runs the flush timer until nothing is queued or in flight.
  const drain = async () => {
    for (let round = 0; round < 400; round += 1) {
      const snapshot = logger.readDiagnosticLogSnapshot();
      if (snapshot.queued === 0 && !snapshot.inFlight) { await advance(0); if (logger.readDiagnosticLogSnapshot().queued === 0) return; }
      await advance(DIAGNOSTIC_LOG_LIMITS.flushDelayMs);
    }
    assert.fail("the queue did not drain");
  };
  const sent = () => calls.flatMap((call) => call.entries) as DiagnosticLogEntry[];
  return { logger, calls, held, control, mirrored, printed: () => printed, advance, task, drain, sent, snapshot: () => logger.readDiagnosticLogSnapshot(),
    pendingTimers: () => liveTimers.size };
}
type World = Awaited<ReturnType<typeof world>>;

// The A2 entry bounds, restated here from the frozen contract and applied to what was sent.
function assertWithinA2(entry: any, label: string) {
  assert.equal(Object.prototype.toString.call(entry), "[object Object]", label);
  assert.deepEqual(Object.keys(entry).filter((key) => !["v", "at", "level", "source", "event", "message", "refs", "data"].includes(key)), [], label);
  assert.equal(entry.v, 1, label);
  assert.ok(typeof entry.at === "number" && Number.isFinite(entry.at), label);
  assert.ok(LEVELS.includes(entry.level), label);
  assert.match(entry.source, /^[a-z0-9.-]{1,48}$/, label);
  assert.match(entry.event, /^[a-z0-9.-]{1,64}$/, label);
  if ("message" in entry) {
    assert.equal(typeof entry.message, "string", label);
    assert.ok(entry.message.length <= 256, label);
  }
  if ("refs" in entry) {
    assert.equal(Object.prototype.toString.call(entry.refs), "[object Object]", label);
    for (const [key, value] of Object.entries(entry.refs)) {
      assert.ok(["runtimeSessionId", "recordingSessionId", "traceId", "operationId", "requestId"].includes(key), `${label}: ref ${key}`);
      assert.ok(typeof value === "string" && value.length <= 128, `${label}: ref ${key}`);
    }
  }
  if ("data" in entry) {
    assert.equal(Object.prototype.toString.call(entry.data), "[object Object]", label);
    const keys = Object.keys(entry.data);
    assert.ok(keys.length <= 16, label);
    for (const key of keys) {
      assert.match(key, /^[A-Za-z0-9_.-]{1,48}$/, label);
      const value = entry.data[key];
      assert.ok(value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) ||
        (typeof value === "string" && value.length <= 256), `${label}: data ${key}`);
    }
  }
  assert.ok(Buffer.byteLength(JSON.stringify(entry), "utf8") <= 2048, `${label}: at most 2,048 bytes`);
}
const assertAllWithinA2 = (w: World) => {
  for (const [index, call] of w.calls.entries()) {
    assert.equal(call.command, "write_diagnostic_log");
    assert.ok(LEVELS.includes(call.level as DiagnosticLogLevel), `call ${index} carries a level`);
    assert.ok(call.entries.length <= 64, `call ${index} carries at most 64 entries`);
    for (const entry of call.entries) assertWithinA2(entry, `call ${index}`);
  }
};
// The counters that say something was refused, dropped or failed.
const quiet = (snapshot: DiagnosticLogSnapshot) => ({
  refusedEntries: snapshot.refusedEntries, refusedFields: snapshot.refusedFields, truncatedFields: snapshot.truncatedFields,
  oversizeEntries: snapshot.oversizeEntries, detailFailures: snapshot.detailFailures, reentrantCalls: snapshot.reentrantCalls,
  internalErrors: snapshot.internalErrors, dropped: snapshot.dropped, ipcFailures: snapshot.ipcFailures,
  ipcTimeouts: snapshot.ipcTimeouts, ipcMalformedReceipts: snapshot.ipcMalformedReceipts, undeliveredEntries: snapshot.undeliveredEntries,
});
const QUIET = { refusedEntries: 0, refusedFields: 0, truncatedFields: 0, oversizeEntries: 0, detailFailures: 0, reentrantCalls: 0,
  internalErrors: 0, dropped: { error: 0, warn: 0, info: 0, debug: 0, trace: 0 }, ipcFailures: 0, ipcTimeouts: 0,
  ipcMalformedReceipts: 0, undeliveredEntries: 0 };

// ---- LG1: level contract and filtering ----

test("LG1 the level contract: five levels, most severe first, default info, and a threshold includes every more severe level (5 x 5)", () => {
  assert.deepEqual([...DIAGNOSTIC_LOG_LEVELS], [...LEVELS]);
  assert.equal(DEFAULT_DIAGNOSTIC_LOG_LEVEL, "info");
  let pairs = 0;
  for (const threshold of LEVELS) for (const level of LEVELS) {
    assert.equal(diagnosticLogLevelIncludes(threshold, level), PASSES[threshold].includes(level), `${threshold} / ${level}`);
    pairs += 1;
  }
  assert.equal(pairs, 25);
  for (const level of LEVELS) assert.equal(isDiagnosticLogLevel(level), true);
  for (const other of ["", "INFO", "Info", "verbose", "fatal", "off", "all", 2, null, undefined, true, ["info"], { level: "info" }]) {
    assert.equal(isDiagnosticLogLevel(other), false, JSON.stringify(other));
    assert.equal(diagnosticLogLevelIncludes(other as DiagnosticLogLevel, "error"), false);
    assert.equal(diagnosticLogLevelIncludes("trace", other as DiagnosticLogLevel), false);
  }
  assert.deepEqual(DIAGNOSTIC_LOG_LIMITS, { queueEntries: 512, batchEntries: 64, flushDelayMs: 50, replyTimeoutMs: 5000, entryBytes: 2048,
    sourceChars: 48, eventChars: 64, messageChars: 256, refChars: 128, dataKeys: 16, dataKeyChars: 48, dataStringChars: 256 });
});

test("LG1 the logger filters by the same table: each of the 25 pairs is accepted, mirrored and sent, or filtered with nothing done", async (t) => {
  const w = await world(t);
  assert.equal(w.snapshot().threshold, "info", "a logger that was never configured filters at info");
  let pairs = 0;
  for (const threshold of LEVELS) for (const level of LEVELS) {
    const label = `${threshold} / ${level}`;
    assert.equal(w.logger.setDiagnosticLogThreshold(threshold), true);
    assert.equal(w.snapshot().threshold, threshold);
    const before = w.snapshot();
    const callsBefore = w.calls.length;
    const mirroredBefore = w.mirrored.length;
    let detailCalls = 0;
    const returned = w.logger.logDiagnostic(level, "lg1.table", `pair.${threshold}.${level}`, () => { detailCalls += 1; return { data: { threshold, level } }; });
    assert.equal(returned, undefined, "the entry call returns nothing");
    await w.drain();
    const after = w.snapshot();
    if (PASSES[threshold].includes(level)) {
      assert.deepEqual([after.accepted - before.accepted, after.filtered - before.filtered, detailCalls], [1, 0, 1], label);
      assert.equal(w.calls.length, callsBefore + 1, label);
      const call = w.calls.at(-1)!;
      assert.equal(call.level, threshold, `${label}: the call carries the threshold`);
      assert.deepEqual(call.entries, [{ v: 1, at: call.entries[0].at, level, source: "lg1.table", event: `pair.${threshold}.${level}`, data: { threshold, level } }], label);
      assert.deepEqual(w.mirrored.slice(mirroredBefore).map((line) => line.method), [CONSOLE_METHOD[level]], `${label}: the matching console method`);
      assert.deepEqual(w.mirrored.at(-1)!.args, ["[diagnostic-log]", call.entries[0]], label);
    } else {
      assert.deepEqual([after.accepted - before.accepted, after.filtered - before.filtered, detailCalls], [0, 1, 0], label);
      assert.equal(w.calls.length, callsBefore, `${label}: nothing is sent`);
      assert.equal(w.mirrored.length, mirroredBefore, `${label}: nothing is printed`);
    }
    pairs += 1;
  }
  assert.equal(pairs, 25);
  assert.deepEqual([w.snapshot().accepted, w.snapshot().filtered], [15, 10]);
  assert.deepEqual(quiet(w.snapshot()), QUIET);
  assertAllWithinA2(w);
});

test("LG1 the frontend and native effective levels are comparable through the receipt: an apply is one call with an empty batch", async (t) => {
  const w = await world(t);
  assert.deepEqual(w.snapshot().native, { accepted: 0, filtered: 0, rejected: 0, dropped: 0 }, "nothing is known about native before the first reply");
  for (const level of LEVELS) {
    const before = w.calls.length;
    const applied = w.logger.applyDiagnosticLogLevel(level);
    assert.equal(w.snapshot().threshold, level, "the frontend threshold is set at once");
    assert.equal(w.calls.length, before, "the call leaves from a timer, not from the caller's stack");
    await w.advance(0);
    assert.deepEqual(w.calls.slice(before).map((call) => [call.command, call.json]), [["write_diagnostic_log", JSON.stringify({ level, entries: [] })]]);
    const receipt = await applied;
    assert.deepEqual(receipt, receiptFor(level, []));
    assert.equal(w.snapshot().native.appliedLevel, level);
    assert.equal(w.snapshot().native.appliedLevel, w.snapshot().threshold, "both sides at the same level");
    assert.deepEqual(w.snapshot().native.sink, { state: "ready", droppedTotal: 0, writeFailures: 0, unsavedAtExit: 0 });
  }
  // Native answering another level is visible, not hidden: the two values differ in the snapshot and in the receipt.
  w.control.receipt = (call) => receiptFor("warn", call.entries, { sink: { state: "degraded", droppedTotal: 3, writeFailures: 1, unsavedAtExit: 0 } });
  const mismatched = w.logger.applyDiagnosticLogLevel("trace");
  await w.advance(0);
  assert.equal((await mismatched).appliedLevel, "warn");
  assert.deepEqual([w.snapshot().threshold, w.snapshot().native.appliedLevel, w.snapshot().native.sink?.state], ["trace", "warn", "degraded"]);
  // Every later batch carries the frontend threshold as its level.
  w.control.receipt = undefined;
  w.logger.logDiagnostic("trace", "lg1.receipt", "batch-level");
  await w.drain();
  assert.equal(w.calls.at(-1)!.level, "trace");
  assert.equal(w.snapshot().native.appliedLevel, "trace");
  assert.equal(w.snapshot().ipcCalls, w.calls.length);
});

test("LG1 an unknown level changes nothing: the setter answers false, the apply rejects without a call, the entry call is refused", async (t) => {
  const w = await world(t);
  for (const other of ["verbose", "INFO", "", null, undefined, 3, { level: "trace" }]) {
    assert.equal(w.logger.setDiagnosticLogThreshold(other as DiagnosticLogLevel), false, JSON.stringify(other));
    await assert.rejects(w.logger.applyDiagnosticLogLevel(other as DiagnosticLogLevel), { message: DIAGNOSTIC_LOG_INVALID_LEVEL_MESSAGE });
    w.logger.logDiagnostic(other as DiagnosticLogLevel, "lg1.unknown", "level");
  }
  await w.advance(DIAGNOSTIC_LOG_LIMITS.replyTimeoutMs);
  assert.equal(w.snapshot().threshold, "info");
  assert.deepEqual([w.calls.length, w.mirrored.length, w.snapshot().accepted, w.snapshot().refusedEntries], [0, 0, 0, 7]);
});

// ---- LG4: privacy and bounds ----

const SECRET_KEY = "sk-live-0123456789abcdefghijklmnop";
const TRANSCRIPT = "Interviewer: tell me about the cache you built at Quartz Relay and why it failed in production";
const PROMPT = "You are a live meeting co-pilot. Answer the question using the candidate's memory below.";
const ANSWER = "Answer: I led the cache redesign and cut the p99 latency by forty percent.";
const IMAGE = `data:image/png;base64,${"iVBORw0KGgoAAAANSUhEUg".repeat(8)}`;
const AUDIO_BASE64 = "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA".repeat(3);
const PROVIDER_CONFIG = {
  provider: "openai", curl: `curl https://api.example/v1/chat -H 'Authorization: Bearer ${SECRET_KEY}'`,
  variables: { API_KEY: SECRET_KEY, MODEL: "gpt" }, headers: { Authorization: `Bearer ${SECRET_KEY}` },
};
const FORBIDDEN = [SECRET_KEY, "Bearer", "Authorization", TRANSCRIPT, PROMPT, ANSWER, "iVBORw0KGgo", "UklGRiQAAABXQVZF", "api.example", "[object", "curl "];
const assertNothingForbidden = (w: World) => {
  const wire = w.calls.map((call) => call.json).join("\n");
  const printed = JSON.stringify(w.mirrored.map((line) => line.args));
  for (const text of FORBIDDEN) {
    assert.equal(wire.includes(text), false, `the wire holds no ${JSON.stringify(text)}`);
    assert.equal(printed.includes(text), false, `the console holds no ${JSON.stringify(text)}`);
  }
};

test("LG4 the typed input has no part for content, a secret, a header, a configuration, an object or an Error", async (t) => {
  const w = await world(t);
  // Each line below is rejected by the compiler; the directive fails the build if it ever compiles.
  // @ts-expect-error the detail has no transcript part
  const transcript: DiagnosticLogDetail = { transcript: TRANSCRIPT };
  // @ts-expect-error the detail has no prompt part
  const prompt: DiagnosticLogDetail = { prompt: PROMPT };
  // @ts-expect-error the detail has no answer part
  const answer: DiagnosticLogDetail = { answer: ANSWER };
  // @ts-expect-error the detail has no error part
  const error: DiagnosticLogDetail = { error: new Error(TRANSCRIPT) };
  // @ts-expect-error the detail has no headers part
  const headers: DiagnosticLogDetail = { headers: PROVIDER_CONFIG.headers };
  // @ts-expect-error a data value is a scalar, not an object
  const nested: DiagnosticLogDetail = { data: { provider: PROVIDER_CONFIG } };
  // @ts-expect-error a data value is a scalar, not an Error
  const errorValue: DiagnosticLogDetail = { data: { cause: new Error(ANSWER) } };
  // @ts-expect-error a data value is a scalar, not an array
  const arrayValue: DiagnosticLogDetail = { data: { turns: [TRANSCRIPT] } };
  // @ts-expect-error the references are five fixed names
  const reference: DiagnosticLogDetail = { refs: { sessionId: "session" } };
  // @ts-expect-error the message is a string
  const message: DiagnosticLogDetail = { message: { text: TRANSCRIPT } };
  // @ts-expect-error the detail is an object or a function, not text
  const text: DiagnosticLogDetailInput = TRANSCRIPT;
  // The same values at run time, as an untyped caller would pass them: each is left out and counted.
  const untyped: unknown[] = [transcript, prompt, answer, error, headers, nested, errorValue, arrayValue, reference, message, text];
  w.logger.setDiagnosticLogThreshold("trace");
  for (const [index, detail] of untyped.entries()) w.logger.logDiagnostic("info", "lg4.typed", `case.${index}`, detail as DiagnosticLogDetail);
  await w.drain();
  assert.deepEqual(w.sent().map((entry) => Object.keys(entry)), untyped.map(() => ["v", "at", "level", "source", "event"]),
    "every event is kept and none carries a detail");
  assert.deepEqual([w.snapshot().accepted, w.snapshot().refusedFields], [11, 11]);
  assertNothingForbidden(w);
  assertAllWithinA2(w);
});

test("LG4 secrets, headers, configuration and content passed past the types are refused and counted; none reaches the wire or the console", async (t) => {
  const w = await world(t);
  w.logger.setDiagnosticLogThreshold("trace");
  const cases: Array<[string, unknown, number]> = [
    // [event, detail, detail parts refused]
    ["key.api-key", { data: { apiKey: SECRET_KEY, api_key: SECRET_KEY, "api-key": SECRET_KEY, "api.key": SECRET_KEY } }, 4],
    ["key.secret", { data: { authorization: "Basic abc", Authorization: "x", bearer: "x", token: "x", accessToken: "x", secret: "x",
      clientSecret: "x", password: "x", cookie: "x", credential: "x" } }, 10],
    ["key.headers", { data: { header: "x-request: 1", headers: "a: b", curl: "curl x", providerConfig: "{}", config: "x" } }, 5],
    // Short names are matched whole, in any case; longer names anywhere in the key.
    ["key.short", { data: { key: "x", Key: "x", auth: "x", AUTH: "x", pass: "x", pwd: "x", sig: "x", access: "x" } }, 8],
    ["key.long", { data: { passwd: "x", passphrase: "x", signature: "x", privateKey: "x", accessKey: "x", authToken: "x",
      "subscription-key": "x", "Ocp-Apim-Subscription-Key": "x", "x-api-key": "x", "xi-api-key": "x" } }, 10],
    ["key.content", { data: { transcript: "hello", prompt: "hi", systemPrompt: "hi", answer: "yes", answerText: "yes", image: "x",
      imageBase64: "x", audio: "x", audioChunk: "x", base64: "x" } }, 10],
    ["value.bearer", { message: `failed with Bearer ${SECRET_KEY}`, data: { note: "bearer abc" } }, 2],
    ["value.header", { message: "Authorization: Basic abc", data: { note: "authorization=abc", other: "api key: 123", third: "API_KEY=1" } }, 4],
    ["value.key", { message: `key ${SECRET_KEY}`, data: { model: SECRET_KEY } }, 2],
    ["value.media", { message: IMAGE, data: { shot: IMAGE, chunk: AUDIO_BASE64 } }, 3],
    ["value.config", { message: PROVIDER_CONFIG.curl, data: { command: PROVIDER_CONFIG.curl } }, 2],
    ["ref.secret", { refs: { requestId: `Bearer ${SECRET_KEY}`, traceId: AUDIO_BASE64.slice(0, 120) } }, 2],
    ["whole.config", { data: PROVIDER_CONFIG }, 3],
    ["whole.detail", PROVIDER_CONFIG, 4],
  ];
  let expected = 0;
  for (const [event, detail, refused] of cases) {
    const before = w.snapshot().refusedFields;
    w.logger.logDiagnostic("warn", "lg4.privacy", event, detail as DiagnosticLogDetail);
    assert.equal(w.snapshot().refusedFields - before, refused, event);
    expected += refused;
  }
  await w.drain();
  assert.equal(w.snapshot().refusedFields, expected);
  assert.equal(w.snapshot().accepted, cases.length, "the events themselves are kept");
  // What is left is the event and, for the whole configuration passed as data, its one harmless scalar.
  assert.deepEqual(w.sent().map((entry) => [entry.event, entry.message, entry.refs, entry.data]), cases.map(([event]) =>
    [event, undefined, undefined, event === "whole.config" ? { provider: "openai" } : undefined]));
  assertNothingForbidden(w);
  assertAllWithinA2(w);
  // A key that names content or a secret may carry a size, a count or a flag.
  w.logger.logDiagnostic("info", "lg4.privacy", "sizes", { data: { promptChars: 1200, answerChars: 0, transcriptTurns: 3, inputTokens: 512,
    imageBytes: 1024, audioMs: 20.5, hasApiKey: true, tokenLimit: null } });
  await w.drain();
  assert.deepEqual(w.sent().at(-1)!.data, { promptChars: 1200, answerChars: 0, transcriptTurns: 3, inputTokens: 512, imageBytes: 1024,
    audioMs: 20.5, hasApiKey: true, tokenLimit: null });
  assert.equal(w.snapshot().refusedFields, expected, "nothing more was refused");
  // A short name inside another word is not that name: these keys carry text.
  const ordinary = { keyboard: "ansi", signal: "ok", accessMode: "read", bypass: "no", author: "none", passed: "yes", design: "v2" };
  w.logger.logDiagnostic("info", "lg4.privacy", "ordinary-keys", { data: ordinary });
  await w.drain();
  assert.deepEqual(w.sent().at(-1)!.data, ordinary);
  assert.equal(w.snapshot().refusedFields, expected);
});

test("LG4 an unknown object is a counted refusal, never a stringified dump", async (t) => {
  const w = await world(t);
  class ProviderClient { apiKey = SECRET_KEY; model = "gpt"; toString() { return `client ${SECRET_KEY}`; } toJSON() { return { apiKey: SECRET_KEY }; } }
  const cyclic: Record<string, unknown> = { name: "cycle" }; cyclic.self = cyclic;
  const unknowns: unknown[] = [new Error(TRANSCRIPT), [TRANSCRIPT], new Map([["k", ANSWER]]), new Set([PROMPT]), new Date(0),
    () => TRANSCRIPT, Symbol("s"), 10n, new ProviderClient(), cyclic, { toString: () => SECRET_KEY }, Promise.resolve(ANSWER),
    new Uint8Array([1, 2, 3]), /transcript/, Object.create({ inherited: TRANSCRIPT })];
  let refused = 0;
  for (const [index, value] of unknowns.entries()) {
    // As a data value: left out.
    const before = w.snapshot().refusedFields;
    w.logger.logDiagnostic("error", "lg4.unknown", `value.${index}`, { data: { kept: index, value } } as unknown as DiagnosticLogDetail);
    assert.equal(w.snapshot().refusedFields - before, 1, `value ${index}`);
    refused += 1;
  }
  for (const [index, value] of unknowns.slice(0, 8).entries()) {
    // As the message, the references, the data or the detail itself: left out.
    const before = w.snapshot().refusedFields;
    w.logger.logDiagnostic("error", "lg4.unknown", `part.${index}`, { message: value, refs: value, data: value } as unknown as DiagnosticLogDetail);
    w.logger.logDiagnostic("error", "lg4.unknown", `detail.${index}`, value as DiagnosticLogDetail);
    const added = w.snapshot().refusedFields - before;
    // A function as the detail is a detail function: it is called and its string result is refused. Each other case refuses 3 + 1.
    assert.equal(added, 4, `part ${index}`);
    refused += added;
  }
  await w.drain();
  assert.equal(w.snapshot().refusedFields, refused);
  assert.deepEqual(quiet(w.snapshot()), { ...QUIET, refusedFields: refused });
  const sent = w.sent();
  assert.equal(sent.length, unknowns.length + 16);
  assert.deepEqual(sent.slice(0, unknowns.length).map((entry) => entry.data), unknowns.map((_value, index) => ({ kept: index })),
    "the scalar next to the unknown value is kept");
  for (const entry of sent.slice(unknowns.length)) assert.deepEqual(Object.keys(entry), ["v", "at", "level", "source", "event"]);
  assertNothingForbidden(w);
  assert.equal(w.calls.map((call) => call.json).join("").includes("cycle"), false);
  assertAllWithinA2(w);
});

test("LG4 nested, oversize and malformed detail is bounded: every entry on the wire satisfies the A2 bounds", async (t) => {
  const w = await world(t);
  w.logger.setDiagnosticLogThreshold("trace");
  const deep: Record<string, unknown> = {};
  let cursor = deep;
  for (let depth = 0; depth < 200; depth += 1) { cursor.next = { depth }; cursor = cursor.next as Record<string, unknown>; }
  const many = Object.fromEntries(Array.from({ length: 40 }, (_unused, index) => [`k${index}`, index]));
  const long = words(100_000);
  const cjk = "测".repeat(300);
  const emoji = "😀".repeat(200);
  const loneHigh = `${words(255, "ab")}😀`; // the pair straddles the 256 limit
  const cases: Array<[string, unknown]> = [
    ["nested.deep", { data: deep }],
    ["nested.mixed", { data: { ok: 1, inner: { a: 1 }, list: [1, 2], also: "kept" } }],
    ["keys.many", { data: many }],
    ["keys.invalid", { data: { "has space": 1, "": 2, "ünïcode": 3, ["k".repeat(49)]: 4, "a/b": 5, "ok.key-1_x": 6, __proto__x: 7 } }],
    ["keys.proto", { data: JSON.parse('{"__proto__":"polluted","constructor":"c","ok":true}') }],
    ["keys.tauri", { data: { __TAURI_TO_IPC_KEY__: 1, __TAURI_INTERNALS__: "x", __TAURI__: null, ok: true } }],
    ["numbers", { data: { nan: NaN, inf: Infinity, ninf: -Infinity, zero: -0, big: 1e308, small: 5e-324, int: 42 } }],
    ["strings.long", { message: long, data: { a: long, b: long } }],
    ["strings.cjk", { message: cjk, data: { a: cjk } }],
    ["strings.emoji", { message: emoji, data: { a: emoji } }],
    ["strings.surrogate", { message: loneHigh, data: { lone: "\ud83d", low: "\ude00 x", ok: "😀" } }],
    ["strings.control", { message: "line one\nline two\t\u0000\u001f\u2028", data: { quote: '"\\' } }],
    ["refs.bounds", { refs: { traceId: dotted(128, "trace"), operationId: dotted(129, "operation"), requestId: "", runtimeSessionId: 7, recordingSessionId: null, extra: "x" } }],
    ["refs.blob", { refs: { traceId: "t".repeat(96), requestId: "r".repeat(95) } }],
    // An identifier is one token of printable ASCII: the composite request identifier of the Fact Risk Review is one, a
    // sentence, a tab, other scripts and control characters are not.
    ["refs.tokens", { refs: { requestId: 'fact-risk:["meeting_1791115200000_ab12cd",0,"task_1",2]', traceId: "two words",
      operationId: "tab\tinside", runtimeSessionId: "会话", recordingSessionId: "\u0001".repeat(8) } }],
    ["bytes.over", { message: cjk, refs: { traceId: dotted(128, "trace") }, data: Object.fromEntries(Array.from({ length: 16 }, (_unused, index) => [`key${index}`, cjk])) }],
    ["bytes.escapes", { message: "\u0000".repeat(256), data: { a: "\u0001".repeat(128), b: "\u0002".repeat(128) } }],
    ["detail.null", null],
    ["detail.undefined-values", { message: undefined, refs: { traceId: undefined }, data: { a: undefined, b: 1 } }],
  ];
  for (const [event, detail] of cases) w.logger.logDiagnostic("debug", "lg4.bounds", event, detail as DiagnosticLogDetail);
  // Malformed tags and levels are refused whole.
  const malformed: Array<[unknown, unknown]> = [["UPPER", "event"], ["", "event"], ["source", ""], ["a b", "event"], ["source", "e".repeat(65)],
    ["s".repeat(49), "event"], [42, "event"], ["source", { event: 1 }], ["source", "ev_ent"], [undefined, undefined]];
  for (const [source, event] of malformed) w.logger.logDiagnostic("error", source as string, event as string, { message: TRANSCRIPT });
  await w.drain();
  assertAllWithinA2(w);
  assertNothingForbidden(w);
  const byEvent = Object.fromEntries(w.sent().map((entry) => [entry.event, entry]));
  assert.deepEqual(Object.keys(byEvent), cases.map(([event]) => event), "every well-formed event is kept, in order");
  assert.equal(w.snapshot().refusedEntries, malformed.length);
  assert.equal(byEvent["nested.deep"]!.data, undefined);
  assert.deepEqual(byEvent["nested.mixed"]!.data, { ok: 1, also: "kept" });
  assert.deepEqual(Object.keys(byEvent["keys.many"]!.data!), Array.from({ length: 16 }, (_unused, index) => `k${index}`), "the first sixteen keys");
  assert.deepEqual(byEvent["keys.invalid"]!.data, { "ok.key-1_x": 6, __proto__x: 7 });
  assert.deepEqual(byEvent["keys.proto"]!.data, { constructor: "c", ok: true });
  assert.deepEqual(byEvent["keys.tauri"]!.data, { ok: true });
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.deepEqual(byEvent["numbers"]!.data, { zero: 0, big: 1e308, small: 5e-324, int: 42 });
  assert.deepEqual([byEvent["strings.long"]!.message, byEvent["strings.long"]!.data], [words(256), { a: words(256), b: words(256) }]);
  assert.deepEqual([byEvent["strings.cjk"]!.message, byEvent["strings.cjk"]!.data], ["测".repeat(256), { a: "测".repeat(256) }]);
  assert.equal(byEvent["strings.emoji"]!.message, "😀".repeat(128), "128 pairs are 256 units");
  // A pair cut by the limit and a lone surrogate become U+FFFD; JSON then holds no escape native would refuse.
  assert.equal(byEvent["strings.surrogate"]!.message, `${words(255, "ab")}\uFFFD`);
  assert.deepEqual(byEvent["strings.surrogate"]!.data, { lone: "\uFFFD", low: "\uFFFD x", ok: "😀" });
  assert.equal(/\\ud[89ab][0-9a-f]{2}/i.test(w.calls.map((call) => call.json).join("")), false, "no escaped lone surrogate on the wire");
  assert.equal(byEvent["strings.control"]!.message, "line one\nline two\t\u0000\u001f\u2028");
  assert.deepEqual(byEvent["refs.bounds"]!.refs, { traceId: dotted(128, "trace") }, "an identifier over the limit is left out, never cut");
  assert.deepEqual(byEvent["refs.blob"]!.refs, { requestId: "r".repeat(95) }, "an unbroken run of 96 base64 characters is an encoded blob, not an identifier");
  assert.deepEqual(byEvent["refs.tokens"]!.refs, { requestId: 'fact-risk:["meeting_1791115200000_ab12cd",0,"task_1",2]' }, "one token of printable ASCII");
  // Over 2,048 bytes: the data goes first, and the message next when that is not enough. A marker says how large it was.
  assert.deepEqual(Object.keys(byEvent["bytes.over"]!), ["v", "at", "level", "source", "event", "message", "refs", "data"]);
  assert.deepEqual(Object.keys(byEvent["bytes.over"]!.data!), ["oversizeBytes"]);
  assert.ok((byEvent["bytes.over"]!.data!.oversizeBytes as number) > 2048);
  // Escapes count as the bytes they are written with: 512 control characters are 3,072 bytes. The message alone fits.
  assert.deepEqual(Object.keys(byEvent["bytes.escapes"]!), ["v", "at", "level", "source", "event", "message", "data"]);
  assert.deepEqual(Object.keys(byEvent["bytes.escapes"]!.data!), ["oversizeBytes"]);
  assert.ok((byEvent["bytes.escapes"]!.data!.oversizeBytes as number) > 3072);
  assert.deepEqual(Object.keys(byEvent["detail.null"]!), ["v", "at", "level", "source", "event"]);
  assert.deepEqual(byEvent["detail.undefined-values"]!.data, { b: 1 });
  assert.equal("message" in byEvent["detail.undefined-values"]!, false);
  assert.equal("refs" in byEvent["detail.undefined-values"]!, false);
  assert.equal(w.snapshot().oversizeEntries, 2);
  assert.ok(w.snapshot().truncatedFields >= 8);
  assert.deepEqual([w.snapshot().internalErrors, w.snapshot().detailFailures], [0, 0]);
  // The byte counter is the UTF-8 size of what was sent.
  assert.equal(w.snapshot().ipcBytes, w.sent().reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry), "utf8"), 0));
});

test("LG4 a filtered call does nothing: the detail function is not called, a detail object is not read, nothing is queued, mirrored or sent", async (t) => {
  const w = await world(t);
  const reads: string[] = [];
  const watched = new Proxy({ message: "expensive" }, {
    get: (target, key, receiver) => { reads.push(String(key)); return Reflect.get(target, key, receiver); },
    ownKeys: (target) => { reads.push("ownKeys"); return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor: (target, key) => { reads.push(`descriptor ${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key); },
  });
  let formatted = 0;
  const expensive = () => { formatted += 1; return { message: JSON.stringify({ large: "x".repeat(10_000) }) }; };
  const timers = t.mock.timers;
  for (const threshold of LEVELS) {
    w.logger.setDiagnosticLogThreshold(threshold);
    for (const level of LEVELS.filter((candidate) => !PASSES[threshold].includes(candidate))) {
      for (let repeat = 0; repeat < 100; repeat += 1) {
        w.logger.logDiagnostic(level, "lg4.filtered", "never-built", expensive);
        w.logger.logDiagnostic(level, "lg4.filtered", "never-read", watched);
        // A filtered call is not inspected at all: malformed tags are not even looked at.
        w.logger.logDiagnostic(level, undefined as unknown as string, undefined as unknown as string, expensive);
      }
    }
  }
  timers.tick(DIAGNOSTIC_LOG_LIMITS.replyTimeoutMs * 2);
  await w.advance(0);
  assert.equal(formatted, 0, "no detail function ran");
  assert.deepEqual(reads, [], "no detail object was read");
  const snapshot = w.snapshot();
  assert.equal(snapshot.filtered, 10 * 100 * 3);
  assert.deepEqual([snapshot.accepted, snapshot.queued, snapshot.queuePeak, snapshot.ipcCalls, snapshot.ipcEntries, snapshot.ipcBytes], [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(quiet(snapshot), QUIET);
  assert.deepEqual([w.calls.length, w.mirrored.length], [0, 0], "no IPC and no console line");
  // The same calls above the threshold are built: the control that the detail function and the object are otherwise used.
  w.logger.setDiagnosticLogThreshold("trace");
  w.logger.logDiagnostic("trace", "lg4.filtered", "built", expensive);
  w.logger.logDiagnostic("trace", "lg4.filtered", "read", watched);
  assert.equal(formatted, 1);
  assert.ok((reads as string[]).includes("message"));
});

// ---- LG4: what the structure guarantees, and what it leaves to the caller ----

// The positive control of LG4. The logger cannot tell a summary from content in a typed string. What a caller
// that passes content gets is shown here, with what bounds it. This is why every call site is listed with its
// fields in the field ledger of its commit and tested from that call site, and why the lists are only a backstop.
test("LG4 the control for typed text is the caller: a sentence as the message or as a string data value is sent as written, bounded; a reference is one token", async (t) => {
  const w = await world(t);
  w.logger.setDiagnosticLogThreshold("trace");
  w.logger.logDiagnostic("warn", "lg4.control", "typed-text", { message: TRANSCRIPT, refs: { traceId: PROMPT, requestId: "request_1" },
    data: { note: ANSWER, question: TRANSCRIPT } });
  await w.drain();
  assert.deepEqual({ ...w.sent().at(-1), at: 0 }, { v: 1, at: 0, level: "warn", source: "lg4.control", event: "typed-text", message: TRANSCRIPT,
    refs: { requestId: "request_1" }, data: { note: ANSWER, question: TRANSCRIPT } }, "typed text passes as written");
  assert.equal(w.snapshot().refusedFields, 1, "the sentence passed as a reference is the one part refused");
  // What bounds it: a whole prompt does not fit. Each text is cut at 256 characters, and an entry over 2,048 bytes
  // keeps its message and loses its data.
  const whole = `${PROMPT} ${words(50_000, "context")}`;
  w.logger.logDiagnostic("warn", "lg4.control", "whole-prompt", { message: whole,
    data: Object.fromEntries(Array.from({ length: 16 }, (_unused, index) => [`part${index}`, whole])) });
  await w.drain();
  const bounded = w.sent().at(-1)!;
  assert.deepEqual([bounded.message, Object.keys(bounded.data!)], [whole.slice(0, 256), ["oversizeBytes"]]);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= 2048);
  assert.deepEqual([w.snapshot().truncatedFields, w.snapshot().oversizeEntries], [17, 1]);
  // The lists are a backstop, not the control: a secret in the shape of an identifier, an encoded run under 96
  // characters and a credential named without a separator have no shape the logger can tell from an ordinary text.
  const unrecognised = { message: "hmac 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    data: { model: "A1b2".repeat(23), note: "client secret 9f8e7d6c5b4a39281706" } };
  w.logger.logDiagnostic("warn", "lg4.control", "unrecognised", unrecognised);
  await w.drain();
  assert.deepEqual([w.sent().at(-1)!.message, w.sent().at(-1)!.data], [unrecognised.message, unrecognised.data]);
  assert.equal(w.snapshot().refusedFields, 1);
  // Known limits of the backstop, which is frozen as it is (decision A4): no pattern is added for them. The app's own
  // credential headers are refused as a header line, in a sentence, as JSON and as a data key (the test below). In the
  // serialisations listed here the name is not followed by its separator, so nothing is recognised and the text is
  // sent as written, with a key value that has no shape of its own. A caller that passes an error body, a list of
  // header pairs or a URL-encoded form is where this is controlled: the field ledger of commits 2 and 3 covers it.
  const KEY_VALUE = "0123456789abcdef0123456789abcdef";
  const serialisations: Array<[string, (name: string, value: string) => string]> = [
    ["JSON inside JSON", (name, value) => JSON.stringify({ error: JSON.stringify({ [name]: value }) })],
    ["an array of pairs", (name, value) => JSON.stringify(Object.entries({ [name]: value }))],
    ["comma joined", (name, value) => String(Object.entries({ [name]: value }))],
    ["URL-encoded", (name, value) => encodeURIComponent(`${name}: ${value}`)],
    ["the name followed by a space", (name, value) => `${name} ${value}`],
  ];
  const credentialHeaders: Array<[string, string, string[]]> = [
    // [name, value, the serialisations that pass]
    ["x-api-key", KEY_VALUE, serialisations.map(([form]) => form)],
    ["xi-api-key", KEY_VALUE, serialisations.map(([form]) => form)],
    ["Ocp-Apim-Subscription-Key", KEY_VALUE, serialisations.map(([form]) => form)],
    // After Authorization a scheme is a shape of its own, so the name followed by a space is refused.
    ["Authorization", `Basic ${KEY_VALUE}`, ["JSON inside JSON", "an array of pairs", "comma joined", "URL-encoded"]],
    ["Authorization", `Token ${KEY_VALUE}`, ["JSON inside JSON", "an array of pairs", "comma joined", "URL-encoded"]],
    // A bearer credential is a shape wherever it stands, except with its space encoded.
    ["Authorization", `Bearer ${KEY_VALUE}`, ["URL-encoded"]],
  ];
  let knownLimits = 0;
  for (const [name, value, passing] of credentialHeaders) for (const [form, write] of serialisations) {
    const text = write(name, value);
    const before = w.snapshot().refusedFields;
    w.logger.logDiagnostic("warn", "lg4.control", "backstop-limit", { message: text, data: { note: text } });
    const label = `${name} ${value.split(" ").length > 1 ? value.split(" ")[0] : ""}: ${form}`;
    if (passing.includes(form)) {
      assert.equal(w.snapshot().refusedFields - before, 0, `${label} is not recognised`);
      knownLimits += 1;
    } else assert.equal(w.snapshot().refusedFields - before, 2, `${label} is refused`);
  }
  assert.equal(knownLimits, 24, "the known limits: 15 for the three key headers, 8 for Authorization with Basic or Token, 1 with Bearer");
  await w.drain();
  const withKey = w.sent().filter((entry) => entry.event === "backstop-limit" && entry.message !== undefined);
  assert.equal(withKey.length, knownLimits);
  for (const entry of withKey) assert.ok(entry.message!.includes(KEY_VALUE) && entry.data!.note === entry.message, "sent as written, key value included");
  t.diagnostic(`LG4 known backstop limits: ${knownLimits} of ${credentialHeaders.length * serialisations.length} serialisations of the app's credential headers pass as written`);
  assertAllWithinA2(w);
});

test("LG4 every credential header of this app's provider templates is refused: as a header line, inside a sentence, as JSON and as a data key", async (t) => {
  const w = await world(t);
  // Thirty-two hexadecimal characters: a value with no shape of its own, so it is the header name that refuses.
  const KEY_VALUE = "0123456789abcdef0123456789abcdef";
  const templates = ["src/config/ai-providers.constants.ts", "src/config/stt.constants.ts"].map((file) => readFileSync(file, "utf8")).join("\n");
  const headers = [...new Set(templates.split("\n").filter((line) => line.includes("{{API_KEY}}")).map((line) => {
    const header = /-H "([^"]+)"/.exec(line);
    assert.ok(header, `the templates carry the key in a header line only: ${line}`);
    return header[1]!;
  }))];
  const names = [...new Set(headers.map((header) => header.split(":")[0]!.toLowerCase()))].sort();
  for (const known of ["authorization", "ocp-apim-subscription-key", "x-api-key", "xi-api-key"]) assert.ok(names.includes(known), `${known} is in the templates`);
  let cases = 0;
  for (const header of headers) {
    const line = header.replace("{{API_KEY}}", KEY_VALUE);
    const name = line.slice(0, line.indexOf(":"));
    const value = line.slice(line.indexOf(":") + 1).trim();
    const forms: Array<[string, unknown, number]> = [
      ["the header line", { message: line }, 1],
      ["inside a sentence", { message: `request failed -H "${line}" with status 401` }, 1],
      ["JSON", { message: JSON.stringify({ [name]: value }) }, 1],
      ["JSON of an error body, lower case", { message: `fetch failed: ${JSON.stringify({ headers: { [name.toLowerCase()]: value } })}` }, 1],
      ["data strings", { data: { note: line, body: JSON.stringify({ [name]: value }) } }, 2],
      ["data keys", { data: { [name]: value, [name.toLowerCase()]: value } }, new Set([name, name.toLowerCase()]).size],
    ];
    for (const [form, detail, refused] of forms) {
      const before = w.snapshot().refusedFields;
      w.logger.logDiagnostic("error", "lg4.headers", "case", detail as DiagnosticLogDetail);
      assert.equal(w.snapshot().refusedFields - before, refused, `${header}: ${form}`);
      cases += 1;
    }
  }
  await w.drain();
  assert.equal(w.sent().length, cases, "the events themselves are kept");
  for (const entry of w.sent()) assert.deepEqual(Object.keys(entry), ["v", "at", "level", "source", "event"]);
  assert.equal(w.calls.map((call) => call.json).join("\n").includes(KEY_VALUE), false, "no call holds the key value");
  assert.equal(JSON.stringify(w.mirrored.map((line) => line.args)).includes(KEY_VALUE), false, "the console holds no key value");
  t.diagnostic(`LG4 provider templates: ${headers.length} credential header templates (${names.join(", ")}), ${cases} cases refused`);
});

test("LG4 the shape backstop: credentials, command lines and media are refused by their shape in the message and in a data string; ordinary summaries pass", async (t) => {
  const w = await world(t);
  const refused: Array<[string, string, string]> = [
    // [event, text, the part that must not be sent]
    ["url-userinfo", "connect https://user:hunter2026pw@proxy.example:8443 refused", "hunter2026pw"],
    ["url-key", "GET https://generativelanguage.example/v1/models?key=AKfake0123456789abcdef failed", "AKfake0123456789abcdef"],
    ["url-sig", "PUT https://storage.example/blob?sv=1&sig=AKfake0123456789abcdef", "AKfake0123456789abcdef"],
    ["url-token", "wss://stream.example/v1/listen?model=nova&access_token=AKfake0123456789abcdef", "AKfake0123456789abcdef"],
    ["google-key", "401 for AIzaSyA1234567890abcdefghijklmnopqrstuvw", "AIzaSyA1234567890"],
    ["github-token", "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB was rejected", "ghp_0123456789"],
    ["slack-token", "xoxb-0123456789-abcdefghij was rejected", "xoxb-0123456789"],
    ["jwt", "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWFzb24ifQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ expired", "eyJhbGciOiJIUzI1NiJ9"],
    ["token-name", "token: 9f8e7d6c5b4a39281706", "9f8e7d6c5b4a39281706"],
    ["password-name", "password=hunter2026pw", "hunter2026pw"],
    ["secret-name", 'body {"client_secret":"9f8e7d6c5b4a39281706"}', "9f8e7d6c5b4a39281706"],
    ["cookie-header", "Cookie: session=9f8e7d6c5b4a39281706", "9f8e7d6c5b4a39281706"],
    ["proxy-authorization", "Proxy-Authorization Basic dXNlcjpodW50ZXIyMDI2", "dXNlcjpodW50ZXIyMDI2"],
    ["api-key-json", JSON.stringify({ provider: "openai", baseUrl: "https://api.example/v1", apiKey: "AKfake0123456789abcdef" }), "AKfake0123456789abcdef"],
    ["curl-user", "curl -u season:hunter2026pw https://api.example/v1", "hunter2026pw"],
    ["curl-url", "curl https://api.example/v1/chat -H 'x-goog-api-key AKfake0123456789abcdef'", "AKfake0123456789abcdef"],
    ["data-url-small", "data:image/png;base64,iVBORw0KGgo=", "iVBORw0KGgo"],
    ["png-short", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk", "iVBORw0KGgo"],
    ["jpeg-short", "frame /9j/4AAQSkZJRgABAQAAAQABAAD/2wBD", "4AAQSkZJRg"],
    ["wav-short", "chunk UklGRiQAAABXQVZFZm10IBAAAAABAAEA", "UklGRiQAAABXQVZF"],
  ];
  let expected = 0;
  for (const [event, text] of refused) {
    w.logger.logDiagnostic("warn", "lg4.shapes", event, { message: text, data: { note: text } });
    expected += 2;
    assert.equal(w.snapshot().refusedFields, expected, event);
  }
  // Summaries a caller really writes. The words key, token, basic, authorization, cookie and curl are not shapes.
  const passes = [
    "Advisor first content timed out after 15000 ms.",
    "System audio capture could not start.",
    "The API key is missing for the selected provider.",
    "Authorization failed with status 401.",
    "Basic checks passed; the token limit was reached at 4096 tokens.",
    "POST https://api.example/v1/chat/completions returned 429.",
    "The curl template has no audio placeholder.",
    "keys: 3, values: 4, tokens: 512",
    "Retried request fact-risk:answer-7 once.",
  ];
  for (const [index, text] of passes.entries()) w.logger.logDiagnostic("warn", "lg4.shapes", `passes.${index}`, { message: text, data: { note: text } });
  await w.drain();
  assert.equal(w.snapshot().refusedFields, expected, "no ordinary summary was refused");
  const sent = w.sent();
  for (const entry of sent.slice(0, refused.length)) assert.deepEqual(Object.keys(entry), ["v", "at", "level", "source", "event"]);
  assert.deepEqual(sent.slice(refused.length).map((entry) => [entry.message, entry.data]), passes.map((text) => [text, { note: text }]));
  const wire = w.calls.map((call) => call.json).join("\n");
  const printed = JSON.stringify(w.mirrored.map((line) => line.args));
  for (const [event, , part] of refused) {
    assert.equal(wire.includes(part), false, `${event}: the wire`);
    assert.equal(printed.includes(part), false, `${event}: the console`);
  }
});

test("LG4 a shape that straddles the cut refuses the whole text; the shortest key that is a shape is exact", async (t) => {
  const w = await world(t);
  // The key starts 16 characters before the limit of 256, after a space. Cut first, `sk-` and the 13 characters
  // after it would stay, which is not a key shape, and would be sent.
  const straddling = `${words(240)}${SECRET_KEY}`;
  assert.equal(straddling.slice(0, 256).endsWith(" sk-live-01234567"), true);
  w.logger.logDiagnostic("warn", "lg4.straddle", "key", { message: straddling, data: { note: straddling } });
  // An encoded run that starts before the limit and reaches 96 characters after it.
  w.logger.logDiagnostic("warn", "lg4.straddle", "blob", { message: `${words(200)}${"QUJD".repeat(30)}` });
  assert.deepEqual([w.snapshot().refusedFields, w.snapshot().truncatedFields], [3, 0]);
  // The same in a text much longer than the limit: what is examined reaches past the limit there too.
  w.logger.logDiagnostic("warn", "lg4.straddle", "key-in-long-text", { message: `${straddling} ${words(300)}` });
  assert.deepEqual([w.snapshot().refusedFields, w.snapshot().truncatedFields], [4, 0]);
  // A shape wholly past the examined text is cut away with it: nothing of it is sent.
  w.logger.logDiagnostic("warn", "lg4.straddle", "past-the-window", { message: `${words(400)}${SECRET_KEY}` });
  assert.deepEqual([w.snapshot().refusedFields, w.snapshot().truncatedFields], [4, 1]);
  // Sixteen characters after the prefix are a key; fifteen are not.
  w.logger.logDiagnostic("warn", "lg4.straddle", "sk-16", { message: `rejected sk-${"a".repeat(16)}` });
  w.logger.logDiagnostic("warn", "lg4.straddle", "sk-15", { message: `rejected sk-${"a".repeat(15)}` });
  assert.equal(w.snapshot().refusedFields, 5);
  await w.drain();
  assert.deepEqual(w.sent().map((entry) => [entry.event, entry.message, entry.data]), [
    ["key", undefined, undefined], ["blob", undefined, undefined], ["key-in-long-text", undefined, undefined],
    ["past-the-window", words(256), undefined], ["sk-16", undefined, undefined], ["sk-15", `rejected sk-${"a".repeat(15)}`, undefined]]);
  assert.equal(w.calls.map((call) => call.json).join("").includes("sk-live"), false);
  assertNothingForbidden(w);
});

// Decisions A8, item 1: the summary of a caught value, for the data field `cause` of an entry about a failed native
// command or a failed local save. The call sites that use it are driven in tests/diagnostic-log-migration.test.ts.
test("LG4 the cause summary: the name and the message of an Error, String of any other value, cut at 160 UTF-16 code units, never a throw; as a data string the shape backstop refuses it whole, also when the cut would divide the shape", async (t) => {
  const w = await world(t);
  const { diagnosticLogCause, DIAGNOSTIC_LOG_CAUSE_CHARS, DIAGNOSTIC_LOG_UNREADABLE_CAUSE } = w.logger;
  assert.deepEqual([DIAGNOSTIC_LOG_CAUSE_CHARS, CAUSE_CHARS, DIAGNOSTIC_LOG_UNREADABLE_CAUSE], [160, 160, "unreadable"]);
  const before = w.snapshot();
  // An Error: its name and its message. No stack, no code and no nested cause.
  const decorated = Object.assign(new Error("the device was removed"), { name: "NotFoundError", stack: "STACK at file.ts:1", code: "E_SECRET", cause: new Error("inner") });
  const throwingMessage = new Error("x");
  Object.defineProperty(throwingMessage, "message", { get() { throw new Error("no message"); } });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const cases: Array<[unknown, string]> = [
    [new Error("disk full"), "Error: disk full"],
    [new TypeError("x is not a function"), "TypeError: x is not a function"],
    [decorated, "NotFoundError: the device was removed"],
    [new Error(""), "Error"],
    [Object.assign(new Error("only a message"), { name: "" }), "only a message"],
    [Object.assign(new Error("named by a symbol"), { name: Symbol("odd") }), "Symbol(odd): named by a symbol"],
    // An Error made in another realm is not an Error of this one; String gives the same name and message.
    [vm.runInNewContext('new RangeError("made in another realm")'), "RangeError: made in another realm"],
    // Any other value through String. A native command rejects with a string.
    ["failed to open /Users/example/Library/trace.json: No such file or directory (os error 2)", "failed to open /Users/example/Library/trace.json: No such file or directory (os error 2)"],
    ["", ""], [404, "404"], [null, "null"], [undefined, "undefined"], [false, "false"], [Symbol("reason"), "Symbol(reason)"], [["a", 1], "a,1"],
    [{ code: 1 }, "[object Object]"],
    // A value that cannot be read as text: the fixed word, and no throw.
    [Object.create(null), "unreadable"], [{ toString() { throw new Error("no text"); } }, "unreadable"], [revoked.proxy, "unreadable"],
    [throwingMessage, "unreadable"],
  ];
  for (const [caught, expected] of cases) assert.equal(diagnosticLogCause(caught), expected, expected);
  // The cut: 160 UTF-16 code units. A cut that falls inside a character outside the Basic Multilingual Plane leaves
  // its first half, and the logger writes U+FFFD in its place.
  assert.equal(diagnosticLogCause(new Error(words(400))), `Error: ${words(400)}`.slice(0, 160));
  assert.equal(diagnosticLogCause(words(160)), words(160));
  assert.equal(diagnosticLogCause(words(161)), words(160));
  const insidePair = `${words(159)}\u{1F600} and more`;
  assert.deepEqual([diagnosticLogCause(insidePair).length, diagnosticLogCause(insidePair).charCodeAt(159)], [160, 0xd83d]);
  // Pure: the caught value is as it was, and the logger counted, queued and sent nothing.
  assert.deepEqual([decorated.name, decorated.message, decorated.stack, decorated.code], ["NotFoundError", "the device was removed", "STACK at file.ts:1", "E_SECRET"]);
  assert.deepEqual(w.snapshot(), before);
  assert.equal(w.pendingTimers(), 0);

  // As the data field `cause` of an entry. A path and a device name are written as they are.
  const log = (event: string, caught: unknown) => w.logger.logDiagnostic("warn", "lg4.cause", event, () => ({ data: { cause: diagnosticLogCause(caught) } }));
  const withPath = new Error("failed to write /Users/example/Recordings/2026-10-04 Team sync/manifest.json on Studio Display Speakers: No space left on device (os error 28)");
  log("path", withPath);
  log("cut", new Error(words(400)));
  log("inside-pair", insidePair);
  assert.deepEqual([w.snapshot().refusedFields, w.snapshot().truncatedFields], [0, 0], "the summary is within every bound of the logger: it is cut by its own function");
  // A credential shape in the summary: the field is left out and the entry is kept.
  log("header", new Error(`request failed: Authorization: Bearer ${SECRET_KEY}`));
  log("key-parameter", `GET https://api.example.test/v1/models?key=${SECRET_KEY} failed`);
  log("blob", new Error(`unexpected reply ${AUDIO_BASE64}`));
  assert.deepEqual([w.snapshot().refusedFields, w.snapshot().truncatedFields], [3, 0]);
  // A key the cut at 160 would divide. Cut first, `sk-live-01` would stay, which is not a key shape, and would be sent.
  // The summary is then handed over uncut up to the backstop's own window, and the logger refuses it.
  const straddling = `${words(150)}${SECRET_KEY} and what follows it`;
  assert.equal(straddling.slice(0, 160).endsWith(" sk-live-01"), true);
  assert.equal(diagnosticLogCause(straddling), straddling, "handed over whole: it is shorter than 160 and the window of 128 together");
  assert.equal(diagnosticLogCause(`${straddling} ${words(400)}`), `${straddling} ${words(400)}`.slice(0, 288), "or up to the end of that window");
  log("straddling-key", straddling);
  log("straddling-key-in-long-text", new Error(`${straddling} ${words(400)}`));
  // An encoded run that starts before the cut and reaches 96 characters after it.
  log("straddling-blob", `${words(120)}${"QUJD".repeat(30)}`);
  assert.deepEqual([w.snapshot().refusedFields, w.snapshot().truncatedFields], [6, 0]);
  // A shape wholly past that window is cut away with the rest: nothing of it is sent.
  log("past-the-window", `${words(300)}${SECRET_KEY}`);
  assert.deepEqual([w.snapshot().refusedFields, w.snapshot().truncatedFields], [6, 0]);
  // A known limit of the backstop, which is frozen: a run of 96 or more letters, digits, slashes, hyphens and
  // underscores has the shape of an encoded blob, and a long path with no dot, space or colon in it is such a run.
  // An error that names one keeps its entry and loses its cause. The same path with a space and a dot passes.
  const DOTLESS_PATH = "/private/var/folders/zz/abcdefgh12345678/T/jarvis-recordings/session_recording_1759570000000_ab12cd/manifest";
  assert.ok(DOTLESS_PATH.length >= 96);
  log("long-dotless-path", `failed to write ${DOTLESS_PATH}: No space left on device (os error 28)`);
  log("path-with-a-space-and-a-dot", `failed to write ${DOTLESS_PATH.replace("/T/", "/T/Application Support/")}.json`);
  assert.deepEqual([w.snapshot().refusedFields, w.snapshot().truncatedFields], [7, 0]);
  // An entry below the threshold builds no summary: the caught value is not read.
  let read = 0;
  w.logger.setDiagnosticLogThreshold("error");
  log("filtered", { toString() { read += 1; return "never read"; } });
  assert.equal(read, 0);
  w.logger.setDiagnosticLogThreshold("info");
  await w.drain();
  assert.deepEqual(w.sent().map((entry) => [entry.event, entry.data]), [
    ["path", { cause: "Error: failed to write /Users/example/Recordings/2026-10-04 Team sync/manifest.json on Studio Display Speakers: No space left on device (os error 28)" }],
    ["cut", { cause: `Error: ${words(400)}`.slice(0, 160) }],
    ["inside-pair", { cause: `${words(159)}\uFFFD` }],
    ["header", undefined], ["key-parameter", undefined], ["blob", undefined],
    ["straddling-key", undefined], ["straddling-key-in-long-text", undefined], ["straddling-blob", undefined],
    ["past-the-window", { cause: words(160) }],
    ["long-dotless-path", undefined],
    ["path-with-a-space-and-a-dot", { cause: `failed to write ${DOTLESS_PATH.replace("/T/", "/T/Application Support/")}.json` }],
  ]);
  for (const entry of w.sent()) assert.ok(entry.data === undefined || (entry.data.cause as string).length <= 160, entry.event);
  assert.equal(w.calls.map((call) => call.json).join("").includes("sk-live"), false);
  assertAllWithinA2(w);
});

test("LG4 a data key named like the IPC serialiser's hook is refused, so one entry never fails the call that carries it", async (t) => {
  const w = await world(t);
  for (let index = 0; index < 63; index += 1) w.logger.logDiagnostic("error", "lg4.serialiser", "ordinary", { data: { index } });
  w.logger.logDiagnostic("error", "lg4.serialiser", "hook-key", { data: { [TAURI_SERIALIZE_HOOK]: 1, ok: true } });
  await w.drain();
  assert.deepEqual([w.calls.length, w.calls[0]!.entries.length, w.sent().at(-1)!.data], [1, 64, { ok: true }]);
  assert.deepEqual(quiet(w.snapshot()), { ...QUIET, refusedFields: 1 }, "the call was delivered: no failure, nothing undelivered");
  // The control: the boundary of these tests does throw for that key, as Tauri's serialiser does.
  assert.throws(() => JSON.stringify({ entries: [{ data: { [TAURI_SERIALIZE_HOOK]: 1 } }] }, tauriReplacer), TypeError);
});

// Each side measures its own serialisation. Native prints a safe integer as it was sent and any other number in at
// most 24 bytes: an integer outside the 64-bit range comes out as a float, and a number with a fraction or an exponent
// can be read one unit in the last place off and is then written with seventeen digits (5e-58 as
// 5.0000000000000005e-58, 17 bytes longer). The native test
// lg4_native_prints_a_number_in_at_most_24_bytes_and_a_safe_integer_as_it_was_sent pins that, with these numbers. The
// logger therefore measures every data number that is not a safe integer as the larger of its own length and 24 bytes.
test("LG4 the size check counts every number that is not a safe integer as 24 bytes: at 2,048 measured bytes the entry is sent whole, one byte over it is sent in the marker form", async (t) => {
  const w = await world(t);
  // An entry that carries `value` and whose own JSON is exactly `bytes` long.
  const ofBytes = (value: number, bytes: number): DiagnosticLogDetail => {
    const pads = (text: string) => Object.fromEntries(Array.from({ length: 7 }, (_unused, index) => [`pad${index}`, text]));
    const frame = Buffer.byteLength(JSON.stringify({ v: 1, at: CLOCK, level: "info", source: "lg4.numbers", event: "at-limit",
      message: "", data: { value, ...pads("") } }), "utf8");
    return { message: words(bytes - frame - 7 * 255, "pad"), data: { value, ...pads(words(255, "pad")) } };
  };
  // [the number, what native can add to its length here: 24 less that length, and nothing for a safe integer]
  const cases: Array<[number, number]> = [
    [0, 0], [42, 0], [-17, 0], [1791115200000, 0], [9007199254740991, 0], [-9007199254740991, 0],
    [-17.5, 19], [0.125, 19], [1e-7, 20], [5e-324, 18], [2 ** 53, 8], [2 ** 63 - 1024, 5], [2 ** 64, 4], [-(2 ** 63), 4],
    [99999999999999980000, 4], [1e21, 19], [1.5e300, 16],
    // The three numbers native was seen to print 17, 16 and 5 bytes longer.
    [5e-58, 19], [3e50, 19], [1.26025383612e-31, 7],
    // Already 24 bytes here: the longest form there is.
    [-1.2345678901234568e-300, 0],
  ];
  for (const [value, added] of cases) {
    assert.equal(added, Number.isSafeInteger(value) ? 0 : 24 - JSON.stringify(value).length, `${value}: the column is written out, not computed`);
    // Measured at exactly 2,048, one byte over, and 2,048 bytes as written here.
    w.logger.logDiagnostic("info", "lg4.numbers", "at-limit", ofBytes(value, 2048 - added));
    w.logger.logDiagnostic("info", "lg4.numbers", "at-limit", ofBytes(value, 2049 - added));
    w.logger.logDiagnostic("info", "lg4.numbers", "at-limit", ofBytes(value, 2048));
  }
  await w.drain();
  let oversize = 0;
  for (const [index, [value, added]] of cases.entries()) {
    const [atLimit, over, asWritten] = w.sent().slice(index * 3, index * 3 + 3);
    assert.equal(Buffer.byteLength(JSON.stringify(atLimit), "utf8"), 2048 - added, `${value}: sent whole`);
    assert.equal(atLimit!.data!.value, value);
    assert.deepEqual(over!.data, { oversizeBytes: 2049 }, `${value}: one byte over`);
    if (added === 0) assert.equal(Buffer.byteLength(JSON.stringify(asWritten), "utf8"), 2048, `${value}: 2,048 bytes as written fit`);
    else assert.deepEqual(asWritten!.data, { oversizeBytes: 2048 + added }, `${value}: 2,048 bytes as written are measured at ${2048 + added}`);
    oversize += added === 0 ? 1 : 2;
  }
  assert.deepEqual(quiet(w.snapshot()), { ...QUIET, oversizeEntries: oversize });
  assert.equal(oversize, 7 * 1 + 14 * 2);
  // Fourteen such numbers in one entry: 14 x 21 bytes are counted on top of the 1,754 written here. The check looks at
  // an entry that far below the limit.
  const many = (bytes: number): DiagnosticLogDetail => {
    const numbers = Object.fromEntries(Array.from({ length: 14 }, (_unused, index) => [`n${index}`, 0.5]));
    const refs = { runtimeSessionId: dotted(128, "runtime"), recordingSessionId: dotted(128, "recording"), traceId: dotted(128, "trace"),
      operationId: dotted(128, "operation"), requestId: dotted(128, "request") };
    const frame = Buffer.byteLength(JSON.stringify({ v: 1, at: CLOCK, level: "info", source: "lg4.numbers", event: "many",
      message: "", refs, data: { ...numbers, pad0: "", pad1: "" } }), "utf8");
    const padding = bytes - frame;
    return { message: words(Math.min(padding, 256), "pad"), refs,
      data: { ...numbers, pad0: words(Math.min(Math.max(padding - 256, 0), 256), "pad"), pad1: words(Math.max(padding - 512, 0), "pad") } };
  };
  t.mock.timers.setTime(CLOCK);
  w.logger.logDiagnostic("info", "lg4.numbers", "many", many(2048 - 14 * 21));
  w.logger.logDiagnostic("info", "lg4.numbers", "many", many(2049 - 14 * 21));
  await w.drain();
  const [manyAtLimit, manyOver] = w.sent().slice(-2);
  assert.equal(Buffer.byteLength(JSON.stringify(manyAtLimit), "utf8"), 1754);
  assert.equal(Object.values(manyAtLimit!.data!).filter((value) => value === 0.5).length, 14);
  assert.deepEqual(manyOver!.data, { oversizeBytes: 2049 });
  assert.equal(w.snapshot().oversizeEntries, oversize + 1);
  assertAllWithinA2(w);
});

// The order in which an oversize entry loses its parts: the data, then the message. The references are never dropped.
test("LG4 an oversize entry loses its data first and its message next; its references and the marker stay, and that form always fits", async (t) => {
  const w = await world(t);
  const refs = (write: (length: number, segment: string) => string) => ({ runtimeSessionId: write(128, "runtime"),
    recordingSessionId: write(128, "recording"), traceId: write(128, "trace"), operationId: write(128, "operation"), requestId: write(128, "request") });
  const controls = "\u0000".repeat(256);
  // 256 control characters are 1,536 bytes of JSON. With five references of 128 characters the entry is over the limit
  // before it has any data, and still over it with the marker in the place of the data: the message goes.
  w.logger.logDiagnostic("warn", "lg4.oversize", "message-goes", { message: controls, refs: refs(dotted) });
  // A message that fits next to the references and the marker stays: only the data goes.
  w.logger.logDiagnostic("warn", "lg4.oversize", "message-stays", { message: words(256), refs: refs(dotted),
    data: Object.fromEntries(Array.from({ length: 16 }, (_unused, index) => [`field${index}`, words(256)])) });
  // The largest entry that can be left: both tags at their limit and five references of 128 characters that are each
  // written as an escape. It is under 1,700 bytes, so there is no third form without the references.
  w.logger.logDiagnostic("warn", "s".repeat(48), "e".repeat(64), { message: controls, refs: refs((length) => "\\".repeat(length)) });
  await w.drain();
  const [goes, stays, largest] = w.sent();
  const measured = (entry: object) => Buffer.byteLength(JSON.stringify(entry), "utf8");
  assert.deepEqual(Object.keys(goes!), ["v", "at", "level", "source", "event", "refs", "data"], "no message");
  assert.deepEqual(goes!.refs, refs(dotted));
  assert.deepEqual(goes!.data, { oversizeBytes: measured({ v: 1, at: goes!.at, level: "warn", source: "lg4.oversize", event: "message-goes", message: controls, refs: refs(dotted) }) });
  assert.ok((goes!.data!.oversizeBytes as number) > 2048);
  assert.deepEqual(Object.keys(stays!), ["v", "at", "level", "source", "event", "message", "refs", "data"]);
  assert.deepEqual([stays!.message, stays!.refs, Object.keys(stays!.data!)], [words(256), refs(dotted), ["oversizeBytes"]]);
  assert.deepEqual(Object.keys(largest!), ["v", "at", "level", "source", "event", "refs", "data"]);
  assert.deepEqual(largest!.refs, refs((length) => "\\".repeat(length)));
  assert.ok(measured(largest!) < 1700, `the largest form is ${measured(largest!)} bytes`);
  assert.deepEqual(quiet(w.snapshot()), { ...QUIET, oversizeEntries: 3 });
  assertAllWithinA2(w);
});

// ---- the shared wire fixture ----

// What the refused parts of the fixed inputs below carry. None of it may appear in a call; the fixture lists it as
// `absent`, and the native test searches the written lines and the terminal lines for it as well.
const ABSENT_VALUE = "MUST-BE-ABSENT";
const FIXTURE_ABSENT = [...FORBIDDEN, ABSENT_VALUE, "Never Sent", "never_sent", "never-sent", "overlong", "has space", "文本"];
// The fixture's first batch: one entry of each level with every optional field, then each bound at its limit.
const FIXTURE_ACCEPTED_AT_BOUNDS = 15;

// The fixed inputs: one entry of each level, then the bounds native must accept.
// The sources, events, references and data of the first five entries are invented to exercise the wire shape. No
// production code emits them, and the commits that add real callers are not bound by these names. The fixture says
// the same in its `note`.
const FIXTURE_NOTE = "The sources, events, references and data of these entries are invented to exercise the wire shape. " +
  "No production code emits them, and later commits are not bound by these names.";
function fixtureInputs(logger: Logger) {
  const log = logger.logDiagnostic;
  log("error", "meeting.capture", "start-failed", { message: "System audio capture could not start.",
    refs: { runtimeSessionId: "meeting_1791115200000_ab12cd", operationId: "capture_operation_1791115200000_ef34gh" },
    data: { stage: "commit-start-error", attempt: 1, recoverable: false } });
  log("warn", "meeting.fact-risk-review", "deadline-exceeded", { message: "Fact Risk Review did not finish; the answer is shown without risk notes.",
    refs: { traceId: "voice_trace_1791115200000_ij56kl", requestId: "fact_risk_review_1791115200000_mn78op" },
    data: { deadlineMs: 4000, elapsedMs: 4003.5, mainAnswerShown: true } });
  log("info", "meeting.settings", "log-level-applied", { data: { level: "debug", previous: "info" } });
  log("debug", "meeting.relation", "candidate-selected", { refs: { traceId: "voice_trace_1791115200000_ij56kl" },
    data: { selectedProviderTier: "fast", selectionReason: "candidate-deadline-expired", stageDeadlineAtMs: 1791115201500, candidates: 2, retried: null } });
  log("trace", "meeting.trace", "step-finished", () => ({ refs: { traceId: "voice_trace_1791115200000_ij56kl" },
    data: { stepId: "step_17", name: "advisor-stream", status: "success", durationMs: 812, valueChars: 1432 } }));
  // Bounds, each at its limit.
  log("info", "s".repeat(48), "e".repeat(64));
  log("info", "a0.-z9", "b0.-y8", { message: words(256, "message") });
  log("info", "lg.fixture", "refs-at-limit", { refs: { runtimeSessionId: dotted(128, "runtime"), recordingSessionId: dotted(128, "recording"),
    traceId: dotted(128, "trace"), operationId: dotted(128, "operation"), requestId: dotted(128, "request") } });
  log("info", "lg.fixture", "data-sixteen-keys", { data: Object.fromEntries(Array.from({ length: 16 }, (_unused, index) =>
    [`${"k".repeat(45)}_${String(index).padStart(2, "0")}`, index % 2 === 0 ? index : `v${index}`])) });
  log("info", "lg.fixture", "data-string-at-limit", { data: { text256: words(256, "data"), "Key_.-0": "" } });
  log("info", "lg.fixture", "data-scalars", { data: { zero: 0, negative: -17, fraction: 0.125, large: 9007199254740991, exponent: 1.5e300,
    yes: true, no: false, nothing: null, empty: "" } });
  log("info", "lg.fixture", "unicode", { message: "诊断日志：采集恢复 ✓ 😀 naïve café", data: { 文本: "ignored", note: "多字节 😀" } });
  log("info", "lg.fixture", "escapes", { message: 'quote " backslash \\ newline \n tab \t nul \u0000 separator \u2028', data: { path: "C:\\logs\\a.jsonl" } });
  // Exactly 2,048 bytes of UTF-8: the largest entry the contract admits.
  const frame = Buffer.byteLength(JSON.stringify({ v: 1, at: CLOCK, level: "info", source: "lg.fixture", event: "bytes-at-limit",
    message: "", data: Object.fromEntries(Array.from({ length: 7 }, (_unused, index) => [`pad${index}`, ""])) }), "utf8");
  const padding = 2048 - frame;
  log("info", "lg.fixture", "bytes-at-limit", { message: words(padding - 7 * 255, "pad"),
    data: Object.fromEntries(Array.from({ length: 7 }, (_unused, index) => [`pad${index}`, words(255, "pad")])) });
  // One byte more (the event tag is two characters longer, the message one shorter): sent without its data and marked.
  log("info", "lg.fixture", "bytes-over-limit", { message: words(padding - 7 * 255 - 1, "pad"),
    data: Object.fromEntries(Array.from({ length: 7 }, (_unused, index) => [`pad${index}`, words(255, "pad")])) });
}

// The fixed inputs the logger refuses, as an untyped caller would pass them. The number after each call is what it
// adds to the counters. A call refused whole sends nothing; otherwise the event is kept and the refused parts are
// left out, so each line below still sends one entry.
function fixtureRefusedInputs(logger: Logger) {
  const log = logger.logDiagnostic as (level: unknown, source: unknown, event: unknown, detail?: unknown) => void;
  // Refused whole: a malformed source tag, a malformed event tag, an unknown level. refusedEntries 3.
  log("error", "Never Sent", "malformed-source", { message: TRANSCRIPT });
  log("error", "lg.fixture", "never_sent", { message: PROMPT });
  log("fatal", "lg.fixture", "never-sent-level", { message: ANSWER });
  // Parts the detail does not have. refusedFields 5, 4 and 1.
  log("warn", "lg.fixture", "refused-parts", { transcript: TRANSCRIPT, prompt: PROMPT, answer: ANSWER, error: new Error(ANSWER),
    headers: PROVIDER_CONFIG.headers });
  log("warn", "lg.fixture", "refused-whole-config", PROVIDER_CONFIG);
  log("warn", "lg.fixture", "refused-text-detail", TRANSCRIPT);
  // A key that names a secret or content carries no text; a size, a count or a flag under it is kept. refusedFields 5 and 8.
  log("warn", "lg.fixture", "refused-secret-keys", { data: { apiKey: SECRET_KEY, authorization: `Basic ${ABSENT_VALUE}`,
    accessToken: `${ABSENT_VALUE} access token`, password: `${ABSENT_VALUE} password`, cookie: `${ABSENT_VALUE} cookie`,
    hasApiKey: true, tokenLimit: 4096 } });
  log("warn", "lg.fixture", "refused-content-keys", { data: { transcript: TRANSCRIPT, prompt: PROMPT, systemPrompt: PROMPT, answer: ANSWER,
    imageBase64: `${ABSENT_VALUE} image`, audioChunk: `${ABSENT_VALUE} audio`, providerConfig: `${ABSENT_VALUE} configuration`,
    headers: `${ABSENT_VALUE} headers`, promptChars: 1200, answerChars: 0, transcriptTurns: 3, imageBytes: 1024, audioMs: 20.5 } });
  // Text in the shape of a credential, a header, a media payload or a command line, under any key. refusedFields 7.
  log("warn", "lg.fixture", "refused-secret-text", { message: `failed with Bearer ${SECRET_KEY}`, data: {
    note: `Authorization: Basic ${ABSENT_VALUE}`, model: SECRET_KEY, shot: IMAGE, chunk: AUDIO_BASE64, command: PROVIDER_CONFIG.curl,
    other: `api key: ${ABSENT_VALUE}`, kept: "plain text is kept" } });
  // A value that is not a finite scalar. refusedFields 7.
  log("warn", "lg.fixture", "refused-values", { data: { provider: PROVIDER_CONFIG, turns: [TRANSCRIPT], cause: new Error(ANSWER),
    when: new Date(0), size: 10n, ratio: NaN, limit: Infinity, kept: 7 } });
  // References: one over its limit is left out and never cut; an empty one, an unknown name, a number and a credential. refusedFields 5.
  log("warn", "lg.fixture", "refused-refs", { refs: { traceId: dotted(128, "trace"), operationId: dotted(129, "overlong"), requestId: "",
    sessionId: `${ABSENT_VALUE} reference`, runtimeSessionId: 7, recordingSessionId: `Bearer ${SECRET_KEY}` } });
  // Data keys outside the pattern, and the keys after the sixteenth. refusedFields 5, 2 and 1.
  log("warn", "lg.fixture", "refused-data-keys", { data: { "has space": `${ABSENT_VALUE} space`, "": `${ABSENT_VALUE} empty`,
    ["k".repeat(49)]: `${ABSENT_VALUE} long`, "a/b": `${ABSENT_VALUE} slash`, 文本: `${ABSENT_VALUE} non-ascii`, "kept.key-1_x": 6 } });
  log("warn", "lg.fixture", "refused-data-key-count", { data: Object.fromEntries(Array.from({ length: 18 }, (_unused, index) =>
    [`k${String(index).padStart(2, "0")}`, index < 16 ? index : `${ABSENT_VALUE} key ${index}`])) });
  log("warn", "lg.fixture", "refused-proto", { data: JSON.parse(`{"__proto__":"${ABSENT_VALUE} proto","kept":true}`) });
  // A detail function that throws: the event is kept without a detail. detailFailures 1.
  log("warn", "lg.fixture", "refused-detail-throws", () => { throw new Error(`${ABSENT_VALUE} ${SECRET_KEY}`); });
  // Text over its limit is cut at the limit; what follows the limit is not sent. truncatedFields 2.
  log("warn", "lg.fixture", "cut-at-limit", { message: `${words(256, "kept")}${ABSENT_VALUE} after the message limit`,
    data: { text: `${words(256, "kept")}${ABSENT_VALUE} after the data limit` } });
  // The credential headers of this app's provider templates: a header line, JSON, and a data key. refusedFields 6.
  log("warn", "lg.fixture", "refused-app-headers", { message: `request failed -H "Ocp-Apim-Subscription-Key: ${ABSENT_VALUE}"`,
    data: { note: `{"x-api-key":"${ABSENT_VALUE}"}`, other: `{"xi-api-key":"${ABSENT_VALUE}"}`, third: `Authorization: Token ${ABSENT_VALUE}`,
      "Ocp-Apim-Subscription-Key": ABSENT_VALUE, key: ABSENT_VALUE, kept: 1 } });
  // A sentence passed as a reference, and a key that straddles the limit of its text. refusedFields 2.
  log("warn", "lg.fixture", "refused-sentence-and-straddle", { refs: { traceId: `${ABSENT_VALUE} is a sentence`, requestId: "request_1" },
    data: { note: `${words(240)}${SECRET_KEY}` } });
}
const FIXTURE_REFUSED = { refusedEntries: 3, refusedFields: 58, detailFailures: 1, truncatedFields: 2, sentEntries: 15 };

// What native answers for a call when it sheds and refuses nothing: an entry is accepted when it is at least as
// severe as the level of its call, and filtered otherwise. The native test has to get exactly these from a real sink.
const nativeAnswer = (level: unknown, entries: any[]): DiagnosticLogReceipt => {
  const passing = entries.filter((entry) => PASSES[level as DiagnosticLogLevel].includes(entry.level)).length;
  return receiptFor(level, entries, { accepted: passing, filtered: entries.length - passing });
};

interface WireFixture { v: 1; command: string; producer: string; note: string; clock: number; absent: string[];
  calls: Array<{ level: unknown; entries: any[] }>; receipts: DiagnosticLogReceipt[] }
// The file text. One entry per line: each line of a call is the JSON the logger serialised for that entry. One
// receipt per line, in the order of the calls.
function fixtureText(fixture: WireFixture): string {
  const { calls, receipts, ...head } = fixture;
  const callText = (call: WireFixture["calls"][number]) => call.entries.length === 0
    ? `    { "level": ${JSON.stringify(call.level)}, "entries": [] }`
    : `    { "level": ${JSON.stringify(call.level)}, "entries": [\n${call.entries.map((entry) => `      ${JSON.stringify(entry)}`).join(",\n")}\n    ] }`;
  return `${JSON.stringify(head, null, 2).slice(0, -2)},\n  "calls": [\n${calls.map(callText).join(",\n")}\n  ],\n` +
    `  "receipts": [\n${receipts.map((receipt) => `    ${JSON.stringify(receipt)}`).join(",\n")}\n  ]\n}\n`;
}

test("LG4 the shared wire fixture is what the real logger sends for fixed inputs: every level, every optional field, each bound at its limit, and nothing of what it refused", async (t) => {
  const w = await world(t);
  // Every call is answered as native answers it, so the receipts the logger reads here are the fixture's.
  w.control.receipt = (call) => nativeAnswer(call.level, call.entries);
  // Call 1: the level apply, an empty batch.
  void w.logger.applyDiagnosticLogLevel("trace");
  await w.advance(0);
  // Call 2: one entry of each level, each bound at its limit, then the inputs with refused parts.
  fixtureInputs(w.logger);
  assert.deepEqual(quiet(w.snapshot()), { ...QUIET, refusedFields: 1, oversizeEntries: 1 }, "the one refused part so far is the non-ASCII data key");
  fixtureRefusedInputs(w.logger);
  await w.drain();
  assert.deepEqual(quiet(w.snapshot()), { ...QUIET, refusedEntries: FIXTURE_REFUSED.refusedEntries, refusedFields: 1 + FIXTURE_REFUSED.refusedFields,
    truncatedFields: FIXTURE_REFUSED.truncatedFields, oversizeEntries: 1, detailFailures: FIXTURE_REFUSED.detailFailures });
  // Calls 3 and 4: one entry more than a call may carry. The call bound of 64 is met exactly and the rest leaves next.
  // Draining moved the clock; every entry of the fixture is stamped at `clock`.
  t.mock.timers.setTime(CLOCK);
  for (let index = 0; index <= DIAGNOSTIC_LOG_LIMITS.batchEntries; index += 1) w.logger.logDiagnostic("trace", "lg.fixture", "batch-at-limit", { data: { index } });
  await w.drain();
  // Calls 5 and 6: the level is lowered while entries of every level are queued. The apply leaves first; the queued
  // entries follow in a call that carries the new level, so native filters the three below it. After the change an
  // entry below the level is not built and not sent.
  t.mock.timers.setTime(CLOCK);
  for (const level of LEVELS) w.logger.logDiagnostic(level, "lg.fixture", "queued-before-warn", { data: { level } });
  void w.logger.applyDiagnosticLogLevel("warn");
  let built = 0;
  for (const level of ["info", "debug", "trace"] as const) {
    w.logger.logDiagnostic(level, "lg.fixture", "never-sent-filtered", () => { built += 1; return { message: TRANSCRIPT }; });
  }
  await w.drain();
  assert.equal(built, 0, "a filtered detail is not built");
  assertAllWithinA2(w);

  const produced: WireFixture = {
    v: 1,
    command: "write_diagnostic_log",
    producer: "src/lib/meeting/diagnostic-log.ts, through the Tauri invoke entry, with the clock fixed at `clock`",
    note: FIXTURE_NOTE,
    clock: CLOCK,
    // What the fixed inputs carried in the parts the logger refused. It appears in no call below.
    absent: FIXTURE_ABSENT,
    // Each call as sent: the arguments of the command.
    calls: w.calls.map((call) => ({ level: call.level, entries: call.entries })),
    // The receipt of each call, as the logger's reader took it. Native has to answer exactly these.
    receipts: w.calls.map((call) => nativeAnswer(call.level, call.entries)),
  };
  const text = fixtureText(produced);
  assert.deepEqual(JSON.parse(text), produced, "the file text is the fixture");
  if (process.env.JARVIS_WRITE_DIAGNOSTIC_LOG_FIXTURE === "1") writeFileSync(FIXTURE, text);
  assert.equal(readFileSync(FIXTURE, "utf8"), text,
    `${FIXTURE} is produced by this test; run it once with JARVIS_WRITE_DIAGNOSTIC_LOG_FIXTURE=1 after a deliberate wire change`);

  // The arguments of every call are the two the command takes, by these names.
  for (const call of w.calls) {
    assert.equal(call.command, produced.command);
    assert.deepEqual(Object.keys(JSON.parse(call.json)), ["level", "entries"]);
  }
  const accepted = FIXTURE_ACCEPTED_AT_BOUNDS + FIXTURE_REFUSED.sentEntries;
  assert.deepEqual(produced.calls.map((call) => [call.level, call.entries.length]),
    [["trace", 0], ["trace", accepted], ["trace", 64], ["trace", 1], ["warn", 0], ["warn", 5]]);
  const bounds = produced.calls[1]!;
  const lowered = produced.calls[5]!;
  assert.deepEqual(bounds.entries.slice(0, 5).map((entry) => entry.level), [...LEVELS]);
  assert.deepEqual(lowered.entries.map((entry) => entry.level), [...LEVELS], "the call at warn still carries the entries queued before it");
  assert.deepEqual([...new Set(produced.calls.flatMap((call) => call.entries.map((entry) => entry.at)))], [CLOCK]);
  // Every optional field is present on one entry, and each entry bound is met exactly once it can be.
  assert.deepEqual(Object.keys(bounds.entries[0]), ["v", "at", "level", "source", "event", "message", "refs", "data"]);
  const byEvent = (event: string) => bounds.entries.find((entry) => entry.event === event);
  assert.deepEqual([bounds.entries[5].source.length, bounds.entries[5].event.length, bounds.entries[6].message.length], [48, 64, 256]);
  assert.deepEqual(Object.values(byEvent("refs-at-limit").refs).map((value) => (value as string).length), [128, 128, 128, 128, 128]);
  assert.deepEqual(Object.keys(byEvent("data-sixteen-keys").data).map((key) => key.length), Array.from({ length: 16 }, () => 48));
  assert.equal(byEvent("data-string-at-limit").data.text256.length, 256);
  assert.equal(Buffer.byteLength(JSON.stringify(byEvent("bytes-at-limit")), "utf8"), 2048);
  assert.deepEqual(byEvent("bytes-over-limit").data, { oversizeBytes: 2049 });
  // What is left of the inputs with refused parts: the event, and the parts that were allowed.
  assert.deepEqual(bounds.entries.slice(FIXTURE_ACCEPTED_AT_BOUNDS).map((entry) => [entry.event, entry.message, entry.refs, entry.data]), [
    ["refused-parts", undefined, undefined, undefined],
    ["refused-whole-config", undefined, undefined, undefined],
    ["refused-text-detail", undefined, undefined, undefined],
    ["refused-secret-keys", undefined, undefined, { hasApiKey: true, tokenLimit: 4096 }],
    ["refused-content-keys", undefined, undefined, { promptChars: 1200, answerChars: 0, transcriptTurns: 3, imageBytes: 1024, audioMs: 20.5 }],
    ["refused-secret-text", undefined, undefined, { kept: "plain text is kept" }],
    ["refused-values", undefined, undefined, { kept: 7 }],
    ["refused-refs", undefined, { traceId: dotted(128, "trace") }, undefined],
    ["refused-data-keys", undefined, undefined, { "kept.key-1_x": 6 }],
    ["refused-data-key-count", undefined, undefined, Object.fromEntries(Array.from({ length: 16 }, (_unused, index) => [`k${String(index).padStart(2, "0")}`, index]))],
    ["refused-proto", undefined, undefined, { kept: true }],
    ["refused-detail-throws", undefined, undefined, undefined],
    ["cut-at-limit", words(256, "kept"), undefined, { text: words(256, "kept") }],
    ["refused-app-headers", undefined, undefined, { kept: 1 }],
    ["refused-sentence-and-straddle", undefined, { requestId: "request_1" }, undefined],
  ]);
  // The receipts: the reader takes each as it is, and what the logger knows about native is their sum.
  for (const receipt of produced.receipts) assert.deepEqual(readDiagnosticLogReceipt(JSON.parse(JSON.stringify(receipt))), receipt);
  assert.deepEqual(produced.receipts.map((receipt) => [receipt.appliedLevel, receipt.accepted, receipt.filtered, receipt.rejected, receipt.dropped]),
    [["trace", 0, 0, 0, 0], ["trace", accepted, 0, 0, 0], ["trace", 64, 0, 0, 0], ["trace", 1, 0, 0, 0], ["warn", 0, 0, 0, 0], ["warn", 2, 3, 0, 0]]);
  assert.deepEqual(w.snapshot().native, { appliedLevel: "warn", accepted: accepted + 65 + 2, filtered: 3, rejected: 0, dropped: 0,
    sink: { state: "ready", droppedTotal: 0, writeFailures: 0, unsavedAtExit: 0 } });
  // Nothing refused is in a call or on the console. Each absent text is plain, so a search of JSON text finds it.
  const wire = JSON.stringify(produced.calls);
  const printed = JSON.stringify(w.mirrored.map((line) => line.args));
  for (const absent of FIXTURE_ABSENT) {
    assert.equal(JSON.stringify(absent), `"${absent}"`, `${absent} needs no JSON escape`);
    assert.equal(wire.includes(absent), false, `no call holds ${JSON.stringify(absent)}`);
    assert.equal(printed.includes(absent), false, `the console holds no ${JSON.stringify(absent)}`);
  }
  const snapshot = w.snapshot();
  assert.deepEqual([snapshot.ipcCalls, snapshot.ipcEntries, snapshot.accepted, snapshot.filtered], [6, accepted + 65 + 5, accepted + 65 + 5, 3]);
});

// ---- LG5: bounded queue and failures ----

const fill = (w: World, level: DiagnosticLogLevel, count: number, event = "fill") => {
  for (let index = 0; index < count; index += 1) w.logger.logDiagnostic(level, "lg5.queue", event, { data: { index } });
};

test("LG5 queue full: the queue never exceeds 512; trace and debug are shed first, error is kept longest and is not a zero-loss promise", async (t) => {
  const w = await world(t);
  w.logger.setDiagnosticLogThreshold("trace");
  w.control.reply = "hold";
  // One call goes in flight and stays there; everything after it waits in the queue.
  fill(w, "trace", 1, "in-flight");
  await w.advance(DIAGNOSTIC_LOG_LIMITS.flushDelayMs);
  assert.deepEqual([w.calls.length, w.snapshot().inFlight, w.snapshot().queued], [1, true, 0]);
  fill(w, "trace", 200);
  fill(w, "debug", 200);
  fill(w, "info", 112);
  assert.deepEqual([w.snapshot().queued, w.snapshot().queuePeak], [512, 512]);
  assert.deepEqual(w.snapshot().dropped, { error: 0, warn: 0, info: 0, debug: 0, trace: 0 });
  const mirroredAtFull = w.mirrored.length;
  // A new entry no more severe than the least severe one queued is itself shed.
  fill(w, "trace", 50);
  assert.deepEqual(w.snapshot().dropped, { error: 0, warn: 0, info: 0, debug: 0, trace: 50 });
  assert.equal(w.mirrored.length, mirroredAtFull, "a shed entry is not printed");
  // A more severe entry takes the place of the oldest trace entry, then of the oldest debug entry.
  fill(w, "warn", 200);
  assert.deepEqual(w.snapshot().dropped, { error: 0, warn: 0, info: 0, debug: 0, trace: 250 });
  fill(w, "error", 150);
  assert.deepEqual(w.snapshot().dropped, { error: 0, warn: 0, info: 0, debug: 150, trace: 250 });
  fill(w, "debug", 10);
  assert.deepEqual(w.snapshot().dropped, { error: 0, warn: 0, info: 0, debug: 160, trace: 250 }, "debug is the least severe level left: the new debug entries go");
  fill(w, "error", 50 + 112 + 200);
  assert.deepEqual(w.snapshot().dropped, { error: 0, warn: 200, info: 112, debug: 210, trace: 250 });
  // The queue now holds 512 error entries. One more error is shed: bounded memory comes before any level.
  fill(w, "error", 3);
  assert.deepEqual(w.snapshot().dropped, { error: 3, warn: 200, info: 112, debug: 210, trace: 250 });
  assert.deepEqual([w.snapshot().queued, w.snapshot().queuePeak, w.calls.length], [512, 512, 1], "still one call, still 512 queued");
  const snapshot = w.snapshot();
  const dropped = Object.values(snapshot.dropped).reduce((sum, count) => sum + count, 0);
  // Every entry call is accounted for: queued once or shed on arrival; a queued entry is sent, still queued or shed later.
  const logged = 1 + 200 + 200 + 112 + 50 + 200 + 150 + 10 + 362 + 3;
  const shedOnArrival = 50 + 10 + 3;
  assert.equal(snapshot.accepted, logged - shedOnArrival);
  assert.equal(snapshot.accepted, snapshot.ipcEntries + snapshot.queued + (dropped - shedOnArrival));
  // Release: what is left leaves in order, eight calls of 64, all error.
  w.control.reply = "receipt";
  w.held[0]!.resolve(receiptFor("trace", w.held[0]!.call.entries));
  await w.drain();
  assert.deepEqual(w.calls.slice(1).map((call) => call.entries.length), [64, 64, 64, 64, 64, 64, 64, 64]);
  assert.deepEqual([...new Set(w.sent().slice(1).map((entry) => entry.level))], ["error"]);
  assert.deepEqual(w.sent().slice(1, 4).map((entry) => entry.data), [{ index: 0 }, { index: 1 }, { index: 2 }], "oldest first");
  assert.equal(w.snapshot().queued, 0);
  assert.deepEqual([w.snapshot().internalErrors, w.snapshot().undeliveredEntries], [0, 0]);
  assertAllWithinA2(w);
});

// In the test above the least severe entries are always the oldest ones, so shedding "the oldest entry" would pass
// it too. Here the oldest entry is the most severe one.
test("LG5 the entry shed is the oldest of the least severe level queued, not the oldest entry: an error queued first outlives 511 trace entries", async (t) => {
  const w = await world(t);
  w.logger.setDiagnosticLogThreshold("trace");
  w.control.reply = "hold";
  fill(w, "trace", 1, "in-flight");
  await w.advance(DIAGNOSTIC_LOG_LIMITS.flushDelayMs);
  assert.deepEqual([w.calls.length, w.snapshot().inFlight, w.snapshot().queued], [1, true, 0]);
  fill(w, "error", 1, "first-and-most-severe");
  fill(w, "debug", 1, "second");
  fill(w, "trace", 510, "trace");
  assert.equal(w.snapshot().queued, 512);
  // A warn arrives on the full queue: the oldest trace gives way. Not the error at the front, and not the debug.
  fill(w, "warn", 1, "arrives-full");
  assert.deepEqual(w.snapshot().dropped, { error: 0, warn: 0, info: 0, debug: 0, trace: 1 });
  // An info arrives: the next oldest trace. Then every trace is displaced by info, and only then the debug.
  fill(w, "info", 509, "info");
  assert.deepEqual(w.snapshot().dropped, { error: 0, warn: 0, info: 0, debug: 0, trace: 510 });
  fill(w, "info", 1, "takes-the-debug");
  assert.deepEqual(w.snapshot().dropped, { error: 0, warn: 0, info: 0, debug: 1, trace: 510 });
  // Only error, warn and info are left. An info is shed itself; a warn takes the oldest info; an error too.
  fill(w, "info", 1, "shed-itself");
  fill(w, "warn", 1, "takes-an-info");
  fill(w, "error", 1, "takes-an-info");
  assert.deepEqual(w.snapshot().dropped, { error: 0, warn: 0, info: 3, debug: 1, trace: 510 });
  assert.equal(w.snapshot().queued, 512);
  w.control.reply = "receipt";
  w.held[0]!.resolve(receiptFor("trace", w.held[0]!.call.entries));
  await w.drain();
  const sent = w.sent().slice(1);
  assert.equal(sent.length, 512);
  // What is left keeps its arrival order: the error first, the warn where it arrived, the newest entries last.
  assert.deepEqual(sent.slice(0, 2).map((entry) => [entry.level, entry.event]), [["error", "first-and-most-severe"], ["warn", "arrives-full"]]);
  assert.deepEqual(sent.slice(2, 4).map((entry) => [entry.event, entry.data]), [["info", { index: 2 }], ["info", { index: 3 }]],
    "the two oldest info entries gave way to the last warn and error");
  assert.deepEqual(sent.slice(-3).map((entry) => [entry.level, entry.event]),
    [["info", "takes-the-debug"], ["warn", "takes-an-info"], ["error", "takes-an-info"]]);
  assert.equal(sent.some((entry) => entry.level === "trace" || entry.level === "debug" || entry.event === "shed-itself"), false);
});

test("LG5 a single oversize entry is counted and sent without its detail; the entries around it are untouched", async (t) => {
  const w = await world(t);
  const huge = Object.fromEntries(Array.from({ length: 16 }, (_unused, index) => [`field${index}`, "é".repeat(256)]));
  w.logger.logDiagnostic("info", "lg5.oversize", "before", { data: { n: 1 } });
  w.logger.logDiagnostic("error", "lg5.oversize", "too-large", { message: "kept", refs: { traceId: "trace-1" }, data: huge });
  w.logger.logDiagnostic("info", "lg5.oversize", "after", { data: { n: 2 } });
  await w.drain();
  const [before, large, after] = w.sent();
  assert.deepEqual([before!.data, after!.data], [{ n: 1 }, { n: 2 }]);
  assert.deepEqual({ ...large, at: 0 }, { v: 1, at: 0, level: "error", source: "lg5.oversize", event: "too-large", message: "kept",
    refs: { traceId: "trace-1" }, data: { oversizeBytes: large!.data!.oversizeBytes } });
  assert.ok((large!.data!.oversizeBytes as number) > 16 * 256 * 2);
  assert.deepEqual(quiet(w.snapshot()), { ...QUIET, oversizeEntries: 1 });
  assert.equal(w.snapshot().accepted, 3);
  assertAllWithinA2(w);
});

test("LG5 a rejected call is counted and not retried; nothing is logged about it and the caller is not blocked", async (t) => {
  const w = await world(t);
  w.control.reply = "reject";
  fill(w, "error", 3);
  const mirroredBefore = w.mirrored.length;
  await w.drain();
  assert.deepEqual([w.calls.length, w.calls[0]!.entries.length], [1, 3]);
  await w.advance(DIAGNOSTIC_LOG_LIMITS.replyTimeoutMs * 3);
  assert.equal(w.calls.length, 1, "no retry");
  assert.deepEqual(quiet(w.snapshot()), { ...QUIET, ipcFailures: 1, undeliveredEntries: 3 });
  assert.equal(w.mirrored.length, mirroredBefore, "the logger prints nothing about its own failure");
  assert.equal(w.snapshot().accepted, 3, "and logs nothing about it through itself");
  // Each later batch is one more attempt, never a loop: the calls equal the batches.
  for (let round = 0; round < 5; round += 1) { fill(w, "info", 10); await w.drain(); }
  assert.deepEqual([w.calls.length, w.snapshot().ipcCalls, w.snapshot().ipcFailures, w.snapshot().undeliveredEntries], [6, 6, 6, 53]);
  // Native back: delivery continues with the next entries. Nothing is replayed.
  w.control.reply = "receipt";
  fill(w, "info", 2);
  await w.drain();
  assert.deepEqual([w.calls.at(-1)!.entries.length, w.snapshot().ipcFailures, w.snapshot().native.accepted], [2, 6, 2]);
});

test("LG5 a boundary that throws, or is absent, is a counted failure and never an exception in the caller", async (t) => {
  const w = await world(t);
  w.control.reply = "throw";
  assert.doesNotThrow(() => fill(w, "error", 2));
  await w.drain();
  assert.deepEqual([w.snapshot().ipcFailures, w.snapshot().undeliveredEntries, w.snapshot().internalErrors], [1, 2, 0]);
  // No Tauri internals at all, as in a plain browser tab or a test process.
  delete (globalThis as any).window;
  assert.doesNotThrow(() => fill(w, "error", 2));
  await w.drain();
  assert.deepEqual([w.snapshot().ipcFailures, w.snapshot().undeliveredEntries, w.snapshot().internalErrors], [2, 4, 0]);
  await assert.rejects(async () => { const applied = w.logger.applyDiagnosticLogLevel("debug"); await w.advance(0); await applied; });
  assert.equal(w.snapshot().threshold, "debug", "the frontend threshold is set even when native cannot be reached");
});

test("LG5 a call that never settles keeps one call in flight, is counted after the timeout, and delivery resumes; a late reply changes nothing", async (t) => {
  const w = await world(t);
  w.logger.setDiagnosticLogThreshold("trace");
  w.control.reply = "hold";
  fill(w, "info", 5, "first");
  await w.advance(DIAGNOSTIC_LOG_LIMITS.flushDelayMs);
  assert.deepEqual([w.calls.length, w.snapshot().inFlight], [1, true]);
  // The caller keeps logging. Nothing waits: 2,000 calls return while the first call is still open.
  fill(w, "trace", 2000, "while-open");
  assert.deepEqual([w.calls.length, w.snapshot().queued, w.snapshot().dropped.trace], [1, 512, 1488], "one call in flight, a bounded queue behind it");
  await w.advance(DIAGNOSTIC_LOG_LIMITS.replyTimeoutMs - 1);
  assert.deepEqual([w.calls.length, w.snapshot().ipcTimeouts, w.snapshot().inFlight], [1, 0, true], "nothing else is sent before the timeout");
  await w.advance(1);
  assert.deepEqual([w.snapshot().ipcTimeouts, w.snapshot().undeliveredEntries], [1, 5]);
  // The next call also never settles: one call per timeout, never a burst of calls.
  await w.advance(0);
  assert.deepEqual([w.calls.length, w.calls[1]!.entries.length, w.snapshot().inFlight], [2, 64, true]);
  // The first call answers late: nothing is counted twice and nothing is un-counted.
  w.held[0]!.resolve(receiptFor("trace", w.held[0]!.call.entries));
  await w.advance(0);
  assert.deepEqual([w.snapshot().ipcTimeouts, w.snapshot().undeliveredEntries, w.snapshot().native.accepted, w.calls.length], [1, 5, 0, 2]);
  // Native answers again: the queue drains.
  w.control.reply = "receipt";
  w.held[1]!.resolve(receiptFor("trace", w.held[1]!.call.entries));
  await w.drain();
  assert.deepEqual([w.snapshot().queued, w.snapshot().inFlight, w.snapshot().ipcTimeouts], [0, false, 1]);
  assert.equal(w.snapshot().native.accepted, 512);
  assert.equal(w.snapshot().ipcEntries, 5 + 512);
  assert.equal(w.snapshot().internalErrors, 0);
});

test("LG5 a reply that is not a version 1 receipt is counted; the receipt reader takes nothing on trust", async (t) => {
  const w = await world(t);
  w.control.reply = "malformed";
  fill(w, "warn", 4);
  await w.drain();
  assert.deepEqual(quiet(w.snapshot()), { ...QUIET, ipcMalformedReceipts: 1, undeliveredEntries: 4 });
  assert.deepEqual(w.snapshot().native, { accepted: 0, filtered: 0, rejected: 0, dropped: 0 });
  const good = receiptFor("info", [1, 2]);
  assert.deepEqual(readDiagnosticLogReceipt(good), good);
  assert.deepEqual(readDiagnosticLogReceipt({ ...good, extra: "ignored" }), good, "unknown members are not carried");
  for (const bad of [null, undefined, "receipt", 1, [], {}, { ...good, v: 2 }, { ...good, appliedLevel: "verbose" }, { ...good, accepted: -1 },
    { ...good, filtered: "0" }, { ...good, rejected: NaN }, { ...good, dropped: undefined }, { ...good, sink: null },
    { ...good, sink: { ...good.sink, state: "ok" } }, { ...good, sink: { ...good.sink, droppedTotal: Infinity } },
    { ...good, sink: { ...good.sink, writeFailures: "1" } }, { ...good, sink: { state: "ready" } },
    // A count is a whole number that is exact here: a fraction, an exponent beyond that and 2^53 are not.
    { ...good, accepted: 1.5 }, { ...good, filtered: 1e300 }, { ...good, rejected: 2 ** 53 }, { ...good, dropped: -0.5 },
    { ...good, sink: { ...good.sink, droppedTotal: 0.1 } }, { ...good, sink: { ...good.sink, unsavedAtExit: 2 ** 53 } }]) {
    assert.equal(readDiagnosticLogReceipt(bad), null, JSON.stringify(bad));
  }
  const largest = { ...good, accepted: Number.MAX_SAFE_INTEGER, sink: { ...good.sink, droppedTotal: Number.MAX_SAFE_INTEGER } };
  assert.deepEqual(readDiagnosticLogReceipt(largest), largest);
  // A reply that throws when it is read is not a receipt either: the reader is total.
  const hostile = () => new Proxy({}, { get: (_target, key) => { if (key === "then") return undefined; throw new Error("hostile reply"); } });
  assert.equal(readDiagnosticLogReceipt(hostile()), null);
  assert.equal(readDiagnosticLogReceipt({ ...good, sink: hostile() }), null);
  w.control.reply = "receipt";
  w.control.receipt = hostile;
  let hostileOutcome: unknown;
  w.logger.applyDiagnosticLogLevel("debug").then(() => { hostileOutcome = "applied"; }, (error: Error) => { hostileOutcome = error.message; });
  await w.advance(0);
  assert.equal(hostileOutcome, DIAGNOSTIC_LOG_MALFORMED_RECEIPT_MESSAGE, "the apply is failed, not left pending");
  assert.deepEqual([w.snapshot().ipcMalformedReceipts, w.snapshot().internalErrors], [2, 0]);
  // Nothing of a refused reply reaches the totals.
  w.control.reply = "receipt";
  w.control.receipt = (call) => receiptFor(call.level, call.entries, { accepted: 1.5, filtered: 1e300 });
  fill(w, "warn", 2);
  await w.drain();
  assert.deepEqual(quiet(w.snapshot()), { ...QUIET, ipcMalformedReceipts: 3, undeliveredEntries: 6 });
  assert.deepEqual(w.snapshot().native, { accepted: 0, filtered: 0, rejected: 0, dropped: 0 });
});

test("LG5 what native reports as rejected and dropped is summed over the calls, next to accepted and filtered", async (t) => {
  const w = await world(t);
  // Two receipts with every count non-zero in one of them, and no count the same in both.
  const answers = [
    { accepted: 0, filtered: 0, rejected: 2, dropped: 1, sink: { state: "ready" as const, droppedTotal: 1, writeFailures: 0, unsavedAtExit: 0 } },
    { accepted: 1, filtered: 1, rejected: 1, dropped: 2, sink: { state: "degraded" as const, droppedTotal: 7, writeFailures: 3, unsavedAtExit: 0 } },
  ];
  w.control.receipt = (call) => receiptFor(call.level, call.entries, answers[w.calls.length - 1]);
  fill(w, "error", 3);
  await w.drain();
  assert.deepEqual(w.snapshot().native, { appliedLevel: "info", ...answers[0] });
  fill(w, "error", 5);
  await w.drain();
  assert.deepEqual(w.calls.map((call) => call.entries.length), [3, 5]);
  // The counts are sums, the sink is the latest one.
  assert.deepEqual(w.snapshot().native, { appliedLevel: "info", accepted: 1, filtered: 1, rejected: 3, dropped: 3, sink: answers[1]!.sink });
  // What native refused or shed is native's report. The logger's own counters say what it did itself: nothing.
  assert.deepEqual(quiet(w.snapshot()), QUIET);
  assert.deepEqual([w.snapshot().accepted, w.snapshot().ipcEntries], [8, 8]);
});

test("LG5 no timer is left once native has answered and the queue is empty; a rejection without a readable reason still settles the apply", async (t) => {
  const w = await world(t);
  assert.equal("writeDiagnosticLog" in w.logger, false, "the raw call of the command is not exported");
  assert.equal(w.pendingTimers(), 0, "loading the module arms nothing");
  // A reply: the reply watchdog is cleared with it.
  fill(w, "info", 3);
  assert.equal(w.pendingTimers(), 1, "the flush timer");
  await w.advance(DIAGNOSTIC_LOG_LIMITS.flushDelayMs);
  assert.deepEqual([w.calls.length, w.snapshot().inFlight, w.snapshot().queued, w.pendingTimers()], [1, false, 0, 0]);
  // An apply, a rejection, a reply that is not a receipt: each leaves nothing behind either.
  const applied = w.logger.applyDiagnosticLogLevel("debug");
  await w.advance(0);
  assert.equal((await applied).appliedLevel, "debug");
  assert.equal(w.pendingTimers(), 0);
  for (const reply of ["reject", "malformed", "throw"] as const) {
    w.control.reply = reply;
    fill(w, "error", 1);
    await w.advance(0);
    assert.deepEqual([w.snapshot().inFlight, w.snapshot().queued, w.pendingTimers()], [false, 0, 0], reply);
  }
  // A call in flight holds exactly its watchdog, however much is logged behind it.
  w.control.reply = "hold";
  fill(w, "error", 1);
  await w.advance(0);
  fill(w, "error", 100);
  assert.deepEqual([w.snapshot().inFlight, w.snapshot().queued, w.pendingTimers()], [true, 100, 1]);
  w.control.reply = "receipt";
  w.held[0]!.resolve(receiptFor("debug", w.held[0]!.call.entries));
  await w.drain();
  assert.deepEqual([w.snapshot().inFlight, w.snapshot().queued, w.pendingTimers()], [false, 0, 0]);
  // Time passing afterwards changes nothing: no late watchdog, no idle call.
  const calls = w.calls.length;
  const before = w.snapshot();
  await w.advance(DIAGNOSTIC_LOG_LIMITS.replyTimeoutMs * 3);
  assert.deepEqual([w.calls.length, w.snapshot()], [calls, before]);

  // Native rejects with a value that cannot be turned into text. The apply is failed with a fixed reason: it does
  // not stay pending, and the failure is counted as a rejected call, not as an internal error.
  w.control.reply = "reject-unprintable";
  assert.throws(() => String(Object.create(null)), TypeError, "the control: this value has no text");
  let failure: unknown;
  w.logger.applyDiagnosticLogLevel("warn").then(() => { failure = "applied"; }, (error: unknown) => { failure = error; });
  const failuresBefore = w.snapshot().ipcFailures;
  await w.advance(0);
  assert.ok(failure instanceof Error);
  assert.equal(failure.message, DIAGNOSTIC_LOG_REJECTED_MESSAGE);
  assert.deepEqual([w.snapshot().ipcFailures - failuresBefore, w.snapshot().internalErrors, w.pendingTimers()], [1, 0, 0]);
});

// A call that native never answers stays reachable from its unsettled promise. What the logger's reply callbacks
// reference stays with it, so they must not reference the batch.
test("LG5 a call that native never answers does not keep its entries: once it has timed out, they can be collected", async (t) => {
  v8.setFlagsFromString("--expose-gc");
  const collect = vm.runInNewContext("gc") as () => void;
  // Plain console functions: the recording ones of the other tests would keep every entry themselves.
  const w = await world(t, { measured: true });
  w.control.reply = "hold";
  const entries: Array<WeakRef<object>> = [];
  w.control.onArguments = (args) => { for (const entry of args.entries) entries.push(new WeakRef(entry)); };
  for (let call = 0; call < 3; call += 1) {
    fill(w, "error", 64);
    await w.advance(0);
    assert.equal(w.held.length, call + 1, "the call is open and unanswered");
    await w.advance(DIAGNOSTIC_LOG_LIMITS.replyTimeoutMs);
  }
  assert.deepEqual([entries.length, w.snapshot().ipcTimeouts, w.snapshot().undeliveredEntries, w.snapshot().queued], [192, 3, 192, 0]);
  // A new task first: a WeakRef keeps its target until the task that read it ends.
  await new Promise((resolve) => setImmediate(resolve));
  collect();
  assert.equal(entries.filter((entry) => entry.deref() !== undefined).length, 0, "no entry of a timed-out call is still reachable");
  assert.equal(w.held.length, 3, "while all three calls are still unanswered");
});

test("LG5 logger failures are counted and never thrown: a detail function that throws and a detail object that throws when read keep the bare event; a throwing console; re-entry", async (t) => {
  const w = await world(t);
  w.logger.setDiagnosticLogThreshold("trace");
  // A detail function that throws: the event is kept without its detail.
  assert.doesNotThrow(() => w.logger.logDiagnostic("error", "lg5.internal", "detail-throws", () => { throw new Error(TRANSCRIPT); }));
  assert.deepEqual([w.snapshot().detailFailures, w.snapshot().accepted], [1, 1]);
  // A detail object that throws when it is read is handled the same way: the bare event is kept and a detail failure
  // is counted. An error-level event is not lost because of its detail.
  const hostile = new Proxy({}, { ownKeys: () => { throw new Error("hostile ownKeys"); } });
  const hostileGetter = { get message(): string { throw new Error("hostile getter"); } };
  const hostileData = { data: new Proxy({ a: 1 }, { get: () => { throw new Error("hostile value"); } }) };
  const revocable = Proxy.revocable({ message: "revoked" }, {});
  revocable.revoke();
  // What was read before the failure is not kept either: the message and the references come before the getter.
  const hostileLate = { message: "read first", refs: { traceId: "trace-1" }, get data(): never { throw new Error("hostile late getter"); } };
  for (const [index, detail] of [hostile, hostileGetter, hostileData, revocable.proxy, hostileLate].entries()) {
    assert.doesNotThrow(() => w.logger.logDiagnostic("error", "lg5.internal", `hostile-${index}`, detail as DiagnosticLogDetail));
    assert.deepEqual([w.snapshot().detailFailures, w.snapshot().accepted, w.snapshot().internalErrors], [2 + index, 2 + index, 0], `hostile ${index}`);
  }
  // A console that throws: the entry is still queued and sent.
  t.mock.method(console, "warn", () => { throw new Error("console is broken"); });
  assert.doesNotThrow(() => w.logger.logDiagnostic("warn", "lg5.internal", "console-throws"));
  assert.deepEqual([w.snapshot().internalErrors, w.snapshot().accepted], [1, 7]);
  // Re-entry: a detail function and a console that log through the logger. One entry each, the inner calls counted.
  w.logger.logDiagnostic("info", "lg5.internal", "outer", () => {
    for (let inner = 0; inner < 1000; inner += 1) w.logger.logDiagnostic("error", "lg5.internal", "inner-from-detail");
    return { data: { outer: true } };
  });
  assert.deepEqual([w.snapshot().reentrantCalls, w.snapshot().accepted], [1000, 8]);
  t.mock.method(console, "info", () => { w.logger.logDiagnostic("error", "lg5.internal", "inner-from-console", () => ({ message: "again" })); });
  w.logger.logDiagnostic("info", "lg5.internal", "console-logs-back");
  assert.deepEqual([w.snapshot().reentrantCalls, w.snapshot().accepted], [1001, 9], "no recursion: the console's own call is refused once");
  // After all of it the logger still works and the failures were never logged as entries.
  w.logger.logDiagnostic("debug", "lg5.internal", "still-works", { data: { ok: true } });
  await w.drain();
  assert.deepEqual(w.sent().map((entry) => entry.event), ["detail-throws", "hostile-0", "hostile-1", "hostile-2", "hostile-3", "hostile-4",
    "console-throws", "outer", "console-logs-back", "still-works"]);
  // Each event whose detail threw is the bare event: no message, no references, no data.
  for (const entry of w.sent().slice(0, 6)) assert.deepEqual(Object.keys(entry), ["v", "at", "level", "source", "event"]);
  assert.deepEqual(w.sent().slice(6).map((entry) => entry.data), [undefined, { outer: true }, undefined, { ok: true }]);
  assert.deepEqual([w.snapshot().detailFailures, w.snapshot().internalErrors], [6, 1]);
  assertNothingForbidden(w);
  assertAllWithinA2(w);
});

test("LG5 the level apply shares the one lane: it waits for the call in flight, coalesces, fails on rejection, timeout and a malformed reply, and never blocks an entry call", async (t) => {
  const w = await world(t);
  const outcome = (promise: Promise<DiagnosticLogReceipt>) => {
    const record: { state: string; value?: unknown } = { state: "pending" };
    promise.then((receipt) => { record.state = "applied"; record.value = receipt.appliedLevel; },
      (error: Error) => { record.state = "failed"; record.value = error.message; });
    return record;
  };
  // A batch is in flight and never answers. The apply waits behind it, entries keep being taken.
  w.control.reply = "hold";
  fill(w, "error", 1);
  await w.advance(0);
  const first = outcome(w.logger.applyDiagnosticLogLevel("debug"));
  const second = outcome(w.logger.applyDiagnosticLogLevel("trace"));
  fill(w, "trace", 3);
  await w.advance(100);
  assert.deepEqual([w.calls.length, first.state, second.state, w.snapshot().threshold, w.snapshot().queued], [1, "pending", "pending", "trace", 3]);
  // The open call answers: the two applies leave as one call with an empty batch and the newest level, before the queued entries.
  w.control.reply = "receipt";
  w.held[0]!.resolve(receiptFor("info", w.held[0]!.call.entries));
  await w.advance(0);
  await w.advance(0);
  assert.equal(w.calls[1]!.json, JSON.stringify({ level: "trace", entries: [] }));
  assert.deepEqual([first, second], [{ state: "applied", value: "trace" }, { state: "applied", value: "trace" }],
    "both settle with the receipt of the call that carried the newest level");
  await w.drain();
  assert.deepEqual(w.calls.slice(2).map((call) => [call.level, call.entries.length]), [["trace", 3]]);
  // Rejection, a malformed reply and no reply: each is a failed apply with its reason, and the frontend threshold stays set.
  w.control.reply = "reject";
  const rejected = outcome(w.logger.applyDiagnosticLogLevel("warn"));
  await w.advance(0);
  assert.deepEqual(rejected, { state: "failed", value: "native rejected the call" });
  w.control.reply = "malformed";
  const malformed = outcome(w.logger.applyDiagnosticLogLevel("error"));
  await w.advance(0);
  assert.deepEqual(malformed, { state: "failed", value: DIAGNOSTIC_LOG_MALFORMED_RECEIPT_MESSAGE });
  w.control.reply = "hold";
  const silent = outcome(w.logger.applyDiagnosticLogLevel("info"));
  await w.advance(0);
  await w.advance(DIAGNOSTIC_LOG_LIMITS.replyTimeoutMs - 1);
  assert.equal(silent.state, "pending", "pending until the timeout, never applied");
  await w.advance(1);
  assert.deepEqual(silent, { state: "failed", value: DIAGNOSTIC_LOG_NO_REPLY_MESSAGE });
  assert.equal(DIAGNOSTIC_LOG_NO_REPLY_MESSAGE, "No native reply within 5000 ms.");
  assert.equal(w.snapshot().threshold, "info");
  assert.deepEqual([w.snapshot().ipcFailures, w.snapshot().ipcMalformedReceipts, w.snapshot().ipcTimeouts, w.snapshot().undeliveredEntries], [1, 1, 1, 0]);
});

// The window itself. Every other test of this file logs a burst inside one task and then moves the clock, which a leaf
// that flushes after 0 ms or 1 ms passes as well.
test("LG5 the 50 ms window: one info entry leaves after 50 ms and not before, and 63 more logged in separate tasks inside the window leave in that same call", async (t) => {
  const w = await world(t);
  assert.equal(DIAGNOSTIC_LOG_LIMITS.flushDelayMs, 50);
  const sentEvents = () => w.calls.map((call) => call.entries.map((entry) => entry.event));
  // One entry alone.
  w.logger.logDiagnostic("info", "lg5.window", "alone");
  await w.advance(49);
  assert.deepEqual([w.calls.length, w.snapshot().queued, w.pendingTimers()], [0, 1, 1], "nothing leaves before the window ends");
  await w.advance(1);
  assert.deepEqual(sentEvents(), [["alone"]]);
  // One entry, then 63 more, each in a task of its own, spread over the 49 ms that follow it.
  w.logger.logDiagnostic("info", "lg5.window", "first");
  for (let index = 1; index <= 63; index += 1) {
    await w.task();
    if (index % 9 === 0) await w.advance(7);
    assert.equal(w.calls.length, 1, `no call before entry ${index}`);
    w.logger.logDiagnostic("info", "lg5.window", "later", { data: { index } });
  }
  // The 64th entry is logged at 49 ms and makes a full batch, which leaves on the next task. Until then, and for the
  // 63 entries and 49 ms before it, nothing has left.
  assert.deepEqual([w.calls.length, w.snapshot().queued], [1, 64], "49 ms after the first entry all 64 are still queued");
  await w.advance(1);
  assert.equal(w.calls.length, 2, "one call for the whole window");
  assert.deepEqual(w.calls[1]!.entries.map((entry) => [entry.event, entry.data?.index]),
    [["first", undefined], ...Array.from({ length: 63 }, (_unused, index) => ["later", index + 1])]);
  // An entry late in the window does not start the window again.
  w.logger.logDiagnostic("info", "lg5.window", "early");
  await w.advance(49);
  w.logger.logDiagnostic("info", "lg5.window", "late");
  assert.equal(w.calls.length, 2);
  await w.advance(1);
  assert.deepEqual(sentEvents().slice(2), [["early", "late"]]);
  assert.deepEqual([w.snapshot().queued, w.pendingTimers()], [0, 0]);
  assert.deepEqual(quiet(w.snapshot()), QUIET);
});

// ---- LG8: frontend cost ----

// Debug-on trace printing of the scripted S63 session, measured on 2026-10-04 through the string command the trace
// store used before commit 3 retired it (G5): lines per 50 ms window, first line to last. Voice 341 lines in 2.7 s,
// Screen 258 lines in 2.6 s.
// Replayed below with one task per line, the Voice lines leave in 18 calls and the Screen lines in 14: one call for
// each window that holds a line, and one more for the Screen window of 69 lines, whose first 64 leave as a full batch.
const MEASURED_ARRIVALS = {
  voice: [1, 7, 44, 47, 43, 28, 17, 2, 0, 0, 0, 1, 12, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 29, 55, 41, 4, 2, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 2],
  screen: [1, 0, 37, 48, 30, 2, 0, 0, 0, 0, 0, 0, 0, 0, 4, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7, 69, 43, 4, 0, 0, 0, 0, 0, 0, 0, 0, 10, 0, 0, 0, 2],
};
// A bounded entry of about the size of a trace store entry: identifiers and a few scalars. It is a stand-in of about
// 269 bytes, not the store's own projection and not a measured line: the old lines averaged 1,686 bytes (575,059 / 341
// for Voice) and 90 of the 341 were over 2,048 bytes. Only the arrival counts above are measured here. What the store
// really logs for the same scripted turns since commit 3, with its entries, calls and bytes per turn, is measured
// with the real Hook in tests/diagnostic-log-level-consumer.test.mjs (LG8): about 217 bytes an entry at trace.
const traceDetail = (index: number): DiagnosticLogDetail => ({ refs: { traceId: "voice_trace_1791115200000_ij56kl" },
  data: { stepId: `step_${index}`, name: "advisor-stream", status: "success", durationMs: index, valueChars: 1432, metadataKeys: 12 } });

test("LG8 frontend cost, steady load: the measured Voice and Screen sessions leave in 50 ms batches with no drop", async (t) => {
  for (const [name, arrivals] of Object.entries(MEASURED_ARRIVALS)) {
    const w = await world(t);
    w.logger.setDiagnosticLogThreshold("trace");
    const lines = arrivals.reduce((sum, count) => sum + count, 0);
    let index = 0;
    for (const count of arrivals) {
      // Each line in a task of its own, so that a timer that is due runs between two lines. No time passes inside the window.
      for (let line = 0; line < count; line += 1) {
        w.logger.logDiagnostic("trace", "meeting.trace", "step-finished", traceDetail(index++));
        await w.task();
      }
      await w.advance(50);
    }
    await w.drain();
    const snapshot = w.snapshot();
    const batches = w.calls.map((call) => call.entries.length);
    assert.equal(snapshot.accepted, lines, name);
    assert.equal(snapshot.ipcEntries, lines, `${name}: every line was sent`);
    assert.deepEqual(quiet(snapshot), QUIET, `${name}: nothing dropped, refused or failed`);
    assert.ok(Math.max(...batches) <= 64, name);
    assert.ok(snapshot.queuePeak <= 128, `${name}: the queue peak ${snapshot.queuePeak} stays far below 512`);
    // One call per active 50 ms window, and one more for a window that holds more than a batch: its first 64 lines
    // leave as soon as they are a full batch. The old path sent one call per line.
    const activeWindows = arrivals.filter((count) => count > 0).length;
    const overfullWindows = arrivals.filter((count) => count > 64).length;
    assert.equal(w.calls.length, activeWindows + overfullWindows, `${name}: ${w.calls.length} calls`);
    assert.equal(w.calls.length, { voice: 18, screen: 14 }[name], `${name}: the measured number of calls`);
    assert.ok(w.calls.length * 10 < lines, `${name}: at least ten times fewer calls than lines`);
    t.diagnostic(`LG8 steady ${name}: lines=${lines} ipcCalls=${w.calls.length} largestBatch=${Math.max(...batches)} queuePeak=${snapshot.queuePeak} ` +
      `ipcBytes=${snapshot.ipcBytes} bytesPerEntry=${Math.round(snapshot.ipcBytes / lines)} dropped=0 ` +
      `(measured arrival counts; the bytes are those of an assumed bounded entry, not of the measured lines)`);
    assertAllWithinA2(w);
    delete (globalThis as any).window;
    t.mock.timers.reset();
  }
  // At info, the default, the same load sends nothing and queues nothing; the per-call cost is measured below.
  const w = await world(t);
  for (const [index] of Array.from({ length: 341 }).entries()) w.logger.logDiagnostic("trace", "meeting.trace", "step-finished", () => traceDetail(index));
  await w.advance(DIAGNOSTIC_LOG_LIMITS.replyTimeoutMs);
  assert.deepEqual([w.snapshot().filtered, w.snapshot().accepted, w.snapshot().ipcCalls, w.snapshot().ipcBytes, w.snapshot().queuePeak, w.mirrored.length],
    [341, 0, 0, 0, 0, 0]);
});

test("LG8 frontend cost, burst: 2,048 entries in one task keep the queue at 512, shed the rest and leave in 8 calls; errors in the burst survive", async (t) => {
  const w = await world(t);
  w.logger.setDiagnosticLogThreshold("trace");
  for (let index = 0; index < 2048; index += 1) {
    // One error in every 128 lines.
    w.logger.logDiagnostic(index % 128 === 127 ? "error" : "trace", "meeting.trace", "burst", traceDetail(index));
  }
  const burst = w.snapshot();
  assert.deepEqual([burst.queued, burst.queuePeak, burst.ipcCalls], [512, 512, 0], "nothing is sent from inside the burst");
  assert.deepEqual(burst.dropped, { error: 0, warn: 0, info: 0, debug: 0, trace: 1536 });
  assert.equal(burst.accepted - 12, 512, "508 trace entries at the front, then the 4 errors that arrived before the queue filled, then 12 that took a trace entry's place");
  await w.drain();
  const snapshot = w.snapshot();
  assert.deepEqual(w.calls.map((call) => call.entries.length), [64, 64, 64, 64, 64, 64, 64, 64]);
  assert.equal(w.sent().filter((entry) => entry.level === "error").length, 16, "all sixteen errors of the burst were sent");
  assert.deepEqual([snapshot.ipcEntries, snapshot.queued, snapshot.internalErrors, snapshot.undeliveredEntries], [512, 0, 0, 0]);
  assert.ok(snapshot.ipcBytes <= 512 * 2048);
  t.diagnostic(`LG8 burst: logged=2048 queuePeak=${snapshot.queuePeak} sent=${snapshot.ipcEntries} ipcCalls=${w.calls.length} ` +
    `ipcBytes=${snapshot.ipcBytes} droppedTrace=${snapshot.dropped.trace} droppedError=${snapshot.dropped.error}`);
  assertAllWithinA2(w);
});

test("LG8 frontend cost per call: a filtered call and an accepted call, measured", async (t) => {
  const w = await world(t, { measured: true });
  const now = () => Number(process.hrtime.bigint());
  // Filtered: threshold info, trace calls with a detail function.
  const filteredCalls = 400_000;
  let started = now();
  for (let index = 0; index < filteredCalls; index += 1) w.logger.logDiagnostic("trace", "meeting.trace", "step-finished", () => traceDetail(index));
  const filteredNs = (now() - started) / filteredCalls;
  assert.deepEqual([w.snapshot().filtered, w.snapshot().accepted, w.calls.length], [filteredCalls, 0, 0]);
  // Accepted: threshold trace, the queue drained every 64 entries so that nothing is shed.
  w.logger.setDiagnosticLogThreshold("trace");
  const acceptedCalls = 64 * 200;
  let acceptedTotal = 0;
  for (let batch = 0; batch < 200; batch += 1) {
    started = now();
    for (let index = 0; index < 64; index += 1) w.logger.logDiagnostic("trace", "meeting.trace", "step-finished", () => traceDetail(index));
    acceptedTotal += now() - started;
    await w.drain();
  }
  const acceptedNs = acceptedTotal / acceptedCalls;
  const snapshot = w.snapshot();
  assert.deepEqual([snapshot.accepted, snapshot.ipcEntries, snapshot.ipcCalls, snapshot.queuePeak], [acceptedCalls, acceptedCalls, 200, 64]);
  assert.deepEqual(quiet(snapshot), QUIET);
  assert.equal(w.printed(), acceptedCalls, "one console line per accepted entry");
  // Measured in Node (V8) with the console replaced by a no-op. The app runs JavaScriptCore with a real console,
  // where each accepted entry also prints one line, and the IPC dispatch is not in this figure.
  t.diagnostic(`LG8 per call: filtered=${filteredNs.toFixed(1)} ns accepted=${(acceptedNs / 1000).toFixed(2)} us ` +
    `(Node, V8: build, bound check, queue and one call of a no-op console method; no IPC) bytesPerEntry=${Math.round(snapshot.ipcBytes / acceptedCalls)}`);
  // Not a performance promise: only that a filtered call stays far below an accepted one and neither is pathological.
  assert.ok(filteredNs < 5_000, `a filtered call took ${filteredNs} ns`);
  assert.ok(acceptedNs < 1_000_000, `an accepted call took ${acceptedNs} ns`);
  assert.ok(filteredNs * 4 < acceptedNs, "filtering happens before any building");
});
