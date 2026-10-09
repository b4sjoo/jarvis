use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

#[derive(Debug, Serialize)]
pub struct AutostartStatus {
    pub supported: bool,
    pub enabled: bool,
}

pub fn supported(identifier: &str) -> bool {
    supports_build(cfg!(debug_assertions), identifier)
}

fn supports_build(debug: bool, identifier: &str) -> bool {
    !debug && identifier == "dev.seasonsg.jarvis"
}

#[tauri::command]
pub fn get_autostart_status(app: AppHandle) -> Result<AutostartStatus, String> {
    let supported = supported(&app.config().identifier);
    let enabled = if supported {
        app.autolaunch().is_enabled().map_err(|e| e.to_string())?
    } else {
        false
    };
    let status = AutostartStatus { supported, enabled };
    eprintln!("AutostartReceipt {}", serde_json::json!({
        "operation": "read", "supported": supported, "enabled": enabled
    }));
    Ok(status)
}

#[tauri::command]
pub fn set_autostart_enabled(app: AppHandle, enabled: bool) -> Result<AutostartStatus, String> {
    if !supported(&app.config().identifier) {
        eprintln!("AutostartReceipt {}", serde_json::json!({
            "operation": "write", "outcome": "unsupported", "enabled": enabled
        }));
        return Err("Launch on Startup is unavailable in development and test builds.".into());
    }
    let result = if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    };
    if let Err(error) = result {
        eprintln!("AutostartReceipt {}", serde_json::json!({
            "operation": "write", "outcome": "error", "enabled": enabled
        }));
        return Err(error.to_string());
    }
    get_autostart_status(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_normal_release_can_register_login_startup() {
        assert!(supports_build(false, "dev.seasonsg.jarvis"));
        assert!(!supports_build(true, "dev.seasonsg.jarvis"));
        for debug in [true, false] {
            assert!(!supports_build(debug, "dev.seasonsg.jarvis.native-diagnostics-test"));
            assert!(!supports_build(debug, "dev.seasonsg.jarvis.focus-close-test"));
        }
    }
}
