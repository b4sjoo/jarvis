use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};
use uuid::Uuid;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

const CALL_RECORDINGS_DIR: &str = "call-session-recordings";
const STATUS_FILE: &str = "recording-state.json";
const EVENTS_FILE: &str = "events.jsonl";
const MANIFEST_FILE: &str = "manifest.json";
const EXPORTS_DIR: &str = "exports";
const MAX_EVENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_SESSION_ID_CHARS: usize = 160;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CallRecordingState {
    Open,
    Closing,
    Closed,
    CloseFailed,
    Abandoned,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CallRecordingHealth {
    #[default]
    Healthy,
    Incomplete,
    CloseFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CallRecordingCompleteness {
    pub health: CallRecordingHealth,
    pub attempted_event_count: u64,
    pub persisted_event_count: u64,
    pub dropped_event_count: u64,
    #[serde(default)]
    pub incompleteness_reasons: Vec<String>,
    pub terminal_state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CallRecordingStatus {
    pub call_session_id: String,
    pub recording_path: String,
    pub state: CallRecordingState,
    pub attempt: u32,
    pub event_count: u64,
    #[serde(default)]
    pub attempted_event_count: u64,
    #[serde(default)]
    pub persisted_event_count: u64,
    #[serde(default)]
    pub dropped_event_count: u64,
    #[serde(default)]
    pub health: CallRecordingHealth,
    #[serde(default)]
    pub incompleteness_reasons: Vec<String>,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CallRecordingSummary {
    pub status: CallRecordingStatus,
    pub human_evaluation_count: u64,
    pub manifest_available: bool,
    pub integrity_error: Option<String>,
    pub audio_recording: Option<crate::call_audio_evidence::CallAudioRecordingSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CallRecordingEvent {
    event_id: String,
    call_session_id: String,
    sequence: u64,
    kind: String,
    occurred_at: u64,
    payload: Value,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CallRecordingManifest {
    version: u32,
    call_session_id: String,
    started_at: u64,
    ended_at: u64,
    event_count: u64,
    events_sha256: String,
    raw_audio_retained: bool,
    #[serde(default)]
    audio_recording: Option<crate::call_audio_evidence::CallAudioRecordingSummary>,
    #[serde(default)]
    health: CallRecordingHealth,
    #[serde(default)]
    attempted_event_count: u64,
    #[serde(default)]
    persisted_event_count: u64,
    #[serde(default)]
    dropped_event_count: u64,
    #[serde(default)]
    incompleteness_reasons: Vec<String>,
    #[serde(default)]
    terminal_state: String,
}

#[tauri::command]
pub fn start_call_recording(
    app: AppHandle,
    call_session_id: String,
    started_at: u64,
) -> Result<CallRecordingStatus, String> {
    let root = recordings_root(&app)?;
    start_at_root(&root, &call_session_id, started_at)
}

#[tauri::command]
pub fn append_call_recording_event(
    app: AppHandle,
    call_session_id: String,
    event_payload: String,
) -> Result<CallRecordingStatus, String> {
    if event_payload.len() > MAX_EVENT_BYTES {
        return Err("Call recording event exceeds the size limit.".to_string());
    }
    let root = recordings_root(&app)?;
    append_at_root(&root, &call_session_id, &event_payload)
}

#[tauri::command]
pub fn mark_call_recording_incomplete(
    app: AppHandle,
    call_session_id: String,
    reason: String,
) -> Result<CallRecordingStatus, String> {
    let root = recordings_root(&app)?;
    mark_incomplete_at_root(&root, &call_session_id, &reason)
}

#[tauri::command]
pub fn close_call_recording(
    app: AppHandle,
    call_session_id: String,
    ended_at: u64,
    completeness: Option<CallRecordingCompleteness>,
) -> Result<CallRecordingStatus, String> {
    let root = recordings_root(&app)?;
    close_at_root(&root, &call_session_id, ended_at, completeness.as_ref())
}

#[tauri::command]
pub fn retry_call_recording_close(
    app: AppHandle,
    call_session_id: String,
    ended_at: u64,
    completeness: Option<CallRecordingCompleteness>,
) -> Result<CallRecordingStatus, String> {
    let root = recordings_root(&app)?;
    close_at_root(&root, &call_session_id, ended_at, completeness.as_ref())
}

#[tauri::command]
pub fn abandon_call_recording(
    app: AppHandle,
    call_session_id: String,
    occurred_at: u64,
    completeness: Option<CallRecordingCompleteness>,
) -> Result<CallRecordingStatus, String> {
    let root = recordings_root(&app)?;
    abandon_at_root(&root, &call_session_id, occurred_at, completeness.as_ref())
}

#[tauri::command]
pub fn list_recoverable_call_recordings(
    app: AppHandle,
) -> Result<Vec<CallRecordingStatus>, String> {
    let root = recordings_root(&app)?;
    list_recoverable_at_root(&root)
}

#[tauri::command]
pub fn list_call_recordings(app: AppHandle) -> Result<Vec<CallRecordingSummary>, String> {
    let root = recordings_root(&app)?;
    list_all_at_root(&root)
}

#[tauri::command]
pub fn reveal_call_recordings_root(app: AppHandle) -> Result<(), String> {
    let root = recordings_root(&app)?;
    fs::create_dir_all(&root)
        .map_err(|error| format!("Failed to create call recordings directory: {error}"))?;
    reveal_path(&root, false)
}

#[tauri::command]
pub fn reveal_call_recording(app: AppHandle, call_session_id: String) -> Result<(), String> {
    let root = recordings_root(&app)?;
    let session_dir = session_dir(&root, &call_session_id)?;
    reject_symlink(&session_dir)?;
    if !session_dir.is_dir() {
        return Err("Call recording does not exist.".to_string());
    }
    reveal_path(&session_dir, false)
}

#[tauri::command]
pub fn export_call_recording(app: AppHandle, call_session_id: String) -> Result<String, String> {
    let root = recordings_root(&app)?;
    let exported = export_at_root(&root, &call_session_id)?;
    reveal_path(&exported, true)?;
    Ok(exported.to_string_lossy().to_string())
}

pub(crate) fn recordings_root(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    Ok(app_data.join(CALL_RECORDINGS_DIR))
}

fn start_at_root(
    recordings_root: &Path,
    call_session_id: &str,
    started_at: u64,
) -> Result<CallRecordingStatus, String> {
    validate_session_id(call_session_id)?;
    reject_symlink(recordings_root)?;
    fs::create_dir_all(recordings_root)
        .map_err(|error| format!("Failed to create call recordings directory: {error}"))?;
    reject_symlink(recordings_root)?;

    let session_dir = session_dir(recordings_root, call_session_id)?;
    reject_symlink(&session_dir)?;
    if session_dir.exists() {
        let existing = read_status(&session_dir)?;
        if existing.state == CallRecordingState::Closed
            || existing.state == CallRecordingState::Abandoned
        {
            return Err("Call recording already reached a terminal state.".to_string());
        }
        return Ok(existing);
    }

    fs::create_dir(&session_dir)
        .map_err(|error| format!("Failed to create call recording: {error}"))?;
    File::create(session_dir.join(EVENTS_FILE))
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("Failed to initialize call recording events: {error}"))?;

    let status = CallRecordingStatus {
        call_session_id: call_session_id.to_string(),
        recording_path: session_dir.to_string_lossy().to_string(),
        state: CallRecordingState::Open,
        attempt: 0,
        event_count: 0,
        attempted_event_count: 0,
        persisted_event_count: 0,
        dropped_event_count: 0,
        health: CallRecordingHealth::Healthy,
        incompleteness_reasons: Vec::new(),
        started_at,
        ended_at: None,
        last_error: None,
    };
    write_status(&session_dir, &status)?;
    Ok(status)
}

fn append_at_root(
    recordings_root: &Path,
    call_session_id: &str,
    event_payload: &str,
) -> Result<CallRecordingStatus, String> {
    validate_session_id(call_session_id)?;
    let session_dir = session_dir(recordings_root, call_session_id)?;
    reject_symlink(&session_dir)?;
    let mut status = read_status(&session_dir)?;
    if !matches!(
        status.state,
        CallRecordingState::Open | CallRecordingState::CloseFailed
    ) {
        return Err("Call recording is not open for events.".to_string());
    }

    let event: CallRecordingEvent = serde_json::from_str(event_payload)
        .map_err(|error| format!("Invalid call recording event: {error}"))?;
    if event.call_session_id != call_session_id {
        return Err("Call recording event belongs to another session.".to_string());
    }
    if event.sequence != status.event_count.saturating_add(1) {
        return Err("Call recording event sequence is not contiguous.".to_string());
    }
    validate_event_token(&event.event_id, "event id")?;
    validate_event_token(&event.kind, "event kind")?;

    let serialized = serde_json::to_string(&event)
        .map_err(|error| format!("Failed to serialize call recording event: {error}"))?;
    let events_path = session_dir.join(EVENTS_FILE);
    reject_symlink(&events_path)?;
    let mut file = OpenOptions::new()
        .create(false)
        .append(true)
        .open(&events_path)
        .map_err(|error| format!("Failed to open call recording events: {error}"))?;
    file.write_all(serialized.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_data())
        .map_err(|error| format!("Failed to append call recording event: {error}"))?;

    status.event_count = event.sequence;
    status.attempted_event_count = status.attempted_event_count.saturating_add(1);
    status.persisted_event_count = event.sequence;
    write_status(&session_dir, &status)?;
    Ok(status)
}

fn mark_incomplete_at_root(
    recordings_root: &Path,
    call_session_id: &str,
    reason: &str,
) -> Result<CallRecordingStatus, String> {
    validate_session_id(call_session_id)?;
    let session_dir = session_dir(recordings_root, call_session_id)?;
    reject_symlink(&session_dir)?;
    let mut status = read_status(&session_dir)?;
    if !matches!(
        status.state,
        CallRecordingState::Open | CallRecordingState::CloseFailed
    ) {
        return Err("Call recording no longer accepts integrity updates.".to_string());
    }
    let normalized = reason.trim();
    if normalized.is_empty() {
        return Err("Call recording incompleteness reason is required.".to_string());
    }
    let normalized: String = normalized.chars().take(500).collect();
    status.health = CallRecordingHealth::Incomplete;
    if !status.incompleteness_reasons.contains(&normalized) {
        status.incompleteness_reasons.push(normalized);
    }
    write_status(&session_dir, &status)?;
    Ok(status)
}

fn close_at_root(
    recordings_root: &Path,
    call_session_id: &str,
    ended_at: u64,
    completeness: Option<&CallRecordingCompleteness>,
) -> Result<CallRecordingStatus, String> {
    validate_session_id(call_session_id)?;
    let session_dir = session_dir(recordings_root, call_session_id)?;
    reject_symlink(&session_dir)?;
    let mut status = read_status(&session_dir)?;
    if status.state == CallRecordingState::Closed {
        return Ok(status);
    }
    if status.state == CallRecordingState::Abandoned {
        return Err("Abandoned call recording cannot be closed.".to_string());
    }

    status.state = CallRecordingState::Closing;
    status.attempt = status.attempt.saturating_add(1);
    status.ended_at = Some(ended_at);
    status.last_error = None;
    apply_completeness(&mut status, completeness, "closed")?;
    write_status(&session_dir, &status)?;

    let close_result = (|| {
        let events_path = session_dir.join(EVENTS_FILE);
        let (events_sha256, line_count) = hash_events(&events_path)?;
        if line_count != status.event_count {
            return Err("Call recording event count does not match the event log.".to_string());
        }
        validate_event_log(&events_path, call_session_id, status.event_count)?;
        if status.persisted_event_count != status.event_count {
            return Err("Call recording persisted count does not match the event log.".to_string());
        }
        let audio_recording = match crate::call_audio_evidence::finalize_temporary_retention(
            &session_dir,
            ended_at,
        ) {
            Ok(manifest) => manifest.as_ref().map(crate::call_audio_evidence::summarize),
            Err(error) => {
                status.health = CallRecordingHealth::Incomplete;
                status
                    .incompleteness_reasons
                    .push(format!("audio-retention-finalize:{error}"));
                write_status(&session_dir, &status)?;
                None
            }
        };
        let raw_audio_retained = audio_recording.as_ref().is_some_and(|audio| {
            audio.retention_mode
                != crate::call_audio_evidence::CallAudioRetentionMode::Deleted
                && audio.chunk_count > 0
        });
        let manifest = CallRecordingManifest {
            version: 3,
            call_session_id: call_session_id.to_string(),
            started_at: status.started_at,
            ended_at,
            event_count: status.event_count,
            events_sha256,
            raw_audio_retained,
            audio_recording,
            health: status.health.clone(),
            attempted_event_count: status.attempted_event_count,
            persisted_event_count: status.persisted_event_count,
            dropped_event_count: status.dropped_event_count,
            incompleteness_reasons: status.incompleteness_reasons.clone(),
            terminal_state: "closed".to_string(),
        };
        write_json_atomically(&session_dir.join(MANIFEST_FILE), &manifest)
    })();

    match close_result {
        Ok(()) => {
            status.state = CallRecordingState::Closed;
            write_status(&session_dir, &status)?;
            Ok(status)
        }
        Err(error) => {
            status.state = CallRecordingState::CloseFailed;
            status.health = CallRecordingHealth::CloseFailed;
            status.last_error = Some(error.clone());
            let _ = write_status(&session_dir, &status);
            Err(error)
        }
    }
}

fn abandon_at_root(
    recordings_root: &Path,
    call_session_id: &str,
    occurred_at: u64,
    completeness: Option<&CallRecordingCompleteness>,
) -> Result<CallRecordingStatus, String> {
    validate_session_id(call_session_id)?;
    let session_dir = session_dir(recordings_root, call_session_id)?;
    reject_symlink(&session_dir)?;
    let mut status = read_status(&session_dir)?;
    if !matches!(
        status.state,
        CallRecordingState::Open | CallRecordingState::Closing | CallRecordingState::CloseFailed
    ) {
        return Err("Call recording is not recoverable.".to_string());
    }
    status.state = CallRecordingState::Abandoned;
    status.ended_at = Some(occurred_at);
    apply_completeness(&mut status, completeness, "abandoned")?;
    write_status(&session_dir, &status)?;
    Ok(status)
}

fn list_recoverable_at_root(recordings_root: &Path) -> Result<Vec<CallRecordingStatus>, String> {
    reject_symlink(recordings_root)?;
    if !recordings_root.exists() {
        return Ok(Vec::new());
    }
    let mut recoverable = Vec::new();
    for entry in fs::read_dir(recordings_root)
        .map_err(|error| format!("Failed to read call recordings directory: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Failed to inspect call recording: {error}"))?;
        let path = entry.path();
        reject_symlink(&path)?;
        if !path.is_dir() {
            continue;
        }
        let Ok(status) = read_status(&path) else {
            continue;
        };
        if matches!(
            status.state,
            CallRecordingState::Open
                | CallRecordingState::Closing
                | CallRecordingState::CloseFailed
        ) {
            recoverable.push(status);
        }
    }
    recoverable.sort_by_key(|status| status.started_at);
    Ok(recoverable)
}

fn list_all_at_root(recordings_root: &Path) -> Result<Vec<CallRecordingSummary>, String> {
    reject_symlink(recordings_root)?;
    if !recordings_root.exists() {
        return Ok(Vec::new());
    }
    let mut recordings = Vec::new();
    for entry in fs::read_dir(recordings_root)
        .map_err(|error| format!("Failed to read call recordings directory: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Failed to inspect call recording: {error}"))?;
        let path = entry.path();
        reject_symlink(&path)?;
        if !path.is_dir() || entry.file_name() == EXPORTS_DIR {
            continue;
        }
        let Ok(status) = read_status(&path) else {
            continue;
        };
        let human_evaluation_count =
            count_event_kind(&path.join(EVENTS_FILE), "human-evaluation").unwrap_or(0);
        let integrity_error = verify_recording_integrity(&path, &status).err();
        let audio_recording = crate::call_audio_evidence::read_for_session_dir(&path)
            .ok()
            .flatten()
            .as_ref()
            .map(crate::call_audio_evidence::summarize);
        recordings.push(CallRecordingSummary {
            status,
            human_evaluation_count,
            manifest_available: path.join(MANIFEST_FILE).is_file(),
            integrity_error,
            audio_recording,
        });
    }
    recordings.sort_by(|left, right| right.status.started_at.cmp(&left.status.started_at));
    Ok(recordings)
}

fn count_event_kind(path: &Path, target_kind: &str) -> Result<u64, String> {
    reject_symlink(path)?;
    let file = File::open(path)
        .map_err(|error| format!("Failed to inspect call recording events: {error}"))?;
    let mut count = 0_u64;
    for line in BufReader::new(file).lines() {
        let line =
            line.map_err(|error| format!("Failed to read call recording events: {error}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let event: CallRecordingEvent = serde_json::from_str(&line)
            .map_err(|error| format!("Invalid call recording event: {error}"))?;
        if event.kind == target_kind {
            count = count.saturating_add(1);
        }
    }
    Ok(count)
}

fn apply_completeness(
    status: &mut CallRecordingStatus,
    completeness: Option<&CallRecordingCompleteness>,
    expected_terminal_state: &str,
) -> Result<(), String> {
    let Some(completeness) = completeness else {
        status.attempted_event_count = status.attempted_event_count.max(status.event_count);
        status.persisted_event_count = status.event_count;
        return Ok(());
    };
    if completeness.terminal_state != expected_terminal_state {
        return Err(
            "Call recording terminal state does not match the close operation.".to_string(),
        );
    }
    if completeness.persisted_event_count != status.event_count {
        return Err("Call recording completeness uses a stale persisted count.".to_string());
    }
    if completeness.attempted_event_count
        < completeness
            .persisted_event_count
            .saturating_add(completeness.dropped_event_count)
    {
        return Err("Call recording completeness counts are inconsistent.".to_string());
    }
    status.attempted_event_count = completeness.attempted_event_count;
    status.persisted_event_count = completeness.persisted_event_count;
    status.dropped_event_count = completeness.dropped_event_count;
    status.incompleteness_reasons = completeness
        .incompleteness_reasons
        .iter()
        .filter_map(|reason| {
            let trimmed = reason.trim();
            (!trimmed.is_empty()).then(|| trimmed.chars().take(500).collect::<String>())
        })
        .take(100)
        .collect();
    status.health = if status.dropped_event_count > 0 || !status.incompleteness_reasons.is_empty() {
        CallRecordingHealth::Incomplete
    } else {
        completeness.health.clone()
    };
    Ok(())
}

fn validate_event_log(
    path: &Path,
    call_session_id: &str,
    expected_count: u64,
) -> Result<(), String> {
    reject_symlink(path)?;
    let file = File::open(path)
        .map_err(|error| format!("Failed to inspect call recording events: {error}"))?;
    let mut expected_sequence = 1_u64;
    for line in BufReader::new(file).lines() {
        let line =
            line.map_err(|error| format!("Failed to read call recording events: {error}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let event: CallRecordingEvent = serde_json::from_str(&line)
            .map_err(|error| format!("Invalid call recording event: {error}"))?;
        if event.call_session_id != call_session_id {
            return Err("Call recording event log contains another session.".to_string());
        }
        if event.sequence != expected_sequence {
            return Err("Call recording event log contains a sequence gap.".to_string());
        }
        expected_sequence = expected_sequence.saturating_add(1);
    }
    if expected_sequence.saturating_sub(1) != expected_count {
        return Err("Call recording event log count is inconsistent.".to_string());
    }
    Ok(())
}

fn verify_recording_integrity(
    session_dir: &Path,
    status: &CallRecordingStatus,
) -> Result<(), String> {
    let events_path = session_dir.join(EVENTS_FILE);
    validate_event_log(&events_path, &status.call_session_id, status.event_count)?;
    let (hash, count) = hash_events(&events_path)?;
    if count != status.event_count {
        return Err("Call recording event count does not match its status.".to_string());
    }
    if status.persisted_event_count != status.event_count {
        return Err("Call recording persisted count does not match its status.".to_string());
    }
    let manifest_path = session_dir.join(MANIFEST_FILE);
    if status.state != CallRecordingState::Closed {
        return Ok(());
    }
    let manifest: CallRecordingManifest = serde_json::from_str(
        &fs::read_to_string(&manifest_path)
            .map_err(|error| format!("Closed call recording is missing its manifest: {error}"))?,
    )
    .map_err(|error| format!("Invalid call recording manifest: {error}"))?;
    if manifest.call_session_id != status.call_session_id
        || manifest.event_count != count
        || manifest.events_sha256 != hash
        || manifest.terminal_state != "closed"
    {
        return Err("Call recording manifest does not match the event log.".to_string());
    }
    Ok(())
}

fn export_at_root(recordings_root: &Path, call_session_id: &str) -> Result<PathBuf, String> {
    validate_session_id(call_session_id)?;
    reject_symlink(recordings_root)?;
    let session_dir = session_dir(recordings_root, call_session_id)?;
    reject_symlink(&session_dir)?;
    let status = read_status(&session_dir)?;
    if status.state == CallRecordingState::Closed && !session_dir.join(MANIFEST_FILE).is_file() {
        return Err("Closed call recording is missing its manifest.".to_string());
    }
    let exports_dir = recordings_root.join(EXPORTS_DIR);
    reject_symlink(&exports_dir)?;
    fs::create_dir_all(&exports_dir)
        .map_err(|error| format!("Failed to create call recording exports: {error}"))?;
    reject_symlink(&exports_dir)?;

    let export_path = exports_dir.join(format!("{call_session_id}.zip"));
    reject_symlink(&export_path)?;
    let file = File::create(&export_path)
        .map_err(|error| format!("Failed to create call recording export: {error}"))?;
    let mut archive = ZipWriter::new(file);
    let options = SimpleFileOptions::default();
    for name in [STATUS_FILE, EVENTS_FILE, MANIFEST_FILE] {
        let source = session_dir.join(name);
        reject_symlink(&source)?;
        if !source.is_file() {
            continue;
        }
        archive
            .start_file(name, options)
            .map_err(|error| format!("Failed to stage call recording export: {error}"))?;
        let mut source_file = File::open(&source)
            .map_err(|error| format!("Failed to read call recording export source: {error}"))?;
        std::io::copy(&mut source_file, &mut archive)
            .map_err(|error| format!("Failed to write call recording export: {error}"))?;
    }
    let export_file = archive
        .finish()
        .map_err(|error| format!("Failed to finalize call recording export: {error}"))?;
    export_file
        .sync_all()
        .map_err(|error| format!("Failed to sync call recording export: {error}"))?;
    Ok(export_path)
}

fn reveal_path(path: &Path, select_file: bool) -> Result<(), String> {
    reject_symlink(path)?;
    #[cfg(target_os = "macos")]
    let status = if select_file {
        Command::new("open").arg("-R").arg(path).status()
    } else {
        Command::new("open").arg(path).status()
    };

    #[cfg(target_os = "windows")]
    let status = if select_file {
        Command::new("explorer")
            .arg(format!("/select,{}", path.to_string_lossy()))
            .status()
    } else {
        Command::new("explorer").arg(path).status()
    };

    #[cfg(target_os = "linux")]
    let status = Command::new("xdg-open")
        .arg(if select_file {
            path.parent().unwrap_or(path)
        } else {
            path
        })
        .status();

    let status =
        status.map_err(|error| format!("Failed to open call recording location: {error}"))?;
    if !status.success() {
        return Err(
            "The system file manager could not open the call recording location.".to_string(),
        );
    }
    Ok(())
}

fn session_dir(recordings_root: &Path, call_session_id: &str) -> Result<PathBuf, String> {
    validate_session_id(call_session_id)?;
    Ok(recordings_root.join(call_session_id))
}

fn read_status(session_dir: &Path) -> Result<CallRecordingStatus, String> {
    reject_symlink(session_dir)?;
    let path = session_dir.join(STATUS_FILE);
    reject_symlink(&path)?;
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read call recording state: {error}"))?;
    let mut status: CallRecordingStatus = serde_json::from_str(&content)
        .map_err(|error| format!("Invalid call recording state: {error}"))?;
    if status.persisted_event_count == 0 && status.event_count > 0 {
        status.persisted_event_count = status.event_count;
    }
    status.attempted_event_count = status.attempted_event_count.max(
        status
            .persisted_event_count
            .saturating_add(status.dropped_event_count),
    );
    Ok(status)
}

fn write_status(session_dir: &Path, status: &CallRecordingStatus) -> Result<(), String> {
    write_json_atomically(&session_dir.join(STATUS_FILE), status)
}

fn write_json_atomically<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        reject_symlink(parent)?;
    }
    reject_symlink(path)?;
    let payload = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Failed to serialize recording data: {error}"))?;
    let temporary = path.with_extension(format!("tmp-{}", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("Failed to stage recording data: {error}"))?;
    file.write_all(&payload)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Failed to sync recording data: {error}"))?;
    drop(file);

    #[cfg(not(target_os = "windows"))]
    fs::rename(&temporary, path)
        .map_err(|error| format!("Failed to commit recording data: {error}"))?;

    #[cfg(target_os = "windows")]
    {
        let backup = path.with_extension("bak");
        if backup.exists() {
            fs::remove_file(&backup)
                .map_err(|error| format!("Failed to remove recording backup: {error}"))?;
        }
        if path.exists() {
            fs::rename(path, &backup)
                .map_err(|error| format!("Failed to stage recording backup: {error}"))?;
        }
        if let Err(error) = fs::rename(&temporary, path) {
            if backup.exists() {
                let _ = fs::rename(&backup, path);
            }
            return Err(format!("Failed to commit recording data: {error}"));
        }
        if backup.exists() {
            fs::remove_file(backup)
                .map_err(|error| format!("Failed to remove recording backup: {error}"))?;
        }
    }
    Ok(())
}

fn hash_events(path: &Path) -> Result<(String, u64), String> {
    reject_symlink(path)?;
    let mut file = File::open(path)
        .map_err(|error| format!("Failed to open call recording events: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut lines = 0_u64;
    let mut previous_was_newline = true;
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read call recording events: {error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        for byte in &buffer[..count] {
            if *byte == b'\n' {
                lines = lines.saturating_add(1);
                previous_was_newline = true;
            } else {
                previous_was_newline = false;
            }
        }
    }
    if !previous_was_newline {
        lines = lines.saturating_add(1);
    }
    Ok((format!("{:x}", hasher.finalize()), lines))
}

fn validate_session_id(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > MAX_SESSION_ID_CHARS {
        return Err("Invalid call session id.".to_string());
    }
    if !value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Invalid call session id.".to_string());
    }
    Ok(())
}

fn validate_event_token(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 200 {
        return Err(format!("Invalid call recording {label}."));
    }
    if !value.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':' | '.')
    }) {
        return Err(format!("Invalid call recording {label}."));
    }
    Ok(())
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("Call recording storage cannot be a symlink.".to_string())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to inspect call recording storage: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root() -> PathBuf {
        std::env::temp_dir().join(format!("moss-recording-test-{}", Uuid::new_v4()))
    }

    fn event(session_id: &str, sequence: u64) -> String {
        serde_json::json!({
            "eventId": format!("event-{sequence}"),
            "callSessionId": session_id,
            "sequence": sequence,
            "kind": "transcript-committed",
            "occurredAt": sequence,
            "payload": { "text": "hello" }
        })
        .to_string()
    }

    #[test]
    fn records_contiguous_events_and_closes_with_a_hash() {
        let root = test_root();
        let session_id = "call-test-1";
        start_at_root(&root, session_id, 1).unwrap();
        assert_eq!(
            append_at_root(&root, session_id, &event(session_id, 1))
                .unwrap()
                .event_count,
            1
        );
        assert!(append_at_root(&root, session_id, &event(session_id, 3)).is_err());

        let closed = close_at_root(&root, session_id, 20, None).unwrap();
        assert_eq!(closed.state, CallRecordingState::Closed);
        let manifest = fs::read_to_string(root.join(session_id).join(MANIFEST_FILE)).unwrap();
        assert!(manifest.contains("eventsSha256"));
        assert!(manifest.contains("\"rawAudioRetained\": false"));
        assert!(manifest.contains("\"audioRecording\": null"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_close_remains_discoverable_and_retries_after_restart() {
        let root = test_root();
        let session_id = "call-test-2";
        start_at_root(&root, session_id, 1).unwrap();
        append_at_root(&root, session_id, &event(session_id, 1)).unwrap();
        let events = root.join(session_id).join(EVENTS_FILE);
        let backup = root.join(session_id).join("events.backup");
        fs::rename(&events, &backup).unwrap();
        fs::create_dir(&events).unwrap();

        assert!(close_at_root(&root, session_id, 20, None).is_err());
        let recovered = list_recoverable_at_root(&root).unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].state, CallRecordingState::CloseFailed);
        assert_eq!(recovered[0].attempt, 1);

        fs::remove_dir(&events).unwrap();
        fs::rename(&backup, &events).unwrap();
        let closed = close_at_root(&root, session_id, 30, None).unwrap();
        assert_eq!(closed.state, CallRecordingState::Closed);
        assert_eq!(closed.attempt, 2);
        assert!(list_recoverable_at_root(&root).unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_cross_session_events_and_path_traversal() {
        let root = test_root();
        start_at_root(&root, "call-test-3", 1).unwrap();
        assert!(append_at_root(&root, "call-test-3", &event("call-other", 1)).is_err());
        assert!(start_at_root(&root, "../escape", 1).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lists_evaluations_and_exports_a_portable_bundle() {
        let root = test_root();
        let session_id = "call-test-4";
        start_at_root(&root, session_id, 1).unwrap();
        let evaluation = serde_json::json!({
            "eventId": "event-evaluation-1",
            "callSessionId": session_id,
            "sequence": 1,
            "kind": "human-evaluation",
            "occurredAt": 2,
            "payload": { "label": "helpful" }
        })
        .to_string();
        append_at_root(&root, session_id, &evaluation).unwrap();
        close_at_root(&root, session_id, 20, None).unwrap();

        let summaries = list_all_at_root(&root).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].human_evaluation_count, 1);
        assert!(summaries[0].manifest_available);
        assert_eq!(summaries[0].integrity_error, None);

        let export = export_at_root(&root, session_id).unwrap();
        assert!(export.is_file());
        let archive = zip::ZipArchive::new(File::open(export).unwrap()).unwrap();
        assert_eq!(archive.len(), 3);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn closes_incomplete_recordings_without_presenting_them_as_healthy() {
        let root = test_root();
        let session_id = "call-test-incomplete";
        start_at_root(&root, session_id, 1).unwrap();
        append_at_root(&root, session_id, &event(session_id, 1)).unwrap();
        let completeness = CallRecordingCompleteness {
            health: CallRecordingHealth::Incomplete,
            attempted_event_count: 2,
            persisted_event_count: 1,
            dropped_event_count: 1,
            incompleteness_reasons: vec!["append:model-operation-returned:disk busy".to_string()],
            terminal_state: "closed".to_string(),
        };

        let status = close_at_root(&root, session_id, 20, Some(&completeness)).unwrap();
        assert_eq!(status.state, CallRecordingState::Closed);
        assert_eq!(status.health, CallRecordingHealth::Incomplete);
        assert_eq!(status.attempted_event_count, 2);
        assert_eq!(status.persisted_event_count, 1);
        assert_eq!(status.dropped_event_count, 1);

        let manifest: CallRecordingManifest = serde_json::from_str(
            &fs::read_to_string(root.join(session_id).join(MANIFEST_FILE)).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest.version, 3);
        assert_eq!(manifest.health, CallRecordingHealth::Incomplete);
        assert_eq!(manifest.terminal_state, "closed");
        assert_eq!(list_all_at_root(&root).unwrap()[0].integrity_error, None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn observer_detach_marks_an_open_recording_incomplete_immediately() {
        let root = test_root();
        let session_id = "call-test-observer-detach";
        start_at_root(&root, session_id, 1).unwrap();
        let status = mark_incomplete_at_root(
            &root,
            session_id,
            "runtime-projection-detached:calling-ui-unmounted",
        )
        .unwrap();
        assert_eq!(status.health, CallRecordingHealth::Incomplete);
        assert_eq!(status.incompleteness_reasons.len(), 1);
        assert_eq!(
            list_recoverable_at_root(&root).unwrap()[0].health,
            CallRecordingHealth::Incomplete
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn summary_integrity_detects_post_close_event_tampering() {
        let root = test_root();
        let session_id = "call-test-tampered";
        start_at_root(&root, session_id, 1).unwrap();
        append_at_root(&root, session_id, &event(session_id, 1)).unwrap();
        close_at_root(&root, session_id, 20, None).unwrap();
        OpenOptions::new()
            .append(true)
            .open(root.join(session_id).join(EVENTS_FILE))
            .unwrap()
            .write_all(b"{}\n")
            .unwrap();

        let summaries = list_all_at_root(&root).unwrap();
        assert!(summaries[0].integrity_error.is_some());
        fs::remove_dir_all(root).unwrap();
    }
}
