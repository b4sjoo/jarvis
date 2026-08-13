mod case_material_extraction;
mod call_audio_evidence;
mod case_privacy;
mod content_storage;
mod credential_store;
mod db;
mod preparation_transaction;
mod recording;
mod speaker;

use serde::Serialize;
use speaker::{NativeCaptureControl, NativeCaptureTerminationRequest, VadConfig};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
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

#[derive(Default)]
struct GracefulExitState {
    authorized: AtomicBool,
    request_pending: AtomicBool,
}

impl GracefulExitState {
    fn authorize(&self) {
        self.authorized.store(true, Ordering::Release);
        self.request_pending.store(false, Ordering::Release);
    }

    fn cancel_request(&self) {
        self.request_pending.store(false, Ordering::Release);
    }

    fn is_authorized(&self) -> bool {
        self.authorized.load(Ordering::Acquire)
    }

    fn begin_request(&self) -> bool {
        !self.request_pending.swap(true, Ordering::AcqRel)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GracefulExitRequest {
    source: &'static str,
}

fn request_graceful_exit(app: &tauri::AppHandle, state: &GracefulExitState, source: &'static str) {
    if !state.begin_request() {
        return;
    }
    if let Err(error) = app.emit("graceful-exit-requested", GracefulExitRequest { source }) {
        state.cancel_request();
        eprintln!("Failed to request graceful MOSS exit: {error}");
    }
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
fn exit_app(app: tauri::AppHandle, state: tauri::State<GracefulExitState>) {
    state.authorize();
    app.exit(0);
}

#[tauri::command]
fn cancel_exit_app(state: tauri::State<GracefulExitState>) {
    state.cancel_request();
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
        .manage(call_audio_evidence::CallAudioEvidenceState::default())
        .manage(credential_store::CredentialStoreState::default())
        .manage(GracefulExitState::default())
        .manage(preparation_transaction::PreparationTransactionState::default())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            write_call_trace_log,
            exit_app,
            cancel_exit_app,
            set_stealth_mode,
            credential_store::get_provider_secret,
            credential_store::save_provider_secret,
            credential_store::remove_provider_secret,
            case_privacy::export_case_bundle,
            case_privacy::stage_case_deletion,
            case_privacy::restore_case_deletion,
            case_privacy::finalize_case_deletion,
            preparation_transaction::begin_preparation_transaction,
            preparation_transaction::execute_preparation_transaction,
            preparation_transaction::select_preparation_transaction,
            preparation_transaction::commit_preparation_transaction,
            preparation_transaction::rollback_preparation_transaction,
            content_storage::import_content_file,
            content_storage::delete_content_file,
            content_storage::stage_content_deletion,
            content_storage::restore_content_deletion,
            content_storage::finalize_content_deletion,
            content_storage::read_content_file_base64,
            case_material_extraction::extract_case_material,
            recording::start_call_recording,
            recording::append_call_recording_event,
            recording::mark_call_recording_incomplete,
            recording::close_call_recording,
            recording::retry_call_recording_close,
            recording::abandon_call_recording,
            recording::list_recoverable_call_recordings,
            recording::list_call_recordings,
            recording::reveal_call_recordings_root,
            recording::reveal_call_recording,
            recording::export_call_recording,
            call_audio_evidence::get_call_audio_recording,
            call_audio_evidence::preserve_call_audio_recording,
            call_audio_evidence::restore_temporary_call_audio_retention,
            call_audio_evidence::delete_call_audio_recording,
            call_audio_evidence::cleanup_expired_call_audio,
            call_audio_evidence::start_call_audio_evidence,
            call_audio_evidence::stop_call_audio_evidence,
            call_audio_evidence::get_active_call_audio_status,
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

    let app = builder
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<GracefulExitState>();
                if !state.is_authorized() {
                    api.prevent_close();
                    request_graceful_exit(window.app_handle(), &state, "window-close");
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building MOSS");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            let state = app_handle.state::<GracefulExitState>();
            if !state.is_authorized() {
                api.prevent_exit();
                request_graceful_exit(app_handle, &state, "application-exit");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::GracefulExitState;

    #[test]
    fn graceful_exit_state_deduplicates_requests_until_cancelled() {
        let state = GracefulExitState::default();
        assert!(state.begin_request());
        assert!(!state.begin_request());
        state.cancel_request();
        assert!(state.begin_request());
    }

    #[test]
    fn graceful_exit_authorization_releases_the_native_gate() {
        let state = GracefulExitState::default();
        assert!(!state.is_authorized());
        state.begin_request();
        state.authorize();
        assert!(state.is_authorized());
        assert!(state.begin_request());
    }
}
