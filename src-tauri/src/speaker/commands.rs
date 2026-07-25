// Jarvis AI Speech Detection, and capture system audio (speaker output) as a stream of f32 samples.
use crate::speaker::{
    AudioDevice, SpeakerInput, SpeakerStream, SpeakerStreamTermination,
    SpeakerStreamTerminationReason,
};
use crate::stt_evaluation::create_raw_evaluation_capture_tap;
use anyhow::Result;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use futures_util::{FutureExt, StreamExt};
use hound::{WavSpec, WavWriter};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::Cursor;
use std::panic::AssertUnwindSafe;
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

    #[cfg(debug_assertions)]
    fn parse(value: &str) -> Option<Self> {
        match value {
            "meeting" => Some(Self::Meeting),
            "system" => Some(Self::System),
            _ => None,
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
    StaleLease(NativeCaptureLease),
    Acquired(NativeCaptureLease),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeStopDisposition {
    Stopped,
    AlreadyIdle,
    StaleRequest,
    OwnerMismatch,
}

impl NativeStopDisposition {
    fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::AlreadyIdle => "already-idle",
            Self::StaleRequest => "stale-request",
            Self::OwnerMismatch => "owner-mismatch",
        }
    }
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
    expected_session_id: Option<&str>,
    expected_generation: Option<u64>,
) -> NativeStopDecision {
    let Some(lease) = control.lease.clone() else {
        return NativeStopDecision::NotRunning;
    };
    if lease.owner != requested_owner {
        return NativeStopDecision::WrongOwner(lease.owner);
    }
    if expected_session_id != Some(lease.session_id.as_str())
        || expected_generation != Some(lease.generation)
    {
        return NativeStopDecision::StaleLease(lease);
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
pub struct NativeAudioStopResult {
    pub disposition: &'static str,
    pub status: MeetingAudioStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSpeechDetectedEvent {
    pub capture_session_id: String,
    pub capture_generation: u64,
    pub segment_sequence: u64,
    pub owner: &'static str,
    pub captured_at_ms: u64,
    pub sample_rate: u32,
    pub media_type: &'static str,
    pub audio_base64: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSpeechStartEvent {
    pub capture_session_id: String,
    pub capture_generation: u64,
    pub candidate_segment_sequence: u64,
    pub owner: &'static str,
    pub source: &'static str,
    pub occurred_at_ms: u64,
    pub sample_rate: u32,
}

const VAD_LIVENESS_SCHEMA_VERSION: u16 = 1;
const VAD_LIVENESS_INTERVAL_MS: u64 = 2_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioLivenessEvent {
    pub schema_version: u16,
    pub snapshot_sequence: u64,
    pub capture_session_id: String,
    pub capture_generation: u64,
    pub owner: &'static str,
    pub source: &'static str,
    pub occurred_at_ms: u64,
    pub sample_rate: u32,
    pub state: &'static str,
    pub trigger: &'static str,
    pub candidate_segment_sequence: Option<u64>,
    pub candidate_started_at_ms: Option<u64>,
    pub candidate_duration_ms: u64,
    pub silence_duration_ms: u64,
    pub interval_duration_ms: u64,
    pub interval_chunk_count: u64,
    pub interval_signal_chunk_count: u64,
    pub interval_speech_chunk_count: u64,
    pub interval_max_rms: f32,
    pub interval_max_peak: f32,
    pub processed_chunk_count: u64,
    pub signal_chunk_count: u64,
    pub speech_chunk_count: u64,
    pub speech_candidate_count: u64,
    pub segment_emitted_count: u64,
    pub candidate_discarded_count: u64,
    pub last_signal_observed_at_ms: Option<u64>,
    pub last_speech_candidate_at_ms: Option<u64>,
    pub last_segment_emitted_at_ms: Option<u64>,
    pub discard_reason: Option<&'static str>,
    pub vad_config_revision: u16,
    pub hop_size: usize,
    pub sensitivity_rms: f32,
    pub peak_threshold: f32,
    pub noise_gate_threshold: f32,
    pub silence_target_ms: u64,
    pub minimum_speech_ms: u64,
    pub maximum_segment_ms: u64,
}

#[derive(Debug, Default)]
struct VadLivenessAccumulator {
    snapshot_sequence: u64,
    interval_sample_count: u64,
    interval_chunk_count: u64,
    interval_signal_chunk_count: u64,
    interval_speech_chunk_count: u64,
    interval_max_rms: f32,
    interval_max_peak: f32,
    processed_chunk_count: u64,
    signal_chunk_count: u64,
    speech_chunk_count: u64,
    speech_candidate_count: u64,
    segment_emitted_count: u64,
    candidate_discarded_count: u64,
    candidate_started_at_ms: Option<u64>,
    last_signal_observed_at_ms: Option<u64>,
    last_speech_candidate_at_ms: Option<u64>,
    last_segment_emitted_at_ms: Option<u64>,
}

impl VadLivenessAccumulator {
    fn observe_chunk(
        &mut self,
        sample_count: usize,
        signal_observed: bool,
        speech_observed: bool,
        rms: f32,
        peak: f32,
        observed_at_ms: u64,
    ) {
        self.interval_sample_count = self
            .interval_sample_count
            .saturating_add(sample_count as u64);
        self.interval_chunk_count = self.interval_chunk_count.saturating_add(1);
        self.processed_chunk_count = self.processed_chunk_count.saturating_add(1);
        self.interval_max_rms = self.interval_max_rms.max(rms);
        self.interval_max_peak = self.interval_max_peak.max(peak);

        if signal_observed {
            self.interval_signal_chunk_count = self.interval_signal_chunk_count.saturating_add(1);
            self.signal_chunk_count = self.signal_chunk_count.saturating_add(1);
            self.last_signal_observed_at_ms = Some(observed_at_ms);
        }
        if speech_observed {
            self.interval_speech_chunk_count = self.interval_speech_chunk_count.saturating_add(1);
            self.speech_chunk_count = self.speech_chunk_count.saturating_add(1);
        }
    }

    fn begin_candidate(&mut self, occurred_at_ms: u64) {
        self.speech_candidate_count = self.speech_candidate_count.saturating_add(1);
        self.candidate_started_at_ms = Some(occurred_at_ms);
        self.last_speech_candidate_at_ms = Some(occurred_at_ms);
    }

    fn mark_segment_emitted(&mut self, occurred_at_ms: u64) {
        self.segment_emitted_count = self.segment_emitted_count.saturating_add(1);
        self.last_segment_emitted_at_ms = Some(occurred_at_ms);
    }

    fn mark_candidate_discarded(&mut self) {
        self.candidate_discarded_count = self.candidate_discarded_count.saturating_add(1);
    }

    fn clear_candidate(&mut self) {
        self.candidate_started_at_ms = None;
    }

    fn should_emit_periodic(&self, sample_rate: u32) -> bool {
        self.interval_sample_count.saturating_mul(1_000)
            >= (sample_rate as u64).saturating_mul(VAD_LIVENESS_INTERVAL_MS)
    }

    #[allow(clippy::too_many_arguments)]
    fn take_snapshot(
        &mut self,
        capture_session_id: &str,
        capture_generation: u64,
        owner: NativeCaptureOwner,
        sample_rate: u32,
        state: &'static str,
        trigger: &'static str,
        candidate_segment_sequence: Option<u64>,
        silence_chunks: usize,
        discard_reason: Option<&'static str>,
        config: &VadConfig,
        occurred_at_ms: u64,
    ) -> NativeAudioLivenessEvent {
        self.snapshot_sequence = self.snapshot_sequence.saturating_add(1);
        let event = NativeAudioLivenessEvent {
            schema_version: VAD_LIVENESS_SCHEMA_VERSION,
            snapshot_sequence: self.snapshot_sequence,
            capture_session_id: capture_session_id.to_string(),
            capture_generation,
            owner: owner.as_str(),
            source: "system-audio",
            occurred_at_ms,
            sample_rate,
            state,
            trigger,
            candidate_segment_sequence,
            candidate_started_at_ms: self.candidate_started_at_ms,
            candidate_duration_ms: self
                .candidate_started_at_ms
                .map(|started_at| occurred_at_ms.saturating_sub(started_at))
                .unwrap_or(0),
            silence_duration_ms: samples_to_ms(
                silence_chunks.saturating_mul(config.hop_size) as u64,
                sample_rate,
            ),
            interval_duration_ms: samples_to_ms(self.interval_sample_count, sample_rate),
            interval_chunk_count: self.interval_chunk_count,
            interval_signal_chunk_count: self.interval_signal_chunk_count,
            interval_speech_chunk_count: self.interval_speech_chunk_count,
            interval_max_rms: self.interval_max_rms,
            interval_max_peak: self.interval_max_peak,
            processed_chunk_count: self.processed_chunk_count,
            signal_chunk_count: self.signal_chunk_count,
            speech_chunk_count: self.speech_chunk_count,
            speech_candidate_count: self.speech_candidate_count,
            segment_emitted_count: self.segment_emitted_count,
            candidate_discarded_count: self.candidate_discarded_count,
            last_signal_observed_at_ms: self.last_signal_observed_at_ms,
            last_speech_candidate_at_ms: self.last_speech_candidate_at_ms,
            last_segment_emitted_at_ms: self.last_segment_emitted_at_ms,
            discard_reason,
            vad_config_revision: VAD_LIVENESS_SCHEMA_VERSION,
            hop_size: config.hop_size,
            sensitivity_rms: config.sensitivity_rms,
            peak_threshold: config.peak_threshold,
            noise_gate_threshold: config.noise_gate_threshold,
            silence_target_ms: samples_to_ms(
                config.silence_chunks.saturating_mul(config.hop_size) as u64,
                sample_rate,
            ),
            minimum_speech_ms: samples_to_ms(
                config.min_speech_chunks.saturating_mul(config.hop_size) as u64,
                sample_rate,
            ),
            maximum_segment_ms: 30_000,
        };
        self.interval_sample_count = 0;
        self.interval_chunk_count = 0;
        self.interval_signal_chunk_count = 0;
        self.interval_speech_chunk_count = 0;
        self.interval_max_rms = 0.0;
        self.interval_max_peak = 0.0;
        event
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioLifecycleEvent {
    pub event_type: &'static str,
    pub capture_session_id: String,
    pub capture_generation: u64,
    pub owner: &'static str,
    pub occurred_at_ms: u64,
    pub reason: Option<String>,
    pub message: Option<String>,
    pub sample_rate: Option<u32>,
    pub expected: bool,
    pub recoverability: &'static str,
    pub diagnostics: CaptureTerminationDiagnostics,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioSegmentDroppedEvent {
    pub capture_session_id: String,
    pub capture_generation: u64,
    pub attempted_segment_sequence: u64,
    pub owner: &'static str,
    pub occurred_at_ms: u64,
    pub reason: &'static str,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CaptureTerminationReason {
    RequestedStop,
    CaptureLimitReached,
    BufferOverflow,
    InvalidSampleRate,
    CapturePanic,
    UnknownStreamEnd,
}

impl CaptureTerminationReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::RequestedStop => "requested-stop",
            Self::CaptureLimitReached => "capture-limit-reached",
            Self::BufferOverflow => "buffer-overflow",
            Self::InvalidSampleRate => "invalid-sample-rate",
            Self::CapturePanic => "capture-panic",
            Self::UnknownStreamEnd => "unknown-stream-end",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CaptureRecoverability {
    NotApplicable,
    RetryOnce,
    Manual,
}

impl CaptureRecoverability {
    fn as_str(self) -> &'static str {
        match self {
            Self::NotApplicable => "not-applicable",
            Self::RetryOnce => "retry-once",
            Self::Manual => "manual",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CaptureTerminationDiagnostics {
    pub dropped_samples: u64,
    pub consecutive_drops: u32,
    pub buffer_capacity: Option<usize>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub fault_injected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fault_injection_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fault_kind: Option<String>,
}

#[cfg(debug_assertions)]
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DebugAudioFaultKind {
    RecoverableStreamEnd,
    FatalCaptureFailure,
}

#[cfg(debug_assertions)]
impl DebugAudioFaultKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::RecoverableStreamEnd => "recoverable-stream-end",
            Self::FatalCaptureFailure => "fatal-capture-failure",
        }
    }

    fn outcome(self, fault_injection_id: &str) -> CaptureRunOutcome {
        let (reason, recoverability) = match self {
            Self::RecoverableStreamEnd => (
                CaptureTerminationReason::UnknownStreamEnd,
                CaptureRecoverability::RetryOnce,
            ),
            Self::FatalCaptureFailure => (
                CaptureTerminationReason::CapturePanic,
                CaptureRecoverability::Manual,
            ),
        };
        CaptureRunOutcome {
            reason,
            expected: false,
            recoverability,
            diagnostics: CaptureTerminationDiagnostics {
                fault_injected: true,
                fault_injection_id: Some(fault_injection_id.to_string()),
                fault_kind: Some(self.as_str().to_string()),
                ..CaptureTerminationDiagnostics::default()
            },
        }
    }
}

#[cfg(debug_assertions)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DebugAudioFaultDisposition {
    Injected,
    AlreadyIdle,
    StaleRequest,
    OwnerMismatch,
    NotActive,
}

#[cfg(debug_assertions)]
impl DebugAudioFaultDisposition {
    fn as_str(self) -> &'static str {
        match self {
            Self::Injected => "injected",
            Self::AlreadyIdle => "already-idle",
            Self::StaleRequest => "stale-request",
            Self::OwnerMismatch => "owner-mismatch",
            Self::NotActive => "not-active",
        }
    }
}

#[cfg(debug_assertions)]
fn decide_debug_audio_fault(
    control: &NativeCaptureControl,
    requested_owner: NativeCaptureOwner,
    expected_session_id: &str,
    expected_generation: u64,
) -> DebugAudioFaultDisposition {
    match control.lease.as_ref() {
        None => DebugAudioFaultDisposition::AlreadyIdle,
        Some(lease) if lease.owner != requested_owner => DebugAudioFaultDisposition::OwnerMismatch,
        Some(lease)
            if lease.session_id != expected_session_id
                || lease.generation != expected_generation =>
        {
            DebugAudioFaultDisposition::StaleRequest
        }
        Some(_) if control.phase != NativeCapturePhase::Active => {
            DebugAudioFaultDisposition::NotActive
        }
        Some(_) => DebugAudioFaultDisposition::Injected,
    }
}

#[cfg(debug_assertions)]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugAudioFaultResult {
    disposition: &'static str,
    fault_injection_id: String,
    previous_status: MeetingAudioStatus,
    current_status: MeetingAudioStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CaptureRunOutcome {
    reason: CaptureTerminationReason,
    expected: bool,
    recoverability: CaptureRecoverability,
    diagnostics: CaptureTerminationDiagnostics,
}

impl CaptureRunOutcome {
    fn from_stream(termination: SpeakerStreamTermination) -> Self {
        let (reason, recoverability) = match termination.reason {
            SpeakerStreamTerminationReason::BufferOverflow => (
                CaptureTerminationReason::BufferOverflow,
                CaptureRecoverability::RetryOnce,
            ),
            SpeakerStreamTerminationReason::UnknownStreamEnd => (
                CaptureTerminationReason::UnknownStreamEnd,
                CaptureRecoverability::RetryOnce,
            ),
        };
        Self {
            reason,
            expected: false,
            recoverability,
            diagnostics: CaptureTerminationDiagnostics {
                dropped_samples: termination.dropped_samples,
                consecutive_drops: termination.consecutive_drops,
                buffer_capacity: termination.buffer_capacity,
                ..CaptureTerminationDiagnostics::default()
            },
        }
    }

    fn expected(reason: CaptureTerminationReason) -> Self {
        Self {
            reason,
            expected: true,
            recoverability: CaptureRecoverability::NotApplicable,
            diagnostics: CaptureTerminationDiagnostics::default(),
        }
    }

    fn panic() -> Self {
        Self {
            reason: CaptureTerminationReason::CapturePanic,
            expected: false,
            recoverability: CaptureRecoverability::Manual,
            diagnostics: CaptureTerminationDiagnostics::default(),
        }
    }
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
    let input = match std::panic::catch_unwind(AssertUnwindSafe(|| {
        SpeakerInput::new_with_device(device_id)
    })) {
        Ok(Ok(input)) => input,
        Ok(Err(e)) => {
            error!("Failed to create speaker input: {}", e);
            emit_capture_lifecycle(
                &app,
                "error",
                capture_owner,
                &capture_session_id,
                capture_generation,
                Some("start-failed"),
                Some(&format!("Failed to access system audio: {}", e)),
                None,
                false,
                CaptureRecoverability::Manual,
                CaptureTerminationDiagnostics::default(),
            );
            release_starting_capture(
                &state,
                capture_owner,
                &capture_session_id,
                capture_generation,
            );
            return Err(format!("Failed to access system audio: {}", e));
        }
        Err(_) => {
            emit_capture_lifecycle(
                &app,
                "error",
                capture_owner,
                &capture_session_id,
                capture_generation,
                Some(CaptureTerminationReason::CapturePanic.as_str()),
                Some("System audio initialization panicked."),
                None,
                false,
                CaptureRecoverability::Manual,
                CaptureTerminationDiagnostics::default(),
            );
            release_starting_capture(
                &state,
                capture_owner,
                &capture_session_id,
                capture_generation,
            );
            return Err("System audio initialization panicked".to_string());
        }
    };

    let stream = match std::panic::catch_unwind(AssertUnwindSafe(|| input.stream())) {
        Ok(stream) => stream,
        Err(_) => {
            emit_capture_lifecycle(
                &app,
                "error",
                capture_owner,
                &capture_session_id,
                capture_generation,
                Some(CaptureTerminationReason::CapturePanic.as_str()),
                Some("System audio stream creation panicked."),
                None,
                false,
                CaptureRecoverability::Manual,
                CaptureTerminationDiagnostics::default(),
            );
            release_starting_capture(
                &state,
                capture_owner,
                &capture_session_id,
                capture_generation,
            );
            return Err("System audio stream creation panicked".to_string());
        }
    };
    let sr = stream.sample_rate();

    // Validate sample rate
    if !(8000..=96000).contains(&sr) {
        error!("Invalid sample rate: {}", sr);
        emit_capture_lifecycle(
            &app,
            "error",
            capture_owner,
            &capture_session_id,
            capture_generation,
            Some(CaptureTerminationReason::InvalidSampleRate.as_str()),
            Some(&format!("Invalid sample rate: {}", sr)),
            Some(sr),
            false,
            CaptureRecoverability::Manual,
            CaptureTerminationDiagnostics::default(),
        );
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
            clear_capture_metadata(&state_clone);
            return Err("Capture start was superseded".to_string());
        }
        let mut task_guard = state_clone
            .stream_task
            .lock()
            .map_err(|e| format!("Failed to store task: {}", e))?;
        if task_guard.is_some() {
            control.phase = NativeCapturePhase::Idle;
            control.lease = None;
            clear_capture_metadata(&state_clone);
            return Err("Capture task slot is already occupied".to_string());
        }
        let task = tokio::spawn(async move {
            let capture_future = async {
                if vad_config.enabled {
                    run_vad_capture(
                        app_clone.clone(),
                        stream,
                        sr,
                        vad_config,
                        task_session_id.clone(),
                        capture_owner,
                        capture_generation,
                    )
                    .await
                } else {
                    run_continuous_capture(
                        app_clone.clone(),
                        stream,
                        sr,
                        vad_config,
                        task_session_id.clone(),
                        capture_owner,
                        capture_generation,
                    )
                    .await
                }
            };
            let outcome = AssertUnwindSafe(capture_future)
                .catch_unwind()
                .await
                .unwrap_or_else(|_| CaptureRunOutcome::panic());
            finish_capture_if_owner(
                &app_clone,
                capture_owner,
                &task_session_id,
                capture_generation,
                sr,
                outcome,
            );
        });
        *task_guard = Some(task);
        control.phase = NativeCapturePhase::Active;
    }

    let _ = app.emit("capture-started", sr);
    emit_capture_lifecycle(
        &app,
        "started",
        capture_owner,
        &capture_session_id,
        capture_generation,
        Some("start-completed"),
        None,
        Some(sr),
        true,
        CaptureRecoverability::NotApplicable,
        CaptureTerminationDiagnostics::default(),
    );

    Ok(())
}

// VAD-enabled capture - OPTIMIZED for real-time speech detection
async fn run_vad_capture(
    app: AppHandle,
    stream: SpeakerStream,
    sr: u32,
    config: VadConfig,
    capture_session_id: String,
    capture_owner: NativeCaptureOwner,
    capture_generation: u64,
) -> CaptureRunOutcome {
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
    let mut liveness = VadLivenessAccumulator::default();
    let mut evaluation_tap = if capture_owner == NativeCaptureOwner::Meeting {
        create_raw_evaluation_capture_tap(&app, &capture_session_id, capture_generation, sr)
    } else {
        None
    };

    while let Some(sample) = stream.next().await {
        if let Some(tap) = evaluation_tap.as_mut() {
            tap.push_sample(sample);
        }
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
            let observed_at_ms = now_ms();
            liveness.observe_chunk(mono.len(), peak > 0.0, is_speech, rms, peak, observed_at_ms);

            if is_speech {
                if !in_speech {
                    // Speech START detected
                    in_speech = true;
                    speech_chunks = 0;
                    liveness.begin_candidate(observed_at_ms);

                    // Include pre-speech buffer for natural sound
                    speech_buffer.extend(pre_speech.drain(..));

                    emit_speech_start(
                        &app,
                        &capture_session_id,
                        segment_sequence + 1,
                        sr,
                        capture_owner,
                        capture_generation,
                    );
                    emit_vad_liveness(
                        &app,
                        &mut liveness,
                        &capture_session_id,
                        capture_generation,
                        capture_owner,
                        sr,
                        "speech-candidate",
                        "speech-start",
                        Some(segment_sequence + 1),
                        silence_chunks,
                        None,
                        &config,
                        observed_at_ms,
                    );
                }

                speech_chunks += 1;
                speech_buffer.extend_from_slice(&mono);
                silence_chunks = 0; // Reset silence counter on any speech

                // Safety cap: force emit if exceeds 30s
                if speech_buffer.len() > max_samples {
                    let normalized_buffer = normalize_audio_level(&speech_buffer, 0.1);
                    match samples_to_wav_b64(sr, &normalized_buffer) {
                        Ok(b64) => {
                            emit_speech_detected(
                                &app,
                                &capture_session_id,
                                &mut segment_sequence,
                                sr,
                                b64,
                                capture_owner,
                                capture_generation,
                            );
                            let emitted_at_ms = now_ms();
                            liveness.mark_segment_emitted(emitted_at_ms);
                            emit_vad_liveness(
                                &app,
                                &mut liveness,
                                &capture_session_id,
                                capture_generation,
                                capture_owner,
                                sr,
                                "segment-emitted",
                                "forced-rollover",
                                Some(segment_sequence),
                                silence_chunks,
                                None,
                                &config,
                                emitted_at_ms,
                            );
                        }
                        Err(error) => {
                            emit_segment_dropped(
                                &app,
                                capture_owner,
                                &capture_session_id,
                                capture_generation,
                                segment_sequence + 1,
                                "wav-encoding-failed",
                                &error,
                            );
                            let dropped_at_ms = now_ms();
                            liveness.mark_candidate_discarded();
                            emit_vad_liveness(
                                &app,
                                &mut liveness,
                                &capture_session_id,
                                capture_generation,
                                capture_owner,
                                sr,
                                "stalled",
                                "candidate-discarded",
                                Some(segment_sequence + 1),
                                silence_chunks,
                                Some("wav-encoding-failed"),
                                &config,
                                dropped_at_ms,
                            );
                        }
                    }
                    speech_buffer.clear();
                    in_speech = false;
                    speech_chunks = 0;
                    liveness.clear_candidate();
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
                            match samples_to_wav_b64(sr, &normalized_buffer) {
                                Ok(b64) => {
                                    emit_speech_detected(
                                        &app,
                                        &capture_session_id,
                                        &mut segment_sequence,
                                        sr,
                                        b64,
                                        capture_owner,
                                        capture_generation,
                                    );
                                    let emitted_at_ms = now_ms();
                                    liveness.mark_segment_emitted(emitted_at_ms);
                                    emit_vad_liveness(
                                        &app,
                                        &mut liveness,
                                        &capture_session_id,
                                        capture_generation,
                                        capture_owner,
                                        sr,
                                        "segment-emitted",
                                        "silence-boundary",
                                        Some(segment_sequence),
                                        silence_chunks,
                                        None,
                                        &config,
                                        emitted_at_ms,
                                    );
                                }
                                Err(error) => {
                                    error!("Failed to encode speech to WAV: {}", error);
                                    emit_segment_dropped(
                                        &app,
                                        capture_owner,
                                        &capture_session_id,
                                        capture_generation,
                                        segment_sequence + 1,
                                        "wav-encoding-failed",
                                        &error,
                                    );
                                    let dropped_at_ms = now_ms();
                                    liveness.mark_candidate_discarded();
                                    emit_vad_liveness(
                                        &app,
                                        &mut liveness,
                                        &capture_session_id,
                                        capture_generation,
                                        capture_owner,
                                        sr,
                                        "stalled",
                                        "candidate-discarded",
                                        Some(segment_sequence + 1),
                                        silence_chunks,
                                        Some("wav-encoding-failed"),
                                        &config,
                                        dropped_at_ms,
                                    );
                                    let _ = app.emit("audio-encoding-error", error);
                                }
                            }
                        } else {
                            liveness.mark_candidate_discarded();
                            emit_vad_liveness(
                                &app,
                                &mut liveness,
                                &capture_session_id,
                                capture_generation,
                                capture_owner,
                                sr,
                                "idle",
                                "candidate-discarded",
                                Some(segment_sequence + 1),
                                silence_chunks,
                                Some("below-minimum-speech"),
                                &config,
                                now_ms(),
                            );
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
                        liveness.clear_candidate();
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

            if liveness.should_emit_periodic(sr) {
                let state = if in_speech && silence_chunks > 0 {
                    "awaiting-silence"
                } else if in_speech {
                    "segment-open"
                } else if liveness.interval_signal_chunk_count > 0 {
                    "signal-observed"
                } else {
                    "idle"
                };
                emit_vad_liveness(
                    &app,
                    &mut liveness,
                    &capture_session_id,
                    capture_generation,
                    capture_owner,
                    sr,
                    state,
                    "periodic",
                    in_speech.then_some(segment_sequence + 1),
                    silence_chunks,
                    None,
                    &config,
                    now_ms(),
                );
            }
        }
    }

    CaptureRunOutcome::from_stream(stream.termination())
}

// Continuous capture (VAD disabled)
async fn run_continuous_capture(
    app: AppHandle,
    stream: SpeakerStream,
    sr: u32,
    config: VadConfig,
    capture_session_id: String,
    capture_owner: NativeCaptureOwner,
    capture_generation: u64,
) -> CaptureRunOutcome {
    let mut stream = stream;
    let max_samples = (sr as u64 * config.max_recording_duration_secs) as usize;

    // Pre-allocate buffer to prevent reallocations
    let mut audio_buffer = Vec::with_capacity(max_samples);
    let start_time = Instant::now();
    let max_duration = Duration::from_secs(config.max_recording_duration_secs);
    let mut segment_sequence = 0_u64;
    let mut evaluation_tap = if capture_owner == NativeCaptureOwner::Meeting {
        create_raw_evaluation_capture_tap(&app, &capture_session_id, capture_generation, sr)
    } else {
        None
    };

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
    let mut outcome = CaptureRunOutcome::expected(CaptureTerminationReason::RequestedStop);
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

                        if let Some(tap) = evaluation_tap.as_mut() {
                            tap.push_sample(sample);
                        }
                        audio_buffer.push(sample);

                        let elapsed = start_time.elapsed();

                        // Emit progress every second
                        if audio_buffer.len() % (sr as usize) == 0 {
                            let _ = app.emit("recording-progress", elapsed.as_secs());
                        }

                        // Check size limit (safety)
                        if audio_buffer.len() >= max_samples {
                            outcome = CaptureRunOutcome::expected(
                                CaptureTerminationReason::CaptureLimitReached,
                            );
                            break;
                        }

                        // Check time limit
                        if elapsed >= max_duration {
                            outcome = CaptureRunOutcome::expected(
                                CaptureTerminationReason::CaptureLimitReached,
                            );
                            break;
                        }
                    },
                    None => {
                        warn!("Audio stream ended unexpectedly");
                        outcome = CaptureRunOutcome::from_stream(stream.termination());
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
                    capture_generation,
                );
            }
            Err(e) => {
                error!("Failed to encode continuous audio: {}", e);
                emit_segment_dropped(
                    &app,
                    capture_owner,
                    &capture_session_id,
                    capture_generation,
                    segment_sequence + 1,
                    "wav-encoding-failed",
                    &e,
                );
                let _ = app.emit("audio-encoding-error", e);
            }
        }
    } else {
        warn!("No audio captured in continuous mode");
        let _ = app.emit("audio-encoding-error", "No audio recorded");
    }

    let _ = app.emit("continuous-recording-stopped", ());
    outcome
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
    capture_generation: u64,
) {
    *segment_sequence += 1;
    let event = NativeSpeechDetectedEvent {
        capture_session_id: capture_session_id.to_string(),
        capture_generation,
        segment_sequence: *segment_sequence,
        owner: capture_owner.as_str(),
        captured_at_ms: now_ms(),
        sample_rate,
        media_type: "audio/wav",
        audio_base64,
    };
    let _ = app.emit("speech-detected", event);
}

fn emit_speech_start(
    app: &AppHandle,
    capture_session_id: &str,
    candidate_segment_sequence: u64,
    sample_rate: u32,
    capture_owner: NativeCaptureOwner,
    capture_generation: u64,
) {
    let event = NativeSpeechStartEvent {
        capture_session_id: capture_session_id.to_string(),
        capture_generation,
        candidate_segment_sequence,
        owner: capture_owner.as_str(),
        source: "system-audio",
        occurred_at_ms: now_ms(),
        sample_rate,
    };
    let _ = app.emit("speech-start", event);
}

#[allow(clippy::too_many_arguments)]
fn emit_vad_liveness(
    app: &AppHandle,
    liveness: &mut VadLivenessAccumulator,
    capture_session_id: &str,
    capture_generation: u64,
    capture_owner: NativeCaptureOwner,
    sample_rate: u32,
    state: &'static str,
    trigger: &'static str,
    candidate_segment_sequence: Option<u64>,
    silence_chunks: usize,
    discard_reason: Option<&'static str>,
    config: &VadConfig,
    occurred_at_ms: u64,
) {
    let event = liveness.take_snapshot(
        capture_session_id,
        capture_generation,
        capture_owner,
        sample_rate,
        state,
        trigger,
        candidate_segment_sequence,
        silence_chunks,
        discard_reason,
        config,
        occurred_at_ms,
    );
    let _ = app.emit("native-audio-liveness", event);
}

#[allow(clippy::too_many_arguments)]
fn emit_segment_dropped(
    app: &AppHandle,
    owner: NativeCaptureOwner,
    session_id: &str,
    generation: u64,
    attempted_segment_sequence: u64,
    reason: &'static str,
    message: &str,
) {
    let event = NativeAudioSegmentDroppedEvent {
        capture_session_id: session_id.to_string(),
        capture_generation: generation,
        attempted_segment_sequence,
        owner: owner.as_str(),
        occurred_at_ms: now_ms(),
        reason,
        message: message.to_string(),
    };
    let _ = app.emit("native-audio-segment-dropped", event);
}

#[allow(clippy::too_many_arguments)]
fn emit_capture_lifecycle(
    app: &AppHandle,
    event_type: &'static str,
    owner: NativeCaptureOwner,
    session_id: &str,
    generation: u64,
    reason: Option<&str>,
    message: Option<&str>,
    sample_rate: Option<u32>,
    expected: bool,
    recoverability: CaptureRecoverability,
    diagnostics: CaptureTerminationDiagnostics,
) {
    let event = NativeAudioLifecycleEvent {
        event_type,
        capture_session_id: session_id.to_string(),
        capture_generation: generation,
        owner: owner.as_str(),
        occurred_at_ms: now_ms(),
        reason: reason.map(str::to_string),
        message: message.map(str::to_string),
        sample_rate,
        expected,
        recoverability: recoverability.as_str(),
        diagnostics,
    };
    let _ = app.emit("native-audio-lifecycle", event);
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

struct ReleasedActiveCapture {
    #[cfg_attr(not(debug_assertions), allow(dead_code))]
    task: Option<tokio::task::JoinHandle<()>>,
}

fn release_active_capture_if_owner(
    state: &crate::AudioState,
    owner: NativeCaptureOwner,
    session_id: &str,
    generation: u64,
) -> Result<Option<ReleasedActiveCapture>, String> {
    let mut control = state
        .capture_control
        .lock()
        .map_err(|error| format!("Failed to acquire capture control: {}", error))?;
    if !control_owns(
        &control,
        NativeCapturePhase::Active,
        owner,
        session_id,
        generation,
    ) {
        return Ok(None);
    }

    let task = state
        .stream_task
        .lock()
        .map_err(|error| format!("Failed to acquire capture task: {}", error))?
        .take();
    control.phase = NativeCapturePhase::Idle;
    control.lease = None;
    clear_capture_metadata(state);
    Ok(Some(ReleasedActiveCapture { task }))
}

fn finish_capture_if_owner(
    app: &AppHandle,
    owner: NativeCaptureOwner,
    session_id: &str,
    generation: u64,
    sample_rate: u32,
    outcome: CaptureRunOutcome,
) {
    let state = app.state::<crate::AudioState>();
    let finished = matches!(
        release_active_capture_if_owner(&state, owner, session_id, generation),
        Ok(Some(_))
    );

    if finished {
        let _ = app.emit("capture-stopped", ());
        emit_capture_lifecycle(
            app,
            if outcome.expected { "stopped" } else { "error" },
            owner,
            session_id,
            generation,
            Some(outcome.reason.as_str()),
            if outcome.reason == CaptureTerminationReason::CapturePanic {
                Some("System audio capture task panicked.")
            } else {
                None
            },
            Some(sample_rate),
            outcome.expected,
            outcome.recoverability,
            outcome.diagnostics,
        );
    }
}

async fn stop_audio_capture_for_owner(
    app: AppHandle,
    requested_owner: NativeCaptureOwner,
    expected_session_id: Option<String>,
    expected_generation: Option<u64>,
) -> Result<NativeStopDisposition, String> {
    let state = app.state::<crate::AudioState>();
    let (lease, task) = {
        let mut control = state
            .capture_control
            .lock()
            .map_err(|e| format!("Failed to acquire capture control: {}", e))?;
        let lease = match begin_capture_stop(
            &mut control,
            requested_owner,
            expected_session_id.as_deref(),
            expected_generation,
        ) {
            NativeStopDecision::NotRunning => return Ok(NativeStopDisposition::AlreadyIdle),
            NativeStopDecision::WrongOwner(owner) => {
                warn!(
                    "Ignoring {} stop request because capture is owned by {}",
                    requested_owner.as_str(),
                    owner.as_str()
                );
                return Ok(NativeStopDisposition::OwnerMismatch);
            }
            NativeStopDecision::StaleLease(active_lease) => {
                warn!(
                    "Ignoring stale {} stop request for session {:?} generation {:?}; active session is {} generation {}",
                    requested_owner.as_str(),
                    expected_session_id,
                    expected_generation,
                    active_lease.session_id,
                    active_lease.generation
                );
                return Ok(NativeStopDisposition::StaleRequest);
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
        emit_capture_lifecycle(
            &app,
            "stopped",
            lease.owner,
            &lease.session_id,
            lease.generation,
            Some("requested-stop"),
            None,
            None,
            true,
            CaptureRecoverability::NotApplicable,
            CaptureTerminationDiagnostics::default(),
        );
    }
    Ok(if stopped {
        NativeStopDisposition::Stopped
    } else {
        NativeStopDisposition::StaleRequest
    })
}

#[tauri::command]
pub async fn stop_system_audio_capture(
    app: AppHandle,
    expected_capture_session_id: Option<String>,
    expected_capture_generation: Option<u64>,
) -> Result<NativeAudioStopResult, String> {
    let disposition = stop_audio_capture_for_owner(
        app.clone(),
        NativeCaptureOwner::System,
        expected_capture_session_id,
        expected_capture_generation,
    )
    .await?;
    Ok(NativeAudioStopResult {
        disposition: disposition.as_str(),
        status: get_meeting_audio_status(app).await?,
    })
}

#[tauri::command]
pub async fn stop_meeting_audio_session(
    app: AppHandle,
    expected_capture_session_id: Option<String>,
    expected_capture_generation: Option<u64>,
) -> Result<NativeAudioStopResult, String> {
    let disposition = stop_audio_capture_for_owner(
        app.clone(),
        NativeCaptureOwner::Meeting,
        expected_capture_session_id,
        expected_capture_generation,
    )
    .await?;
    Ok(NativeAudioStopResult {
        disposition: disposition.as_str(),
        status: get_meeting_audio_status(app).await?,
    })
}

#[cfg(debug_assertions)]
#[tauri::command]
pub async fn debug_inject_native_audio_fault(
    app: AppHandle,
    expected_owner: String,
    expected_capture_session_id: String,
    expected_capture_generation: u64,
    fault_kind: DebugAudioFaultKind,
    fault_injection_id: String,
) -> Result<DebugAudioFaultResult, String> {
    let owner = NativeCaptureOwner::parse(expected_owner.trim())
        .ok_or_else(|| "Invalid debug audio fault owner".to_string())?;
    let expected_session_id = expected_capture_session_id.trim();
    if expected_session_id.is_empty() {
        return Err("Debug audio fault requires a capture session id".to_string());
    }
    let injection_id = fault_injection_id.trim();
    if injection_id.is_empty() || injection_id.len() > 160 {
        return Err("Debug audio fault requires a bounded injection id".to_string());
    }

    let previous_status = get_meeting_audio_status(app.clone()).await?;
    let state = app.state::<crate::AudioState>();
    let disposition = {
        let control = state
            .capture_control
            .lock()
            .map_err(|error| format!("Failed to acquire capture control: {}", error))?;
        decide_debug_audio_fault(
            &control,
            owner,
            expected_session_id,
            expected_capture_generation,
        )
    };

    if disposition == DebugAudioFaultDisposition::Injected {
        let released = release_active_capture_if_owner(
            &state,
            owner,
            expected_session_id,
            expected_capture_generation,
        )?;
        if let Some(released) = released {
            if let Some(task) = released.task {
                task.abort();
            }
            let outcome = fault_kind.outcome(injection_id);
            let _ = app.emit("capture-stopped", ());
            emit_capture_lifecycle(
                &app,
                "error",
                owner,
                expected_session_id,
                expected_capture_generation,
                Some(outcome.reason.as_str()),
                Some(match fault_kind {
                    DebugAudioFaultKind::RecoverableStreamEnd => {
                        "Debug fault injection: recoverable stream termination."
                    }
                    DebugAudioFaultKind::FatalCaptureFailure => {
                        "Debug fault injection: fatal capture failure."
                    }
                }),
                previous_status.sample_rate,
                outcome.expected,
                outcome.recoverability,
                outcome.diagnostics,
            );
        } else {
            return Ok(DebugAudioFaultResult {
                disposition: DebugAudioFaultDisposition::StaleRequest.as_str(),
                fault_injection_id: injection_id.to_string(),
                previous_status,
                current_status: get_meeting_audio_status(app).await?,
            });
        }
    }

    Ok(DebugAudioFaultResult {
        disposition: disposition.as_str(),
        fault_injection_id: injection_id.to_string(),
        previous_status,
        current_status: get_meeting_audio_status(app).await?,
    })
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

fn samples_to_ms(sample_count: u64, sample_rate: u32) -> u64 {
    if sample_rate == 0 {
        return 0;
    }
    sample_count
        .saturating_mul(1_000)
        .saturating_add((sample_rate as u64) / 2)
        / sample_rate as u64
}

#[cfg(test)]
mod tests {
    use super::{
        begin_capture_stop, claim_capture_lease, control_owns, decide_debug_audio_fault,
        release_active_capture_if_owner, CaptureRecoverability, CaptureRunOutcome,
        CaptureTerminationDiagnostics, CaptureTerminationReason, DebugAudioFaultDisposition,
        DebugAudioFaultKind, NativeAudioLifecycleEvent, NativeAudioSegmentDroppedEvent,
        NativeCaptureControl, NativeCaptureOwner, NativeCapturePhase, NativeSpeechDetectedEvent,
        NativeSpeechStartEvent, NativeStopDecision, SpeakerStreamTermination,
        SpeakerStreamTerminationReason, VadConfig, VadLivenessAccumulator,
    };

    #[test]
    fn serializes_native_speech_event_for_typescript_consumers() {
        let event = NativeSpeechDetectedEvent {
            capture_session_id: "capture-test".to_string(),
            capture_generation: 3,
            segment_sequence: 7,
            owner: "system",
            captured_at_ms: 1234,
            sample_rate: 48_000,
            media_type: "audio/wav",
            audio_base64: "UklGRg==".to_string(),
        };

        let value = serde_json::to_value(event).expect("event should serialize");
        assert_eq!(value["captureSessionId"], "capture-test");
        assert_eq!(value["captureGeneration"], 3);
        assert_eq!(value["segmentSequence"], 7);
        assert_eq!(value["owner"], "system");
        assert_eq!(value["capturedAtMs"], 1234);
        assert_eq!(value["sampleRate"], 48_000);
        assert_eq!(value["mediaType"], "audio/wav");
        assert_eq!(value["audioBase64"], "UklGRg==");
    }

    #[test]
    fn serializes_native_speech_start_identity_for_typescript_consumers() {
        let event = NativeSpeechStartEvent {
            capture_session_id: "capture-test".to_string(),
            capture_generation: 3,
            candidate_segment_sequence: 8,
            owner: "meeting",
            source: "system-audio",
            occurred_at_ms: 1234,
            sample_rate: 48_000,
        };

        let value = serde_json::to_value(event).expect("event should serialize");
        assert_eq!(value["captureSessionId"], "capture-test");
        assert_eq!(value["captureGeneration"], 3);
        assert_eq!(value["candidateSegmentSequence"], 8);
        assert_eq!(value["owner"], "meeting");
        assert_eq!(value["source"], "system-audio");
        assert_eq!(value["occurredAtMs"], 1234);
        assert_eq!(value["sampleRate"], 48_000);
    }

    #[test]
    fn serializes_compact_vad_liveness_without_audio() {
        let mut liveness = VadLivenessAccumulator::default();
        liveness.observe_chunk(1_024, true, true, 0.02, 0.04, 1_200);
        liveness.begin_candidate(1_200);
        let event = liveness.take_snapshot(
            "capture-test",
            3,
            NativeCaptureOwner::Meeting,
            48_000,
            "speech-candidate",
            "speech-start",
            Some(8),
            0,
            None,
            &VadConfig::default(),
            1_200,
        );

        let value = serde_json::to_value(event).expect("event should serialize");
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["snapshotSequence"], 1);
        assert_eq!(value["captureSessionId"], "capture-test");
        assert_eq!(value["captureGeneration"], 3);
        assert_eq!(value["state"], "speech-candidate");
        assert_eq!(value["trigger"], "speech-start");
        assert_eq!(value["candidateSegmentSequence"], 8);
        assert_eq!(value["intervalChunkCount"], 1);
        assert_eq!(value["intervalSignalChunkCount"], 1);
        assert_eq!(value["intervalSpeechChunkCount"], 1);
        assert!(value.get("audioBase64").is_none());
    }

    #[test]
    fn vad_liveness_uses_sample_rate_for_periodic_interval() {
        let mut at_48k = VadLivenessAccumulator::default();
        for _ in 0..93 {
            at_48k.observe_chunk(1_024, false, false, 0.0, 0.0, 1_000);
        }
        assert!(!at_48k.should_emit_periodic(48_000));
        at_48k.observe_chunk(1_024, false, false, 0.0, 0.0, 1_001);
        assert!(at_48k.should_emit_periodic(48_000));

        let mut at_44k = VadLivenessAccumulator::default();
        for _ in 0..86 {
            at_44k.observe_chunk(1_024, false, false, 0.0, 0.0, 1_000);
        }
        assert!(!at_44k.should_emit_periodic(44_100));
        at_44k.observe_chunk(1_024, false, false, 0.0, 0.0, 1_001);
        assert!(at_44k.should_emit_periodic(44_100));
    }

    #[test]
    fn serializes_typed_native_audio_lifecycle_event() {
        let event = NativeAudioLifecycleEvent {
            event_type: "stopped",
            capture_session_id: "capture-test".to_string(),
            capture_generation: 3,
            owner: "meeting",
            occurred_at_ms: 1234,
            reason: Some("stream-ended".to_string()),
            message: None,
            sample_rate: None,
            expected: false,
            recoverability: "retry-once",
            diagnostics: CaptureTerminationDiagnostics {
                dropped_samples: 9_000,
                consecutive_drops: 51,
                buffer_capacity: Some(131_072),
                ..CaptureTerminationDiagnostics::default()
            },
        };

        let value = serde_json::to_value(event).expect("event should serialize");
        assert_eq!(value["eventType"], "stopped");
        assert_eq!(value["captureSessionId"], "capture-test");
        assert_eq!(value["captureGeneration"], 3);
        assert_eq!(value["owner"], "meeting");
        assert_eq!(value["reason"], "stream-ended");
        assert_eq!(value["expected"], false);
        assert_eq!(value["recoverability"], "retry-once");
        assert_eq!(value["diagnostics"]["droppedSamples"], 9_000);
        assert_eq!(value["diagnostics"]["consecutiveDrops"], 51);
        assert_eq!(value["diagnostics"]["bufferCapacity"], 131_072);
    }

    #[test]
    fn serializes_lease_qualified_segment_drop_without_audio() {
        let event = NativeAudioSegmentDroppedEvent {
            capture_session_id: "capture-test".to_string(),
            capture_generation: 3,
            attempted_segment_sequence: 8,
            owner: "meeting",
            occurred_at_ms: 1234,
            reason: "wav-encoding-failed",
            message: "writer failed".to_string(),
        };

        let value = serde_json::to_value(event).expect("event should serialize");
        assert_eq!(value["captureSessionId"], "capture-test");
        assert_eq!(value["captureGeneration"], 3);
        assert_eq!(value["attemptedSegmentSequence"], 8);
        assert_eq!(value["owner"], "meeting");
        assert_eq!(value["reason"], "wav-encoding-failed");
        assert!(value.get("audioBase64").is_none());
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
    fn concurrent_owner_claims_have_exactly_one_winner() {
        let mut control = NativeCaptureControl::default();
        let meeting = claim_capture_lease(
            &mut control,
            NativeCaptureOwner::Meeting,
            "meeting-1".to_string(),
        )
        .expect("meeting should claim the idle controller");

        let legacy = claim_capture_lease(
            &mut control,
            NativeCaptureOwner::System,
            "system-1".to_string(),
        );

        assert!(legacy.is_err());
        assert_eq!(control.phase, NativeCapturePhase::Starting);
        assert_eq!(control.lease, Some(meeting));
    }

    #[test]
    fn stop_during_start_invalidates_the_starting_lease() {
        let mut control = NativeCaptureControl::default();
        let lease = claim_capture_lease(
            &mut control,
            NativeCaptureOwner::Meeting,
            "meeting-1".to_string(),
        )
        .expect("meeting should claim the idle controller");

        assert_eq!(
            begin_capture_stop(
                &mut control,
                NativeCaptureOwner::Meeting,
                Some(&lease.session_id),
                Some(lease.generation),
            ),
            NativeStopDecision::Acquired(lease.clone())
        );
        assert!(!control_owns(
            &control,
            NativeCapturePhase::Starting,
            lease.owner,
            &lease.session_id,
            lease.generation,
        ));
        assert_eq!(control.phase, NativeCapturePhase::Stopping);
    }

    #[test]
    fn wrong_owner_cannot_stop_an_active_capture() {
        let mut control = NativeCaptureControl::default();
        let lease = claim_capture_lease(
            &mut control,
            NativeCaptureOwner::Meeting,
            "meeting-1".to_string(),
        )
        .expect("meeting capture should claim the controller");
        control.phase = NativeCapturePhase::Active;

        assert_eq!(
            begin_capture_stop(
                &mut control,
                NativeCaptureOwner::System,
                Some(&lease.session_id),
                Some(lease.generation),
            ),
            NativeStopDecision::WrongOwner(NativeCaptureOwner::Meeting)
        );
        assert_eq!(control.phase, NativeCapturePhase::Active);
        assert_eq!(
            begin_capture_stop(
                &mut control,
                NativeCaptureOwner::Meeting,
                Some(&lease.session_id),
                Some(lease.generation),
            ),
            NativeStopDecision::Acquired(lease)
        );
        assert_eq!(control.phase, NativeCapturePhase::Stopping);
    }

    #[test]
    fn stale_same_owner_lease_cannot_stop_a_new_generation() {
        let mut control = NativeCaptureControl::default();
        let old = claim_capture_lease(
            &mut control,
            NativeCaptureOwner::Meeting,
            "meeting-old".to_string(),
        )
        .expect("old capture should claim the controller");
        control.phase = NativeCapturePhase::Idle;
        control.lease = None;
        let current = claim_capture_lease(
            &mut control,
            NativeCaptureOwner::Meeting,
            "meeting-current".to_string(),
        )
        .expect("current capture should claim the controller");
        control.phase = NativeCapturePhase::Active;

        assert_eq!(
            begin_capture_stop(
                &mut control,
                NativeCaptureOwner::Meeting,
                Some(&old.session_id),
                Some(old.generation),
            ),
            NativeStopDecision::StaleLease(current.clone())
        );
        assert_eq!(control.phase, NativeCapturePhase::Active);
        assert_eq!(control.lease, Some(current));
    }

    #[test]
    fn buffer_overflow_maps_to_one_recoverable_capture_outcome() {
        let outcome = CaptureRunOutcome::from_stream(SpeakerStreamTermination {
            reason: SpeakerStreamTerminationReason::BufferOverflow,
            dropped_samples: 24_000,
            consecutive_drops: 51,
            buffer_capacity: Some(131_072),
        });

        assert_eq!(outcome.reason, CaptureTerminationReason::BufferOverflow);
        assert!(!outcome.expected);
        assert_eq!(outcome.recoverability, CaptureRecoverability::RetryOnce);
        assert_eq!(outcome.diagnostics.dropped_samples, 24_000);
        assert_eq!(outcome.diagnostics.consecutive_drops, 51);
        assert_eq!(outcome.diagnostics.buffer_capacity, Some(131_072));
    }

    #[test]
    fn capture_panic_requires_manual_recovery() {
        let outcome = CaptureRunOutcome::panic();

        assert_eq!(outcome.reason, CaptureTerminationReason::CapturePanic);
        assert!(!outcome.expected);
        assert_eq!(outcome.recoverability, CaptureRecoverability::Manual);
        assert_eq!(
            outcome.diagnostics,
            CaptureTerminationDiagnostics::default()
        );
    }

    #[test]
    fn debug_fault_requires_the_exact_active_capture_lease() {
        let mut control = NativeCaptureControl::default();
        assert_eq!(
            decide_debug_audio_fault(&control, NativeCaptureOwner::Meeting, "meeting-1", 1,),
            DebugAudioFaultDisposition::AlreadyIdle
        );

        let lease = claim_capture_lease(
            &mut control,
            NativeCaptureOwner::Meeting,
            "meeting-1".to_string(),
        )
        .expect("meeting capture should claim the controller");
        assert_eq!(
            decide_debug_audio_fault(
                &control,
                NativeCaptureOwner::Meeting,
                &lease.session_id,
                lease.generation,
            ),
            DebugAudioFaultDisposition::NotActive
        );
        control.phase = NativeCapturePhase::Active;
        assert_eq!(
            decide_debug_audio_fault(
                &control,
                NativeCaptureOwner::System,
                &lease.session_id,
                lease.generation,
            ),
            DebugAudioFaultDisposition::OwnerMismatch
        );
        assert_eq!(
            decide_debug_audio_fault(
                &control,
                NativeCaptureOwner::Meeting,
                "stale-session",
                lease.generation,
            ),
            DebugAudioFaultDisposition::StaleRequest
        );
        assert_eq!(
            decide_debug_audio_fault(
                &control,
                NativeCaptureOwner::Meeting,
                &lease.session_id,
                lease.generation,
            ),
            DebugAudioFaultDisposition::Injected
        );
    }

    #[test]
    fn debug_fault_releases_only_the_exact_active_capture() {
        let state = crate::AudioState::default();
        let lease = {
            let mut control = state
                .capture_control
                .lock()
                .expect("capture control should lock");
            let lease = claim_capture_lease(
                &mut control,
                NativeCaptureOwner::Meeting,
                "meeting-1".to_string(),
            )
            .expect("meeting capture should claim the controller");
            control.phase = NativeCapturePhase::Active;
            lease
        };

        assert!(release_active_capture_if_owner(
            &state,
            NativeCaptureOwner::Meeting,
            "stale-session",
            lease.generation,
        )
        .expect("stale release should not fail")
        .is_none());
        assert!(release_active_capture_if_owner(
            &state,
            NativeCaptureOwner::Meeting,
            &lease.session_id,
            lease.generation,
        )
        .expect("exact release should succeed")
        .is_some());

        let control = state
            .capture_control
            .lock()
            .expect("capture control should lock");
        assert_eq!(control.phase, NativeCapturePhase::Idle);
        assert!(control.lease.is_none());
    }

    #[test]
    fn debug_fault_outcomes_use_the_production_lifecycle_contract() {
        let recoverable =
            DebugAudioFaultKind::RecoverableStreamEnd.outcome("native_audio_fault_recoverable");
        assert_eq!(
            recoverable.reason,
            CaptureTerminationReason::UnknownStreamEnd
        );
        assert_eq!(recoverable.recoverability, CaptureRecoverability::RetryOnce);
        assert!(recoverable.diagnostics.fault_injected);
        assert_eq!(
            recoverable.diagnostics.fault_kind.as_deref(),
            Some("recoverable-stream-end")
        );

        let fatal = DebugAudioFaultKind::FatalCaptureFailure.outcome("native_audio_fault_fatal");
        assert_eq!(fatal.reason, CaptureTerminationReason::CapturePanic);
        assert_eq!(fatal.recoverability, CaptureRecoverability::Manual);
        assert_eq!(
            fatal.diagnostics.fault_injection_id.as_deref(),
            Some("native_audio_fault_fatal")
        );
    }
}
