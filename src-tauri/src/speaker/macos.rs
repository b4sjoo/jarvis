// Jarvis macos speaker input and stream
use super::audio_block::{
    audio_block_queue, AudioBlock, AudioBlockConsumer, AudioBlockMetadata, AudioBlockProducer,
    SourceAudioTime,
};
use super::{AudioDevice, SpeakerStreamTermination, SpeakerStreamTerminationReason};
use crate::native_stall_diagnostics::CaptureCallbackCounters;
use anyhow::Result;
use ca::aggregate_device_keys as agg_keys;
use cidre::{arc, av, cat, cf, core_audio as ca, mach, ns, os};
use futures_util::Stream;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Poll, Waker};
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::error;

const CAPTURE_BUFFER_SIZE: usize = 1024 * 128;
const TERMINATION_NONE: u8 = 0;
const TERMINATION_BUFFER_OVERFLOW: u8 = 1;
const TERMINATION_INVALID_FORMAT: u8 = 2;

pub fn get_output_devices() -> Result<Vec<AudioDevice>> {
    let mut devices = Vec::new();

    let default_output_uid = ca::System::default_output_device()
        .ok()
        .and_then(|d| d.uid().ok())
        .map(|u| u.to_string());

    let all_devices = ca::System::devices()?;

    for device in all_devices.iter() {
        let output_buffers = device
            .output_stream_cfg()
            .map(|cfg| cfg.number_buffers())
            .unwrap_or(0);

        let input_buffers = device
            .input_stream_cfg()
            .map(|cfg| cfg.number_buffers())
            .unwrap_or(0);

        if output_buffers > 0 {
            let is_primarily_input = input_buffers > 0 && output_buffers == 0;
            if !is_primarily_input {
                let name = device
                    .name()
                    .map(|n| n.to_string())
                    .unwrap_or_else(|_| "Unknown Device".to_string());
                let uid = device
                    .uid()
                    .map(|u| u.to_string())
                    .unwrap_or_else(|_| format!("macos_output_unknown"));
                let is_default = default_output_uid
                    .as_ref()
                    .map(|def| def == &uid)
                    .unwrap_or(false);

                devices.push(AudioDevice {
                    id: uid,
                    name,
                    is_default,
                });
            }
        }
    }

    Ok(devices)
}

fn find_output_device_by_uid(uid: &str) -> Option<ca::Device> {
    let all_devices = match ca::System::devices() {
        Ok(d) => d,
        Err(e) => {
            error!(
                "[find_output_device_by_uid] Failed to get system devices: {}",
                e
            );
            return None;
        }
    };

    for device in all_devices.into_iter() {
        if let Ok(cfg) = device.output_stream_cfg() {
            if cfg.number_buffers() > 0 {
                if let Ok(device_uid) = device.uid() {
                    if device_uid.to_string() == uid {
                        return Some(device);
                    }
                }
            }
        }
    }

    error!(
        "[find_output_device_by_uid] No matching device found for UID: {}",
        uid
    );
    None
}

pub struct SpeakerInput {
    output_uid: String,
    aggregate_uid: String,
    tap: ca::TapGuard, // Assuming ca::TapGuard from core-audio-rs
    agg_desc: arc::Retained<cf::DictionaryOf<cf::String, cf::Type>>,
}

struct WakerState {
    waker: Option<Waker>,
    has_data: bool,
}

pub struct SpeakerStream {
    consumer: AudioBlockConsumer,
    _device: ca::hardware::StartedDevice<ca::AggregateDevice>,
    _ctx: Box<Ctx>,
    _tap: ca::TapGuard,
    waker_state: Arc<Mutex<WakerState>>,
    callback_counters: Arc<CaptureCallbackCounters>,
}

impl SpeakerStream {
    pub(crate) fn callback_counters(&self) -> Arc<CaptureCallbackCounters> {
        self.callback_counters.clone()
    }

    pub fn termination(&self) -> SpeakerStreamTermination {
        let reason = match self._ctx.termination_code.load(Ordering::Acquire) {
            TERMINATION_BUFFER_OVERFLOW => SpeakerStreamTerminationReason::BufferOverflow,
            TERMINATION_INVALID_FORMAT => SpeakerStreamTerminationReason::InvalidAudioFormat,
            _ => SpeakerStreamTerminationReason::UnknownStreamEnd,
        };
        SpeakerStreamTermination {
            reason,
            dropped_samples: self._ctx.dropped_samples.load(Ordering::Acquire),
            consecutive_drops: self._ctx.consecutive_drops.load(Ordering::Acquire),
            buffer_capacity: Some(CAPTURE_BUFFER_SIZE),
        }
    }
}

struct Ctx {
    float_mono: bool,
    producer: AudioBlockProducer,
    waker_state: Arc<Mutex<WakerState>>,
    timebase: mach::TimeBaseInfo,
    origin_host_ns: u64,
    origin_wall_ms: u64,
    consecutive_drops: Arc<AtomicU32>,
    dropped_samples: Arc<AtomicU64>,
    termination_code: Arc<AtomicU8>,
    should_terminate: Arc<AtomicBool>,
    callback_counters: Arc<CaptureCallbackCounters>,
}

impl SpeakerInput {
    pub fn new(device_id: Option<String>) -> Result<Self> {
        let output_device = match device_id {
            Some(ref uid) if !uid.is_empty() && uid != "default" => {
                match find_output_device_by_uid(uid) {
                    Some(device) => device,
                    None => {
                        ca::System::default_output_device().expect("No default output device found")
                    }
                }
            }
            _ => ca::System::default_output_device()?,
        };

        let output_uid = output_device.uid()?;

        let sub_device = cf::DictionaryOf::with_keys_values(
            &[ca::sub_device_keys::uid()],
            &[output_uid.as_type_ref()],
        );

        let tap_desc = ca::TapDesc::with_mono_global_tap_excluding_processes(&ns::Array::new());
        let tap = tap_desc.create_process_tap()?;

        let sub_tap = cf::DictionaryOf::with_keys_values(
            &[ca::sub_device_keys::uid()],
            &[tap.uid().unwrap().as_type_ref()],
        );

        let aggregate_uid = cf::Uuid::new().to_cf_string();
        let agg_desc = cf::DictionaryOf::with_keys_values(
            &[
                agg_keys::is_private(),
                agg_keys::is_stacked(),
                agg_keys::tap_auto_start(),
                agg_keys::name(),
                agg_keys::main_sub_device(),
                agg_keys::uid(),
                agg_keys::sub_device_list(),
                agg_keys::tap_list(),
            ],
            &[
                cf::Boolean::value_true().as_type_ref(),
                cf::Boolean::value_false(),
                cf::Boolean::value_true(),
                cf::str!(c"system-audio-tap"), // Simplified name
                &output_uid,
                &aggregate_uid,
                &cf::ArrayOf::from_slice(&[sub_device.as_ref()]),
                &cf::ArrayOf::from_slice(&[sub_tap.as_ref()]),
            ],
        );

        Ok(Self {
            tap,
            agg_desc,
            output_uid: output_uid.to_string(),
            aggregate_uid: aggregate_uid.to_string(),
        })
    }

    pub(crate) fn capture_diagnostics(&self) -> serde_json::Value {
        serde_json::json!({
            "outputUid": self.output_uid,
            "aggregateUid": self.aggregate_uid,
            "tapUid": self.tap.uid().ok().map(|uid| uid.to_string()),
            "audioFormat": self.tap.asbd().ok().map(|format| format!("{:?}", format)),
        })
    }

    fn start_device(
        &self,
        ctx: &mut Box<Ctx>,
    ) -> Result<ca::hardware::StartedDevice<ca::AggregateDevice>> {
        extern "C" fn proc(
            device: ca::Device,
            _now: &cat::AudioTimeStamp,
            input_data: &cat::AudioBufList<1>,
            input_time: &cat::AudioTimeStamp,
            _output_data: &mut cat::AudioBufList<1>,
            _output_time: &cat::AudioTimeStamp,
            ctx: Option<&mut Ctx>,
        ) -> os::Status {
            let ctx = ctx.unwrap();

            ctx.callback_counters.observe_entry();
            if ctx.should_terminate.load(Ordering::Acquire) {
                return os::Status::NO_ERR;
            }
            if input_data.number_buffers == 0 || input_data.buffers[0].data_bytes_size == 0 {
                ctx.callback_counters.observe_empty();
                return os::Status::NO_ERR;
            }
            let buffer = &input_data.buffers[0];
            let rate = device.actual_sample_rate().ok();
            let valid_rate = rate.filter(|r| r.is_finite() && (8000.0..=96000.0).contains(r));
            if !ctx.float_mono
                || input_data.number_buffers != 1
                || buffer.number_channels != 1
                || buffer.data.is_null()
                || buffer.data_bytes_size % 4 != 0
                || input_time.flags.0 & 3 != 3
                || input_time.host_time == 0
                || !input_time.sample_time.is_finite()
                || valid_rate.is_none()
            {
                ctx.termination_code
                    .store(TERMINATION_INVALID_FORMAT, Ordering::Release);
                ctx.should_terminate.store(true, Ordering::Release);
                wake_consumer(ctx);
                return os::Status::NO_ERR;
            }
            let host_time_ns = ((input_time.host_time as u128 * ctx.timebase.numer as u128)
                / ctx.timebase.denom as u128) as u64;
            let captured_at_ms = (ctx.origin_wall_ms as i128
                + (host_time_ns as i128 - ctx.origin_host_ns as i128) / 1_000_000)
                .max(0) as u64;
            let frames = buffer.data_bytes_size as usize / std::mem::size_of::<f32>();
            let data = unsafe { std::slice::from_raw_parts(buffer.data as *const f32, frames) };
            ctx.callback_counters.observe_frames(frames);
            process_audio_data(
                ctx,
                data,
                AudioBlockMetadata {
                    sample_rate: valid_rate.unwrap().round() as u32,
                    frames,
                    source_time: Some(SourceAudioTime {
                        sample_time: input_time.sample_time,
                        host_time_ns,
                        captured_at_ms,
                    }),
                },
            );

            os::Status::NO_ERR
        }

        let agg_device = ca::AggregateDevice::with_desc(&self.agg_desc)?;
        let proc_id = agg_device.create_io_proc_id(proc, Some(ctx))?;
        let started_device = ca::device_start(agg_device, Some(proc_id))?;

        Ok(started_device)
    }

    pub fn stream(self) -> SpeakerStream {
        let asbd = self.tap.asbd().unwrap();

        let format = av::AudioFormat::with_asbd(&asbd).unwrap();

        let (producer, consumer) = audio_block_queue(CAPTURE_BUFFER_SIZE, 1024);

        let waker_state = Arc::new(Mutex::new(WakerState {
            waker: None,
            has_data: false,
        }));

        let callback_counters = Arc::new(CaptureCallbackCounters::new());
        let timebase = mach::TimeBaseInfo::new();
        assert!(timebase.denom > 0 && timebase.numer > 0);
        let origin_host_ns =
            ((mach::abs_time() as u128 * timebase.numer as u128) / timebase.denom as u128) as u64;
        let origin_wall_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        let mut ctx = Box::new(Ctx {
            float_mono: format.common_format() == av::audio::CommonFormat::PcmF32
                && asbd.channels_per_frame == 1,
            producer,
            waker_state: waker_state.clone(),
            timebase,
            origin_host_ns,
            origin_wall_ms,
            consecutive_drops: Arc::new(AtomicU32::new(0)),
            dropped_samples: Arc::new(AtomicU64::new(0)),
            termination_code: Arc::new(AtomicU8::new(TERMINATION_NONE)),
            should_terminate: Arc::new(AtomicBool::new(false)),
            callback_counters: callback_counters.clone(),
        });

        let device = self.start_device(&mut ctx).unwrap();

        SpeakerStream {
            consumer,
            _device: device,
            _ctx: ctx,
            _tap: self.tap,
            waker_state,
            callback_counters,
        }
    }
}

fn process_audio_data(ctx: &mut Ctx, data: &[f32], metadata: AudioBlockMetadata) {
    let buffer_size = data.len();
    let pushed = if ctx.producer.push(data, metadata) {
        buffer_size
    } else {
        0
    };

    // Consistent buffer overflow handling
    if pushed < buffer_size {
        let dropped = buffer_size - pushed;
        ctx.dropped_samples
            .fetch_add(dropped as u64, Ordering::AcqRel);
        let consecutive = ctx.consecutive_drops.fetch_add(1, Ordering::AcqRel) + 1;
        ctx.callback_counters
            .observe_drop(dropped, consecutive == 51);

        // Only terminate after many consecutive drops (prevents temporary spikes from killing stream)
        if consecutive == 25 {
            eprintln!("Warning: Audio buffer experiencing drops - system may be overloaded");
        }

        if consecutive > 50 {
            eprintln!("Critical: Audio buffer overflow - capture stopping");
            ctx.termination_code
                .store(TERMINATION_BUFFER_OVERFLOW, Ordering::Release);
            ctx.should_terminate.store(true, Ordering::Release);
            wake_consumer(ctx);
            return;
        }
    } else {
        // Success - reset consecutive drops counter
        ctx.consecutive_drops.store(0, Ordering::Release);
    }

    wake_consumer(ctx);
}

fn wake_consumer(ctx: &mut Ctx) {
    let should_wake = {
        let mut waker_state = ctx.waker_state.lock().unwrap();
        if !waker_state.has_data {
            waker_state.has_data = true;
            waker_state.waker.take()
        } else {
            None
        }
    };

    if let Some(waker) = should_wake {
        waker.wake();
    }
}

impl Stream for SpeakerStream {
    type Item = AudioBlock;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<Option<Self::Item>> {
        if let Some(sample) = self.consumer.pop() {
            return Poll::Ready(Some(sample));
        }

        if self._ctx.should_terminate.load(Ordering::Acquire) {
            return match self.consumer.pop() {
                Some(sample) => Poll::Ready(Some(sample)),
                None => Poll::Ready(None),
            };
        }

        {
            let mut state = self.waker_state.lock().unwrap();
            state.has_data = false;
            state.waker = Some(cx.waker().clone());
        }

        Poll::Pending
    }
}

impl Drop for SpeakerStream {
    fn drop(&mut self) {
        self._ctx.should_terminate.store(true, Ordering::Release);
    }
}
