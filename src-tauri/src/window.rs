#[cfg(target_os = "macos")]
use tauri::LogicalPosition;
use tauri::{App, AppHandle, Manager, Runtime, WebviewWindow, WebviewWindowBuilder};

// The offset from the top of the screen to the window
const TOP_OFFSET: i32 = 54;
const DEFAULT_WINDOW_WIDTH: f64 = 600.0;
const MIN_WINDOW_WIDTH: f64 = 360.0;
const WINDOW_SIDE_MARGIN: f64 = 32.0;
const FOCUS_ANSWER_WINDOW_LABEL: &str = "meeting-focus-answer";
const FOCUS_CONTROLS_WINDOW_LABEL: &str = "meeting-focus-controls";
const FOCUS_ANSWER_WIDTH: f64 = 920.0;
const FOCUS_ANSWER_HEIGHT: f64 = 620.0;
const FOCUS_CONTROLS_WIDTH: f64 = 920.0;
const FOCUS_CONTROLS_HEIGHT: f64 = 230.0;
const FOCUS_TOP_MARGIN: i32 = 12;
const FOCUS_BOTTOM_MARGIN: i32 = 56;

/// Sets up the main window with custom positioning
pub fn setup_main_window(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    // Try different possible window labels
    let window = app
        .get_webview_window("main")
        .or_else(|| app.get_webview_window("jarvis"))
        .or_else(|| {
            // Get the first window if specific labels don't work
            app.webview_windows().values().next().cloned()
        })
        .ok_or("No window found")?;

    position_window_top_center(&window, TOP_OFFSET)?;

    // Set window as non-focusable on Windows
    // #[cfg(target_os = "windows")]
    // {
    //     let _ = window.set_focusable(false);
    // }

    Ok(())
}

/// Positions a window at the top center of the screen with a specified Y offset
pub fn position_window_top_center(
    window: &WebviewWindow,
    y_offset: i32,
) -> Result<(), Box<dyn std::error::Error>> {
    let monitor = match window.current_monitor()? {
        Some(monitor) => Some(monitor),
        None => window.primary_monitor()?,
    };

    if let Some(monitor) = monitor {
        let monitor_size = monitor.size();
        let monitor_position = monitor.position();
        let window_size = window.outer_size()?;

        // Calculate center X position
        let center_x =
            monitor_position.x + (monitor_size.width as i32 - window_size.width as i32) / 2;

        // Set the window position
        window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: center_x,
            y: monitor_position.y + y_offset,
        }))?;
    }

    Ok(())
}

/// Future function for centering window completely (both X and Y)
#[allow(dead_code)]
pub fn center_window_completely(window: &WebviewWindow) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(monitor) = window.primary_monitor()? {
        let monitor_size = monitor.size();
        let window_size = window.outer_size()?;

        let center_x = (monitor_size.width as i32 - window_size.width as i32) / 2;
        let center_y = (monitor_size.height as i32 - window_size.height as i32) / 2;

        window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: center_x,
            y: center_y,
        }))?;
    }

    Ok(())
}

#[tauri::command]
pub fn set_window_height(
    window: tauri::WebviewWindow,
    height: u32,
    width: Option<u32>,
) -> Result<(), String> {
    use tauri::{LogicalSize, Size};

    let requested_width = width
        .map(|value| value as f64)
        .unwrap_or(DEFAULT_WINDOW_WIDTH);
    let window_width = clamp_logical_window_width(&window, requested_width)?;
    let new_size = LogicalSize::new(window_width, height as f64);
    window
        .set_size(Size::Logical(new_size))
        .map_err(|e| format!("Failed to resize window: {}", e))?;
    position_window_top_center(&window, TOP_OFFSET)
        .map_err(|e| format!("Failed to reposition window: {}", e))?;

    Ok(())
}

fn clamp_logical_window_width(window: &WebviewWindow, requested_width: f64) -> Result<f64, String> {
    let scale_factor = window
        .scale_factor()
        .map_err(|e| format!("Failed to get window scale factor: {}", e))?;
    let monitor = match window
        .current_monitor()
        .map_err(|e| format!("Failed to get current monitor: {}", e))?
    {
        Some(monitor) => Some(monitor),
        None => window
            .primary_monitor()
            .map_err(|e| format!("Failed to get primary monitor: {}", e))?,
    };

    if let Some(monitor) = monitor {
        let logical_monitor_width = monitor.size().width as f64 / scale_factor.max(1.0);
        let max_width = (logical_monitor_width - WINDOW_SIDE_MARGIN).max(MIN_WINDOW_WIDTH);
        return Ok(requested_width.min(max_width).max(MIN_WINDOW_WIDTH));
    }

    Ok(requested_width.max(MIN_WINDOW_WIDTH))
}

#[tauri::command]
pub fn open_dashboard(app: tauri::AppHandle) -> Result<(), String> {
    show_dashboard_window(&app)
}

#[tauri::command]
pub fn toggle_dashboard(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(dashboard_window) = app.get_webview_window("dashboard") {
        match dashboard_window.is_visible() {
            Ok(true) => {
                // Window is visible, hide it
                dashboard_window
                    .hide()
                    .map_err(|e| format!("Failed to hide dashboard window: {}", e))?;
            }
            Ok(false) => {
                // Window is hidden, show and focus it
                dashboard_window
                    .show()
                    .map_err(|e| format!("Failed to show dashboard window: {}", e))?;
                dashboard_window
                    .set_focus()
                    .map_err(|e| format!("Failed to focus dashboard window: {}", e))?;
            }
            Err(e) => {
                return Err(format!("Failed to check dashboard visibility: {}", e));
            }
        }
    } else {
        // Window doesn't exist, create and show it
        show_dashboard_window(&app)?;
    }

    Ok(())
}

#[tauri::command]
pub fn move_window(app: tauri::AppHandle, direction: String, step: i32) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let current_pos = window
            .outer_position()
            .map_err(|e| format!("Failed to get window position: {}", e))?;

        let (new_x, new_y) = match direction.as_str() {
            "up" => (current_pos.x, current_pos.y - step),
            "down" => (current_pos.x, current_pos.y + step),
            "left" => (current_pos.x - step, current_pos.y),
            "right" => (current_pos.x + step, current_pos.y),
            _ => return Err(format!("Invalid direction: {}", direction)),
        };

        window
            .set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                x: new_x,
                y: new_y,
            }))
            .map_err(|e| format!("Failed to set window position: {}", e))?;
    } else {
        return Err("Main window not found".to_string());
    }

    Ok(())
}

pub fn create_dashboard_window<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<WebviewWindow<R>, tauri::Error> {
    let base_builder =
        WebviewWindowBuilder::new(app, "dashboard", tauri::WebviewUrl::App("/chats".into()));

    #[cfg(target_os = "macos")]
    let base_builder = base_builder
        .title("Jarvis - Dashboard")
        .center()
        .decorations(true)
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .hidden_title(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .content_protected(true)
        .visible(true)
        .traffic_light_position(LogicalPosition::new(14.0, 18.0));

    #[cfg(not(target_os = "macos"))]
    let base_builder = base_builder
        .title("Jarvis - Dashboard")
        .center()
        .decorations(true)
        .inner_size(800.0, 600.0)
        .min_inner_size(800.0, 600.0)
        .content_protected(true)
        .visible(false);

    let window = base_builder.build()?;

    // Set up close event handler - hide window instead of destroying it
    setup_dashboard_close_handler(&window);

    Ok(window)
}

#[tauri::command]
pub fn show_meeting_focus_windows(app: tauri::AppHandle) -> Result<(), String> {
    let answer = ensure_focus_window(
        &app,
        FOCUS_ANSWER_WINDOW_LABEL,
        "/meeting-focus-answer",
        "Jarvis Focus Answer",
        FOCUS_ANSWER_WIDTH,
        FOCUS_ANSWER_HEIGHT,
    )?;
    let controls = ensure_focus_window(
        &app,
        FOCUS_CONTROLS_WINDOW_LABEL,
        "/meeting-focus-controls",
        "Jarvis Focus Controls",
        FOCUS_CONTROLS_WIDTH,
        FOCUS_CONTROLS_HEIGHT,
    )?;

    position_focus_window(&app, &answer, FocusWindowPlacement::Top)?;
    position_focus_window(&app, &controls, FocusWindowPlacement::Bottom)?;

    answer
        .show()
        .map_err(|e| format!("Failed to show focus answer window: {}", e))?;
    controls
        .show()
        .map_err(|e| format!("Failed to show focus controls window: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn hide_meeting_focus_windows(app: tauri::AppHandle) -> Result<(), String> {
    for label in [FOCUS_ANSWER_WINDOW_LABEL, FOCUS_CONTROLS_WINDOW_LABEL] {
        if let Some(window) = app.get_webview_window(label) {
            window
                .hide()
                .map_err(|e| format!("Failed to hide {}: {}", label, e))?;
        }
    }

    Ok(())
}

enum FocusWindowPlacement {
    Top,
    Bottom,
}

fn ensure_focus_window<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    route: &str,
    title: &str,
    width: f64,
    height: f64,
) -> Result<WebviewWindow<R>, String> {
    if let Some(window) = app.get_webview_window(label) {
        return Ok(window);
    }

    let base_builder = WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App(route.into()));

    #[cfg(target_os = "macos")]
    let base_builder = base_builder
        .title(title)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .content_protected(true)
        .resizable(false)
        .focused(false)
        .inner_size(width, height)
        .visible(false);

    #[cfg(not(target_os = "macos"))]
    let base_builder = base_builder
        .title(title)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .content_protected(true)
        .resizable(false)
        .focused(false)
        .inner_size(width, height)
        .visible(false);

    let window = base_builder
        .build()
        .map_err(|e| format!("Failed to create {}: {}", label, e))?;
    setup_focus_close_handler(&window);

    Ok(window)
}

fn position_focus_window<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    placement: FocusWindowPlacement,
) -> Result<(), String> {
    let reference_window = app
        .get_webview_window("main")
        .or_else(|| app.webview_windows().values().next().cloned())
        .ok_or_else(|| "No reference window found for Focus Mode".to_string())?;
    let monitor = match reference_window
        .current_monitor()
        .map_err(|e| format!("Failed to get current monitor: {}", e))?
    {
        Some(monitor) => Some(monitor),
        None => reference_window
            .primary_monitor()
            .map_err(|e| format!("Failed to get primary monitor: {}", e))?,
    }
    .ok_or_else(|| "No monitor found for Focus Mode".to_string())?;
    let monitor_size = monitor.size();
    let monitor_position = monitor.position();
    let window_size = window
        .outer_size()
        .map_err(|e| format!("Failed to get focus window size: {}", e))?;
    let x = monitor_position.x + (monitor_size.width as i32 - window_size.width as i32) / 2;
    let y = match placement {
        FocusWindowPlacement::Top => monitor_position.y + FOCUS_TOP_MARGIN,
        FocusWindowPlacement::Bottom => {
            monitor_position.y + monitor_size.height as i32 - window_size.height as i32
                - FOCUS_BOTTOM_MARGIN
        }
    };

    window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x,
            y: y.max(monitor_position.y),
        }))
        .map_err(|e| format!("Failed to position focus window: {}", e))?;

    Ok(())
}

fn setup_focus_close_handler<R: Runtime>(window: &WebviewWindow<R>) {
    let window_clone = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Err(e) = window_clone.hide() {
                eprintln!("Failed to hide Focus Mode window on close: {}", e);
            }
        }
    });
}

/// Sets up the close event handler for the dashboard window
fn setup_dashboard_close_handler<R: Runtime>(window: &WebviewWindow<R>) {
    let window_clone = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            // Prevent the window from being destroyed
            api.prevent_close();
            // Hide the window instead
            if let Err(e) = window_clone.hide() {
                eprintln!("Failed to hide dashboard window on close: {}", e);
            }
        }
    });
}

/// Shows the dashboard window and brings it to focus
pub fn show_dashboard_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(dashboard_window) = app.get_webview_window("dashboard") {
        // Window exists, show and focus it
        dashboard_window
            .show()
            .map_err(|e| format!("Failed to show dashboard window: {}", e))?;
        dashboard_window
            .set_focus()
            .map_err(|e| format!("Failed to focus dashboard window: {}", e))?;
    } else {
        // Window doesn't exist, create it and then show it
        let window = create_dashboard_window(app)
            .map_err(|e| format!("Failed to create dashboard window: {}", e))?;
        window
            .show()
            .map_err(|e| format!("Failed to show new dashboard window: {}", e))?;
        window
            .set_focus()
            .map_err(|e| format!("Failed to focus new dashboard window: {}", e))?;
    }
    Ok(())
}
