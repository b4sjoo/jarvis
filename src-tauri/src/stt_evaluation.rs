use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use hound::{WavSpec, WavWriter};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;
use uuid::Uuid;

const STT_EVALUATION_CAPTURE_DIR: &str = "stt-evaluation-captures";
const DEFAULT_TTL_HOURS: u64 = 72;
const MAX_TTL_HOURS: u64 = 24 * 14;
const MAX_SUBMITTED_AUDIO_BYTES: usize = 32 * 1024 * 1024;
const RAW_AUDIO_CHUNK_MS: usize = 500;
const RAW_AUDIO_QUEUE_CAPACITY: usize = 24;
const RAW_AUDIO_FILE_CHUNK_SECONDS: usize = 30;

#[derive(Debug, Default)]
pub struct SttEvaluationCaptureState {
    current: Mutex<Option<SttEvaluationCaptureSession>>,
}

#[derive(Debug, Clone)]
struct SttEvaluationCaptureSession {
    session_id: String,
    folder_name: String,
    folder_path: PathBuf,
    started_at_ms: u64,
    expires_at_ms: u64,
    active: Arc<AtomicBool>,
    ended_at_ms: Arc<Mutex<Option<u64>>>,
    open_raw_writer_count: Arc<AtomicU64>,
    manifest_revision: Arc<AtomicU64>,
    counters: Arc<Mutex<SttEvaluationCaptureCounters>>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct SttEvaluationCaptureCounters {
    raw_chunk_count: u64,
    submitted_audio_count: u64,
    provider_event_count: u64,
    canonical_event_count: u64,
    human_reference_count: u64,
    bytes_written: u64,
    dropped_raw_chunk_count: u64,
    last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SttEvaluationCaptureStatus {
    active: bool,
    lifecycle: &'static str,
    session_id: Option<String>,
    folder_name: Option<String>,
    folder_path: Option<String>,
    started_at: Option<u64>,
    expires_at: Option<u64>,
    raw_chunk_count: u64,
    submitted_audio_count: u64,
    provider_event_count: u64,
    canonical_event_count: u64,
    human_reference_count: u64,
    bytes_written: u64,
    dropped_raw_chunk_count: u64,
    open_raw_writer_count: u64,
    manifest_revision: u64,
    manifest_finalized: bool,
    ended_at: Option<u64>,
    last_error: Option<String>,
}

impl Default for SttEvaluationCaptureStatus {
    fn default() -> Self {
        Self {
            active: false,
            lifecycle: "idle",
            session_id: None,
            folder_name: None,
            folder_path: None,
            started_at: None,
            expires_at: None,
            raw_chunk_count: 0,
            submitted_audio_count: 0,
            provider_event_count: 0,
            canonical_event_count: 0,
            human_reference_count: 0,
            bytes_written: 0,
            dropped_raw_chunk_count: 0,
            open_raw_writer_count: 0,
            manifest_revision: 0,
            manifest_finalized: false,
            ended_at: None,
            last_error: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SttEvaluationSubmittedAudioMetadata {
    pub utterance_id: String,
    pub trace_id: String,
    pub audio_session_id: String,
    pub audio_segment_sequence: u64,
    pub native_capture_session_id: Option<String>,
    pub native_capture_generation: Option<u64>,
    pub native_segment_sequence: Option<u64>,
    pub native_captured_at_ms: Option<u64>,
    pub native_sample_rate: Option<u32>,
    pub queued_at: u64,
    pub submitted_at: u64,
    pub media_type: String,
    pub audio_bytes: u64,
}

#[derive(Debug)]
struct RawAudioChunk {
    captured_at_ms: u64,
    samples: Vec<f32>,
}

pub struct RawEvaluationCaptureTap {
    app: AppHandle,
    session_id: String,
    capture_session_id: String,
    capture_generation: u64,
    sample_rate: u32,
    chunk_samples: usize,
    next_sequence: u64,
    buffer: Vec<f32>,
    sender: Option<mpsc::Sender<RawAudioChunk>>,
    active: Arc<AtomicBool>,
}

impl RawEvaluationCaptureTap {
    pub fn push_sample(&mut self, sample: f32) {
        if !self.active.load(Ordering::Acquire) {
            self.buffer.clear();
            self.sender.take();
            return;
        }
        self.buffer.push(sample);
        if self.buffer.len() >= self.chunk_samples {
            self.flush();
        }
    }

    fn flush(&mut self) {
        if self.buffer.is_empty() {
            return;
        }
        let Some(sender) = &self.sender else {
            self.buffer.clear();
            return;
        };
        self.next_sequence = self.next_sequence.saturating_add(1);
        let samples = std::mem::take(&mut self.buffer);
        let chunk = RawAudioChunk {
            captured_at_ms: now_ms(),
            samples,
        };

        if let Err(error) = sender.try_send(chunk) {
            let reason = match error {
                TrySendError::Full(_) => "raw audio writer queue is full",
                TrySendError::Closed(_) => "raw audio writer is closed",
            };
            update_session_counters(&self.app, &self.session_id, |counters| {
                counters.dropped_raw_chunk_count =
                    counters.dropped_raw_chunk_count.saturating_add(1);
                counters.last_error = Some(reason.to_string());
            });
            let _ = append_capture_event(
                &self.app,
                &self.session_id,
                json!({
                    "kind": "raw-audio-chunk-dropped",
                    "captureSessionId": self.capture_session_id,
                    "captureGeneration": self.capture_generation,
                    "sequence": self.next_sequence,
                    "sampleRate": self.sample_rate,
                    "reason": reason,
                    "occurredAt": now_ms(),
                }),
            );
        }
    }
}

impl Drop for RawEvaluationCaptureTap {
    fn drop(&mut self) {
        self.flush();
        self.sender.take();
    }
}

#[tauri::command]
pub fn start_stt_evaluation_capture(
    app: AppHandle,
    ttl_hours: Option<u64>,
) -> Result<SttEvaluationCaptureStatus, String> {
    cleanup_expired_stt_evaluation_captures(&app)?;
    let state = app.state::<SttEvaluationCaptureState>();
    let mut current = state
        .current
        .lock()
        .map_err(|error| format!("Failed to acquire STT evaluation state: {}", error))?;
    if let Some(session) = current.as_ref() {
        if session.active.load(Ordering::Acquire) {
            return Ok(status_for_session(session));
        }
    }

    let started_at_ms = now_ms();
    let ttl_hours = ttl_hours
        .unwrap_or(DEFAULT_TTL_HOURS)
        .clamp(1, MAX_TTL_HOURS);
    let expires_at_ms = started_at_ms.saturating_add(ttl_hours.saturating_mul(60 * 60 * 1_000));
    let session_id = format!("stt_eval_{}", Uuid::new_v4());
    let short_id = session_id
        .strip_prefix("stt_eval_")
        .unwrap_or(&session_id)
        .chars()
        .take(8)
        .collect::<String>();
    let folder_name = format!("stt-eval-{}_{}", started_at_ms, short_id);
    let root = stt_evaluation_root(&app)?;
    let folder_path = root.join(&folder_name);

    create_private_dir(&folder_path)?;
    for relative in [
        "source-audio",
        "submitted-audio",
        "provider-events",
        "canonical",
        "references",
        "events",
    ] {
        create_private_dir(&folder_path.join(relative))?;
    }

    let session = SttEvaluationCaptureSession {
        session_id,
        folder_name,
        folder_path,
        started_at_ms,
        expires_at_ms,
        active: Arc::new(AtomicBool::new(true)),
        ended_at_ms: Arc::new(Mutex::new(None)),
        open_raw_writer_count: Arc::new(AtomicU64::new(0)),
        manifest_revision: Arc::new(AtomicU64::new(0)),
        counters: Arc::new(Mutex::new(SttEvaluationCaptureCounters::default())),
    };
    write_manifest(&session, None, None)?;
    write_private_text(
        &session.folder_path.join("README.md"),
        "# STT Evaluation Capture\n\nLocal-only system-audio evidence. Raw audio and transcript revisions must never be used as runtime prompt context. Human-confirmed references are the only formal WER ground truth.\n",
        false,
    )?;
    for relative in [
        "provider-events/raw-transcript-revisions.jsonl",
        "canonical/transcript-turns.jsonl",
        "references/human-corrections.jsonl",
        "events/audio-artifacts.jsonl",
        "events/lifecycle.jsonl",
    ] {
        write_private_text(&session.folder_path.join(relative), "", false)?;
    }
    append_lifecycle_event(
        &session,
        json!({
            "kind": "evaluation-capture-started",
            "sessionId": session.session_id,
            "startedAt": started_at_ms,
            "expiresAt": expires_at_ms,
            "localOnly": true,
            "sourceLane": "system-audio",
        }),
    )?;
    *current = Some(session.clone());
    Ok(status_for_session(&session))
}

#[tauri::command]
pub async fn stop_stt_evaluation_capture(
    app: AppHandle,
    reason: Option<String>,
) -> Result<SttEvaluationCaptureStatus, String> {
    let state = app.state::<SttEvaluationCaptureState>();
    let session = state
        .current
        .lock()
        .map_err(|error| format!("Failed to acquire STT evaluation state: {}", error))?
        .as_ref()
        .cloned();
    let Some(session) = session else {
        return Ok(SttEvaluationCaptureStatus::default());
    };
    let ended_at = now_ms();
    session.active.store(false, Ordering::Release);
    if let Ok(mut stored_ended_at) = session.ended_at_ms.lock() {
        *stored_ended_at = Some(ended_at);
    }
    append_lifecycle_event(
        &session,
        json!({
            "kind": "evaluation-capture-stopped",
            "sessionId": session.session_id,
            "endedAt": ended_at,
            "reason": reason.unwrap_or_else(|| "manual".to_string()),
        }),
    )?;
    write_manifest(&session, Some(ended_at), None)?;
    for _ in 0..20 {
        if session.open_raw_writer_count.load(Ordering::Acquire) == 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    write_manifest(&session, Some(ended_at), None)?;
    Ok(status_for_session(&session))
}

#[tauri::command]
pub fn get_stt_evaluation_capture_status(
    app: AppHandle,
) -> Result<SttEvaluationCaptureStatus, String> {
    let state = app.state::<SttEvaluationCaptureState>();
    let current = state
        .current
        .lock()
        .map_err(|error| format!("Failed to acquire STT evaluation state: {}", error))?;
    Ok(current.as_ref().map(status_for_session).unwrap_or_default())
}

#[tauri::command]
pub fn delete_stt_evaluation_capture(app: AppHandle) -> Result<SttEvaluationCaptureStatus, String> {
    let state = app.state::<SttEvaluationCaptureState>();
    let mut current = state
        .current
        .lock()
        .map_err(|error| format!("Failed to acquire STT evaluation state: {}", error))?;
    let Some(session) = current.as_ref() else {
        return Ok(SttEvaluationCaptureStatus::default());
    };
    if session.active.load(Ordering::Acquire) {
        return Err("Stop STT Evaluation Capture before deleting it.".to_string());
    }
    let session_id = session.session_id.clone();
    let folder_name = session.folder_name.clone();
    let root = stt_evaluation_root(&app)?;
    fs::remove_dir_all(&session.folder_path)
        .map_err(|error| format!("Failed to delete STT evaluation capture: {}", error))?;
    append_deletion_audit(
        &root,
        json!({
            "sessionId": session_id,
            "folderName": folder_name,
            "deletedAt": now_ms(),
            "reason": "manual",
        }),
    )?;
    *current = None;
    Ok(SttEvaluationCaptureStatus::default())
}

#[tauri::command]
pub fn cleanup_stt_evaluation_captures(app: AppHandle) -> Result<u64, String> {
    cleanup_expired_stt_evaluation_captures(&app)
}

#[tauri::command]
pub fn record_stt_evaluation_submitted_audio(
    app: AppHandle,
    session_id: String,
    base64_payload: String,
    metadata: SttEvaluationSubmittedAudioMetadata,
) -> Result<String, String> {
    let session = resolve_session(&app, &session_id)?;
    if base64_payload.len() > MAX_SUBMITTED_AUDIO_BYTES * 2 {
        return Err("Submitted STT evaluation audio is too large.".to_string());
    }
    let bytes = B64
        .decode(base64_payload.as_bytes())
        .map_err(|error| format!("Failed to decode submitted STT audio: {}", error))?;
    if bytes.len() > MAX_SUBMITTED_AUDIO_BYTES {
        return Err("Submitted STT evaluation audio is too large.".to_string());
    }
    let safe_utterance_id = sanitize_identifier(&metadata.utterance_id);
    let relative_path =
        submitted_audio_relative_path(&safe_utterance_id, metadata.audio_segment_sequence);
    let sha256 = sha256_hex(&bytes);
    write_private_bytes(&session.folder_path.join(&relative_path), &bytes)?;
    append_capture_event(
        &app,
        &session_id,
        json!({
            "kind": "submitted-audio",
            "sessionId": session_id,
            "relativePath": relative_path,
            "recordedAt": now_ms(),
            "source": "system-audio",
            "processingStage": "vad-submitted",
            "channels": 1,
            "encoding": metadata.media_type.clone(),
            "sha256": sha256,
            "metadata": metadata,
        }),
    )?;
    update_session_counters(&app, &session.session_id, |counters| {
        counters.submitted_audio_count = counters.submitted_audio_count.saturating_add(1);
        counters.bytes_written = counters.bytes_written.saturating_add(bytes.len() as u64);
    });
    Ok(session
        .folder_path
        .join(relative_path)
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
pub fn record_stt_evaluation_transcript_event(
    app: AppHandle,
    session_id: String,
    stream: String,
    payload: String,
) -> Result<(), String> {
    let session = resolve_session(&app, &session_id)?;
    let parsed: Value = serde_json::from_str(&payload)
        .map_err(|error| format!("Invalid STT evaluation transcript payload: {}", error))?;
    let (relative_path, counter_kind) = match stream.as_str() {
        "provider" => ("provider-events/raw-transcript-revisions.jsonl", "provider"),
        "canonical" => ("canonical/transcript-turns.jsonl", "canonical"),
        "human-reference" => ("references/human-corrections.jsonl", "human-reference"),
        _ => return Err("Unsupported STT evaluation transcript stream.".to_string()),
    };
    append_private_jsonl(
        &session.folder_path.join(relative_path),
        &json!({
            "sessionId": session_id,
            "recordedAt": now_ms(),
            "payload": parsed,
        }),
    )?;
    update_session_counters(&app, &session.session_id, |counters| match counter_kind {
        "provider" => {
            counters.provider_event_count = counters.provider_event_count.saturating_add(1)
        }
        "canonical" => {
            counters.canonical_event_count = counters.canonical_event_count.saturating_add(1)
        }
        "human-reference" => {
            counters.human_reference_count = counters.human_reference_count.saturating_add(1)
        }
        _ => {}
    });
    Ok(())
}

pub fn create_raw_evaluation_capture_tap(
    app: &AppHandle,
    capture_session_id: &str,
    capture_generation: u64,
    sample_rate: u32,
) -> Option<RawEvaluationCaptureTap> {
    let state = app.state::<SttEvaluationCaptureState>();
    let current = state.current.lock().ok()?;
    let session = current.as_ref()?.clone();
    if !session.active.load(Ordering::Acquire) {
        return None;
    }
    drop(current);

    let chunk_samples = ((sample_rate as usize * RAW_AUDIO_CHUNK_MS) / 1_000).max(1);
    let (sender, receiver) = mpsc::channel(RAW_AUDIO_QUEUE_CAPACITY);
    session.open_raw_writer_count.fetch_add(1, Ordering::AcqRel);
    let session_for_writer = session.clone();
    let capture_id = capture_session_id.to_string();
    tokio::spawn(async move {
        run_raw_audio_writer(
            session_for_writer,
            capture_id,
            capture_generation,
            sample_rate,
            receiver,
        )
        .await;
    });

    let _ = append_capture_event(
        app,
        &session.session_id,
        json!({
            "kind": "raw-capture-started",
            "sessionId": session.session_id,
            "captureSessionId": capture_session_id,
            "captureGeneration": capture_generation,
            "sampleRate": sample_rate,
            "chunkDurationMs": RAW_AUDIO_CHUNK_MS,
            "startedAt": now_ms(),
        }),
    );

    Some(RawEvaluationCaptureTap {
        app: app.clone(),
        session_id: session.session_id,
        capture_session_id: capture_session_id.to_string(),
        capture_generation,
        sample_rate,
        chunk_samples,
        next_sequence: 0,
        buffer: Vec::with_capacity(chunk_samples),
        sender: Some(sender),
        active: session.active,
    })
}

pub fn cleanup_expired_stt_evaluation_captures(app: &AppHandle) -> Result<u64, String> {
    let root = stt_evaluation_root(app)?;
    if !root.exists() {
        return Ok(0);
    }
    let now = now_ms();
    let active_session_id = app
        .try_state::<SttEvaluationCaptureState>()
        .and_then(|state| {
            state.current.lock().ok()?.as_ref().and_then(|session| {
                session
                    .active
                    .load(Ordering::Acquire)
                    .then(|| session.session_id.clone())
            })
        });
    let mut deleted = 0_u64;

    for entry in fs::read_dir(&root)
        .map_err(|error| format!("Failed to inspect STT evaluation captures: {}", error))?
    {
        let entry = entry
            .map_err(|error| format!("Failed to inspect STT evaluation capture: {}", error))?;
        if !entry
            .file_type()
            .map_err(|error| format!("Failed to inspect STT evaluation capture type: {}", error))?
            .is_dir()
        {
            continue;
        }
        let manifest_path = entry.path().join("manifest.json");
        let Ok(contents) = fs::read_to_string(&manifest_path) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<Value>(&contents) else {
            continue;
        };
        let session_id = manifest
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let expires_at = manifest
            .get("expiresAt")
            .and_then(Value::as_u64)
            .unwrap_or(u64::MAX);
        if active_session_id.as_deref() == Some(session_id) || expires_at > now {
            continue;
        }
        fs::remove_dir_all(entry.path()).map_err(|error| {
            format!("Failed to remove expired STT evaluation capture: {}", error)
        })?;
        append_deletion_audit(
            &root,
            json!({
                "sessionId": session_id,
                "folderName": entry.file_name().to_string_lossy(),
                "deletedAt": now,
                "reason": "ttl-expired",
            }),
        )?;
        deleted = deleted.saturating_add(1);
    }
    Ok(deleted)
}

async fn run_raw_audio_writer(
    session: SttEvaluationCaptureSession,
    capture_session_id: String,
    capture_generation: u64,
    sample_rate: u32,
    mut receiver: mpsc::Receiver<RawAudioChunk>,
) {
    let file_chunk_samples = (sample_rate as usize).saturating_mul(RAW_AUDIO_FILE_CHUNK_SECONDS);
    let mut file_sequence = 0_u64;
    let mut file_sample_start = 0_u64;
    let mut pending_samples = Vec::with_capacity(file_chunk_samples);
    let mut first_captured_at_ms: Option<u64> = None;
    let mut last_captured_at_ms: Option<u64> = None;
    while let Some(chunk) = receiver.recv().await {
        first_captured_at_ms.get_or_insert(chunk.captured_at_ms);
        last_captured_at_ms = Some(chunk.captured_at_ms);
        pending_samples.extend_from_slice(&chunk.samples);

        while pending_samples.len() >= file_chunk_samples {
            let remaining = pending_samples.split_off(file_chunk_samples);
            let samples = std::mem::replace(&mut pending_samples, remaining);
            file_sequence = file_sequence.saturating_add(1);
            write_raw_audio_file_chunk(
                &session,
                &capture_session_id,
                capture_generation,
                sample_rate,
                file_sequence,
                file_sample_start,
                first_captured_at_ms,
                last_captured_at_ms,
                &samples,
            );
            file_sample_start = file_sample_start.saturating_add(samples.len() as u64);
            first_captured_at_ms = if pending_samples.is_empty() {
                None
            } else {
                last_captured_at_ms
            };
        }
    }

    if !pending_samples.is_empty() {
        file_sequence = file_sequence.saturating_add(1);
        write_raw_audio_file_chunk(
            &session,
            &capture_session_id,
            capture_generation,
            sample_rate,
            file_sequence,
            file_sample_start,
            first_captured_at_ms,
            last_captured_at_ms,
            &pending_samples,
        );
    }
    let _ = append_capture_event_for_session(
        &session,
        json!({
            "kind": "raw-capture-writer-closed",
            "sessionId": session.session_id,
            "captureSessionId": capture_session_id,
            "captureGeneration": capture_generation,
            "fileCount": file_sequence,
            "closedAt": now_ms(),
        }),
    );
    let _ =
        session
            .open_raw_writer_count
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                Some(count.saturating_sub(1))
            });
    let ended_at = session
        .ended_at_ms
        .lock()
        .ok()
        .and_then(|ended_at| *ended_at);
    let _ = write_manifest(&session, ended_at, None);
}

#[allow(clippy::too_many_arguments)]
fn write_raw_audio_file_chunk(
    session: &SttEvaluationCaptureSession,
    capture_session_id: &str,
    capture_generation: u64,
    sample_rate: u32,
    file_sequence: u64,
    sample_start: u64,
    first_captured_at_ms: Option<u64>,
    last_captured_at_ms: Option<u64>,
    samples: &[f32],
) {
    let relative_path = format!(
        "source-audio/system-{}-{}-{:05}.wav",
        sanitize_identifier(capture_session_id),
        capture_generation,
        file_sequence
    );
    let bytes = match samples_to_wav_bytes(sample_rate, samples) {
        Ok(bytes) => bytes,
        Err(error) => {
            update_session_counters_for_session(session, |counters| {
                counters.dropped_raw_chunk_count =
                    counters.dropped_raw_chunk_count.saturating_add(1);
                counters.last_error = Some(error);
            });
            return;
        }
    };
    if let Err(error) = write_private_bytes(&session.folder_path.join(&relative_path), &bytes) {
        update_session_counters_for_session(session, |counters| {
            counters.dropped_raw_chunk_count = counters.dropped_raw_chunk_count.saturating_add(1);
            counters.last_error = Some(error);
        });
        return;
    }

    let sample_count = samples.len() as u64;
    let duration_ms = sample_count.saturating_mul(1_000) / sample_rate.max(1) as u64;
    let sha256 = sha256_hex(&bytes);
    let captured_start_at_ms =
        first_captured_at_ms.map(|time| time.saturating_sub(RAW_AUDIO_CHUNK_MS as u64));
    let _ = append_capture_event_for_session(
        session,
        json!({
            "kind": "raw-audio-chunk",
            "sessionId": session.session_id,
            "relativePath": relative_path,
            "captureSessionId": capture_session_id,
            "captureGeneration": capture_generation,
            "sequence": file_sequence,
            "sampleRate": sample_rate,
            "sampleStart": sample_start,
            "sampleCount": sample_count,
            "durationMs": duration_ms,
            "capturedStartAt": captured_start_at_ms,
            "capturedEndAt": last_captured_at_ms,
            "source": "system-audio",
            "processingStage": "pre-vad-noise-gate",
            "channels": 1,
            "encoding": "audio/wav; codec=pcm_s16le",
            "sha256": sha256,
            "bytes": bytes.len(),
        }),
    );
    update_session_counters_for_session(session, |counters| {
        counters.raw_chunk_count = counters.raw_chunk_count.saturating_add(1);
        counters.bytes_written = counters.bytes_written.saturating_add(bytes.len() as u64);
    });
}

fn resolve_session(
    app: &AppHandle,
    expected_session_id: &str,
) -> Result<SttEvaluationCaptureSession, String> {
    let state = app.state::<SttEvaluationCaptureState>();
    let current = state
        .current
        .lock()
        .map_err(|error| format!("Failed to acquire STT evaluation state: {}", error))?;
    let session = current
        .as_ref()
        .filter(|session| session.session_id == expected_session_id)
        .cloned()
        .ok_or_else(|| "STT evaluation session is no longer available.".to_string())?;
    Ok(session)
}

fn status_for_session(session: &SttEvaluationCaptureSession) -> SttEvaluationCaptureStatus {
    let active = session.active.load(Ordering::Acquire);
    let open_raw_writer_count = session.open_raw_writer_count.load(Ordering::Acquire);
    let ended_at = session
        .ended_at_ms
        .lock()
        .ok()
        .and_then(|ended_at| *ended_at);
    let manifest_revision = session.manifest_revision.load(Ordering::Acquire);
    let manifest_finalized = !active && open_raw_writer_count == 0 && ended_at.is_some();
    let counters = session
        .counters
        .lock()
        .map(|counters| counters.clone())
        .unwrap_or_default();
    SttEvaluationCaptureStatus {
        active,
        lifecycle: if active {
            "active"
        } else if open_raw_writer_count > 0 {
            "stopping"
        } else {
            "stopped"
        },
        session_id: Some(session.session_id.clone()),
        folder_name: Some(session.folder_name.clone()),
        folder_path: Some(session.folder_path.to_string_lossy().to_string()),
        started_at: Some(session.started_at_ms),
        expires_at: Some(session.expires_at_ms),
        raw_chunk_count: counters.raw_chunk_count,
        submitted_audio_count: counters.submitted_audio_count,
        provider_event_count: counters.provider_event_count,
        canonical_event_count: counters.canonical_event_count,
        human_reference_count: counters.human_reference_count,
        bytes_written: counters.bytes_written,
        dropped_raw_chunk_count: counters.dropped_raw_chunk_count,
        open_raw_writer_count,
        manifest_revision,
        manifest_finalized,
        ended_at,
        last_error: counters.last_error,
    }
}

fn update_session_counters(
    app: &AppHandle,
    session_id: &str,
    update: impl FnOnce(&mut SttEvaluationCaptureCounters),
) {
    let state = app.state::<SttEvaluationCaptureState>();
    let counters = {
        let Ok(current) = state.current.lock() else {
            return;
        };
        let Some(session) = current
            .as_ref()
            .filter(|session| session.session_id == session_id)
        else {
            return;
        };
        session.counters.clone()
    };
    if let Ok(mut counters) = counters.lock() {
        update(&mut counters);
    };
}

fn update_session_counters_for_session(
    session: &SttEvaluationCaptureSession,
    update: impl FnOnce(&mut SttEvaluationCaptureCounters),
) {
    if let Ok(mut counters) = session.counters.lock() {
        update(&mut counters);
    };
}

fn write_manifest(
    session: &SttEvaluationCaptureSession,
    ended_at: Option<u64>,
    deletion: Option<Value>,
) -> Result<(), String> {
    if let Some(ended_at) = ended_at {
        if let Ok(mut stored_ended_at) = session.ended_at_ms.lock() {
            *stored_ended_at = Some(ended_at);
        }
    }
    let counters = session
        .counters
        .lock()
        .map(|counters| counters.clone())
        .unwrap_or_default();
    let active = session.active.load(Ordering::Acquire);
    let open_raw_writer_count = session.open_raw_writer_count.load(Ordering::Acquire);
    let ended_at = session
        .ended_at_ms
        .lock()
        .ok()
        .and_then(|ended_at| *ended_at);
    let manifest_revision = session
        .manifest_revision
        .fetch_add(1, Ordering::AcqRel)
        .saturating_add(1);
    let manifest_finalized = !active && open_raw_writer_count == 0 && ended_at.is_some();
    let manifest = json!({
        "schemaVersion": 1,
        "sessionId": session.session_id,
        "folderName": session.folder_name,
        "status": if active {
            "running"
        } else if open_raw_writer_count > 0 {
            "stopped-pending-writer-drain"
        } else {
            "stopped"
        },
        "localOnly": true,
        "sourceLane": "system-audio",
        "startedAt": session.started_at_ms,
        "endedAt": ended_at,
        "expiresAt": session.expires_at_ms,
        "ttlHours": (session.expires_at_ms.saturating_sub(session.started_at_ms)) / 3_600_000,
        "runtimeContextPolicy": "excluded",
        "formalReferencePolicy": "human-confirmed-only",
        "counters": counters,
        "finalization": {
            "manifestRevision": manifest_revision,
            "manifestFinalized": manifest_finalized,
            "openRawWriterCount": open_raw_writer_count,
            "counterSnapshotAt": now_ms(),
            "rawWriterDrained": open_raw_writer_count == 0,
            "endedAtPresent": ended_at.is_some(),
        },
        "deletion": deletion,
    });
    write_private_text(
        &session.folder_path.join("manifest.json"),
        &serde_json::to_string_pretty(&manifest)
            .map_err(|error| format!("Failed to serialize STT evaluation manifest: {}", error))?,
        false,
    )
}

fn append_lifecycle_event(
    session: &SttEvaluationCaptureSession,
    event: Value,
) -> Result<(), String> {
    append_private_jsonl(&session.folder_path.join("events/lifecycle.jsonl"), &event)
}

fn append_capture_event(app: &AppHandle, session_id: &str, event: Value) -> Result<(), String> {
    let session = resolve_session(app, session_id)?;
    append_capture_event_for_session(&session, event)
}

fn append_capture_event_for_session(
    session: &SttEvaluationCaptureSession,
    event: Value,
) -> Result<(), String> {
    append_private_jsonl(
        &session.folder_path.join("events/audio-artifacts.jsonl"),
        &event,
    )
}

fn append_deletion_audit(root: &Path, event: Value) -> Result<(), String> {
    create_private_dir(root)?;
    append_private_jsonl(&root.join("deletions.jsonl"), &event)
}

fn samples_to_wav_bytes(sample_rate: u32, samples: &[f32]) -> Result<Vec<u8>, String> {
    if samples.is_empty() {
        return Err("Raw STT evaluation audio chunk is empty.".to_string());
    }
    let mut cursor = Cursor::new(Vec::new());
    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = WavWriter::new(&mut cursor, spec)
        .map_err(|error| format!("Failed to create raw evaluation WAV: {}", error))?;
    for sample in samples {
        writer
            .write_sample((sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
            .map_err(|error| format!("Failed to encode raw evaluation WAV: {}", error))?;
    }
    writer
        .finalize()
        .map_err(|error| format!("Failed to finalize raw evaluation WAV: {}", error))?;
    Ok(cursor.into_inner())
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn stt_evaluation_root(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {}", error))?;
    Ok(app_data_dir.join(STT_EVALUATION_CAPTURE_DIR))
}

fn sanitize_identifier(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    let trimmed = sanitized.trim_matches('-');
    if trimmed.is_empty() {
        "artifact".to_string()
    } else {
        trimmed.to_string()
    }
}

fn submitted_audio_relative_path(safe_utterance_id: &str, audio_segment_sequence: u64) -> String {
    format!(
        "submitted-audio/{}-segment-{}.wav",
        safe_utterance_id, audio_segment_sequence
    )
}

fn create_private_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("Failed to create STT evaluation directory: {}", error))?;
    set_private_dir_permissions(path)
}

fn write_private_text(path: &Path, payload: &str, append: bool) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        create_private_dir(parent)?;
    }
    let mut options = OpenOptions::new();
    options.create(true).write(true);
    if append {
        options.append(true);
    } else {
        options.truncate(true);
    }
    set_private_file_mode(&mut options);
    let mut file = options
        .open(path)
        .map_err(|error| format!("Failed to open STT evaluation file: {}", error))?;
    file.write_all(payload.as_bytes())
        .map_err(|error| format!("Failed to write STT evaluation file: {}", error))
}

fn write_private_bytes(path: &Path, payload: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        create_private_dir(parent)?;
    }
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    set_private_file_mode(&mut options);
    let mut file = options
        .open(path)
        .map_err(|error| format!("Failed to open STT evaluation binary: {}", error))?;
    file.write_all(payload)
        .map_err(|error| format!("Failed to write STT evaluation binary: {}", error))
}

fn append_private_jsonl(path: &Path, value: &Value) -> Result<(), String> {
    let payload = format!(
        "{}\n",
        serde_json::to_string(value)
            .map_err(|error| format!("Failed to serialize STT evaluation event: {}", error))?
    );
    write_private_text(path, &payload, true)
}

#[cfg(unix)]
fn set_private_file_mode(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
}

#[cfg(not(unix))]
fn set_private_file_mode(_options: &mut OpenOptions) {}

#[cfg(unix)]
fn set_private_dir_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("Failed to protect STT evaluation directory: {}", error))
}

#[cfg(not(unix))]
fn set_private_dir_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_artifact_identity() {
        assert_eq!(sanitize_identifier("turn/a:b c"), "turn-a-b-c");
        assert_eq!(sanitize_identifier("..."), "artifact");
    }

    #[test]
    fn keeps_rollover_audio_segments_distinct_within_one_utterance() {
        assert_eq!(
            submitted_audio_relative_path("utterance-family-1", 7),
            "submitted-audio/utterance-family-1-segment-7.wav"
        );
        assert_eq!(
            submitted_audio_relative_path("utterance-family-1", 8),
            "submitted-audio/utterance-family-1-segment-8.wav"
        );
    }

    #[test]
    fn encodes_raw_samples_as_wav() {
        let bytes = samples_to_wav_bytes(16_000, &[0.0, 0.25, -0.25]).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
    }
}
