//! Task 178 LG: the ordinary diagnostic log. Level contract, bounded sink and the
//! one IPC command.
//!
//! Level. Five levels, most severe first; a threshold includes every more severe
//! level. The level expresses diagnostic severity and detail only. It gates nothing
//! but ordinary diagnostic output: canonical facts, Session Recording, the critical
//! event stream, Native Stall Diagnostics files and raw audio permission never read
//! it, and it starts no model call, sampler or capture. One threshold is shared by
//! the entries the frontend sends and by the native `tracing` events of the
//! allowlisted targets. It is `info` until the first valid call of the command.
//!
//! Producers. A frontend entry arrives through `write_diagnostic_log` as an untyped
//! value and is validated field by field; only the validated fields are written. A
//! native event arrives through the subscriber, which answers `Interest::never()`
//! for every call site outside `NATIVE_ALLOWLIST`, so a `tracing` macro anywhere
//! else, including one on a realtime audio thread, stays a no-op. Both producers
//! only build one bounded line and push it; neither touches a file or stderr.
//!
//! Queue. One queue with two lanes: error, warn and info take the priority lane,
//! debug and trace the detail lane. Detail entries never use more than the detail
//! capacity, so the rest of the queue is always left to the priority lane, which
//! may use all of it. A priority entry that finds the whole queue full takes the
//! place of the oldest queued detail entry. When no detail entry is left, an
//! error takes the place of the oldest info entry, or else of the oldest warn,
//! and a warn the place of the oldest info. Otherwise the arriving entry is the
//! one shed. Every shed entry is counted. Nothing is lossless, errors included.
//!
//! Writer. One named thread appends JSON Lines to segments in
//! `<app data dir>/diagnostic-logs` and prints one line per entry to stderr, each
//! line in a stderr write of its own, so the stderr lock is free between lines.
//! The active segment is
//! `diagnostic-<start ms, 13 digits>-<sequence, 4 digits>.jsonl.partial`
//! and loses the `.partial` suffix only when the writer seals it, so a file that
//! was still being written never presents as complete. A run never reopens a
//! file: every run that writes an entry adds at least one segment.
//!
//! Retention. A pure function of the segment list and now. Its two bounds are
//! the approved ones: no segment that started 14 days ago or earlier, and at most
//! 50 MiB in total, which is ten full segments; the oldest goes first. The number
//! of files is guarded at 1,024 and is not a retention rule, so short runs and
//! daily rotation do not push out history the two bounds allow. Retention runs at
//! startup, before a segment is opened and every five minutes while the writer is
//! idle or busy. A segment that cannot be removed is skipped and the pass goes on
//! with the rest; a new segment is refused only when the bytes that remain leave
//! no room for it under the 50 MiB bound.
//!
//! Directory. It is checked before every file operation: before a listing, the
//! creation of a segment, each batch appended to the active segment, a seal and
//! each removal it must be a real directory. A symlink in its place is refused,
//! and an active segment is then given up. Known limit: the check and the
//! operation that follows it are two calls on a path, so a directory replaced by
//! a symlink between the two is not seen by that one operation. One segment can
//! then be created or sealed, or one file with a segment name removed, in the
//! folder behind the link. The next batch or housekeeping pass finds the link.
//!
//! Failure. Counters and a sink state travel in every receipt. The sink prints at
//! most one direct stderr line per state change and never creates an entry about
//! its own queue or writer. A retention pass that could not remove a segment has
//! a line of its own and leaves the state as it is. Known limit: the writer
//! prints a batch to stderr after saving it, so a stderr that stops taking output
//! stops the writer. The queue then fills and sheds, which the counters show,
//! while the state stays `ready`.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};
use std::collections::VecDeque;
use std::fmt::{self, Write as _};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tracing::field::{Field, Visit};
use tracing::level_filters::LevelFilter;
use tracing::subscriber::Interest;
use tracing::{span, Event, Metadata, Subscriber};

/// Version of the entry and of the receipt on the wire.
pub const DIAGNOSTIC_LOG_WIRE_VERSION: u8 = 1;

// Entry bounds of the wire contract. Native enforces each of them again.
const MAX_ENTRIES_PER_CALL: usize = 64;
const MAX_ENTRY_BYTES: usize = 2_048;
const MAX_SOURCE_CHARS: usize = 48;
const MAX_EVENT_CHARS: usize = 64;
const MAX_MESSAGE_CHARS: usize = 256;
const MAX_REF_CHARS: usize = 128;
const MAX_DATA_KEYS: usize = 16;
const MAX_DATA_KEY_CHARS: usize = 48;
const MAX_DATA_STRING_CHARS: usize = 256;
const ENTRY_KEYS: [&str; 8] = [
    "v", "at", "level", "source", "event", "message", "refs", "data",
];
const REF_KEYS: [&str; 5] = [
    "runtimeSessionId",
    "recordingSessionId",
    "traceId",
    "operationId",
    "requestId",
];
const ORIGIN_FRONTEND: &str = "frontend";
const ORIGIN_NATIVE: &str = "native";
/// What the added origin costs on a frontend line; not part of the entry bound.
const FRONTEND_ORIGIN_FIELD: &str = r#","origin":"frontend""#;
const INVALID_LEVEL_MESSAGE: &str =
    "Diagnostic log level is not one of error, warn, info, debug, trace";

// Queue. Entries, not bytes; one entry is at most MAX_ENTRY_BYTES plus the origin.
/// What the priority lane always has for itself. It is not a cap: priority
/// entries may use the whole queue.
const PRIORITY_LANE_RESERVED: usize = 1_024;
/// The most the detail lane ever holds.
const DETAIL_LANE_CAPACITY: usize = 2_048;
const QUEUE_CAPACITY: usize = PRIORITY_LANE_RESERVED + DETAIL_LANE_CAPACITY;
const WRITER_BATCH_ENTRIES: usize = 256;
const WRITER_THREAD_NAME: &str = "diagnostic-log-writer";

// Files. Binary units.
const DIRECTORY_NAME: &str = "diagnostic-logs";
const SEGMENT_PREFIX: &str = "diagnostic-";
const SEGMENT_START_DIGITS: usize = 13;
const SEGMENT_SEQUENCE_DIGITS: usize = 4;
const SEALED_SUFFIX: &str = ".jsonl";
const PARTIAL_SUFFIX: &str = ".jsonl.partial";
const SEGMENT_MAX_BYTES: u64 = 5 * 1024 * 1024;
const SEGMENT_MAX_AGE_MS: u64 = 24 * 60 * 60 * 1_000;
/// The byte bound of retention is this many full segments: 50 MiB.
const FULL_SEGMENTS_RETAINED: u64 = 10;
const RETENTION_MAX_BYTES: u64 = FULL_SEGMENTS_RETAINED * SEGMENT_MAX_BYTES;
const RETENTION_MAX_AGE_MS: u64 = 14 * 24 * 60 * 60 * 1_000;
/// A guard on the number of files in the directory, not a retention rule. Every
/// run and every day adds a segment however small, so a count of ten would keep
/// ten runs or ten days and neither approved bound could be reached. It takes
/// more than 73 runs a day for 14 days to reach this guard.
const MAX_SEGMENT_FILES: usize = 1_024;
/// How often the writer applies rotation by age and retention, idle or busy.
const HOUSEKEEPING_INTERVAL: Duration = Duration::from_secs(5 * 60);
/// The only wait the sink adds to the app exit path.
const EXIT_FLUSH_BOUND: Duration = Duration::from_millis(250);

const TERMINAL_PREFIX: &str = "[diagnostic-log] ";

/// Five levels, most severe first. A threshold includes every more severe level.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticLogLevel {
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

impl DiagnosticLogLevel {
    /// The level named by a wire value, or `None` for anything else.
    pub fn from_wire(value: &str) -> Option<Self> {
        match value {
            "error" => Some(Self::Error),
            "warn" => Some(Self::Warn),
            "info" => Some(Self::Info),
            "debug" => Some(Self::Debug),
            "trace" => Some(Self::Trace),
            _ => None,
        }
    }

    fn from_rank(rank: u8) -> Self {
        match rank {
            0 => Self::Error,
            1 => Self::Warn,
            2 => Self::Info,
            3 => Self::Debug,
            _ => Self::Trace,
        }
    }

    fn of_event(level: &tracing::Level) -> Self {
        if *level == tracing::Level::ERROR {
            Self::Error
        } else if *level == tracing::Level::WARN {
            Self::Warn
        } else if *level == tracing::Level::INFO {
            Self::Info
        } else if *level == tracing::Level::DEBUG {
            Self::Debug
        } else {
            Self::Trace
        }
    }

    fn is_detail(self) -> bool {
        self > Self::Info
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticLogSinkState {
    /// The writer runs and the last file write succeeded.
    Ready,
    /// The writer runs, file output is failing and is tried again with later entries.
    Degraded,
    /// No file output for this run: the directory was unusable at startup, or
    /// there is no writer.
    Failed,
}

impl DiagnosticLogSinkState {
    fn from_rank(rank: u8) -> Self {
        match rank {
            0 => Self::Ready,
            1 => Self::Degraded,
            _ => Self::Failed,
        }
    }
}

/// Process-lifetime sink totals carried by every receipt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticLogSinkReceipt {
    pub state: DiagnosticLogSinkState,
    /// Entries shed because the queue was full or no writer was running.
    pub dropped_total: u64,
    /// Entries the writer took and could not save to a file.
    pub write_failures: u64,
    /// Entries still queued or being written when the exit flush reached its bound.
    pub unsaved_at_exit: u64,
}

/// Receipt, version 1. `accepted + filtered + rejected + dropped` equals the
/// number of entries received by the call.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticLogReceipt {
    pub v: u8,
    pub applied_level: DiagnosticLogLevel,
    pub accepted: u64,
    pub filtered: u64,
    pub rejected: u64,
    pub dropped: u64,
    pub sink: DiagnosticLogSinkReceipt,
}

/// A native `tracing` target whose events are live, the source its entries carry
/// and the most detailed level admitted from it.
struct AllowedTarget {
    target: &'static str,
    source: &'static str,
    most_detailed: DiagnosticLogLevel,
}

/// Every call site outside this list is answered with `Interest::never()`.
///
/// `speaker::commands` runs on Tokio workers, the `native-audio-start` thread and
/// the main thread, never inside the audio callback. Only its `error!` call sites
/// are live: each sits on a failure branch. Its `warn!` call sites stay off until
/// they are graded, because one of them fires on every normal stop (the capture
/// task's release finds the capture already stopping). Its two `info!` receipts
/// stay off: they format one whole JSON value per emitted segment and carry
/// device identifiers, and the same facts already reach the frontend as events.
/// `speaker::macos` is left out because that module holds the CoreAudio callback;
/// `speaker::windows` and `speaker::linux` because their call sites run on the
/// capture threads.
const NATIVE_ALLOWLIST: &[AllowedTarget] = &[AllowedTarget {
    target: "jarvis_lib::speaker::commands",
    source: "native.speaker.commands",
    most_detailed: DiagnosticLogLevel::Error,
}];

/// The one event tag of version 1 for native events: call sites carry no tag yet.
const NATIVE_EVENT_TAG: &str = "tracing";

fn allowed_source(
    allowlist: &[AllowedTarget],
    target: &str,
    level: DiagnosticLogLevel,
) -> Option<&'static str> {
    allowlist
        .iter()
        .find(|allowed| allowed.target == target && level <= allowed.most_detailed)
        .map(|allowed| allowed.source)
}

/// One line of the log. Field order is the order on disk.
#[derive(Serialize)]
struct Line<'a> {
    v: u8,
    at: &'a Number,
    level: DiagnosticLogLevel,
    source: &'a str,
    event: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    refs: Option<&'a Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<&'a Map<String, Value>>,
    origin: &'static str,
}

enum Verdict {
    Accepted(DiagnosticLogLevel, String),
    Filtered,
    Rejected,
}

/// The level is read first: an entry below the threshold is counted as filtered
/// and is not validated or serialised any further.
fn examine_frontend_entry(entry: &Value, threshold: DiagnosticLogLevel) -> Verdict {
    let Some(entry) = entry.as_object() else {
        return Verdict::Rejected;
    };
    let level = entry
        .get("level")
        .and_then(Value::as_str)
        .and_then(DiagnosticLogLevel::from_wire);
    match level {
        None => Verdict::Rejected,
        Some(level) if level > threshold => Verdict::Filtered,
        Some(level) => match frontend_line(entry, level) {
            Some(line) => Verdict::Accepted(level, line),
            None => Verdict::Rejected,
        },
    }
}

/// The line for a well-formed entry, built from the validated fields only, or
/// `None` when any field is unknown, malformed or over a bound.
fn frontend_line(entry: &Map<String, Value>, level: DiagnosticLogLevel) -> Option<String> {
    if entry.keys().any(|key| !ENTRY_KEYS.contains(&key.as_str())) {
        return None;
    }
    if entry.get("v")?.as_u64()? != u64::from(DIAGNOSTIC_LOG_WIRE_VERSION) {
        return None;
    }
    let at = entry.get("at")?.as_number()?;
    if !at.as_f64().is_some_and(|ms| ms.is_finite() && ms >= 0.0) {
        return None;
    }
    let source = tag(entry.get("source")?, MAX_SOURCE_CHARS)?;
    let event = tag(entry.get("event")?, MAX_EVENT_CHARS)?;
    let message = match entry.get("message") {
        None => None,
        Some(message) => Some(text(message, MAX_MESSAGE_CHARS)?),
    };
    let refs = match entry.get("refs") {
        None => None,
        Some(refs) => Some(valid_refs(refs)?),
    };
    let data = match entry.get("data") {
        None => None,
        Some(data) => Some(valid_data(data)?),
    };
    let line = serde_json::to_string(&Line {
        v: DIAGNOSTIC_LOG_WIRE_VERSION,
        at,
        level,
        source,
        event,
        message,
        refs,
        data,
        origin: ORIGIN_FRONTEND,
    })
    .ok()?;
    (line.len() - FRONTEND_ORIGIN_FIELD.len() <= MAX_ENTRY_BYTES).then_some(line)
}

/// 1 to `max` characters of `[a-z0-9.-]`.
fn tag(value: &Value, max: usize) -> Option<&str> {
    let tag = value.as_str()?;
    let allowed = |byte: u8| {
        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'.' || byte == b'-'
    };
    ((1..=max).contains(&tag.len()) && tag.bytes().all(allowed)).then_some(tag)
}

/// At most `max_chars` characters. A text of at most that many bytes is not counted.
fn text(value: &Value, max_chars: usize) -> Option<&str> {
    let text = value.as_str()?;
    (text.len() <= max_chars || text.chars().count() <= max_chars).then_some(text)
}

fn valid_refs(value: &Value) -> Option<&Map<String, Value>> {
    let refs = value.as_object()?;
    refs.iter()
        .all(|(key, value)| {
            REF_KEYS.contains(&key.as_str()) && text(value, MAX_REF_CHARS).is_some()
        })
        .then_some(refs)
}

/// Flat: a nested object or an array as a value refuses the entry.
fn valid_data(value: &Value) -> Option<&Map<String, Value>> {
    let data = value.as_object()?;
    let key_allowed = |key: &str| {
        (1..=MAX_DATA_KEY_CHARS).contains(&key.len())
            && key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
    };
    let value_allowed = |value: &Value| match value {
        Value::Null | Value::Bool(_) => true,
        Value::Number(number) => number.as_f64().is_some_and(f64::is_finite),
        Value::String(_) => text(value, MAX_DATA_STRING_CHARS).is_some(),
        Value::Array(_) | Value::Object(_) => false,
    };
    (data.len() <= MAX_DATA_KEYS
        && data
            .iter()
            .all(|(key, value)| key_allowed(key) && value_allowed(value)))
    .then_some(data)
}

/// The message of a native event, cut at the message bound. Formatting stops at
/// the bound, so an oversize value is not rendered in full first.
#[derive(Default)]
struct BoundedMessage {
    text: String,
    chars: usize,
    truncated: bool,
}

impl fmt::Write for BoundedMessage {
    fn write_str(&mut self, text: &str) -> fmt::Result {
        for character in text.chars() {
            if self.chars == MAX_MESSAGE_CHARS {
                self.truncated = true;
                return Err(fmt::Error);
            }
            self.text.push(character);
            self.chars += 1;
        }
        Ok(())
    }
}

/// Only `message` is recorded in version 1. Any other field of a call site is
/// ignored, so adding a field to an allowlisted call site cannot widen the output.
impl Visit for BoundedMessage {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        if field.name() == "message" {
            let _ = write!(self, "{value:?}");
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            let _ = self.write_str(value);
        }
    }
}

struct Queued {
    order: u64,
    level: DiagnosticLogLevel,
    line: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WriterPhase {
    /// Not started, or the thread could not be created.
    Absent,
    Running,
    /// The exit flush was requested: nothing more is admitted.
    Closing,
    Ended,
}

struct Queue {
    priority: VecDeque<Queued>,
    detail: VecDeque<Queued>,
    /// How many entries of each level the priority lane holds: error, warn, info.
    priority_levels: [usize; 3],
    next_order: u64,
    /// Entries the writer took and has not finished saving.
    in_flight: usize,
    writer: WriterPhase,
}

/// What became of one arriving entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Admission {
    Queued,
    /// Queued in the place of an older entry, whose order number this is.
    Displaced(u64),
    /// Not queued: the arriving entry is the one shed.
    Shed,
}

impl Queue {
    fn new() -> Self {
        Self {
            priority: VecDeque::new(),
            detail: VecDeque::new(),
            priority_levels: [0; 3],
            next_order: 0,
            in_flight: 0,
            writer: WriterPhase::Absent,
        }
    }

    fn len(&self) -> usize {
        self.priority.len() + self.detail.len()
    }

    fn admit(&mut self, level: DiagnosticLogLevel, line: String) -> Admission {
        if self.writer != WriterPhase::Running {
            return Admission::Shed;
        }
        let mut admission = Admission::Queued;
        if level.is_detail() {
            if self.detail.len() >= DETAIL_LANE_CAPACITY || self.len() >= QUEUE_CAPACITY {
                return Admission::Shed;
            }
        } else if self.len() >= QUEUE_CAPACITY {
            // Full: the oldest detail entry gives way first, then the oldest
            // priority entry that is less severe than the arriving one.
            let victim = match self.detail.pop_front() {
                Some(victim) => Some(victim),
                None => self.take_less_severe(level),
            };
            match victim {
                Some(victim) => admission = Admission::Displaced(victim.order),
                None => return Admission::Shed,
            }
        }
        let queued = Queued {
            order: self.next_order,
            level,
            line,
        };
        self.next_order += 1;
        if level.is_detail() {
            self.detail.push_back(queued);
        } else {
            self.priority_levels[level as usize] += 1;
            self.priority.push_back(queued);
        }
        admission
    }

    /// Removes the oldest priority entry of the least severe level that is less
    /// severe than `level`: an info before a warn, and never an error.
    fn take_less_severe(&mut self, level: DiagnosticLogLevel) -> Option<Queued> {
        let victim_level = [DiagnosticLogLevel::Info, DiagnosticLogLevel::Warn]
            .into_iter()
            .find(|victim| *victim > level && self.priority_levels[*victim as usize] > 0)?;
        let index = self
            .priority
            .iter()
            .position(|queued| queued.level == victim_level)?;
        self.priority_levels[victim_level as usize] -= 1;
        self.priority.remove(index)
    }

    /// The oldest entries of both lanes, in arrival order.
    fn take_batch(&mut self, limit: usize) -> Vec<String> {
        let mut batch = Vec::with_capacity(limit.min(self.len()));
        while batch.len() < limit {
            let from_priority = match (self.priority.front(), self.detail.front()) {
                (Some(priority), Some(detail)) => priority.order < detail.order,
                (Some(_), None) => true,
                (None, Some(_)) => false,
                (None, None) => break,
            };
            let queued = if from_priority {
                let queued = self.priority.pop_front();
                if let Some(queued) = &queued {
                    self.priority_levels[queued.level as usize] -= 1;
                }
                queued
            } else {
                self.detail.pop_front()
            };
            if let Some(queued) = queued {
                batch.push(queued.line);
            }
        }
        batch
    }

    /// Empties both lanes and returns how many entries they held.
    fn clear(&mut self) -> usize {
        let held = self.len();
        self.priority.clear();
        self.detail.clear();
        self.priority_levels = [0; 3];
        held
    }
}

type Clock = Box<dyn Fn() -> u64 + Send + Sync>;
type Terminal = Box<dyn Write + Send>;

/// The sink: threshold, queue, counters and state. Producers only call `receive`
/// and `submit_native`; the writer thread owns every file.
struct Sink {
    level: AtomicU8,
    state: AtomicU8,
    dropped_total: AtomicU64,
    write_failures: AtomicU64,
    unsaved_at_exit: AtomicU64,
    queue: Mutex<Queue>,
    /// Wakes the writer.
    wake: Condvar,
    /// Tells the exit flush that the writer has ended.
    ended: Condvar,
    /// Where the per-entry line and the state lines go: stderr in the app.
    terminal: Mutex<Terminal>,
    /// Epoch milliseconds, for native entries, segment names and retention.
    clock: Clock,
    /// How long the writer waits for an entry before it applies rotation by age
    /// and retention: `HOUSEKEEPING_INTERVAL` in the app.
    idle_wait: Duration,
}

fn unpoisoned<T>(result: Result<T, PoisonError<T>>) -> T {
    result.unwrap_or_else(PoisonError::into_inner)
}

impl Sink {
    fn new(clock: Clock, terminal: Terminal, idle_wait: Duration) -> Self {
        Self {
            level: AtomicU8::new(DiagnosticLogLevel::Info as u8),
            // There is no output until `start`.
            state: AtomicU8::new(DiagnosticLogSinkState::Failed as u8),
            dropped_total: AtomicU64::new(0),
            write_failures: AtomicU64::new(0),
            unsaved_at_exit: AtomicU64::new(0),
            queue: Mutex::new(Queue::new()),
            wake: Condvar::new(),
            ended: Condvar::new(),
            terminal: Mutex::new(terminal),
            clock,
            idle_wait,
        }
    }

    fn level(&self) -> DiagnosticLogLevel {
        DiagnosticLogLevel::from_rank(self.level.load(Ordering::Relaxed))
    }

    fn state(&self) -> DiagnosticLogSinkState {
        DiagnosticLogSinkState::from_rank(self.state.load(Ordering::Relaxed))
    }

    fn lock_queue(&self) -> MutexGuard<'_, Queue> {
        unpoisoned(self.queue.lock())
    }

    /// Starts the writer once. `directory` is the logger's own directory, or
    /// `None` when the app data directory could not be resolved. Returns whether
    /// a writer is running.
    fn start(self: &Arc<Self>, directory: Option<PathBuf>) -> bool {
        let mut queue = self.lock_queue();
        if queue.writer != WriterPhase::Absent {
            return queue.writer == WriterPhase::Running;
        }
        let (directory, problem) = match directory {
            None => (None, Some("app data directory unavailable".to_string())),
            Some(directory) => match prepare_directory(&directory) {
                Ok(()) => (Some(directory), None),
                Err(error) => (
                    None,
                    Some(format!("log directory unavailable ({:?})", error.kind())),
                ),
            },
        };
        let segments = Segments {
            directory,
            active: None,
            next_sequence: 0,
            retention_failure: None,
        };
        if problem.is_none() {
            // Before the thread exists, so that its first file result is not lost.
            self.state
                .store(DiagnosticLogSinkState::Ready as u8, Ordering::Relaxed);
        }
        let sink = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name(WRITER_THREAD_NAME.into())
            .spawn(move || writer_thread(sink, segments));
        match (spawned, problem) {
            (Ok(_), None) => queue.writer = WriterPhase::Running,
            (Ok(_), Some(problem)) => {
                // The writer still prints the terminal line; nothing is saved.
                queue.writer = WriterPhase::Running;
                self.print_line(&format!("sink failed: {problem}"));
            }
            (Err(error), _) => {
                self.state
                    .store(DiagnosticLogSinkState::Failed as u8, Ordering::Relaxed);
                self.print_line(&format!(
                    "sink failed: writer thread unavailable ({:?})",
                    error.kind()
                ));
            }
        }
        queue.writer == WriterPhase::Running
    }

    /// The command body. Fails only for an invalid level value, and then applies
    /// nothing. It never waits for the writer: it validates, takes the queue lock
    /// once and returns.
    fn receive(
        &self,
        level: &str,
        entries: Option<&Value>,
    ) -> Result<DiagnosticLogReceipt, String> {
        let threshold = DiagnosticLogLevel::from_wire(level)
            .ok_or_else(|| INVALID_LEVEL_MESSAGE.to_string())?;
        self.level.store(threshold as u8, Ordering::Relaxed);

        let (mut accepted, mut filtered, mut rejected, mut dropped) = (0u64, 0u64, 0u64, 0u64);
        let mut lines = Vec::new();
        match entries {
            None | Some(Value::Null) => {}
            Some(Value::Array(entries)) => {
                rejected += entries.len().saturating_sub(MAX_ENTRIES_PER_CALL) as u64;
                for entry in entries.iter().take(MAX_ENTRIES_PER_CALL) {
                    match examine_frontend_entry(entry, threshold) {
                        Verdict::Accepted(level, line) => lines.push((level, line)),
                        Verdict::Filtered => filtered += 1,
                        Verdict::Rejected => rejected += 1,
                    }
                }
            }
            // Not a batch at all: refused as one malformed item.
            Some(_) => rejected += 1,
        }
        if !lines.is_empty() {
            let mut shed = 0;
            let mut queue = self.lock_queue();
            let first_of_call = queue.next_order;
            for (level, line) in lines {
                match queue.admit(level, line) {
                    Admission::Queued => accepted += 1,
                    Admission::Displaced(order) => {
                        shed += 1;
                        if order < first_of_call {
                            accepted += 1;
                        } else {
                            // The displaced entry is an earlier one of this
                            // call: it is no longer queued, the arriving one is.
                            dropped += 1;
                        }
                    }
                    Admission::Shed => {
                        shed += 1;
                        dropped += 1;
                    }
                }
            }
            drop(queue);
            self.dropped_total.fetch_add(shed, Ordering::Relaxed);
            self.wake.notify_one();
        }
        Ok(DiagnosticLogReceipt {
            v: DIAGNOSTIC_LOG_WIRE_VERSION,
            applied_level: self.level(),
            accepted,
            filtered,
            rejected,
            dropped,
            sink: DiagnosticLogSinkReceipt {
                state: self.state(),
                dropped_total: self.dropped_total.load(Ordering::Relaxed),
                write_failures: self.write_failures.load(Ordering::Relaxed),
                unsaved_at_exit: self.unsaved_at_exit.load(Ordering::Relaxed),
            },
        })
    }

    /// One native event that passed the allowlist and the threshold.
    fn submit_native(
        &self,
        level: DiagnosticLogLevel,
        source: &'static str,
        line_number: Option<u32>,
        message: &BoundedMessage,
    ) {
        let at = Number::from((self.clock)());
        let mut data = Map::new();
        if let Some(line_number) = line_number {
            data.insert("line".into(), line_number.into());
        }
        if message.truncated {
            data.insert("truncated".into(), true.into());
        }
        let Ok(line) = serde_json::to_string(&Line {
            v: DIAGNOSTIC_LOG_WIRE_VERSION,
            at: &at,
            level,
            source,
            event: NATIVE_EVENT_TAG,
            message: (!message.text.is_empty()).then_some(message.text.as_str()),
            refs: None,
            data: (!data.is_empty()).then_some(&data),
            origin: ORIGIN_NATIVE,
        }) else {
            return;
        };
        let admission = self.lock_queue().admit(level, line);
        if admission != Admission::Queued {
            self.dropped_total.fetch_add(1, Ordering::Relaxed);
        }
        if admission != Admission::Shed {
            self.wake.notify_one();
        }
    }

    /// Asks the writer to save what is queued and seal the active segment, and
    /// waits at most `bound`. What is still queued or being written at the bound
    /// is counted as unsaved. Nothing is admitted afterwards.
    fn close(&self, bound: Duration) {
        let deadline = Instant::now() + bound;
        let mut queue = self.lock_queue();
        if queue.writer != WriterPhase::Running {
            return;
        }
        queue.writer = WriterPhase::Closing;
        self.wake.notify_all();
        while queue.writer != WriterPhase::Ended {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            queue = unpoisoned(self.ended.wait_timeout(queue, remaining)).0;
        }
        let unsaved = if queue.writer == WriterPhase::Ended {
            0
        } else {
            (queue.len() + queue.in_flight) as u64
        };
        drop(queue);
        if unsaved > 0 {
            self.unsaved_at_exit.store(unsaved, Ordering::Relaxed);
            // The writer may be stuck holding the terminal; exit never waits for it.
            if let Ok(mut terminal) = self.terminal.try_lock() {
                let _ = writeln!(
                    terminal,
                    "{TERMINAL_PREFIX}exit flush incomplete: {unsaved} entries unsaved"
                );
            }
        }
    }

    /// A direct line about the sink itself. Never an entry.
    fn print_line(&self, line: &str) {
        let _ = writeln!(unpoisoned(self.terminal.lock()), "{TERMINAL_PREFIX}{line}");
    }

    /// One write per entry line. A whole batch in one write would hold the
    /// process-wide stderr lock, and every other print of the process with it,
    /// for up to 256 entries.
    fn print_entries(&self, lines: &[String]) {
        let mut output = String::new();
        for line in lines {
            output.clear();
            output.push_str(TERMINAL_PREFIX);
            output.push_str(line);
            output.push('\n');
            let _ = unpoisoned(self.terminal.lock()).write_all(output.as_bytes());
        }
    }

    /// At most one line per change of state. `Failed` is final for the run.
    fn file_result(&self, result: &io::Result<()>, resumes: bool) {
        let (from, to, line) = match result {
            Ok(()) if resumes => (
                DiagnosticLogSinkState::Degraded,
                DiagnosticLogSinkState::Ready,
                "sink ready: file output resumed".to_string(),
            ),
            Ok(()) => return,
            Err(error) => (
                DiagnosticLogSinkState::Ready,
                DiagnosticLogSinkState::Degraded,
                format!("sink degraded: file output failing ({:?})", error.kind()),
            ),
        };
        let changed = self
            .state
            .compare_exchange(from as u8, to as u8, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok();
        if changed {
            self.print_line(&line);
        }
    }

    /// A retention pass that could not remove a segment: one line when that
    /// starts and none while it lasts. The state is not touched, because the
    /// segment was skipped and writes go on.
    fn retention_result(&self, failure: Option<io::ErrorKind>, failing: &mut bool) {
        if let (Some(kind), false) = (failure, *failing) {
            self.print_line(&format!(
                "retention incomplete: a segment could not be removed ({kind:?})"
            ));
        }
        *failing = failure.is_some();
    }

    /// Blocks the writer until there is something to save, the exit flush is
    /// requested or the idle wait has passed. An empty batch means the idle wait
    /// passed, or the end when `closing`.
    fn next_batch(&self) -> (Vec<String>, bool) {
        let mut queue = self.lock_queue();
        while queue.len() == 0 && queue.writer != WriterPhase::Closing {
            let (guard, wait) = unpoisoned(self.wake.wait_timeout(queue, self.idle_wait));
            queue = guard;
            if wait.timed_out() {
                break;
            }
        }
        let batch = queue.take_batch(WRITER_BATCH_ENTRIES);
        queue.in_flight = batch.len();
        (batch, queue.writer == WriterPhase::Closing)
    }

    fn run_writer(&self, segments: &mut Segments) {
        let mut housekept_at_ms = (self.clock)();
        let mut retention_failing = false;
        let started = segments.housekeep(housekept_at_ms);
        self.file_result(&started, false);
        self.retention_result(segments.retention_failure, &mut retention_failing);
        loop {
            let (batch, closing) = self.next_batch();
            let now_ms = (self.clock)();
            if batch.is_empty() {
                if closing {
                    let sealed = segments.seal();
                    self.file_result(&sealed, false);
                    return;
                }
            } else {
                let (saved, result) = segments.append(&batch, now_ms);
                self.write_failures
                    .fetch_add((batch.len() - saved) as u64, Ordering::Relaxed);
                self.lock_queue().in_flight = 0;
                self.file_result(&result, true);
                self.retention_result(segments.retention_failure, &mut retention_failing);
                self.print_entries(&batch);
                // The idle wait never passes while entries keep arriving, so a
                // busy writer applies rotation by age and retention by the clock.
                if !housekeeping_due(housekept_at_ms, now_ms) {
                    continue;
                }
            }
            housekept_at_ms = now_ms;
            let kept = segments.housekeep(now_ms);
            self.file_result(&kept, false);
            self.retention_result(segments.retention_failure, &mut retention_failing);
        }
    }

    /// The writer stopped on an internal error: what it held and what was queued
    /// can no longer be saved, and nothing more is admitted.
    fn writer_failed(&self) {
        let lost = {
            let mut queue = self.lock_queue();
            let lost = queue.clear() + queue.in_flight;
            queue.in_flight = 0;
            queue.writer = WriterPhase::Ended;
            lost
        };
        self.write_failures
            .fetch_add(lost as u64, Ordering::Relaxed);
        let previous = self
            .state
            .swap(DiagnosticLogSinkState::Failed as u8, Ordering::Relaxed);
        if previous != DiagnosticLogSinkState::Failed as u8 {
            self.print_line("sink failed: writer ended unexpectedly");
        }
    }
}

/// Whether a busy writer owes a housekeeping pass: the last one is at least one
/// interval old, or the clock was set back behind it.
fn housekeeping_due(housekept_at_ms: u64, now_ms: u64) -> bool {
    now_ms < housekept_at_ms || now_ms - housekept_at_ms >= HOUSEKEEPING_INTERVAL.as_millis() as u64
}

fn writer_thread(sink: Arc<Sink>, mut segments: Segments) {
    if catch_unwind(AssertUnwindSafe(|| sink.run_writer(&mut segments))).is_err() {
        // A second failure while reporting the first must not escape the thread.
        let _ = catch_unwind(AssertUnwindSafe(|| sink.writer_failed()));
    }
    sink.lock_queue().writer = WriterPhase::Ended;
    sink.ended.notify_all();
}

/// One segment file of the logger, as retention sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Segment {
    name: String,
    started_at_ms: u64,
    sequence: u32,
    bytes: u64,
}

fn segment_file_name(started_at_ms: u64, sequence: u32, sealed: bool) -> String {
    let suffix = if sealed {
        SEALED_SUFFIX
    } else {
        PARTIAL_SUFFIX
    };
    format!(
        "{SEGMENT_PREFIX}{started_at_ms:0start$}-{sequence:0digits$}{suffix}",
        start = SEGMENT_START_DIGITS,
        digits = SEGMENT_SEQUENCE_DIGITS
    )
}

/// `(start, sequence)` of a name of exactly the logger's own pattern.
fn parse_segment_file_name(name: &str) -> Option<(u64, u32)> {
    let rest = name.strip_prefix(SEGMENT_PREFIX)?;
    let rest = rest
        .strip_suffix(PARTIAL_SUFFIX)
        .or_else(|| rest.strip_suffix(SEALED_SUFFIX))?;
    let (start, sequence) = rest.split_once('-')?;
    let digits = |text: &str, count: usize| {
        text.len() == count && text.bytes().all(|byte| byte.is_ascii_digit())
    };
    if !digits(start, SEGMENT_START_DIGITS) || !digits(sequence, SEGMENT_SEQUENCE_DIGITS) {
        return None;
    }
    Some((start.parse().ok()?, sequence.parse().ok()?))
}

/// Retention, as a pure function of the segment list and now: the names to
/// remove so that no segment started 14 days ago or earlier remains and the rest
/// hold at most 50 MiB, oldest removed first. The number of files is guarded as
/// well. With `room_for_new_segment` it leaves room for one more full segment.
///
/// A segment named more than one rotation period ahead of now was written under
/// another clock, so its age is unknown. It is not expired by age, which would
/// remove every segment when the clock is set back, and it counts as the oldest,
/// so it is the first to go under a bound and never pushes out a newer segment.
/// The other direction has no special case: a segment written while the clock
/// was behind is removed as soon as the corrected clock makes its start 14 days
/// old.
fn retention_removals(
    segments: &[Segment],
    now_ms: u64,
    room_for_new_segment: bool,
) -> Vec<String> {
    let (max_files, max_bytes) = if room_for_new_segment {
        (
            MAX_SEGMENT_FILES - 1,
            RETENTION_MAX_BYTES - SEGMENT_MAX_BYTES,
        )
    } else {
        (MAX_SEGMENT_FILES, RETENTION_MAX_BYTES)
    };
    let within_this_clock =
        |segment: &Segment| segment.started_at_ms <= now_ms.saturating_add(SEGMENT_MAX_AGE_MS);
    let mut oldest_first: Vec<&Segment> = segments.iter().collect();
    oldest_first.sort_by(|a, b| {
        (within_this_clock(a), a.started_at_ms, a.sequence, &a.name).cmp(&(
            within_this_clock(b),
            b.started_at_ms,
            b.sequence,
            &b.name,
        ))
    });
    let mut removals = Vec::new();
    let mut kept = VecDeque::new();
    for segment in oldest_first {
        if now_ms.saturating_sub(segment.started_at_ms) >= RETENTION_MAX_AGE_MS {
            removals.push(segment.name.clone());
        } else {
            kept.push_back(segment);
        }
    }
    let mut total = kept
        .iter()
        .fold(0u64, |total, segment| total.saturating_add(segment.bytes));
    while kept.len() > max_files || total > max_bytes {
        let Some(oldest) = kept.pop_front() else {
            break;
        };
        total = total.saturating_sub(oldest.bytes);
        removals.push(oldest.name.clone());
    }
    removals
}

fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_file())
}

/// Whether the logger's directory is there, as a real directory. A missing one
/// is `Ok(false)`. A symlink, or anything else in its place, is an error: nothing
/// is listed, written, renamed or removed through it.
fn real_directory(directory: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(true),
        Ok(_) => Err(io::Error::from(io::ErrorKind::InvalidInput)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// Creates the logger's directory when it is missing and requires it to be a
/// real directory.
fn prepare_directory(directory: &Path) -> io::Result<()> {
    fs::create_dir_all(directory)?;
    if real_directory(directory)? {
        Ok(())
    } else {
        Err(io::Error::from(io::ErrorKind::NotFound))
    }
}

/// The regular files directly inside `directory` whose names match the pattern.
/// Never recursive; directories, symlinks and other names are not listed.
fn scan_segments(directory: &Path) -> io::Result<Vec<Segment>> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut segments = Vec::new();
    for entry in entries {
        let name = entry?.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some((started_at_ms, sequence)) = parse_segment_file_name(name) else {
            continue;
        };
        let Ok(metadata) = fs::symlink_metadata(directory.join(name)) else {
            continue;
        };
        if metadata.file_type().is_file() {
            segments.push(Segment {
                name: name.to_owned(),
                started_at_ms,
                sequence,
                bytes: metadata.len(),
            });
        }
    }
    Ok(segments)
}

/// What one retention pass left in the directory.
#[derive(Debug, Default, PartialEq, Eq)]
struct RetentionPass {
    /// The bytes of the segments that are still there.
    remaining_bytes: u64,
    /// Why the first segment that could not be removed stayed.
    failed_removal: Option<io::ErrorKind>,
}

/// Removes what retention names. Every caller comes through here, so the
/// directory is checked each time, not only at startup: one that was replaced by
/// a symlink while the app runs is refused, and a missing one holds nothing.
///
/// A segment that cannot be removed is skipped: the pass goes on with the rest
/// and reports the first such failure with the bytes that remain. No other
/// segment is removed in its place, so its bytes count towards the bound until
/// it can be removed.
///
/// Known limit: the check and the removal are two calls on a path, and the
/// standard library has no removal relative to an open directory. A directory
/// replaced between the last check and the removal that follows it is not seen.
/// The check is repeated before each removal to keep that window to one call.
/// The creation of a segment has the same window: `Segments::open` checks the
/// directory and then creates the file by path, so a directory replaced by a
/// symlink between the two gets a new `.partial` file in the folder behind the
/// link. Nothing there is overwritten (`create_new`), and the next batch or
/// housekeeping pass finds the link and gives that segment up.
fn apply_retention(
    directory: &Path,
    now_ms: u64,
    room_for_new_segment: bool,
) -> io::Result<RetentionPass> {
    let mut pass = RetentionPass::default();
    if !real_directory(directory)? {
        return Ok(pass);
    }
    let segments = scan_segments(directory)?;
    pass.remaining_bytes = segments
        .iter()
        .fold(0u64, |total, segment| total.saturating_add(segment.bytes));
    for name in retention_removals(&segments, now_ms, room_for_new_segment) {
        if !real_directory(directory)? {
            return Ok(RetentionPass::default());
        }
        // `remove_file` removes one name: never a directory, never a link's target.
        match fs::remove_file(directory.join(&name)) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => {
                pass.failed_removal.get_or_insert(error.kind());
            }
            _ => {
                let removed = segments
                    .iter()
                    .find(|segment| segment.name == name)
                    .map_or(0, |segment| segment.bytes);
                pass.remaining_bytes = pass.remaining_bytes.saturating_sub(removed);
            }
        }
    }
    Ok(pass)
}

struct ActiveSegment {
    file: File,
    name: String,
    started_at_ms: u64,
    sequence: u32,
    bytes: u64,
}

/// The file side of the writer thread.
struct Segments {
    /// `None`: no file output for this run.
    directory: Option<PathBuf>,
    active: Option<ActiveSegment>,
    next_sequence: u32,
    /// What the latest retention pass could not remove, if anything.
    retention_failure: Option<io::ErrorKind>,
}

impl Segments {
    /// Saves the lines in order and returns how many were saved. After an error
    /// the active segment is given up unsealed and the next call starts a new one.
    fn append(&mut self, lines: &[String], now_ms: u64) -> (usize, io::Result<()>) {
        let mut saved = 0;
        let result = self.append_counting(lines, now_ms, &mut saved);
        if result.is_err() {
            self.give_up_active();
        }
        (saved, result)
    }

    /// Gives up the active segment after a failed write, or when the directory
    /// is no longer a real one. One that nothing was saved into is removed, and
    /// only from a real directory: it is this run's own file, and left in place
    /// every failing batch would add an empty file and push out a segment that
    /// holds entries.
    fn give_up_active(&mut self) {
        let (Some(active), Some(directory)) = (self.active.take(), &self.directory) else {
            return;
        };
        if active.bytes > 0 {
            return;
        }
        drop(active.file);
        let path = directory.join(&active.name);
        if matches!(real_directory(directory), Ok(true)) && is_regular_file(&path) {
            let _ = fs::remove_file(path);
        }
    }

    fn append_counting(
        &mut self,
        lines: &[String],
        now_ms: u64,
        saved: &mut usize,
    ) -> io::Result<()> {
        let directory = self
            .directory
            .clone()
            .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
        if self.active.is_some() && !matches!(real_directory(&directory), Ok(true)) {
            // One check for each batch. The directory is gone, or something that
            // is not a real directory took its place: nothing more is written to
            // the segment. What follows opens a new one, which a symlink refuses.
            self.give_up_active();
        }
        let (missing, expired) = self.active.as_ref().map_or((false, false), |active| {
            (
                !is_regular_file(&directory.join(&active.name)),
                now_ms.saturating_sub(active.started_at_ms) >= SEGMENT_MAX_AGE_MS,
            )
        });
        if missing {
            // Removed from outside: there is nothing left to seal.
            self.active = None;
        } else if expired {
            self.seal()?;
        }
        let mut buffer = Vec::new();
        let mut buffered = 0;
        for line in lines {
            let needed = line.len() as u64 + 1;
            let full = self.active.as_ref().is_some_and(|active| {
                active.bytes + buffer.len() as u64 + needed > SEGMENT_MAX_BYTES
            });
            if full {
                self.write(&mut buffer)?;
                *saved += std::mem::take(&mut buffered);
                self.seal()?;
            }
            if self.active.is_none() {
                self.active = Some(self.open(&directory, now_ms)?);
            }
            buffer.extend_from_slice(line.as_bytes());
            buffer.push(b'\n');
            buffered += 1;
        }
        self.write(&mut buffer)?;
        *saved += buffered;
        Ok(())
    }

    fn write(&mut self, buffer: &mut Vec<u8>) -> io::Result<()> {
        if let Some(active) = &mut self.active {
            active.file.write_all(buffer)?;
            active.bytes += buffer.len() as u64;
        }
        buffer.clear();
        Ok(())
    }

    /// Makes room by retention, then creates a new `.partial` segment. An
    /// existing file is never reopened or appended to.
    fn open(&mut self, directory: &Path, now_ms: u64) -> io::Result<ActiveSegment> {
        // A start that does not fit the name would leave a file that retention
        // does not recognise, and neither bound would ever apply to it.
        if now_ms >= 10u64.pow(SEGMENT_START_DIGITS as u32) {
            return Err(io::Error::from(io::ErrorKind::InvalidData));
        }
        prepare_directory(directory)?;
        let pass = apply_retention(directory, now_ms, true)?;
        self.retention_failure = pass.failed_removal;
        if let Some(kind) = pass.failed_removal {
            // A segment that could not be removed refuses a new one only when
            // what remains leaves no room for a full segment under the bound.
            if pass.remaining_bytes > RETENTION_MAX_BYTES - SEGMENT_MAX_BYTES {
                return Err(io::Error::from(kind));
            }
        }
        let limit = 10u32.pow(SEGMENT_SEQUENCE_DIGITS as u32);
        for _ in 0..limit {
            let sequence = self.next_sequence;
            self.next_sequence = (sequence + 1) % limit;
            let name = segment_file_name(now_ms, sequence, false);
            if is_regular_file(&directory.join(segment_file_name(now_ms, sequence, true))) {
                continue;
            }
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(directory.join(&name))
            {
                Ok(file) => {
                    return Ok(ActiveSegment {
                        file,
                        name,
                        started_at_ms: now_ms,
                        sequence,
                        bytes: 0,
                    })
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::from(io::ErrorKind::AlreadyExists))
    }

    /// Completes the active segment: its data is synced and it loses `.partial`.
    fn seal(&mut self) -> io::Result<()> {
        let (Some(active), Some(directory)) = (self.active.take(), &self.directory) else {
            return Ok(());
        };
        active.file.sync_all()?;
        drop(active.file);
        real_directory(directory)?;
        fs::rename(
            directory.join(&active.name),
            directory.join(segment_file_name(
                active.started_at_ms,
                active.sequence,
                true,
            )),
        )
    }

    /// Rotation by age and retention between writes, so that both bounds hold
    /// when no segment is being opened.
    fn housekeep(&mut self, now_ms: u64) -> io::Result<()> {
        let Some(directory) = self.directory.clone() else {
            return Ok(());
        };
        if !matches!(real_directory(&directory), Ok(true)) {
            // Gone, or no longer a real directory: the active segment is dropped,
            // not sealed and not written again.
            self.give_up_active();
        }
        let expired = self.active.as_ref().is_some_and(|active| {
            now_ms.saturating_sub(active.started_at_ms) >= SEGMENT_MAX_AGE_MS
        });
        if expired {
            self.seal()?;
        }
        self.retention_failure = apply_retention(&directory, now_ms, false)?.failed_removal;
        Ok(())
    }
}

/// The hand-written subscriber. It keeps no span state: this crate uses no spans
/// and none is ever enabled.
struct DiagnosticLogSubscriber {
    sink: Arc<Sink>,
    allowlist: &'static [AllowedTarget],
}

impl DiagnosticLogSubscriber {
    fn source(&self, metadata: &Metadata<'_>) -> Option<(DiagnosticLogLevel, &'static str)> {
        if !metadata.is_event() {
            return None;
        }
        let level = DiagnosticLogLevel::of_event(metadata.level());
        allowed_source(self.allowlist, metadata.target(), level).map(|source| (level, source))
    }
}

impl Subscriber for DiagnosticLogSubscriber {
    /// `never` is cached by the call site, which then costs one atomic load.
    /// `sometimes` keeps the threshold live: `enabled` is asked for every event.
    fn register_callsite(&self, metadata: &'static Metadata<'static>) -> Interest {
        if self.source(metadata).is_some() {
            Interest::sometimes()
        } else {
            Interest::never()
        }
    }

    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        self.source(metadata)
            .is_some_and(|(level, _)| level <= self.sink.level())
    }

    /// The most detailed level any allowlisted target admits. Without it the
    /// process-wide maximum would rise to trace, and every `tracing` macro of
    /// every crate in the process would get past its level gate and register
    /// its call site, to be refused here. The hint is fixed by the allowlist and
    /// does not follow the threshold, which `enabled` reads for every event.
    fn max_level_hint(&self) -> Option<LevelFilter> {
        let most_detailed = self
            .allowlist
            .iter()
            .map(|allowed| allowed.most_detailed)
            .max();
        Some(match most_detailed {
            None => LevelFilter::OFF,
            Some(DiagnosticLogLevel::Error) => LevelFilter::ERROR,
            Some(DiagnosticLogLevel::Warn) => LevelFilter::WARN,
            Some(DiagnosticLogLevel::Info) => LevelFilter::INFO,
            Some(DiagnosticLogLevel::Debug) => LevelFilter::DEBUG,
            Some(DiagnosticLogLevel::Trace) => LevelFilter::TRACE,
        })
    }

    fn new_span(&self, _attributes: &span::Attributes<'_>) -> span::Id {
        span::Id::from_u64(1)
    }

    fn record(&self, _span: &span::Id, _values: &span::Record<'_>) {}

    fn record_follows_from(&self, _span: &span::Id, _follows: &span::Id) {}

    fn event(&self, event: &Event<'_>) {
        let metadata = event.metadata();
        let Some((level, source)) = self.source(metadata) else {
            return;
        };
        let mut message = BoundedMessage::default();
        event.record(&mut message);
        self.sink
            .submit_native(level, source, metadata.line(), &message);
    }

    fn enter(&self, _span: &span::Id) {}

    fn exit(&self, _span: &span::Id) {}
}

fn system_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

static PROCESS_SINK: OnceLock<Arc<Sink>> = OnceLock::new();

fn process_sink() -> &'static Arc<Sink> {
    PROCESS_SINK.get_or_init(|| {
        Arc::new(Sink::new(
            Box::new(system_now_ms),
            Box::new(io::stderr()),
            HOUSEKEEPING_INTERVAL,
        ))
    })
}

/// Starts the sink once at app startup and installs its subscriber as the global
/// `tracing` default. A directory that cannot be created leaves the sink failed
/// and the app starting normally.
pub fn start(app_data_dir: Option<PathBuf>) {
    let sink = process_sink();
    if sink.start(app_data_dir.map(|directory| directory.join(DIRECTORY_NAME))) {
        let _ = tracing::dispatcher::set_global_default(tracing::Dispatch::new(
            DiagnosticLogSubscriber {
                sink: Arc::clone(sink),
                allowlist: NATIVE_ALLOWLIST,
            },
        ));
    }
}

/// Best effort, for the app exit path only: waits at most `EXIT_FLUSH_BOUND`.
pub fn flush_at_exit() {
    process_sink().close(EXIT_FLUSH_BOUND);
}

/// The level of every call becomes the native effective threshold; an apply is a
/// call with an empty batch. The command fails only for an invalid level value,
/// and then nothing is applied. Entries arrive as untyped values so that one
/// malformed entry can never fail the batch.
#[tauri::command]
pub fn write_diagnostic_log(
    level: String,
    entries: Option<Value>,
) -> Result<DiagnosticLogReceipt, String> {
    process_sink().receive(&level, entries.as_ref())
}

#[cfg(test)]
#[path = "diagnostic_log_tests.rs"]
pub(crate) mod tests;
