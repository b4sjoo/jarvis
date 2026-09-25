use crate::speaker::NativeAudioLivenessEvent;
use serde::Serialize;
use std::collections::VecDeque;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, WebviewWindow};
use uuid::Uuid;

const DELIVERY_TIMEOUT: Duration = Duration::from_secs(6);
const OBSERVER_GAP: Duration = Duration::from_secs(3);
const MAX_SAMPLES: u8 = 2;
const MAX_STACK_BYTES: u64 = 4 * 1024 * 1024;
const MAX_SESSION_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug)]
pub struct CaptureCallbackCounters {
    started_at: Instant,
    started_at_wall_ms: u64,
    callbacks: AtomicU64,
    input_frames: AtomicU64,
    empty_callbacks: AtomicU64,
    dropped_samples: AtomicU64,
    overflow_threshold_elapsed_ms: AtomicU64,
    last_callback_elapsed_ms: AtomicU64,
}

impl CaptureCallbackCounters {
    pub fn new() -> Self {
        Self {
            started_at: Instant::now(),
            started_at_wall_ms: wall_ms(),
            callbacks: AtomicU64::new(0),
            input_frames: AtomicU64::new(0),
            empty_callbacks: AtomicU64::new(0),
            dropped_samples: AtomicU64::new(0),
            overflow_threshold_elapsed_ms: AtomicU64::new(0),
            last_callback_elapsed_ms: AtomicU64::new(0),
        }
    }

    pub fn observe_entry(&self) {
        self.callbacks.fetch_add(1, Ordering::Relaxed);
        self.last_callback_elapsed_ms.store(
            self.started_at.elapsed().as_millis() as u64,
            Ordering::Relaxed,
        );
    }

    pub fn observe_frames(&self, frames: usize) {
        self.input_frames
            .fetch_add(frames as u64, Ordering::Relaxed);
    }

    pub fn observe_empty(&self) {
        self.empty_callbacks.fetch_add(1, Ordering::Relaxed);
    }

    pub fn observe_drop(&self, samples: usize, overflow_threshold_crossed: bool) {
        self.dropped_samples
            .fetch_add(samples as u64, Ordering::Relaxed);
        if overflow_threshold_crossed {
            self.overflow_threshold_elapsed_ms.store(
                self.started_at.elapsed().as_millis() as u64,
                Ordering::Relaxed,
            );
        }
    }

    fn snapshot(&self) -> CallbackSnapshot {
        CallbackSnapshot {
            started_at_wall_ms: self.started_at_wall_ms,
            callbacks: self.callbacks.load(Ordering::Relaxed),
            input_frames: self.input_frames.load(Ordering::Relaxed),
            empty_callbacks: self.empty_callbacks.load(Ordering::Relaxed),
            dropped_samples: self.dropped_samples.load(Ordering::Relaxed),
            overflow_threshold_elapsed_ms: self
                .overflow_threshold_elapsed_ms
                .load(Ordering::Relaxed),
            last_callback_elapsed_ms: self.last_callback_elapsed_ms.load(Ordering::Relaxed),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CallbackSnapshot {
    started_at_wall_ms: u64,
    callbacks: u64,
    input_frames: u64,
    empty_callbacks: u64,
    dropped_samples: u64,
    overflow_threshold_elapsed_ms: u64,
    last_callback_elapsed_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Marker {
    capture_session_id: String,
    capture_generation: u64,
    snapshot_sequence: u64,
}

#[derive(Clone, Debug)]
struct Pending {
    marker: Marker,
    send_started: Instant,
    send_started_at_ms: u64,
    emit_finished_at_ms: Option<u64>,
    emit_succeeded: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressSnapshot {
    at_ms: u64,
    marker: Marker,
    callbacks: Option<CallbackSnapshot>,
    processed_chunk_count: u64,
    raw_signal_chunk_count: u64,
    raw_zero_duration_ms: u64,
    last_raw_signal_observed_at_ms: Option<u64>,
    segment_emitted_count: u64,
}

struct RunState {
    capture: Option<(String, u64)>,
    counters: Option<Arc<CaptureCallbackCounters>>,
    pending: Option<Pending>,
    progress: VecDeque<ProgressSnapshot>,
    last_tick: Instant,
    attempts: u8,
    sampled_this_stall: bool,
    awaiting_fresh_recovery: bool,
    sampling: bool,
}

impl RunState {
    fn new(now: Instant) -> Self {
        Self {
            capture: None,
            counters: None,
            pending: None,
            progress: VecDeque::with_capacity(60),
            last_tick: now,
            attempts: 0,
            sampled_this_stall: false,
            awaiting_fresh_recovery: false,
            sampling: false,
        }
    }

    fn set_capture(
        &mut self,
        session_id: &str,
        generation: u64,
        counters: Arc<CaptureCallbackCounters>,
    ) {
        self.capture = Some((session_id.to_owned(), generation));
        self.counters = Some(counters);
        self.pending = None;
        self.sampled_this_stall = false;
        self.awaiting_fresh_recovery = false;
    }

    fn clear_capture(&mut self, session_id: &str, generation: u64) {
        if self
            .capture
            .as_ref()
            .is_some_and(|capture| capture.0 == session_id && capture.1 == generation)
        {
            self.capture = None;
            self.counters = None;
            self.pending = None;
            self.sampled_this_stall = false;
            self.awaiting_fresh_recovery = false;
        }
    }

    fn begin(&mut self, event: &NativeAudioLivenessEvent, now: Instant) -> bool {
        if event.trigger != "periodic"
            || event.owner != "meeting"
            || !self.capture.as_ref().is_some_and(|capture| {
                capture.0 == event.capture_session_id && capture.1 == event.capture_generation
            })
        {
            return false;
        }
        let marker = Marker {
            capture_session_id: event.capture_session_id.clone(),
            capture_generation: event.capture_generation,
            snapshot_sequence: event.snapshot_sequence,
        };
        let progress = ProgressSnapshot {
            at_ms: wall_ms(),
            marker: marker.clone(),
            callbacks: self.counters.as_ref().map(|counters| counters.snapshot()),
            processed_chunk_count: event.processed_chunk_count,
            raw_signal_chunk_count: event.raw_signal_chunk_count,
            raw_zero_duration_ms: event.raw_zero_duration_ms,
            last_raw_signal_observed_at_ms: event.last_raw_signal_observed_at_ms,
            segment_emitted_count: event.segment_emitted_count,
        };
        self.select_marker(marker, progress, now)
    }

    fn select_marker(&mut self, marker: Marker, progress: ProgressSnapshot, now: Instant) -> bool {
        if self.progress.len() == 60 {
            self.progress.pop_front();
        }
        self.progress.push_back(progress);
        if self.pending.is_some() {
            return false;
        }
        self.pending = Some(Pending {
            marker,
            send_started: now,
            send_started_at_ms: wall_ms(),
            emit_finished_at_ms: None,
            emit_succeeded: None,
        });
        true
    }

    fn finish(&mut self, marker: &Marker, succeeded: bool) {
        if let Some(pending) = self
            .pending
            .as_mut()
            .filter(|pending| &pending.marker == marker)
        {
            pending.emit_finished_at_ms = Some(wall_ms());
            pending.emit_succeeded = Some(succeeded);
            if !succeeded {
                self.pending = None;
            }
        }
    }

    fn acknowledge(&mut self, marker: &Marker, now: Instant) -> AckOutcome {
        let Some(pending) = self
            .pending
            .as_ref()
            .filter(|pending| &pending.marker == marker)
        else {
            return AckOutcome::Rejected;
        };
        let fresh = now.duration_since(pending.send_started) < DELIVERY_TIMEOUT;
        let was_sampled = self.sampled_this_stall;
        self.pending = None;
        if was_sampled && !self.awaiting_fresh_recovery {
            self.awaiting_fresh_recovery = true;
        } else if self.awaiting_fresh_recovery && fresh {
            self.awaiting_fresh_recovery = false;
            self.sampled_this_stall = false;
            return AckOutcome::Recovered(self.attempts);
        }
        AckOutcome::Accepted
    }

    fn tick(&mut self, now: Instant) -> Option<DiagnosticIncident> {
        if now.duration_since(self.last_tick) > OBSERVER_GAP {
            self.last_tick = now;
            self.pending = None;
            return None;
        }
        self.last_tick = now;
        let pending = self.pending.as_ref()?;
        if self.attempts >= MAX_SAMPLES
            || self.sampled_this_stall
            || self.sampling
            || now.duration_since(pending.send_started) < DELIVERY_TIMEOUT
        {
            return None;
        }
        self.attempts += 1;
        self.sampled_this_stall = true;
        self.sampling = true;
        Some(DiagnosticIncident {
            attempt: self.attempts,
            marker: pending.marker.clone(),
            send_started_at_ms: pending.send_started_at_ms,
            emit_finished_at_ms: pending.emit_finished_at_ms,
            emit_succeeded: pending.emit_succeeded,
            triggered_at_ms: wall_ms(),
            callbacks_at_trigger: self.counters.as_ref().map(|counters| counters.snapshot()),
            progress: self.progress.iter().cloned().collect(),
        })
    }
}

#[derive(Debug, PartialEq, Eq)]
enum AckOutcome {
    Rejected,
    Accepted,
    Recovered(u8),
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticIncident {
    attempt: u8,
    marker: Marker,
    send_started_at_ms: u64,
    emit_finished_at_ms: Option<u64>,
    emit_succeeded: Option<bool>,
    triggered_at_ms: u64,
    callbacks_at_trigger: Option<CallbackSnapshot>,
    progress: Vec<ProgressSnapshot>,
}

struct Run {
    id: String,
    folder: PathBuf,
    active: AtomicBool,
    observer_epoch: AtomicU64,
    state: Mutex<RunState>,
}

impl Run {
    fn is_active(&self, epoch: u64) -> bool {
        self.active.load(Ordering::Acquire) && self.observer_epoch.load(Ordering::Acquire) == epoch
    }
}

#[derive(Default)]
pub struct NativeStallDiagnostics {
    current: Mutex<Option<Arc<Run>>>,
    capture: Mutex<Option<(String, u64, Arc<CaptureCallbackCounters>)>>,
}

impl NativeStallDiagnostics {
    pub fn arm(&self, folder: PathBuf) -> Result<String, String> {
        if !folder.join("manifest.json").is_file() {
            return Err("Session recording is not active on disk".into());
        }
        let dir = folder.join("diagnostics/native-stall");
        fs::create_dir_all(&dir)
            .map_err(|error| format!("Cannot create diagnostics directory: {error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
                .map_err(|error| format!("Cannot restrict diagnostics directory: {error}"))?;
        }
        let capture = self
            .capture
            .lock()
            .map_err(|_| "Capture diagnostics lock failed")?;
        let mut current = self.current.lock().map_err(|_| "Diagnostics lock failed")?;
        if let Some(existing) = current.as_ref() {
            if existing.folder == dir {
                if existing.active.load(Ordering::Acquire) {
                    return Ok(existing.id.clone());
                }
                if let Ok(mut state) = existing.state.lock() {
                    state.pending = None;
                    state.last_tick = Instant::now();
                }
                let epoch = existing.observer_epoch.fetch_add(1, Ordering::AcqRel) + 1;
                existing.active.store(true, Ordering::Release);
                if let Err(error) = start_observer(existing.clone(), epoch) {
                    existing.active.store(false, Ordering::Release);
                    return Err(error);
                }
                return Ok(existing.id.clone());
            }
            existing.active.store(false, Ordering::Release);
            existing.observer_epoch.fetch_add(1, Ordering::AcqRel);
        }
        let run = Arc::new(Run {
            id: Uuid::new_v4().to_string(),
            folder: dir,
            active: AtomicBool::new(true),
            observer_epoch: AtomicU64::new(1),
            state: Mutex::new(RunState::new(Instant::now())),
        });
        if let Some((session_id, generation, counters)) = capture.as_ref() {
            if let Ok(mut state) = run.state.lock() {
                state.set_capture(session_id, *generation, counters.clone());
            }
        }
        start_observer(run.clone(), 1)?;
        let id = run.id.clone();
        *current = Some(run);
        Ok(id)
    }

    pub fn disarm(&self) {
        if let Ok(current) = self.current.lock() {
            if let Some(run) = current.as_ref() {
                run.active.store(false, Ordering::Release);
                run.observer_epoch.fetch_add(1, Ordering::AcqRel);
                if let Ok(mut state) = run.state.lock() {
                    state.pending = None;
                }
            }
        }
    }

    fn run(&self) -> Option<Arc<Run>> {
        self.current.lock().ok()?.as_ref().cloned()
    }

    pub fn set_capture(
        &self,
        session_id: &str,
        generation: u64,
        counters: Arc<CaptureCallbackCounters>,
    ) {
        if let Ok(mut capture) = self.capture.lock() {
            *capture = Some((session_id.to_owned(), generation, counters.clone()));
        }
        if let Some(run) = self.run() {
            if let Ok(mut state) = run.state.lock() {
                state.set_capture(session_id, generation, counters);
            }
        }
    }

    pub fn clear_capture(&self, session_id: &str, generation: u64) {
        if let Ok(mut capture) = self.capture.lock() {
            if capture
                .as_ref()
                .is_some_and(|capture| capture.0 == session_id && capture.1 == generation)
            {
                *capture = None;
            }
        }
        if let Some(run) = self.run() {
            if let Ok(mut state) = run.state.lock() {
                state.clear_capture(session_id, generation);
            }
        }
    }

    pub fn begin_event(&self, event: &NativeAudioLivenessEvent) -> Option<String> {
        let run = self.run()?;
        if !run.active.load(Ordering::Acquire) {
            return None;
        }
        let selected = run.state.lock().ok()?.begin(event, Instant::now());
        selected.then(|| run.id.clone())
    }

    pub fn finish_event(&self, event: &NativeAudioLivenessEvent, succeeded: bool) {
        if let Some(run) = self.run() {
            if let Ok(mut state) = run.state.lock() {
                state.finish(
                    &Marker {
                        capture_session_id: event.capture_session_id.clone(),
                        capture_generation: event.capture_generation,
                        snapshot_sequence: event.snapshot_sequence,
                    },
                    succeeded,
                );
            }
        }
    }

    fn acknowledge(&self, run_id: &str, marker: Marker) -> bool {
        let Some(run) = self.run() else {
            return false;
        };
        if run.id != run_id || !run.active.load(Ordering::Acquire) {
            return false;
        }
        let result = run
            .state
            .lock()
            .ok()
            .map(|mut state| state.acknowledge(&marker, Instant::now()));
        match result {
            Some(AckOutcome::Accepted) => true,
            Some(AckOutcome::Recovered(attempt)) => {
                let recovery = serde_json::json!({
                    "runId": run.id,
                    "attempt": attempt,
                    "atMs": wall_ms(),
                    "marker": marker,
                });
                let folder = run.folder.clone();
                let _ = thread::Builder::new()
                    .name("native-stall-recovery".into())
                    .spawn(move || {
                        let _ = fs::write(
                            folder.join(format!("recovery-{attempt}.json")),
                            recovery.to_string(),
                        );
                    });
                true
            }
            _ => false,
        }
    }
}

fn start_observer(run: Arc<Run>, epoch: u64) -> Result<(), String> {
    thread::Builder::new()
        .name("native-stall-observer".into())
        .spawn(move || observe(run, epoch))
        .map(|_| ())
        .map_err(|error| format!("Cannot start diagnostics observer: {error}"))
}

fn observe(run: Arc<Run>, epoch: u64) {
    while run.is_active(epoch) {
        thread::sleep(Duration::from_secs(1));
        if !run.is_active(epoch) {
            break;
        }
        let incident = run
            .state
            .lock()
            .ok()
            .and_then(|mut state| state.tick(Instant::now()));
        if let Some(incident) = incident {
            let sampling_run = run.clone();
            let worker_incident = incident.clone();
            let result = thread::Builder::new()
                .name("native-stall-sample".into())
                .spawn(move || {
                    sample_incident(&sampling_run, epoch, worker_incident);
                    if let Ok(mut state) = sampling_run.state.lock() {
                        state.sampling = false;
                    }
                });
            if result.is_err() {
                if let Ok(mut state) = run.state.lock() {
                    state.sampling = false;
                }
                let _ = fs::write(run.folder.join(format!("sample-{}.json.partial", incident.attempt)),
                    serde_json::json!({"incident": incident, "sampleStatus": "thread-spawn-failed"}).to_string());
            }
        }
    }
}

fn sample_incident(run: &Run, epoch: u64, incident: DiagnosticIncident) {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Report<'a> {
        run_id: &'a str,
        pid: u32,
        build_version: &'static str,
        incident: &'a DiagnosticIncident,
        sample_started_at_ms: u64,
        sample_finished_at_ms: u64,
        sample_status: &'a str,
        exit_code: Option<i32>,
        stack_file: Option<String>,
    }

    let attempt_marker = write_attempt_marker(run, &incident);
    let stack_name = format!("sample-{}.txt", incident.attempt);
    let stack_path = run.folder.join(&stack_name);
    let stderr_path = run
        .folder
        .join(format!("sample-{}.stderr.partial", incident.attempt));
    let started = wall_ms();
    let mut status;
    let mut exit_code = None;
    if run.is_active(epoch)
        && session_bytes(&run.folder).saturating_add(MAX_STACK_BYTES) <= MAX_SESSION_BYTES
    {
        #[cfg(target_os = "macos")]
        {
            let stderr = fs::File::create(&stderr_path);
            let child = stderr.and_then(|stderr| {
                Command::new("/usr/bin/sample")
                    .arg(std::process::id().to_string())
                    .arg("1")
                    .arg("10")
                    .arg("-file")
                    .arg(&stack_path)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::from(stderr))
                    .spawn()
            });
            match child {
                Ok(mut child) => {
                    let deadline = Instant::now() + Duration::from_secs(5);
                    loop {
                        if !run.is_active(epoch) || Instant::now() >= deadline {
                            let _ = child.kill();
                            let _ = child.wait();
                            status = if run.is_active(epoch) {
                                "timeout"
                            } else {
                                "cancelled"
                            };
                            break;
                        }
                        match child.try_wait() {
                            Ok(Some(exit)) => {
                                exit_code = exit.code();
                                status = if exit.success() {
                                    "completed"
                                } else {
                                    "failed"
                                };
                                break;
                            }
                            Ok(None) => thread::sleep(Duration::from_millis(50)),
                            Err(_) => {
                                let _ = child.kill();
                                let _ = child.wait();
                                status = "failed";
                                break;
                            }
                        }
                    }
                }
                Err(_) => status = "spawn-or-disk-failed",
            }
            if status == "failed" {
                if let Ok(stderr) = fs::read(&stderr_path) {
                    let message = String::from_utf8_lossy(&stderr[..stderr.len().min(4_096)]);
                    if message.contains("Operation not permitted")
                        || message.contains("Permission denied")
                    {
                        status = "permission-denied";
                    }
                }
            }
            let _ = fs::remove_file(&stderr_path);
        }
        #[cfg(not(target_os = "macos"))]
        {
            status = "unavailable";
        }
    } else {
        status = "capacity-or-disabled";
    }
    let stack_size = fs::metadata(&stack_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if status == "completed" && stack_size == 0 {
        status = "empty-stack";
    }
    if stack_size > MAX_STACK_BYTES {
        if let Ok(file) = fs::OpenOptions::new().write(true).open(&stack_path) {
            let _ = file.set_len(MAX_STACK_BYTES);
        }
        status = "truncated";
    }
    let report = Report {
        run_id: &run.id,
        pid: std::process::id(),
        build_version: env!("CARGO_PKG_VERSION"),
        incident: &incident,
        sample_started_at_ms: started,
        sample_finished_at_ms: wall_ms(),
        sample_status: status,
        exit_code,
        stack_file: stack_path.exists().then_some(stack_name),
    };
    match serde_json::to_vec_pretty(&report) {
        Ok(payload) => {
            publish_sample_report(run, incident.attempt, &payload, attempt_marker.as_deref());
        }
        Err(error) => {
            eprintln!("Native stall sample report encoding failed: {error}");
        }
    }
}

fn write_attempt_marker(run: &Run, incident: &DiagnosticIncident) -> Option<PathBuf> {
    use std::io::Write;

    let path = run
        .folder
        .join(format!("attempt-{}.json.partial", incident.attempt));
    let payload = serde_json::json!({
        "runId": run.id,
        "attempt": incident.attempt,
        "marker": incident.marker,
        "triggeredAtMs": incident.triggered_at_ms,
        "sampleStatus": "triggered",
    });
    let result = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .and_then(|mut file| file.write_all(payload.to_string().as_bytes()));
    match result {
        Ok(()) => Some(path),
        Err(error) => {
            eprintln!("Native stall attempt marker unavailable: {error}");
            None
        }
    }
}

fn publish_sample_report(run: &Run, attempt: u8, payload: &[u8], marker: Option<&std::path::Path>) {
    let final_path = run.folder.join(format!("sample-{attempt}.json"));
    let partial_path = final_path.with_extension("json.partial");
    let result =
        fs::write(&partial_path, payload).and_then(|_| fs::rename(&partial_path, &final_path));
    if let Err(error) = result {
        eprintln!("Native stall sample report unavailable: {error}");
        return;
    }
    if let Some(marker) = marker {
        if let Err(error) = fs::remove_file(marker) {
            eprintln!("Native stall attempt marker cleanup failed: {error}");
        }
    }
}

fn session_bytes(path: &PathBuf) -> u64 {
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| entry.metadata().ok())
        .map(|metadata| metadata.len())
        .sum()
}

fn wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[tauri::command]
pub fn set_native_stall_diagnostics(
    app: AppHandle,
    enabled: bool,
    folder_name: Option<String>,
) -> Result<Option<String>, String> {
    let diagnostics = app.state::<NativeStallDiagnostics>();
    if !enabled {
        diagnostics.disarm();
        return Ok(None);
    }
    let folder_name = folder_name.ok_or("Recording folder is required")?;
    if folder_name.is_empty()
        || folder_name != crate::sanitize_session_recording_folder_name(&folder_name)
    {
        return Err("Invalid recording folder name".into());
    }
    let folder = crate::meeting_session_recording_dir(&app, &folder_name)?;
    diagnostics.arm(folder).map(Some)
}

#[tauri::command]
pub async fn acknowledge_native_stall_marker(
    window: WebviewWindow,
    app: AppHandle,
    diagnostic_run_id: String,
    capture_session_id: String,
    capture_generation: u64,
    snapshot_sequence: u64,
) -> bool {
    if window.label() != "main" {
        return false;
    }
    app.state::<NativeStallDiagnostics>().acknowledge(
        &diagnostic_run_id,
        Marker {
            capture_session_id,
            capture_generation,
            snapshot_sequence,
        },
    )
}

#[cfg(debug_assertions)]
#[tauri::command]
pub fn debug_block_main_thread_for_stall_test(
    app: AppHandle,
    diagnostic_run_id: Option<String>,
) -> Result<(), String> {
    let diagnostics = app.state::<NativeStallDiagnostics>();
    if let Some(run_id) = diagnostic_run_id {
        let run = diagnostics
            .run()
            .ok_or("Native diagnostics are not armed")?;
        if run.id != run_id || !run.active.load(Ordering::Acquire) {
            return Err("Diagnostic session has changed".into());
        }
        if run
            .state
            .lock()
            .map_err(|_| "Diagnostics lock failed")?
            .capture
            .is_none()
        {
            return Err("Meeting capture is not active".into());
        }
    } else {
        if diagnostics
            .run()
            .is_some_and(|run| run.active.load(Ordering::Acquire))
        {
            return Err("Unarmed comparison requires diagnostics to be disabled".into());
        }
        if diagnostics
            .capture
            .lock()
            .map_err(|_| "Capture diagnostics lock failed")?
            .is_none()
        {
            return Err("Meeting capture is not active".into());
        }
    }
    if app.get_webview_window("main").is_none() {
        return Err("Main WebView is unavailable".into());
    }
    app.run_on_main_thread(|| thread::sleep(Duration::from_secs(12)))
        .map_err(|error| format!("Cannot schedule bounded main-thread test: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marker(sequence: u64) -> Marker {
        Marker {
            capture_session_id: "capture".into(),
            capture_generation: 1,
            snapshot_sequence: sequence,
        }
    }

    fn pending(sequence: u64, now: Instant) -> Pending {
        Pending {
            marker: marker(sequence),
            send_started: now,
            send_started_at_ms: 1,
            emit_finished_at_ms: Some(2),
            emit_succeeded: Some(true),
        }
    }

    fn progress(sequence: u64) -> ProgressSnapshot {
        ProgressSnapshot {
            at_ms: 1,
            marker: marker(sequence),
            callbacks: None,
            processed_chunk_count: 0,
            raw_signal_chunk_count: 0,
            raw_zero_duration_ms: 0,
            last_raw_signal_observed_at_ms: None,
            segment_emitted_count: 0,
        }
    }

    #[test]
    fn later_events_do_not_extend_an_unacknowledged_marker() {
        let now = Instant::now();
        let mut state = RunState::new(now);
        assert!(state.select_marker(marker(1), progress(1), now));
        assert!(!state.select_marker(marker(2), progress(2), now + Duration::from_secs(2)));
        assert_eq!(state.pending.as_ref().unwrap().marker, marker(1));
        assert_eq!(state.pending.as_ref().unwrap().send_started, now);
    }

    #[test]
    fn sampling_recovers_only_after_a_new_fresh_ack() {
        let now = Instant::now();
        let mut state = RunState::new(now);
        state.pending = Some(pending(1, now));
        state.sampled_this_stall = true;
        state.attempts = 1;
        assert_eq!(
            state.acknowledge(&marker(1), now + Duration::from_secs(7)),
            AckOutcome::Accepted
        );
        assert!(state.sampled_this_stall);
        assert!(state.select_marker(marker(2), progress(2), now + Duration::from_secs(8)));
        assert_eq!(
            state.acknowledge(&marker(2), now + Duration::from_secs(9)),
            AckOutcome::Recovered(1)
        );
        assert!(!state.sampled_this_stall);
        assert_eq!(state.attempts, 1);
    }

    #[test]
    fn another_diagnostic_session_cannot_acknowledge_the_pending_marker() {
        let now = Instant::now();
        let diagnostics = NativeStallDiagnostics::default();
        let mut state = RunState::new(now);
        state.pending = Some(pending(1, now));
        *diagnostics.current.lock().unwrap() = Some(Arc::new(Run {
            id: "run-a".into(),
            folder: std::env::temp_dir(),
            active: AtomicBool::new(true),
            observer_epoch: AtomicU64::new(1),
            state: Mutex::new(state),
        }));
        assert!(!diagnostics.acknowledge("run-b", marker(1)));
        assert!(diagnostics.acknowledge("run-a", marker(1)));
    }

    #[test]
    fn toggling_within_one_recording_preserves_quota_and_retires_old_observer() {
        let root = std::env::temp_dir().join(format!("jarvis-stall-test-{}", Uuid::new_v4()));
        let first = root.join("first");
        let second = root.join("second");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        fs::write(first.join("manifest.json"), "{}").unwrap();
        fs::write(second.join("manifest.json"), "{}").unwrap();

        let diagnostics = NativeStallDiagnostics::default();
        let first_id = diagnostics.arm(first.clone()).unwrap();
        let run = diagnostics.run().unwrap();
        run.state.lock().unwrap().attempts = 1;
        let first_epoch = run.observer_epoch.load(Ordering::Acquire);
        diagnostics.disarm();
        assert!(!run.is_active(first_epoch));
        assert_eq!(diagnostics.arm(first).unwrap(), first_id);
        assert_eq!(run.state.lock().unwrap().attempts, 1);
        assert!(!run.is_active(first_epoch));
        assert!(run.is_active(run.observer_epoch.load(Ordering::Acquire)));

        diagnostics.disarm();
        assert_ne!(diagnostics.arm(second).unwrap(), first_id);
        assert_eq!(diagnostics.run().unwrap().state.lock().unwrap().attempts, 0);
        diagnostics.disarm();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_emit_is_not_mistaken_for_unacknowledged_delivery() {
        let now = Instant::now();
        let mut state = RunState::new(now);
        state.pending = Some(pending(1, now));
        state.finish(&marker(1), false);
        assert!(state.pending.is_none());
        assert_eq!(state.attempts, 0);
    }

    #[test]
    fn two_failed_or_successful_attempts_exhaust_the_session_budget() {
        let now = Instant::now();
        let mut state = RunState::new(now);
        state.attempts = MAX_SAMPLES;
        state.pending = Some(pending(1, now));
        for second in 1..=7 {
            assert!(state.tick(now + Duration::from_secs(second)).is_none());
        }
        assert_eq!(state.attempts, MAX_SAMPLES);
    }

    #[test]
    fn stale_future_and_duplicate_ack_cannot_clear_current_marker() {
        let now = Instant::now();
        let mut state = RunState::new(now);
        state.pending = Some(pending(2, now));
        assert_eq!(state.acknowledge(&marker(1), now), AckOutcome::Rejected);
        assert_eq!(state.acknowledge(&marker(3), now), AckOutcome::Rejected);
        assert!(state.pending.is_some());
        assert_eq!(state.acknowledge(&marker(2), now), AckOutcome::Accepted);
        assert_eq!(state.acknowledge(&marker(2), now), AckOutcome::Rejected);
    }

    #[test]
    fn timeout_samples_once_and_keeps_session_quota_across_generations() {
        let now = Instant::now();
        let mut state = RunState::new(now);
        state.pending = Some(pending(1, now));
        for second in 1..=5 {
            assert!(state.tick(now + Duration::from_secs(second)).is_none());
        }
        assert!(state.tick(now + Duration::from_secs(6)).is_some());
        assert!(state.tick(now + Duration::from_secs(7)).is_none());
        state.clear_capture("capture", 1);
        assert_eq!(state.attempts, 1);
    }

    #[test]
    fn observer_gap_does_not_turn_sleep_into_stall() {
        let now = Instant::now();
        let mut state = RunState::new(now);
        state.pending = Some(pending(1, now));
        assert!(state.tick(now + Duration::from_secs(20)).is_none());
        assert!(state.pending.is_none());
        assert_eq!(state.attempts, 0);
    }

    #[test]
    fn attempt_marker_survives_failed_report_and_clears_after_publication() {
        let folder = std::env::temp_dir().join(format!("jarvis-stall-report-{}", Uuid::new_v4()));
        fs::create_dir(&folder).unwrap();
        let run = Run {
            id: "run-a".into(),
            folder: folder.clone(),
            active: AtomicBool::new(true),
            observer_epoch: AtomicU64::new(1),
            state: Mutex::new(RunState::new(Instant::now())),
        };
        let incident = DiagnosticIncident {
            attempt: 1,
            marker: marker(1),
            send_started_at_ms: 1,
            emit_finished_at_ms: None,
            emit_succeeded: None,
            triggered_at_ms: 2,
            callbacks_at_trigger: None,
            progress: Vec::new(),
        };
        let attempt_marker = write_attempt_marker(&run, &incident).unwrap();
        let content = fs::read_to_string(&attempt_marker).unwrap();
        let marker_payload: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(marker_payload["sampleStatus"], "triggered");
        assert_eq!(marker_payload["runId"], "run-a");
        assert_eq!(marker_payload["marker"]["captureSessionId"], "capture");
        assert!(marker_payload.get("transcript").is_none());
        let blocked_partial = folder.join("sample-1.json.partial");
        fs::create_dir(&blocked_partial).unwrap();
        publish_sample_report(
            &run,
            1,
            br#"{"sampleStatus":"failed"}"#,
            Some(&attempt_marker),
        );
        assert!(attempt_marker.is_file());
        assert!(!folder.join("sample-1.json").exists());
        fs::remove_dir(blocked_partial).unwrap();
        publish_sample_report(
            &run,
            1,
            br#"{"sampleStatus":"failed"}"#,
            Some(&attempt_marker),
        );
        assert!(!attempt_marker.exists());
        assert!(folder.join("sample-1.json").is_file());
        fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn already_unwritable_attempt_has_no_durable_marker() {
        let file = std::env::temp_dir().join(format!("jarvis-stall-no-dir-{}", Uuid::new_v4()));
        fs::write(&file, b"not a directory").unwrap();
        let run = Run {
            id: "run-a".into(),
            folder: file.clone(),
            active: AtomicBool::new(true),
            observer_epoch: AtomicU64::new(1),
            state: Mutex::new(RunState::new(Instant::now())),
        };
        let incident = DiagnosticIncident {
            attempt: 1,
            marker: marker(1),
            send_started_at_ms: 1,
            emit_finished_at_ms: None,
            emit_succeeded: None,
            triggered_at_ms: 2,
            callbacks_at_trigger: None,
            progress: Vec::new(),
        };
        assert!(write_attempt_marker(&run, &incident).is_none());
        fs::remove_file(file).unwrap();
    }
}
