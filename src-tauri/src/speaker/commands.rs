// Jarvis AI Speech Detection, and capture system audio (speaker output) as a stream of f32 samples.
use crate::speaker::{AudioDevice, SpeakerInput};
use anyhow::Result;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use futures_util::StreamExt;
use hound::{WavSpec, WavWriter};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Listener, Manager};
use tauri_plugin_shell::ShellExt;
use tracing::{error, warn};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeCaptureOwner {
    Meeting,
    System,
}

impl NativeCaptureOwner {
    fn as_str(self) -> &'static str {
        match self {
            Self::Meeting => "meeting",
            Self::System => "system",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeCapturePhase {
    Idle,
    Starting,
    Active,
    Stopping,
}

impl Default for NativeCapturePhase {
    fn default() -> Self {
        Self::Idle
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NativeCaptureLease {
    owner: NativeCaptureOwner,
    session_id: String,
    generation: u64,
}

#[derive(Debug, Default)]
pub struct NativeCaptureControl {
    phase: NativeCapturePhase,
    generation: u64,
    lease: Option<NativeCaptureLease>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum NativeStopDecision {
    NotRunning,
    WrongOwner(NativeCaptureOwner),
    Acquired(NativeCaptureLease),
}

fn claim_capture_lease(
    control: &mut NativeCaptureControl,
    owner: NativeCaptureOwner,
    session_id: String,
) -> Result<NativeCaptureLease, String> {
    if control.phase != NativeCapturePhase::Idle || control.lease.is_some() {
        let current_owner = control
            .lease
            .as_ref()
            .map(|lease| lease.owner.as_str())
            .unwrap_or("unknown");
        return Err(format!("Capture already owned by {}", current_owner));
    }
    control.generation = control.generation.saturating_add(1);
    let lease = NativeCaptureLease {
        owner,
        session_id,
        generation: control.generation,
    };
    control.phase = NativeCapturePhase::Starting;
    control.lease = Some(lease.clone());
    Ok(lease)
}

fn begin_capture_stop(
    control: &mut NativeCaptureControl,
    requested_owner: NativeCaptureOwner,
) -> NativeStopDecision {
    let Some(lease) = control.lease.clone() else {
        return NativeStopDecision::NotRunning;
    };
    if lease.owner != requested_owner {
        return NativeStopDecision::WrongOwner(lease.owner);
    }
    control.phase = NativeCapturePhase::Stopping;
    NativeStopDecision::Acquired(lease)
}

// VAD Configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VadConfig {
    pub enabled: bool,
    pub hop_size: usize,
    pub sensitivity_rms: f32,
    pub peak_threshold: f32,
    pub silence_chunks: usize,
    pub min_speech_chunks: usize,
    pub pre_speech_chunks: usize,
    pub noise_gate_threshold: f32,
    pub max_recording_duration_secs: u64,
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            hop_size: 1024,
            sensitivity_rms: 0.012, // Much less sensitive - only real speech
            peak_threshold: 0.035,  // Higher threshold - filters clicks/noise
            silence_chunks: 45,     // ~1.0s of silence before stopping
            min_speech_chunks: 7,   // ~0.16s - captures short answers
            pre_speech_chunks: 12,  // ~0.27s - enough to catch word start
            noise_gate_threshold: 0.003, // Stronger noise filtering
            max_recording_duration_secs: 180, // 3 minutes default
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingAudioStatus {
    pub active: bool,
    pub system_capture_active: bool,
    pub capture_owner: Option<String>,
    pub device_id: Option<String>,
    pub sample_rate: Option<u32>,
    pub vad_enabled: bool,
    pub started_at_ms: Option<u64>,
    pub capture_session_id: Option<String>,
    pub capture_generation: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSpeechDetectedEvent {
    pub capture_session_id: String,
    pub segment_sequence: u64,
    pub owner: &'static str,
    pub captured_at_ms: u64,
    pub sample_rate: u32,
    pub media_type: &'static str,
    pub audio_base64: String,
}

#[tauri::command]
pub async fn start_system_audio_capture(
    app: AppHandle,
    vad_config: Option<VadConfig>,
    device_id: Option<String>,
) -> Result<MeetingAudioStatus, String> {
    start_audio_capture(
        app.clone(),
        vad_config,
        device_id,
        NativeCaptureOwner::System,
    )
    .await?;
    get_meeting_audio_status(app).await
}

#[tauri::command]
pub async fn start_meeting_audio_session(
    app: AppHandle,
    vad_config: Option<VadConfig>,
    device_id: Option<String>,
) -> Result<MeetingAudioStatus, String> {
    start_audio_capture(
        app.clone(),
        vad_config,
        device_id,
        NativeCaptureOwner::Meeting,
    )
    .await?;
    get_meeting_audio_status(app).await
}

async fn start_audio_capture(
    app: AppHandle,
    vad_config: Option<VadConfig>,
    device_id: Option<String>,
    capture_owner: NativeCaptureOwner,
) -> Result<(), String> {
    let state = app.state::<crate::AudioState>();
    let capture_session_id = format!("capture_{}", Uuid::new_v4());
    let capture_generation = {
        let mut control = state
            .capture_control
            .lock()
            .map_err(|e| format!("Failed to acquire capture control: {}", e))?;
        let lease = claim_capture_lease(&mut control, capture_owner, capture_session_id.clone())?;
        lease.generation
    };

    // Update VAD config if provided
    if let Some(config) = vad_config {
        let mut vad_cfg = state
            .vad_config
            .lock()
            .map_err(|e| format!("Failed to acquire VAD config lock: {}", e))?;
        *vad_cfg = config;
    }

    let requested_device_id = device_id.clone();
    let input = match SpeakerInput::new_with_device(device_id) {
        Ok(input) => input,
        Err(e) => {
            error!("Failed to create speaker input: {}", e);
            release_starting_capture(
                &state,
                capture_owner,
                &capture_session_id,
                capture_generation,
            );
            return Err(format!("Failed to access system audio: {}", e));
        }
    };

    let stream = input.stream();
    let sr = stream.sample_rate();

    // Validate sample rate
    if !(8000..=96000).contains(&sr) {
        error!("Invalid sample rate: {}", sr);
        release_starting_capture(
            &state,
            capture_owner,
            &capture_session_id,
            capture_generation,
        );
        return Err(format!(
            "Invalid sample rate: {}. Expected 8000-96000 Hz",
            sr
        ));
    }

    let app_clone = app.clone();
    let vad_config = state
        .vad_config
        .lock()
        .map_err(|e| format!("Failed to read VAD config: {}", e))?
        .clone();

    *state
        .capture_device_id
        .lock()
        .map_err(|e| format!("Failed to set capture device: {}", e))? = requested_device_id;
    *state
        .sample_rate
        .lock()
        .map_err(|e| format!("Failed to set sample rate: {}", e))? = Some(sr);
    *state
        .started_at_ms
        .lock()
        .map_err(|e| format!("Failed to set capture start time: {}", e))? = Some(now_ms());
    let state_clone = app.state::<crate::AudioState>();
    let task_session_id = capture_session_id.clone();
    let task = tokio::spawn(async move {
        if vad_config.enabled {
            run_vad_capture(
                app_clone.clone(),
                stream,
                sr,
                vad_config,
                task_session_id.clone(),
                capture_owner,
            )
            .await;
        } else {
            run_continuous_capture(
                app_clone.clone(),
                stream,
                sr,
                vad_config,
                task_session_id.clone(),
                capture_owner,
            )
            .await;
        }
        finish_capture_if_owner(
            &app_clone,
            capture_owner,
            &task_session_id,
            capture_generation,
        );
    });

    {
        let mut control = state_clone
            .capture_control
            .lock()
            .map_err(|e| format!("Failed to acquire capture control: {}", e))?;
        if !control_owns(
            &control,
            NativeCapturePhase::Starting,
            capture_owner,
            &capture_session_id,
            capture_generation,
        ) {
            task.abort();
            clear_capture_metadata(&state_clone);
            return Err("Capture start was superseded".to_string());
        }
        let mut task_guard = state_clone
            .stream_task
            .lock()
            .map_err(|e| format!("Failed to store task: {}", e))?;
        if task_guard.is_some() {
            task.abort();
            control.phase = NativeCapturePhase::Idle;
            control.lease = None;
            clear_capture_metadata(&state_clone);
            return Err("Capture task slot is already occupied".to_string());
        }
        *task_guard = Some(task);
        control.phase = NativeCapturePhase::Active;
    }

    let _ = app.emit("capture-started", sr);

    Ok(())
}

// VAD-enabled capture - OPTIMIZED for real-time speech detection
async fn run_vad_capture(
    app: AppHandle,
    stream: impl StreamExt<Item = f32> + Unpin,
    sr: u32,
    config: VadConfig,
    capture_session_id: String,
    capture_owner: NativeCaptureOwner,
) {
    let mut stream = stream;
    let mut buffer: VecDeque<f32> = VecDeque::new();
    let mut pre_speech: VecDeque<f32> =
        VecDeque::with_capacity(config.pre_speech_chunks * config.hop_size);
    let mut speech_buffer = Vec::new();
    let mut in_speech = false;
    let mut silence_chunks = 0;
    let mut speech_chunks = 0;
    let max_samples = sr as usize * 30; // 30s safety cap per utterance
    let mut segment_sequence = 0_u64;

    while let Some(sample) = stream.next().await {
        buffer.push_back(sample);

        // Process in fixed chunks for VAD analysis
        while buffer.len() >= config.hop_size {
            let mut mono = Vec::with_capacity(config.hop_size);
            for _ in 0..config.hop_size {
                if let Some(v) = buffer.pop_front() {
                    mono.push(v);
                }
            }

            // Apply noise gate BEFORE VAD (critical for accuracy)
            let mono = apply_noise_gate(&mono, config.noise_gate_threshold);

            let (rms, peak) = calculate_audio_metrics(&mono);
            let is_speech = rms > config.sensitivity_rms || peak > config.peak_threshold;

            if is_speech {
                if !in_speech {
                    // Speech START detected
                    in_speech = true;
                    speech_chunks = 0;

                    // Include pre-speech buffer for natural sound
                    speech_buffer.extend(pre_speech.drain(..));

                    let _ = app.emit("speech-start", ());
                }

                speech_chunks += 1;
                speech_buffer.extend_from_slice(&mono);
                silence_chunks = 0; // Reset silence counter on any speech

                // Safety cap: force emit if exceeds 30s
                if speech_buffer.len() > max_samples {
                    let normalized_buffer = normalize_audio_level(&speech_buffer, 0.1);
                    if let Ok(b64) = samples_to_wav_b64(sr, &normalized_buffer) {
                        // let duration = speech_buffer.len() as f32 / sr as f32;
                        emit_speech_detected(
                            &app,
                            &capture_session_id,
                            &mut segment_sequence,
                            sr,
                            b64,
                            capture_owner,
                        );
                    }
                    speech_buffer.clear();
                    in_speech = false;
                    speech_chunks = 0;
                }
            } else {
                // Silence detected
                if in_speech {
                    silence_chunks += 1;

                    // Continue collecting during silence (important for natural speech)
                    speech_buffer.extend_from_slice(&mono);

                    // Check if silence duration exceeds threshold
                    if silence_chunks >= config.silence_chunks {
                        // Verify minimum speech duration
                        if speech_chunks >= config.min_speech_chunks && !speech_buffer.is_empty() {
                            // Trim trailing silence (keep ~0.15s for natural ending)
                            let silence_duration_samples = silence_chunks * config.hop_size;
                            let keep_silence_samples = (sr as usize) * 15 / 100; // 0.15s
                            let trim_amount =
                                silence_duration_samples.saturating_sub(keep_silence_samples);

                            if speech_buffer.len() > trim_amount {
                                speech_buffer.truncate(speech_buffer.len() - trim_amount);
                            }

                            // Emit complete speech segment
                            let normalized_buffer = normalize_audio_level(&speech_buffer, 0.1);
                            if let Ok(b64) = samples_to_wav_b64(sr, &normalized_buffer) {
                                // let duration = speech_buffer.len() as f32 / sr as f32;
                                emit_speech_detected(
                                    &app,
                                    &capture_session_id,
                                    &mut segment_sequence,
                                    sr,
                                    b64,
                                    capture_owner,
                                );
                            } else {
                                error!("Failed to encode speech to WAV");
                                let _ = app.emit("audio-encoding-error", "Failed to encode speech");
                            }
                        } else {
                            let _ = app.emit(
                                "speech-discarded",
                                "Audio too short (likely background noise)",
                            );
                        }

                        // Reset for next speech detection
                        speech_buffer.clear();
                        in_speech = false;
                        silence_chunks = 0;
                        speech_chunks = 0;
                    }
                } else {
                    // Not in speech yet - maintain rolling pre-speech buffer
                    pre_speech.extend(mono.into_iter());

                    // Trim excess (maintain fixed size)
                    while pre_speech.len() > config.pre_speech_chunks * config.hop_size {
                        pre_speech.pop_front();
                    }

                    // Periodically shrink capacity to prevent memory bloat
                    if pre_speech.len() == config.pre_speech_chunks * config.hop_size {
                        pre_speech.shrink_to_fit();
                    }
                }
            }
        }
    }
}

// Continuous capture (VAD disabled)
async fn run_continuous_capture(
    app: AppHandle,
    stream: impl StreamExt<Item = f32> + Unpin,
    sr: u32,
    config: VadConfig,
    capture_session_id: String,
    capture_owner: NativeCaptureOwner,
) {
    let mut stream = stream;
    let max_samples = (sr as u64 * config.max_recording_duration_secs) as usize;

    // Pre-allocate buffer to prevent reallocations
    let mut audio_buffer = Vec::with_capacity(max_samples);
    let start_time = Instant::now();
    let max_duration = Duration::from_secs(config.max_recording_duration_secs);
    let mut segment_sequence = 0_u64;

    // Atomic flag for manual stop
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_for_listener = stop_flag.clone();

    // Listen for manual stop event
    let stop_listener = app.listen("manual-stop-continuous", move |_| {
        stop_flag_for_listener.store(true, Ordering::Release);
    });

    // Emit recording started
    let _ = app.emit(
        "continuous-recording-start",
        config.max_recording_duration_secs,
    );

    // Accumulate audio - check stop flag on EVERY sample for immediate response
    loop {
        // Check stop flag FIRST on every iteration for immediate stopping
        if stop_flag.load(Ordering::Acquire) {
            break;
        }

        tokio::select! {
            sample_opt = stream.next() => {
                match sample_opt {
                    Some(sample) => {
                        if stop_flag.load(Ordering::Acquire) {
                            break;
                        }

                        audio_buffer.push(sample);

                        let elapsed = start_time.elapsed();

                        // Emit progress every second
                        if audio_buffer.len() % (sr as usize) == 0 {
                            let _ = app.emit("recording-progress", elapsed.as_secs());
                        }

                        // Check size limit (safety)
                        if audio_buffer.len() >= max_samples {
                            break;
                        }

                        // Check time limit
                        if elapsed >= max_duration {
                            break;
                        }
                    },
                    None => {
                        warn!("Audio stream ended unexpectedly");
                        break;
                    }
                }
            }
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(10)) => {
            }
        }
    }

    // Clean up event listener (CRITICAL)
    app.unlisten(stop_listener);

    // Process and emit audio
    if !audio_buffer.is_empty() {
        // let duration = start_time.elapsed().as_secs_f32();

        // Apply noise gate
        let cleaned_audio = apply_noise_gate(&audio_buffer, config.noise_gate_threshold);
        let cleaned_audio = normalize_audio_level(&cleaned_audio, 0.1);

        match samples_to_wav_b64(sr, &cleaned_audio) {
            Ok(b64) => {
                emit_speech_detected(
                    &app,
                    &capture_session_id,
                    &mut segment_sequence,
                    sr,
                    b64,
                    capture_owner,
                );
            }
            Err(e) => {
                error!("Failed to encode continuous audio: {}", e);
                let _ = app.emit("audio-encoding-error", e);
            }
        }
    } else {
        warn!("No audio captured in continuous mode");
        let _ = app.emit("audio-encoding-error", "No audio recorded");
    }

    let _ = app.emit("continuous-recording-stopped", ());
}

// Apply noise gate
fn apply_noise_gate(samples: &[f32], threshold: f32) -> Vec<f32> {
    const KNEE_RATIO: f32 = 3.0; // Compression ratio for soft knee

    samples
        .iter()
        .map(|&s| {
            let abs = s.abs();
            if abs < threshold {
                s * (abs / threshold).powf(1.0 / KNEE_RATIO)
            } else {
                s
            }
        })
        .collect()
}

// Calculate RMS and peak (optimized)
fn calculate_audio_metrics(chunk: &[f32]) -> (f32, f32) {
    let mut sumsq = 0.0f32;
    let mut peak = 0.0f32;

    for &v in chunk {
        let a = v.abs();
        peak = peak.max(a);
        sumsq += v * v;
    }

    let rms = (sumsq / chunk.len() as f32).sqrt();
    (rms, peak)
}

fn normalize_audio_level(samples: &[f32], target_rms: f32) -> Vec<f32> {
    if samples.is_empty() {
        return Vec::new();
    }

    let sum_squares: f32 = samples.iter().map(|&s| s * s).sum();
    let current_rms = (sum_squares / samples.len() as f32).sqrt();

    if current_rms < 0.001 {
        return samples.to_vec();
    }

    let gain = (target_rms / current_rms).min(10.0);

    samples
        .iter()
        .map(|&s| {
            let amplified = s * gain;
            if amplified.abs() > 1.0 {
                amplified.signum() * (1.0 - (-amplified.abs()).exp())
            } else {
                amplified
            }
        })
        .collect()
}

// Convert samples to WAV base64 (with proper error handling)
fn samples_to_wav_b64(sample_rate: u32, mono_f32: &[f32]) -> Result<String, String> {
    // Validate sample rate
    if !(8000..=96000).contains(&sample_rate) {
        error!("Invalid sample rate: {}", sample_rate);
        return Err(format!(
            "Invalid sample rate: {}. Expected 8000-96000 Hz",
            sample_rate
        ));
    }

    // Validate buffer
    if mono_f32.is_empty() {
        return Err("Empty audio buffer".to_string());
    }

    let mut cursor = Cursor::new(Vec::new());
    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut writer = WavWriter::new(&mut cursor, spec).map_err(|e| {
        error!("Failed to create WAV writer: {}", e);
        e.to_string()
    })?;

    for &s in mono_f32 {
        let clamped = s.clamp(-1.0, 1.0);
        let sample_i16 = (clamped * i16::MAX as f32) as i16;
        writer.write_sample(sample_i16).map_err(|e| e.to_string())?;
    }

    writer.finalize().map_err(|e| e.to_string())?;

    Ok(B64.encode(cursor.into_inner()))
}

fn emit_speech_detected(
    app: &AppHandle,
    capture_session_id: &str,
    segment_sequence: &mut u64,
    sample_rate: u32,
    audio_base64: String,
    capture_owner: NativeCaptureOwner,
) {
    *segment_sequence += 1;
    let event = NativeSpeechDetectedEvent {
        capture_session_id: capture_session_id.to_string(),
        segment_sequence: *segment_sequence,
        owner: capture_owner.as_str(),
        captured_at_ms: now_ms(),
        sample_rate,
        media_type: "audio/wav",
        audio_base64,
    };
    let _ = app.emit("speech-detected", event);
}

fn control_owns(
    control: &NativeCaptureControl,
    phase: NativeCapturePhase,
    owner: NativeCaptureOwner,
    session_id: &str,
    generation: u64,
) -> bool {
    control.phase == phase
        && control.lease.as_ref().is_some_and(|lease| {
            lease.owner == owner && lease.session_id == session_id && lease.generation == generation
        })
}

fn release_starting_capture(
    state: &crate::AudioState,
    owner: NativeCaptureOwner,
    session_id: &str,
    generation: u64,
) {
    if let Ok(mut control) = state.capture_control.lock() {
        if control_owns(
            &control,
            NativeCapturePhase::Starting,
            owner,
            session_id,
            generation,
        ) {
            control.phase = NativeCapturePhase::Idle;
            control.lease = None;
            clear_capture_metadata(state);
        }
    }
}

fn finish_capture_if_owner(
    app: &AppHandle,
    owner: NativeCaptureOwner,
    session_id: &str,
    generation: u64,
) {
    let state = app.state::<crate::AudioState>();
    let finished = if let Ok(mut control) = state.capture_control.lock() {
        if control_owns(
            &control,
            NativeCapturePhase::Active,
            owner,
            session_id,
            generation,
        ) {
            if let Ok(mut task) = state.stream_task.lock() {
                *task = None;
            }
            control.phase = NativeCapturePhase::Idle;
            control.lease = None;
            clear_capture_metadata(&state);
            true
        } else {
            false
        }
    } else {
        false
    };

    if finished {
        let _ = app.emit("capture-stopped", ());
    }
}

async fn stop_audio_capture_for_owner(
    app: AppHandle,
    requested_owner: NativeCaptureOwner,
) -> Result<(), String> {
    let state = app.state::<crate::AudioState>();
    let (lease, task) = {
        let mut control = state
            .capture_control
            .lock()
            .map_err(|e| format!("Failed to acquire capture control: {}", e))?;
        let lease = match begin_capture_stop(&mut control, requested_owner) {
            NativeStopDecision::NotRunning => return Ok(()),
            NativeStopDecision::WrongOwner(owner) => {
                warn!(
                    "Ignoring {} stop request because capture is owned by {}",
                    requested_owner.as_str(),
                    owner.as_str()
                );
                return Ok(());
            }
            NativeStopDecision::Acquired(lease) => lease,
        };
        let task = state
            .stream_task
            .lock()
            .map_err(|e| format!("Failed to acquire capture task: {}", e))?
            .take();
        (lease, task)
    };

    if let Some(task) = task {
        task.abort();
    }

    tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;

    let stopped = {
        let mut control = state
            .capture_control
            .lock()
            .map_err(|e| format!("Failed to acquire capture control: {}", e))?;
        if control_owns(
            &control,
            NativeCapturePhase::Stopping,
            lease.owner,
            &lease.session_id,
            lease.generation,
        ) {
            control.phase = NativeCapturePhase::Idle;
            control.lease = None;
            clear_capture_metadata(&state);
            true
        } else {
            false
        }
    };

    tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
    if stopped {
        let _ = app.emit("capture-stopped", ());
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_system_audio_capture(app: AppHandle) -> Result<(), String> {
    stop_audio_capture_for_owner(app, NativeCaptureOwner::System).await?;
    Ok(())
}

#[tauri::command]
pub async fn stop_meeting_audio_session(app: AppHandle) -> Result<MeetingAudioStatus, String> {
    stop_audio_capture_for_owner(app.clone(), NativeCaptureOwner::Meeting).await?;
    get_meeting_audio_status(app).await
}

#[tauri::command]
pub async fn get_meeting_audio_status(app: AppHandle) -> Result<MeetingAudioStatus, String> {
    let state = app.state::<crate::AudioState>();

    let (system_capture_active, capture_owner, capture_session_id, capture_generation) = {
        let control = state
            .capture_control
            .lock()
            .map_err(|e| format!("Failed to get capture control: {}", e))?;
        let active = matches!(
            control.phase,
            NativeCapturePhase::Starting
                | NativeCapturePhase::Active
                | NativeCapturePhase::Stopping
        );
        let owner = control
            .lease
            .as_ref()
            .map(|lease| lease.owner.as_str().to_string());
        let session_id = control.lease.as_ref().map(|lease| lease.session_id.clone());
        let generation = control.lease.as_ref().map(|lease| lease.generation);
        (active, owner, session_id, generation)
    };
    let device_id = state
        .capture_device_id
        .lock()
        .map_err(|e| format!("Failed to get capture device: {}", e))?
        .clone();
    let sample_rate = *state
        .sample_rate
        .lock()
        .map_err(|e| format!("Failed to get sample rate: {}", e))?;
    let started_at_ms = *state
        .started_at_ms
        .lock()
        .map_err(|e| format!("Failed to get capture start time: {}", e))?;
    let vad_enabled = state
        .vad_config
        .lock()
        .map_err(|e| format!("Failed to get VAD config: {}", e))?
        .enabled;
    let active = system_capture_active && capture_owner.as_deref() == Some("meeting");

    Ok(MeetingAudioStatus {
        active,
        system_capture_active,
        capture_owner,
        device_id,
        sample_rate,
        vad_enabled,
        started_at_ms,
        capture_session_id,
        capture_generation,
    })
}

/// Manual stop for continuous recording
#[tauri::command]
pub async fn manual_stop_continuous(app: AppHandle) -> Result<(), String> {
    let _ = app.emit("manual-stop-continuous", ());

    tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;

    Ok(())
}

#[tauri::command]
pub fn check_system_audio_access(_app: AppHandle) -> Result<bool, String> {
    match SpeakerInput::new() {
        Ok(_) => Ok(true),
        Err(e) => {
            error!("System audio access check failed: {}", e);
            Ok(false)
        }
    }
}

#[tauri::command]
pub async fn request_system_audio_access(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        app.shell()
            .command("open")
            .args(["x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture"])
            .spawn()
            .map_err(|e| {
                error!("Failed to open system preferences: {}", e);
                e.to_string()
            })?;
    }
    #[cfg(target_os = "windows")]
    {
        app.shell()
            .command("ms-settings:sound")
            .spawn()
            .map_err(|e| {
                error!("Failed to open sound settings: {}", e);
                e.to_string()
            })?;
    }
    #[cfg(target_os = "linux")]
    {
        let commands = ["pavucontrol", "gnome-control-center sound"];
        let mut opened = false;

        for cmd in &commands {
            if app.shell().command(cmd).spawn().is_ok() {
                opened = true;
                break;
            }
        }

        if !opened {
            warn!("Failed to open audio settings on Linux");
        }
    }

    Ok(())
}

// VAD Configuration Management
#[tauri::command]
pub async fn get_vad_config(app: AppHandle) -> Result<VadConfig, String> {
    let state = app.state::<crate::AudioState>();
    let config = state
        .vad_config
        .lock()
        .map_err(|e| format!("Failed to get VAD config: {}", e))?
        .clone();
    Ok(config)
}

#[tauri::command]
pub async fn update_vad_config(app: AppHandle, config: VadConfig) -> Result<(), String> {
    // Validate config
    if config.sensitivity_rms < 0.0 || config.sensitivity_rms > 1.0 {
        return Err("Invalid sensitivity_rms: must be 0.0-1.0".to_string());
    }
    if config.max_recording_duration_secs > 3600 {
        return Err("Invalid max_recording_duration_secs: must be <= 3600 (1 hour)".to_string());
    }

    let state = app.state::<crate::AudioState>();
    *state
        .vad_config
        .lock()
        .map_err(|e| format!("Failed to update VAD config: {}", e))? = config;

    Ok(())
}

#[tauri::command]
pub async fn get_capture_status(app: AppHandle) -> Result<bool, String> {
    let state = app.state::<crate::AudioState>();
    let control = state
        .capture_control
        .lock()
        .map_err(|e| format!("Failed to get capture status: {}", e))?;
    Ok(control.phase != NativeCapturePhase::Idle)
}

#[tauri::command]
pub fn get_audio_sample_rate(_app: AppHandle) -> Result<u32, String> {
    let input = SpeakerInput::new().map_err(|e| {
        error!("Failed to create speaker input: {}", e);
        format!("Failed to access system audio: {}", e)
    })?;

    let stream = input.stream();
    let sr = stream.sample_rate();

    Ok(sr)
}

#[tauri::command]
pub fn get_input_devices() -> Result<Vec<AudioDevice>, String> {
    crate::speaker::list_input_devices().map_err(|e| {
        error!("Failed to get input devices: {}", e);
        format!("Failed to get input devices: {}", e)
    })
}

#[tauri::command]
pub fn get_output_devices() -> Result<Vec<AudioDevice>, String> {
    crate::speaker::list_output_devices().map_err(|e| {
        error!("Failed to get output devices: {}", e);
        format!("Failed to get output devices: {}", e)
    })
}

fn clear_capture_metadata(state: &crate::AudioState) {
    if let Ok(mut device_id) = state.capture_device_id.lock() {
        *device_id = None;
    }
    if let Ok(mut sample_rate) = state.sample_rate.lock() {
        *sample_rate = None;
    }
    if let Ok(mut started_at_ms) = state.started_at_ms.lock() {
        *started_at_ms = None;
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{
        begin_capture_stop, claim_capture_lease, NativeCaptureControl, NativeCaptureOwner,
        NativeCapturePhase, NativeSpeechDetectedEvent, NativeStopDecision,
    };

    #[test]
    fn serializes_native_speech_event_for_typescript_consumers() {
        let event = NativeSpeechDetectedEvent {
            capture_session_id: "capture-test".to_string(),
            segment_sequence: 7,
            owner: "system",
            captured_at_ms: 1234,
            sample_rate: 48_000,
            media_type: "audio/wav",
            audio_base64: "UklGRg==".to_string(),
        };

        let value = serde_json::to_value(event).expect("event should serialize");
        assert_eq!(value["captureSessionId"], "capture-test");
        assert_eq!(value["segmentSequence"], 7);
        assert_eq!(value["owner"], "system");
        assert_eq!(value["capturedAtMs"], 1234);
        assert_eq!(value["sampleRate"], 48_000);
        assert_eq!(value["mediaType"], "audio/wav");
        assert_eq!(value["audioBase64"], "UklGRg==");
    }

    #[test]
    fn capture_lease_generation_is_monotonic() {
        let mut control = NativeCaptureControl::default();
        let first = claim_capture_lease(
            &mut control,
            NativeCaptureOwner::Meeting,
            "meeting-1".to_string(),
        )
        .expect("first capture should claim the controller");
        control.phase = NativeCapturePhase::Idle;
        control.lease = None;
        let second = claim_capture_lease(
            &mut control,
            NativeCaptureOwner::Meeting,
            "meeting-2".to_string(),
        )
        .expect("second capture should claim the controller");

        assert_eq!(first.generation, 1);
        assert_eq!(second.generation, 2);
    }

    #[test]
    fn wrong_owner_cannot_stop_an_active_capture() {
        let mut control = NativeCaptureControl::default();
        claim_capture_lease(
            &mut control,
            NativeCaptureOwner::Meeting,
            "meeting-1".to_string(),
        )
        .expect("meeting capture should claim the controller");
        control.phase = NativeCapturePhase::Active;

        assert_eq!(
            begin_capture_stop(&mut control, NativeCaptureOwner::System),
            NativeStopDecision::WrongOwner(NativeCaptureOwner::Meeting)
        );
        assert_eq!(control.phase, NativeCapturePhase::Active);
        assert_eq!(
            begin_capture_stop(&mut control, NativeCaptureOwner::Meeting),
            NativeStopDecision::Acquired(
                control
                    .lease
                    .clone()
                    .expect("meeting lease should remain active")
            )
        );
        assert_eq!(control.phase, NativeCapturePhase::Stopping);
    }
}
