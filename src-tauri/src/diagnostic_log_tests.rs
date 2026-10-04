//! Tests of the ordinary diagnostic log (Task 178 LG). The acceptance ids LG1,
//! LG4, LG5, LG6 and LG8 are in the test names.
//!
//! A test builds its own sink in a temporary directory, with a clock the test
//! sets and a terminal that records what would go to stderr. The writer's idle
//! wait is the app's five minutes, except in the two tests that are about an
//! idle writer, which give it 5 ms. The two tests that
//! call the command itself also reach the process-wide sink, which is never
//! started in the test process; they hold `ProcessWideCommand`. A subscriber is
//! only ever installed as the default of the calling test thread: the
//! process-wide subscriber belongs to the app's startup and is never installed
//! in the test process.

use super::*;
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use uuid::Uuid;

/// Fixed clock of the tests: 2026-09-21T14:13:20Z.
const TEST_NOW_MS: u64 = 1_790_000_000_000;
const MINUTE_MS: u64 = 60 * 1_000;
const HOUR_MS: u64 = 60 * MINUTE_MS;
const DAY_MS: u64 = 24 * 60 * 60 * 1_000;
const MIB: u64 = 1024 * 1024;
const WAIT_BOUND: Duration = Duration::from_secs(30);

const LEVELS: [DiagnosticLogLevel; 5] = [
    DiagnosticLogLevel::Error,
    DiagnosticLogLevel::Warn,
    DiagnosticLogLevel::Info,
    DiagnosticLogLevel::Debug,
    DiagnosticLogLevel::Trace,
];

/// A target that exists only in these tests, admitted at every level, so that
/// the threshold can be exercised on native events of all five levels.
const TEST_TARGET: &str = "jarvis_lib::diagnostic_log::tests::admitted";
const TEST_ALLOWLIST: &[AllowedTarget] = &[AllowedTarget {
    target: TEST_TARGET,
    source: "native.test",
    most_detailed: DiagnosticLogLevel::Trace,
}];

fn wire(level: DiagnosticLogLevel) -> &'static str {
    match level {
        DiagnosticLogLevel::Error => "error",
        DiagnosticLogLevel::Warn => "warn",
        DiagnosticLogLevel::Info => "info",
        DiagnosticLogLevel::Debug => "debug",
        DiagnosticLogLevel::Trace => "trace",
    }
}

fn entry(level: &str, event: &str) -> Value {
    json!({ "v": 1, "at": TEST_NOW_MS + 123, "level": level, "source": "meeting.test", "event": event })
}

fn with(mut entry: Value, key: &str, value: Value) -> Value {
    entry[key] = value;
    entry
}

fn without(mut entry: Value, key: &str) -> Value {
    entry.as_object_mut().unwrap().remove(key);
    entry
}

/// An entry of exactly `bytes` serialised bytes, built from fields that are each
/// within their own bound.
fn entry_of_bytes(level: &str, event: &str, bytes: usize) -> Value {
    let mut entry = with(entry(level, event), "message", json!("m".repeat(256)));
    let mut data = Map::new();
    for index in 0..8 {
        data.insert(format!("k{index}"), json!(""));
    }
    entry["data"] = Value::Object(data);
    let mut missing = bytes - serde_json::to_string(&entry).unwrap().len();
    for index in 0..8 {
        let take = missing.min(MAX_DATA_STRING_CHARS);
        entry["data"][format!("k{index}")] = json!("d".repeat(take));
        missing -= take;
    }
    assert_eq!(serde_json::to_string(&entry).unwrap().len(), bytes);
    entry
}

fn emit_admitted(level: DiagnosticLogLevel) {
    match level {
        DiagnosticLogLevel::Error => tracing::error!(target: TEST_TARGET, "native event"),
        DiagnosticLogLevel::Warn => tracing::warn!(target: TEST_TARGET, "native event"),
        DiagnosticLogLevel::Info => tracing::info!(target: TEST_TARGET, "native event"),
        DiagnosticLogLevel::Debug => tracing::debug!(target: TEST_TARGET, "native event"),
        DiagnosticLogLevel::Trace => tracing::trace!(target: TEST_TARGET, "native event"),
    }
}

fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + WAIT_BOUND;
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting until {what}");
        std::thread::sleep(Duration::from_millis(1));
    }
}

/// Relative path to kind of everything under `root`, without following symlinks.
fn tree(root: &Path) -> BTreeMap<String, String> {
    fn walk(root: &Path, directory: &Path, found: &mut BTreeMap<String, String>) {
        for item in fs::read_dir(directory).unwrap() {
            let path = item.unwrap().path();
            let name = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            let metadata = fs::symlink_metadata(&path).unwrap();
            if metadata.file_type().is_symlink() {
                found.insert(name, "symlink".into());
            } else if metadata.is_dir() {
                found.insert(name, "directory".into());
                walk(root, &path, found);
            } else {
                found.insert(name, format!("file of {} bytes", metadata.len()));
            }
        }
    }
    let mut found = BTreeMap::new();
    walk(root, root, &mut found);
    found
}

#[derive(Clone, Default)]
struct Recorder(Arc<Mutex<Vec<u8>>>);

impl Write for Recorder {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// The clock of a test sink. It can park the writer thread inside the clock, or
/// fail on it, which are the two ways a test reaches the writer without any
/// switch in the product code.
struct TestClock {
    now_ms: AtomicU64,
    hold_writer: AtomicBool,
    /// Set while the writer thread is held inside the clock.
    writer_held: AtomicBool,
    fail_writer: AtomicBool,
}

impl TestClock {
    fn read(&self) -> u64 {
        if std::thread::current().name() == Some(WRITER_THREAD_NAME) {
            if self.fail_writer.load(Ordering::SeqCst) {
                panic!("test clock failure on the writer thread");
            }
            while self.hold_writer.load(Ordering::SeqCst) {
                self.writer_held.store(true, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(1));
            }
            self.writer_held.store(false, Ordering::SeqCst);
        }
        self.now_ms.load(Ordering::SeqCst)
    }
}

/// A real sink over a temporary stand-in for the app data directory.
pub(crate) struct TestSink {
    sink: Arc<Sink>,
    clock: Arc<TestClock>,
    terminal: Recorder,
    root: PathBuf,
}

impl TestSink {
    /// With the idle wait of the app, which no test lives long enough to see end.
    fn new(label: &str) -> Self {
        Self::with_idle_wait(label, HOUSEKEEPING_INTERVAL)
    }

    /// With a writer that ends its idle wait after `idle_wait`.
    fn with_idle_wait(label: &str, idle_wait: Duration) -> Self {
        let root =
            std::env::temp_dir().join(format!("jarvis-diagnostic-log-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let clock = Arc::new(TestClock {
            now_ms: AtomicU64::new(TEST_NOW_MS),
            hold_writer: AtomicBool::new(false),
            writer_held: AtomicBool::new(false),
            fail_writer: AtomicBool::new(false),
        });
        let terminal = Recorder::default();
        let reader = Arc::clone(&clock);
        let sink = Arc::new(Sink::new(
            Box::new(move || reader.read()),
            Box::new(terminal.clone()),
            idle_wait,
        ));
        Self {
            sink,
            clock,
            terminal,
            root,
        }
    }

    pub(crate) fn started(label: &str) -> Self {
        let log = Self::new(label);
        assert!(log.sink.start(Some(log.directory())));
        assert_eq!(log.sink.state(), DiagnosticLogSinkState::Ready);
        log
    }

    fn directory(&self) -> PathBuf {
        self.root.join(DIRECTORY_NAME)
    }

    fn set_now(&self, now_ms: u64) {
        self.clock.now_ms.store(now_ms, Ordering::SeqCst);
    }

    /// The file side of a writer over this sink's directory, driven by the test
    /// itself with no writer thread.
    fn segments(&self) -> Segments {
        Segments {
            directory: Some(self.directory()),
            active: None,
            next_sequence: 0,
            retention_failure: None,
        }
    }

    fn send(&self, level: &str, entries: Vec<Value>) -> DiagnosticLogReceipt {
        self.sink
            .receive(level, Some(&Value::Array(entries)))
            .unwrap()
    }

    /// An apply: a call with an empty batch.
    pub(crate) fn apply(&self, level: &str) -> DiagnosticLogReceipt {
        self.sink.receive(level, None).unwrap()
    }

    /// The sink's own subscriber over the production allowlist.
    pub(crate) fn dispatch(&self) -> tracing::Dispatch {
        self.dispatch_over(NATIVE_ALLOWLIST)
    }

    fn dispatch_over(&self, allowlist: &'static [AllowedTarget]) -> tracing::Dispatch {
        tracing::Dispatch::new(DiagnosticLogSubscriber {
            sink: Arc::clone(&self.sink),
            allowlist,
        })
    }

    fn queued(&self) -> (usize, usize, usize) {
        let queue = self.sink.lock_queue();
        (queue.priority.len(), queue.detail.len(), queue.in_flight)
    }

    /// Waits until the writer has taken and saved everything that was queued.
    fn settle(&self) {
        wait_until("the writer has saved the queue", || {
            self.queued() == (0, 0, 0)
        });
    }

    /// Parks the writer thread with exactly one entry in flight and an empty queue.
    fn park_writer(&self) {
        let level = wire(self.sink.level());
        self.send(level, vec![entry("error", "priming")]);
        self.settle();
        self.clock.hold_writer.store(true, Ordering::SeqCst);
        self.send(level, vec![entry("error", "parked")]);
        wait_until("the writer is parked", || self.queued() == (0, 0, 1));
    }

    fn release_writer(&self) {
        self.clock.hold_writer.store(false, Ordering::SeqCst);
    }

    /// Saves everything and ends the writer; the outputs are then complete.
    pub(crate) fn finish(&self) {
        self.release_writer();
        self.sink.close(WAIT_BOUND);
        wait_until("the writer has ended", || {
            self.sink.lock_queue().writer != WriterPhase::Closing
        });
    }

    fn segment_names(&self) -> Vec<String> {
        let mut names: Vec<String> = scan_segments(&self.directory())
            .unwrap()
            .into_iter()
            .map(|segment| segment.name)
            .collect();
        names.sort();
        names
    }

    /// The raw content of every segment, oldest first.
    pub(crate) fn file_text(&self) -> String {
        self.segment_names()
            .iter()
            .map(|name| fs::read_to_string(self.directory().join(name)).unwrap())
            .collect()
    }

    pub(crate) fn file_lines(&self) -> Vec<Value> {
        self.file_text()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    pub(crate) fn terminal_text(&self) -> String {
        String::from_utf8(self.terminal.0.lock().unwrap().clone()).unwrap()
    }

    /// The entry lines the terminal received, parsed.
    fn terminal_entries(&self) -> Vec<Value> {
        self.terminal_text()
            .lines()
            .filter_map(|line| line.strip_prefix(TERMINAL_PREFIX))
            .filter(|line| line.starts_with('{'))
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    /// The direct lines about the sink itself.
    fn terminal_notes(&self) -> Vec<String> {
        self.terminal_text()
            .lines()
            .map(|line| line.strip_prefix(TERMINAL_PREFIX).unwrap().to_owned())
            .filter(|line| !line.starts_with('{'))
            .collect()
    }

    fn receipt(&self) -> DiagnosticLogSinkReceipt {
        self.apply(wire(self.sink.level())).sink
    }
}

impl Drop for TestSink {
    fn drop(&mut self) {
        self.finish();
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn levels_of(lines: &[Value]) -> Vec<String> {
    lines
        .iter()
        .map(|line| line["level"].as_str().unwrap().to_owned())
        .collect()
}

fn events_of(lines: &[Value]) -> Vec<String> {
    lines
        .iter()
        .map(|line| line["event"].as_str().unwrap().to_owned())
        .collect()
}

fn counts(receipt: &DiagnosticLogReceipt) -> (u64, u64, u64, u64) {
    (
        receipt.accepted,
        receipt.filtered,
        receipt.rejected,
        receipt.dropped,
    )
}

/// Held by a test while it calls the command itself. The command acts on the
/// process-wide sink, which is never started in the test process: it has no
/// writer, so it validates and counts, writes nothing, and counts every entry
/// that passes as dropped. One test at a time; leaving restores the level found
/// on entering, so the default is still the default for the next test.
struct ProcessWideCommand {
    _one_at_a_time: MutexGuard<'static, ()>,
    level_on_entry: DiagnosticLogLevel,
}

impl ProcessWideCommand {
    fn enter() -> Self {
        static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());
        Self {
            _one_at_a_time: unpoisoned(ONE_AT_A_TIME.lock()),
            level_on_entry: process_sink().level(),
        }
    }
}

impl Drop for ProcessWideCommand {
    fn drop(&mut self) {
        let _ = write_diagnostic_log(wire(self.level_on_entry).to_string(), None);
    }
}

/// Static metadata of a call site that is never emitted, to ask the subscriber
/// directly what it answers for a target, a level and a kind.
macro_rules! probe {
    ($target:expr, $level:expr, $kind:expr) => {{
        struct Site;
        impl tracing::Callsite for Site {
            fn set_interest(&self, _interest: Interest) {}
            fn metadata(&self) -> &Metadata<'_> {
                &METADATA
            }
        }
        static SITE: Site = Site;
        static METADATA: Metadata<'static> = Metadata::new(
            "probe",
            $target,
            $level,
            None,
            None,
            None,
            tracing::field::FieldSet::new(&[], tracing::callsite::Identifier(&SITE)),
            $kind,
        );
        &METADATA
    }};
}

// ---------------------------------------------------------------------------
// Wire names and the process-wide threshold (from the scaffold).
// ---------------------------------------------------------------------------

#[test]
fn the_level_and_the_receipt_serialise_to_the_frozen_wire_names() {
    for (rank, level) in LEVELS.into_iter().enumerate() {
        let name = wire(level);
        assert_eq!(serde_json::to_value(level).unwrap(), json!(name));
        assert_eq!(
            serde_json::from_value::<DiagnosticLogLevel>(json!(name)).unwrap(),
            level
        );
        assert_eq!(DiagnosticLogLevel::from_wire(name), Some(level));
        assert_eq!(DiagnosticLogLevel::from_rank(rank as u8), level);
        assert_eq!(level as usize, rank, "most severe first");
    }
    for invalid in ["", "INFO", "Info", " info", "verbose", "off", "warning"] {
        assert_eq!(DiagnosticLogLevel::from_wire(invalid), None, "{invalid:?}");
    }
    for (rank, (state, name)) in [
        (DiagnosticLogSinkState::Ready, "ready"),
        (DiagnosticLogSinkState::Degraded, "degraded"),
        (DiagnosticLogSinkState::Failed, "failed"),
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(serde_json::to_value(state).unwrap(), json!(name));
        assert_eq!(DiagnosticLogSinkState::from_rank(rank as u8), state);
    }
    let receipt = DiagnosticLogReceipt {
        v: DIAGNOSTIC_LOG_WIRE_VERSION,
        applied_level: DiagnosticLogLevel::Warn,
        accepted: 1,
        filtered: 2,
        rejected: 3,
        dropped: 4,
        sink: DiagnosticLogSinkReceipt {
            state: DiagnosticLogSinkState::Degraded,
            dropped_total: 5,
            write_failures: 6,
            unsaved_at_exit: 7,
        },
    };
    assert_eq!(
        serde_json::to_value(receipt).unwrap(),
        json!({
            "v": 1, "appliedLevel": "warn",
            "accepted": 1, "filtered": 2, "rejected": 3, "dropped": 4,
            "sink": { "state": "degraded", "droppedTotal": 5, "writeFailures": 6, "unsavedAtExit": 7 }
        })
    );
}

// One of the two tests that call the command, which acts on the process-wide
// sink. That sink is never started in the test process, so it has no writer and
// no file.
#[test]
fn lg1_the_command_applies_a_valid_level_process_wide_and_an_invalid_level_applies_nothing() {
    let _process_wide = ProcessWideCommand::enter();
    let level = || process_sink().level();
    assert_eq!(level(), DiagnosticLogLevel::Info, "default before any call");

    let malformed = || {
        Some(json!([
            Value::Null,
            42,
            "text",
            [],
            { "v": 2 }
        ]))
    };
    for invalid in ["", "INFO", "verbose"] {
        assert_eq!(
            write_diagnostic_log(invalid.to_string(), malformed()).unwrap_err(),
            INVALID_LEVEL_MESSAGE
        );
        assert_eq!(
            level(),
            DiagnosticLogLevel::Info,
            "{invalid:?} applied nothing"
        );
    }

    for empty in [None, Some(Value::Null), Some(json!([]))] {
        let applied = write_diagnostic_log("trace".to_string(), empty).unwrap();
        assert_eq!(applied.applied_level, DiagnosticLogLevel::Trace);
        assert_eq!(level(), DiagnosticLogLevel::Trace);
        assert_eq!(counts(&applied), (0, 0, 0, 0), "an apply is an empty batch");
    }

    let receipt = write_diagnostic_log("warn".to_string(), malformed()).unwrap();
    assert_eq!(receipt.v, 1);
    assert_eq!(receipt.applied_level, DiagnosticLogLevel::Warn);
    assert_eq!(level(), DiagnosticLogLevel::Warn);
    assert_eq!(
        counts(&receipt),
        (0, 0, 5, 0),
        "one malformed entry never fails the batch"
    );

    // Without a writer nothing can be saved, and the receipt says so.
    let unstarted = write_diagnostic_log(
        "warn".to_string(),
        Some(json!([entry("error", "before-start")])),
    )
    .unwrap();
    assert_eq!(counts(&unstarted), (0, 0, 0, 1));
    assert_eq!(unstarted.sink.state, DiagnosticLogSinkState::Failed);
    assert!(unstarted.sink.dropped_total >= 1);

    write_diagnostic_log("info".to_string(), None).unwrap();
    assert_eq!(level(), DiagnosticLogLevel::Info);
}

// ---------------------------------------------------------------------------
// LG1: levels and filtering.
// ---------------------------------------------------------------------------

#[test]
fn lg1_frontend_entries_pass_exactly_the_25_level_by_threshold_combinations() {
    for threshold in LEVELS {
        let log = TestSink::started("lg1-frontend");
        let batch = LEVELS
            .iter()
            .map(|level| entry(wire(*level), "threshold-table"))
            .collect();
        let receipt = log.send(wire(threshold), batch);
        let passing = threshold as u64 + 1;
        assert_eq!(receipt.applied_level, threshold);
        assert_eq!(counts(&receipt), (passing, 5 - passing, 0, 0));

        log.finish();
        let expected: Vec<&str> = LEVELS
            .iter()
            .filter(|level| **level <= threshold)
            .map(|level| wire(*level))
            .collect();
        assert_eq!(levels_of(&log.file_lines()), expected, "{threshold:?}");
        assert_eq!(
            levels_of(&log.terminal_entries()),
            expected,
            "{threshold:?}"
        );
    }
}

#[test]
fn lg1_tracing_events_pass_exactly_the_25_level_by_threshold_combinations() {
    for threshold in LEVELS {
        let log = TestSink::started("lg1-native");
        assert_eq!(log.apply(wire(threshold)).applied_level, threshold);
        tracing::dispatcher::with_default(&log.dispatch_over(TEST_ALLOWLIST), || {
            for level in LEVELS {
                emit_admitted(level);
            }
        });

        log.finish();
        let expected: Vec<&str> = LEVELS
            .iter()
            .filter(|level| **level <= threshold)
            .map(|level| wire(*level))
            .collect();
        let lines = log.file_lines();
        assert_eq!(levels_of(&lines), expected, "{threshold:?}");
        assert_eq!(
            levels_of(&log.terminal_entries()),
            expected,
            "{threshold:?}"
        );
        for line in lines {
            let level = line["level"].clone();
            let number = line["data"]["line"].clone();
            assert!(number.as_u64().is_some_and(|number| number > 0));
            assert_eq!(
                line,
                json!({
                    "v": 1, "at": TEST_NOW_MS, "level": level,
                    "source": "native.test", "event": "tracing",
                    "message": "native event", "data": { "line": number },
                    "origin": "native"
                })
            );
        }
    }
}

#[test]
fn lg1_the_default_threshold_is_info_and_a_change_reaches_native_events_at_once() {
    let log = TestSink::started("lg1-default");
    assert_eq!(log.sink.level(), DiagnosticLogLevel::Info);

    tracing::dispatcher::with_default(&log.dispatch_over(TEST_ALLOWLIST), || {
        // Before any call: info.
        for level in LEVELS {
            emit_admitted(level);
        }
        // An invalid level fails the call and applies nothing, entries included.
        for invalid in ["", "INFO", "verbose", "off"] {
            let batch = json!([entry("error", "invalid-level-call")]);
            assert_eq!(
                log.sink.receive(invalid, Some(&batch)).unwrap_err(),
                INVALID_LEVEL_MESSAGE
            );
            assert_eq!(log.sink.level(), DiagnosticLogLevel::Info);
        }
        // The same subscriber and the same call sites follow each apply.
        assert_eq!(log.apply("error").applied_level, DiagnosticLogLevel::Error);
        emit_admitted(DiagnosticLogLevel::Warn);
        assert_eq!(log.apply("trace").applied_level, DiagnosticLogLevel::Trace);
        emit_admitted(DiagnosticLogLevel::Trace);
    });
    for level in LEVELS {
        let receipt = log.apply(wire(level));
        assert_eq!((receipt.v, receipt.applied_level), (1, level));
        assert_eq!(counts(&receipt), (0, 0, 0, 0));
        assert_eq!(receipt.sink.state, DiagnosticLogSinkState::Ready);
    }

    log.finish();
    assert_eq!(
        levels_of(&log.file_lines()),
        ["error", "warn", "info", "trace"]
    );
}

#[test]
fn lg1_only_the_allowlisted_native_call_sites_are_live() {
    use tracing::metadata::Kind;
    use tracing::Level;
    const COMMANDS: &str = "jarvis_lib::speaker::commands";

    // The one reviewed target is the module path of speaker/commands.rs.
    assert_eq!(
        std::any::type_name::<crate::speaker::NativeCaptureControl>(),
        "jarvis_lib::speaker::commands::NativeCaptureControl"
    );
    assert_eq!(NATIVE_ALLOWLIST.len(), 1);
    assert_eq!(NATIVE_ALLOWLIST[0].target, COMMANDS);
    assert_eq!(NATIVE_ALLOWLIST[0].most_detailed, DiagnosticLogLevel::Error);

    let log = TestSink::started("lg1-allowlist");
    log.apply("trace");
    let subscriber = DiagnosticLogSubscriber {
        sink: Arc::clone(&log.sink),
        allowlist: NATIVE_ALLOWLIST,
    };
    let live = probe!(COMMANDS, Level::ERROR, Kind::EVENT);
    assert!(subscriber.register_callsite(live).is_sometimes());
    assert!(subscriber.enabled(live));
    for (label, refused) in [
        ("ungraded warn", probe!(COMMANDS, Level::WARN, Kind::EVENT)),
        ("info receipt", probe!(COMMANDS, Level::INFO, Kind::EVENT)),
        ("debug", probe!(COMMANDS, Level::DEBUG, Kind::EVENT)),
        ("trace", probe!(COMMANDS, Level::TRACE, Kind::EVENT)),
        ("span", probe!(COMMANDS, Level::ERROR, Kind::SPAN)),
        (
            "test module of the target",
            probe!(
                "jarvis_lib::speaker::commands::tests",
                Level::ERROR,
                Kind::EVENT
            ),
        ),
        (
            "prefix of the target",
            probe!("jarvis_lib::speaker", Level::ERROR, Kind::EVENT),
        ),
        (
            "CoreAudio callback module",
            probe!("jarvis_lib::speaker::macos", Level::ERROR, Kind::EVENT),
        ),
        (
            "Windows capture thread",
            probe!("jarvis_lib::speaker::windows", Level::ERROR, Kind::EVENT),
        ),
        (
            "Linux capture thread",
            probe!("jarvis_lib::speaker::linux", Level::ERROR, Kind::EVENT),
        ),
        (
            "Native Stall Diagnostics",
            probe!(
                "jarvis_lib::native_stall_diagnostics",
                Level::ERROR,
                Kind::EVENT
            ),
        ),
        ("sqlx", probe!("sqlx::query", Level::ERROR, Kind::EVENT)),
        (
            "h2",
            probe!("h2::codec::framed_read", Level::ERROR, Kind::EVENT),
        ),
        (
            "hyper-util",
            probe!(
                "hyper_util::client::legacy::pool",
                Level::ERROR,
                Kind::EVENT
            ),
        ),
    ] {
        assert!(subscriber.register_callsite(refused).is_never(), "{label}");
        assert!(!subscriber.enabled(refused), "{label}");
    }

    tracing::dispatcher::with_default(&log.dispatch(), || {
        tracing::error!(target: "jarvis_lib::speaker::commands", "admitted error");
        tracing::warn!(target: "jarvis_lib::speaker::commands", "refused: not graded yet");
        tracing::info!(target: "jarvis_lib::speaker::commands", "[native-audio-observation] refused");
        tracing::debug!(target: "jarvis_lib::speaker::commands", "refused");
        tracing::error!(target: "jarvis_lib::speaker::macos", "refused");
        tracing::error!(target: "jarvis_lib::speaker::windows", "refused");
        tracing::error!(target: "jarvis_lib::speaker::linux", "refused");
        tracing::error!(target: "sqlx::query", "refused");
        tracing::error!("refused: the default target of this module");
    });

    log.finish();
    let lines = log.file_lines();
    assert_eq!(
        lines
            .iter()
            .map(|line| (
                line["source"].as_str().unwrap(),
                line["message"].as_str().unwrap()
            ))
            .collect::<Vec<_>>(),
        [("native.speaker.commands", "admitted error")]
    );
    assert!(!log.file_text().contains("refused"));
    assert!(!log.terminal_text().contains("refused"));
}

// Without the hint, installing the subscriber raises the process-wide maximum of
// `tracing` from off to trace, and every macro of every crate passes its level
// gate to be refused by the subscriber.
#[test]
fn lg1_the_subscriber_caps_the_process_wide_level_at_what_its_allowlist_admits() {
    let log = TestSink::started("lg1-level-hint");
    let hint = |allowlist: &'static [AllowedTarget]| {
        DiagnosticLogSubscriber {
            sink: Arc::clone(&log.sink),
            allowlist,
        }
        .max_level_hint()
    };
    // Production: errors only, so warn, info, debug and trace macros anywhere in
    // the process stay behind their level gate as they did before.
    assert_eq!(hint(NATIVE_ALLOWLIST), Some(LevelFilter::ERROR));
    assert_eq!(hint(TEST_ALLOWLIST), Some(LevelFilter::TRACE));
    assert_eq!(hint(&[]), Some(LevelFilter::OFF));
    const MIXED: &[AllowedTarget] = &[
        AllowedTarget {
            target: "a",
            source: "a",
            most_detailed: DiagnosticLogLevel::Warn,
        },
        AllowedTarget {
            target: "b",
            source: "b",
            most_detailed: DiagnosticLogLevel::Debug,
        },
        AllowedTarget {
            target: "c",
            source: "c",
            most_detailed: DiagnosticLogLevel::Info,
        },
    ];
    assert_eq!(hint(MIXED), Some(LevelFilter::DEBUG));
    // The hint follows the allowlist, not the threshold: a threshold change
    // needs no rebuild of the call site cache.
    for level in LEVELS {
        log.apply(wire(level));
        assert_eq!(hint(NATIVE_ALLOWLIST), Some(LevelFilter::ERROR));
        assert_eq!(hint(TEST_ALLOWLIST), Some(LevelFilter::TRACE));
    }
}

// The allowlist admits the `error!` call sites of a whole module. This pins the
// ones that were reviewed for the thread they run on and for what they format,
// so that a new one is reviewed too before it becomes live.
#[test]
fn lg1_the_allowlisted_module_holds_exactly_the_reviewed_call_sites() {
    let source = include_str!("speaker/commands.rs");
    let (production, _tests) = source
        .split_once("\n#[cfg(test)]\n")
        .expect("the first test module marker separates production from tests");
    let count = |needle: &str| production.matches(needle).count();
    assert_eq!(
        count("error!("),
        8,
        "review the thread and the fields of the new call site, then update this count"
    );
    // Never live, whatever the threshold.
    assert_eq!(
        (
            count("warn!("),
            count("info!("),
            count("debug!("),
            count("trace!(")
        ),
        (8, 2, 0, 0)
    );
}

// The level is read first. An entry below the threshold is counted as filtered
// whatever else it holds: nothing more of it is validated.
#[test]
fn lg1_a_malformed_entry_below_the_threshold_is_filtered_and_not_validated_further() {
    let log = TestSink::started("lg1-filtered-first");
    let malformed = |level: &str| {
        json!({
            "v": 2, "level": level, "source": "NOT A TAG", "event": 7,
            "unknown": { "nested": [1, 2] }
        })
    };
    let receipt = log.send(
        "warn",
        vec![
            malformed("info"),
            malformed("debug"),
            malformed("trace"),
            json!({ "level": "debug" }),
            entry("info", "well-formed-below"),
            // At the threshold or above it the same entry is validated, and refused.
            malformed("warn"),
            malformed("error"),
            // Without a level there is nothing to filter by.
            json!({ "v": 1, "at": TEST_NOW_MS, "source": "meeting.test", "event": "no-level" }),
            entry("error", "kept"),
        ],
    );
    assert_eq!(counts(&receipt), (1, 5, 3, 0));
    log.finish();
    assert_eq!(events_of(&log.file_lines()), ["kept"]);
}

// ---------------------------------------------------------------------------
// LG4: privacy and bounds.
// ---------------------------------------------------------------------------

#[test]
fn lg4_every_bound_is_enforced_per_entry_and_never_fails_the_batch() {
    let base = || entry("info", "bound");
    let data = |pairs: Vec<(String, Value)>| {
        with(base(), "data", Value::Object(pairs.into_iter().collect()))
    };
    let keys = |count: usize| {
        data(
            (0..count)
                .map(|index| (format!("key{index:02}"), json!(index)))
                .collect(),
        )
    };
    let all_refs = |chars: usize| {
        let value = "r".repeat(chars);
        with(
            base(),
            "refs",
            json!({
                "runtimeSessionId": value, "recordingSessionId": value, "traceId": value,
                "operationId": value, "requestId": value
            }),
        )
    };
    let cases: Vec<(&str, Value, bool)> = vec![
        ("minimal entry", base(), true),
        (
            "source of 48",
            with(base(), "source", json!("s".repeat(48))),
            true,
        ),
        (
            "source of 49",
            with(base(), "source", json!("s".repeat(49))),
            false,
        ),
        ("empty source", with(base(), "source", json!("")), false),
        (
            "source in upper case",
            with(base(), "source", json!("Meeting")),
            false,
        ),
        (
            "source with an underscore",
            with(base(), "source", json!("meeting_test")),
            false,
        ),
        (
            "source with a path",
            with(base(), "source", json!("/users/someone")),
            false,
        ),
        (
            "source that is a number",
            with(base(), "source", json!(7)),
            false,
        ),
        ("missing source", without(base(), "source"), false),
        (
            "event of 64",
            with(base(), "event", json!("e".repeat(64))),
            true,
        ),
        (
            "event of 65",
            with(base(), "event", json!("e".repeat(65))),
            false,
        ),
        ("empty event", with(base(), "event", json!("")), false),
        (
            "event with a space",
            with(base(), "event", json!("start failed")),
            false,
        ),
        (
            "event with digits, dot and dash",
            with(base(), "event", json!("a-1.b")),
            true,
        ),
        ("missing event", without(base(), "event"), false),
        (
            "message of 256",
            with(base(), "message", json!("m".repeat(256))),
            true,
        ),
        (
            "message of 257",
            with(base(), "message", json!("m".repeat(257))),
            false,
        ),
        (
            "message of 256 wide characters",
            with(base(), "message", json!("界".repeat(256))),
            true,
        ),
        (
            "message of 257 wide characters",
            with(base(), "message", json!("界".repeat(257))),
            false,
        ),
        (
            "message with a line break",
            with(base(), "message", json!("one\ntwo")),
            true,
        ),
        (
            "message that is null",
            with(base(), "message", Value::Null),
            false,
        ),
        (
            "message that is an object",
            with(base(), "message", json!({ "text": "m" })),
            false,
        ),
        ("every ref at 128", all_refs(128), true),
        (
            "a ref of 129",
            with(base(), "refs", json!({ "traceId": "r".repeat(129) })),
            false,
        ),
        (
            "an unknown ref key",
            with(base(), "refs", json!({ "sessionId": "s" })),
            false,
        ),
        (
            "a ref that is a number",
            with(base(), "refs", json!({ "traceId": 7 })),
            false,
        ),
        (
            "refs that is an array",
            with(base(), "refs", json!(["trace"])),
            false,
        ),
        ("empty refs", with(base(), "refs", json!({})), true),
        ("data of 16 keys", keys(16), true),
        ("data of 17 keys", keys(17), false),
        (
            "data key of 48",
            data(vec![("k".repeat(48), json!(1))]),
            true,
        ),
        (
            "data key of 49",
            data(vec![("k".repeat(49), json!(1))]),
            false,
        ),
        (
            "empty data key",
            data(vec![(String::new(), json!(1))]),
            false,
        ),
        (
            "data key with a space",
            data(vec![("a b".into(), json!(1))]),
            false,
        ),
        (
            "data key with every allowed kind",
            data(vec![("A_z.0-9".into(), json!(1))]),
            true,
        ),
        (
            "data string of 256",
            data(vec![("k".into(), json!("d".repeat(256)))]),
            true,
        ),
        (
            "data string of 257",
            data(vec![("k".into(), json!("d".repeat(257)))]),
            false,
        ),
        (
            "data scalars",
            data(vec![
                ("int".into(), json!(-3)),
                ("float".into(), json!(0.25)),
                ("yes".into(), json!(true)),
                ("none".into(), Value::Null),
            ]),
            true,
        ),
        (
            "nested data object",
            data(vec![("k".into(), json!({ "a": 1 }))]),
            false,
        ),
        ("data array", data(vec![("k".into(), json!([1, 2]))]), false),
        (
            "data that is an array",
            with(base(), "data", json!([1])),
            false,
        ),
        ("empty data", with(base(), "data", json!({})), true),
        ("version 2", with(base(), "v", json!(2)), false),
        ("version as text", with(base(), "v", json!("1")), false),
        ("version 1.5", with(base(), "v", json!(1.5)), false),
        ("missing version", without(base(), "v"), false),
        ("missing time", without(base(), "at"), false),
        ("time as text", with(base(), "at", json!("now")), false),
        ("negative time", with(base(), "at", json!(-1)), false),
        ("fractional time", with(base(), "at", json!(1.5)), true),
        ("missing level", without(base(), "level"), false),
        (
            "level in upper case",
            with(base(), "level", json!("INFO")),
            false,
        ),
        (
            "level that is a number",
            with(base(), "level", json!(2)),
            false,
        ),
        (
            "unknown field",
            with(base(), "context", json!("extra")),
            false,
        ),
        ("null", Value::Null, false),
        ("number", json!(42), false),
        ("text", json!("text"), false),
        ("array", json!([]), false),
        ("boolean", json!(true), false),
        (
            "exactly 2,048 bytes",
            entry_of_bytes("info", "bound", MAX_ENTRY_BYTES),
            true,
        ),
        (
            "2,049 bytes",
            entry_of_bytes("info", "bound", MAX_ENTRY_BYTES + 1),
            false,
        ),
    ];
    assert!(cases.len() <= MAX_ENTRIES_PER_CALL);

    let log = TestSink::started("lg4-bounds");
    // One by one: each case decides for itself.
    for (label, case, accepted) in &cases {
        let receipt = log.send("trace", vec![case.clone()]);
        let expected = if *accepted {
            (1, 0, 0, 0)
        } else {
            (0, 0, 1, 0)
        };
        assert_eq!(counts(&receipt), expected, "{label}");
    }
    // Together: the refused ones never fail the batch or their neighbours.
    let kept: Vec<Value> = cases
        .iter()
        .filter(|(_, _, accepted)| *accepted)
        .map(|(_, case, _)| case.clone())
        .collect();
    let together = log.send(
        "trace",
        cases.iter().map(|(_, case, _)| case.clone()).collect(),
    );
    assert_eq!(
        counts(&together),
        (kept.len() as u64, 0, (cases.len() - kept.len()) as u64, 0)
    );

    // At most 64 items per call; the rest are counted as rejected.
    let many = log.send("trace", vec![entry("info", "sixty-four"); 70]);
    assert_eq!(counts(&many), (64, 0, 6, 0));
    // `entries` that is not a batch is one refused item; an absent one is an apply.
    for not_a_batch in [
        json!({ "0": entry("info", "bound") }),
        json!("entries"),
        json!(7),
    ] {
        let receipt = log.sink.receive("trace", Some(&not_a_batch)).unwrap();
        assert_eq!(counts(&receipt), (0, 0, 1, 0));
    }

    // The sink writes the validated fields and the origin, nothing else.
    log.finish();
    let expected: Vec<Value> = kept
        .iter()
        .chain(kept.iter())
        .cloned()
        .chain(std::iter::repeat_n(entry("info", "sixty-four"), 64))
        .map(|entry| with(entry, "origin", json!("frontend")))
        .collect();
    assert_eq!(log.file_lines(), expected);
    assert_eq!(log.terminal_entries(), expected);
    for line in log.file_text().lines() {
        assert!(line.ends_with(&format!("{}}}", &FRONTEND_ORIGIN_FIELD[1..])));
        assert!(line.len() <= MAX_ENTRY_BYTES + FRONTEND_ORIGIN_FIELD.len());
    }
}

/// The shared wire fixture: every call the real frontend logger makes for fixed
/// inputs. tests/diagnostic-log.test.ts writes it and fails when the logger no
/// longer produces exactly this file.
const WIRE_FIXTURE: &str = include_str!("../../tests/fixtures/diagnostic-log-wire-v1.json");

/// The names of the command's parameters, read from its declaration.
fn command_parameter_names() -> Vec<&'static str> {
    let source = include_str!("diagnostic_log.rs");
    let declaration = source
        .split_once("pub fn write_diagnostic_log(")
        .and_then(|(_, rest)| rest.split_once(')'))
        .expect("the command's declaration")
        .0;
    declaration
        .split(',')
        .filter_map(|parameter| parameter.split_once(':'))
        .map(|(name, _)| name.trim())
        .collect()
}

// Frontend entry -> IPC payload -> native sink. The real Tauri IPC round trip is
// not run: the app is not started, so Tauri's dispatch and its argument parsing
// are outside this test. What is run: the fixture holds the arguments of every
// call the real frontend logger made (one entry of each level with every
// optional field, each entry bound at its limit, a call of exactly 64 entries, a
// call whose level was lowered while its entries were queued, and what was left
// of inputs the logger refused). Each call is given, as the command's own
// argument types, to the command itself and to a real sink over a temporary
// directory. `absent` is what the refused inputs carried. `receipts` is the
// other direction: the receipt the frontend's reader took for each call in the
// Node test, which the real sink has to answer value for value.
#[test]
fn lg4_the_shared_wire_fixture_of_the_frontend_logger_passes_the_command_and_is_written_as_sent() {
    let fixture: Value = serde_json::from_str(WIRE_FIXTURE).unwrap();
    assert_eq!(fixture["v"], 1);
    // The command the fixture names is this function; a call's keys are its parameters.
    let command: fn(String, Option<Value>) -> Result<DiagnosticLogReceipt, String> =
        write_diagnostic_log;
    assert_eq!(fixture["command"], "write_diagnostic_log");
    assert_eq!(command_parameter_names(), ["level", "entries"]);

    struct Call {
        level: String,
        entries: Option<Value>,
        passing: Vec<Value>,
        filtered: u64,
    }
    let rank = |level: &Value| {
        LEVELS
            .iter()
            .position(|known| Some(wire(*known)) == level.as_str())
            .expect("one of the five levels")
    };
    let calls: Vec<Call> = fixture["calls"]
        .as_array()
        .unwrap()
        .iter()
        .map(|call| {
            let arguments = call.as_object().unwrap();
            let mut names: Vec<&str> = arguments.keys().map(String::as_str).collect();
            names.sort_unstable();
            assert_eq!(
                names,
                ["entries", "level"],
                "the arguments of a call are the command's parameters"
            );
            let sent = arguments["entries"].as_array().unwrap();
            // Written out here, not taken from the sink: an entry passes when it
            // is at least as severe as the level of its call.
            let (passing, below): (Vec<Value>, Vec<Value>) = sent
                .iter()
                .cloned()
                .partition(|entry| rank(&entry["level"]) <= rank(&arguments["level"]));
            Call {
                level: serde_json::from_value(arguments["level"].clone()).unwrap(),
                entries: serde_json::from_value(arguments["entries"].clone()).unwrap(),
                passing,
                filtered: below.len() as u64,
            }
        })
        .collect();

    // The fixture is not hollow.
    let sent: Vec<&Value> = calls
        .iter()
        .flat_map(|call| call.entries.as_ref().unwrap().as_array().unwrap())
        .collect();
    let mut levels: Vec<&str> = sent
        .iter()
        .map(|entry| entry["level"].as_str().unwrap())
        .collect();
    levels.sort_unstable();
    levels.dedup();
    assert_eq!(levels, ["debug", "error", "info", "trace", "warn"]);
    assert!(
        sent.iter().any(|entry| ["message", "refs", "data"]
            .iter()
            .all(|field| entry.get(field).is_some())),
        "one entry carries every optional field"
    );
    assert!(
        sent.iter()
            .any(|entry| serde_json::to_string(entry).unwrap().len() == MAX_ENTRY_BYTES),
        "one entry is exactly at the byte bound"
    );
    let sizes: Vec<(usize, u64)> = calls
        .iter()
        .map(|call| (call.passing.len(), call.filtered))
        .collect();
    assert!(
        sizes.contains(&(0, 0)),
        "a level apply is a call with an empty batch"
    );
    assert!(
        sizes.contains(&(MAX_ENTRIES_PER_CALL, 0)),
        "one call carries exactly the most entries a call may"
    );
    assert!(
        sizes
            .iter()
            .any(|(passing, filtered)| *passing > 0 && *filtered > 0),
        "one call carries entries below its own level"
    );

    // The command itself. Nothing is refused; with no writer in the test process
    // every entry that passes is counted as dropped and nothing is written.
    {
        let _process_wide = ProcessWideCommand::enter();
        for call in &calls {
            let receipt = command(call.level.clone(), call.entries.clone()).unwrap();
            assert_eq!(wire(receipt.applied_level), call.level);
            assert_eq!(
                counts(&receipt),
                (0, call.filtered, 0, call.passing.len() as u64)
            );
            assert_eq!(receipt.sink.state, DiagnosticLogSinkState::Failed);
        }
    }

    // The same calls through the command's body on a real sink.
    let log = TestSink::started("lg4-fixture");
    let mut expected = Vec::new();
    let receipts = fixture["receipts"].as_array().unwrap();
    assert_eq!(receipts.len(), calls.len(), "one receipt for each call");
    for (call, read_by_the_frontend) in calls.iter().zip(receipts) {
        let receipt = log
            .sink
            .receive(&call.level, call.entries.as_ref())
            .unwrap();
        assert_eq!(
            &serde_json::to_value(&receipt).unwrap(),
            read_by_the_frontend,
            "native answers the receipt the frontend's reader was tested with"
        );
        assert_eq!(wire(receipt.applied_level), call.level);
        assert_eq!(
            counts(&receipt),
            (call.passing.len() as u64, call.filtered, 0, 0),
            "native refuses nothing the frontend logger sent"
        );
        assert_eq!(
            receipt.sink,
            DiagnosticLogSinkReceipt {
                state: DiagnosticLogSinkState::Ready,
                dropped_total: 0,
                write_failures: 0,
                unsaved_at_exit: 0,
            }
        );
        expected.extend(
            call.passing
                .iter()
                .cloned()
                .map(|entry| with(entry, "origin", json!("frontend"))),
        );
    }
    log.finish();
    assert_eq!(log.file_lines(), expected);
    assert_eq!(log.terminal_entries(), expected);
    assert_eq!(log.terminal_notes(), Vec::<String>::new());

    // Nothing the frontend logger refused is in a file or on the terminal.
    let absent = fixture["absent"].as_array().unwrap();
    assert!(!absent.is_empty());
    let mut outputs = vec![("terminal".to_string(), log.terminal_text())];
    for (name, kind) in tree(&log.root) {
        if kind.starts_with("file") {
            let content = fs::read_to_string(log.root.join(&name)).unwrap();
            outputs.push((name, content));
        }
    }
    assert_eq!(outputs.len(), 2, "the terminal and one segment");
    for text in absent {
        let text = text.as_str().unwrap();
        assert!(!text.is_empty());
        for (name, content) in &outputs {
            assert!(!content.contains(text), "{name} holds {text:?}");
        }
    }
}

// Each side measures an entry on its own serialisation of it, and native prints
// some numbers longer than `JSON.stringify` wrote them. An integer outside the
// 64-bit range is read as a float and printed as one, which can be one byte
// longer. A number with a fraction or an exponent can be read one unit in the
// last place off, because serde_json is built without `float_roundtrip` here,
// and is then printed with seventeen digits: up to 17 bytes longer, and as a
// slightly different value. Whatever it read, native prints a number in at most
// 24 bytes: a sign, seventeen digits, a point and an exponent of up to five
// characters. The frontend therefore measures every data number that is not a
// safe integer as the larger of its own length and 24 bytes. A safe integer is
// printed as it was sent. The left column is what `JSON.stringify` writes.
#[test]
fn lg4_native_prints_a_number_in_at_most_24_bytes_and_a_safe_integer_as_it_was_sent() {
    const NATIVE_NUMBER_BYTES: usize = 24;
    let cases = [
        // Safe integers on the frontend: measured as sent.
        ("0", true),
        ("42", true),
        ("-17", true),
        ("1791115200000", true),
        ("9007199254740991", true),
        ("-9007199254740991", true),
        // Every other number: measured as at least 24 bytes.
        ("-17.5", false),
        ("0.125", false),
        ("0.000001", false),
        ("1e-7", false),
        ("5e-324", false),
        ("9007199254740992", false),
        ("9223372036854775000", false),
        ("-9223372036854775000", false),
        ("9223372036854776000", false),
        ("-9223372036854776000", false),
        ("18446744073709552000", false),
        ("99999999999999980000", false),
        ("-99999999999999980000", false),
        ("100000000000000000000", false),
        ("123456789012345680000", false),
        ("1e+21", false),
        ("1.5e+300", false),
        ("1e+308", false),
        ("5e-58", false),
        ("3e+50", false),
        ("1.26025383612e-31", false),
        // Already 24 bytes as sent: the longest form there is.
        ("-1.2345678901234568e-300", false),
    ];
    let mut longer_here = Vec::new();
    for (sent, safe_integer) in cases {
        let value: Value = serde_json::from_str(sent).unwrap();
        let written = serde_json::to_string(&value).unwrap();
        let measured = if safe_integer {
            assert_eq!(written, sent);
            sent.len()
        } else {
            sent.len().max(NATIVE_NUMBER_BYTES)
        };
        assert!(written.len() <= measured, "{sent} is written as {written}");
        if written.len() > sent.len() {
            longer_here.push((sent, written));
        }
    }
    assert_eq!(
        longer_here,
        [
            ("-9223372036854776000", "-9.223372036854776e18".to_string()),
            ("18446744073709552000", "1.8446744073709552e19".to_string()),
            ("5e-58", "5.0000000000000005e-58".to_string()),
            ("3e+50", "3.0000000000000002e50".to_string()),
            ("1.26025383612e-31", "1.2602538361199999e-31".to_string()),
        ]
    );

    // What it means for the entry bound. An entry of 2,048 bytes as sent is
    // refused here when native prints its number longer, so the frontend does
    // not send it whole. An entry the frontend measures at 2,048 bytes, with
    // the number counted as 24, is accepted whatever native prints for it. The
    // batch is never failed.
    let as_sent = |number: &str, bytes: usize| -> Value {
        let field = format!(r#""n":{number},"#);
        let text = serde_json::to_string(&entry_of_bytes("info", "number", bytes - field.len()))
            .unwrap()
            .replace(r#""data":{"#, &format!(r#""data":{{{field}"#));
        assert_eq!(text.len(), bytes);
        serde_json::from_str(&text).unwrap()
    };
    let measured_at_the_bound = |number: &str| {
        as_sent(
            number,
            MAX_ENTRY_BYTES - (NATIVE_NUMBER_BYTES - number.len()),
        )
    };
    let longer = [
        "18446744073709552000",
        "-9223372036854776000",
        "5e-58",
        "3e+50",
        "1.26025383612e-31",
    ];
    let log = TestSink::started("lg4-numbers");
    let whole = log.send(
        "info",
        vec![
            as_sent("42", MAX_ENTRY_BYTES),
            as_sent("9007199254740991", MAX_ENTRY_BYTES),
            as_sent("9223372036854775000", MAX_ENTRY_BYTES),
        ],
    );
    assert_eq!(counts(&whole), (3, 0, 0, 0));
    let at_the_bound_as_sent = log.send(
        "info",
        longer
            .iter()
            .map(|number| as_sent(number, MAX_ENTRY_BYTES))
            .collect(),
    );
    assert_eq!(counts(&at_the_bound_as_sent), (0, 0, 5, 0));
    let at_the_bound_as_measured = log.send(
        "info",
        longer.into_iter().map(measured_at_the_bound).collect(),
    );
    assert_eq!(counts(&at_the_bound_as_measured), (5, 0, 0, 0));
    // The value native wrote for a number it read one unit off is the one it
    // read, not the one that was sent.
    log.finish();
    let written: Vec<String> = log
        .file_text()
        .lines()
        .skip(3)
        .map(|line| {
            let after = line.split_once(r#""n":"#).unwrap().1;
            after
                .chars()
                .take_while(|character| !matches!(character, ',' | '}'))
                .collect()
        })
        .collect();
    assert_eq!(
        written,
        [
            "1.8446744073709552e19",
            "-9.223372036854776e18",
            "5.0000000000000005e-58",
            "3.0000000000000002e50",
            "1.2602538361199999e-31",
        ]
    );
}

#[test]
fn lg4_a_secret_in_a_refused_field_never_reaches_the_file_or_the_terminal_line() {
    const SECRET: &str = "sk-live-0123456789-SECRET";
    let base = |event: &str| entry("error", event);
    let refused = vec![
        with(
            base("header"),
            "authorization",
            json!(format!("Bearer {SECRET}")),
        ),
        with(
            base("headers"),
            "data",
            json!({ "headers": { "Authorization": SECRET } }),
        ),
        with(base("keys"), "data", json!({ "apiKeys": [SECRET] })),
        with(
            base("config"),
            "providerConfig",
            json!({ "apiKey": SECRET }),
        ),
        with(base("ref"), "refs", json!({ "apiKey": SECRET })),
        with(
            base("prompt"),
            "message",
            json!(format!("{}{SECRET}", "p".repeat(250))),
        ),
        with(
            base("transcript"),
            "data",
            json!({ "transcript": format!("{}{SECRET}", "t".repeat(250)) }),
        ),
        with(base("tag"), "event", json!(SECRET)),
        with(
            base("path"),
            "source",
            json!(format!("/Users/someone/{SECRET}")),
        ),
        json!(SECRET),
        json!([SECRET]),
    ];

    let log = TestSink::started("lg4-secret");
    let mut batch = vec![base("before")];
    batch.extend(refused.iter().cloned());
    batch.push(base("after"));
    let receipt = log.send("warn", batch);
    assert_eq!(counts(&receipt), (2, 0, refused.len() as u64, 0));

    // Below the threshold: counted as filtered and never serialised.
    let quiet = with(entry("debug", "quiet"), "message", json!(SECRET));
    assert_eq!(counts(&log.send("warn", vec![quiet])), (0, 1, 0, 0));

    log.finish();
    assert_eq!(events_of(&log.file_lines()), ["before", "after"]);
    assert_eq!(events_of(&log.terminal_entries()), ["before", "after"]);
    assert!(!log.terminal_text().contains("SECRET"));
    for (name, kind) in tree(&log.root) {
        if kind.starts_with("file") {
            let content = fs::read_to_string(log.root.join(&name)).unwrap();
            assert!(!content.contains("SECRET"), "{name}");
        }
    }
}

#[test]
fn lg4_a_native_event_writes_one_bounded_message_and_no_other_field() {
    const SECRET: &str = "sk-live-0123456789-SECRET";
    /// Renders far more than the bound, and counts how much was asked for.
    struct Endless<'a>(&'a AtomicUsize);
    impl fmt::Display for Endless<'_> {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            for _ in 0..100_000 {
                self.0.fetch_add(1, Ordering::SeqCst);
                formatter.write_str("0123456789")?;
            }
            Ok(())
        }
    }

    let log = TestSink::started("lg4-native");
    log.apply("trace");
    let chunks = AtomicUsize::new(0);
    tracing::dispatcher::with_default(&log.dispatch_over(TEST_ALLOWLIST), || {
        tracing::error!(
            target: TEST_TARGET,
            authorization = SECRET,
            api_key = %SECRET,
            "start failed: {}",
            "device busy"
        );
        tracing::warn!(target: TEST_TARGET, "{}", Endless(&chunks));
        tracing::warn!(target: TEST_TARGET, "{}", "\u{1}".repeat(300));
        tracing::error!(target: TEST_TARGET, attempt = 2);
    });

    log.finish();
    let text = log.file_text();
    let lines = log.file_lines();
    assert_eq!(lines.len(), 4);
    assert!(!text.contains("SECRET") && !log.terminal_text().contains("SECRET"));
    assert!(!text.contains("authorization") && !text.contains("attempt"));

    assert_eq!(lines[0]["message"], "start failed: device busy");
    assert_eq!(
        lines[0]["data"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        ["line"]
    );
    // Formatting stopped at the bound: 26 chunks of 10 characters, not 100,000.
    assert_eq!(lines[1]["message"].as_str().unwrap().chars().count(), 256);
    assert_eq!(lines[1]["data"]["truncated"], true);
    assert_eq!(chunks.load(Ordering::SeqCst), 26);
    // The worst case of escaping still fits one entry.
    assert_eq!(lines[2]["message"].as_str().unwrap().chars().count(), 256);
    for line in text.lines() {
        assert!(line.len() <= MAX_ENTRY_BYTES, "{} bytes", line.len());
    }
    assert!(lines[3].get("message").is_none());
    for line in &lines {
        let mut keys: Vec<&str> = line
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.retain(|key| {
            ![
                "v", "at", "level", "source", "event", "message", "data", "origin",
            ]
            .contains(key)
        });
        assert!(keys.is_empty(), "{keys:?}");
    }
}

// ---------------------------------------------------------------------------
// LG5: bounded queue, failures and the exit flush.
// ---------------------------------------------------------------------------

fn detail_batch(start: usize, count: usize) -> Vec<Value> {
    (start..start + count)
        .map(|index| {
            let level = if index % 2 == 0 { "debug" } else { "trace" };
            with(entry(level, "detail"), "data", json!({ "n": index }))
        })
        .collect()
}

fn priority_batch(start: usize, count: usize) -> Vec<Value> {
    (start..start + count)
        .map(|index| {
            let level = ["error", "warn", "info"][index % 3];
            with(entry(level, "priority"), "data", json!({ "n": index }))
        })
        .collect()
}

fn send_all(log: &TestSink, entries: Vec<Value>) -> (u64, u64) {
    let (mut accepted, mut dropped) = (0, 0);
    for batch in entries.chunks(MAX_ENTRIES_PER_CALL) {
        let receipt = log.send("trace", batch.to_vec());
        assert_eq!(receipt.filtered + receipt.rejected, 0);
        accepted += receipt.accepted;
        dropped += receipt.dropped;
    }
    (accepted, dropped)
}

#[test]
fn lg5_a_full_detail_lane_sheds_detail_entries_and_still_takes_priority_entries() {
    let log = TestSink::started("lg5-detail-lane");
    log.apply("trace");
    log.park_writer();

    assert_eq!(
        send_all(&log, detail_batch(0, DETAIL_LANE_CAPACITY)),
        (DETAIL_LANE_CAPACITY as u64, 0)
    );
    let shed = log.send("trace", detail_batch(DETAIL_LANE_CAPACITY, 10));
    assert_eq!(counts(&shed), (0, 0, 0, 10));
    assert_eq!(shed.sink.dropped_total, 10);
    assert_eq!(shed.sink.state, DiagnosticLogSinkState::Ready);

    let kept = log.send("trace", priority_batch(0, 6));
    assert_eq!(counts(&kept), (6, 0, 0, 0));
    assert_eq!(kept.sink.dropped_total, 10);
    assert_eq!(log.queued(), (6, DETAIL_LANE_CAPACITY, 1));

    log.finish();
    let events = events_of(&log.file_lines());
    assert_eq!(events.len(), 2 + DETAIL_LANE_CAPACITY + 6);
    assert_eq!(
        events.iter().filter(|event| *event == "detail").count(),
        DETAIL_LANE_CAPACITY
    );
    assert_eq!(log.receipt().write_failures, 0);
}

#[test]
fn lg5_a_full_queue_sheds_detail_first_then_info_then_warn_and_an_error_is_not_lossless() {
    assert_eq!(
        (PRIORITY_LANE_RESERVED, DETAIL_LANE_CAPACITY, QUEUE_CAPACITY),
        (1_024, 2_048, 3_072)
    );
    let log = TestSink::started("lg5-full-queue");
    log.apply("trace");
    log.park_writer();
    send_all(&log, detail_batch(0, DETAIL_LANE_CAPACITY));
    send_all(&log, priority_batch(0, PRIORITY_LANE_RESERVED));
    assert_eq!(
        log.queued(),
        (PRIORITY_LANE_RESERVED, DETAIL_LANE_CAPACITY, 1)
    );

    // Full: a detail entry is shed itself.
    let detail = log.send("trace", detail_batch(9_000, 1));
    assert_eq!(counts(&detail), (0, 0, 0, 1));
    assert_eq!(detail.sink.dropped_total, 1);

    // Full: a priority entry takes the place of the oldest detail entry.
    let first = log.send("trace", priority_batch(PRIORITY_LANE_RESERVED, 1));
    assert_eq!(counts(&first), (1, 0, 0, 0));
    assert_eq!(first.sink.dropped_total, 2);
    assert_eq!(
        log.queued(),
        (PRIORITY_LANE_RESERVED + 1, DETAIL_LANE_CAPACITY - 1, 1)
    );
    assert!(log
        .sink
        .lock_queue()
        .detail
        .front()
        .unwrap()
        .line
        .contains(r#""n":1}"#));

    // Until no detail entry is left.
    let rest = priority_batch(PRIORITY_LANE_RESERVED + 1, DETAIL_LANE_CAPACITY - 1);
    assert_eq!(send_all(&log, rest), (DETAIL_LANE_CAPACITY as u64 - 1, 0));
    assert_eq!(log.queued(), (QUEUE_CAPACITY, 0, 1));
    let mut shed = 1 + DETAIL_LANE_CAPACITY as u64;
    assert_eq!(log.receipt().dropped_total, shed);

    // The queue now holds error, warn and info in equal parts and no detail.
    // An error and a warn each take the place of the oldest info; an info is shed.
    let each = QUEUE_CAPACITY / 3;
    assert_eq!(log.sink.lock_queue().priority_levels, [each; 3]);
    let numbers = |log: &TestSink, level: DiagnosticLogLevel| -> Vec<u64> {
        log.sink
            .lock_queue()
            .priority
            .iter()
            .filter(|queued| queued.level == level && queued.line.contains(r#""event":"priority""#))
            .map(|queued| {
                let line: Value = serde_json::from_str(&queued.line).unwrap();
                line["data"]["n"].as_u64().unwrap()
            })
            .collect()
    };
    let preferred = log.send(
        "trace",
        vec![
            entry("error", "kept-error"),
            entry("warn", "kept-warn"),
            entry("info", "shed-info"),
        ],
    );
    assert_eq!(counts(&preferred), (2, 0, 0, 1));
    shed += 3;
    assert_eq!(preferred.sink.dropped_total, shed);
    assert_eq!(log.queued(), (QUEUE_CAPACITY, 0, 1));
    assert_eq!(
        log.sink.lock_queue().priority_levels,
        [each + 1, each + 1, each - 2]
    );
    // The two info entries that gave way were the two oldest: n = 2 and n = 5.
    assert_eq!(numbers(&log, DiagnosticLogLevel::Info)[..2], [8, 11]);
    assert_eq!(numbers(&log, DiagnosticLogLevel::Warn)[..2], [1, 4]);

    // Errors keep arriving: every info goes, oldest first, and only then a warn.
    let errors = |count: usize| vec![entry("error", "kept-error"); count];
    assert_eq!(send_all(&log, errors(each - 3)), (each as u64 - 3, 0));
    shed += each as u64 - 3;
    assert_eq!(
        log.sink.lock_queue().priority_levels,
        [2 * each - 2, each + 1, 1]
    );
    assert_eq!(
        numbers(&log, DiagnosticLogLevel::Info),
        [QUEUE_CAPACITY as u64 - 1],
        "the newest info is the last to go"
    );
    // One info is left: a warn takes its place. With no info left a warn is shed
    // itself, and an error takes the place of the oldest warn.
    let warn = log.send("trace", vec![entry("warn", "kept-warn")]);
    assert_eq!(counts(&warn), (1, 0, 0, 0));
    let warn = log.send("trace", vec![entry("warn", "shed-warn")]);
    assert_eq!(counts(&warn), (0, 0, 0, 1));
    shed += 2;
    assert_eq!(
        log.sink.lock_queue().priority_levels,
        [2 * each - 2, each + 2, 0]
    );
    assert_eq!(send_all(&log, errors(each + 2)), (each as u64 + 2, 0));
    shed += each as u64 + 2;
    assert_eq!(
        log.sink.lock_queue().priority_levels,
        [QUEUE_CAPACITY, 0, 0]
    );
    assert_eq!(log.receipt().dropped_total, shed);

    // Only errors are queued. Nothing gives way to another error: error, warn
    // and info are shed, and counted.
    let lossy = log.send(
        "trace",
        vec![
            entry("error", "shed-error"),
            entry("warn", "shed-warn"),
            entry("info", "shed-info"),
        ],
    );
    assert_eq!(counts(&lossy), (0, 0, 0, 3));
    shed += 3;
    assert_eq!(lossy.sink.dropped_total, shed);
    assert_eq!(lossy.sink.state, DiagnosticLogSinkState::Ready);

    log.finish();
    let lines = log.file_lines();
    let events = events_of(&lines);
    assert_eq!(events.len(), 2 + QUEUE_CAPACITY);
    assert!(levels_of(&lines)[2..].iter().all(|level| level == "error"));
    // What was written: the errors of the first fill in arrival order, then the
    // errors that took the place of the info and warn entries.
    assert!(events[2..2 + each].iter().all(|event| event == "priority"));
    assert!(events[2 + each..].iter().all(|event| event == "kept-error"));
    let written: Vec<u64> = lines[2..2 + each]
        .iter()
        .map(|line| line["data"]["n"].as_u64().unwrap())
        .collect();
    assert_eq!(
        written,
        (0..QUEUE_CAPACITY as u64)
            .filter(|n| n % 3 == 0)
            .collect::<Vec<_>>()
    );
    assert!(!log.file_text().contains("shed-"));
    assert_eq!(log.terminal_notes(), Vec::<String>::new());
}

// `accepted` is what of this call is queued when the call returns: an entry of
// the call that a later entry of the same call displaced is counted as dropped.
#[test]
fn lg5_an_entry_displaced_by_a_later_entry_of_its_own_call_is_counted_as_dropped() {
    let log = TestSink::started("lg5-same-call");
    log.apply("trace");
    log.park_writer();
    // One below the bound, with info entries only.
    let fill = vec![entry("info", "fill"); QUEUE_CAPACITY - 1];
    assert_eq!(send_all(&log, fill), (QUEUE_CAPACITY as u64 - 1, 0));
    assert_eq!(log.queued(), (QUEUE_CAPACITY - 1, 0, 1));

    // The debug entry fills the queue. The first error takes its place; the
    // second takes the place of the oldest info, which an earlier call queued.
    let receipt = log.send(
        "trace",
        vec![
            entry("debug", "detail-of-this-call"),
            entry("error", "first-error"),
            entry("error", "second-error"),
        ],
    );
    assert_eq!(counts(&receipt), (2, 0, 0, 1));
    assert_eq!(receipt.sink.dropped_total, 2);
    assert_eq!(log.queued(), (QUEUE_CAPACITY, 0, 1));

    log.finish();
    let events = events_of(&log.file_lines());
    assert_eq!(events.len(), 2 + QUEUE_CAPACITY);
    assert_eq!(events[events.len() - 2..], ["first-error", "second-error"]);
    assert!(!events.contains(&"detail-of-this-call".to_string()));
    assert_eq!(
        events.iter().filter(|event| *event == "fill").count(),
        QUEUE_CAPACITY - 2
    );
}

#[test]
fn lg5_entries_of_both_lanes_are_written_in_arrival_order() {
    let log = TestSink::started("lg5-order");
    log.apply("trace");
    log.park_writer();
    let order = ["info", "debug", "error", "trace", "warn", "debug"];
    for (index, level) in order.iter().enumerate() {
        log.send("trace", vec![entry(level, &format!("arrival-{index}"))]);
    }
    log.finish();
    assert_eq!(levels_of(&log.file_lines())[2..], order);
    assert_eq!(levels_of(&log.terminal_entries())[2..], order);
}

#[test]
fn lg5_one_oversize_entry_is_refused_alone() {
    let log = TestSink::started("lg5-oversize");
    let oversize = entry_of_bytes("error", "oversize", MAX_ENTRY_BYTES + 1);
    let receipt = log.send(
        "info",
        vec![entry("info", "before"), oversize, entry("info", "after")],
    );
    assert_eq!(counts(&receipt), (2, 0, 1, 0));
    assert_eq!(receipt.sink.state, DiagnosticLogSinkState::Ready);

    log.finish();
    assert_eq!(events_of(&log.file_lines()), ["before", "after"]);
    assert_eq!(log.receipt().write_failures, 0);
}

#[cfg(unix)]
#[test]
fn lg5_an_unwritable_directory_degrades_once_counts_every_failure_and_recovers() {
    use std::os::unix::fs::PermissionsExt;

    let log = TestSink::started("lg5-unwritable");
    let mode =
        |mode| fs::set_permissions(log.directory(), fs::Permissions::from_mode(mode)).unwrap();
    mode(0o500);

    let first = log.send(
        "info",
        vec![entry("error", "lost-1"), entry("warn", "lost-2")],
    );
    assert_eq!(counts(&first), (2, 0, 0, 0), "the queue took them");
    wait_until("the sink is degraded", || {
        log.receipt().state == DiagnosticLogSinkState::Degraded
    });
    let second = log.send("info", vec![entry("error", "lost-3")]);
    assert_eq!(counts(&second), (1, 0, 0, 0));
    assert_eq!(second.sink.state, DiagnosticLogSinkState::Degraded);
    assert_eq!(second.sink.write_failures, 2);
    wait_until("the failures are counted", || {
        log.receipt().write_failures == 3
    });
    assert_eq!(log.receipt().state, DiagnosticLogSinkState::Degraded);
    assert_eq!(log.segment_names(), Vec::<String>::new());

    mode(0o700);
    log.send("info", vec![entry("info", "saved")]);
    log.settle();
    wait_until("the sink is ready again", || {
        log.receipt().state == DiagnosticLogSinkState::Ready
    });

    log.finish();
    assert_eq!(events_of(&log.file_lines()), ["saved"]);
    // The terminal line does not depend on the file.
    assert_eq!(
        events_of(&log.terminal_entries()),
        ["lost-1", "lost-2", "lost-3", "saved"]
    );
    // One line per change of state, without a path.
    assert_eq!(
        log.terminal_notes(),
        [
            "sink degraded: file output failing (PermissionDenied)",
            "sink ready: file output resumed"
        ]
    );
    let receipt = log.receipt();
    assert_eq!((receipt.write_failures, receipt.dropped_total), (3, 0));
}

// Unix only: a directory that holds an open file can be removed there.
#[cfg(unix)]
#[test]
fn lg5_a_vanished_directory_is_created_again_and_a_blocked_path_is_counted() {
    let log = TestSink::started("lg5-vanished");
    log.send("info", vec![entry("info", "before")]);
    log.settle();
    assert_eq!(log.segment_names().len(), 1);

    // Vanished: the next entry goes to a new segment in a new directory.
    fs::remove_dir_all(log.directory()).unwrap();
    log.send("info", vec![entry("info", "after-vanish")]);
    log.settle();
    assert_eq!(log.receipt().state, DiagnosticLogSinkState::Ready);
    assert_eq!(events_of(&log.file_lines()), ["after-vanish"]);

    // Blocked: a regular file where the directory was.
    fs::remove_dir_all(log.directory()).unwrap();
    fs::write(log.directory(), b"not a directory").unwrap();
    log.send(
        "info",
        vec![entry("error", "blocked-1"), entry("error", "blocked-2")],
    );
    log.settle();
    wait_until("the sink is degraded", || {
        log.receipt().state == DiagnosticLogSinkState::Degraded
    });
    assert_eq!(log.receipt().write_failures, 2);
    assert_eq!(fs::read(log.directory()).unwrap(), b"not a directory");

    fs::remove_file(log.directory()).unwrap();
    log.send("info", vec![entry("info", "after-block")]);
    log.finish();
    assert_eq!(events_of(&log.file_lines()), ["after-block"]);
    let notes = log.terminal_notes();
    assert_eq!(notes.len(), 2, "{notes:?}");
    assert!(notes[0].starts_with("sink degraded: file output failing ("));
    assert_eq!(notes[1], "sink ready: file output resumed");
    assert!(!log.terminal_text().contains(log.root.to_str().unwrap()));
}

#[test]
fn lg5_a_directory_that_cannot_be_created_reports_failed_and_the_command_still_answers() {
    // The app data directory could not be resolved.
    let unresolved = TestSink::new("lg5-unresolved");
    assert!(unresolved.sink.start(None));
    // The app data directory is not a directory.
    let blocked = TestSink::new("lg5-blocked");
    let not_a_directory = blocked.root.join("app-data");
    fs::write(&not_a_directory, b"file").unwrap();
    assert!(blocked
        .sink
        .start(Some(not_a_directory.join(DIRECTORY_NAME))));

    for (log, note) in [
        (&unresolved, "sink failed: app data directory unavailable"),
        (&blocked, "sink failed: log directory unavailable ("),
    ] {
        let applied = log.apply("debug");
        assert_eq!(applied.applied_level, DiagnosticLogLevel::Debug);
        assert_eq!(applied.sink.state, DiagnosticLogSinkState::Failed);

        let receipt = log.send(
            "debug",
            vec![entry("error", "unsaved"), entry("debug", "unsaved")],
        );
        assert_eq!(counts(&receipt), (2, 0, 0, 0));
        log.settle();
        wait_until("the failures are counted", || {
            log.receipt().write_failures == 2
        });

        log.finish();
        assert_eq!(log.receipt().state, DiagnosticLogSinkState::Failed);
        assert_eq!(events_of(&log.terminal_entries()), ["unsaved", "unsaved"]);
        let notes = log.terminal_notes();
        assert_eq!(notes.len(), 1, "{notes:?}");
        assert!(notes[0].starts_with(note), "{notes:?}");
    }
    assert_eq!(tree(&unresolved.root), BTreeMap::new());
    assert_eq!(
        tree(&blocked.root),
        BTreeMap::from([("app-data".to_string(), "file of 4 bytes".to_string())])
    );
}

#[test]
fn lg5_a_writer_failure_is_contained_reported_once_and_later_entries_are_counted_as_dropped() {
    let log = TestSink::started("lg5-writer-failure");
    log.send("info", vec![entry("info", "saved")]);
    log.settle();

    // The writer thread panics on its next step, with these three queued.
    log.clock.fail_writer.store(true, Ordering::SeqCst);
    let queued = log.send(
        "info",
        vec![
            entry("error", "lost"),
            entry("warn", "lost"),
            entry("info", "lost"),
        ],
    );
    assert_eq!(counts(&queued), (3, 0, 0, 0));
    wait_until("the writer has ended", || {
        log.sink.lock_queue().writer == WriterPhase::Ended
    });

    // The command still answers, and says that nothing is being saved.
    let later = log.send(
        "info",
        vec![entry("error", "later"), entry("debug", "quiet")],
    );
    assert_eq!(counts(&later), (0, 1, 0, 1));
    assert_eq!(later.sink.state, DiagnosticLogSinkState::Failed);
    assert_eq!(
        (later.sink.write_failures, later.sink.dropped_total),
        (3, 1)
    );
    assert_eq!(log.queued(), (0, 0, 0));
    tracing::dispatcher::with_default(&log.dispatch_over(TEST_ALLOWLIST), || {
        emit_admitted(DiagnosticLogLevel::Error);
    });
    assert_eq!(log.receipt().dropped_total, 2);

    // The exit flush has nothing to wait for.
    let started = Instant::now();
    log.sink.close(EXIT_FLUSH_BOUND);
    assert!(started.elapsed() < EXIT_FLUSH_BOUND);
    assert_eq!(log.receipt().unsaved_at_exit, 0);

    assert_eq!(events_of(&log.file_lines()), ["saved"]);
    assert_eq!(
        log.terminal_notes(),
        ["sink failed: writer ended unexpectedly"]
    );
}

#[test]
fn lg5_entries_queued_or_in_flight_at_exit_are_unsaved_after_the_250_ms_bound() {
    let log = TestSink::started("lg5-exit-bound");
    log.park_writer();
    let queued = log.send("info", priority_batch(0, 5));
    assert_eq!(counts(&queued), (5, 0, 0, 0));
    assert_eq!(log.queued(), (5, 0, 1));

    let started = Instant::now();
    log.sink.close(EXIT_FLUSH_BOUND);
    let waited = started.elapsed();
    assert!(waited >= EXIT_FLUSH_BOUND, "{waited:?}");
    assert!(
        waited < EXIT_FLUSH_BOUND + Duration::from_secs(2),
        "{waited:?}"
    );

    // One in flight and five queued: counted, and said once on the terminal.
    let after = log.send("info", vec![entry("error", "after-exit")]);
    assert_eq!(counts(&after), (0, 0, 0, 1));
    assert_eq!(after.sink.unsaved_at_exit, 6);
    assert_eq!(
        log.terminal_notes(),
        ["exit flush incomplete: 6 entries unsaved"]
    );
    // Nothing presents as complete at the bound.
    assert!(log
        .segment_names()
        .iter()
        .all(|name| name.ends_with(PARTIAL_SUFFIX)));

    // A second exit flush does not wait again.
    let again = Instant::now();
    log.sink.close(EXIT_FLUSH_BOUND);
    assert!(again.elapsed() < EXIT_FLUSH_BOUND);
    assert_eq!(log.receipt().unsaved_at_exit, 6);
}

#[test]
fn lg5_a_clean_exit_flush_saves_everything_and_seals_the_segment() {
    let log = TestSink::started("lg5-exit-clean");
    log.apply("trace");
    tracing::dispatcher::with_default(&log.dispatch_over(TEST_ALLOWLIST), || {
        emit_admitted(DiagnosticLogLevel::Warn);
    });
    send_all(&log, priority_batch(0, 200));
    send_all(&log, detail_batch(0, 200));
    log.settle();
    assert!(log.segment_names()[0].ends_with(PARTIAL_SUFFIX));

    log.sink.close(EXIT_FLUSH_BOUND);
    let receipt = log.receipt();
    assert_eq!(
        (
            receipt.unsaved_at_exit,
            receipt.write_failures,
            receipt.dropped_total
        ),
        (0, 0, 0)
    );
    assert_eq!(log.sink.lock_queue().writer, WriterPhase::Ended);
    let names = log.segment_names();
    assert_eq!(names, [segment_file_name(TEST_NOW_MS, 0, true)]);
    assert_eq!(log.file_lines().len(), 401);
    assert_eq!(log.terminal_notes(), Vec::<String>::new());
}

#[test]
fn lg5_the_command_returns_while_the_writer_is_blocked() {
    let log = TestSink::started("lg5-prompt");
    log.apply("trace");
    log.park_writer();

    let started = Instant::now();
    let (mut accepted, mut dropped, mut slowest) = (0, 0, Duration::ZERO);
    for call in 0..100 {
        let batch = if call % 2 == 0 {
            priority_batch(call * 64, 64)
        } else {
            detail_batch(call * 64, 64)
        };
        let before = Instant::now();
        let receipt = log.send("trace", batch);
        slowest = slowest.max(before.elapsed());
        assert_eq!(receipt.accepted + receipt.dropped, 64);
        accepted += receipt.accepted;
        dropped += receipt.dropped;
    }
    let elapsed = started.elapsed();
    tracing::dispatcher::with_default(&log.dispatch_over(TEST_ALLOWLIST), || {
        emit_admitted(DiagnosticLogLevel::Error);
    });

    // The writer made no progress during the 6,400 entries, and no call waited for it.
    assert_eq!(log.queued().2, 1);
    assert_eq!(log.queued().0 + log.queued().1, QUEUE_CAPACITY);
    assert_eq!(accepted + dropped, 6_400);
    assert!(dropped > 0);
    assert!(elapsed < Duration::from_secs(10), "{elapsed:?}");
    assert!(slowest < Duration::from_secs(1), "{slowest:?}");
}

#[cfg(unix)]
#[test]
fn lg5_the_sink_never_creates_an_entry_about_itself() {
    use std::os::unix::fs::PermissionsExt;

    let log = TestSink::started("lg5-no-recursion");
    log.apply("trace");
    // The sink's own subscriber is the default of this thread while it sheds and fails.
    tracing::dispatcher::with_default(&log.dispatch_over(TEST_ALLOWLIST), || {
        log.park_writer();
        send_all(&log, detail_batch(0, DETAIL_LANE_CAPACITY + 500));
        send_all(&log, priority_batch(0, QUEUE_CAPACITY));
        for _ in 0..50 {
            emit_admitted(DiagnosticLogLevel::Error);
        }
        // Every write now needs a new segment, and none can be created.
        fs::remove_file(log.directory().join(&log.segment_names()[0])).unwrap();
        fs::set_permissions(log.directory(), fs::Permissions::from_mode(0o500)).unwrap();
        log.release_writer();
        log.settle();
        fs::set_permissions(log.directory(), fs::Permissions::from_mode(0o700)).unwrap();
        log.send("trace", vec![entry("info", "recovered")]);
        log.settle();
    });
    log.finish();

    // Shed: 500 detail entries on arrival, every queued detail entry for a
    // priority entry, and one info entry for each of the 50 native errors. Not
    // saved: the parked entry and everything that was queued.
    let receipt = log.receipt();
    assert_eq!(
        (receipt.dropped_total, receipt.write_failures),
        (
            500 + DETAIL_LANE_CAPACITY as u64 + 50,
            1 + QUEUE_CAPACITY as u64
        )
    );
    // Shedding and failing produced counters and two state lines, and no entry:
    // everything on the terminal is something this test submitted. The 50 native
    // errors took the place of 50 queued info entries.
    let printed = log.terminal_entries();
    assert_eq!(printed.len(), 2 + QUEUE_CAPACITY + 1);
    assert_eq!(events_of(&log.file_lines()), ["recovered"]);
    let mut native = 0;
    for line in &printed {
        let event = line["event"].as_str().unwrap();
        if line["origin"] == "native" {
            assert_eq!(
                (
                    line["source"].as_str().unwrap(),
                    event,
                    line["message"].as_str().unwrap()
                ),
                ("native.test", NATIVE_EVENT_TAG, "native event"),
                "{line}"
            );
            native += 1;
        } else {
            assert!(
                ["priming", "parked", "priority", "recovered"].contains(&event),
                "{line}"
            );
            assert_eq!(line["source"], "meeting.test");
        }
    }
    assert_eq!(native, 50);
    assert_eq!(
        log.terminal_notes(),
        [
            "sink degraded: file output failing (PermissionDenied)",
            "sink ready: file output resumed"
        ]
    );

    // And the product code of the sink holds no tracing macro and no print macro.
    let production = include_str!("diagnostic_log.rs");
    for needle in [
        "error!(",
        "warn!(",
        "info!(",
        "debug!(",
        "trace!(",
        "event!(",
        "print!(",
        "println!(",
        "dbg!(",
    ] {
        assert!(!production.contains(needle), "the sink uses {needle}");
    }
}

// What a full disk or a quota does: a new segment can be created and the write
// into it fails. Here the handle of the new segment is replaced by a read-only
// one, which fails the same `write_all` of the same path through `append`.
#[test]
fn lg5_a_failing_write_leaves_no_empty_segment_and_keeps_the_segments_that_hold_entries() {
    let log = TestSink::new("lg5-failing-write");
    let directory = log.directory();
    fs::create_dir_all(&directory).unwrap();
    let history: Vec<String> = (1..=9u64)
        .map(|days| segment_file_name(TEST_NOW_MS - days * DAY_MS, 0, true))
        .collect();
    for name in &history {
        fs::write(directory.join(name), "{\"history\":true}\n").unwrap();
    }
    let before = tree(&log.root);
    let read_only = |name: &str| File::open(directory.join(name)).unwrap();
    let mut segments = log.segments();

    for batch in 0..12u64 {
        let now = TEST_NOW_MS + batch * 1_000;
        let mut active = segments.open(&directory, now).unwrap();
        assert!(directory.join(&active.name).exists());
        active.file = read_only(&active.name);
        segments.active = Some(active);
        let (saved, result) = segments.append(&["{\"lost\":true}".to_string()], now);
        assert_eq!(saved, 0);
        assert!(result.is_err());
        assert!(segments.active.is_none());
        // Nothing was added and nothing was removed: no empty file is left and
        // the nine earlier segments are all there.
        assert_eq!(tree(&log.root), before, "after failing batch {batch}");
    }

    // A segment that holds entries is not removed when a later write into it
    // fails: it stays as it is, unsealed, and the next write starts a new one.
    let now = TEST_NOW_MS + DAY_MS / 2;
    let (saved, result) = segments.append(&["{\"saved\":1}".to_string()], now);
    assert_eq!((saved, result.is_ok()), (1, true));
    let kept = segments.active.as_ref().unwrap().name.clone();
    assert!(kept.ends_with(PARTIAL_SUFFIX));
    segments.active.as_mut().unwrap().file = read_only(&kept);
    let (saved, result) = segments.append(
        &["{\"lost\":2}".to_string(), "{\"lost\":3}".to_string()],
        now,
    );
    assert_eq!(saved, 0);
    assert!(result.is_err());
    assert!(segments.active.is_none());
    assert_eq!(
        fs::read_to_string(directory.join(&kept)).unwrap(),
        "{\"saved\":1}\n"
    );
    let (saved, result) = segments.append(&["{\"saved\":4}".to_string()], now);
    assert_eq!((saved, result.is_ok()), (1, true));
    segments.seal().unwrap();
    let mut names: Vec<String> = scan_segments(&directory)
        .unwrap()
        .into_iter()
        .map(|segment| segment.name)
        .collect();
    names.sort();
    let mut expected = history.clone();
    expected.push(kept);
    expected.push(segment_file_name(now, 13, true));
    expected.sort();
    assert_eq!(names, expected);
}

/// A terminal that takes no output while `stuck` is set, as a stderr whose
/// reader has stopped does.
struct StuckTerminal {
    stuck: Arc<AtomicBool>,
    entered: Arc<AtomicBool>,
}

impl Write for StuckTerminal {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.entered.store(true, Ordering::SeqCst);
        while self.stuck.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(1));
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

// The exit flush says on the terminal what was left unsaved, and it must not
// wait for the terminal: the writer may be the one holding it.
#[test]
fn lg5_the_exit_flush_keeps_its_bound_when_the_writer_is_stuck_in_the_terminal() {
    let root = std::env::temp_dir().join(format!(
        "jarvis-diagnostic-log-lg5-stuck-terminal-{}",
        Uuid::new_v4()
    ));
    let stuck = Arc::new(AtomicBool::new(true));
    let entered = Arc::new(AtomicBool::new(false));
    let sink = Arc::new(Sink::new(
        Box::new(|| TEST_NOW_MS),
        Box::new(StuckTerminal {
            stuck: Arc::clone(&stuck),
            entered: Arc::clone(&entered),
        }),
        HOUSEKEEPING_INTERVAL,
    ));
    assert!(sink.start(Some(root.join(DIRECTORY_NAME))));
    let send = |events: &[&str]| {
        let batch = events.iter().map(|event| entry("error", event)).collect();
        sink.receive("info", Some(&Value::Array(batch))).unwrap()
    };
    assert_eq!(counts(&send(&["saved-then-stuck"])), (1, 0, 0, 0));
    wait_until("the writer is inside the terminal write", || {
        entered.load(Ordering::SeqCst)
    });
    // The writer saved the first entry and now holds the terminal. The command
    // still answers, and what it queues cannot be saved.
    assert_eq!(
        counts(&send(&["queued-1", "queued-2", "queued-3"])),
        (3, 0, 0, 0)
    );

    let (done, finished) = std::sync::mpsc::channel();
    let closing = Arc::clone(&sink);
    let exit = std::thread::spawn(move || {
        let started = Instant::now();
        closing.close(EXIT_FLUSH_BOUND);
        let _ = done.send(started.elapsed());
    });
    let waited = finished.recv_timeout(Duration::from_secs(10));
    // Whatever the outcome, let the writer and the exit thread end.
    stuck.store(false, Ordering::SeqCst);
    exit.join().unwrap();
    let waited = waited.expect("the exit flush returned while the terminal was held");
    assert!(waited >= EXIT_FLUSH_BOUND, "{waited:?}");
    assert!(
        waited < EXIT_FLUSH_BOUND + Duration::from_secs(2),
        "{waited:?}"
    );
    let after = sink.receive("info", None).unwrap();
    assert_eq!(after.sink.unsaved_at_exit, 3);

    wait_until("the writer has ended", || {
        sink.lock_queue().writer == WriterPhase::Ended
    });
    let _ = fs::remove_dir_all(&root);
}

/// A terminal that keeps every write on its own.
#[derive(Clone, Default)]
struct WriteRecorder(Arc<Mutex<Vec<Vec<u8>>>>);

impl Write for WriteRecorder {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().push(bytes.to_vec());
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

// A whole batch in one write would hold the stderr lock of the process for as
// long as that write takes. Each entry line is a write of its own.
#[test]
fn lg5_the_writer_prints_each_entry_line_in_a_terminal_write_of_its_own() {
    let root = std::env::temp_dir().join(format!(
        "jarvis-diagnostic-log-lg5-line-writes-{}",
        Uuid::new_v4()
    ));
    let terminal = WriteRecorder::default();
    let sink = Arc::new(Sink::new(
        Box::new(|| TEST_NOW_MS),
        Box::new(terminal.clone()),
        HOUSEKEEPING_INTERVAL,
    ));
    assert!(sink.start(Some(root.join(DIRECTORY_NAME))));
    // One call: the 64 entries are queued together and the writer takes them
    // as one batch.
    let batch: Vec<Value> = (0..64)
        .map(|index| entry_of_bytes("error", &format!("line-{index}"), 2_000))
        .collect();
    let receipt = sink.receive("info", Some(&Value::Array(batch))).unwrap();
    assert_eq!(counts(&receipt), (64, 0, 0, 0));
    sink.close(WAIT_BOUND);
    assert_eq!(sink.lock_queue().writer, WriterPhase::Ended);

    let writes = terminal.0.lock().unwrap().clone();
    assert_eq!(writes.len(), 64, "one write for each entry line");
    for (index, write) in writes.iter().enumerate() {
        let text = std::str::from_utf8(write).unwrap();
        assert_eq!(text.matches('\n').count(), 1, "write {index}");
        let line = text
            .strip_prefix(TERMINAL_PREFIX)
            .and_then(|line| line.strip_suffix('\n'))
            .unwrap();
        let line: Value = serde_json::from_str(line).unwrap();
        assert_eq!(line["event"], format!("line-{index}"));
    }
    let _ = fs::remove_dir_all(&root);
}

// The flush is one call in the app exit path, after the raw receipt line, and no
// capture start or stop path refers to the sink.
#[test]
fn lg5_the_exit_flush_is_wired_once_after_the_raw_receipt_line() {
    let shutdown = include_str!("app_shutdown.rs");
    let receipt = shutdown
        .find(r#"eprintln!("ApplicationShutdownReceipt {receipt}");"#)
        .expect("the raw receipt line");
    let flush = shutdown
        .find("crate::diagnostic_log::flush_at_exit();")
        .expect("the exit flush");
    let exit = shutdown.find("app.exit(0);").expect("the exit");
    assert!(receipt < flush && flush < exit);
    assert_eq!(shutdown.matches("diagnostic_log").count(), 1);
    assert_eq!(EXIT_FLUSH_BOUND, Duration::from_millis(250));

    for (name, source) in [
        ("app_shutdown/gate.rs", include_str!("app_shutdown/gate.rs")),
        ("speaker/commands.rs", include_str!("speaker/commands.rs")),
        ("speaker/macos.rs", include_str!("speaker/macos.rs")),
        ("stt_evaluation.rs", include_str!("stt_evaluation.rs")),
        (
            "session_recording_files.rs",
            include_str!("session_recording_files.rs"),
        ),
    ] {
        assert!(!source.contains("diagnostic_log"), "{name}");
    }
}

// ---------------------------------------------------------------------------
// LG6: file retention.
// ---------------------------------------------------------------------------

fn segment(started_at_ms: u64, sequence: u32, bytes: u64) -> Segment {
    Segment {
        name: segment_file_name(started_at_ms, sequence, true),
        started_at_ms,
        sequence,
        bytes,
    }
}

#[test]
fn lg6_retention_is_exact_on_both_sides_of_the_14_day_boundary() {
    let now = TEST_NOW_MS;
    let inside = segment(now - 14 * DAY_MS + 1, 0, 100);
    let boundary = segment(now - 14 * DAY_MS, 0, 100);
    let outside = segment(now - 14 * DAY_MS - 1, 0, 100);
    let fresh = segment(now, 0, 100);
    let ahead = segment(now + DAY_MS, 0, 100);
    let all = [
        fresh.clone(),
        outside.clone(),
        inside.clone(),
        ahead.clone(),
        boundary.clone(),
    ];

    assert_eq!(RETENTION_MAX_AGE_MS, 14 * DAY_MS);
    assert_eq!(
        retention_removals(&all, now, false),
        [outside.name.clone(), boundary.name.clone()]
    );
    assert_eq!(
        retention_removals(&[inside.clone()], now, false),
        Vec::<String>::new()
    );
    // One millisecond later the segment that was just inside has reached 14 days.
    assert_eq!(
        retention_removals(&[inside.clone()], now + 1, false),
        [inside.name]
    );
    // A pure function of its two arguments.
    assert_eq!(
        retention_removals(&all, now, false),
        retention_removals(&all, now, false)
    );
}

#[test]
fn lg6_retention_is_exact_on_both_sides_of_the_50_mib_boundary() {
    let now = TEST_NOW_MS;
    assert_eq!(RETENTION_MAX_BYTES, 52_428_800);
    assert_eq!(SEGMENT_MAX_BYTES, 5_242_880);
    assert_eq!(FULL_SEGMENTS_RETAINED, 10);
    assert_eq!(
        FULL_SEGMENTS_RETAINED * SEGMENT_MAX_BYTES,
        RETENTION_MAX_BYTES
    );

    // Exactly 50 MiB in ten segments: nothing is removed.
    let ten: Vec<Segment> = (0..10)
        .map(|index| segment(now - (10 - index) * 1_000, 0, 5 * MIB))
        .collect();
    assert_eq!(retention_removals(&ten, now, false), Vec::<String>::new());

    // One byte more: the oldest goes, and only the oldest.
    let mut over = ten.clone();
    over[9].bytes += 1;
    assert_eq!(retention_removals(&over, now, false), [ten[0].name.clone()]);

    // Bytes alone decide as well: three segments over the total.
    let wide = [
        segment(now - 3_000, 0, 30 * MIB),
        segment(now - 2_000, 0, 20 * MIB),
        segment(now - 1_000, 0, 1),
    ];
    assert_eq!(
        retention_removals(&wide, now, false),
        [wide[0].name.clone()]
    );
    assert_eq!(
        retention_removals(&wide[..2], now, false),
        Vec::<String>::new()
    );

    // Whichever is reached first: age removes a small segment too.
    let old = [segment(now - 14 * DAY_MS, 0, 1), segment(now, 0, 1)];
    assert_eq!(retention_removals(&old, now, false), [old[0].name.clone()]);
}

#[test]
fn lg6_the_number_of_files_is_only_guarded_and_room_is_made_before_a_new_segment() {
    let now = TEST_NOW_MS;
    assert_eq!(MAX_SEGMENT_FILES, 1_024);
    // Small segments: eleven are kept, and so is the guard's worth. Neither
    // retention bound is reached, so nothing is removed.
    let at_guard: Vec<Segment> = (0..MAX_SEGMENT_FILES as u64)
        .map(|index| segment(now - 1_000_000 + index, 0, 10))
        .collect();
    assert_eq!(
        retention_removals(&at_guard[..11], now, false),
        Vec::<String>::new()
    );
    assert_eq!(
        retention_removals(&at_guard, now, false),
        Vec::<String>::new()
    );
    // One file more than the guard: the oldest goes, and only the oldest.
    let mut over_guard = at_guard.clone();
    over_guard.push(segment(now, 0, 10));
    assert_eq!(
        retention_removals(&over_guard, now, false),
        [at_guard[0].name.clone()]
    );

    // Before a new segment: one file fewer than the guard, and at most 45 MiB.
    assert_eq!(
        retention_removals(&at_guard, now, true),
        [at_guard[0].name.clone()]
    );
    assert_eq!(
        retention_removals(&at_guard[1..], now, true),
        Vec::<String>::new()
    );
    let nine: Vec<Segment> = (0..9)
        .map(|index| segment(now - (9 - index) * 1_000, 0, 5 * MIB))
        .collect();
    assert_eq!(retention_removals(&nine, now, true), Vec::<String>::new());
    let mut over = nine.clone();
    over[8].bytes += 1;
    assert_eq!(retention_removals(&over, now, true), [nine[0].name.clone()]);
}

// A segment named ahead of the clock was written before the clock was set back.
#[test]
fn lg6_a_segment_named_ahead_of_the_clock_is_the_first_to_go_and_is_not_expired_by_age() {
    let now = TEST_NOW_MS;
    // Up to one rotation period ahead is still this clock: an ordinary segment.
    let within = segment(now + DAY_MS, 0, 5 * MIB);
    let ahead = segment(now + DAY_MS + 1, 0, 5 * MIB);
    let far_ahead = segment(now + 365 * DAY_MS, 0, 5 * MIB);
    let recent: Vec<Segment> = (1..=8)
        .map(|days| segment(now - days * DAY_MS, 0, 5 * MIB))
        .collect();

    // Under the bounds nothing is removed: a clock that was set back, even by
    // years, removes no segment by itself.
    let mut all = recent.clone();
    all.extend([far_ahead.clone(), within.clone()]);
    assert_eq!(all.len() as u64 * 5 * MIB, RETENTION_MAX_BYTES);
    assert_eq!(retention_removals(&all, now, false), Vec::<String>::new());
    assert_eq!(
        retention_removals(&[far_ahead.clone()], 0, false),
        Vec::<String>::new()
    );

    // Over a bound the segments ahead of the clock go before any segment of this
    // clock, the nearest first, although their names sort as the newest.
    all.push(ahead.clone());
    assert_eq!(retention_removals(&all, now, false), [ahead.name.clone()]);
    assert_eq!(
        retention_removals(&all, now, true),
        [ahead.name.clone(), far_ahead.name.clone()]
    );
    // The one that is within a rotation period keeps its place as the newest.
    all.push(segment(now - 9 * DAY_MS, 0, 5 * MIB));
    assert_eq!(
        retention_removals(&all, now, false),
        [ahead.name.clone(), far_ahead.name.clone()]
    );
    all.push(segment(now - 10 * DAY_MS, 0, 5 * MIB));
    assert_eq!(
        retention_removals(&all, now, false),
        [
            ahead.name.clone(),
            far_ahead.name.clone(),
            segment_file_name(now - 10 * DAY_MS, 0, true)
        ]
    );
    // Once the clock has caught up it expires by age like any other.
    assert_eq!(
        retention_removals(&[ahead.clone()], now + 15 * DAY_MS, false),
        Vec::<String>::new()
    );
    assert_eq!(
        retention_removals(&[ahead.clone()], now + 15 * DAY_MS + 1, false),
        [ahead.name]
    );
}

#[test]
fn lg6_only_a_name_of_the_exact_pattern_is_a_segment() {
    let sealed = segment_file_name(TEST_NOW_MS, 7, true);
    let partial = segment_file_name(TEST_NOW_MS, 7, false);
    assert_eq!(sealed, "diagnostic-1790000000000-0007.jsonl");
    assert_eq!(partial, "diagnostic-1790000000000-0007.jsonl.partial");
    assert_eq!(parse_segment_file_name(&sealed), Some((TEST_NOW_MS, 7)));
    assert_eq!(parse_segment_file_name(&partial), Some((TEST_NOW_MS, 7)));
    assert_eq!(
        segment_file_name(5, 0, true),
        "diagnostic-0000000000005-0000.jsonl"
    );

    for foreign in [
        "",
        "diagnostic-1790000000000-0007",
        "diagnostic-1790000000000-0007.json",
        "diagnostic-1790000000000-0007.jsonl.bak",
        "diagnostic-1790000000000-0007.jsonl.partial.tmp",
        "diagnostic-179000000000-0007.jsonl",
        "diagnostic-17900000000000-0007.jsonl",
        "diagnostic-1790000000000-007.jsonl",
        "diagnostic-1790000000000-00007.jsonl",
        "diagnostic-1790000000000.jsonl",
        "diagnostic-17900000000x0-0007.jsonl",
        "diagnostic-+790000000000-0007.jsonl",
        "Diagnostic-1790000000000-0007.jsonl",
        "xdiagnostic-1790000000000-0007.jsonl",
        "diagnostic-1790000000000-0007.jsonl ",
        "sample-1.json",
        "recovery-1.json",
        "manifest.json",
        "system.wav",
        "meeting-trace-metrics.json",
    ] {
        assert_eq!(parse_segment_file_name(foreign), None, "{foreign:?}");
    }
}

#[test]
fn lg6_segments_rotate_at_5_mib_and_at_24_hours_on_a_fixed_clock() {
    let log = TestSink::started("lg6-rotation");
    // 2,880 entries of 2,000 bytes, about 5.5 MiB: more than one segment.
    const CALLS: u64 = 45;
    let large = entry_of_bytes("info", "rotation", 2_000);
    for _ in 0..CALLS {
        assert_eq!(
            counts(&log.send("info", vec![large.clone(); 64])),
            (64, 0, 0, 0)
        );
        log.settle();
    }
    let per_line = 2_000 + FRONTEND_ORIGIN_FIELD.len() as u64 + 1;
    let lines_per_segment = SEGMENT_MAX_BYTES / per_line;
    let first = segment_file_name(TEST_NOW_MS, 0, true);
    let second = segment_file_name(TEST_NOW_MS, 1, false);
    assert_eq!(log.segment_names(), [first.clone(), second.clone()]);
    let size = |name: &str| fs::metadata(log.directory().join(name)).unwrap().len();
    assert_eq!(size(&first), lines_per_segment * per_line);
    assert!(size(&first) <= SEGMENT_MAX_BYTES && size(&first) + per_line > SEGMENT_MAX_BYTES);
    assert_eq!(size(&second), (CALLS * 64 - lines_per_segment) * per_line);

    // One millisecond before 24 hours: the same segment.
    log.clock
        .now_ms
        .store(TEST_NOW_MS + DAY_MS - 1, Ordering::SeqCst);
    log.send("info", vec![entry("info", "same-day")]);
    log.settle();
    assert_eq!(log.segment_names(), [first.clone(), second.clone()]);

    // At 24 hours: the segment is sealed and a new one starts at the new time.
    log.clock
        .now_ms
        .store(TEST_NOW_MS + DAY_MS, Ordering::SeqCst);
    log.send("info", vec![entry("info", "next-day")]);
    log.settle();
    let third = segment_file_name(TEST_NOW_MS + DAY_MS, 2, false);
    assert_eq!(
        log.segment_names(),
        [
            first.clone(),
            segment_file_name(TEST_NOW_MS, 1, true),
            third
        ]
    );

    log.finish();
    let names = log.segment_names();
    assert_eq!(names.len(), 3);
    assert!(names.iter().all(|name| name.ends_with(SEALED_SUFFIX)));
    let events = events_of(&log.file_lines());
    assert_eq!(events.len(), CALLS as usize * 64 + 2);
    assert_eq!(events[CALLS as usize * 64..], ["same-day", "next-day"]);
    assert_eq!(log.receipt().write_failures, 0);
}

#[test]
fn lg6_a_segment_left_unfinished_is_never_presented_as_complete() {
    let log = TestSink::new("lg6-unfinished");
    fs::create_dir_all(log.directory()).unwrap();
    // What a killed run leaves behind: a partial segment whose last line was cut.
    let leftover = segment_file_name(TEST_NOW_MS - 60_000, 0, false);
    let cut = "{\"v\":1,\"at\":1789999940000,\"level\":\"info\"}\n{\"v\":1,\"at\":17899";
    fs::write(log.directory().join(&leftover), cut).unwrap();

    assert!(log.sink.start(Some(log.directory())));
    log.send("info", vec![entry("info", "new-run")]);
    log.settle();
    // While it is written, the new segment is partial as well, under its own name.
    let active = segment_file_name(TEST_NOW_MS, 0, false);
    assert_eq!(log.segment_names(), [leftover.clone(), active]);

    log.finish();
    // Only the segment this run completed lost the suffix. The leftover was not
    // appended to, renamed or removed.
    assert_eq!(
        log.segment_names(),
        [leftover.clone(), segment_file_name(TEST_NOW_MS, 0, true)]
    );
    assert_eq!(
        fs::read_to_string(log.directory().join(&leftover)).unwrap(),
        cut
    );
    let sealed = fs::read_to_string(
        log.directory()
            .join(segment_file_name(TEST_NOW_MS, 0, true)),
    )
    .unwrap();
    assert_eq!(sealed.lines().count(), 1);
    assert!(sealed.ends_with("\"origin\":\"frontend\"}\n"));
}

#[cfg(unix)]
#[test]
fn lg6_retention_removes_only_its_own_regular_segment_files() {
    let log = TestSink::new("lg6-own-files");
    let logs = log.directory();
    let recording = log.root.join("meeting-session-recordings/session-1");
    let expired = TEST_NOW_MS - 15 * DAY_MS;
    let put = |path: PathBuf, content: &str| {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    };

    // The logger's own files.
    put(logs.join(segment_file_name(expired, 0, true)), "expired\n");
    put(
        logs.join(segment_file_name(expired, 1, false)),
        "expired partial\n",
    );
    put(
        logs.join(segment_file_name(TEST_NOW_MS - DAY_MS, 0, true)),
        "recent\n",
    );
    // In the logger's directory, but not its files.
    put(logs.join("notes.txt"), "kept");
    put(logs.join("diagnostic-123-0000.jsonl"), "kept");
    put(
        logs.join(format!("{}.bak", segment_file_name(expired, 2, true))),
        "kept",
    );
    put(
        logs.join(segment_file_name(expired, 3, true))
            .join("inside.txt"),
        "kept",
    );
    put(
        logs.join("nested")
            .join(segment_file_name(expired, 4, true)),
        "kept",
    );
    // Recordings, audio and Native Stall Diagnostics next to it.
    put(recording.join("audio/system.wav"), "audio");
    put(
        recording.join("diagnostics/native-stall/sample-1.json"),
        "{}",
    );
    put(recording.join("human-evaluation/evaluation.json"), "{}");
    put(recording.join(segment_file_name(expired, 5, true)), "kept");
    put(
        log.root
            .join("stt-evaluation-captures/c1/source-audio/a.wav"),
        "audio",
    );
    put(log.root.join(segment_file_name(expired, 6, true)), "kept");
    // A symlink with an expired segment name, pointing at a recording.
    std::os::unix::fs::symlink(
        recording.join("audio/system.wav"),
        logs.join(segment_file_name(expired, 7, true)),
    )
    .unwrap();

    let mut expected = tree(&log.root);
    let logs_name = |name: String| format!("{DIRECTORY_NAME}/{name}");
    assert!(expected
        .remove(&logs_name(segment_file_name(expired, 0, true)))
        .is_some());
    assert!(expected
        .remove(&logs_name(segment_file_name(expired, 1, false)))
        .is_some());

    // Startup alone applies retention.
    assert!(log.sink.start(Some(log.directory())));
    wait_until("startup retention has run", || {
        !logs.join(segment_file_name(expired, 0, true)).exists()
            && !logs.join(segment_file_name(expired, 1, false)).exists()
    });
    assert_eq!(tree(&log.root), expected);

    // Writing applies it again and adds exactly one segment.
    log.send("info", vec![entry("info", "written")]);
    log.finish();
    let written = segment_file_name(TEST_NOW_MS, 0, true);
    let size = fs::metadata(logs.join(&written)).unwrap().len();
    expected.insert(logs_name(written), format!("file of {size} bytes"));
    assert_eq!(tree(&log.root), expected);
    assert_eq!(
        fs::read_to_string(recording.join("audio/system.wav")).unwrap(),
        "audio"
    );
    assert_eq!(log.terminal_notes(), Vec::<String>::new());
}

#[cfg(unix)]
#[test]
fn lg6_a_log_directory_that_is_a_symlink_is_refused() {
    let log = TestSink::new("lg6-symlink");
    let recording = log.root.join("meeting-session-recordings/session-1");
    fs::create_dir_all(&recording).unwrap();
    let old = segment_file_name(TEST_NOW_MS - 15 * DAY_MS, 0, true);
    fs::write(recording.join(&old), "a recording file with a segment name").unwrap();
    std::os::unix::fs::symlink(&recording, log.directory()).unwrap();
    let before = tree(&log.root);

    assert!(log.sink.start(Some(log.directory())));
    log.send("info", vec![entry("error", "not-saved")]);
    log.finish();

    assert_eq!(log.receipt().state, DiagnosticLogSinkState::Failed);
    assert_eq!(log.receipt().write_failures, 1);
    assert_eq!(tree(&log.root), before);
    assert_eq!(
        log.terminal_notes(),
        ["sink failed: log directory unavailable (InvalidInput)"]
    );
}

#[test]
fn lg6_the_directory_stays_within_50_mib_which_is_ten_full_segments_by_bytes_when_a_segment_is_opened(
) {
    let log = TestSink::new("lg6-total");
    fs::create_dir_all(log.directory()).unwrap();
    // Ten full segments, the oldest twelve days old: exactly 50 MiB.
    let old: Vec<String> = (0..10u64)
        .map(|index| segment_file_name(TEST_NOW_MS - (12 - index) * DAY_MS, 0, true))
        .collect();
    for name in &old {
        let file = File::create(log.directory().join(name)).unwrap();
        file.set_len(SEGMENT_MAX_BYTES).unwrap();
    }
    let total = |log: &TestSink| -> u64 {
        scan_segments(&log.directory())
            .unwrap()
            .iter()
            .map(|segment| segment.bytes)
            .sum()
    };
    assert_eq!(total(&log), RETENTION_MAX_BYTES);

    // Startup keeps all ten: nothing is over a bound yet.
    assert!(log.sink.start(Some(log.directory())));
    log.apply("info");
    log.settle();
    apply_retention(&log.directory(), TEST_NOW_MS, false).unwrap();
    assert_eq!(log.segment_names(), old);

    // A new segment needs room: the oldest goes before it is created.
    log.send("info", vec![entry("info", "eleventh")]);
    log.settle();
    let mut expected = old[1..].to_vec();
    expected.push(segment_file_name(TEST_NOW_MS, 0, false));
    assert_eq!(log.segment_names(), expected);
    assert!(total(&log) <= RETENTION_MAX_BYTES);
    assert_eq!(log.segment_names().len() as u64, FULL_SEGMENTS_RETAINED);

    // Three days later the next oldest has reached 14 days, and the active one 24 hours.
    log.clock
        .now_ms
        .store(TEST_NOW_MS + 3 * DAY_MS, Ordering::SeqCst);
    log.send("info", vec![entry("info", "three-days-later")]);
    log.finish();
    let names = log.segment_names();
    assert_eq!(names[..8], old[2..]);
    assert_eq!(
        names[8..],
        [
            segment_file_name(TEST_NOW_MS, 0, true),
            segment_file_name(TEST_NOW_MS + 3 * DAY_MS, 1, true)
        ]
    );
}

// ---------------------------------------------------------------------------
// LG6: how much history the two retention bounds really keep.
// ---------------------------------------------------------------------------

/// One run of the app over `directory`: a new sink that starts at `now_ms`,
/// takes the entries and exits cleanly.
fn one_run(directory: &Path, now_ms: u64, entries: Vec<Value>) {
    let sink = Arc::new(Sink::new(
        Box::new(move || now_ms),
        Box::new(io::sink()),
        HOUSEKEEPING_INTERVAL,
    ));
    assert!(sink.start(Some(directory.to_path_buf())));
    let sent = entries.len() as u64;
    let receipt = sink.receive("trace", Some(&Value::Array(entries))).unwrap();
    assert_eq!(counts(&receipt), (sent, 0, 0, 0));
    sink.close(WAIT_BOUND);
    assert_eq!(sink.lock_queue().writer, WriterPhase::Ended);
    let exit = sink.receive("trace", None).unwrap().sink;
    assert_eq!((exit.unsaved_at_exit, exit.write_failures), (0, 0));
}

fn events_in(directory: &Path) -> Vec<String> {
    let mut segments = scan_segments(directory).unwrap();
    segments.sort_by(|a, b| a.name.cmp(&b.name));
    segments
        .iter()
        .flat_map(|segment| {
            fs::read_to_string(directory.join(&segment.name))
                .unwrap()
                .lines()
                .map(|line| {
                    let line: Value = serde_json::from_str(line).unwrap();
                    line["event"].as_str().unwrap().to_owned()
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

// Every run that writes an entry adds a segment. Short runs must not push out
// the log of an earlier run while both retention bounds are far away.
#[test]
fn lg6_many_short_runs_keep_the_log_of_the_first_run() {
    let log = TestSink::new("lg6-short-runs");
    const RUNS: u64 = 40;
    for run in 0..RUNS {
        one_run(
            &log.directory(),
            TEST_NOW_MS + run * MINUTE_MS,
            vec![entry("error", &format!("run-{run}"))],
        );
    }
    let segments = scan_segments(&log.directory()).unwrap();
    assert_eq!(segments.len() as u64, RUNS, "one sealed segment per run");
    assert!(segments
        .iter()
        .all(|segment| segment.name.ends_with(SEALED_SUFFIX)));
    assert_eq!(
        events_in(&log.directory()),
        (0..RUNS)
            .map(|run| format!("run-{run}"))
            .collect::<Vec<_>>()
    );
    // The same holds when stale segments named ahead of the clock are present:
    // they do not push out the runs of this clock.
    let stale = segment_file_name(TEST_NOW_MS + 365 * DAY_MS, 0, true);
    fs::write(log.directory().join(&stale), "{\"event\":\"stale\"}\n").unwrap();
    one_run(
        &log.directory(),
        TEST_NOW_MS + RUNS * MINUTE_MS,
        vec![entry("error", "after-stale")],
    );
    let events = events_in(&log.directory());
    assert_eq!(events.len() as u64, RUNS + 2);
    assert!(events.contains(&"run-0".to_string()) && events.contains(&"stale".to_string()));
}

// One run that stays on, with one entry a day: the 24 hour rotation gives one
// segment a day, and it is the 14 day bound that ends a segment's life.
#[test]
fn lg6_an_always_on_run_keeps_fourteen_days_of_daily_segments() {
    let log = TestSink::started("lg6-always-on");
    let kept = |log: &TestSink| -> Vec<String> { events_of(&log.file_lines()) };
    let day = |day: u64| format!("day-{day}");
    for today in 0..=13u64 {
        log.set_now(TEST_NOW_MS + today * DAY_MS);
        log.send("info", vec![entry("info", &day(today))]);
        log.settle();
        assert_eq!(
            kept(&log),
            (0..=today).map(day).collect::<Vec<_>>(),
            "day {today}: nothing has reached 14 days"
        );
    }
    // Day 14: the segment of day 0 started exactly 14 days ago and goes.
    log.set_now(TEST_NOW_MS + 14 * DAY_MS - 1);
    log.send("info", vec![entry("info", "day-13-late")]);
    log.settle();
    assert_eq!(kept(&log).first().unwrap(), "day-0");
    for today in 14..=16u64 {
        log.set_now(TEST_NOW_MS + today * DAY_MS);
        log.send("info", vec![entry("info", &day(today))]);
        log.settle();
        let kept = kept(&log);
        assert_eq!(kept.first().unwrap(), &day(today - 13), "day {today}");
        assert_eq!(kept.last().unwrap(), &day(today), "day {today}");
        assert_eq!(log.segment_names().len(), 14, "day {today}");
    }
    assert_eq!(log.receipt().write_failures, 0);
}

// ---------------------------------------------------------------------------
// LG6: rotation by age and retention between writes, idle and busy.
// ---------------------------------------------------------------------------

// The function the writer runs between writes, on a fixed clock.
#[test]
fn lg6_housekeeping_seals_at_24_hours_and_applies_retention_beside_an_active_segment() {
    let log = TestSink::new("lg6-housekeep");
    let directory = log.directory();
    fs::create_dir_all(&directory).unwrap();
    // One millisecond short of 14 days at the test's now.
    let old = segment_file_name(TEST_NOW_MS - 14 * DAY_MS + 1, 0, true);
    fs::write(directory.join(&old), "{}\n").unwrap();
    let mut segments = log.segments();
    let (saved, result) = segments.append(&["{\"n\":1}".to_string()], TEST_NOW_MS);
    assert_eq!((saved, result.is_ok()), (1, true));
    let partial = segment_file_name(TEST_NOW_MS, 0, false);
    let sealed = segment_file_name(TEST_NOW_MS, 0, true);

    segments.housekeep(TEST_NOW_MS).unwrap();
    assert_eq!(log.segment_names(), [old.clone(), partial.clone()]);
    // 14 days reached while a segment is active and nothing is being opened.
    segments.housekeep(TEST_NOW_MS + 1).unwrap();
    assert_eq!(log.segment_names(), [partial.clone()]);
    // One millisecond before 24 hours the active segment stays as it is.
    segments.housekeep(TEST_NOW_MS + DAY_MS - 1).unwrap();
    assert_eq!(log.segment_names(), [partial]);
    assert!(segments.active.is_some());
    // At 24 hours it is sealed without any entry arriving.
    segments.housekeep(TEST_NOW_MS + DAY_MS).unwrap();
    assert_eq!(log.segment_names(), [sealed.clone()]);
    assert!(segments.active.is_none());
    assert_eq!(
        fs::read_to_string(directory.join(&sealed)).unwrap(),
        "{\"n\":1}\n"
    );
    // A missing directory holds nothing to keep: not an error.
    fs::remove_dir_all(&directory).unwrap();
    segments.housekeep(TEST_NOW_MS + DAY_MS).unwrap();
    assert!(!directory.exists(), "housekeeping creates nothing");
}

// The real writer thread with nothing arriving. Its idle wait is 5 ms here and
// five minutes in the app; everything else is the product path.
#[test]
fn lg6_an_idle_writer_applies_retention_and_seals_at_24_hours_without_an_entry() {
    let log = TestSink::with_idle_wait("lg6-idle", Duration::from_millis(5));
    fs::create_dir_all(log.directory()).unwrap();
    // Reaches 14 days one hour after startup.
    let old = segment_file_name(TEST_NOW_MS - 14 * DAY_MS + HOUR_MS, 0, true);
    fs::write(log.directory().join(&old), "{}\n").unwrap();
    assert!(log.sink.start(Some(log.directory())));
    log.send("info", vec![entry("info", "the-only-entry")]);
    log.settle();
    let partial = segment_file_name(TEST_NOW_MS, 0, false);
    let sealed = segment_file_name(TEST_NOW_MS, 0, true);

    // Many idle passes with the clock unchanged: neither bound is reached.
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(log.segment_names(), [old.clone(), partial.clone()]);

    // One hour later, nothing written since: the old segment has reached 14 days.
    log.set_now(TEST_NOW_MS + HOUR_MS);
    wait_until("the idle writer removed the expired segment", || {
        log.segment_names() == [partial.clone()]
    });
    // 24 hours after the active segment started, still nothing written.
    log.set_now(TEST_NOW_MS + DAY_MS);
    wait_until("the idle writer sealed the segment", || {
        log.segment_names() == [sealed.clone()]
    });
    assert_eq!(events_of(&log.file_lines()), ["the-only-entry"]);

    // The next entry starts a new segment at its own time.
    log.send("info", vec![entry("info", "next-day")]);
    log.finish();
    assert_eq!(
        log.segment_names(),
        [sealed, segment_file_name(TEST_NOW_MS + DAY_MS, 1, true)]
    );
    assert_eq!(events_of(&log.file_lines()), ["the-only-entry", "next-day"]);
    assert_eq!(log.terminal_notes(), Vec::<String>::new());
    assert_eq!(log.receipt().write_failures, 0);
}

// The idle wait never ends while entries keep arriving. A busy writer applies
// retention by the clock, so an expired segment does not wait for the next
// segment to be opened.
#[test]
fn lg6_a_busy_writer_applies_retention_every_five_minutes_by_the_clock() {
    assert_eq!(HOUSEKEEPING_INTERVAL, Duration::from_secs(5 * 60));
    let interval = HOUSEKEEPING_INTERVAL.as_millis() as u64;
    assert!(!housekeeping_due(TEST_NOW_MS, TEST_NOW_MS));
    assert!(!housekeeping_due(TEST_NOW_MS, TEST_NOW_MS + interval - 1));
    assert!(housekeeping_due(TEST_NOW_MS, TEST_NOW_MS + interval));
    assert!(
        housekeeping_due(TEST_NOW_MS, TEST_NOW_MS - 1),
        "the clock was set back"
    );

    let log = TestSink::new("lg6-busy");
    fs::create_dir_all(log.directory()).unwrap();
    // Reaches 14 days one minute after startup.
    let old = segment_file_name(TEST_NOW_MS - 14 * DAY_MS + MINUTE_MS, 0, true);
    fs::write(log.directory().join(&old), "{}\n").unwrap();
    assert!(log.sink.start(Some(log.directory())));
    let send = |log: &TestSink, event: &str| {
        log.send("info", vec![entry("info", event)]);
        // The line is printed after the entry is saved and before the writer
        // decides whether housekeeping is due.
        wait_until("the entry is printed", || {
            events_of(&log.terminal_entries()).contains(&event.to_string())
        });
    };
    send(&log, "at-start");
    let partial = segment_file_name(TEST_NOW_MS, 0, false);
    assert_eq!(log.segment_names(), [old.clone(), partial.clone()]);

    // One millisecond before the interval the segment is 14 days old and still
    // there: the pass is not due. Two entries, so that the decision after the
    // first one has been made when the second one is printed.
    log.set_now(TEST_NOW_MS + interval - 1);
    send(&log, "not-due-1");
    send(&log, "not-due-2");
    assert_eq!(log.segment_names(), [old, partial.clone()]);

    // At the interval the pass runs after the batch: no segment was opened.
    log.set_now(TEST_NOW_MS + interval);
    send(&log, "due");
    wait_until("the busy writer removed the expired segment", || {
        log.segment_names() == [partial.clone()]
    });
    log.finish();
    assert_eq!(
        events_of(&log.file_lines()),
        ["at-start", "not-due-1", "not-due-2", "due"]
    );
    assert_eq!(log.terminal_notes(), Vec::<String>::new());
}

// The directory is checked every time, not only at startup.
#[cfg(unix)]
#[test]
fn lg6_a_directory_replaced_by_a_symlink_is_never_listed_written_or_removed_through() {
    let log = TestSink::new("lg6-swapped");
    let recording = log.root.join("meeting-session-recordings/session-1");
    fs::create_dir_all(&recording).unwrap();
    let expired = segment_file_name(TEST_NOW_MS - 15 * DAY_MS, 0, true);
    fs::write(
        recording.join(&expired),
        "a recording file with a segment name",
    )
    .unwrap();
    // A segment that was active when the directory was replaced: its file was
    // moved away with the old directory, and the other folder happens to hold a
    // file of the same name.
    let taken = segment_file_name(TEST_NOW_MS, 0, false);
    fs::write(recording.join(&taken), "another file with a segment name").unwrap();
    let moved = log.root.join("moved-away");
    fs::create_dir_all(&moved).unwrap();
    fs::write(moved.join(&taken), "").unwrap();
    std::os::unix::fs::symlink(&recording, log.directory()).unwrap();
    let before = tree(&log.root);
    let refused =
        |result: io::Result<()>| result.unwrap_err().kind() == io::ErrorKind::InvalidInput;

    // Each file operation of the writer, on its own.
    let mut segments = log.segments();
    assert!(refused(segments.housekeep(TEST_NOW_MS)));
    assert!(refused(
        apply_retention(&log.directory(), TEST_NOW_MS, false).map(|_| ())
    ));
    assert!(refused(
        apply_retention(&log.directory(), TEST_NOW_MS, true).map(|_| ())
    ));
    assert!(refused(prepare_directory(&log.directory())));
    assert!(refused(
        segments.open(&log.directory(), TEST_NOW_MS).map(|_| ())
    ));
    let (saved, result) = segments.append(&["{}".to_string()], TEST_NOW_MS);
    assert_eq!(saved, 0);
    assert!(refused(result));
    // An active segment is given up by each of them. Its handle could still be
    // written: the batch is not appended to it. The file of that name in the
    // other folder is not renamed by a seal and not removed with the segment.
    let active = || {
        OpenOptions::new()
            .append(true)
            .open(moved.join(&taken))
            .unwrap()
    };
    let with_active = |segments: &mut Segments, bytes: u64| {
        segments.active = Some(ActiveSegment {
            file: active(),
            name: taken.clone(),
            started_at_ms: TEST_NOW_MS,
            sequence: 0,
            bytes,
        });
    };
    for bytes in [0, 7] {
        // Housekeeping, before the segment is due for its seal and when it is.
        for now in [TEST_NOW_MS, TEST_NOW_MS + DAY_MS] {
            with_active(&mut segments, bytes);
            assert!(refused(segments.housekeep(now)));
            assert!(segments.active.is_none());
        }
        with_active(&mut segments, bytes);
        assert!(refused(segments.seal()));
        assert!(segments.active.is_none());
        with_active(&mut segments, bytes);
        let (saved, result) = segments.append(&["{}".to_string()], TEST_NOW_MS);
        assert_eq!(saved, 0);
        assert!(refused(result));
        assert!(segments.active.is_none());
        assert_eq!(
            tree(&log.root),
            before,
            "nothing was appended, renamed or removed"
        );
    }
    assert_eq!(real_directory(&recording).unwrap(), true);
    assert_eq!(real_directory(&log.root.join("absent")).unwrap(), false);

    // A link is refused before anything is listed through it, so also when the
    // folder behind it holds nothing that retention would remove.
    let empty = log.root.join("empty");
    fs::create_dir_all(&empty).unwrap();
    let link = log.root.join("link-to-empty");
    std::os::unix::fs::symlink(&empty, &link).unwrap();
    assert!(refused(
        apply_retention(&link, TEST_NOW_MS, false).map(|_| ())
    ));
    let mut over_link = Segments {
        directory: Some(link),
        active: None,
        next_sequence: 0,
        retention_failure: None,
    };
    assert!(refused(over_link.housekeep(TEST_NOW_MS)));
}

// The same through the real writer: started on a real directory that is then
// replaced by a symlink while the app runs, idle and busy.
#[cfg(unix)]
#[test]
fn lg6_a_running_writer_refuses_a_directory_that_became_a_symlink() {
    let log = TestSink::with_idle_wait("lg6-swapped-running", Duration::from_millis(5));
    assert!(log.sink.start(Some(log.directory())));
    log.send("info", vec![entry("info", "before-the-swap")]);
    log.settle();
    assert_eq!(log.receipt().state, DiagnosticLogSinkState::Ready);

    let recording = log.root.join("meeting-session-recordings/session-1");
    fs::create_dir_all(&recording).unwrap();
    let expired = segment_file_name(TEST_NOW_MS - 15 * DAY_MS, 0, true);
    fs::write(
        recording.join(&expired),
        "a recording file with a segment name",
    )
    .unwrap();
    // The directory is replaced between two passes of the writer, which is held
    // in its clock meanwhile. A replacement in the middle of a pass, between the
    // check and the removal that follows it, is the known limit of path calls.
    log.clock.hold_writer.store(true, Ordering::SeqCst);
    wait_until("the writer is held between two passes", || {
        log.clock.writer_held.load(Ordering::SeqCst)
    });
    fs::remove_dir_all(log.directory()).unwrap();
    std::os::unix::fs::symlink(&recording, log.directory()).unwrap();
    let before = tree(&log.root);
    log.release_writer();

    // Idle: the next pass finds the link and says so once.
    wait_until("the sink is degraded", || {
        log.receipt().state == DiagnosticLogSinkState::Degraded
    });
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(tree(&log.root), before);

    // Busy: an entry cannot be saved, and is counted.
    let receipt = log.send("info", vec![entry("error", "after-the-swap")]);
    assert_eq!(counts(&receipt), (1, 0, 0, 0));
    wait_until("the failure is counted", || {
        log.receipt().write_failures == 1
    });
    log.set_now(TEST_NOW_MS + 30 * DAY_MS);
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(tree(&log.root), before);
    assert_eq!(log.receipt().state, DiagnosticLogSinkState::Degraded);

    log.finish();
    assert_eq!(tree(&log.root), before);
    assert_eq!(
        log.terminal_notes(),
        ["sink degraded: file output failing (InvalidInput)"]
    );
    assert_eq!(
        events_of(&log.terminal_entries()),
        ["before-the-swap", "after-the-swap"]
    );
}

// After a due pass the interval starts again. The batches that follow inside it
// run no housekeeping, so a busy writer does not scan the directory after every
// batch once its first five minutes have passed.
#[test]
fn lg6_a_second_batch_inside_the_interval_after_a_due_pass_runs_no_housekeeping() {
    let interval = HOUSEKEEPING_INTERVAL.as_millis() as u64;
    let log = TestSink::started("lg6-busy-interval");
    let send = |log: &TestSink, event: &str| {
        log.send("info", vec![entry("info", event)]);
        // The line is printed after the entry is saved and before the writer
        // decides whether housekeeping is due.
        wait_until("the entry is printed", || {
            events_of(&log.terminal_entries()).contains(&event.to_string())
        });
    };
    send(&log, "at-start");
    let partial = segment_file_name(TEST_NOW_MS, 0, false);
    let expired = |sequence: u32| segment_file_name(TEST_NOW_MS - 15 * DAY_MS, sequence, true);

    // The pass that is due at the interval runs after this batch.
    fs::write(log.directory().join(expired(0)), "{}\n").unwrap();
    log.set_now(TEST_NOW_MS + interval);
    send(&log, "due");
    wait_until("the due pass removed the expired segment", || {
        log.segment_names() == [partial.clone()]
    });

    // An expired segment that appears after that pass stays for the whole of
    // the next interval. Two entries, so that the decision after the first one
    // has been made when the second one is printed.
    fs::write(log.directory().join(expired(1)), "{}\n").unwrap();
    log.set_now(TEST_NOW_MS + 2 * interval - 1);
    send(&log, "inside-1");
    send(&log, "inside-2");
    assert_eq!(log.segment_names(), [expired(1), partial.clone()]);

    // One interval after the due pass the next one runs.
    log.set_now(TEST_NOW_MS + 2 * interval);
    send(&log, "due-again");
    wait_until("the next due pass removed the expired segment", || {
        log.segment_names() == [partial.clone()]
    });
    log.finish();
    assert_eq!(log.terminal_notes(), Vec::<String>::new());
}

// A sealed segment of the same start and sequence is never renamed over.
#[test]
fn lg6_opening_a_segment_skips_a_sequence_whose_sealed_name_exists() {
    let log = TestSink::new("lg6-sealed-name");
    let directory = log.directory();
    fs::create_dir_all(&directory).unwrap();
    let earlier = segment_file_name(TEST_NOW_MS, 0, true);
    fs::write(directory.join(&earlier), "{\"earlier\":true}\n").unwrap();

    let mut segments = log.segments();
    let (saved, result) = segments.append(&["{\"later\":true}".to_string()], TEST_NOW_MS);
    assert_eq!((saved, result.is_ok()), (1, true));
    let active = segments.active.as_ref().unwrap();
    assert_eq!(
        (active.sequence, active.name.clone()),
        (1, segment_file_name(TEST_NOW_MS, 1, false))
    );
    segments.seal().unwrap();
    assert_eq!(
        log.segment_names(),
        [earlier.clone(), segment_file_name(TEST_NOW_MS, 1, true)]
    );
    assert_eq!(
        fs::read_to_string(directory.join(&earlier)).unwrap(),
        "{\"earlier\":true}\n"
    );
}

// A clock at 10^13 ms or later, the year 2286, does not fit the 13 digits of a
// segment name. A file named with 14 digits would never be seen by retention.
#[test]
fn lg6_a_clock_that_does_not_fit_the_segment_name_opens_no_segment() {
    const LAST_MS: u64 = 9_999_999_999_999;
    let log = TestSink::started("lg6-clock-range");
    // The last millisecond that fits: an ordinary segment.
    log.set_now(LAST_MS);
    log.send("info", vec![entry("info", "fits")]);
    log.settle();
    let fits = segment_file_name(LAST_MS, 0, false);
    assert_eq!(fits, "diagnostic-9999999999999-0000.jsonl.partial");
    assert_eq!(log.segment_names(), [fits]);

    // A day later that segment is sealed, and no new one is opened: the entry
    // is a counted file failure and no file is created.
    log.set_now(LAST_MS + DAY_MS);
    let receipt = log.send("info", vec![entry("error", "does-not-fit")]);
    assert_eq!(counts(&receipt), (1, 0, 0, 0));
    wait_until("the failure is counted", || {
        log.receipt().write_failures == 1
    });
    assert_eq!(log.receipt().state, DiagnosticLogSinkState::Degraded);
    let sealed = segment_file_name(LAST_MS, 0, true);
    assert_eq!(
        tree(&log.root).into_keys().collect::<Vec<_>>(),
        [
            DIRECTORY_NAME.to_string(),
            format!("{DIRECTORY_NAME}/{sealed}")
        ]
    );

    // Back in range the next entry is saved.
    log.set_now(LAST_MS);
    log.send("info", vec![entry("info", "fits-again")]);
    log.finish();
    assert_eq!(events_of(&log.file_lines()), ["fits", "fits-again"]);
    assert_eq!(
        log.terminal_notes(),
        [
            "sink degraded: file output failing (InvalidData)",
            "sink ready: file output resumed"
        ]
    );
    assert_eq!(log.receipt().write_failures, 1);
}

/// A file that cannot be removed for as long as this lives: it carries the
/// user-immutable flag, which Finder shows as Locked.
#[cfg(target_os = "macos")]
struct Locked(PathBuf);

#[cfg(target_os = "macos")]
impl Locked {
    fn flag(flag: &str, path: &Path) -> bool {
        std::process::Command::new("/usr/bin/chflags")
            .arg(flag)
            .arg(path)
            .status()
            .is_ok_and(|status| status.success())
    }

    fn lock(path: PathBuf) -> Self {
        assert!(Self::flag("uchg", &path));
        assert!(fs::remove_file(&path).is_err(), "the control: it stays");
        Self(path)
    }

    fn unlock(&self) {
        assert!(Self::flag("nouchg", &self.0));
    }
}

#[cfg(target_os = "macos")]
impl Drop for Locked {
    fn drop(&mut self) {
        // So that the temporary directory can be removed, whatever the test did.
        if fs::symlink_metadata(&self.0).is_ok() {
            let _ = Self::flag("nouchg", &self.0);
        }
    }
}

// A segment that cannot be removed, through the real writer: the pass goes on
// with the rest, says so once in a line of its own, and the sink stays ready
// because every write succeeds.
#[cfg(target_os = "macos")]
#[test]
fn lg6_a_segment_that_cannot_be_removed_is_skipped_and_the_sink_stays_ready_while_writes_succeed() {
    let interval = HOUSEKEEPING_INTERVAL.as_millis() as u64;
    let log = TestSink::new("lg6-locked");
    fs::create_dir_all(log.directory()).unwrap();
    let expired = TEST_NOW_MS - 15 * DAY_MS;
    // The locked one is the first the pass comes to; the other expired one is after it.
    let locked_name = segment_file_name(expired, 0, true);
    let removable = segment_file_name(expired, 1, true);
    let recent = segment_file_name(TEST_NOW_MS - DAY_MS, 0, true);
    for (name, event) in [
        (&locked_name, "locked"),
        (&removable, "removable"),
        (&recent, "recent"),
    ] {
        fs::write(
            log.directory().join(name),
            format!("{{\"event\":\"{event}\"}}\n"),
        )
        .unwrap();
    }
    let locked = Locked::lock(log.directory().join(&locked_name));
    let ready = |log: &TestSink| {
        let receipt = log.receipt();
        assert_eq!(
            (receipt.state, receipt.write_failures),
            (DiagnosticLogSinkState::Ready, 0)
        );
    };
    let send = |log: &TestSink, event: &str| {
        log.send("info", vec![entry("info", event)]);
        wait_until("the entry is printed", || {
            events_of(&log.terminal_entries()).contains(&event.to_string())
        });
        ready(log);
    };

    // Startup: the locked segment is skipped and the one after it is removed.
    assert!(log.sink.start(Some(log.directory())));
    wait_until("startup retention went on past the locked segment", || {
        log.segment_names() == [locked_name.clone(), recent.clone()]
    });
    ready(&log);

    // Opening a segment runs a pass, and so does the busy writer at the
    // interval. Both skip the locked segment again, and every entry is saved.
    send(&log, "saved-1");
    log.set_now(TEST_NOW_MS + interval);
    send(&log, "saved-2");
    send(&log, "saved-3");
    let active = segment_file_name(TEST_NOW_MS, 0, false);
    assert_eq!(
        log.segment_names(),
        [locked_name.clone(), recent.clone(), active.clone()]
    );

    // Once it can be removed, the next pass removes it.
    locked.unlock();
    log.set_now(TEST_NOW_MS + 2 * interval);
    send(&log, "saved-4");
    wait_until("the pass removed the unlocked segment", || {
        log.segment_names() == [recent.clone(), active.clone()]
    });
    log.finish();
    ready(&log);
    assert_eq!(
        events_of(&log.file_lines()),
        ["recent", "saved-1", "saved-2", "saved-3", "saved-4"]
    );
    // One line for the whole time it lasted, in its own words, and no state line.
    assert_eq!(
        log.terminal_notes(),
        ["retention incomplete: a segment could not be removed (PermissionDenied)"]
    );
}

// The byte bound decides, not the failed removal: with room for one more full
// segment a new one is opened beside the locked one, and without it none is.
#[cfg(target_os = "macos")]
#[test]
fn lg6_a_new_segment_is_refused_only_when_what_could_not_be_removed_leaves_no_room_for_it() {
    let log = TestSink::new("lg6-locked-room");
    let directory = log.directory();
    fs::create_dir_all(&directory).unwrap();
    let full = |name: &str| {
        let file = File::create(directory.join(name)).unwrap();
        file.set_len(SEGMENT_MAX_BYTES).unwrap();
    };
    // Two full segments that have expired, the older of them locked, and eight
    // full segments that have not.
    let expired = TEST_NOW_MS - 15 * DAY_MS;
    let locked_name = segment_file_name(expired, 0, true);
    let removable = segment_file_name(expired, 1, true);
    let recent: Vec<String> = (1..=8u64)
        .rev()
        .map(|days| segment_file_name(TEST_NOW_MS - days * DAY_MS, 0, true))
        .collect();
    for name in [&locked_name, &removable].into_iter().chain(&recent) {
        full(name);
    }
    let locked = Locked::lock(directory.join(&locked_name));
    let names = |extra: &[String]| {
        let mut names = vec![locked_name.clone()];
        names.extend(recent.iter().cloned());
        names.extend(extra.iter().cloned());
        names
    };

    // The pass skips the locked segment, removes the one after it and reports
    // what stayed: nine full segments, 45 MiB.
    assert_eq!(
        apply_retention(&directory, TEST_NOW_MS, false).unwrap(),
        RetentionPass {
            remaining_bytes: 9 * SEGMENT_MAX_BYTES,
            failed_removal: Some(io::ErrorKind::PermissionDenied),
        }
    );
    assert_eq!(log.segment_names(), names(&[]));

    // 45 MiB remain: there is room for one more full segment, so it is opened.
    let mut segments = log.segments();
    let (saved, result) = segments.append(&["{\"saved\":1}".to_string()], TEST_NOW_MS);
    assert_eq!((saved, result.is_ok()), (1, true));
    assert_eq!(
        segments.retention_failure,
        Some(io::ErrorKind::PermissionDenied)
    );
    segments.seal().unwrap();
    let small = segment_file_name(TEST_NOW_MS, 0, true);
    assert_eq!(log.segment_names(), names(&[small.clone()]));

    // Twelve bytes more than 45 MiB remain now: no room, so no segment is
    // opened. The batch fails with the reason of the removal, and nothing is
    // created or removed.
    let before = tree(&log.root);
    let (saved, result) = segments.append(&["{\"lost\":2}".to_string()], TEST_NOW_MS + 1);
    assert_eq!(saved, 0);
    assert_eq!(result.unwrap_err().kind(), io::ErrorKind::PermissionDenied);
    assert!(segments.active.is_none());
    assert_eq!(tree(&log.root), before);

    // Unlocked, the pass removes it and the next segment is opened.
    locked.unlock();
    let (saved, result) = segments.append(&["{\"saved\":3}".to_string()], TEST_NOW_MS + 1);
    assert_eq!((saved, result.is_ok()), (1, true));
    assert_eq!(segments.retention_failure, None);
    segments.seal().unwrap();
    let mut expected = recent.clone();
    expected.extend([small, segment_file_name(TEST_NOW_MS + 1, 1, true)]);
    assert_eq!(log.segment_names(), expected);
}

// ---------------------------------------------------------------------------
// LG8: native cost under a fixed steady load and a fixed burst.
// ---------------------------------------------------------------------------

// Measures and reports; the only assertions are that every entry is accounted
// for. Read the numbers with `--nocapture`: the line starts with LG8_NATIVE_COST.
// The queue figure is the largest sampled queue length: one sample per call,
// taken after that call's native events, of the entries queued at that moment.
// The entries the writer has already taken are not in it, so it is a lower
// bound of the queue's high-water mark, not the high-water mark itself.
#[test]
fn lg8_native_cost_under_steady_and_burst_load() {
    fn run(
        label: &str,
        calls: usize,
        per_call: usize,
        bytes: usize,
        gap: Duration,
        native: usize,
    ) -> Value {
        let log = TestSink::started(label);
        log.apply("trace");
        let dispatch = log.dispatch_over(TEST_ALLOWLIST);
        let levels = [
            "info", "debug", "trace", "debug", "warn", "trace", "debug", "error",
        ];
        let batch: Vec<Value> = (0..per_call)
            .map(|index| entry_of_bytes(levels[index % levels.len()], "load", bytes))
            .collect();
        let batch = Value::Array(batch);

        let (mut accepted, mut dropped, mut largest_sampled) = (0u64, 0u64, 0usize);
        let (mut command, mut slowest, mut events) =
            (Duration::ZERO, Duration::ZERO, Duration::ZERO);
        let started = Instant::now();
        tracing::dispatcher::with_default(&dispatch, || {
            for _ in 0..calls {
                let before = Instant::now();
                let receipt = log.sink.receive("trace", Some(&batch)).unwrap();
                let took = before.elapsed();
                command += took;
                slowest = slowest.max(took);
                assert_eq!(receipt.accepted + receipt.dropped, per_call as u64);
                accepted += receipt.accepted;
                dropped += receipt.dropped;

                let before = Instant::now();
                for index in 0..native {
                    tracing::warn!(target: TEST_TARGET, "native load event {index}");
                }
                events += before.elapsed();

                let (priority, detail, _in_flight) = log.queued();
                largest_sampled = largest_sampled.max(priority + detail);
                std::thread::sleep(gap);
            }
        });
        let produced = started.elapsed();
        log.finish();
        let drained = started.elapsed();

        let sink = log.receipt();
        let written = log.file_text().lines().count() as u64;
        let submitted = accepted + (calls * native) as u64;
        // Every admitted entry was written, failed or shed, and nothing else was written.
        assert_eq!(
            submitted,
            written + sink.write_failures + (sink.dropped_total - dropped)
        );
        assert_eq!(sink.unsaved_at_exit, 0);
        let segments = scan_segments(&log.directory()).unwrap();
        let sent = (calls * per_call) as u128;
        json!({
            "load": label,
            "frontendEntries": sent as u64,
            "entryBytes": bytes,
            "nativeEvents": calls * native,
            "commandNsPerEntry": (command.as_nanos() / sent) as u64,
            "slowestCallMicros": slowest.as_micros() as u64,
            "nativeNsPerEvent": (events.as_nanos() / (calls * native).max(1) as u128) as u64,
            "largestSampledQueueLength": largest_sampled,
            "queueCapacity": QUEUE_CAPACITY,
            "accepted": accepted,
            "droppedOfCalls": dropped,
            "droppedTotal": sink.dropped_total,
            "writeFailures": sink.write_failures,
            "unsavedAtExit": sink.unsaved_at_exit,
            "linesWritten": written,
            "bytesWritten": segments.iter().map(|segment| segment.bytes).sum::<u64>(),
            "segments": segments.len(),
            "producedMs": produced.as_millis() as u64,
            "drainedMs": drained.as_millis() as u64,
        })
    }

    // Steady: the Debug-on rate measured for one Voice turn (about 310 lines a
    // second), as 20 calls of 16 entries of 900 bytes, 50 ms apart, with one
    // native event per call.
    let steady = run("lg8-steady", 20, 16, 900, Duration::from_millis(50), 1);
    // Burst: 200 calls of 64 entries of 2,000 bytes back to back, 12,800 entries
    // and about 25 MiB, with ten native events per call.
    let burst = run("lg8-burst", 200, 64, 2_000, Duration::ZERO, 10);

    // What a call site outside the allowlist and one below the threshold cost.
    let log = TestSink::started("lg8-idle");
    log.apply("warn");
    let rounds = 1_000_000u32;
    let (never, filtered) = tracing::dispatcher::with_default(
        &log.dispatch_over(TEST_ALLOWLIST),
        || {
            let before = Instant::now();
            for index in 0..rounds {
                tracing::error!(target: "jarvis_lib::speaker::macos", "outside the allowlist {index}");
            }
            let never = before.elapsed();
            let before = Instant::now();
            for index in 0..rounds {
                tracing::trace!(target: TEST_TARGET, "below the threshold {index}");
            }
            (never, before.elapsed())
        },
    );
    log.finish();
    assert_eq!(log.file_text(), "");

    println!(
        "\nLG8_NATIVE_COST {}",
        json!({
            "debugAssertions": cfg!(debug_assertions),
            "steady": steady,
            "burst": burst,
            "outsideAllowlistNsPerEvent": never.as_nanos() as f64 / f64::from(rounds),
            "belowThresholdNsPerEvent": filtered.as_nanos() as f64 / f64::from(rounds),
        })
    );
}
