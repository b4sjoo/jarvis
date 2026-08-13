use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample, Stream, StreamConfig};
use hound::{WavSpec, WavWriter};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{
    channel, sync_channel, Receiver, Sender, SyncSender, TrySendError,
};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::AppHandle;
use tauri::Manager;

pub const AUDIO_MANIFEST_FILE: &str = "audio-manifest.json";
pub const AUDIO_DIR: &str = "audio";
const AUDIO_DELETE_STAGING_DIR: &str = ".audio-deleting";
const TEMPORARY_RETENTION_MS: u64 = 72 * 60 * 60 * 1_000;
const MAX_SESSION_ID_CHARS: usize = 160;
const WRITER_QUEUE_CAPACITY: usize = 64;
const MAX_CHUNK_DURATION_SECS: u64 = 15 * 60;
const WRITER_STOP_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Default)]
pub struct CallAudioEvidenceState {
    active: Mutex<Option<ActiveCallAudioCapture>>,
}

struct ActiveCallAudioCapture {
    call_session_id: String,
    capture_generation: u64,
    them: ChannelWriterHandle,
    me: Option<ChannelWriterHandle>,
    microphone_stop: Option<Sender<()>>,
    microphone_done: Option<Receiver<()>>,
    microphone_thread: Option<JoinHandle<()>>,
    microphone_error: Arc<Mutex<Option<String>>>,
}

struct ChannelWriterHandle {
    channel: CallAudioChannel,
    sender: Option<SyncSender<Vec<f32>>>,
    overflow_count: Arc<AtomicU64>,
    completion: Option<Receiver<Result<Vec<CallAudioChunk>, String>>>,
    join: Option<JoinHandle<()>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveCallAudioStatus {
    pub active: bool,
    pub call_session_id: Option<String>,
    pub capture_generation: Option<u64>,
    pub them_overflow_count: u64,
    pub me_overflow_count: u64,
    pub microphone_failure: Option<String>,
}

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
    pub retention_actions: Vec<CallAudioRetentionAction>,
    #[serde(default)]
    pub failure_stage: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub retryable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CallAudioRetentionAction {
    pub action: String,
    pub actor: String,
    pub occurred_at: u64,
    pub audio_recording_revision: u64,
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
        retention_actions: Vec::new(),
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
            append_retention_action(manifest, "preserve", "user", occurred_at, 1);
            Ok(())
        },
    )
}

#[tauri::command]
pub fn restore_temporary_call_audio_retention(
    app: AppHandle,
    call_session_id: String,
    expected_revision: u64,
    occurred_at: u64,
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
        append_retention_action(manifest, "restore-temporary", "user", occurred_at, 1);
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
    delete_at_session_dir(&session_dir, expected_revision, occurred_at, "user")
}

#[tauri::command]
pub fn cleanup_expired_call_audio(
    app: AppHandle,
    occurred_at: u64,
) -> Result<CallAudioCleanupResult, String> {
    cleanup_expired_at_root(&crate::recording::recordings_root(&app)?, occurred_at)
}

#[tauri::command]
pub fn start_call_audio_evidence(
    app: AppHandle,
    call_session_id: String,
    capture_generation: u64,
    system_sample_rate: u32,
    input_device_id: Option<String>,
    expected_revision: u64,
    requested_at: u64,
) -> Result<CallAudioManifest, String> {
    if !(8_000..=96_000).contains(&system_sample_rate) {
        return Err("System audio sample rate is outside the supported range.".to_string());
    }
    let state = app.state::<CallAudioEvidenceState>();
    let mut active = state
        .active
        .lock()
        .map_err(|_| "Call audio recorder is unavailable.".to_string())?;
    if let Some(existing) = active.as_ref() {
        if existing.call_session_id == call_session_id
            && existing.capture_generation == capture_generation
        {
            return get_manifest_for_app(&app, &call_session_id)?
                .ok_or_else(|| "Active audio recording has no manifest.".to_string());
        }
        return Err("Another call audio recording is already active.".to_string());
    }

    let session_dir = resolve_session_dir(&app, &call_session_id)?;
    let mut manifest = match read_for_session_dir(&session_dir)? {
        Some(manifest) => {
            if manifest.audio_recording_revision != expected_revision {
                return Err("Audio recording changed. Refresh before trying again.".to_string());
            }
            ensure_not_deleted(&manifest)?;
            manifest
        }
        None if expected_revision == 0 => empty_manifest(&call_session_id, requested_at),
        None => return Err("Audio recording changed. Refresh before trying again.".to_string()),
    };
    manifest.audio_recording_revision = manifest.audio_recording_revision.saturating_add(1);
    manifest.state = CallAudioRecordingState::Starting;
    manifest.requested_at = requested_at;
    manifest.stopped_at = None;
    manifest.failure_stage = None;
    manifest.last_error = None;
    manifest.retryable = false;
    write_for_session_dir(&session_dir, &manifest)?;

    fs::create_dir_all(session_dir.join(AUDIO_DIR))
        .map_err(|error| format!("Failed to create audio evidence directory: {error}"))?;
    let them_part = next_part(&manifest, CallAudioChannel::Them, capture_generation);
    let them = spawn_channel_writer(
        &session_dir,
        CallAudioChannel::Them,
        capture_generation,
        them_part,
        system_sample_rate,
        requested_at,
    )?;

    let microphone_error = Arc::new(Mutex::new(None));
    let (me, microphone_stop, microphone_done, microphone_thread, microphone_failure) = match start_microphone_capture(
        &session_dir,
        capture_generation,
        next_part(&manifest, CallAudioChannel::Me, capture_generation),
        requested_at,
        input_device_id.as_deref(),
        microphone_error.clone(),
    ) {
        Ok((writer, stop, done, thread)) => {
            (Some(writer), Some(stop), Some(done), Some(thread), None)
        }
        Err(error) => {
            if let Ok(mut slot) = microphone_error.lock() {
                *slot = Some(error.clone());
            }
            (None, None, None, None, Some(error))
        }
    };

    if let Some(channel) = channel_mut(&mut manifest, CallAudioChannel::Them) {
        channel.health = CallAudioChannelHealth::Complete;
        channel.failure = None;
    }
    if let Some(channel) = channel_mut(&mut manifest, CallAudioChannel::Me) {
        channel.health = if microphone_failure.is_some() {
            CallAudioChannelHealth::Missing
        } else {
            CallAudioChannelHealth::Complete
        };
        channel.failure = microphone_failure;
    }
    manifest.audio_recording_revision = manifest.audio_recording_revision.saturating_add(1);
    manifest.state = CallAudioRecordingState::Recording;
    manifest.started_at.get_or_insert(requested_at);
    write_for_session_dir(&session_dir, &manifest)?;

    *active = Some(ActiveCallAudioCapture {
        call_session_id,
        capture_generation,
        them,
        me,
        microphone_stop,
        microphone_done,
        microphone_thread,
        microphone_error,
    });
    Ok(manifest)
}

#[tauri::command]
pub fn stop_call_audio_evidence(
    app: AppHandle,
    call_session_id: String,
    expected_revision: u64,
    occurred_at: u64,
) -> Result<CallAudioManifest, String> {
    let state = app.state::<CallAudioEvidenceState>();
    let capture = {
        let mut active = state
            .active
            .lock()
            .map_err(|_| "Call audio recorder is unavailable.".to_string())?;
        let Some(capture) = active.take() else {
            return get_manifest_for_app(&app, &call_session_id)?
                .ok_or_else(|| "This session has no audio recording.".to_string());
        };
        if capture.call_session_id != call_session_id {
            *active = Some(capture);
            return Err("Audio recorder belongs to another CallSession.".to_string());
        }
        capture
    };
    stop_active_capture(&app, capture, expected_revision, occurred_at)
}

#[tauri::command]
pub fn get_active_call_audio_status(app: AppHandle) -> Result<ActiveCallAudioStatus, String> {
    let state = app.state::<CallAudioEvidenceState>();
    let active = state
        .active
        .lock()
        .map_err(|_| "Call audio recorder is unavailable.".to_string())?;
    Ok(match active.as_ref() {
        Some(capture) => ActiveCallAudioStatus {
            active: true,
            call_session_id: Some(capture.call_session_id.clone()),
            capture_generation: Some(capture.capture_generation),
            them_overflow_count: capture.them.overflow_count.load(Ordering::Acquire),
            me_overflow_count: capture
                .me
                .as_ref()
                .map(|writer| writer.overflow_count.load(Ordering::Acquire))
                .unwrap_or(0),
            microphone_failure: capture
                .microphone_error
                .lock()
                .ok()
                .and_then(|error| error.clone()),
        },
        None => ActiveCallAudioStatus {
            active: false,
            call_session_id: None,
            capture_generation: None,
            them_overflow_count: 0,
            me_overflow_count: 0,
            microphone_failure: None,
        },
    })
}

pub(crate) fn append_system_audio_samples(
    app: &AppHandle,
    capture_generation: u64,
    sample_rate: u32,
    samples: &[f32],
) {
    if samples.is_empty() {
        return;
    }
    let state = app.state::<CallAudioEvidenceState>();
    let Ok(active) = state.active.try_lock() else {
        return;
    };
    let Some(capture) = active.as_ref() else {
        return;
    };
    if capture.capture_generation != capture_generation {
        return;
    }
    enqueue_samples(&capture.them, samples, sample_rate);
}

fn stop_active_capture(
    app: &AppHandle,
    mut capture: ActiveCallAudioCapture,
    expected_revision: u64,
    occurred_at: u64,
) -> Result<CallAudioManifest, String> {
    let session_dir = resolve_session_dir(app, &capture.call_session_id)?;
    let mut manifest = read_for_session_dir(&session_dir)?
        .ok_or_else(|| "Active audio recording has no manifest.".to_string())?;
    if manifest.audio_recording_revision != expected_revision {
        return Err("Audio recording changed. Refresh before trying again.".to_string());
    }
    manifest.audio_recording_revision = manifest.audio_recording_revision.saturating_add(1);
    manifest.state = CallAudioRecordingState::Stopping;
    write_for_session_dir(&session_dir, &manifest)?;

    if let Some(stop) = capture.microphone_stop.take() {
        let _ = stop.send(());
    }
    let microphone_stopped = capture
        .microphone_done
        .take()
        .is_none_or(|done| done.recv_timeout(WRITER_STOP_TIMEOUT).is_ok());
    if microphone_stopped {
        if let Some(thread) = capture.microphone_thread.take() {
            let _ = thread.join();
        }
    } else if let Ok(mut slot) = capture.microphone_error.lock() {
        *slot = Some("Microphone capture did not stop within 500 ms.".to_string());
    }
    let them_overflow = capture.them.overflow_count.load(Ordering::Acquire);
    let me_overflow = capture
        .me
        .as_ref()
        .map(|writer| writer.overflow_count.load(Ordering::Acquire))
        .unwrap_or(0);
    let them_result = finish_channel_writer(&mut capture.them);
    let me_result = capture.me.as_mut().map(finish_channel_writer);
    let microphone_error = capture
        .microphone_error
        .lock()
        .ok()
        .and_then(|error| error.clone());

    apply_channel_result(
        &mut manifest,
        CallAudioChannel::Them,
        them_result,
        them_overflow,
    );
    match me_result {
        Some(result) => apply_channel_result(
            &mut manifest,
            CallAudioChannel::Me,
            result,
            me_overflow,
        ),
        None => {
            if let Some(channel) = channel_mut(&mut manifest, CallAudioChannel::Me) {
                channel.health = CallAudioChannelHealth::Missing;
                channel.failure = microphone_error;
            }
        }
    }
    manifest.audio_recording_revision = manifest.audio_recording_revision.saturating_add(1);
    manifest.stopped_at = Some(occurred_at);
    manifest.state = if manifest.channels.iter().all(|channel| {
        channel.health == CallAudioChannelHealth::Complete && channel.chunk_count > 0
    }) {
        CallAudioRecordingState::RetainedTemporarily
    } else {
        CallAudioRecordingState::Partial
    };
    manifest.retryable = false;
    write_for_session_dir(&session_dir, &manifest)?;
    Ok(manifest)
}

fn spawn_channel_writer(
    session_dir: &Path,
    channel: CallAudioChannel,
    capture_generation: u64,
    first_part: u32,
    sample_rate: u32,
    started_at: u64,
) -> Result<ChannelWriterHandle, String> {
    let (sender, receiver) = sync_channel::<Vec<f32>>(WRITER_QUEUE_CAPACITY);
    let overflow_count = Arc::new(AtomicU64::new(0));
    spawn_channel_writer_with_receiver(
        session_dir,
        channel,
        capture_generation,
        first_part,
        sample_rate,
        started_at,
        sender,
        receiver,
        overflow_count,
    )
}

#[allow(clippy::too_many_arguments)]
fn spawn_channel_writer_with_receiver(
    session_dir: &Path,
    channel: CallAudioChannel,
    capture_generation: u64,
    first_part: u32,
    sample_rate: u32,
    started_at: u64,
    sender: SyncSender<Vec<f32>>,
    receiver: Receiver<Vec<f32>>,
    overflow_count: Arc<AtomicU64>,
) -> Result<ChannelWriterHandle, String> {
    let root = session_dir.to_path_buf();
    let thread_channel = channel.clone();
    let (completion_sender, completion_receiver) = std::sync::mpsc::channel();
    let join = thread::Builder::new()
        .name(format!("moss-audio-{}", channel_name(&channel)))
        .spawn(move || {
            let result = write_channel_chunks(
                &root,
                thread_channel,
                capture_generation,
                first_part,
                sample_rate,
                started_at,
                receiver,
            );
            let _ = completion_sender.send(result);
        })
        .map_err(|error| format!("Failed to start audio writer: {error}"))?;
    Ok(ChannelWriterHandle {
        channel,
        sender: Some(sender),
        overflow_count,
        completion: Some(completion_receiver),
        join: Some(join),
    })
}

fn start_microphone_capture(
    session_dir: &Path,
    capture_generation: u64,
    first_part: u32,
    started_at: u64,
    requested_device: Option<&str>,
    microphone_error: Arc<Mutex<Option<String>>>,
) -> Result<(
    ChannelWriterHandle,
    Sender<()>,
    Receiver<()>,
    JoinHandle<()>,
), String> {
    let requested_device = requested_device.map(str::to_string);
    let (startup_sender, startup_receiver) = channel::<Result<u32, String>>();
    let (stop_sender, stop_receiver) = channel::<()>();
    let (done_sender, done_receiver) = channel::<()>();
    let (sample_sender, sample_receiver) = sync_channel::<Vec<f32>>(WRITER_QUEUE_CAPACITY);
    let microphone_sample_sender = sample_sender.clone();
    let overflow = Arc::new(AtomicU64::new(0));
    let thread_overflow = overflow.clone();
    let thread_error = microphone_error.clone();
    let microphone_thread = thread::Builder::new()
        .name("moss-microphone-capture".to_string())
        .spawn(move || {
            let result = (|| {
                let host = cpal::default_host();
                let mut selected = None;
                if let Some(requested) = requested_device
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                {
                    if let Ok(devices) = host.input_devices() {
                        for device in devices {
                            if device.name().ok().as_deref() == Some(requested) {
                                selected = Some(device);
                                break;
                            }
                        }
                    }
                }
                let device = selected
                    .or_else(|| host.default_input_device())
                    .ok_or_else(|| "No microphone input device is available.".to_string())?;
                let supported = device
                    .default_input_config()
                    .map_err(|error| format!("Failed to read microphone configuration: {error}"))?;
                let sample_rate = supported.sample_rate().0;
                if !(8_000..=96_000).contains(&sample_rate) {
                    return Err("Microphone sample rate is outside the supported range.".to_string());
                }
                let channels = supported.channels() as usize;
                let stream_config: StreamConfig = supported.clone().into();
                let callback_error = thread_error.clone();
                let on_error = move |error| {
                    if let Ok(mut slot) = callback_error.lock() {
                        *slot = Some(format!("Microphone stream failed: {error}"));
                    }
                };
                let stream = match supported.sample_format() {
                    SampleFormat::F32 => build_microphone_stream::<f32>(
                        &device,
                        &stream_config,
                        channels,
                        microphone_sample_sender.clone(),
                        thread_overflow.clone(),
                        on_error,
                    ),
                    SampleFormat::I16 => build_microphone_stream::<i16>(
                        &device,
                        &stream_config,
                        channels,
                        microphone_sample_sender.clone(),
                        thread_overflow.clone(),
                        on_error,
                    ),
                    SampleFormat::U16 => build_microphone_stream::<u16>(
                        &device,
                        &stream_config,
                        channels,
                        microphone_sample_sender.clone(),
                        thread_overflow.clone(),
                        on_error,
                    ),
                    format => Err(format!("Unsupported microphone sample format: {format}")),
                }?;
                stream
                    .play()
                    .map_err(|error| format!("Failed to start microphone capture: {error}"))?;
                let _ = startup_sender.send(Ok(sample_rate));
                let _ = stop_receiver.recv();
                drop(stream);
                Ok::<(), String>(())
            })();
            if let Err(error) = result {
                let _ = startup_sender.send(Err(error.clone()));
                if let Ok(mut slot) = thread_error.lock() {
                    *slot = Some(error);
                }
            }
            let _ = done_sender.send(());
        })
        .map_err(|error| format!("Failed to start microphone thread: {error}"))?;

    let sample_rate = match startup_receiver.recv_timeout(Duration::from_secs(3)) {
        Ok(Ok(sample_rate)) => sample_rate,
        Ok(Err(error)) => {
            let _ = stop_sender.send(());
            if done_receiver.recv_timeout(WRITER_STOP_TIMEOUT).is_ok() {
                let _ = microphone_thread.join();
            }
            return Err(error);
        }
        Err(_) => {
            let _ = stop_sender.send(());
            if done_receiver.recv_timeout(WRITER_STOP_TIMEOUT).is_ok() {
                let _ = microphone_thread.join();
            }
            return Err("Microphone capture did not start within three seconds.".to_string());
        }
    };
    let writer = match spawn_channel_writer_with_receiver(
        session_dir,
        CallAudioChannel::Me,
        capture_generation,
        first_part,
        sample_rate,
        started_at,
        sample_sender,
        sample_receiver,
        overflow,
    ) {
        Ok(writer) => writer,
        Err(error) => {
            let _ = stop_sender.send(());
            if done_receiver.recv_timeout(WRITER_STOP_TIMEOUT).is_ok() {
                let _ = microphone_thread.join();
            }
            return Err(error);
        }
    };
    Ok((writer, stop_sender, done_receiver, microphone_thread))
}

fn build_microphone_stream<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    channels: usize,
    sender: SyncSender<Vec<f32>>,
    overflow: Arc<AtomicU64>,
    on_error: impl FnMut(cpal::StreamError) + Send + 'static,
) -> Result<Stream, String>
where
    T: SizedSample + Sample,
    f32: FromSample<T>,
{
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                let mut mono = Vec::with_capacity(data.len() / channels.max(1));
                for frame in data.chunks(channels.max(1)) {
                    let sum = frame
                        .iter()
                        .fold(0.0_f32, |total, sample| total + f32::from_sample(*sample));
                    mono.push(sum / frame.len().max(1) as f32);
                }
                if !mono.is_empty() {
                    match sender.try_send(mono) {
                        Ok(()) => {}
                        Err(TrySendError::Full(_)) => {
                            overflow.fetch_add(1, Ordering::AcqRel);
                        }
                        Err(TrySendError::Disconnected(_)) => {}
                    }
                }
            },
            on_error,
            None,
        )
        .map_err(|error| format!("Failed to create microphone stream: {error}"))
}

fn enqueue_samples(writer: &ChannelWriterHandle, samples: &[f32], sample_rate: u32) {
    let Some(sender) = writer.sender.as_ref() else {
        return;
    };
    if sample_rate == 0 {
        writer.overflow_count.fetch_add(1, Ordering::AcqRel);
        return;
    }
    match sender.try_send(samples.to_vec()) {
        Ok(()) => {}
        Err(TrySendError::Full(_)) => {
            writer.overflow_count.fetch_add(1, Ordering::AcqRel);
        }
        Err(TrySendError::Disconnected(_)) => {}
    }
}

fn finish_channel_writer(
    writer: &mut ChannelWriterHandle,
) -> Result<Vec<CallAudioChunk>, String> {
    writer.sender.take();
    let Some(completion) = writer.completion.take() else {
        return Err(format!(
            "{} audio writer is unavailable.",
            channel_name(&writer.channel)
        ));
    };
    let result = completion.recv_timeout(WRITER_STOP_TIMEOUT).map_err(|_| {
        format!(
            "{} audio writer did not stop within 500 ms.",
            channel_name(&writer.channel)
        )
    })?;
    if let Some(join) = writer.join.take() {
        join.join()
            .map_err(|_| format!("{} audio writer panicked.", channel_name(&writer.channel)))?;
    }
    result
}

fn write_channel_chunks(
    session_dir: &Path,
    channel: CallAudioChannel,
    capture_generation: u64,
    mut part: u32,
    sample_rate: u32,
    started_at: u64,
    receiver: Receiver<Vec<f32>>,
) -> Result<Vec<CallAudioChunk>, String> {
    let max_samples = sample_rate as u64 * MAX_CHUNK_DURATION_SECS;
    let mut chunks = Vec::new();
    let mut writer: Option<WavWriter<BufWriter<File>>> = None;
    let mut path: Option<PathBuf> = None;
    let mut sample_count = 0_u64;
    let mut chunk_started_at = started_at;

    for samples in receiver {
        for sample in samples {
            if writer.is_none() {
                let next_path = chunk_path(session_dir, &channel, capture_generation, part);
                writer = Some(
                    WavWriter::create(
                        &next_path,
                        WavSpec {
                            channels: 1,
                            sample_rate,
                            bits_per_sample: 16,
                            sample_format: hound::SampleFormat::Int,
                        },
                    )
                    .map_err(|error| format!("Failed to create audio chunk: {error}"))?,
                );
                path = Some(next_path);
            }
            let value = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
            writer
                .as_mut()
                .expect("writer exists after initialization")
                .write_sample(value)
                .map_err(|error| format!("Failed to write audio chunk: {error}"))?;
            sample_count = sample_count.saturating_add(1);
            if sample_count >= max_samples {
                chunks.push(finalize_chunk(
                    writer.take().expect("writer exists at rotation"),
                    path.take().expect("path exists at rotation"),
                    channel.clone(),
                    capture_generation,
                    part,
                    sample_rate,
                    sample_count,
                    chunk_started_at,
                )?);
                chunk_started_at = chunks.last().map(|chunk| chunk.ended_at).unwrap_or(started_at);
                sample_count = 0;
                part = part.saturating_add(1);
            }
        }
    }

    if let (Some(writer), Some(path)) = (writer, path) {
        chunks.push(finalize_chunk(
            writer,
            path,
            channel,
            capture_generation,
            part,
            sample_rate,
            sample_count,
            chunk_started_at,
        )?);
    }
    Ok(chunks)
}

fn finalize_chunk(
    writer: WavWriter<BufWriter<File>>,
    path: PathBuf,
    channel: CallAudioChannel,
    capture_generation: u64,
    part: u32,
    sample_rate: u32,
    sample_count: u64,
    started_at: u64,
) -> Result<CallAudioChunk, String> {
    writer
        .finalize()
        .map_err(|error| format!("Failed to finalize audio chunk: {error}"))?;
    let duration_ms = sample_count.saturating_mul(1_000) / sample_rate as u64;
    let byte_count = fs::metadata(&path)
        .map_err(|error| format!("Failed to inspect audio chunk: {error}"))?
        .len();
    let sha256 = hash_file(&path)?;
    Ok(CallAudioChunk {
        audio_chunk_id: format!(
            "audio-{}-{}-{}",
            channel_name(&channel),
            capture_generation,
            part
        ),
        channel,
        capture_generation,
        part,
        started_at,
        ended_at: started_at.saturating_add(duration_ms),
        sample_rate,
        channel_count: 1,
        sample_format: "pcm-s16le".to_string(),
        duration_ms,
        byte_count,
        sha256,
        relative_path: format!(
            "{AUDIO_DIR}/{}",
            path.file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("audio.wav")
        ),
        gap_count: 0,
    })
}

fn apply_channel_result(
    manifest: &mut CallAudioManifest,
    channel_kind: CallAudioChannel,
    result: Result<Vec<CallAudioChunk>, String>,
    overflow_count: u64,
) {
    let (chunks, failure) = match result {
        Ok(chunks) => (chunks, None),
        Err(error) => (Vec::new(), Some(error)),
    };
    let added_count = chunks.len() as u32;
    let added_bytes: u64 = chunks.iter().map(|chunk| chunk.byte_count).sum();
    let added_duration: u64 = chunks.iter().map(|chunk| chunk.duration_ms).sum();
    manifest.chunks.extend(chunks);
    if let Some(channel) = channel_mut(manifest, channel_kind) {
        channel.chunk_count = channel.chunk_count.saturating_add(added_count);
        channel.byte_count = channel.byte_count.saturating_add(added_bytes);
        channel.duration_ms = channel.duration_ms.saturating_add(added_duration);
        channel.gap_count = channel.gap_count.saturating_add(overflow_count);
        channel.overflow_count = channel.overflow_count.saturating_add(overflow_count);
        let previous_failure = channel.failure.take();
        channel.failure = failure.or(previous_failure);
        channel.health = if channel.health == CallAudioChannelHealth::Partial
            || channel.failure.is_some()
            || channel.gap_count > 0
            || overflow_count > 0
        {
            CallAudioChannelHealth::Partial
        } else if added_count == 0 && channel.chunk_count == 0 {
            CallAudioChannelHealth::Missing
        } else {
            CallAudioChannelHealth::Complete
        };
    }
}

fn next_part(
    manifest: &CallAudioManifest,
    channel: CallAudioChannel,
    capture_generation: u64,
) -> u32 {
    manifest
        .chunks
        .iter()
        .filter(|chunk| {
            chunk.channel == channel && chunk.capture_generation == capture_generation
        })
        .map(|chunk| chunk.part)
        .max()
        .unwrap_or(0)
        .saturating_add(1)
}

fn channel_mut(
    manifest: &mut CallAudioManifest,
    channel: CallAudioChannel,
) -> Option<&mut CallAudioChannelStatus> {
    manifest
        .channels
        .iter_mut()
        .find(|status| status.channel == channel)
}

fn chunk_path(
    session_dir: &Path,
    channel: &CallAudioChannel,
    capture_generation: u64,
    part: u32,
) -> PathBuf {
    session_dir.join(AUDIO_DIR).join(format!(
        "{}-generation-{}-part-{}.wav",
        channel_name(channel),
        capture_generation,
        part
    ))
}

fn channel_name(channel: &CallAudioChannel) -> &'static str {
    match channel {
        CallAudioChannel::Them => "them",
        CallAudioChannel::Me => "me",
    }
}

pub(crate) fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("Failed to read audio chunk for hashing: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("Failed to hash audio chunk: {error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn get_manifest_for_app(
    app: &AppHandle,
    call_session_id: &str,
) -> Result<Option<CallAudioManifest>, String> {
    let session_dir = resolve_session_dir(app, call_session_id)?;
    read_for_session_dir(&session_dir)
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
    actor: &str,
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
    append_retention_action(&mut manifest, "delete", actor, occurred_at, 0);
    write_for_session_dir(session_dir, &manifest)?;
    Ok(manifest)
}

fn append_retention_action(
    manifest: &mut CallAudioManifest,
    action: &str,
    actor: &str,
    occurred_at: u64,
    future_revision_delta: u64,
) {
    manifest.retention_actions.push(CallAudioRetentionAction {
        action: action.to_string(),
        actor: actor.to_string(),
        occurred_at,
        audio_recording_revision: manifest
            .audio_recording_revision
            .saturating_add(future_revision_delta),
    });
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
            "retention-policy",
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
            append_retention_action(manifest, "preserve", "user", 2_000, 1);
            Ok(())
        })
        .unwrap();
        assert_eq!(preserved.retention_mode, CallAudioRetentionMode::Preserved);
        assert_eq!(preserved.retention_actions.len(), 1);
        assert_eq!(preserved.retention_actions[0].action, "preserve");
        assert_eq!(preserved.retention_actions[0].actor, "user");
        assert_eq!(
            preserved.retention_actions[0].audio_recording_revision,
            preserved.audio_recording_revision
        );
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
        assert_eq!(manifest.retention_actions.len(), 1);
        assert_eq!(manifest.retention_actions[0].action, "delete");
        assert_eq!(manifest.retention_actions[0].actor, "retention-policy");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn historical_sessions_without_audio_are_valid() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        assert_eq!(read_for_session_dir(&root).unwrap(), None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn channel_writer_creates_hashed_pcm_wav_evidence() {
        let root = test_root();
        fs::create_dir_all(root.join(AUDIO_DIR)).unwrap();
        let (sender, receiver) = sync_channel(2);
        sender.send(vec![0.0, 0.25, -0.25, 1.0, -1.0]).unwrap();
        drop(sender);

        let chunks = write_channel_chunks(
            &root,
            CallAudioChannel::Them,
            7,
            1,
            8_000,
            1_000,
            receiver,
        )
        .unwrap();

        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].sample_format, "pcm-s16le");
        assert_eq!(chunks[0].sample_rate, 8_000);
        assert!(chunks[0].byte_count > 44);
        assert_eq!(chunks[0].sha256.len(), 64);
        let reader = hound::WavReader::open(root.join(&chunks[0].relative_path)).unwrap();
        assert_eq!(reader.spec().channels, 1);
        assert_eq!(reader.duration(), 5);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn later_success_does_not_hide_an_existing_channel_gap() {
        let mut manifest = empty_manifest("call-gap", 1_000);
        let channel = channel_mut(&mut manifest, CallAudioChannel::Them).unwrap();
        channel.health = CallAudioChannelHealth::Partial;
        channel.gap_count = 1;
        channel.failure = Some("prior writer gap".to_string());

        apply_channel_result(
            &mut manifest,
            CallAudioChannel::Them,
            Ok(vec![CallAudioChunk {
                audio_chunk_id: "audio-them-2-1".to_string(),
                channel: CallAudioChannel::Them,
                capture_generation: 2,
                part: 1,
                started_at: 2_000,
                ended_at: 2_100,
                sample_rate: 16_000,
                channel_count: 1,
                sample_format: "pcm-s16le".to_string(),
                duration_ms: 100,
                byte_count: 3_244,
                sha256: "a".repeat(64),
                relative_path: "audio/them-generation-2-part-1.wav".to_string(),
                gap_count: 0,
            }]),
            0,
        );

        let channel = channel_mut(&mut manifest, CallAudioChannel::Them).unwrap();
        assert_eq!(channel.health, CallAudioChannelHealth::Partial);
        assert_eq!(channel.gap_count, 1);
        assert_eq!(channel.failure.as_deref(), Some("prior writer gap"));
        assert_eq!(channel.chunk_count, 1);
    }
}
