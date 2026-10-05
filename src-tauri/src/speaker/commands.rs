// Jarvis AI Speech Detection, and capture system audio (speaker output) as a stream of f32 samples.
use crate::native_stall_diagnostics::NativeStallDiagnostics;
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
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tracing::{debug, error, info, warn};
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
    start_in_flight: Option<NativeCaptureLease>,
    metadata: Option<NativeCaptureMetadata>,
    task: Option<tokio::task::JoinHandle<()>>,
    signals: Option<NativeCaptureSignals>,
    vad_config: VadConfig,
    capture_vad_config: Option<VadConfig>,
}

#[derive(Debug)]
struct NativeCaptureMetadata {
    device_id: Option<String>,
    sample_rate: u32,
    started_at_ms: u64,
}

const NATIVE_START_FOREGROUND_TIMEOUT: Duration = Duration::from_secs(5);

struct PreparedNativeCapture {
    stream: SpeakerStream,
    sample_rate: u32,
}

struct NativeStartFailure {
    reason: &'static str,
    message: String,
    sample_rate: Option<u32>,
}

struct NativeStartFlightGuard {
    app: AppHandle,
    lease: NativeCaptureLease,
}

impl Drop for NativeStartFlightGuard {
    fn drop(&mut self) {
        let state = self.app.state::<crate::AudioState>();
        if let Ok(mut control) = state.capture_control.lock() {
            clear_start_in_flight(&mut control, &self.lease);
        };
    }
}

fn clear_start_in_flight(control: &mut NativeCaptureControl, lease: &NativeCaptureLease) {
    if control.start_in_flight.as_ref() == Some(lease) {
        control.start_in_flight = None;
    }
}

fn discard_timed_out_start<T: Send + 'static>(receiver: &mut tokio::sync::oneshot::Receiver<T>) {
    // Late sends fail on the worker; already queued resources leave the IPC thread for disposal.
    receiver.close();
    if let Ok(result) = receiver.try_recv() {
        if let Err(error) = std::thread::Builder::new()
            .name("native-audio-discard".into())
            .spawn(move || drop(result))
        {
            warn!("Could not start background audio cleanup: {error}");
        }
    }
}

fn fail_capture_start(
    app: &AppHandle,
    lease: &NativeCaptureLease,
    failure: NativeStartFailure,
) -> String {
    release_starting_capture(
        &app.state::<crate::AudioState>(),
        lease.owner,
        &lease.session_id,
        lease.generation,
    );
    emit_capture_lifecycle(
        app,
        "error",
        lease.owner,
        &lease.session_id,
        lease.generation,
        Some(failure.reason),
        Some(&failure.message),
        failure.sample_rate,
        false,
        CaptureRecoverability::Manual,
        CaptureTerminationDiagnostics::default(),
    );
    failure.message
}

#[derive(Debug, Clone, Default)]
struct NativeCaptureSignals {
    stop_requested: Arc<AtomicBool>,
    termination_requested: Arc<AtomicBool>,
    termination_request: Arc<Mutex<Option<NativeCaptureTerminationRequest>>>,
    stopped: Arc<tokio::sync::Notify>,
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
    if control.start_in_flight.is_some() {
        return Err(
            "Previous system audio start is still finishing; retry when it completes".into(),
        );
    }
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
    control.start_in_flight = Some(lease.clone());
    control.signals = Some(NativeCaptureSignals::default());
    control.capture_vad_config = Some(control.vad_config.clone());
    Ok(lease)
}

fn reserve_capture(
    state: &crate::AudioState,
    owner: NativeCaptureOwner,
    session_id: String,
    config: Option<VadConfig>,
) -> Result<(NativeCaptureLease, NativeCaptureSignals, VadConfig), String> {
    if let Some(config) = config.as_ref() {
        validate_vad_config(config)?;
    }
    let mut control = state
        .capture_control
        .lock()
        .map_err(|error| format!("Failed to acquire capture control: {}", error))?;
    let lease = claim_capture_lease(&mut control, owner, session_id)?;
    if let Some(config) = config {
        control.vad_config = config.clone();
        control.capture_vad_config = Some(config);
    }
    Ok((
        lease,
        control.signals.as_ref().unwrap().clone(),
        control.capture_vad_config.as_ref().unwrap().clone(),
    ))
}

fn activate_capture_if_owner(
    state: &crate::AudioState,
    lease: &NativeCaptureLease,
    metadata: NativeCaptureMetadata,
    spawn_task: impl FnOnce() -> tokio::task::JoinHandle<()>,
) -> Result<(), String> {
    let mut control = state
        .capture_control
        .lock()
        .map_err(|error| format!("Failed to acquire capture control: {}", error))?;
    if !control_owns(
        &control,
        NativeCapturePhase::Starting,
        lease.owner,
        &lease.session_id,
        lease.generation,
    ) {
        // Debug, not warn: a start that a later stop or start superseded is a
        // designed outcome of the lease, and its caller receives the error.
        debug!(
            "Capture start superseded: expected {:?}, observed {:?}, phase {:?}",
            lease, control.lease, control.phase
        );
        return Err("Capture start was superseded".to_string());
    }
    // Only task scheduling occurs here; initialization and stream destruction stay outside the lock.
    control.task = Some(spawn_task());
    control.metadata = Some(metadata);
    control.phase = NativeCapturePhase::Active;
    Ok(())
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
#[serde(default)]
pub struct VadConfig {
    pub enabled: bool,
    pub hop_size: usize,
    pub sensitivity_rms: f32,
    pub peak_threshold: f32,
    pub silence_duration_ms: u64,
    pub minimum_speech_duration_ms: u64,
    pub pre_speech_duration_ms: u64,
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
            silence_duration_ms: 1_045,
            minimum_speech_duration_ms: 163,
            pre_speech_duration_ms: 279,
            noise_gate_threshold: 0.003,      // Stronger noise filtering
            max_recording_duration_secs: 180, // 3 minutes default
        }
    }
}

const MAX_VAD_SEGMENT_MS: u64 = 30_000;
const FORCED_ROLLOVER_OVERLAP_MS: u64 = 400;
const TRAILING_SILENCE_KEEP_MS: u64 = 150;
const GRACEFUL_CAPTURE_STOP_TIMEOUT_MS: u64 = 750;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ResolvedVadTiming {
    silence_samples: usize,
    minimum_speech_samples: usize,
    pre_speech_samples: usize,
    maximum_segment_samples: usize,
    rollover_overlap_samples: usize,
    trailing_silence_keep_samples: usize,
}

impl ResolvedVadTiming {
    fn resolve(config: &VadConfig, sample_rate: u32) -> Self {
        Self {
            silence_samples: ms_to_samples_ceil(config.silence_duration_ms, sample_rate),
            minimum_speech_samples: ms_to_samples_ceil(
                config.minimum_speech_duration_ms,
                sample_rate,
            ),
            pre_speech_samples: ms_to_samples_ceil(config.pre_speech_duration_ms, sample_rate),
            maximum_segment_samples: ms_to_samples_ceil(MAX_VAD_SEGMENT_MS, sample_rate),
            rollover_overlap_samples: ms_to_samples_ceil(FORCED_ROLLOVER_OVERLAP_MS, sample_rate),
            trailing_silence_keep_samples: ms_to_samples_ceil(
                TRAILING_SILENCE_KEEP_MS,
                sample_rate,
            ),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeSegmentEndReason {
    Silence,
    ForcedRollover,
    StopDrain,
    TerminationDrain,
    ContinuousStop,
}

impl NativeSegmentEndReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::Silence => "silence",
            Self::ForcedRollover => "forced-rollover",
            Self::StopDrain => "stop-drain",
            Self::TerminationDrain => "termination-drain",
            Self::ContinuousStop => "continuous-stop",
        }
    }
}

#[derive(Debug, Clone)]
struct NativeSegmentBoundary {
    sample_start: u64,
    sample_end: u64,
    speech_started_at_ms: u64,
    speech_ended_at_ms: u64,
    segment_emitted_at_ms: u64,
    end_reason: NativeSegmentEndReason,
    rollover_family_id: Option<String>,
    overlap_sample_count: u64,
    silence_target_samples: u64,
    minimum_speech_samples: u64,
    pre_speech_samples: u64,
    maximum_segment_samples: u64,
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
    pub speech_started_at_ms: u64,
    pub speech_ended_at_ms: u64,
    pub segment_emitted_at_ms: u64,
    pub sample_start: u64,
    pub sample_end: u64,
    pub sample_rate: u32,
    pub duration_ms: u64,
    pub end_reason: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rollover_family_id: Option<String>,
    pub overlap_sample_count: u64,
    pub overlap_duration_ms: u64,
    pub vad_silence_target_samples: u64,
    pub vad_minimum_speech_samples: u64,
    pub vad_pre_speech_samples: u64,
    pub vad_maximum_segment_samples: u64,
    pub media_type: &'static str,
    pub audio_base64: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_timing: Option<NativeAudioDeliveryTiming>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioDeliveryTiming {
    pub raw_ready_at_ms: u64,
    pub encode_started_at_ms: u64,
    pub encoded_at_ms: u64,
    pub encode_duration_micros: u64,
    pub emit_started_at_ms: u64,
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

const VAD_LIVENESS_SCHEMA_VERSION: u16 = 2;
const VAD_LIVENESS_INTERVAL_MS: u64 = 2_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioLivenessEvent {
    pub schema_version: u16,
    pub snapshot_sequence: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic_run_id: Option<String>,
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
    pub raw_signal_chunk_count: u64,
    pub raw_zero_duration_ms: u64,
    pub last_raw_signal_observed_at_ms: Option<u64>,
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
    raw_signal_chunk_count: u64,
    raw_zero_sample_count: u64,
    last_raw_signal_observed_at_ms: Option<u64>,
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
    fn observe_raw_chunk(&mut self, samples: &[f32], observed_at_ms: u64) {
        if samples.iter().any(|sample| *sample != 0.0) {
            self.raw_signal_chunk_count = self.raw_signal_chunk_count.saturating_add(1);
            self.raw_zero_sample_count = 0;
            self.last_raw_signal_observed_at_ms = Some(observed_at_ms);
        } else {
            self.raw_zero_sample_count = self
                .raw_zero_sample_count
                .saturating_add(samples.len() as u64);
        }
    }

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
        silence_samples: usize,
        discard_reason: Option<&'static str>,
        config: &VadConfig,
        occurred_at_ms: u64,
    ) -> NativeAudioLivenessEvent {
        self.snapshot_sequence = self.snapshot_sequence.saturating_add(1);
        let event = NativeAudioLivenessEvent {
            schema_version: VAD_LIVENESS_SCHEMA_VERSION,
            snapshot_sequence: self.snapshot_sequence,
            diagnostic_run_id: None,
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
            silence_duration_ms: samples_to_ms(silence_samples as u64, sample_rate),
            interval_duration_ms: samples_to_ms(self.interval_sample_count, sample_rate),
            interval_chunk_count: self.interval_chunk_count,
            interval_signal_chunk_count: self.interval_signal_chunk_count,
            interval_speech_chunk_count: self.interval_speech_chunk_count,
            interval_max_rms: self.interval_max_rms,
            interval_max_peak: self.interval_max_peak,
            processed_chunk_count: self.processed_chunk_count,
            signal_chunk_count: self.signal_chunk_count,
            raw_signal_chunk_count: self.raw_signal_chunk_count,
            raw_zero_duration_ms: samples_to_ms(self.raw_zero_sample_count, sample_rate),
            last_raw_signal_observed_at_ms: self.last_raw_signal_observed_at_ms,
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
            silence_target_ms: config.silence_duration_ms,
            minimum_speech_ms: config.minimum_speech_duration_ms,
            maximum_segment_ms: MAX_VAD_SEGMENT_MS,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_tail_flush_operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_tail_flush_requested_at_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_tail_flush_acknowledged_at_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_tail_flush_duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_tail_flush_disposition: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_tail_flush_candidate_segment_sequence: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_tail_flush_candidate_duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_tail_flush_emitted_segment_sequence: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_tail_flush_no_qualifying_candidate_reason: Option<String>,
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
fn request_debug_audio_fault(
    control: &NativeCaptureControl,
    owner: NativeCaptureOwner,
    session_id: &str,
    generation: u64,
    outcome: CaptureRunOutcome,
) -> Result<DebugAudioFaultDisposition, String> {
    let disposition = decide_debug_audio_fault(control, owner, session_id, generation);
    if disposition == DebugAudioFaultDisposition::Injected {
        let signals = control
            .signals
            .as_ref()
            .expect("active capture has signals");
        *signals.termination_request.lock().map_err(|error| {
            format!("Failed to acquire capture termination request: {}", error)
        })? = Some(NativeCaptureTerminationRequest {
            owner,
            capture_session_id: session_id.to_string(),
            capture_generation: generation,
            outcome,
        });
        signals.termination_requested.store(true, Ordering::Release);
    }
    Ok(disposition)
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

    fn with_native_tail_flush_request(
        mut self,
        operation_id: String,
        requested_at_ms: u64,
    ) -> Self {
        self.diagnostics.native_tail_flush_operation_id = Some(operation_id);
        self.diagnostics.native_tail_flush_requested_at_ms = Some(requested_at_ms);
        self
    }

    fn acknowledge_native_tail_flush(
        &mut self,
        disposition: NativeTailFlushDisposition,
        candidate_segment_sequence: Option<u64>,
        candidate_duration_ms: u64,
        emitted_segment_sequence: Option<u64>,
        no_qualifying_candidate_reason: Option<&'static str>,
        acknowledged_at_ms: u64,
    ) {
        let requested_at_ms = self
            .diagnostics
            .native_tail_flush_requested_at_ms
            .unwrap_or(acknowledged_at_ms);
        self.diagnostics.native_tail_flush_acknowledged_at_ms = Some(acknowledged_at_ms);
        self.diagnostics.native_tail_flush_duration_ms =
            Some(acknowledged_at_ms.saturating_sub(requested_at_ms));
        self.diagnostics.native_tail_flush_disposition = Some(disposition.as_str().to_string());
        self.diagnostics
            .native_tail_flush_candidate_segment_sequence = candidate_segment_sequence;
        self.diagnostics.native_tail_flush_candidate_duration_ms = Some(candidate_duration_ms);
        self.diagnostics.native_tail_flush_emitted_segment_sequence = emitted_segment_sequence;
        self.diagnostics
            .native_tail_flush_no_qualifying_candidate_reason =
            no_qualifying_candidate_reason.map(str::to_string);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeTailFlushDisposition {
    SegmentEmitted,
    NoQualifyingCandidate,
    EncodingFailed,
    TimedOut,
}

impl NativeTailFlushDisposition {
    fn as_str(self) -> &'static str {
        match self {
            Self::SegmentEmitted => "segment-emitted",
            Self::NoQualifyingCandidate => "no-qualifying-candidate",
            Self::EncodingFailed => "encoding-failed",
            Self::TimedOut => "timeout",
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct NativeCaptureTerminationRequest {
    owner: NativeCaptureOwner,
    capture_session_id: String,
    capture_generation: u64,
    outcome: CaptureRunOutcome,
}

fn take_capture_termination_request(
    requested: &AtomicBool,
    request: &Mutex<Option<NativeCaptureTerminationRequest>>,
    owner: NativeCaptureOwner,
    capture_session_id: &str,
    capture_generation: u64,
) -> Option<CaptureRunOutcome> {
    if !requested.load(Ordering::Acquire) {
        return None;
    }

    let mut guard = request.lock().ok()?;
    let matches_active_capture = guard.as_ref().is_some_and(|pending| {
        pending.owner == owner
            && pending.capture_session_id == capture_session_id
            && pending.capture_generation == capture_generation
    });
    if !matches_active_capture {
        return None;
    }

    let outcome = guard.take().map(|pending| pending.outcome);
    requested.store(false, Ordering::Release);
    outcome
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
    let (lease, signals, vad_config) = reserve_capture(
        &state,
        capture_owner,
        capture_session_id.clone(),
        vad_config,
    )?;
    let capture_generation = lease.generation;

    let requested_device_id = device_id.clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let worker_app = app.clone();
    let worker_lease = lease.clone();
    let guard = NativeStartFlightGuard {
        app: app.clone(),
        lease: lease.clone(),
    };
    if let Err(error) = std::thread::Builder::new()
        .name("native-audio-start".into())
        .spawn(move || {
            let result = prepare_native_capture(&worker_app, device_id, &worker_lease);
            let _ = sender.send((result, guard));
        })
    {
        return Err(fail_capture_start(
            &app,
            &lease,
            NativeStartFailure {
                reason: "start-failed",
                message: format!("System audio startup worker unavailable: {error}"),
                sample_rate: None,
            },
        ));
    }
    let mut receiver = receiver;
    let (prepared, guard) =
        match tokio::time::timeout(NATIVE_START_FOREGROUND_TIMEOUT, &mut receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                return Err(fail_capture_start(
                    &app,
                    &lease,
                    NativeStartFailure {
                        reason: "start-failed",
                        message: "System audio startup ended unexpectedly".into(),
                        sample_rate: None,
                    },
                ));
            }
            Err(_) => {
                discard_timed_out_start(&mut receiver);
                return Err(fail_capture_start(
                    &app,
                    &lease,
                    NativeStartFailure {
                        reason: "start-failed",
                        message: "System audio startup exceeded 5 seconds; retry after it finishes"
                            .into(),
                        sample_rate: None,
                    },
                ));
            }
        };
    let PreparedNativeCapture {
        stream,
        sample_rate: sr,
    } = match prepared {
        Ok(prepared) => prepared,
        Err(failure) => {
            let message = fail_capture_start(&app, &lease, failure);
            drop(guard);
            return Err(message);
        }
    };

    let app_clone = app.clone();
    let capture_stop_requested = signals.stop_requested;
    let capture_termination_requested = signals.termination_requested;
    let capture_termination_request = signals.termination_request;
    let task_session_id = capture_session_id.clone();
    let activation = activate_capture_if_owner(
        &state,
        &lease,
        NativeCaptureMetadata {
            device_id: requested_device_id,
            sample_rate: sr,
            started_at_ms: now_ms(),
        },
        move || {
            tokio::spawn(async move {
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
                            capture_stop_requested.clone(),
                            capture_termination_requested.clone(),
                            capture_termination_request.clone(),
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
                            capture_stop_requested.clone(),
                            capture_termination_requested.clone(),
                            capture_termination_request.clone(),
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
            })
        },
    );
    drop(guard);
    activation?;

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

fn prepare_native_capture(
    app: &AppHandle,
    device_id: Option<String>,
    lease: &NativeCaptureLease,
) -> Result<PreparedNativeCapture, NativeStartFailure> {
    let input = match std::panic::catch_unwind(AssertUnwindSafe(|| {
        SpeakerInput::new_with_device(device_id.clone())
    })) {
        Ok(Ok(input)) => input,
        Ok(Err(error)) => {
            error!("Failed to create speaker input: {}", error);
            return Err(NativeStartFailure {
                reason: "start-failed",
                message: format!("Failed to access system audio: {error}"),
                sample_rate: None,
            });
        }
        Err(_) => {
            return Err(NativeStartFailure {
                reason: CaptureTerminationReason::CapturePanic.as_str(),
                message: "System audio initialization panicked".into(),
                sample_rate: None,
            });
        }
    };
    let diagnostics = serde_json::json!({
        "stage": "capture-format",
        "captureSessionId": lease.session_id,
        "captureGeneration": lease.generation,
        "owner": lease.owner.as_str(),
        "occurredAtMs": now_ms(),
        "requestedDeviceId": device_id,
        "actualRoute": input.capture_diagnostics(),
    });
    info!("[native-audio-observation] {}", diagnostics);
    let _ = app.emit("native-audio-observation", diagnostics);
    let stream = std::panic::catch_unwind(AssertUnwindSafe(|| input.stream())).map_err(|_| {
        NativeStartFailure {
            reason: CaptureTerminationReason::CapturePanic.as_str(),
            message: "System audio stream creation panicked".into(),
            sample_rate: None,
        }
    })?;
    let sample_rate = stream.sample_rate();
    if !(8000..=96000).contains(&sample_rate) {
        error!("Invalid sample rate: {}", sample_rate);
        return Err(NativeStartFailure {
            reason: CaptureTerminationReason::InvalidSampleRate.as_str(),
            message: format!("Invalid sample rate: {sample_rate}. Expected 8000-96000 Hz"),
            sample_rate: Some(sample_rate),
        });
    }
    Ok(PreparedNativeCapture {
        stream,
        sample_rate,
    })
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
    stop_requested: Arc<AtomicBool>,
    termination_requested: Arc<AtomicBool>,
    termination_request: Arc<Mutex<Option<NativeCaptureTerminationRequest>>>,
) -> CaptureRunOutcome {
    let mut stream = stream;
    #[cfg(target_os = "macos")]
    if capture_owner == NativeCaptureOwner::Meeting {
        app.state::<NativeStallDiagnostics>().set_capture(
            &capture_session_id,
            capture_generation,
            stream.callback_counters(),
        );
    }
    let timing = ResolvedVadTiming::resolve(&config, sr);
    let capture_started_at_ms = now_ms();
    let mut buffer: VecDeque<f32> = VecDeque::new();
    let mut pre_speech: VecDeque<f32> = VecDeque::with_capacity(timing.pre_speech_samples);
    let mut speech_buffer = Vec::new();
    let mut in_speech = false;
    let mut silence_samples = 0_usize;
    let mut speech_evidence_samples = 0_usize;
    let mut processed_samples = 0_u64;
    let mut segment_start_sample = 0_u64;
    let mut segment_overlap_sample_count = 0_usize;
    let mut rollover_family_id: Option<String> = None;
    let mut segment_sequence = 0_u64;
    let mut liveness = VadLivenessAccumulator::default();
    let mut evaluation_tap = if capture_owner == NativeCaptureOwner::Meeting {
        create_raw_evaluation_capture_tap(&app, &capture_session_id, capture_generation, sr)
    } else {
        None
    };
    let (tail_end_reason, mut outcome) = loop {
        if let Some(outcome) = take_capture_termination_request(
            &termination_requested,
            &termination_request,
            capture_owner,
            &capture_session_id,
            capture_generation,
        ) {
            break (NativeSegmentEndReason::TerminationDrain, outcome);
        }
        if stop_requested.load(Ordering::Acquire) {
            break (
                NativeSegmentEndReason::StopDrain,
                CaptureRunOutcome::expected(CaptureTerminationReason::RequestedStop),
            );
        }

        let Some(sample) = stream.next().await else {
            let requested_at_ms = now_ms();
            break (
                NativeSegmentEndReason::TerminationDrain,
                CaptureRunOutcome::from_stream(stream.termination())
                    .with_native_tail_flush_request(
                        format!("native_tail_flush_{}", Uuid::new_v4()),
                        requested_at_ms,
                    ),
            );
        };
        if let Some(tap) = evaluation_tap.as_mut() {
            tap.push_sample(sample);
        }
        buffer.push_back(sample);

        while buffer.len() >= config.hop_size {
            let mut mono = Vec::with_capacity(config.hop_size);
            for _ in 0..config.hop_size {
                if let Some(v) = buffer.pop_front() {
                    mono.push(v);
                }
            }

            let observed_at_ms = now_ms();
            liveness.observe_raw_chunk(&mono, observed_at_ms);
            let mono = apply_noise_gate(&mono, config.noise_gate_threshold);
            let (rms, peak) = calculate_audio_metrics(&mono);
            let is_speech = rms > config.sensitivity_rms || peak > config.peak_threshold;
            liveness.observe_chunk(mono.len(), peak > 0.0, is_speech, rms, peak, observed_at_ms);
            let chunk_start_sample = processed_samples;
            processed_samples = processed_samples.saturating_add(mono.len() as u64);

            if is_speech {
                if !in_speech {
                    in_speech = true;
                    speech_evidence_samples = 0;
                    liveness.begin_candidate(observed_at_ms);

                    segment_start_sample =
                        chunk_start_sample.saturating_sub(pre_speech.len() as u64);
                    segment_overlap_sample_count = 0;
                    rollover_family_id = None;
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
                        silence_samples,
                        None,
                        &config,
                        observed_at_ms,
                    );
                }

                speech_evidence_samples = speech_evidence_samples.saturating_add(mono.len());
                speech_buffer.extend_from_slice(&mono);
                silence_samples = 0;

                if speech_buffer.len() >= timing.maximum_segment_samples {
                    let emitted_at_ms = now_ms();
                    let sample_end =
                        segment_start_sample.saturating_add(speech_buffer.len() as u64);
                    let family_id = rollover_family_id
                        .get_or_insert_with(|| {
                            format!(
                                "{}-{}-{}",
                                capture_session_id,
                                capture_generation,
                                segment_sequence + 1
                            )
                        })
                        .clone();
                    let boundary = NativeSegmentBoundary {
                        sample_start: segment_start_sample,
                        sample_end,
                        speech_started_at_ms: sample_offset_to_wall_ms(
                            capture_started_at_ms,
                            segment_start_sample,
                            sr,
                        ),
                        speech_ended_at_ms: sample_offset_to_wall_ms(
                            capture_started_at_ms,
                            sample_end,
                            sr,
                        ),
                        segment_emitted_at_ms: emitted_at_ms,
                        end_reason: NativeSegmentEndReason::ForcedRollover,
                        rollover_family_id: Some(family_id.clone()),
                        overlap_sample_count: segment_overlap_sample_count as u64,
                        silence_target_samples: timing.silence_samples as u64,
                        minimum_speech_samples: timing.minimum_speech_samples as u64,
                        pre_speech_samples: timing.pre_speech_samples as u64,
                        maximum_segment_samples: timing.maximum_segment_samples as u64,
                    };
                    match encode_and_emit_speech_segment(
                        &app,
                        &capture_session_id,
                        &mut segment_sequence,
                        sr,
                        &speech_buffer,
                        capture_owner,
                        capture_generation,
                        boundary,
                    ) {
                        Ok(emitted_sequence) => {
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
                                Some(emitted_sequence),
                                silence_samples,
                                None,
                                &config,
                                emitted_at_ms,
                            );
                            let overlap_count =
                                timing.rollover_overlap_samples.min(speech_buffer.len());
                            let retained_from = speech_buffer.len().saturating_sub(overlap_count);
                            speech_buffer = speech_buffer[retained_from..].to_vec();
                            segment_start_sample = sample_end.saturating_sub(overlap_count as u64);
                            segment_overlap_sample_count = overlap_count;
                            speech_evidence_samples = 0;
                            silence_samples = 0;
                            liveness.clear_candidate();
                            liveness.begin_candidate(emitted_at_ms);
                            emit_speech_start(
                                &app,
                                &capture_session_id,
                                segment_sequence + 1,
                                sr,
                                capture_owner,
                                capture_generation,
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
                                silence_samples,
                                Some("wav-encoding-failed"),
                                &config,
                                dropped_at_ms,
                            );
                            speech_buffer.clear();
                            in_speech = false;
                            speech_evidence_samples = 0;
                            silence_samples = 0;
                            segment_overlap_sample_count = 0;
                            rollover_family_id = None;
                            liveness.clear_candidate();
                        }
                    }
                }
            } else {
                if in_speech {
                    silence_samples = silence_samples.saturating_add(mono.len());
                    speech_buffer.extend_from_slice(&mono);

                    if silence_samples >= timing.silence_samples {
                        if speech_evidence_samples >= timing.minimum_speech_samples
                            && !speech_buffer.is_empty()
                        {
                            trim_trailing_silence(
                                &mut speech_buffer,
                                silence_samples,
                                timing.trailing_silence_keep_samples,
                            );
                            let emitted_at_ms = now_ms();
                            let sample_end =
                                segment_start_sample.saturating_add(speech_buffer.len() as u64);
                            let boundary = NativeSegmentBoundary {
                                sample_start: segment_start_sample,
                                sample_end,
                                speech_started_at_ms: sample_offset_to_wall_ms(
                                    capture_started_at_ms,
                                    segment_start_sample,
                                    sr,
                                ),
                                speech_ended_at_ms: sample_offset_to_wall_ms(
                                    capture_started_at_ms,
                                    sample_end,
                                    sr,
                                ),
                                segment_emitted_at_ms: emitted_at_ms,
                                end_reason: NativeSegmentEndReason::Silence,
                                rollover_family_id: rollover_family_id.clone(),
                                overlap_sample_count: segment_overlap_sample_count as u64,
                                silence_target_samples: timing.silence_samples as u64,
                                minimum_speech_samples: timing.minimum_speech_samples as u64,
                                pre_speech_samples: timing.pre_speech_samples as u64,
                                maximum_segment_samples: timing.maximum_segment_samples as u64,
                            };
                            match encode_and_emit_speech_segment(
                                &app,
                                &capture_session_id,
                                &mut segment_sequence,
                                sr,
                                &speech_buffer,
                                capture_owner,
                                capture_generation,
                                boundary,
                            ) {
                                Ok(emitted_sequence) => {
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
                                        Some(emitted_sequence),
                                        silence_samples,
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
                                        silence_samples,
                                        Some("wav-encoding-failed"),
                                        &config,
                                        dropped_at_ms,
                                    );
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
                                silence_samples,
                                Some("below-minimum-speech"),
                                &config,
                                now_ms(),
                            );
                        }

                        speech_buffer.clear();
                        in_speech = false;
                        silence_samples = 0;
                        speech_evidence_samples = 0;
                        segment_overlap_sample_count = 0;
                        rollover_family_id = None;
                        liveness.clear_candidate();
                    }
                } else {
                    pre_speech.extend(mono.into_iter());
                    while pre_speech.len() > timing.pre_speech_samples {
                        pre_speech.pop_front();
                    }
                }
            }

            if liveness.should_emit_periodic(sr) {
                let state = if in_speech && silence_samples > 0 {
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
                    silence_samples,
                    None,
                    &config,
                    now_ms(),
                );
            }
        }
    };

    if in_speech && !buffer.is_empty() {
        let remaining: Vec<f32> = buffer.drain(..).collect();
        let remaining = apply_noise_gate(&remaining, config.noise_gate_threshold);
        let (rms, peak) = calculate_audio_metrics(&remaining);
        let is_speech = rms > config.sensitivity_rms || peak > config.peak_threshold;
        if is_speech {
            speech_evidence_samples = speech_evidence_samples.saturating_add(remaining.len());
            silence_samples = 0;
        } else {
            silence_samples = silence_samples.saturating_add(remaining.len());
        }
        speech_buffer.extend_from_slice(&remaining);
    }

    let tail_candidate_segment_sequence = in_speech.then_some(segment_sequence + 1);
    let tail_candidate_duration_ms = samples_to_ms(speech_evidence_samples as u64, sr);
    let mut tail_flush_disposition = NativeTailFlushDisposition::NoQualifyingCandidate;
    let mut tail_flush_emitted_segment_sequence = None;
    let mut no_qualifying_candidate_reason = if !in_speech {
        Some("no-active-candidate")
    } else if speech_evidence_samples < timing.minimum_speech_samples {
        Some("below-minimum-speech")
    } else if speech_buffer.is_empty() {
        Some("empty-candidate")
    } else {
        None
    };

    if should_emit_tail_segment(
        in_speech,
        speech_evidence_samples,
        speech_buffer.len(),
        &timing,
    ) {
        trim_trailing_silence(
            &mut speech_buffer,
            silence_samples,
            timing.trailing_silence_keep_samples,
        );
        let emitted_at_ms = now_ms();
        let sample_end = segment_start_sample.saturating_add(speech_buffer.len() as u64);
        let boundary = NativeSegmentBoundary {
            sample_start: segment_start_sample,
            sample_end,
            speech_started_at_ms: sample_offset_to_wall_ms(
                capture_started_at_ms,
                segment_start_sample,
                sr,
            ),
            speech_ended_at_ms: sample_offset_to_wall_ms(capture_started_at_ms, sample_end, sr),
            segment_emitted_at_ms: emitted_at_ms,
            end_reason: tail_end_reason,
            rollover_family_id,
            overlap_sample_count: segment_overlap_sample_count as u64,
            silence_target_samples: timing.silence_samples as u64,
            minimum_speech_samples: timing.minimum_speech_samples as u64,
            pre_speech_samples: timing.pre_speech_samples as u64,
            maximum_segment_samples: timing.maximum_segment_samples as u64,
        };
        match encode_and_emit_speech_segment(
            &app,
            &capture_session_id,
            &mut segment_sequence,
            sr,
            &speech_buffer,
            capture_owner,
            capture_generation,
            boundary,
        ) {
            Ok(emitted_sequence) => {
                tail_flush_disposition = NativeTailFlushDisposition::SegmentEmitted;
                tail_flush_emitted_segment_sequence = Some(emitted_sequence);
                no_qualifying_candidate_reason = None;
                liveness.mark_segment_emitted(emitted_at_ms);
                emit_vad_liveness(
                    &app,
                    &mut liveness,
                    &capture_session_id,
                    capture_generation,
                    capture_owner,
                    sr,
                    "segment-emitted",
                    tail_end_reason.as_str(),
                    Some(emitted_sequence),
                    silence_samples,
                    None,
                    &config,
                    emitted_at_ms,
                );
            }
            Err(error) => {
                tail_flush_disposition = NativeTailFlushDisposition::EncodingFailed;
                no_qualifying_candidate_reason = None;
                emit_segment_dropped(
                    &app,
                    capture_owner,
                    &capture_session_id,
                    capture_generation,
                    segment_sequence + 1,
                    "tail-drain-wav-encoding-failed",
                    &error,
                );
            }
        }
    } else if in_speech {
        liveness.mark_candidate_discarded();
        emit_vad_liveness(
            &app,
            &mut liveness,
            &capture_session_id,
            capture_generation,
            capture_owner,
            sr,
            "idle",
            "tail-discarded",
            Some(segment_sequence + 1),
            silence_samples,
            Some("below-minimum-speech-tail"),
            &config,
            now_ms(),
        );
    }

    if tail_end_reason == NativeSegmentEndReason::TerminationDrain {
        outcome.acknowledge_native_tail_flush(
            tail_flush_disposition,
            tail_candidate_segment_sequence,
            tail_candidate_duration_ms,
            tail_flush_emitted_segment_sequence,
            no_qualifying_candidate_reason,
            now_ms(),
        );
    }

    outcome
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
    capture_stop_requested: Arc<AtomicBool>,
    capture_termination_requested: Arc<AtomicBool>,
    capture_termination_request: Arc<Mutex<Option<NativeCaptureTerminationRequest>>>,
) -> CaptureRunOutcome {
    let mut stream = stream;
    let capture_started_at_ms = now_ms();
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

    // Accumulate audio - check stop flag on EVERY sample for immediate response
    let mut outcome = CaptureRunOutcome::expected(CaptureTerminationReason::RequestedStop);
    let mut termination_requested_for_capture = false;
    loop {
        if let Some(requested_outcome) = take_capture_termination_request(
            &capture_termination_requested,
            &capture_termination_request,
            capture_owner,
            &capture_session_id,
            capture_generation,
        ) {
            outcome = requested_outcome;
            termination_requested_for_capture = true;
            break;
        }
        // Check stop flag FIRST on every iteration for immediate stopping
        if capture_stop_requested.load(Ordering::Acquire) {
            break;
        }

        tokio::select! {
            sample_opt = stream.next() => {
                match sample_opt {
                    Some(sample) => {
                        if capture_stop_requested.load(Ordering::Acquire) {
                            break;
                        }

                        if let Some(tap) = evaluation_tap.as_mut() {
                            tap.push_sample(sample);
                        }
                        audio_buffer.push(sample);

                        let elapsed = start_time.elapsed();

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

    // Process and emit audio
    let mut termination_emitted_segment_sequence = None;
    let mut termination_flush_disposition = NativeTailFlushDisposition::NoQualifyingCandidate;
    let mut termination_no_candidate_reason = Some("empty-continuous-buffer");
    if !audio_buffer.is_empty() {
        let raw_ready_at_ms = now_ms();
        let encode_started = Instant::now();
        // let duration = start_time.elapsed().as_secs_f32();

        // Apply noise gate
        let cleaned_audio = apply_noise_gate(&audio_buffer, config.noise_gate_threshold);
        let cleaned_audio = normalize_audio_level(&cleaned_audio, 0.1);

        match samples_to_wav_b64(sr, &cleaned_audio) {
            Ok(b64) => {
                let emitted_at_ms = now_ms();
                let sample_end = cleaned_audio.len() as u64;
                emit_speech_detected(
                    &app,
                    &capture_session_id,
                    &mut segment_sequence,
                    sr,
                    b64,
                    capture_owner,
                    capture_generation,
                    NativeSegmentBoundary {
                        sample_start: 0,
                        sample_end,
                        speech_started_at_ms: capture_started_at_ms,
                        speech_ended_at_ms: sample_offset_to_wall_ms(
                            capture_started_at_ms,
                            sample_end,
                            sr,
                        ),
                        segment_emitted_at_ms: emitted_at_ms,
                        end_reason: NativeSegmentEndReason::ContinuousStop,
                        rollover_family_id: None,
                        overlap_sample_count: 0,
                        silence_target_samples: 0,
                        minimum_speech_samples: 0,
                        pre_speech_samples: 0,
                        maximum_segment_samples: max_samples as u64,
                    },
                    NativeAudioDeliveryTiming {
                        raw_ready_at_ms,
                        encode_started_at_ms: raw_ready_at_ms,
                        encoded_at_ms: now_ms(),
                        encode_duration_micros: encode_started.elapsed().as_micros() as u64,
                        emit_started_at_ms: 0,
                    },
                );
                termination_emitted_segment_sequence = Some(segment_sequence);
                termination_flush_disposition = NativeTailFlushDisposition::SegmentEmitted;
                termination_no_candidate_reason = None;
            }
            Err(e) => {
                termination_flush_disposition = NativeTailFlushDisposition::EncodingFailed;
                termination_no_candidate_reason = None;
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
            }
        }
    } else {
        warn!("No audio captured in continuous mode");
    }

    if termination_requested_for_capture {
        outcome.acknowledge_native_tail_flush(
            termination_flush_disposition,
            (!audio_buffer.is_empty()).then_some(1),
            samples_to_ms(audio_buffer.len() as u64, sr),
            termination_emitted_segment_sequence,
            termination_no_candidate_reason,
            now_ms(),
        );
    }

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
    boundary: NativeSegmentBoundary,
    mut timing: NativeAudioDeliveryTiming,
) -> u64 {
    *segment_sequence += 1;
    let duration_samples = boundary.sample_end.saturating_sub(boundary.sample_start);
    timing.emit_started_at_ms = now_ms();
    let event = NativeSpeechDetectedEvent {
        capture_session_id: capture_session_id.to_string(),
        capture_generation,
        segment_sequence: *segment_sequence,
        owner: capture_owner.as_str(),
        captured_at_ms: boundary.segment_emitted_at_ms,
        speech_started_at_ms: boundary.speech_started_at_ms,
        speech_ended_at_ms: boundary.speech_ended_at_ms,
        segment_emitted_at_ms: boundary.segment_emitted_at_ms,
        sample_start: boundary.sample_start,
        sample_end: boundary.sample_end,
        sample_rate,
        duration_ms: samples_to_ms(duration_samples, sample_rate),
        end_reason: boundary.end_reason.as_str(),
        rollover_family_id: boundary.rollover_family_id,
        overlap_sample_count: boundary.overlap_sample_count,
        overlap_duration_ms: samples_to_ms(boundary.overlap_sample_count, sample_rate),
        vad_silence_target_samples: boundary.silence_target_samples,
        vad_minimum_speech_samples: boundary.minimum_speech_samples,
        vad_pre_speech_samples: boundary.pre_speech_samples,
        vad_maximum_segment_samples: boundary.maximum_segment_samples,
        media_type: "audio/wav",
        audio_base64,
        delivery_timing: Some(timing.clone()),
    };
    let emit_started = Instant::now();
    let result = app.emit("speech-detected", event);
    let observation = serde_json::json!({
        "stage": "segment-delivery",
        "captureSessionId": capture_session_id,
        "captureGeneration": capture_generation,
        "segmentSequence": *segment_sequence,
        "owner": capture_owner.as_str(),
        "deliveryTiming": timing,
        "emitFinishedAtMs": now_ms(),
        "emitDurationMicros": emit_started.elapsed().as_micros() as u64,
        "emitSucceeded": result.is_ok(),
        "emitError": result.err().map(|error| error.to_string()),
    });
    // This compact receipt contains no PCM and follows the audio emit. Its end
    // timestamp cannot be included in the audio envelope emitted before it.
    info!("[native-audio-observation] {}", observation);
    let _ = app.emit("native-audio-observation", observation);
    *segment_sequence
}

#[allow(clippy::too_many_arguments)]
fn encode_and_emit_speech_segment(
    app: &AppHandle,
    capture_session_id: &str,
    segment_sequence: &mut u64,
    sample_rate: u32,
    samples: &[f32],
    capture_owner: NativeCaptureOwner,
    capture_generation: u64,
    boundary: NativeSegmentBoundary,
) -> Result<u64, String> {
    let encode_started_at_ms = now_ms();
    let encode_started = Instant::now();
    let normalized = normalize_audio_level(samples, 0.1);
    let audio_base64 = samples_to_wav_b64(sample_rate, &normalized)?;
    let timing = NativeAudioDeliveryTiming {
        raw_ready_at_ms: boundary.segment_emitted_at_ms,
        encode_started_at_ms,
        encoded_at_ms: now_ms(),
        encode_duration_micros: encode_started.elapsed().as_micros() as u64,
        emit_started_at_ms: 0,
    };
    Ok(emit_speech_detected(
        app,
        capture_session_id,
        segment_sequence,
        sample_rate,
        audio_base64,
        capture_owner,
        capture_generation,
        boundary,
        timing,
    ))
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
    silence_samples: usize,
    discard_reason: Option<&'static str>,
    config: &VadConfig,
    occurred_at_ms: u64,
) {
    let mut event = liveness.take_snapshot(
        capture_session_id,
        capture_generation,
        capture_owner,
        sample_rate,
        state,
        trigger,
        candidate_segment_sequence,
        silence_samples,
        discard_reason,
        config,
        occurred_at_ms,
    );
    let diagnostics = app.state::<NativeStallDiagnostics>();
    event.diagnostic_run_id = diagnostics.begin_event(&event);
    if event.diagnostic_run_id.is_some() {
        let delivered = app.emit("native-audio-liveness", event.clone()).is_ok();
        diagnostics.finish_event(&event, delivered);
    } else {
        let _ = app.emit("native-audio-liveness", event);
    }
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
        release_capture_if_owner(
            &mut control,
            NativeCapturePhase::Starting,
            owner,
            session_id,
            generation,
        );
    }
}

struct ReleasedActiveCapture {
    #[cfg_attr(not(debug_assertions), allow(dead_code))]
    task: Option<tokio::task::JoinHandle<()>>,
}

fn release_capture_if_owner(
    control: &mut NativeCaptureControl,
    phase: NativeCapturePhase,
    owner: NativeCaptureOwner,
    session_id: &str,
    generation: u64,
) -> Option<ReleasedActiveCapture> {
    if !control_owns(control, phase, owner, session_id, generation) {
        // Debug, not warn: this fires on every normal stop, when the capture
        // task's own release finds the capture already stopping.
        debug!(
            "Capture release rejected: expected {}/{}/{} {:?}, observed {:?} {:?}",
            owner.as_str(),
            session_id,
            generation,
            phase,
            control.lease,
            control.phase
        );
        return None;
    }
    let task = control.task.take();
    if let Some(signals) = control.signals.take() {
        signals.stop_requested.store(true, Ordering::Release);
        signals.stopped.notify_waiters();
    }
    control.metadata = None;
    control.capture_vad_config = None;
    control.phase = NativeCapturePhase::Idle;
    control.lease = None;
    Some(ReleasedActiveCapture { task })
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
    Ok(release_capture_if_owner(
        &mut control,
        NativeCapturePhase::Active,
        owner,
        session_id,
        generation,
    ))
}

fn finish_capture_if_owner(
    app: &AppHandle,
    owner: NativeCaptureOwner,
    session_id: &str,
    generation: u64,
    sample_rate: u32,
    outcome: CaptureRunOutcome,
) {
    app.state::<NativeStallDiagnostics>()
        .clear_capture(session_id, generation);
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
    let (disposition, stopped_lease) = stop_capture_for_owner(
        &state,
        requested_owner,
        expected_session_id.as_deref(),
        expected_generation,
    )
    .await?;
    if let Some(lease) = stopped_lease {
        app.state::<NativeStallDiagnostics>()
            .clear_capture(&lease.session_id, lease.generation);
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
    Ok(disposition)
}

async fn stop_capture_for_owner(
    state: &crate::AudioState,
    requested_owner: NativeCaptureOwner,
    expected_session_id: Option<&str>,
    expected_generation: Option<u64>,
) -> Result<(NativeStopDisposition, Option<NativeCaptureLease>), String> {
    let (lease, task, duplicate_stop) = {
        let mut control = state
            .capture_control
            .lock()
            .map_err(|e| format!("Failed to acquire capture control: {}", e))?;
        let already_stopping = control.phase == NativeCapturePhase::Stopping;
        let lease = match begin_capture_stop(
            &mut control,
            requested_owner,
            expected_session_id,
            expected_generation,
        ) {
            NativeStopDecision::NotRunning => {
                return Ok((NativeStopDisposition::AlreadyIdle, None))
            }
            NativeStopDecision::WrongOwner(owner) => {
                // Debug, not warn: a stop request for another owner is refused
                // by design, and its caller receives the disposition.
                debug!(
                    "Ignoring {} stop request because capture is owned by {}",
                    requested_owner.as_str(),
                    owner.as_str()
                );
                return Ok((NativeStopDisposition::OwnerMismatch, None));
            }
            NativeStopDecision::StaleLease(active_lease) => {
                // Debug, not warn: a stop request for a lease native no longer
                // holds is refused by design, and its caller receives the
                // disposition.
                debug!(
                    "Ignoring stale {} stop request for session {:?} generation {:?}; active session is {} generation {}",
                    requested_owner.as_str(),
                    expected_session_id,
                    expected_generation,
                    active_lease.session_id,
                    active_lease.generation
                );
                return Ok((NativeStopDisposition::StaleRequest, None));
            }
            NativeStopDecision::Acquired(lease) => lease,
        };
        let signals = control.signals.as_ref().expect("owned capture has signals");
        signals.stop_requested.store(true, Ordering::Release);
        // Register before releasing the lock so a concurrent stop cannot miss completion.
        let duplicate_stop = already_stopping.then(|| {
            let mut notified = Box::pin(signals.stopped.clone().notified_owned());
            notified.as_mut().enable();
            notified
        });
        let task = if already_stopping {
            None
        } else {
            control.task.take()
        };
        (lease, task, duplicate_stop)
    };

    if let Some(completed) = duplicate_stop {
        completed.await;
        return Ok((NativeStopDisposition::AlreadyIdle, None));
    }
    if let Some(mut task) = task {
        if tokio::time::timeout(
            tokio::time::Duration::from_millis(GRACEFUL_CAPTURE_STOP_TIMEOUT_MS),
            &mut task,
        )
        .await
        .is_err()
        {
            warn!(
                "Capture {} generation {} did not drain within {}ms; aborting",
                lease.session_id, lease.generation, GRACEFUL_CAPTURE_STOP_TIMEOUT_MS
            );
            task.abort();
            let _ = task.await;
        }
    }

    let stopped = {
        let mut control = state
            .capture_control
            .lock()
            .map_err(|e| format!("Failed to acquire capture control: {}", e))?;
        release_capture_if_owner(
            &mut control,
            NativeCapturePhase::Stopping,
            lease.owner,
            &lease.session_id,
            lease.generation,
        )
        .is_some()
    };

    Ok(if stopped {
        (NativeStopDisposition::Stopped, Some(lease))
    } else {
        (NativeStopDisposition::StaleRequest, None)
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
    let requested_at_ms = now_ms();
    let disposition = {
        let control = state
            .capture_control
            .lock()
            .map_err(|error| format!("Failed to acquire capture control: {}", error))?;
        request_debug_audio_fault(
            &control,
            owner,
            expected_session_id,
            expected_capture_generation,
            fault_kind
                .outcome(injection_id)
                .with_native_tail_flush_request(injection_id.to_string(), requested_at_ms),
        )?
    };

    if disposition == DebugAudioFaultDisposition::Injected {
        let deadline = Instant::now() + Duration::from_millis(GRACEFUL_CAPTURE_STOP_TIMEOUT_MS);
        let mut completed = false;
        while Instant::now() < deadline {
            let still_active = {
                let control = state
                    .capture_control
                    .lock()
                    .map_err(|error| format!("Failed to acquire capture control: {}", error))?;
                control_owns(
                    &control,
                    NativeCapturePhase::Active,
                    owner,
                    expected_session_id,
                    expected_capture_generation,
                )
            };
            if !still_active {
                completed = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        if !completed {
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
                let mut outcome = fault_kind
                    .outcome(injection_id)
                    .with_native_tail_flush_request(injection_id.to_string(), requested_at_ms);
                outcome.acknowledge_native_tail_flush(
                    NativeTailFlushDisposition::TimedOut,
                    None,
                    0,
                    None,
                    Some("native-tail-flush-timeout"),
                    now_ms(),
                );
                let _ = app.emit("capture-stopped", ());
                emit_capture_lifecycle(
                    &app,
                    "error",
                    owner,
                    expected_session_id,
                    expected_capture_generation,
                    Some(outcome.reason.as_str()),
                    Some("Debug fault injection timed out while flushing native audio."),
                    previous_status.sample_rate,
                    outcome.expected,
                    outcome.recoverability,
                    outcome.diagnostics,
                );
            }
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
    capture_status_snapshot(&state)
}

fn capture_status_snapshot(state: &crate::AudioState) -> Result<MeetingAudioStatus, String> {
    let control = state
        .capture_control
        .lock()
        .map_err(|error| format!("Failed to get capture control: {}", error))?;
    let system_capture_active = control.phase != NativeCapturePhase::Idle;
    let capture_owner = control
        .lease
        .as_ref()
        .map(|lease| lease.owner.as_str().to_string());
    let capture_session_id = control.lease.as_ref().map(|lease| lease.session_id.clone());
    let capture_generation = control.lease.as_ref().map(|lease| lease.generation);
    let device_id = control
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.device_id.clone());
    let sample_rate = control
        .metadata
        .as_ref()
        .map(|metadata| metadata.sample_rate);
    let started_at_ms = control
        .metadata
        .as_ref()
        .map(|metadata| metadata.started_at_ms);
    let vad_enabled = control
        .capture_vad_config
        .as_ref()
        .unwrap_or(&control.vad_config)
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

fn validate_vad_config(config: &VadConfig) -> Result<(), String> {
    if config.sensitivity_rms < 0.0 || config.sensitivity_rms > 1.0 {
        return Err("Invalid sensitivity_rms: must be 0.0-1.0".to_string());
    }
    if config.max_recording_duration_secs > 3600 {
        return Err("Invalid max_recording_duration_secs: must be <= 3600 (1 hour)".to_string());
    }
    if config.hop_size == 0 || config.hop_size > 16_384 {
        return Err("Invalid hop_size: must be 1-16384".to_string());
    }
    if !(100..=10_000).contains(&config.silence_duration_ms) {
        return Err("Invalid silence_duration_ms: must be 100-10000".to_string());
    }
    if !(50..=5_000).contains(&config.minimum_speech_duration_ms) {
        return Err("Invalid minimum_speech_duration_ms: must be 50-5000".to_string());
    }
    if config.pre_speech_duration_ms > 5_000 {
        return Err("Invalid pre_speech_duration_ms: must be <= 5000".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn get_output_devices() -> Result<Vec<AudioDevice>, String> {
    crate::speaker::list_output_devices().map_err(|e| {
        error!("Failed to get output devices: {}", e);
        format!("Failed to get output devices: {}", e)
    })
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

fn ms_to_samples_ceil(duration_ms: u64, sample_rate: u32) -> usize {
    if duration_ms == 0 || sample_rate == 0 {
        return 0;
    }
    let samples = duration_ms
        .saturating_mul(sample_rate as u64)
        .saturating_add(999)
        / 1_000;
    usize::try_from(samples).unwrap_or(usize::MAX)
}

fn sample_offset_to_wall_ms(
    capture_started_at_ms: u64,
    sample_offset: u64,
    sample_rate: u32,
) -> u64 {
    capture_started_at_ms.saturating_add(samples_to_ms(sample_offset, sample_rate))
}

fn should_emit_tail_segment(
    in_speech: bool,
    speech_evidence_samples: usize,
    buffered_samples: usize,
    timing: &ResolvedVadTiming,
) -> bool {
    in_speech && speech_evidence_samples >= timing.minimum_speech_samples && buffered_samples > 0
}

fn trim_trailing_silence(
    samples: &mut Vec<f32>,
    trailing_silence_samples: usize,
    keep_silence_samples: usize,
) {
    let trim_amount = trailing_silence_samples.saturating_sub(keep_silence_samples);
    if trim_amount == 0 {
        return;
    }
    samples.truncate(samples.len().saturating_sub(trim_amount));
}

#[cfg(test)]
#[path = "native_capture_control_tests.rs"]
mod native_capture_control_tests;

#[cfg(test)]
mod tests {
    use super::{
        apply_noise_gate, begin_capture_stop, claim_capture_lease, control_owns,
        decide_debug_audio_fault, discard_timed_out_start, release_active_capture_if_owner,
        samples_to_ms, should_emit_tail_segment, take_capture_termination_request,
        CaptureRecoverability, CaptureRunOutcome, CaptureTerminationDiagnostics,
        CaptureTerminationReason, DebugAudioFaultDisposition, DebugAudioFaultKind,
        NativeAudioLifecycleEvent, NativeAudioSegmentDroppedEvent, NativeCaptureControl,
        NativeCaptureOwner, NativeCapturePhase, NativeCaptureTerminationRequest,
        NativeSegmentEndReason, NativeSpeechDetectedEvent, NativeSpeechStartEvent,
        NativeStopDecision, NativeTailFlushDisposition, ResolvedVadTiming,
        SpeakerStreamTermination, SpeakerStreamTerminationReason, VadConfig,
        VadLivenessAccumulator,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    struct DropThreadProbe(std::sync::mpsc::Sender<std::thread::ThreadId>);

    impl Drop for DropThreadProbe {
        fn drop(&mut self) {
            let _ = self.0.send(std::thread::current().id());
        }
    }

    #[test]
    fn timed_out_start_discards_queued_or_late_results_off_foreground() {
        let foreground = std::thread::current().id();
        let (drop_tx, drop_rx) = std::sync::mpsc::channel();
        let (sender, mut receiver) = tokio::sync::oneshot::channel();
        assert!(sender.send(DropThreadProbe(drop_tx)).is_ok());
        discard_timed_out_start(&mut receiver);
        assert_ne!(
            drop_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap(),
            foreground
        );

        let (drop_tx, drop_rx) = std::sync::mpsc::channel();
        let (sender, mut receiver) = tokio::sync::oneshot::channel();
        discard_timed_out_start(&mut receiver);
        let worker = std::thread::spawn(move || {
            if let Err(result) = sender.send(DropThreadProbe(drop_tx)) {
                drop(result);
            }
            std::thread::current().id()
        });
        assert_eq!(
            drop_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap(),
            worker.join().unwrap()
        );
    }

    #[tokio::test]
    async fn task128_meeting_config_and_shared_stop_survive_wrapper_retirement() {
        let state = crate::AudioState::default();
        for enabled in [true, false] {
            let config = VadConfig {
                enabled,
                silence_duration_ms: 900,
                ..VadConfig::default()
            };
            let (lease, signals, reserved_config) = super::reserve_capture(
                &state,
                NativeCaptureOwner::Meeting,
                format!("task128-{enabled}"),
                Some(config),
            )
            .unwrap();
            assert_eq!(reserved_config.enabled, enabled);
            assert_eq!(reserved_config.silence_duration_ms, 900);
            let status = super::capture_status_snapshot(&state).unwrap();
            assert!(status.active && status.system_capture_active);
            assert_eq!(status.capture_owner.as_deref(), Some("meeting"));
            assert_eq!(status.vad_enabled, enabled);
            let (mismatch, _) = super::stop_capture_for_owner(
                &state,
                NativeCaptureOwner::System,
                Some(&lease.session_id),
                Some(lease.generation),
            )
            .await
            .unwrap();
            assert_eq!(mismatch, super::NativeStopDisposition::OwnerMismatch);
            assert!(!signals.stop_requested.load(Ordering::Acquire));
            let (stopped, _) = super::stop_capture_for_owner(
                &state,
                NativeCaptureOwner::Meeting,
                Some(&lease.session_id),
                Some(lease.generation),
            )
            .await
            .unwrap();
            assert_eq!(stopped, super::NativeStopDisposition::Stopped);
            assert!(signals.stop_requested.load(Ordering::Acquire));
            assert!(!super::capture_status_snapshot(&state).unwrap().active);
            super::clear_start_in_flight(&mut state.capture_control.lock().unwrap(), &lease);
        }
    }

    #[test]
    fn serializes_native_speech_event_for_typescript_consumers() {
        let event = NativeSpeechDetectedEvent {
            capture_session_id: "capture-test".to_string(),
            capture_generation: 3,
            segment_sequence: 7,
            owner: "system",
            captured_at_ms: 1234,
            speech_started_at_ms: 1_000,
            speech_ended_at_ms: 1_200,
            segment_emitted_at_ms: 1_234,
            sample_start: 48_000,
            sample_end: 57_600,
            sample_rate: 48_000,
            duration_ms: 200,
            end_reason: NativeSegmentEndReason::ForcedRollover.as_str(),
            rollover_family_id: Some("rollover-test".to_string()),
            overlap_sample_count: 19_200,
            overlap_duration_ms: 400,
            vad_silence_target_samples: 50_160,
            vad_minimum_speech_samples: 7_824,
            vad_pre_speech_samples: 13_392,
            vad_maximum_segment_samples: 1_440_000,
            media_type: "audio/wav",
            audio_base64: "UklGRg==".to_string(),
            delivery_timing: None,
        };

        let value = serde_json::to_value(event).expect("event should serialize");
        assert_eq!(value["captureSessionId"], "capture-test");
        assert_eq!(value["captureGeneration"], 3);
        assert_eq!(value["segmentSequence"], 7);
        assert_eq!(value["owner"], "system");
        assert_eq!(value["capturedAtMs"], 1234);
        assert_eq!(value["speechStartedAtMs"], 1_000);
        assert_eq!(value["speechEndedAtMs"], 1_200);
        assert_eq!(value["sampleStart"], 48_000);
        assert_eq!(value["sampleEnd"], 57_600);
        assert_eq!(value["sampleRate"], 48_000);
        assert_eq!(value["durationMs"], 200);
        assert_eq!(value["endReason"], "forced-rollover");
        assert_eq!(value["rolloverFamilyId"], "rollover-test");
        assert_eq!(value["overlapDurationMs"], 400);
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
    fn raw_zero_observation_is_before_noise_gate_and_tracks_exact_zero_only() {
        let mut liveness = VadLivenessAccumulator::default();
        let quiet = vec![0.000_001; 48_000];
        assert!(apply_noise_gate(&quiet, 0.003)
            .iter()
            .all(|v| *v < quiet[0]));
        liveness.observe_raw_chunk(&quiet, 1_000);
        assert_eq!(liveness.raw_signal_chunk_count, 1);
        let zeros = vec![0.0; 48_000];
        for _ in 0..90 {
            liveness.observe_raw_chunk(&zeros, 91_000);
        }
        assert_eq!(
            samples_to_ms(liveness.raw_zero_sample_count, 48_000),
            90_000
        );
        liveness.observe_raw_chunk(&quiet, 92_000);
        assert_eq!(liveness.raw_zero_sample_count, 0);
        assert_eq!(liveness.last_raw_signal_observed_at_ms, Some(92_000));
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
        assert_eq!(value["schemaVersion"], 2);
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
    fn vad_timing_preserves_millisecond_semantics_across_sample_rates() {
        let config = VadConfig::default();
        let at_48k = ResolvedVadTiming::resolve(&config, 48_000);
        let at_44k = ResolvedVadTiming::resolve(&config, 44_100);

        assert_eq!(at_48k.silence_samples, 50_160);
        assert_eq!(at_44k.silence_samples, 46_085);
        assert_eq!(at_48k.minimum_speech_samples, 7_824);
        assert_eq!(at_44k.minimum_speech_samples, 7_189);
        assert_eq!(at_48k.rollover_overlap_samples, 19_200);
        assert_eq!(at_44k.rollover_overlap_samples, 17_640);
    }

    #[test]
    fn tail_drain_requires_a_real_speech_candidate() {
        let timing = ResolvedVadTiming::resolve(&VadConfig::default(), 48_000);

        assert!(!should_emit_tail_segment(
            false,
            timing.minimum_speech_samples,
            timing.minimum_speech_samples,
            &timing,
        ));
        assert!(!should_emit_tail_segment(
            true,
            timing.minimum_speech_samples - 1,
            timing.minimum_speech_samples,
            &timing,
        ));
        assert!(!should_emit_tail_segment(
            true,
            timing.minimum_speech_samples,
            0,
            &timing,
        ));
        assert!(should_emit_tail_segment(
            true,
            timing.minimum_speech_samples,
            timing.minimum_speech_samples,
            &timing,
        ));
    }

    #[test]
    fn native_termination_request_is_consumed_only_by_its_capture_lease() {
        let requested = AtomicBool::new(true);
        let request = Mutex::new(Some(NativeCaptureTerminationRequest {
            owner: NativeCaptureOwner::Meeting,
            capture_session_id: "capture-test".to_string(),
            capture_generation: 3,
            outcome: CaptureRunOutcome::panic()
                .with_native_tail_flush_request("fault-1".to_string(), 1_000),
        }));

        assert!(take_capture_termination_request(
            &requested,
            &request,
            NativeCaptureOwner::Meeting,
            "capture-other",
            3,
        )
        .is_none());
        assert!(requested.load(Ordering::Acquire));

        let outcome = take_capture_termination_request(
            &requested,
            &request,
            NativeCaptureOwner::Meeting,
            "capture-test",
            3,
        )
        .expect("matching capture should consume the request");
        assert_eq!(
            outcome
                .diagnostics
                .native_tail_flush_operation_id
                .as_deref(),
            Some("fault-1")
        );
        assert!(!requested.load(Ordering::Acquire));
        assert!(request.lock().expect("request lock").is_none());
    }

    #[test]
    fn native_tail_flush_acknowledgement_serializes_without_audio() {
        let mut outcome =
            CaptureRunOutcome::panic().with_native_tail_flush_request("fault-1".to_string(), 1_000);
        outcome.acknowledge_native_tail_flush(
            NativeTailFlushDisposition::SegmentEmitted,
            Some(8),
            420,
            Some(8),
            None,
            1_025,
        );

        let value =
            serde_json::to_value(outcome.diagnostics).expect("diagnostics should serialize");
        assert_eq!(value["nativeTailFlushOperationId"], "fault-1");
        assert_eq!(value["nativeTailFlushRequestedAtMs"], 1_000);
        assert_eq!(value["nativeTailFlushAcknowledgedAtMs"], 1_025);
        assert_eq!(value["nativeTailFlushDurationMs"], 25);
        assert_eq!(value["nativeTailFlushDisposition"], "segment-emitted");
        assert_eq!(value["nativeTailFlushCandidateSegmentSequence"], 8);
        assert_eq!(value["nativeTailFlushCandidateDurationMs"], 420);
        assert_eq!(value["nativeTailFlushEmittedSegmentSequence"], 8);
        assert!(value.get("audioBase64").is_none());
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
        super::clear_start_in_flight(&mut control, &first);
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
        super::clear_start_in_flight(&mut control, &old);
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
