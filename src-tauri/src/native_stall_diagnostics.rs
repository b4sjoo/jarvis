use crate::speaker::NativeAudioLivenessEvent;
use serde::Serialize;
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
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
                let mut command = Command::new("/usr/bin/sample");
                command
                    .arg(std::process::id().to_string())
                    .arg("1")
                    .arg("10")
                    .arg("-file")
                    .arg(&stack_path);
                command
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
                    status = failed_sample_status(&stderr);
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
        status = empty_stack_status(&stack_path);
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

fn failed_sample_status(stderr: &[u8]) -> &'static str {
    let message = String::from_utf8_lossy(&stderr[..stderr.len().min(4_096)]);
    if message.contains("Operation not permitted") || message.contains("Permission denied") {
        "permission-denied"
    } else {
        "failed"
    }
}

fn empty_stack_status(path: &Path) -> &'static str {
    match fs::OpenOptions::new().write(true).open(path) {
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => "permission-denied",
        _ => "empty-stack",
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
    let marker = Marker {
        capture_session_id,
        capture_generation,
        snapshot_sequence,
    };
    let diagnostics = app.state::<NativeStallDiagnostics>();
    diagnostics.acknowledge(&diagnostic_run_id, marker)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sampler_error_classification_keeps_existing_bounded_stderr_contract() {
        assert_eq!(
            failed_sample_status(b"Operation not permitted"),
            "permission-denied"
        );
        assert_eq!(
            failed_sample_status(b"Permission denied"),
            "permission-denied"
        );
        assert_eq!(failed_sample_status(b"unknown failure"), "failed");
        let mut long = vec![b'x'; 4_096];
        long.extend_from_slice(b"Permission denied");
        assert_eq!(failed_sample_status(&long), "failed");
    }

    #[test]
    #[ignore = "run in fresh processes under /usr/bin/time -l for paired memory attribution"]
    fn memory_probe_real_owner() {
        let mode = std::env::var("NSD_MEMORY_PROBE").expect("NSD_MEMORY_PROBE must be off or on");
        assert!(mode == "off" || mode == "on");
        let root = std::env::temp_dir().join(format!("jarvis-nsd-memory-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("manifest.json"), "{}").unwrap();

        let diagnostics = NativeStallDiagnostics::default();
        let counters = Arc::new(CaptureCallbackCounters::new());
        diagnostics.set_capture("capture", 1, counters.clone());
        let run = if mode == "on" {
            diagnostics.arm(root.clone()).unwrap();
            Some(diagnostics.run().unwrap())
        } else {
            None
        };
        let armed_at = Instant::now();
        for sequence in 1..=60 {
            counters.observe_entry();
            let selected = marker(sequence);
            let mut entry = progress(sequence);
            entry.at_ms = wall_ms();
            entry.callbacks = Some(counters.snapshot());
            if let Some(run) = &run {
                let mut state = run.state.lock().unwrap();
                assert!(state.select_marker(selected.clone(), entry, Instant::now()));
                state.finish(&selected, true);
                assert_eq!(
                    state.acknowledge(&selected, Instant::now()),
                    AckOutcome::Accepted
                );
            }
        }
        thread::sleep(Duration::from_millis(1_350));
        if let Some(run) = &run {
            let state = run.state.lock().unwrap();
            assert_eq!(state.progress.len(), 60);
            assert!(state.last_tick > armed_at, "real observer did not tick");
        }
        println!(
            "NSD_MEMORY_PROBE mode={mode} progress={} observer_tick={}",
            run.as_ref()
                .map_or(0, |run| run.state.lock().unwrap().progress.len()),
            run.as_ref()
                .is_some_and(|run| run.state.lock().unwrap().last_tick > armed_at)
        );
        diagnostics.disarm();
        fs::remove_dir_all(root).unwrap();
    }

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

    #[cfg(unix)]
    #[test]
    fn empty_stack_distinguishes_output_permission_from_other_empty_results() {
        use std::os::unix::fs::PermissionsExt;

        let file = std::env::temp_dir().join(format!("jarvis-stall-empty-{}", Uuid::new_v4()));
        fs::write(&file, b"").unwrap();
        assert_eq!(empty_stack_status(&file), "empty-stack");

        fs::set_permissions(&file, fs::Permissions::from_mode(0o000)).unwrap();
        assert_eq!(empty_stack_status(&file), "permission-denied");

        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        fs::remove_file(file).unwrap();
    }

    // ---------------------------------------------------------------------
    // 145/183 NDI formal diagnostics integration: native acceptance tests for
    // NDI3 (lifecycle), NDI4 (files and window) and NDI5 (log isolation).
    //
    // State tests use a bare `RunState` with synthetic instants. No test here
    // locks the state of a run that has a live observer, and none reaches the
    // spawning branch of `sample_incident`: every call goes through
    // `ndi_sample_without_spawning`, which refuses a run that could launch
    // `/usr/bin/sample`. The reports written here are therefore the
    // "capacity-or-disabled" kind and carry no stack. The outcomes that only
    // the real sampler produces ("completed", "failed", "permission-denied",
    // "timeout", "cancelled", "truncated", "spawn-or-disk-failed",
    // "empty-stack") are not exercised by these tests.
    // ---------------------------------------------------------------------

    /// Epoch an observer held before Stop. `disarm` clears `active` and bumps
    /// the epoch, so a stopped run is inactive under this value on both counts.
    const NDI_EPOCH_BEFORE_STOP: u64 = 1;

    /// Temporary tree removed on drop, so a failed assertion leaves nothing behind.
    struct NdiTempDir(PathBuf);

    impl NdiTempDir {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!("jarvis-ndi-{label}-{}", Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        /// A recording folder that is active on disk: it has a manifest file.
        fn recording(&self, name: &str) -> PathBuf {
            let folder = self.0.join(name);
            fs::create_dir(&folder).unwrap();
            fs::write(folder.join("manifest.json"), "{}").unwrap();
            folder
        }

        /// The diagnostics folder of a recording, created by hand for tests
        /// that build a `Run` without `arm`.
        fn diagnostics_folder(&self, name: &str) -> PathBuf {
            let folder = self.recording(name).join("diagnostics/native-stall");
            fs::create_dir_all(&folder).unwrap();
            folder
        }

        /// Every entry below the root as a sorted relative path; directories
        /// end with `/`.
        fn tree(&self) -> Vec<String> {
            fn visit(root: &Path, folder: &Path, entries: &mut Vec<String>) {
                for entry in fs::read_dir(folder).unwrap() {
                    let path = entry.unwrap().path();
                    let relative = path
                        .strip_prefix(root)
                        .unwrap()
                        .components()
                        .map(|component| component.as_os_str().to_string_lossy().into_owned())
                        .collect::<Vec<_>>()
                        .join("/");
                    if path.is_dir() {
                        entries.push(format!("{relative}/"));
                        visit(root, &path, entries);
                    } else {
                        entries.push(relative);
                    }
                }
            }
            let mut entries = Vec::new();
            visit(&self.0, &self.0, &mut entries);
            entries.sort();
            entries
        }
    }

    impl Drop for NdiTempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A run as `disarm` leaves it: inactive, with the epoch moved past the
    /// one its observer held. No observer thread exists for it.
    fn ndi_stopped_run(id: &str, folder: PathBuf) -> Run {
        Run {
            id: id.into(),
            folder,
            active: AtomicBool::new(false),
            observer_epoch: AtomicU64::new(NDI_EPOCH_BEFORE_STOP + 1),
            state: Mutex::new(RunState::new(Instant::now())),
        }
    }

    /// The only route by which these tests reach `sample_incident`. It refuses
    /// a run that could take the spawning branch, so the default suite cannot
    /// launch `/usr/bin/sample`.
    fn ndi_sample_without_spawning(run: &Run, epoch: u64, incident: DiagnosticIncident) {
        assert!(
            !run.active.load(Ordering::Acquire) && !run.is_active(epoch),
            "refusing to call sample_incident on a run that could spawn the sampler"
        );
        sample_incident(run, epoch, incident);
    }

    /// A progress entry whose payload differs per sequence, so a rolled or
    /// rewritten entry cannot pass for the original.
    fn ndi_progress(sequence: u64) -> ProgressSnapshot {
        let mut entry = progress(sequence);
        entry.at_ms = 1_000 + sequence * 2_000;
        entry.processed_chunk_count = sequence * 10;
        entry.segment_emitted_count = sequence;
        entry
    }

    fn ndi_sequences<'a>(entries: impl IntoIterator<Item = &'a ProgressSnapshot>) -> Vec<u64> {
        entries
            .into_iter()
            .map(|entry| entry.marker.snapshot_sequence)
            .collect()
    }

    fn ndi_span(first: u64, last: u64) -> Vec<u64> {
        (first..=last).collect()
    }

    /// A hand-built incident with fixed fields, for file tests that do not
    /// need the state machine.
    fn ndi_incident(attempt: u8) -> DiagnosticIncident {
        DiagnosticIncident {
            attempt,
            marker: marker(u64::from(attempt)),
            send_started_at_ms: 1,
            emit_finished_at_ms: Some(2),
            emit_succeeded: Some(true),
            triggered_at_ms: 3,
            callbacks_at_trigger: None,
            progress: vec![ndi_progress(1), ndi_progress(2)],
        }
    }

    fn ndi_read_json(path: &Path) -> serde_json::Value {
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }

    fn ndi_file_names(folder: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// Waits for a JSON file that the owner writes on a detached thread.
    fn ndi_wait_for_json(path: &Path) -> serde_json::Value {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let parsed = fs::read(path)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok());
            if let Some(value) = parsed {
                return value;
            }
            assert!(
                Instant::now() < deadline,
                "{} was not written",
                path.display()
            );
            thread::sleep(Duration::from_millis(5));
        }
    }

    /// Synthetic observer timeline over a bare `RunState`: one tick per
    /// synthetic second (inside `OBSERVER_GAP`), no thread and no real clock.
    struct NdiTimeline<'a> {
        state: RunState,
        run: &'a Run,
        base: Instant,
        second: u64,
    }

    impl<'a> NdiTimeline<'a> {
        fn new(run: &'a Run) -> Self {
            let base = Instant::now();
            Self {
                state: RunState::new(base),
                run,
                base,
                second: 0,
            }
        }

        fn now(&self) -> Instant {
            self.base + Duration::from_secs(self.second)
        }

        /// Advances one second and runs the body of `observe` once: tick, hand
        /// an incident to the sampler, clear `sampling` as the worker does.
        /// The run is stopped, so sampling takes the non-spawning branch.
        fn step(&mut self) -> Option<DiagnosticIncident> {
            self.second += 1;
            let incident = self.state.tick(self.now())?;
            ndi_sample_without_spawning(self.run, NDI_EPOCH_BEFORE_STOP, incident.clone());
            self.state.sampling = false;
            Some(incident)
        }

        fn quiet_steps(&mut self, seconds: u64) {
            for _ in 0..seconds {
                assert!(self.step().is_none());
            }
        }

        /// One second later, entry `sequence` is sent, emitted and
        /// acknowledged at once.
        fn deliver(&mut self, sequence: u64) -> AckOutcome {
            self.send_unacknowledged(sequence);
            self.state.acknowledge(&marker(sequence), self.now())
        }

        /// One second later, entry `sequence` is sent with a successful emit
        /// and no acknowledgement: the start of a stall.
        fn send_unacknowledged(&mut self, sequence: u64) {
            self.quiet_steps(1);
            let now = self.now();
            assert!(self
                .state
                .select_marker(marker(sequence), ndi_progress(sequence), now));
            self.state.finish(&marker(sequence), true);
        }

        /// One second later, entry `sequence` arrives while an older marker
        /// is still pending. It rolls the window and selects nothing.
        fn roll_during_stall(&mut self, sequence: u64) {
            self.quiet_steps(1);
            let now = self.now();
            assert!(!self
                .state
                .select_marker(marker(sequence), ndi_progress(sequence), now));
        }

        /// One second later, the page acknowledges the marker of a stall.
        fn late_ack(&mut self, sequence: u64) -> AckOutcome {
            self.quiet_steps(1);
            self.state.acknowledge(&marker(sequence), self.now())
        }

        fn window(&self) -> Vec<u64> {
            ndi_sequences(&self.state.progress)
        }
    }

    // NDI4 (a): rolling past 60 entries does not modify a frozen incident or
    // its report file, and a third stall does not overwrite the first two.
    #[test]
    fn ndi4_rolling_window_keeps_frozen_incidents_and_refuses_a_third_sample() {
        let temp = NdiTempDir::new("window");
        let folder = temp.diagnostics_folder("recording");
        let run = ndi_stopped_run("run-ndi4-window", folder.clone());
        let mut timeline = NdiTimeline::new(&run);

        // Sixty entries: 1..=59 delivered and acknowledged, 60 never acknowledged.
        for sequence in 1..=59 {
            assert_eq!(timeline.deliver(sequence), AckOutcome::Accepted);
        }
        timeline.send_unacknowledged(60);
        assert_eq!(timeline.window(), ndi_span(1, 60));

        // Stall one reaches the 6 s condition: incident one freezes 1..=60.
        timeline.quiet_steps(5);
        let first = timeline.step().expect("stall one meets the 6 s condition");
        assert_eq!(first.attempt, 1);
        assert_eq!(first.marker, marker(60));
        assert_eq!(ndi_sequences(&first.progress), ndi_span(1, 60));
        let first_frozen = serde_json::to_vec(&first).unwrap();
        let first_path = folder.join("sample-1.json");
        let first_report = fs::read(&first_path).unwrap();
        assert_eq!(ndi_file_names(&folder), ["sample-1.json"]);
        let first_parsed = ndi_read_json(&first_path);
        assert_eq!(first_parsed["sampleStatus"], "capacity-or-disabled");
        assert_eq!(
            first_parsed["incident"],
            serde_json::to_value(&first).unwrap()
        );
        assert_eq!(
            first_parsed["incident"]["progress"]
                .as_array()
                .unwrap()
                .len(),
            60
        );

        // The window keeps rolling to 130 entries: first while marker 60 is
        // still pending, then across the recovery, then in healthy delivery.
        timeline.roll_during_stall(61);
        assert_eq!(timeline.window(), ndi_span(2, 61));
        for sequence in 62..=65 {
            timeline.roll_during_stall(sequence);
        }
        assert_eq!(timeline.late_ack(60), AckOutcome::Accepted);
        assert_eq!(timeline.deliver(66), AckOutcome::Recovered(1));
        for sequence in 67..=129 {
            assert_eq!(timeline.deliver(sequence), AckOutcome::Accepted);
        }
        timeline.send_unacknowledged(130);
        assert_eq!(timeline.window(), ndi_span(71, 130));
        assert_eq!(serde_json::to_vec(&first).unwrap(), first_frozen);
        assert_eq!(ndi_sequences(&first.progress), ndi_span(1, 60));
        assert_eq!(fs::read(&first_path).unwrap(), first_report);

        // Stall two: incident two freezes 71..=130 and leaves report one alone.
        timeline.quiet_steps(5);
        let second = timeline.step().expect("stall two meets the 6 s condition");
        assert_eq!(second.attempt, 2);
        assert_eq!(second.marker, marker(130));
        assert_eq!(ndi_sequences(&second.progress), ndi_span(71, 130));
        let second_frozen = serde_json::to_vec(&second).unwrap();
        let second_path = folder.join("sample-2.json");
        let second_report = fs::read(&second_path).unwrap();
        assert_eq!(ndi_file_names(&folder), ["sample-1.json", "sample-2.json"]);
        assert_eq!(
            ndi_read_json(&second_path)["incident"],
            serde_json::to_value(&second).unwrap()
        );
        assert_eq!(fs::read(&first_path).unwrap(), first_report);

        // Later activity: the window rolls past everything incident two
        // froze, the stall recovers, and a third stall outlasts the 6 s
        // condition. Every tick runs the same observer body that wrote the
        // first two reports.
        for sequence in 131..=135 {
            timeline.roll_during_stall(sequence);
        }
        assert_eq!(timeline.late_ack(130), AckOutcome::Accepted);
        assert_eq!(timeline.deliver(136), AckOutcome::Recovered(2));
        for sequence in 137..=199 {
            assert_eq!(timeline.deliver(sequence), AckOutcome::Accepted);
        }
        timeline.send_unacknowledged(200);
        timeline.quiet_steps(10);

        // The third stall is real and unsampled; only the quota refuses it.
        let stalled = timeline.state.pending.as_ref().unwrap();
        assert_eq!(stalled.marker, marker(200));
        assert!(timeline.now().duration_since(stalled.send_started) >= DELIVERY_TIMEOUT);
        assert!(!timeline.state.sampled_this_stall && !timeline.state.sampling);
        assert_eq!(timeline.state.attempts, MAX_SAMPLES);
        assert_eq!(timeline.window(), ndi_span(141, 200));

        // No third sample file of any kind, and the first two are untouched.
        assert_eq!(ndi_file_names(&folder), ["sample-1.json", "sample-2.json"]);
        assert_eq!(fs::read(&first_path).unwrap(), first_report);
        assert_eq!(fs::read(&second_path).unwrap(), second_report);
        assert_eq!(serde_json::to_vec(&first).unwrap(), first_frozen);
        assert_eq!(serde_json::to_vec(&second).unwrap(), second_frozen);
    }

    // NDI4 (b): the diagnostics folder is `<recording>/diagnostics/native-stall`
    // and each run writes only under its own recording.
    #[test]
    fn ndi4_diagnostics_folder_is_derived_from_its_own_recording() {
        let temp = NdiTempDir::new("path");
        let first = temp.recording("first");
        let second = temp.recording("second");
        let diagnostics = NativeStallDiagnostics::default();

        // `arm` starts a real observer, so the run is stopped at once and its
        // state is never locked here; only its folder is used.
        let first_id = diagnostics.arm(first.clone()).unwrap();
        let first_run = diagnostics.run().unwrap();
        let first_epoch = first_run.observer_epoch.load(Ordering::Acquire);
        diagnostics.disarm();
        assert_eq!(
            first_run.folder,
            PathBuf::from(format!("{}/diagnostics/native-stall", first.display()))
        );
        assert!(first_run.folder.starts_with(&first));
        assert!(!first_run.folder.starts_with(&second));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&first_run.folder)
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        assert_eq!(
            temp.tree(),
            [
                "first/",
                "first/diagnostics/",
                "first/diagnostics/native-stall/",
                "first/manifest.json",
                "second/",
                "second/manifest.json",
            ]
        );

        ndi_sample_without_spawning(&first_run, first_epoch, ndi_incident(1));
        let first_report_path = first_run.folder.join("sample-1.json");
        let first_report = fs::read(&first_report_path).unwrap();
        assert_eq!(ndi_read_json(&first_report_path)["runId"], first_id);
        assert_eq!(
            temp.tree(),
            [
                "first/",
                "first/diagnostics/",
                "first/diagnostics/native-stall/",
                "first/diagnostics/native-stall/sample-1.json",
                "first/manifest.json",
                "second/",
                "second/manifest.json",
            ]
        );

        let second_id = diagnostics.arm(second.clone()).unwrap();
        let second_run = diagnostics.run().unwrap();
        let second_epoch = second_run.observer_epoch.load(Ordering::Acquire);
        diagnostics.disarm();
        assert_ne!(second_id, first_id);
        assert_eq!(
            second_run.folder,
            PathBuf::from(format!("{}/diagnostics/native-stall", second.display()))
        );
        assert!(!second_run.folder.starts_with(&first));

        ndi_sample_without_spawning(&second_run, second_epoch, ndi_incident(1));
        assert_eq!(
            ndi_read_json(&second_run.folder.join("sample-1.json"))["runId"],
            second_id
        );
        assert_eq!(fs::read(&first_report_path).unwrap(), first_report);
        assert_eq!(
            temp.tree(),
            [
                "first/",
                "first/diagnostics/",
                "first/diagnostics/native-stall/",
                "first/diagnostics/native-stall/sample-1.json",
                "first/manifest.json",
                "second/",
                "second/diagnostics/",
                "second/diagnostics/native-stall/",
                "second/diagnostics/native-stall/sample-1.json",
                "second/manifest.json",
            ]
        );
    }

    // NDI4 (b): a recording that is not active on disk cannot be armed, and
    // the refusal creates no folder, no file and no run.
    #[test]
    fn ndi4_missing_manifest_returns_on_disk_error_and_creates_nothing() {
        let temp = NdiTempDir::new("manifest");
        let without_manifest = temp.0.join("without-manifest");
        fs::create_dir(&without_manifest).unwrap();
        let manifest_is_a_directory = temp.0.join("manifest-is-a-directory");
        fs::create_dir_all(manifest_is_a_directory.join("manifest.json")).unwrap();
        let never_created = temp.0.join("never-created");
        let before = temp.tree();
        assert_eq!(
            before,
            [
                "manifest-is-a-directory/",
                "manifest-is-a-directory/manifest.json/",
                "without-manifest/",
            ]
        );

        let diagnostics = NativeStallDiagnostics::default();
        for folder in [without_manifest, manifest_is_a_directory, never_created] {
            assert_eq!(
                diagnostics.arm(folder),
                Err("Session recording is not active on disk".to_owned())
            );
        }
        assert!(diagnostics.run().is_none());
        assert_eq!(temp.tree(), before);
    }

    // NDI4 (c): a result that is not a completed sample is never labelled as
    // one. The existence of `sample-N.json` is not the completeness signal;
    // only `sampleStatus == "completed"` is, and nothing here may carry it.
    // Covered on the non-spawning branch: an attempt whose sampling did not
    // run, and an attempt whose report could not be published.
    #[test]
    fn ndi4_not_complete_result_is_never_reported_as_completed_evidence() {
        let temp = NdiTempDir::new("status");
        let folder = temp.diagnostics_folder("recording");
        let run = ndi_stopped_run("run-ndi4-status", folder.clone());

        // Sampling did not run: the published report says so and names no stack.
        ndi_sample_without_spawning(&run, NDI_EPOCH_BEFORE_STOP, ndi_incident(1));
        let report = ndi_read_json(&folder.join("sample-1.json"));
        assert_eq!(report["sampleStatus"], "capacity-or-disabled");
        assert_eq!(report["exitCode"], serde_json::Value::Null);
        assert_eq!(report["stackFile"], serde_json::Value::Null);
        assert_eq!(report["runId"], "run-ndi4-status");
        assert_eq!(report["incident"]["attempt"], 1);

        // The report cannot be published: only a `.partial` attempt marker
        // remains, still labelled "triggered", and no `sample-2.json` appears.
        let blocked_partial = folder.join("sample-2.json.partial");
        fs::create_dir(&blocked_partial).unwrap();
        ndi_sample_without_spawning(&run, NDI_EPOCH_BEFORE_STOP, ndi_incident(2));
        fs::remove_dir(&blocked_partial).unwrap();
        assert!(!folder.join("sample-2.json").exists());
        assert_eq!(
            ndi_read_json(&folder.join("attempt-2.json.partial"))["sampleStatus"],
            "triggered"
        );

        // Nothing in the folder claims a completed sample or holds a stack.
        let names = ndi_file_names(&folder);
        assert_eq!(names, ["attempt-2.json.partial", "sample-1.json"]);
        for name in &names {
            let status = ndi_read_json(&folder.join(name))["sampleStatus"].clone();
            assert!(status.is_string(), "{name} carries no sampleStatus");
            assert_ne!(status, "completed", "{name}");
        }
    }

    // NDI3: sampling requested after Stop takes the non-spawning branch. Stop
    // clears the pending marker, keeps the spent attempt and refuses a later
    // ACK. The run is registered by hand, so no observer thread exists for it.
    #[test]
    fn ndi3_sampling_requested_after_stop_takes_the_non_spawning_branch() {
        let temp = NdiTempDir::new("stop");
        let folder = temp.diagnostics_folder("recording");
        let base = Instant::now();
        let diagnostics = NativeStallDiagnostics::default();
        let run = Arc::new(Run {
            id: "run-ndi3-stop".into(),
            folder: folder.clone(),
            active: AtomicBool::new(true),
            observer_epoch: AtomicU64::new(NDI_EPOCH_BEFORE_STOP),
            state: Mutex::new(RunState::new(base)),
        });
        *diagnostics.current.lock().unwrap() = Some(run.clone());

        // A stall meets the 6 s condition while the run is still armed.
        let incident = {
            let mut state = run.state.lock().unwrap();
            assert!(state.select_marker(marker(1), ndi_progress(1), base));
            state.finish(&marker(1), true);
            for second in 1..=5 {
                assert!(state.tick(base + Duration::from_secs(second)).is_none());
            }
            state
                .tick(base + Duration::from_secs(6))
                .expect("the stall meets the 6 s condition")
        };
        assert!(run.is_active(NDI_EPOCH_BEFORE_STOP));

        // Stop arrives before the sampler starts.
        diagnostics.disarm();
        assert!(!run.is_active(NDI_EPOCH_BEFORE_STOP));
        {
            let state = run.state.lock().unwrap();
            assert!(state.pending.is_none());
            assert_eq!(state.attempts, 1);
        }

        ndi_sample_without_spawning(&run, NDI_EPOCH_BEFORE_STOP, incident);
        run.state.lock().unwrap().sampling = false;
        let report = ndi_read_json(&folder.join("sample-1.json"));
        assert_eq!(report["sampleStatus"], "capacity-or-disabled");
        assert_eq!(report["stackFile"], serde_json::Value::Null);
        assert_eq!(report["incident"]["attempt"], 1);

        // After Stop an ACK is refused before any recovery write is scheduled.
        assert!(!diagnostics.acknowledge("run-ndi3-stop", marker(1)));
        assert_eq!(ndi_file_names(&folder), ["sample-1.json"]);
        assert_eq!(run.state.lock().unwrap().attempts, 1);
    }

    // NDI3: a capture generation change drops the unrecovered stall of the old
    // generation but never resets the session quota.
    #[test]
    fn ndi3_capture_generation_change_keeps_the_session_quota() {
        let base = Instant::now();
        let at = |second: u64| base + Duration::from_secs(second);
        let generation_marker = |generation: u64| Marker {
            capture_session_id: "capture".into(),
            capture_generation: generation,
            snapshot_sequence: 1,
        };
        let counters = Arc::new(CaptureCallbackCounters::new());
        let mut state = RunState::new(base);
        let mut second = 0;
        let mut sampled = Vec::new();

        for generation in 1..=3 {
            state.set_capture("capture", generation, counters.clone());
            assert!(state.pending.is_none());
            assert!(!state.sampled_this_stall && !state.awaiting_fresh_recovery);
            if generation > 1 {
                assert_eq!(
                    state.acknowledge(&generation_marker(generation - 1), at(second)),
                    AckOutcome::Rejected
                );
            }

            // One stall per generation, ticked for eight seconds.
            let mut entry = progress(1);
            entry.marker = generation_marker(generation);
            assert!(state.select_marker(generation_marker(generation), entry, at(second)));
            state.finish(&generation_marker(generation), true);
            for _ in 0..8 {
                second += 1;
                if let Some(incident) = state.tick(at(second)) {
                    state.sampling = false;
                    sampled.push((incident.attempt, incident.marker.capture_generation));
                }
            }
        }

        // Generations 1 and 2 used the two attempts; generation 3 has a real,
        // unsampled stall that only the quota refuses.
        assert_eq!(sampled, [(1, 1), (2, 2)]);
        assert_eq!(state.attempts, MAX_SAMPLES);
        assert_eq!(state.pending.as_ref().unwrap().marker, generation_marker(3));
        assert!(!state.sampled_this_stall && !state.sampling);

        // A stale generation cannot clear the current capture; clearing the
        // current one still keeps the quota.
        state.clear_capture("capture", 2);
        assert_eq!(state.capture, Some(("capture".to_owned(), 3)));
        assert!(state.pending.is_some());
        state.clear_capture("capture", 3);
        assert!(state.capture.is_none() && state.pending.is_none());
        assert_eq!(state.attempts, MAX_SAMPLES);
    }

    // ---------------------------------------------------------------------
    // NDI5 log isolation.
    //
    // The crate has one logger, the ordinary diagnostic log
    // (`crate::diagnostic_log`): a `tracing` subscriber with a level threshold.
    // The app installs it process-wide at startup; the test process never does,
    // and this module does not log through it. The first three tests prove
    // that the dedicated evidence is written with no logger at all, that the
    // same evidence is written whatever debug-like or log-level-like variables
    // the process starts with, and that the production source consults no
    // Debug flag, environment variable, build-profile gate or logger. The
    // fourth is the five-level comparison (ERROR, WARN, INFO, DEBUG, TRACE):
    // with that subscriber installed for the test's own thread at each level,
    // the evidence is the same and none of it passes through the sink. A
    // thread this module spawns does not inherit a subscriber scoped to the
    // test thread; the source guard is what covers it. If a subscriber is ever
    // installed for the whole test process, `ndi5_assert_no_logger_installed`
    // fails; that is the cue to extend the comparison, not to delete the
    // assertion.
    //
    // The stack file `sample-N.txt` is written by `/usr/bin/sample` itself and
    // is outside these tests.
    // ---------------------------------------------------------------------

    const NDI5_EVIDENCE_PREFIX: &str = "NDI5_EVIDENCE=";

    fn ndi5_assert_no_logger_installed() {
        assert!(
            tracing::dispatcher::get_default(|current| {
                current.is::<tracing::subscriber::NoSubscriber>()
            }),
            "a tracing subscriber is installed process-wide: extend the five-level comparison"
        );
        assert!(
            !tracing::enabled!(tracing::Level::ERROR),
            "a logger level is enabled process-wide: extend the five-level comparison"
        );
    }

    /// Writes every dedicated evidence file that exists without the sampler
    /// (recovery file, sample report, attempt marker) and returns the content
    /// with wall-clock and process fields removed.
    fn ndi5_write_dedicated_evidence() -> serde_json::Value {
        let temp = NdiTempDir::new("log-isolation");
        let folder = temp.diagnostics_folder("recording");
        let diagnostics = NativeStallDiagnostics::default();
        let run = Arc::new(Run {
            id: "run-ndi5".into(),
            folder: folder.clone(),
            active: AtomicBool::new(true),
            observer_epoch: AtomicU64::new(NDI_EPOCH_BEFORE_STOP),
            state: Mutex::new(RunState::new(Instant::now())),
        });
        *diagnostics.current.lock().unwrap() = Some(run.clone());

        // Recovery file: written by the owner while the run is armed. The run
        // is registered by hand, so no observer thread exists for it.
        {
            let mut state = run.state.lock().unwrap();
            state.attempts = 1;
            state.sampled_this_stall = true;
            state.awaiting_fresh_recovery = true;
            state.pending = Some(pending(2, Instant::now()));
        }
        assert!(diagnostics.acknowledge("run-ndi5", marker(2)));
        let mut recovery = ndi_wait_for_json(&folder.join("recovery-1.json"));

        // Sample report and attempt marker: written after Stop, so that
        // sampling takes the non-spawning branch.
        diagnostics.disarm();
        ndi_sample_without_spawning(&run, NDI_EPOCH_BEFORE_STOP, ndi_incident(1));
        let mut report = ndi_read_json(&folder.join("sample-1.json"));
        let attempt_marker = write_attempt_marker(&run, &ndi_incident(2)).unwrap();
        let attempt_marker = ndi_read_json(&attempt_marker);

        for volatile in ["pid", "sampleStartedAtMs", "sampleFinishedAtMs"] {
            assert!(report.as_object_mut().unwrap().remove(volatile).is_some());
        }
        assert!(recovery.as_object_mut().unwrap().remove("atMs").is_some());
        serde_json::json!({
            "files": ndi_file_names(&folder),
            "attemptMarker": attempt_marker,
            "sampleReport": report,
            "recovery": recovery,
        })
    }

    // NDI5: the dedicated evidence is saved with no logger installed and with
    // no Debug input of any kind; none of the evidence functions takes one.
    #[test]
    fn ndi5_dedicated_evidence_is_written_with_no_logger_installed() {
        ndi5_assert_no_logger_installed();
        let evidence = ndi5_write_dedicated_evidence();
        ndi5_assert_no_logger_installed();

        assert_eq!(
            evidence["files"],
            serde_json::json!(["attempt-2.json.partial", "recovery-1.json", "sample-1.json"])
        );
        assert_eq!(
            evidence["attemptMarker"],
            serde_json::json!({
                "runId": "run-ndi5",
                "attempt": 2,
                "marker": {
                    "captureSessionId": "capture",
                    "captureGeneration": 1,
                    "snapshotSequence": 2,
                },
                "triggeredAtMs": 3,
                "sampleStatus": "triggered",
            })
        );
        assert_eq!(
            evidence["recovery"],
            serde_json::json!({
                "runId": "run-ndi5",
                "attempt": 1,
                "marker": {
                    "captureSessionId": "capture",
                    "captureGeneration": 1,
                    "snapshotSequence": 2,
                },
            })
        );
        let report = &evidence["sampleReport"];
        assert_eq!(report["runId"], "run-ndi5");
        assert_eq!(report["sampleStatus"], "capacity-or-disabled");
        assert_eq!(
            report["incident"],
            serde_json::to_value(ndi_incident(1)).unwrap()
        );

        // Read by `ndi5_dedicated_evidence_ignores_debug_and_log_level_environment`,
        // which runs this test again in fresh processes.
        println!("\n{NDI5_EVIDENCE_PREFIX}{evidence}");
    }

    // NDI5: the same evidence is saved whatever debug-like or log-level-like
    // variables the process starts with. The variables are given to fresh
    // child processes of this test binary, the way a real switch would arrive,
    // instead of mutating the environment of this multi-threaded process.
    #[test]
    fn ndi5_dedicated_evidence_ignores_debug_and_log_level_environment() {
        // (name, most restrictive value, most verbose value)
        const SWITCHES: [(&str, &str, &str); 7] = [
            ("DEBUG", "0", "1"),
            ("JARVIS_DEBUG", "false", "true"),
            ("JARVIS_DEBUG_MODE", "false", "true"),
            ("TAURI_ENV_DEBUG", "false", "true"),
            ("RUST_LOG", "off", "trace"),
            ("LOG_LEVEL", "off", "trace"),
            ("JARVIS_LOG_LEVEL", "off", "trace"),
        ];
        let child_test = format!(
            "{}::ndi5_dedicated_evidence_is_written_with_no_logger_installed",
            module_path!().split_once("::").unwrap().1
        );

        let mut evidence = vec![ndi5_write_dedicated_evidence().to_string()];
        for profile in ["absent", "most restrictive", "most verbose"] {
            let mut command = Command::new(std::env::current_exe().unwrap());
            command.args(["--exact", &child_test, "--nocapture"]);
            for (name, restrictive, verbose) in SWITCHES {
                match profile {
                    "absent" => command.env_remove(name),
                    "most restrictive" => command.env(name, restrictive),
                    _ => command.env(name, verbose),
                };
            }
            let output = command.output().unwrap();
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(
                output.status.success() && stdout.contains("test result: ok. 1 passed; 0 failed"),
                "profile {profile}\n{stdout}\n{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let line = stdout
                .lines()
                .find_map(|line| line.strip_prefix(NDI5_EVIDENCE_PREFIX))
                .unwrap_or_else(|| panic!("profile {profile} printed no evidence\n{stdout}"));
            evidence.push(line.to_owned());
        }

        assert_eq!(evidence.len(), 4);
        for other in &evidence[1..] {
            assert_eq!(other, &evidence[0]);
        }
    }

    // NDI5: with the ordinary diagnostic log's subscriber installed at each of
    // its five levels, the dedicated evidence is the one written with no
    // logger, and nothing of it passes through the sink.
    #[test]
    fn ndi5_dedicated_evidence_is_identical_at_each_of_the_five_log_levels() {
        ndi5_assert_no_logger_installed();
        let without_logger = ndi5_write_dedicated_evidence();

        for level in ["error", "warn", "info", "debug", "trace"] {
            let log = crate::diagnostic_log::tests::TestSink::started("ndi5");
            let applied = serde_json::to_value(log.apply(level).applied_level).unwrap();
            assert_eq!(applied, level);

            let evidence = tracing::dispatcher::with_default(&log.dispatch(), || {
                assert!(
                    !tracing::dispatcher::get_default(|current| {
                        current.is::<tracing::subscriber::NoSubscriber>()
                    }),
                    "the sink's subscriber is this thread's default"
                );
                let evidence = ndi5_write_dedicated_evidence();
                // Proves that the sink was live while the evidence was written:
                // an error passes every threshold.
                tracing::error!(target: "jarvis_lib::speaker::commands", "ndi5 sink canary");
                evidence
            });
            ndi5_assert_no_logger_installed();
            assert_eq!(evidence, without_logger, "level {level}");

            log.finish();
            let lines = log.file_lines();
            assert_eq!(lines.len(), 1, "level {level}: {lines:?}");
            assert_eq!(lines[0]["message"], "ndi5 sink canary");
            for output in [log.file_text(), log.terminal_text()] {
                assert_eq!(output.lines().count(), 1, "level {level}: {output}");
                for evidence_text in [
                    "run-ndi5",
                    "native-stall",
                    "recovery",
                    "sample",
                    "attempt",
                    "capture",
                    "capacity-or-disabled",
                ] {
                    assert!(
                        !output.contains(evidence_text),
                        "level {level}: {evidence_text} reached the sink"
                    );
                }
            }
        }
    }

    // NDI5 source guard over the production part of this file (everything
    // above the test module). It is textual: it catches a direct read, not one
    // hidden behind a helper in another module.
    #[test]
    fn ndi5_production_source_reads_no_debug_flag_environment_or_log_filter() {
        let source = include_str!("native_stall_diagnostics.rs");
        let (production, _tests) = source
            .split_once("\n#[cfg(test)]\nmod tests {")
            .expect("the test module marker separates production from tests");
        for owner in [
            "pub fn arm(",
            "fn acknowledge(",
            "fn observe(",
            "fn sample_incident(",
            "fn write_attempt_marker(",
            "fn publish_sample_report(",
        ] {
            assert!(production.contains(owner), "production part lost {owner}");
        }
        assert!(!production.contains("#[test]"));
        let lowered = production.to_ascii_lowercase();

        for (index, line) in production.lines().enumerate() {
            let number = index + 1;
            // Debug: the word appears only in derive lists.
            if line.to_ascii_lowercase().contains("debug") {
                assert!(
                    line.trim_start().starts_with("#[derive("),
                    "line {number} consults something named debug: {line}"
                );
            }
            // Build gates: platform only, no build profile and no feature.
            if line.contains("cfg") {
                assert!(
                    [
                        "#[cfg(unix)]",
                        "#[cfg(target_os = \"macos\")]",
                        "#[cfg(not(target_os = \"macos\"))]",
                    ]
                    .contains(&line.trim()),
                    "line {number} adds a build gate: {line}"
                );
            }
        }

        // Environment: no runtime read. The one compile-time read is the
        // build version written into the report.
        for needle in [
            "std::env",
            "env::var",
            "var_os",
            "getenv",
            "option_env!",
            "dotenv",
        ] {
            assert!(!lowered.contains(needle), "production reads {needle}");
        }
        assert_eq!(production.matches("env!(").count(), 1);
        assert!(production.contains("build_version: env!(\"CARGO_PKG_VERSION\")"));

        // Logger: not referenced at all, so no level can filter a write.
        for needle in [
            "tracing",
            "log::",
            "log_level",
            "loglevel",
            "levelfilter",
            "level::",
            "max_level",
            "enabled!(",
            "rust_log",
        ] {
            assert!(!lowered.contains(needle), "production references {needle}");
        }
    }
}
