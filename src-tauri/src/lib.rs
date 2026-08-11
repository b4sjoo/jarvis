mod case_material_extraction;
mod case_privacy;
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

#[cfg(all(target_os = "macos", debug_assertions))]
fn restore_development_application_icon(app: &tauri::AppHandle) -> Result<(), String> {
    app.run_on_main_thread(|| {
        use objc2::AllocAnyThread;
        use objc2_app_kit::{NSApplication, NSImage};
        use objc2_foundation::{MainThreadMarker, NSData};

        let marker = unsafe { MainThreadMarker::new_unchecked() };
        let application = NSApplication::sharedApplication(marker);
        let data = NSData::with_bytes(include_bytes!("../icons/icon.icns"));
        let icon = NSImage::initWithData(NSImage::alloc(), &data)
            .expect("the generated MOSS development icon must be valid");
        unsafe { application.setApplicationIconImage(Some(&icon)) };
    })
    .map_err(|error| format!("Failed to refresh the development Dock icon: {error}"))
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn set_stealth_mode(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let policy = if enabled {
            tauri::ActivationPolicy::Accessory
        } else {
            tauri::ActivationPolicy::Regular
        };
        app.set_activation_policy(policy)
            .map_err(|error| format!("Failed to update Dock visibility: {error}"))?;

        #[cfg(debug_assertions)]
        if !enabled {
            restore_development_application_icon(&app)?;
        }
    }

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        use tauri::Manager;
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "Main window is unavailable".to_string())?;
        window
            .set_skip_taskbar(enabled)
            .map_err(|error| format!("Failed to update taskbar visibility: {error}"))?;
    }

    Ok(())
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_keychain::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            write_call_trace_log,
            exit_app,
            set_stealth_mode,
            case_privacy::export_case_bundle,
            case_privacy::stage_case_deletion,
            case_privacy::restore_case_deletion,
            case_privacy::finalize_case_deletion,
            content_storage::import_content_file,
            content_storage::delete_content_file,
            content_storage::read_content_file_base64,
            case_material_extraction::extract_case_material,
            recording::start_call_recording,
            recording::append_call_recording_event,
            recording::close_call_recording,
            recording::retry_call_recording_close,
            recording::abandon_call_recording,
            recording::list_recoverable_call_recordings,
            recording::list_call_recordings,
            recording::reveal_call_recordings_root,
            recording::reveal_call_recording,
            recording::export_call_recording,
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
