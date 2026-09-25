mod gate;

use gate::{ShutdownGate, StepReceipt, WAIT_BOUND};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewWindow};
#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuEvent, MenuItem, MenuItemKind};

const GENERATION: u64 = 1; // An application lifetime has one irrevocable Quit operation.
const REQUEST_EVENT: &str = "jarvis-shutdown-requested";
const STATUS_EVENT: &str = "jarvis-shutdown-status";
#[cfg(target_os = "macos")]
const QUIT_MENU_ID: &str = "jarvis-coordinated-quit";

#[derive(Default)]
pub struct AppShutdownState(Mutex<Option<ShutdownGate>>);

fn snapshot(gate: &ShutdownGate) -> Value {
    json!({
        "generation": GENERATION, "attempt": gate.attempt, "origin": gate.origin,
        "waiting": gate.waiting, "forced": gate.forced,
        "elapsedMs": gate.started.elapsed().as_millis() as u64,
        "unresolvedRecordingFolder": gate.unresolved_recording_folder,
        "results": gate.results.iter().map(|r| json!({
            "stage": r.stage, "result": r.result, "elapsedMs": r.elapsed_ms
        })).collect::<Vec<_>>()
    })
}

fn publish(app: &AppHandle, value: &Value) {
    if let Err(error) = app.emit(STATUS_EVENT, value) {
        eprintln!("Application shutdown status delivery failed: {error}");
    }
}

fn dispatch(app: &AppHandle, attempt: u64) {
    // A missing/unresponsive main owner still gets a native-bounded wait and visible Retry/Force.
    if let Err(error) = app.emit_to(
        "main",
        REQUEST_EVENT,
        json!({
            "generation": GENERATION, "attempt": attempt
        }),
    ) {
        eprintln!("Application shutdown request delivery failed: {error}");
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(WAIT_BOUND).await;
        let state = app.state::<AppShutdownState>();
        let value = {
            let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
            guard
                .as_mut()
                .and_then(|gate| gate.expire(attempt, Instant::now()).then(|| snapshot(gate)))
        };
        if let Some(value) = value {
            publish(&app, &value);
        }
    });
}

pub fn request(app: &AppHandle, origin: &str) -> Result<(), String> {
    let state = app.state::<AppShutdownState>();
    let (value, first) = {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        let first = guard.is_none();
        let gate = guard.get_or_insert_with(|| ShutdownGate::new(origin, Instant::now()));
        (snapshot(gate), first)
    };
    publish(app, &value);
    if first {
        dispatch(app, 1);
    }
    // Dashboard owns the visible closing UI, main owns the actual Meeting Hook.
    crate::window::show_dashboard_window(app)
}

#[cfg(target_os = "macos")]
pub fn install_quit_menu(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let menu = Menu::default(app.handle())?;
    let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() else {
        return Err("Default macOS application menu is unavailable".into());
    };
    let Some(MenuItemKind::Predefined(default_quit)) = app_menu.items()?.into_iter().last() else {
        return Err("Default macOS Quit item is unavailable".into());
    };
    if !default_quit.text()?.starts_with("Quit ") {
        return Err("Default macOS Quit item has changed".into());
    }
    app_menu.remove(&default_quit)?;
    let coordinated_quit = MenuItem::with_id(
        app,
        QUIT_MENU_ID,
        default_quit.text()?,
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    app_menu.append(&coordinated_quit)?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    if event.id().as_ref() == QUIT_MENU_ID {
        if let Err(error) = request(app, "application-menu") {
            eprintln!("Application menu shutdown request failed: {error}");
        }
    }
}

/// Register as App::run callback. Window CloseRequested hide handlers stay unchanged.
pub fn on_run_event(app: &AppHandle, event: RunEvent) {
    if let RunEvent::ExitRequested { api, .. } = event {
        let authorized = app
            .state::<AppShutdownState>()
            .0
            .lock()
            .map(|guard| guard.as_ref().is_some_and(|gate| gate.exit_authorized))
            .unwrap_or(false);
        if !authorized {
            api.prevent_exit();
            if let Err(error) = request(app, "application-exit") {
                eprintln!("Application shutdown request failed: {error}");
            }
        }
    }
}

#[tauri::command]
pub fn get_app_shutdown(app: AppHandle) -> Result<Option<Value>, String> {
    let state = app.state::<AppShutdownState>();
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    Ok(guard.as_ref().map(snapshot))
}

#[tauri::command]
pub fn retry_app_shutdown(app: AppHandle, generation: u64, attempt: u64) -> Result<(), String> {
    let state = app.state::<AppShutdownState>();
    let (value, next) = {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        let gate = guard.as_mut().ok_or("No shutdown requested")?;
        if generation != GENERATION || attempt != gate.attempt || !gate.retry(Instant::now()) {
            return Err("Shutdown Retry is no longer available".into());
        }
        (snapshot(gate), gate.attempt)
    };
    publish(&app, &value);
    dispatch(&app, next);
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShutdownStepReceipt {
    stage: String,
    result: String,
    elapsed_ms: u64,
}

#[tauri::command]
pub fn report_app_shutdown(
    app: AppHandle,
    window: WebviewWindow,
    generation: u64,
    attempt: u64,
    receipt: ShutdownStepReceipt,
    unresolved_recording_folder: Option<String>,
) -> Result<bool, String> {
    if window.label() != "main" || generation != GENERATION {
        return Err("Only main owns shutdown settlement".into());
    }
    let state = app.state::<AppShutdownState>();
    let (accepted, value) = {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        let gate = guard.as_mut().ok_or("No shutdown requested")?;
        let accepted = gate.report(
            attempt,
            StepReceipt {
                stage: receipt.stage,
                result: receipt.result,
                elapsed_ms: receipt.elapsed_ms,
            },
            unresolved_recording_folder,
            Instant::now(),
        );
        (accepted, snapshot(gate))
    };
    publish(&app, &value);
    Ok(accepted)
}

fn exit(app: &AppHandle, receipt: Value) {
    eprintln!("ApplicationShutdownReceipt {receipt}");
    for (label, window) in app.webview_windows() {
        if label.starts_with("meeting-focus-") || label.starts_with("capture-overlay-") {
            if let Err(error) = window.destroy() {
                eprintln!("Shutdown window cleanup failed: {error}");
            }
        }
    }
    app.exit(0);
}

#[tauri::command]
pub fn complete_app_shutdown(
    app: AppHandle,
    window: WebviewWindow,
    generation: u64,
    attempt: u64,
) -> Result<(), String> {
    if window.label() != "main" || generation != GENERATION {
        return Err("Only main owns shutdown settlement".into());
    }
    let state = app.state::<AppShutdownState>();
    let (ready, value) = {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        let gate = guard.as_mut().ok_or("No shutdown requested")?;
        (gate.complete(attempt, Instant::now()), snapshot(gate))
    };
    publish(&app, &value);
    if ready {
        exit(&app, value);
    }
    Ok(())
}

#[tauri::command]
pub fn force_app_shutdown(app: AppHandle, generation: u64, attempt: u64) -> Result<(), String> {
    let state = app.state::<AppShutdownState>();
    let value = {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        let gate = guard.as_mut().ok_or("No shutdown requested")?;
        if generation != GENERATION || !gate.force(attempt, Instant::now()) {
            return Err(
                "Force Quit requires an unresolved shutdown and explicit confirmation".into(),
            );
        }
        snapshot(gate)
    };
    exit(&app, value);
    Ok(())
}
