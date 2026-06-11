mod capture;
mod db;
mod shortcuts;
mod window;
use base64::{engine::general_purpose, Engine as _};
use std::fs::OpenOptions;
use std::path::{Component, Path};
use std::sync::{Arc, Mutex};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager, WebviewWindow};
use tokio::task::JoinHandle;
mod speaker;
use capture::CaptureState;
use speaker::VadConfig;

#[cfg(target_os = "macos")]
#[allow(deprecated)]
use tauri_nspanel::{cocoa::appkit::NSWindowCollectionBehavior, panel_delegate, WebviewWindowExt};

#[derive(Default)]
pub struct AudioState {
    stream_task: Arc<Mutex<Option<JoinHandle<()>>>>,
    vad_config: Arc<Mutex<VadConfig>>,
    is_capturing: Arc<Mutex<bool>>,
    capture_owner: Arc<Mutex<Option<String>>>,
    capture_device_id: Arc<Mutex<Option<String>>>,
    sample_rate: Arc<Mutex<Option<u32>>>,
    started_at_ms: Arc<Mutex<Option<u64>>>,
}

#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn write_meeting_trace_log(message: String) {
    eprintln!("{}", message);
}

const MEETING_TRACE_METRICS_FILE: &str = "meeting-trace-metrics.json";
const MEETING_TRACE_METRICS_MAX_BYTES: usize = 2 * 1024 * 1024;
const MEETING_TRACE_EXPORTS_DIR: &str = "meeting-trace-exports";
const MEETING_TRACE_EXPORT_MAX_BYTES: usize = 10 * 1024 * 1024;
const MEETING_SESSION_RECORDINGS_DIR: &str = "meeting-session-recordings";
const MEETING_SESSION_RECORDING_TEXT_MAX_BYTES: usize = 50 * 1024 * 1024;
const MEETING_SESSION_RECORDING_BASE64_MAX_BYTES: usize = 80 * 1024 * 1024;

#[tauri::command]
fn read_meeting_trace_metrics(app: AppHandle) -> Result<String, String> {
    let path = meeting_trace_metrics_path(&app)?;

    match fs::read_to_string(path) {
        Ok(contents) => Ok(contents),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(format!("Failed to read meeting trace metrics: {}", error)),
    }
}

#[tauri::command]
fn write_meeting_trace_metrics(app: AppHandle, payload: String) -> Result<(), String> {
    if payload.len() > MEETING_TRACE_METRICS_MAX_BYTES {
        return Err("Meeting trace metrics payload is too large.".to_string());
    }

    let path = meeting_trace_metrics_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create meeting trace metrics directory: {}",
                error
            )
        })?;
    }

    fs::write(path, payload)
        .map_err(|error| format!("Failed to write meeting trace metrics: {}", error))
}

#[tauri::command]
fn export_meeting_trace(
    app: AppHandle,
    file_name: String,
    payload: String,
) -> Result<String, String> {
    if payload.len() > MEETING_TRACE_EXPORT_MAX_BYTES {
        return Err("Meeting trace export payload is too large.".to_string());
    }

    let safe_file_name = sanitize_trace_export_file_name(&file_name);
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {}", error))?;
    let export_dir = app_data_dir.join(MEETING_TRACE_EXPORTS_DIR);

    fs::create_dir_all(&export_dir)
        .map_err(|error| format!("Failed to create meeting trace export directory: {}", error))?;

    let path = export_dir.join(safe_file_name);
    fs::write(&path, payload)
        .map_err(|error| format!("Failed to export meeting trace: {}", error))?;

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn start_meeting_session_recording(
    app: AppHandle,
    folder_name: String,
    manifest_payload: String,
    readme_payload: String,
) -> Result<String, String> {
    if manifest_payload.len() > MEETING_SESSION_RECORDING_TEXT_MAX_BYTES {
        return Err("Meeting session recording manifest is too large.".to_string());
    }
    if readme_payload.len() > MEETING_SESSION_RECORDING_TEXT_MAX_BYTES {
        return Err("Meeting session recording README is too large.".to_string());
    }

    let session_dir = meeting_session_recording_dir(&app, &folder_name)?;
    fs::create_dir_all(&session_dir).map_err(|error| {
        format!(
            "Failed to create meeting session recording directory: {}",
            error
        )
    })?;

    fs::write(session_dir.join("manifest.json"), manifest_payload)
        .map_err(|error| format!("Failed to write session manifest: {}", error))?;
    fs::write(session_dir.join("README.md"), readme_payload)
        .map_err(|error| format!("Failed to write session README: {}", error))?;

    Ok(session_dir.to_string_lossy().to_string())
}

#[tauri::command]
fn write_meeting_session_recording_text(
    app: AppHandle,
    folder_name: String,
    relative_path: String,
    payload: String,
    append: bool,
) -> Result<String, String> {
    if payload.len() > MEETING_SESSION_RECORDING_TEXT_MAX_BYTES {
        return Err("Meeting session recording text payload is too large.".to_string());
    }

    let path = meeting_session_recording_file_path(&app, &folder_name, &relative_path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create meeting session recording directory: {}",
                error
            )
        })?;
    }

    if append {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|error| format!("Failed to open session recording file: {}", error))?;
        use std::io::Write;
        file.write_all(payload.as_bytes())
            .map_err(|error| format!("Failed to append session recording file: {}", error))?;
    } else {
        fs::write(&path, payload)
            .map_err(|error| format!("Failed to write session recording file: {}", error))?;
    }

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn write_meeting_session_recording_base64(
    app: AppHandle,
    folder_name: String,
    relative_path: String,
    base64_payload: String,
) -> Result<String, String> {
    if base64_payload.len() > MEETING_SESSION_RECORDING_BASE64_MAX_BYTES {
        return Err("Meeting session recording binary payload is too large.".to_string());
    }

    let bytes = general_purpose::STANDARD
        .decode(base64_payload.as_bytes())
        .map_err(|error| format!("Failed to decode session recording base64: {}", error))?;
    let path = meeting_session_recording_file_path(&app, &folder_name, &relative_path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create meeting session recording directory: {}",
                error
            )
        })?;
    }

    fs::write(&path, bytes)
        .map_err(|error| format!("Failed to write session recording binary file: {}", error))?;

    Ok(path.to_string_lossy().to_string())
}

fn sanitize_trace_export_file_name(file_name: &str) -> String {
    let sanitized: String = file_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric()
                || character == '-'
                || character == '_'
                || character == '.'
            {
                character
            } else {
                '-'
            }
        })
        .collect();

    let trimmed = sanitized.trim_matches('-');
    let file_name = if trimmed.is_empty() {
        "jarvis-trace-export.json".to_string()
    } else {
        trimmed.to_string()
    };

    if file_name.ends_with(".json") {
        file_name
    } else {
        format!("{}.json", file_name)
    }
}

fn sanitize_session_recording_folder_name(folder_name: &str) -> String {
    let sanitized: String = folder_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric()
                || character == '-'
                || character == '_'
                || character == '.'
            {
                character
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches(['-', '.']);

    if trimmed.is_empty() {
        "session-recording".to_string()
    } else {
        trimmed.to_string()
    }
}

fn sanitize_session_recording_path_component(component: &str) -> String {
    let sanitized: String = component
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric()
                || character == '-'
                || character == '_'
                || character == '.'
            {
                character
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches(['-', '.']);

    if trimmed.is_empty() {
        "artifact".to_string()
    } else {
        trimmed.to_string()
    }
}

fn sanitize_session_recording_relative_path(relative_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative_path);
    let mut sanitized = PathBuf::new();

    for component in path.components() {
        match component {
            Component::Normal(value) => {
                sanitized.push(sanitize_session_recording_path_component(
                    &value.to_string_lossy(),
                ));
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("Invalid session recording relative path.".to_string());
            }
        }
    }

    if sanitized.as_os_str().is_empty() {
        return Err("Session recording relative path is empty.".to_string());
    }

    Ok(sanitized)
}

fn meeting_session_recording_dir(app: &AppHandle, folder_name: &str) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {}", error))?;
    let safe_folder_name = sanitize_session_recording_folder_name(folder_name);

    Ok(app_data_dir
        .join(MEETING_SESSION_RECORDINGS_DIR)
        .join(safe_folder_name))
}

fn meeting_session_recording_file_path(
    app: &AppHandle,
    folder_name: &str,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let session_dir = meeting_session_recording_dir(app, folder_name)?;
    let safe_relative_path = sanitize_session_recording_relative_path(relative_path)?;

    Ok(session_dir.join(safe_relative_path))
}

fn meeting_trace_metrics_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {}", error))?;

    Ok(app_data_dir.join(MEETING_TRACE_METRICS_FILE))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:jarvis.db", db::migrations())
                .build(),
        )
        .manage(AudioState::default())
        .manage(CaptureState::default())
        .manage(shortcuts::WindowVisibility {
            is_hidden: Mutex::new(false),
        })
        .manage(shortcuts::RegisteredShortcuts::default())
        .manage(shortcuts::MoveWindowState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_keychain::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_machine_uid::init());
    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
    }
    let mut builder = builder
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            write_meeting_trace_log,
            read_meeting_trace_metrics,
            write_meeting_trace_metrics,
            export_meeting_trace,
            start_meeting_session_recording,
            write_meeting_session_recording_text,
            write_meeting_session_recording_base64,
            window::set_window_height,
            window::open_dashboard,
            window::toggle_dashboard,
            window::move_window,
            window::show_meeting_focus_windows,
            window::hide_meeting_focus_windows,
            capture::capture_to_base64,
            capture::capture_screen_context_to_base64,
            capture::start_screen_capture,
            capture::capture_selected_area,
            capture::close_overlay_window,
            shortcuts::check_shortcuts_registered,
            shortcuts::get_registered_shortcuts,
            shortcuts::update_shortcuts,
            shortcuts::validate_shortcut_key,
            shortcuts::set_app_icon_visibility,
            shortcuts::set_always_on_top,
            shortcuts::exit_app,
            speaker::start_system_audio_capture,
            speaker::stop_system_audio_capture,
            speaker::start_meeting_audio_session,
            speaker::stop_meeting_audio_session,
            speaker::get_meeting_audio_status,
            speaker::manual_stop_continuous,
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
            {
                if let Err(e) = app
                    .handle()
                    .set_activation_policy(tauri::ActivationPolicy::Accessory)
                {
                    eprintln!("Failed to initialize hidden Dock activation policy: {}", e);
                }
            }

            // Setup main window positioning
            window::setup_main_window(app).expect("Failed to setup main window");
            #[cfg(target_os = "macos")]
            init(app.app_handle());
            let app_handle = app.handle();
            if app_handle.get_webview_window("dashboard").is_none() {
                if let Err(e) = window::create_dashboard_window(&app_handle) {
                    eprintln!("Failed to pre-create dashboard window on startup: {}", e);
                }
            }

            #[cfg(desktop)]
            {
                use tauri_plugin_autostart::MacosLauncher;

                #[allow(deprecated, unexpected_cfgs)]
                if let Err(e) = app.handle().plugin(tauri_plugin_autostart::init(
                    MacosLauncher::LaunchAgent,
                    Some(vec![]),
                )) {
                    eprintln!("Failed to initialize autostart plugin: {}", e);
                }
            }

            // Initialize global shortcut plugin with centralized handler
            app.handle()
                .plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, shortcut, event| {
                            use tauri_plugin_global_shortcut::{Shortcut, ShortcutState};

                            let action_id = {
                                let state = app.state::<shortcuts::RegisteredShortcuts>();
                                let registered = match state.shortcuts.lock() {
                                    Ok(guard) => guard,
                                    Err(poisoned) => {
                                        eprintln!("Mutex poisoned in handler, recovering...");
                                        poisoned.into_inner()
                                    }
                                };

                                registered.iter().find_map(|(action_id, shortcut_str)| {
                                    if let Ok(s) = shortcut_str.parse::<Shortcut>() {
                                        if &s == shortcut {
                                            return Some(action_id.clone());
                                        }
                                    }
                                    None
                                })
                            };

                            if let Some(action_id) = action_id {
                                match event.state() {
                                    ShortcutState::Pressed => {
                                        if let Some(direction) =
                                            action_id.strip_prefix("move_window_")
                                        {
                                            shortcuts::start_move_window(app, direction);
                                        } else {
                                            eprintln!("Shortcut triggered: {}", action_id);
                                            shortcuts::handle_shortcut_action(app, &action_id);
                                        }
                                    }
                                    ShortcutState::Released => {
                                        if let Some(direction) =
                                            action_id.strip_prefix("move_window_")
                                        {
                                            shortcuts::stop_move_window(app, direction);
                                        }
                                    }
                                }
                            }
                        })
                        .build(),
                )
                .expect("Failed to initialize global shortcut plugin");
            if let Err(e) = shortcuts::setup_global_shortcuts(app.handle()) {
                eprintln!("Failed to setup global shortcuts: {}", e);
            }
            Ok(())
        });

    // Add macOS-specific permissions plugin
    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_plugin_macos_permissions::init());
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(target_os = "macos")]
#[allow(deprecated, unexpected_cfgs)]
fn init(app_handle: &AppHandle) {
    let window: WebviewWindow = app_handle.get_webview_window("main").unwrap();

    let panel = window.to_panel().unwrap();

    let delegate = panel_delegate!(MyPanelDelegate {
        window_did_become_key,
        window_did_resign_key
    });

    let handle = app_handle.to_owned();

    delegate.set_listener(Box::new(move |delegate_name: String| {
        match delegate_name.as_str() {
            "window_did_become_key" => {
                let app_name = handle.package_info().name.to_owned();

                println!("[info]: {:?} panel becomes key window!", app_name);
            }
            "window_did_resign_key" => {
                println!("[info]: panel resigned from key window!");
            }
            _ => (),
        }
    }));

    // Set the window to float level
    #[allow(non_upper_case_globals)]
    const NSFloatWindowLevel: i32 = 4;
    panel.set_level(NSFloatWindowLevel);

    #[allow(non_upper_case_globals)]
    const NSWindowStyleMaskNonActivatingPanel: i32 = 1 << 7;
    panel.set_style_mask(NSWindowStyleMaskNonActivatingPanel);

    #[allow(deprecated)]
    panel.set_collection_behaviour(
        NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces,
    );

    panel.set_delegate(delegate);
}
