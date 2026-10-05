// Task 178 LG: the ordinary diagnostic log, frontend side.
//
// A leaf module: its only import is the Tauri invoke entry. It holds the level
// contract, the wire types of the one native command, the module-level logger
// and the receipt of the level apply that the Hook shows.
//
// Level. Five levels, most severe first. A threshold includes every more severe
// level. The level expresses diagnostic severity and detail only. Canonical
// facts, Session Recording, the critical event stream, Native Stall Diagnostics
// files and raw audio permission never read it, and it starts no model call,
// sampler or capture.
//
// Wire. The level of every call becomes the native effective threshold, so an
// apply is a call with an empty batch. A call carries at most 64 entries. The
// command rejects only for an invalid level value, and then applies nothing.
// Native validates each entry on its own, so one refused entry never fails the
// batch: accepted + filtered + rejected + dropped equals the entries received.
//
// Logger. One per page. logDiagnostic is total: it returns nothing, throws
// nothing and is never awaited. It compares the level first, so a filtered call
// formats nothing, never calls its detail function and sends nothing. What
// passes is built from the typed detail alone: three known parts, flat scalar
// data, fixed lengths and counts. A part that does not fit is left out and
// counted; it is never turned into text. The logger reports its own failures
// only through readDiagnosticLogSnapshot, never through itself.
//
// Privacy. What the structure guarantees: an entry has three known parts and
// nothing else; data is flat and scalar; a text has at most 256 characters and
// an entry at most 2,048 bytes, so a whole prompt, transcript or answer does
// not fit; an object, an array or an Error is never turned into text; a
// reference is one token without whitespace. What the logger cannot tell is a
// short sentence passed as a typed string: `message` and a string data value
// are text the caller wrote or reviewed, and the caller is the control. Every
// call site is listed with its fields in the field ledger of the commit that
// adds it, and is tested from that call site. The key and shape lists below
// are a backstop against an accident, such as a header or a command line
// reaching a typed string. They are not the control: a secret in the shape of
// an identifier passes them.
//
// Cause. The logger turns no Error into text. One function here does, for a
// call site that asks: diagnosticLogCause gives the name and the message of a
// caught value, cut at 160 characters, for the data field `cause` of an entry
// about a failed native command or a failed local save. That text can name a
// path or a device, and `cause` is the one field that may. A catch that can
// receive a provider's response does not use it. The summary is a string data
// value like any other: the shape backstop below refuses it whole.
//
// Lengths. A length limit is counted here in UTF-16 code units and on native
// in Unicode scalar values. This side is the stricter one: a character outside
// the Basic Multilingual Plane counts as two here and as one there, so a text
// of 256 such characters, which native and the wire contract admit, is cut
// here to 128. Nothing this side sends is refused there for its length. A cut
// that falls inside such a character leaves U+FFFD in its place.
//
// Numbers. Each side measures an entry on its own serialisation of it. Native
// prints a safe integer as it was sent, and any other number in up to 24
// bytes, so the size check here counts every data number that is not a safe
// integer as the larger of its own length and 24 bytes. Known limit: native
// reads such a number without exact round-tripping and can write it one unit
// in the last place off, for example 5e-58 as 5.0000000000000005e-58.
//
// Delivery. Accepted entries wait in one bounded queue and leave in batches
// from a timer, one call at a time, so calls reach native in the order they
// were made and the newest level is the last one applied. A full queue sheds
// the least severe entries first. A rejected call, a reply that is not a
// receipt and a reply that never comes are counted and not retried. Nothing is
// flushed when the page goes away: what is queued then is lost, which is at
// most one flush window of entries when no call is open, and up to the whole
// queue while a call waits for its reply, for at most the reply timeout.

import { invoke } from "@tauri-apps/api/core";

export const DIAGNOSTIC_LOG_LEVELS = [
  "error",
  "warn",
  "info",
  "debug",
  "trace",
] as const;

export type DiagnosticLogLevel = (typeof DIAGNOSTIC_LOG_LEVELS)[number];

export const DEFAULT_DIAGNOSTIC_LOG_LEVEL: DiagnosticLogLevel = "info";

// Frozen after the G5 measurement of 2026-10-04 (Debug-on trace printing of the
// scripted S63 session: 203 lines for a Voice turn, 123 for a Screen turn, at
// most 72 lines in any 50 ms and 186 in any 250 ms). One 50 ms flush window can
// hold more than one 64-entry batch; a full batch leaves at once without
// waiting for the window, and the queue holds more than two whole turns.
export const DIAGNOSTIC_LOG_LIMITS = {
  queueEntries: 512,
  batchEntries: 64,
  flushDelayMs: 50,
  replyTimeoutMs: 5000,
  entryBytes: 2048,
  sourceChars: 48,
  eventChars: 64,
  messageChars: 256,
  refChars: 128,
  dataKeys: 16,
  dataKeyChars: 48,
  dataStringChars: 256,
} as const;

export type DiagnosticLogDataValue = string | number | boolean | null;

// Only the references that really exist, each at most 128 characters.
export interface DiagnosticLogRefs {
  runtimeSessionId?: string;
  recordingSessionId?: string;
  traceId?: string;
  operationId?: string;
  requestId?: string;
}

// Entry, version 1. One entry serialises to at most 2,048 bytes of UTF-8.
export interface DiagnosticLogEntry {
  v: 1;
  // Epoch milliseconds on the producer clock.
  at: number;
  level: DiagnosticLogLevel;
  // Subsystem: 1 to 48 characters of [a-z0-9.-].
  source: string;
  // Stable tag: 1 to 64 characters of [a-z0-9.-].
  event: string;
  // Short safe summary, at most 256 characters.
  message?: string;
  refs?: DiagnosticLogRefs;
  // Flat: at most 16 keys of 1 to 48 characters of [A-Za-z0-9_.-]. A string
  // value has at most 256 characters and a number value is finite.
  data?: Record<string, DiagnosticLogDataValue>;
}

export type DiagnosticLogSinkState = "ready" | "degraded" | "failed";

// Receipt, version 1.
export interface DiagnosticLogReceipt {
  v: 1;
  // The level now effective on native.
  appliedLevel: DiagnosticLogLevel;
  // Entries of this call queued for writing.
  accepted: number;
  // Entries of this call below the applied level.
  filtered: number;
  // Entries of this call refused as malformed or over a bound.
  rejected: number;
  // Entries of this call shed because the queue was full.
  dropped: number;
  sink: {
    state: DiagnosticLogSinkState;
    droppedTotal: number;
    writeFailures: number;
    unsavedAtExit: number;
  };
}

// The one call site of the command. The logger and the level apply below go
// through it one call at a time. It is not exported: a caller of its own would
// pass the level filter, the bounds, the queue and the order of the applies.
function writeDiagnosticLog(
  level: DiagnosticLogLevel,
  entries: readonly DiagnosticLogEntry[]
): Promise<DiagnosticLogReceipt> {
  return invoke<DiagnosticLogReceipt>("write_diagnostic_log", {
    level,
    entries,
  });
}

// ---- level contract ----

const LEVEL_RANK: ReadonlyMap<unknown, number> = new Map(
  DIAGNOSTIC_LOG_LEVELS.map((level, rank) => [level, rank])
);
const WARN_RANK = 1;

export function isDiagnosticLogLevel(
  value: unknown
): value is DiagnosticLogLevel {
  return LEVEL_RANK.has(value);
}

// Whether an entry of `level` passes `threshold`.
export function diagnosticLogLevelIncludes(
  threshold: DiagnosticLogLevel,
  level: DiagnosticLogLevel
): boolean {
  const thresholdRank = LEVEL_RANK.get(threshold);
  const levelRank = LEVEL_RANK.get(level);
  return (
    thresholdRank !== undefined &&
    levelRank !== undefined &&
    levelRank <= thresholdRank
  );
}

// ---- the typed input of one entry ----

// What a caller may say about one event. There is no part for a transcript, a
// prompt, an answer, an image, audio, a header or a configuration, and no part
// takes an object, an array or an Error.
export interface DiagnosticLogDetail {
  message?: string;
  refs?: DiagnosticLogRefs;
  // An undefined value is skipped, so an optional field can be passed as it is.
  data?: Readonly<Record<string, DiagnosticLogDataValue | undefined>>;
}

// A detail that costs something to build is passed as a function. It is called
// only for an entry that passed the threshold.
export type DiagnosticLogDetailInput =
  | DiagnosticLogDetail
  | (() => DiagnosticLogDetail | undefined);

export interface DiagnosticLogSnapshot {
  threshold: DiagnosticLogLevel;
  // Entry calls below the threshold. Nothing was formatted, queued or sent.
  filtered: number;
  // Entries queued for delivery and mirrored to the console.
  accepted: number;
  // Calls refused whole: an unknown level or a malformed source or event tag.
  refusedEntries: number;
  // Detail parts left out: an unknown part or reference, a value that is not a
  // scalar, a key or text that names a secret or content, a key over the count.
  refusedFields: number;
  // Strings cut to their limit.
  truncatedFields: number;
  // Entries over 2,048 bytes, sent without their detail and marked.
  oversizeEntries: number;
  // Detail functions that threw, and detail objects that threw when they were
  // read; the entry was kept without its detail.
  detailFailures: number;
  // Entry calls made from inside the logger (a detail function or the console).
  reentrantCalls: number;
  // Failures of the logger itself. Never logged, only counted here.
  internalErrors: number;
  queued: number;
  queuePeak: number;
  // Entries shed by a full queue, by their own level.
  dropped: Record<DiagnosticLogLevel, number>;
  inFlight: boolean;
  ipcCalls: number;
  ipcEntries: number;
  // The serialised size of the entries sent, without the call envelope.
  ipcBytes: number;
  // Calls native rejected.
  ipcFailures: number;
  // Calls whose reply did not arrive within the timeout.
  ipcTimeouts: number;
  // Replies that were not a version 1 receipt.
  ipcMalformedReceipts: number;
  // Entries of the calls counted in the three lines above.
  undeliveredEntries: number;
  // What the receipts reported: sums over the calls, and the latest sink.
  native: {
    appliedLevel?: DiagnosticLogLevel;
    accepted: number;
    filtered: number;
    rejected: number;
    dropped: number;
    sink?: DiagnosticLogReceipt["sink"];
  };
}

// ---- the singleton ----

interface QueuedEntry {
  entry: DiagnosticLogEntry;
  rank: number;
  bytes: number;
}

interface ApplyWaiter {
  resolve(receipt: DiagnosticLogReceipt): void;
  reject(error: Error): void;
}

const SOURCE_PATTERN = new RegExp(
  `^[a-z0-9.-]{1,${DIAGNOSTIC_LOG_LIMITS.sourceChars}}$`
);
const EVENT_PATTERN = new RegExp(
  `^[a-z0-9.-]{1,${DIAGNOSTIC_LOG_LIMITS.eventChars}}$`
);
const DATA_KEY_PATTERN = new RegExp(
  `^[A-Za-z0-9_.-]{1,${DIAGNOSTIC_LOG_LIMITS.dataKeyChars}}$`
);
const REF_KEYS: ReadonlySet<string> = new Set([
  "runtimeSessionId",
  "recordingSessionId",
  "traceId",
  "operationId",
  "requestId",
]);
// A reference is an identifier: one token of printable ASCII, no whitespace.
const REF_PATTERN = /^[\x21-\x7e]+$/;
// A data key with one of these names may carry a size, a count or a flag. It
// never carries text. The names of the second pattern are too short to match
// inside another word, so they are matched whole.
const RESTRICTED_KEY_PATTERN =
  /authorization|api[-_.]?key|subscription[-_.]?key|access[-_.]?key|private[-_.]?key|secret|passw(?:or)?d|passphrase|token|cookie|credential|bearer|signature|headers?|curl|config|prompt|transcript|answer|image|audio|base64/i;
const RESTRICTED_SHORT_KEY_PATTERN = /^(?:key|auth|pass|pwd|sig|access)$/i;
// Text in one of these shapes is left out whatever its key is. A backstop, not
// the control: see Privacy above.
const RESTRICTED_TEXT_PATTERN = new RegExp(
  [
    // An Authorization header, plain or as a quoted JSON name, with or without
    // its separator, and a bearer credential on its own.
    String.raw`authorization["']?\s*[:=]`,
    String.raw`authorization["']?\s+(?:bearer|basic|token|digest)\b`,
    String.raw`\bbearer\s+\S`,
    // A name that ends in key, followed by its separator: x-api-key,
    // xi-api-key, Ocp-Apim-Subscription-Key, apiKey, API_KEY, a ?key= parameter.
    String.raw`key["']?\s*[:=]`,
    // The other credential names followed by their separator.
    String.raw`(?:secret|passw(?:or)?d|passphrase|pwd|token|cookie|credential|signature)["']?\s*[:=]`,
    // A URL with user information, or with a credential parameter that the two
    // lines above do not name.
    String.raw`:\/\/[^\s/?#@]+:[^\s/?#@]*@`,
    String.raw`[?&](?:auth|sig)=`,
    // Keys by their published prefix, and a JSON Web Token.
    String.raw`\bsk-[A-Za-z0-9_-]{16,}`,
    String.raw`\bAIza[A-Za-z0-9_-]{20,}`,
    String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}`,
    String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`,
    String.raw`\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.`,
    // A command line.
    String.raw`\bcurl\s+(?:-|https?:)`,
    // A media payload: a data URL, the first bytes of an image, audio or
    // document file in base64, or any long encoded run.
    String.raw`data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,`,
    String.raw`(?:^|[^A-Za-z0-9+/])(?:iVBORw0KGgo|\/9j\/4AAQ|UklGR|GkXfo|T2dnUw|JVBERi0)`,
    String.raw`[A-Za-z0-9+/=_-]{96,}`,
  ].join("|"),
  "i"
);
// How far past its limit a text is examined before it is cut, so that a shape
// that starts before the limit and ends after it is seen whole.
const SHAPE_WINDOW_CHARS = 128;
// The longest form in which native prints a number: a sign, seventeen digits,
// a point and an exponent of up to five characters.
const NATIVE_NUMBER_BYTES = 24;
// A lone surrogate has no JSON form that native accepts. The first pattern is
// the cheap check for any surrogate at all; the second matches only lone ones.
const ANY_SURROGATE_PATTERN = /[\uD800-\uDFFF]/;
const LONE_SURROGATE_PATTERN = /\p{Cs}/gu;
const OVERSIZE_MARKER_KEY = "oversizeBytes";

export const DIAGNOSTIC_LOG_MALFORMED_RECEIPT_MESSAGE =
  "The native reply was not a version 1 diagnostic log receipt.";
export const DIAGNOSTIC_LOG_NO_REPLY_MESSAGE =
  `No native reply within ${DIAGNOSTIC_LOG_LIMITS.replyTimeoutMs} ms.`;
export const DIAGNOSTIC_LOG_INVALID_LEVEL_MESSAGE =
  "The requested level is not one of error, warn, info, debug, trace.";
export const DIAGNOSTIC_LOG_REJECTED_MESSAGE =
  "Native rejected the call without a readable reason.";

let thresholdLevel: DiagnosticLogLevel = DEFAULT_DIAGNOSTIC_LOG_LEVEL;
let thresholdRank = LEVEL_RANK.get(DEFAULT_DIAGNOSTIC_LOG_LEVEL) as number;

const queue: QueuedEntry[] = [];
const queuedByRank = [0, 0, 0, 0, 0];
const applyWaiters: ApplyWaiter[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushTimerUrgent = false;
let inFlight = false;
// True while one entry call is being taken, its detail function and its console
// line included.
let accepting = false;

const counters = {
  filtered: 0,
  accepted: 0,
  refusedEntries: 0,
  refusedFields: 0,
  truncatedFields: 0,
  oversizeEntries: 0,
  detailFailures: 0,
  reentrantCalls: 0,
  internalErrors: 0,
  queuePeak: 0,
  dropped: [0, 0, 0, 0, 0],
  ipcCalls: 0,
  ipcEntries: 0,
  ipcBytes: 0,
  ipcFailures: 0,
  ipcTimeouts: 0,
  ipcMalformedReceipts: 0,
  undeliveredEntries: 0,
  nativeAccepted: 0,
  nativeFiltered: 0,
  nativeRejected: 0,
  nativeDropped: 0,
};
let nativeAppliedLevel: DiagnosticLogLevel | undefined;
let nativeSink: DiagnosticLogReceipt["sink"] | undefined;

// Sets the frontend threshold alone. Native learns the level from the next
// call. An unknown value changes nothing and answers false.
export function setDiagnosticLogThreshold(level: DiagnosticLogLevel): boolean {
  const rank = LEVEL_RANK.get(level);
  if (rank === undefined) return false;
  thresholdLevel = level;
  thresholdRank = rank;
  return true;
}

// The entry call. Level, subsystem, stable event tag, then the optional detail.
export function logDiagnostic(
  level: DiagnosticLogLevel,
  source: string,
  event: string,
  detail?: DiagnosticLogDetailInput
): void {
  try {
    const rank = LEVEL_RANK.get(level);
    if (rank === undefined) {
      counters.refusedEntries += 1;
      return;
    }
    if (rank > thresholdRank) {
      counters.filtered += 1;
      return;
    }
    if (accepting) {
      counters.reentrantCalls += 1;
      return;
    }
    accepting = true;
    try {
      acceptEntry(level, rank, source, event, detail);
    } finally {
      accepting = false;
    }
  } catch {
    counters.internalErrors += 1;
  }
}

// ---- the cause of a caught failure ----

export const DIAGNOSTIC_LOG_CAUSE_CHARS = 160;
// The summary of a caught value that cannot be read as text.
export const DIAGNOSTIC_LOG_UNREADABLE_CAUSE = "unreadable";

// The summary of a caught value for the data field `cause`: the name and the
// message of an Error, or String of any other value, cut at 160 UTF-16 code
// units. No stack and no other property. Pure and total: it reads the value,
// keeps nothing and never throws. A call site calls it inside its lazy
// detail, so an entry below the threshold builds no summary.
//
// The cut and the shape backstop. The logger looks for a restricted shape in a
// string before it cuts it, so that a credential the cut would divide refuses
// the text instead of leaving its first part. The cut here comes first, so the
// same is done here: when the text up to the backstop's window past the cut
// holds a restricted shape, that window is returned uncut, the logger finds
// the shape whole and leaves the field out. A summary that reaches an entry
// has at most 160 code units.
export function diagnosticLogCause(caught: unknown): string {
  try {
    let text: string;
    if (caught instanceof Error) {
      const name = String(caught.name);
      const message = String(caught.message);
      text = name && message ? `${name}: ${message}` : name || message;
    } else {
      text = String(caught);
    }
    if (text.length <= DIAGNOSTIC_LOG_CAUSE_CHARS) return text;
    const examined = text.slice(
      0,
      DIAGNOSTIC_LOG_CAUSE_CHARS + SHAPE_WINDOW_CHARS
    );
    return RESTRICTED_TEXT_PATTERN.test(examined)
      ? examined
      : text.slice(0, DIAGNOSTIC_LOG_CAUSE_CHARS);
  } catch {
    return DIAGNOSTIC_LOG_UNREADABLE_CAUSE;
  }
}

// Sets the frontend threshold and sends the level to native in a call with an
// empty batch. The promise settles with the receipt of the call that carried
// the newest level; it rejects when native rejects, when the reply is not a
// receipt and when no reply arrives in time. It is for one caller, the Hook's
// level effect, which never awaits it on a business path.
export function applyDiagnosticLogLevel(
  level: DiagnosticLogLevel
): Promise<DiagnosticLogReceipt> {
  return new Promise<DiagnosticLogReceipt>((resolve, reject) => {
    if (!setDiagnosticLogThreshold(level)) {
      reject(new Error(DIAGNOSTIC_LOG_INVALID_LEVEL_MESSAGE));
      return;
    }
    applyWaiters.push({ resolve, reject });
    scheduleFlush();
  });
}

// A copy of the counters. Reading it changes nothing.
export function readDiagnosticLogSnapshot(): DiagnosticLogSnapshot {
  return {
    threshold: thresholdLevel,
    filtered: counters.filtered,
    accepted: counters.accepted,
    refusedEntries: counters.refusedEntries,
    refusedFields: counters.refusedFields,
    truncatedFields: counters.truncatedFields,
    oversizeEntries: counters.oversizeEntries,
    detailFailures: counters.detailFailures,
    reentrantCalls: counters.reentrantCalls,
    internalErrors: counters.internalErrors,
    queued: queue.length,
    queuePeak: counters.queuePeak,
    dropped: {
      error: counters.dropped[0],
      warn: counters.dropped[1],
      info: counters.dropped[2],
      debug: counters.dropped[3],
      trace: counters.dropped[4],
    },
    inFlight,
    ipcCalls: counters.ipcCalls,
    ipcEntries: counters.ipcEntries,
    ipcBytes: counters.ipcBytes,
    ipcFailures: counters.ipcFailures,
    ipcTimeouts: counters.ipcTimeouts,
    ipcMalformedReceipts: counters.ipcMalformedReceipts,
    undeliveredEntries: counters.undeliveredEntries,
    native: {
      ...(nativeAppliedLevel !== undefined
        ? { appliedLevel: nativeAppliedLevel }
        : {}),
      accepted: counters.nativeAccepted,
      filtered: counters.nativeFiltered,
      rejected: counters.nativeRejected,
      dropped: counters.nativeDropped,
      ...(nativeSink !== undefined ? { sink: { ...nativeSink } } : {}),
    },
  };
}

// ---- building one entry ----

function acceptEntry(
  level: DiagnosticLogLevel,
  rank: number,
  source: string,
  event: string,
  detail: DiagnosticLogDetailInput | undefined
) {
  if (
    typeof source !== "string" ||
    typeof event !== "string" ||
    !SOURCE_PATTERN.test(source) ||
    !EVENT_PATTERN.test(event)
  ) {
    counters.refusedEntries += 1;
    return;
  }
  const at = Date.now();
  let entry: DiagnosticLogEntry = { v: 1, at, level, source, event };
  let supplied: unknown = detail;
  if (typeof detail === "function") {
    try {
      supplied = detail();
    } catch {
      counters.detailFailures += 1;
      supplied = undefined;
    }
  }
  if (supplied !== undefined && supplied !== null) {
    try {
      readDetail(entry, supplied);
    } catch {
      // A detail that throws when it is read (a getter, a Proxy, a revoked
      // Proxy) is treated as a detail function that throws: the event is kept
      // without any of its detail.
      counters.detailFailures += 1;
      entry = { v: 1, at, level, source, event };
    }
  }

  let bytes = utf8Length(JSON.stringify(entry));
  // Native measures its own serialisation of the entry, in which a number that
  // is not a safe integer can take up to 24 bytes. Each such number is counted
  // as the larger of its length here and 24. Only an entry that those bytes
  // could take over the limit is looked at.
  const measured =
    bytes >
    DIAGNOSTIC_LOG_LIMITS.entryBytes -
      DIAGNOSTIC_LOG_LIMITS.dataKeys * NATIVE_NUMBER_BYTES
      ? bytes + nativeNumberReserve(entry.data)
      : bytes;
  if (measured > DIAGNOSTIC_LOG_LIMITS.entryBytes) {
    // The event is kept and its detail is not: the data goes first, and the
    // message next when what is left still does not fit. The references stay.
    // Five of them at their limit with every character escaped, both tags at
    // theirs and the marker come to under 1,700 bytes, so that form fits.
    counters.oversizeEntries += 1;
    const data = { [OVERSIZE_MARKER_KEY]: measured };
    const message =
      entry.message !== undefined ? { message: entry.message } : {};
    const refs = entry.refs !== undefined ? { refs: entry.refs } : {};
    const bare: DiagnosticLogEntry = { v: 1, at, level, source, event };
    entry = { ...bare, ...message, ...refs, data };
    bytes = utf8Length(JSON.stringify(entry));
    if (bytes > DIAGNOSTIC_LOG_LIMITS.entryBytes) {
      entry = { ...bare, ...refs, data };
      bytes = utf8Length(JSON.stringify(entry));
    }
  }
  if (!enqueue({ entry, rank, bytes })) return;
  counters.accepted += 1;
  mirrorToConsole(entry);
}

// The bytes native can add to the entry when it prints the data numbers: for
// each number that is not a safe integer, what its length here lacks to 24.
function nativeNumberReserve(
  data: Record<string, DiagnosticLogDataValue> | undefined
): number {
  let reserve = 0;
  if (data !== undefined) {
    for (const key of Object.keys(data)) {
      const value = data[key];
      if (typeof value === "number" && !Number.isSafeInteger(value)) {
        const written = JSON.stringify(value).length;
        if (written < NATIVE_NUMBER_BYTES) {
          reserve += NATIVE_NUMBER_BYTES - written;
        }
      }
    }
  }
  return reserve;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

function readDetail(entry: DiagnosticLogEntry, supplied: unknown) {
  if (!isRecordLike(supplied)) {
    counters.refusedFields += 1;
    return;
  }
  for (const part of Object.keys(supplied)) {
    const value = supplied[part];
    if (value === undefined) continue;
    if (part === "message") {
      const message = readText(value, DIAGNOSTIC_LOG_LIMITS.messageChars, true);
      if (message !== undefined) entry.message = message;
    } else if (part === "refs") {
      const refs = readRefs(value);
      if (refs !== undefined) entry.refs = refs;
    } else if (part === "data") {
      const data = readData(value);
      if (data !== undefined) entry.data = data;
    } else {
      counters.refusedFields += 1;
    }
  }
}

// A string within its limit, or nothing. A value that is not a string and text
// in a restricted shape are refused. Text over the limit is cut when
// `truncate` is set and refused otherwise. The shape is looked for before the
// cut, in the text up to a fixed distance past the limit: a credential that
// straddles the limit refuses the text instead of leaving its first part.
function readText(
  value: unknown,
  limit: number,
  truncate: boolean
): string | undefined {
  if (typeof value !== "string") {
    counters.refusedFields += 1;
    return undefined;
  }
  let text = value;
  if (text.length > limit && !truncate) {
    counters.refusedFields += 1;
    return undefined;
  }
  const examined =
    text.length > limit + SHAPE_WINDOW_CHARS
      ? text.slice(0, limit + SHAPE_WINDOW_CHARS)
      : text;
  if (RESTRICTED_TEXT_PATTERN.test(examined)) {
    counters.refusedFields += 1;
    return undefined;
  }
  if (text.length > limit) {
    counters.truncatedFields += 1;
    text = text.slice(0, limit);
  }
  return ANY_SURROGATE_PATTERN.test(text)
    ? text.replace(LONE_SURROGATE_PATTERN, "\uFFFD")
    : text;
}

function readRefs(value: unknown): DiagnosticLogRefs | undefined {
  if (!isRecordLike(value)) {
    counters.refusedFields += 1;
    return undefined;
  }
  const refs: Record<string, string> = {};
  let taken = 0;
  for (const key of Object.keys(value)) {
    const candidate = value[key];
    if (candidate === undefined) continue;
    if (!REF_KEYS.has(key)) {
      counters.refusedFields += 1;
      continue;
    }
    // An identifier is never cut: a shortened one would name something else.
    const text = readText(candidate, DIAGNOSTIC_LOG_LIMITS.refChars, false);
    if (text === undefined) continue;
    // Empty, or not one token: a sentence is not an identifier.
    if (!REF_PATTERN.test(text)) {
      counters.refusedFields += 1;
      continue;
    }
    refs[key] = text;
    taken += 1;
  }
  return taken > 0 ? (refs as DiagnosticLogRefs) : undefined;
}

function readData(
  value: unknown
): Record<string, DiagnosticLogDataValue> | undefined {
  if (!isRecordLike(value)) {
    counters.refusedFields += 1;
    return undefined;
  }
  const data: Record<string, DiagnosticLogDataValue> = {};
  let taken = 0;
  for (const key of Object.keys(value)) {
    const candidate = value[key];
    if (candidate === undefined) continue;
    // `__proto__` would set the prototype of the data object. A `__TAURI` key
    // is read by the IPC serialiser as its own hook and makes the whole call
    // throw.
    if (
      taken >= DIAGNOSTIC_LOG_LIMITS.dataKeys ||
      key === "__proto__" ||
      key.startsWith("__TAURI") ||
      !DATA_KEY_PATTERN.test(key)
    ) {
      counters.refusedFields += 1;
      continue;
    }
    let scalar: DiagnosticLogDataValue;
    if (candidate === null || typeof candidate === "boolean") {
      scalar = candidate;
    } else if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        counters.refusedFields += 1;
        continue;
      }
      scalar = candidate;
    } else if (typeof candidate === "string") {
      if (
        RESTRICTED_KEY_PATTERN.test(key) ||
        RESTRICTED_SHORT_KEY_PATTERN.test(key)
      ) {
        counters.refusedFields += 1;
        continue;
      }
      const text = readText(
        candidate,
        DIAGNOSTIC_LOG_LIMITS.dataStringChars,
        true
      );
      if (text === undefined) continue;
      scalar = text;
    } else {
      // An object, an array, an Error, a function, a symbol or a bigint.
      counters.refusedFields += 1;
      continue;
    }
    data[key] = scalar;
    taken += 1;
  }
  return taken > 0 ? data : undefined;
}

// The UTF-8 size of JSON text. JSON.stringify escapes a lone surrogate, so the
// text holds only whole code points.
function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

// The matching console method. A trace entry uses console.debug: console.trace
// would print a call stack.
function mirrorToConsole(entry: DiagnosticLogEntry) {
  try {
    const label = "[diagnostic-log]";
    if (entry.level === "error") console.error(label, entry);
    else if (entry.level === "warn") console.warn(label, entry);
    else if (entry.level === "info") console.info(label, entry);
    else console.debug(label, entry);
  } catch {
    counters.internalErrors += 1;
  }
}

// ---- the bounded queue ----

// Takes the entry, or sheds one. A full queue gives up its oldest entry of the
// least severe level it holds when that level is less severe than the new
// entry; otherwise the new entry is the one shed. Error entries are kept
// longest. They are not guaranteed.
function enqueue(item: QueuedEntry): boolean {
  if (queue.length >= DIAGNOSTIC_LOG_LIMITS.queueEntries) {
    let victimRank = queuedByRank.length - 1;
    while (victimRank > item.rank && queuedByRank[victimRank] === 0) {
      victimRank -= 1;
    }
    if (victimRank <= item.rank) {
      counters.dropped[item.rank] += 1;
      return false;
    }
    const victim = queue.findIndex((queued) => queued.rank === victimRank);
    queue.splice(victim, 1);
    queuedByRank[victimRank] -= 1;
    counters.dropped[victimRank] += 1;
  }
  queue.push(item);
  queuedByRank[item.rank] += 1;
  if (queue.length > counters.queuePeak) counters.queuePeak = queue.length;
  scheduleFlush();
  return true;
}

// ---- delivery: one call at a time ----

// Arms the flush timer unless a call is in flight; the reply to that call arms
// it again. A level apply, an error or warn entry and a full batch leave on
// the next task. Anything else waits one flush window, so a burst leaves as
// one batch.
function scheduleFlush() {
  if (inFlight) return;
  const urgent =
    applyWaiters.length > 0 ||
    queue.length >= DIAGNOSTIC_LOG_LIMITS.batchEntries ||
    queuedByRank[0] + queuedByRank[WARN_RANK] > 0;
  if (flushTimer !== null) {
    if (!urgent || flushTimerUrgent) return;
    clearTimeout(flushTimer);
  }
  flushTimerUrgent = urgent;
  flushTimer = setTimeout(
    flush,
    urgent ? 0 : DIAGNOSTIC_LOG_LIMITS.flushDelayMs
  );
}

function flush() {
  flushTimer = null;
  if (inFlight) return;
  try {
    if (applyWaiters.length > 0) {
      send([], applyWaiters.splice(0));
      return;
    }
    if (queue.length === 0) return;
    const batch = queue.splice(0, DIAGNOSTIC_LOG_LIMITS.batchEntries);
    for (const item of batch) queuedByRank[item.rank] -= 1;
    send(batch, []);
  } catch {
    counters.internalErrors += 1;
  }
}

function send(batch: QueuedEntry[], waiters: ApplyWaiter[]) {
  inFlight = true;
  // Only this count outlives the function. The reply callbacks below must not
  // hold the batch: they stay reachable for as long as native does not answer,
  // and a call that timed out would keep its entries with them.
  const sent = batch.length;
  counters.ipcCalls += 1;
  counters.ipcEntries += sent;
  for (const item of batch) counters.ipcBytes += item.bytes;

  let settled = false;
  const settle = (
    outcome:
      | { reply: unknown }
      | { rejection: unknown }
      | { timedOut: true }
  ) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    inFlight = false;
    let receipt: DiagnosticLogReceipt | null = null;
    let failure: Error | undefined;
    try {
      receipt =
        "reply" in outcome ? readDiagnosticLogReceipt(outcome.reply) : null;
      if (receipt) {
        nativeAppliedLevel = receipt.appliedLevel;
        nativeSink = receipt.sink;
        counters.nativeAccepted += receipt.accepted;
        counters.nativeFiltered += receipt.filtered;
        counters.nativeRejected += receipt.rejected;
        counters.nativeDropped += receipt.dropped;
      } else {
        counters.undeliveredEntries += sent;
        if ("reply" in outcome) {
          counters.ipcMalformedReceipts += 1;
          failure = new Error(DIAGNOSTIC_LOG_MALFORMED_RECEIPT_MESSAGE);
        } else if ("timedOut" in outcome) {
          counters.ipcTimeouts += 1;
          failure = new Error(DIAGNOSTIC_LOG_NO_REPLY_MESSAGE);
        } else {
          counters.ipcFailures += 1;
          failure = rejectionError(outcome.rejection);
        }
      }
    } catch {
      counters.internalErrors += 1;
      receipt = null;
    }
    // Every waiter is settled, whatever happened above: an apply never stays
    // pending because its outcome could not be read.
    for (const waiter of waiters) {
      if (receipt) waiter.resolve(receipt);
      else waiter.reject(failure ?? new Error(DIAGNOSTIC_LOG_REJECTED_MESSAGE));
    }
    if (applyWaiters.length > 0 || queue.length > 0) scheduleFlush();
  };
  const watchdog = setTimeout(
    () => settle({ timedOut: true }),
    DIAGNOSTIC_LOG_LIMITS.replyTimeoutMs
  );

  let call: Promise<unknown>;
  try {
    call = writeDiagnosticLog(
      thresholdLevel,
      batch.map((item) => item.entry)
    );
  } catch (error) {
    call = Promise.reject(error);
  }
  call.then(
    (reply) => settle({ reply }),
    (rejection) => settle({ rejection })
  );
}

// The reason of a rejected call as an Error. A value that cannot be turned
// into text gets a fixed reason.
function rejectionError(rejection: unknown): Error {
  if (rejection instanceof Error) return rejection;
  try {
    return new Error(String(rejection));
  } catch {
    return new Error(DIAGNOSTIC_LOG_REJECTED_MESSAGE);
  }
}

// A count as native sends it: a whole number that is exact here.
function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

// A version 1 receipt read field by field, or null. Total: a reply that throws
// when it is read is not a receipt.
export function readDiagnosticLogReceipt(
  value: unknown
): DiagnosticLogReceipt | null {
  try {
    return readReceiptFields(value);
  } catch {
    return null;
  }
}

function readReceiptFields(value: unknown): DiagnosticLogReceipt | null {
  if (!isRecordLike(value) || value.v !== 1) return null;
  const { appliedLevel, accepted, filtered, rejected, dropped, sink } = value;
  if (
    !isDiagnosticLogLevel(appliedLevel) ||
    !isCount(accepted) ||
    !isCount(filtered) ||
    !isCount(rejected) ||
    !isCount(dropped) ||
    !isRecordLike(sink)
  ) {
    return null;
  }
  const { state, droppedTotal, writeFailures, unsavedAtExit } = sink;
  if (
    (state !== "ready" && state !== "degraded" && state !== "failed") ||
    !isCount(droppedTotal) ||
    !isCount(writeFailures) ||
    !isCount(unsavedAtExit)
  ) {
    return null;
  }
  return {
    v: 1,
    appliedLevel,
    accepted,
    filtered,
    rejected,
    dropped,
    sink: { state, droppedTotal, writeFailures, unsavedAtExit },
  };
}

// ---- the level apply as the Hook shows it ----
//
// Order. Applies are ordered by a Hook-local request id. A reply is written
// only to the pending record of the same request, so a late reply for an older
// request changes nothing.
//
// Meaning. Applied says that native answered this request with a receipt whose
// level is the requested one. Until then the level is shown as requested, not
// as active on native. The record decides nothing: no request, no level and no
// business path reads it.

export interface DiagnosticLogLevelApply {
  // Hook-local, strictly increasing. The only ordering key.
  requestId: number;
  level: DiagnosticLogLevel;
  status: "pending" | "applied" | "failed";
  // Present once applied: what native reported.
  appliedLevel?: DiagnosticLogLevel;
  sinkState?: DiagnosticLogSinkState;
  // Present once failed.
  message?: string;
}

export type DiagnosticLogLevelOutcome =
  | { receipt: DiagnosticLogReceipt }
  | { message: string };

export type DiagnosticLogLevelProjection =
  | { phase: "pending"; level: DiagnosticLogLevel }
  | {
      phase: "applied";
      level: DiagnosticLogLevel;
      appliedLevel: DiagnosticLogLevel;
      sinkState: DiagnosticLogSinkState;
    }
  | { phase: "failed"; level: DiagnosticLogLevel; message: string };

// First writer: the record kept once a request is sent.
export function beginDiagnosticLogLevelApply(
  requestId: number,
  level: DiagnosticLogLevel
): DiagnosticLogLevelApply {
  return { requestId, level, status: "pending" };
}

// Second writer: the native reply, applied only to the pending record of the
// same request.
export function settleDiagnosticLogLevelApply(
  previous: DiagnosticLogLevelApply | null,
  requestId: number,
  outcome: DiagnosticLogLevelOutcome
): DiagnosticLogLevelApply | null {
  if (
    !previous ||
    previous.requestId !== requestId ||
    previous.status !== "pending"
  ) {
    return previous;
  }
  if ("message" in outcome) {
    return {
      ...previous,
      status: "failed",
      message: outcome.message.slice(0, DIAGNOSTIC_LOG_LIMITS.messageChars),
    };
  }
  const receipt = readDiagnosticLogReceipt(outcome.receipt);
  if (!receipt) {
    return {
      ...previous,
      status: "failed",
      message: DIAGNOSTIC_LOG_MALFORMED_RECEIPT_MESSAGE,
    };
  }
  if (receipt.appliedLevel !== previous.level) {
    return {
      ...previous,
      status: "failed",
      message: `Native reports ${receipt.appliedLevel}.`,
    };
  }
  return {
    ...previous,
    status: "applied",
    appliedLevel: receipt.appliedLevel,
    sinkState: receipt.sink.state,
  };
}

// What the panel shows. The setting is user intent; applied and failed come
// only from the settled record of a request for that same level.
export function projectDiagnosticLogLevel(input: {
  level: DiagnosticLogLevel;
  apply: DiagnosticLogLevelApply | null;
}): DiagnosticLogLevelProjection {
  const { level, apply } = input;
  if (!apply || apply.level !== level || apply.status === "pending") {
    return { phase: "pending", level };
  }
  if (
    apply.status === "applied" &&
    apply.appliedLevel === level &&
    apply.sinkState !== undefined
  ) {
    return {
      phase: "applied",
      level,
      appliedLevel: apply.appliedLevel,
      sinkState: apply.sinkState,
    };
  }
  return { phase: "failed", level, message: apply.message ?? "" };
}
