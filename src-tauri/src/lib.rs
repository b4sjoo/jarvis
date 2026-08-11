mod content_storage;
mod db;
mod recording;
mod speaker;

use speaker::{NativeCaptureControl, NativeCaptureTerminationRequest, VadConfig};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tokio::task::JoinHandle;

#[derive(Default)]
pub struct AudioState {
    stream_task: Arc<Mutex<Option<JoinHandle<()>>>>,
    capture_control: Arc<Mutex<NativeCaptureControl>>,
    vad_config: Arc<Mutex<VadConfig>>,
    capture_device_id: Arc<Mutex<Option<String>>>,
    sample_rate: Arc<Mutex<Option<u32>>>,
    started_at_ms: Arc<Mutex<Option<u64>>>,
    capture_stop_requested: Arc<AtomicBool>,
    capture_termination_requested: Arc<AtomicBool>,
    capture_termination_request: Arc<Mutex<Option<NativeCaptureTerminationRequest>>>,
}

#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn write_call_trace_log(message: String) {
    eprintln!("[call-trace] {message}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:moss.db", db::migrations())
                .build(),
        )
        .manage(AudioState::default())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_keychain::init())
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            write_call_trace_log,
            content_storage::import_content_file,
            recording::start_call_recording,
            recording::append_call_recording_event,
            recording::close_call_recording,
            recording::retry_call_recording_close,
            recording::abandon_call_recording,
            recording::list_recoverable_call_recordings,
            speaker::start_call_audio_session,
            speaker::stop_call_audio_session,
            #[cfg(debug_assertions)]
            speaker::debug_inject_native_audio_fault,
            speaker::get_call_audio_status,
            speaker::check_system_audio_access,
            speaker::request_system_audio_access,
            speaker::get_vad_config,
            speaker::update_vad_config,
            speaker::get_capture_status,
            speaker::get_audio_sample_rate,
            speaker::get_input_devices,
            speaker::get_output_devices,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            if let Err(error) = app
                .handle()
                .set_activation_policy(tauri::ActivationPolicy::Accessory)
            {
                eprintln!("Failed to hide MOSS from the Dock: {error}");
            }
            Ok(())
        });

    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_plugin_macos_permissions::init());
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running MOSS");
}
