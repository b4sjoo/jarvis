//! Test-build-only observation. No commands, timers, or business state access.
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{
    menu::{MenuEvent, MenuItem, Submenu},
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder,
};

const LABEL: &str = "native-smoke-status";
const MENU: &str = "native-smoke-read-status";

pub(super) fn install(app: &tauri::App, menu: &Submenu<tauri::Wry>) -> tauri::Result<()> {
    assert_eq!(
        app.config().identifier,
        "dev.seasonsg.jarvis.native-diagnostics-test",
        "Smoke feature must not run with the ordinary application identity"
    );
    menu.append(&MenuItem::with_id(
        app,
        MENU,
        "Read Smoke Status",
        true,
        None::<&str>,
    )?)
}

pub(super) fn on_menu_event(app: &AppHandle, event: &MenuEvent) -> bool {
    if event.id().as_ref() != MENU {
        return false;
    }
    if let Err(error) = show_status(app) {
        eprintln!("NativeSmokeObservationError {error}");
    }
    true
}

fn show_status(app: &AppHandle) -> tauri::Result<()> {
    let registered = crate::shortcuts::get_registered_shortcuts(app.clone()).ok();
    let mut windows: Vec<_> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label != LABEL)
        .map(|(label, window)| {
            json!({
                "label": label,
                "visible": window.is_visible().ok(),
                "focused": window.is_focused().ok(),
            })
        })
        .collect();
    windows.sort_by_key(|window| window["label"].as_str().unwrap_or("").to_owned());
    let snapshot = json!({
        "buildId": env!("JARVIS_NATIVE_SMOKE_BUILD_ID"),
        "pid": std::process::id(),
        "sampledAtMs": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
        "windows": windows,
        "shortcutBindings": {
            "meeting_focus_mode": registered.as_ref().and_then(|keys| keys.get("meeting_focus_mode")),
            "toggle_dashboard": registered.as_ref().and_then(|keys| keys.get("toggle_dashboard")),
        },
        "businessState": "not sampled; inspect the actual UI",
        "actionReceipts": "not sampled; use existing native logs",
    });
    if let Some(window) = app.get_webview_window(LABEL) {
        // Update only this test-owned view, without adding a production IPC event.
        window.eval(&format!(
            "window.dispatchEvent(new CustomEvent('native-smoke-snapshot',{{detail:{snapshot}}}));"
        ))?;
        window.show()?;
        window.set_focus()?;
    } else {
        WebviewWindowBuilder::new(
            app,
            LABEL,
            WebviewUrl::App("tests/native-smoke/status.html".into()),
        )
        .title("Native App Smoke Status")
        .inner_size(720.0, 650.0)
        .initialization_script(format!("window.__NATIVE_SMOKE_SNAPSHOT__={snapshot};"))
        .build()?;
    }
    eprintln!("NativeSmokeObservation {snapshot}");
    Ok(())
}
