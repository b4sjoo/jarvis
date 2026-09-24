use anyhow::Result;
use futures_util::Stream;
use serde::{Deserialize, Serialize};
use std::pin::Pin;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpeakerStreamTerminationReason {
    BufferOverflow,
    UnknownStreamEnd,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpeakerStreamTermination {
    pub reason: SpeakerStreamTerminationReason,
    pub dropped_samples: u64,
    pub consecutive_drops: u32,
    pub buffer_capacity: Option<usize>,
}

impl SpeakerStreamTermination {
    #[allow(dead_code)]
    pub fn unknown() -> Self {
        Self {
            reason: SpeakerStreamTerminationReason::UnknownStreamEnd,
            dropped_samples: 0,
            consecutive_drops: 0,
            buffer_capacity: None,
        }
    }
}

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos::{SpeakerInput as PlatformSpeakerInput, SpeakerStream as PlatformSpeakerStream};

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
use windows::{SpeakerInput as PlatformSpeakerInput, SpeakerStream as PlatformSpeakerStream};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux::{SpeakerInput as PlatformSpeakerInput, SpeakerStream as PlatformSpeakerStream};

mod commands;

// Re-export commands for tauri handler
pub use commands::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
pub(crate) fn list_output_devices() -> Result<Vec<AudioDevice>> {
    #[cfg(target_os = "macos")]
    return macos::get_output_devices();

    #[cfg(target_os = "windows")]
    return windows::get_output_devices();

    #[cfg(target_os = "linux")]
    return linux::get_output_devices();
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub(crate) fn list_output_devices() -> Result<Vec<AudioDevice>> {
    Ok(vec![])
}

// Jarvis speaker input and stream
pub struct SpeakerInput {
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    inner: PlatformSpeakerInput,
}

impl SpeakerInput {
    pub(crate) fn capture_diagnostics(&self) -> serde_json::Value {
        #[cfg(target_os = "macos")]
        return self.inner.capture_diagnostics();
        #[cfg(not(target_os = "macos"))]
        serde_json::Value::Null
    }

    // Creates a new speaker input. Fails on unsupported platforms.
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    pub fn new() -> Result<Self> {
        let inner = PlatformSpeakerInput::new(None)?;
        Ok(Self { inner })
    }

    // Creates a new speaker input with a specific device ID
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    pub fn new_with_device(device_id: Option<String>) -> Result<Self> {
        let inner = PlatformSpeakerInput::new(device_id)?;
        Ok(Self { inner })
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    pub fn new() -> Result<Self> {
        Err(anyhow::anyhow!(
            "SpeakerInput::new is not supported on this platform"
        ))
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    pub fn new_with_device(_device_id: Option<String>) -> Result<Self> {
        Err(anyhow::anyhow!(
            "SpeakerInput::new_with_device is not supported on this platform"
        ))
    }

    // Starts the audio stream.
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    pub fn stream(self) -> SpeakerStream {
        let inner = self.inner.stream();
        SpeakerStream { inner }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    pub fn stream(self) -> SpeakerStream {
        unimplemented!("SpeakerInput::stream is not supported on this platform")
    }
}

// Stream of f32 audio samples from the speaker.
pub struct SpeakerStream {
    inner: PlatformSpeakerStream,
}

impl Stream for SpeakerStream {
    type Item = f32;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
        {
            Pin::new(&mut self.inner).poll_next(cx)
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            std::task::Poll::Pending
        }
    }
}

impl SpeakerStream {
    #[cfg(target_os = "macos")]
    pub(crate) fn callback_counters(
        &self,
    ) -> std::sync::Arc<crate::native_stall_diagnostics::CaptureCallbackCounters> {
        self.inner.callback_counters()
    }

    // Gets the sample rate (e.g., 16000 Hz on stub, variable on real impls).
    pub fn sample_rate(&self) -> u32 {
        #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
        return self.inner.sample_rate();

        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        0
    }

    pub fn termination(&self) -> SpeakerStreamTermination {
        #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
        return self.inner.termination();

        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        SpeakerStreamTermination::unknown()
    }
}
