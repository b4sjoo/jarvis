use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

pub const AUDIO_MANIFEST_FILE: &str = "audio-manifest.json";
pub const AUDIO_DIR: &str = "audio";
const AUDIO_DELETE_STAGING_DIR: &str = ".audio-deleting";
const TEMPORARY_RETENTION_MS: u64 = 72 * 60 * 60 * 1_000;
const MAX_SESSION_ID_CHARS: usize = 160;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CallAudioRecordingState {
    Off,
    Starting,
    Recording,
    Stopping,
    RetainedTemporarily,
    Preserved,
    Deleting,
    Deleted,
    Partial,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CallAudioRetentionMode {
    Temporary,
    Preserved,
    Deleted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CallAudioChannelHealth {
    Complete,
    Partial,
    Missing,
    Deleted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CallAudioChannel {
    Them,
    Me,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CallAudioChunk {
    pub audio_chunk_id: String,
    pub channel: CallAudioChannel,
    pub capture_generation: u64,
    pub part: u32,
    pub started_at: u64,
    pub ended_at: u64,
    pub sample_rate: u32,
    pub channel_count: u16,
    pub sample_format: String,
    pub duration_ms: u64,
    pub byte_count: u64,
    pub sha256: String,
    pub relative_path: String,
    #[serde(default)]
    pub gap_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CallAudioChannelStatus {
    pub channel: CallAudioChannel,
    pub health: CallAudioChannelHealth,
    pub chunk_count: u32,
    pub byte_count: u64,
    pub duration_ms: u64,
    pub gap_count: u64,
    pub overflow_count: u64,
    pub failure: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CallAudioManifest {
    pub version: u32,
    pub audio_recording_revision: u64,
    pub call_session_id: String,
    pub state: CallAudioRecordingState,
    pub requested_at: u64,
    pub started_at: Option<u64>,
    pub stopped_at: Option<u64>,
    pub retention_mode: CallAudioRetentionMode,
    pub expires_at: Option<u64>,
    pub preserved_at: Option<u64>,
    pub deleted_at: Option<u64>,
    pub channels: Vec<CallAudioChannelStatus>,
    pub chunks: Vec<CallAudioChunk>,
    #[serde(default)]
    pub failure_stage: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub retryable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CallAudioRecordingSummary {
    pub audio_recording_revision: u64,
    pub state: CallAudioRecordingState,
    pub retention_mode: CallAudioRetentionMode,
    pub expires_at: Option<u64>,
    pub preserved_at: Option<u64>,
    pub deleted_at: Option<u64>,
    pub chunk_count: u32,
    pub byte_count: u64,
    pub duration_ms: u64,
    pub channels: Vec<CallAudioChannelStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CallAudioCleanupResult {
    pub scanned_count: u64,
    pub expired_count: u64,
    pub deleted_count: u64,
    pub failed_count: u64,
    pub failures: Vec<String>,
}

pub(crate) fn empty_manifest(call_session_id: &str, requested_at: u64) -> CallAudioManifest {
    CallAudioManifest {
        version: 1,
        audio_recording_revision: 1,
        call_session_id: call_session_id.to_string(),
        state: CallAudioRecordingState::Starting,
        requested_at,
        started_at: None,
        stopped_at: None,
        retention_mode: CallAudioRetentionMode::Temporary,
        expires_at: None,
        preserved_at: None,
        deleted_at: None,
        channels: vec![
            empty_channel(CallAudioChannel::Them),
            empty_channel(CallAudioChannel::Me),
        ],
        chunks: Vec::new(),
        failure_stage: None,
        last_error: None,
        retryable: false,
    }
}

fn empty_channel(channel: CallAudioChannel) -> CallAudioChannelStatus {
    CallAudioChannelStatus {
        channel,
        health: CallAudioChannelHealth::Missing,
        chunk_count: 0,
        byte_count: 0,
        duration_ms: 0,
        gap_count: 0,
        overflow_count: 0,
        failure: None,
    }
}

pub(crate) fn summarize(manifest: &CallAudioManifest) -> CallAudioRecordingSummary {
    CallAudioRecordingSummary {
        audio_recording_revision: manifest.audio_recording_revision,
        state: manifest.state.clone(),
        retention_mode: manifest.retention_mode.clone(),
        expires_at: manifest.expires_at,
        preserved_at: manifest.preserved_at,
        deleted_at: manifest.deleted_at,
        chunk_count: manifest.chunks.len() as u32,
        byte_count: manifest.chunks.iter().map(|chunk| chunk.byte_count).sum(),
        duration_ms: manifest
            .channels
            .iter()
            .map(|channel| channel.duration_ms)
            .max()
            .unwrap_or(0),
        channels: manifest.channels.clone(),
    }
}

pub(crate) fn read_for_session_dir(
    session_dir: &Path,
) -> Result<Option<CallAudioManifest>, String> {
    let path = session_dir.join(AUDIO_MANIFEST_FILE);
    reject_symlink(&path)?;
    if !path.exists() {
        return Ok(None);
    }
    let manifest: CallAudioManifest = serde_json::from_str(
        &fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read audio manifest: {error}"))?,
    )
    .map_err(|error| format!("Invalid audio manifest: {error}"))?;
    if manifest.version != 1 {
        return Err("Unsupported audio manifest version.".to_string());
    }
    Ok(Some(manifest))
}

pub(crate) fn write_for_session_dir(
    session_dir: &Path,
    manifest: &CallAudioManifest,
) -> Result<(), String> {
    if manifest.call_session_id.trim().is_empty() {
        return Err("Audio manifest CallSession identity is required.".to_string());
    }
    fs::create_dir_all(session_dir)
        .map_err(|error| format!("Failed to create recording directory: {error}"))?;
    let path = session_dir.join(AUDIO_MANIFEST_FILE);
    reject_symlink(&path)?;
    let temporary = session_dir.join(format!(".{AUDIO_MANIFEST_FILE}.tmp"));
    let payload = serde_json::to_vec_pretty(manifest)
        .map_err(|error| format!("Failed to serialize audio manifest: {error}"))?;
    let mut file = File::create(&temporary)
        .map_err(|error| format!("Failed to stage audio manifest: {error}"))?;
    file.write_all(&payload)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Failed to persist audio manifest: {error}"))?;
    fs::rename(&temporary, &path)
        .map_err(|error| format!("Failed to commit audio manifest: {error}"))?;
    Ok(())
}

pub(crate) fn finalize_temporary_retention(
    session_dir: &Path,
    closed_at: u64,
) -> Result<Option<CallAudioManifest>, String> {
    let Some(mut manifest) = read_for_session_dir(session_dir)? else {
        return Ok(None);
    };
    if manifest.retention_mode == CallAudioRetentionMode::Temporary
        && manifest.deleted_at.is_none()
    {
        manifest.audio_recording_revision = manifest.audio_recording_revision.saturating_add(1);
        manifest.expires_at = Some(closed_at.saturating_add(TEMPORARY_RETENTION_MS));
        if !matches!(
            manifest.state,
            CallAudioRecordingState::Partial | CallAudioRecordingState::Error
        ) {
            manifest.state = CallAudioRecordingState::RetainedTemporarily;
        }
        write_for_session_dir(session_dir, &manifest)?;
    }
    Ok(Some(manifest))
}

#[tauri::command]
pub fn get_call_audio_recording(
    app: AppHandle,
    call_session_id: String,
) -> Result<Option<CallAudioManifest>, String> {
    let session_dir = resolve_session_dir(&app, &call_session_id)?;
    read_for_session_dir(&session_dir)
}

#[tauri::command]
pub fn preserve_call_audio_recording(
    app: AppHandle,
    call_session_id: String,
    expected_revision: u64,
    occurred_at: u64,
) -> Result<CallAudioManifest, String> {
    mutate_retention(
        &app,
        &call_session_id,
        expected_revision,
        |manifest| {
            ensure_not_deleted(manifest)?;
            manifest.retention_mode = CallAudioRetentionMode::Preserved;
            manifest.state = CallAudioRecordingState::Preserved;
            manifest.expires_at = None;
            manifest.preserved_at = Some(occurred_at);
            Ok(())
        },
    )
}

#[tauri::command]
pub fn restore_temporary_call_audio_retention(
    app: AppHandle,
    call_session_id: String,
    expected_revision: u64,
) -> Result<CallAudioManifest, String> {
    let session_dir = resolve_session_dir(&app, &call_session_id)?;
    let closed_at = read_call_closed_at(&session_dir)?
        .ok_or_else(|| "End the call before restoring temporary retention.".to_string())?;
    mutate_retention_at_dir(&session_dir, expected_revision, |manifest| {
        ensure_not_deleted(manifest)?;
        manifest.retention_mode = CallAudioRetentionMode::Temporary;
        manifest.state = CallAudioRecordingState::RetainedTemporarily;
        manifest.expires_at = Some(closed_at.saturating_add(TEMPORARY_RETENTION_MS));
        manifest.preserved_at = None;
        Ok(())
    })
}

#[tauri::command]
pub fn delete_call_audio_recording(
    app: AppHandle,
    call_session_id: String,
    expected_revision: u64,
    occurred_at: u64,
) -> Result<CallAudioManifest, String> {
    let session_dir = resolve_session_dir(&app, &call_session_id)?;
    delete_at_session_dir(&session_dir, expected_revision, occurred_at)
}

#[tauri::command]
pub fn cleanup_expired_call_audio(
    app: AppHandle,
    occurred_at: u64,
) -> Result<CallAudioCleanupResult, String> {
    cleanup_expired_at_root(&crate::recording::recordings_root(&app)?, occurred_at)
}

fn mutate_retention<F>(
    app: &AppHandle,
    call_session_id: &str,
    expected_revision: u64,
    mutate: F,
) -> Result<CallAudioManifest, String>
where
    F: FnOnce(&mut CallAudioManifest) -> Result<(), String>,
{
    let session_dir = resolve_session_dir(app, call_session_id)?;
    mutate_retention_at_dir(&session_dir, expected_revision, mutate)
}

fn mutate_retention_at_dir<F>(
    session_dir: &Path,
    expected_revision: u64,
    mutate: F,
) -> Result<CallAudioManifest, String>
where
    F: FnOnce(&mut CallAudioManifest) -> Result<(), String>,
{
    let mut manifest = read_for_session_dir(session_dir)?
        .ok_or_else(|| "This session has no audio recording.".to_string())?;
    if manifest.audio_recording_revision != expected_revision {
        return Err("Audio recording changed. Refresh before trying again.".to_string());
    }
    mutate(&mut manifest)?;
    manifest.audio_recording_revision = manifest.audio_recording_revision.saturating_add(1);
    write_for_session_dir(session_dir, &manifest)?;
    Ok(manifest)
}

fn delete_at_session_dir(
    session_dir: &Path,
    expected_revision: u64,
    occurred_at: u64,
) -> Result<CallAudioManifest, String> {
    let mut manifest = read_for_session_dir(session_dir)?
        .ok_or_else(|| "This session has no audio recording.".to_string())?;
    if manifest.audio_recording_revision != expected_revision {
        return Err("Audio recording changed. Refresh before trying again.".to_string());
    }
    if manifest.retention_mode == CallAudioRetentionMode::Deleted {
        return Ok(manifest);
    }
    manifest.audio_recording_revision = manifest.audio_recording_revision.saturating_add(1);
    manifest.state = CallAudioRecordingState::Deleting;
    manifest.retryable = true;
    manifest.failure_stage = None;
    manifest.last_error = None;
    write_for_session_dir(session_dir, &manifest)?;

    let audio_dir = session_dir.join(AUDIO_DIR);
    let staged_dir = session_dir.join(AUDIO_DELETE_STAGING_DIR);
    let deletion = (|| {
        reject_symlink(&audio_dir)?;
        reject_symlink(&staged_dir)?;
        if audio_dir.exists() && !staged_dir.exists() {
            fs::rename(&audio_dir, &staged_dir)
                .map_err(|error| format!("Failed to stage audio deletion: {error}"))?;
        }
        if staged_dir.exists() {
            fs::remove_dir_all(&staged_dir)
                .map_err(|error| format!("Failed to delete staged audio: {error}"))?;
        }
        Ok::<(), String>(())
    })();

    if let Err(error) = deletion {
        manifest.audio_recording_revision = manifest.audio_recording_revision.saturating_add(1);
        manifest.failure_stage = Some("delete-files".to_string());
        manifest.last_error = Some(error.clone());
        write_for_session_dir(session_dir, &manifest)?;
        return Err(error);
    }

    manifest.audio_recording_revision = manifest.audio_recording_revision.saturating_add(1);
    manifest.state = CallAudioRecordingState::Deleted;
    manifest.retention_mode = CallAudioRetentionMode::Deleted;
    manifest.expires_at = None;
    manifest.preserved_at = None;
    manifest.deleted_at = Some(occurred_at);
    manifest.retryable = false;
    manifest.failure_stage = None;
    manifest.last_error = None;
    for channel in &mut manifest.channels {
        channel.health = CallAudioChannelHealth::Deleted;
    }
    write_for_session_dir(session_dir, &manifest)?;
    Ok(manifest)
}

fn cleanup_expired_at_root(
    recordings_root: &Path,
    occurred_at: u64,
) -> Result<CallAudioCleanupResult, String> {
    let mut result = CallAudioCleanupResult {
        scanned_count: 0,
        expired_count: 0,
        deleted_count: 0,
        failed_count: 0,
        failures: Vec::new(),
    };
    if !recordings_root.exists() {
        return Ok(result);
    }
    for entry in fs::read_dir(recordings_root)
        .map_err(|error| format!("Failed to scan call recordings: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Failed to inspect call recording: {error}"))?;
        let session_dir = entry.path();
        if !session_dir.is_dir() || entry.file_name() == "exports" {
            continue;
        }
        let Some(manifest) = read_for_session_dir(&session_dir)? else {
            continue;
        };
        result.scanned_count = result.scanned_count.saturating_add(1);
        if manifest.retention_mode != CallAudioRetentionMode::Temporary
            || manifest.expires_at.is_none_or(|expires_at| expires_at > occurred_at)
        {
            continue;
        }
        result.expired_count = result.expired_count.saturating_add(1);
        match delete_at_session_dir(
            &session_dir,
            manifest.audio_recording_revision,
            occurred_at,
        ) {
            Ok(_) => result.deleted_count = result.deleted_count.saturating_add(1),
            Err(error) => {
                result.failed_count = result.failed_count.saturating_add(1);
                result.failures.push(format!(
                    "{}: {error}",
                    manifest.call_session_id
                ));
            }
        }
    }
    Ok(result)
}

fn resolve_session_dir(app: &AppHandle, call_session_id: &str) -> Result<PathBuf, String> {
    validate_session_id(call_session_id)?;
    let path = crate::recording::recordings_root(app)?.join(call_session_id);
    reject_symlink(&path)?;
    if !path.is_dir() {
        return Err("Call recording does not exist.".to_string());
    }
    Ok(path)
}

fn read_call_closed_at(session_dir: &Path) -> Result<Option<u64>, String> {
    let value: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(session_dir.join("recording-state.json"))
            .map_err(|error| format!("Failed to read call recording state: {error}"))?,
    )
    .map_err(|error| format!("Invalid call recording state: {error}"))?;
    Ok(value.get("endedAt").and_then(serde_json::Value::as_u64))
}

fn ensure_not_deleted(manifest: &CallAudioManifest) -> Result<(), String> {
    if manifest.retention_mode == CallAudioRetentionMode::Deleted {
        return Err("Deleted audio cannot change retention policy.".to_string());
    }
    Ok(())
}

fn validate_session_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > MAX_SESSION_ID_CHARS
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Invalid call session id.".to_string());
    }
    Ok(())
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("Audio evidence path cannot be a symlink.".to_string())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to inspect audio evidence path: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn test_root() -> PathBuf {
        std::env::temp_dir().join(format!("moss-audio-evidence-test-{}", Uuid::new_v4()))
    }

    fn ready_session(root: &Path, session_id: &str, closed_at: u64) -> PathBuf {
        let session_dir = root.join(session_id);
        fs::create_dir_all(session_dir.join(AUDIO_DIR)).unwrap();
        fs::write(
            session_dir.join("recording-state.json"),
            serde_json::json!({ "endedAt": closed_at }).to_string(),
        )
        .unwrap();
        let mut manifest = empty_manifest(session_id, 10);
        manifest.state = CallAudioRecordingState::RetainedTemporarily;
        manifest.started_at = Some(11);
        manifest.stopped_at = Some(12);
        manifest.expires_at = Some(closed_at + TEMPORARY_RETENTION_MS);
        write_for_session_dir(&session_dir, &manifest).unwrap();
        session_dir
    }

    #[test]
    fn temporary_retention_uses_call_close_plus_seventy_two_hours() {
        let root = test_root();
        let session_dir = ready_session(&root, "call-1", 1_000);
        let manifest = finalize_temporary_retention(&session_dir, 2_000)
            .unwrap()
            .unwrap();
        assert_eq!(manifest.expires_at, Some(2_000 + TEMPORARY_RETENTION_MS));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn retention_changes_require_the_exact_audio_revision() {
        let root = test_root();
        let session_dir = ready_session(&root, "call-2", 1_000);
        assert!(mutate_retention_at_dir(&session_dir, 99, |_| Ok(())).is_err());
        let preserved = mutate_retention_at_dir(&session_dir, 1, |manifest| {
            manifest.retention_mode = CallAudioRetentionMode::Preserved;
            manifest.expires_at = None;
            Ok(())
        })
        .unwrap();
        assert_eq!(preserved.retention_mode, CallAudioRetentionMode::Preserved);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn expired_cleanup_deletes_audio_but_keeps_an_auditable_tombstone() {
        let root = test_root();
        let session_dir = ready_session(&root, "call-3", 1_000);
        fs::write(session_dir.join(AUDIO_DIR).join("them.wav"), b"audio").unwrap();
        let result = cleanup_expired_at_root(&root, 1_000 + TEMPORARY_RETENTION_MS).unwrap();
        assert_eq!(result.deleted_count, 1);
        assert!(!session_dir.join(AUDIO_DIR).exists());
        let manifest = read_for_session_dir(&session_dir).unwrap().unwrap();
        assert_eq!(manifest.retention_mode, CallAudioRetentionMode::Deleted);
        assert!(manifest.deleted_at.is_some());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn historical_sessions_without_audio_are_valid() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        assert_eq!(read_for_session_dir(&root).unwrap(), None);
        fs::remove_dir_all(root).unwrap();
    }
}
