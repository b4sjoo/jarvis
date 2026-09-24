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
const MAIN_WINDOW_LABEL: &str = "main";
const INTERVIEW_WINDOW_LABELS: [&str; 3] = [
    FOCUS_ANSWER_WINDOW_LABEL,
    FOCUS_CONTROLS_WINDOW_LABEL,
    MAIN_WINDOW_LABEL,
];
const FOCUS_ANSWER_WIDTH: f64 = 920.0;
const FOCUS_ANSWER_HEIGHT: f64 = 540.0;
const FOCUS_ANSWER_MIN_HEIGHT: f64 = 300.0;
const FOCUS_CONTROLS_WIDTH: f64 = 920.0;
const FOCUS_CONTROLS_HEIGHT: f64 = 280.0;
const FOCUS_CONTROLS_MAX_WIDTH: f64 = 1280.0;
const FOCUS_CONTROLS_MAX_HEIGHT: f64 = 440.0;
const FOCUS_TOP_MARGIN: i32 = 12;
const FOCUS_BOTTOM_MARGIN: i32 = 56;
const FOCUS_WINDOW_GAP: i32 = 12;

static FOCUS_CONTROLS_PREFERENCE: std::sync::Mutex<Option<(f64, f64, f64, bool)>> =
    std::sync::Mutex::new(None);

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusControlsGeometryResult {
    snapshot_revision: u64,
    requested_width: f64,
    requested_height: f64,
    applied_width: f64,
    applied_height: f64,
    measured_transcript_height: f64,
    constrained_by_monitor_width: bool,
    constrained_by_answer_window: bool,
    transcript_scroll_required: bool,
}

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

    let preferred = FOCUS_CONTROLS_PREFERENCE
        .lock()
        .map_err(|_| "Focus geometry preference is unavailable".to_string())?
        .unwrap_or((FOCUS_CONTROLS_WIDTH, FOCUS_CONTROLS_HEIGHT, 80.0, false));
    set_meeting_focus_controls_geometry(
        app.clone(),
        0,
        preferred.0,
        preferred.1,
        preferred.2,
        preferred.3,
    )?;

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

#[tauri::command]
pub fn set_meeting_focus_controls_geometry(
    app: tauri::AppHandle,
    snapshot_revision: u64,
    preferred_width: f64,
    preferred_height: f64,
    measured_transcript_height: f64,
    transcript_scroll_required: bool,
) -> Result<FocusControlsGeometryResult, String> {
    use tauri::LogicalSize;

    let controls = app
        .get_webview_window(FOCUS_CONTROLS_WINDOW_LABEL)
        .ok_or_else(|| "Focus controls window is not available".to_string())?;
    let answer = app
        .get_webview_window(FOCUS_ANSWER_WINDOW_LABEL)
        .ok_or_else(|| "Focus answer window is not available".to_string())?;
    let reference_window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .or_else(|| app.webview_windows().values().next().cloned())
        .ok_or_else(|| "No reference window found for Focus Mode".to_string())?;
    let monitor = match reference_window
        .current_monitor()
        .map_err(|error| format!("Failed to get current monitor: {}", error))?
    {
        Some(monitor) => Some(monitor),
        None => reference_window
            .primary_monitor()
            .map_err(|error| format!("Failed to get primary monitor: {}", error))?,
    }
    .ok_or_else(|| "No monitor found for Focus Mode".to_string())?;
    let scale_factor = monitor.scale_factor().max(1.0);
    let monitor_size = monitor.size();
    let logical_monitor_width = monitor_size.width as f64 / scale_factor;
    let maximum_width = FOCUS_CONTROLS_MAX_WIDTH
        .min((logical_monitor_width - WINDOW_SIDE_MARGIN).max(MIN_WINDOW_WIDTH));
    let reserved_vertical_space =
        (FOCUS_TOP_MARGIN + FOCUS_BOTTOM_MARGIN + FOCUS_WINDOW_GAP) as f64;
    let available_height = (monitor_size.height as f64 / scale_factor - reserved_vertical_space)
        .max(FOCUS_CONTROLS_HEIGHT + 1.0);
    let (answer_height, controls_height) =
        resolve_focus_window_vertical_layout(available_height, preferred_height);
    let (applied_width, applied_height) = clamp_focus_controls_geometry(
        preferred_width,
        controls_height,
        maximum_width,
        controls_height,
    );

    let answer_width =
        FOCUS_ANSWER_WIDTH.min((logical_monitor_width - WINDOW_SIDE_MARGIN).max(MIN_WINDOW_WIDTH));
    let origin = tauri::LogicalPosition::new(
        monitor.position().x as f64 / scale_factor,
        monitor.position().y as f64 / scale_factor,
    );
    let extent = LogicalSize::new(
        logical_monitor_width,
        monitor_size.height as f64 / scale_factor,
    );
    let answer_position = focus_target_position(
        origin,
        extent,
        LogicalSize::new(answer_width, answer_height),
        FocusWindowPlacement::Top,
    );
    let controls_position = focus_target_position(
        origin,
        extent,
        LogicalSize::new(applied_width, applied_height),
        FocusWindowPlacement::Bottom,
    );
    let (answer_size, answer_position) = focus_geometry_submission(
        LogicalSize::new(answer_width, answer_height),
        answer_position,
        scale_factor,
    );
    let (controls_size, controls_position) = focus_geometry_submission(
        LogicalSize::new(applied_width, applied_height),
        controls_position,
        scale_factor,
    );
    answer
        .set_size(answer_size)
        .map_err(|error| format!("Failed to resize Focus answer window: {}", error))?;
    controls
        .set_size(controls_size)
        .map_err(|error| format!("Failed to resize Focus controls window: {}", error))?;
    answer
        .set_position(answer_position)
        .map_err(|error| format!("Failed to position Focus answer: {}", error))?;
    controls
        .set_position(controls_position)
        .map_err(|error| format!("Failed to position Focus controls: {}", error))?;
    *FOCUS_CONTROLS_PREFERENCE
        .lock()
        .map_err(|_| "Focus geometry preference is unavailable".to_string())? = Some((
        preferred_width,
        preferred_height,
        measured_transcript_height,
        transcript_scroll_required,
    ));

    Ok(FocusControlsGeometryResult {
        snapshot_revision,
        requested_width: preferred_width,
        requested_height: preferred_height,
        applied_width,
        applied_height,
        measured_transcript_height,
        constrained_by_monitor_width: applied_width + 0.5 < preferred_width,
        constrained_by_answer_window: applied_height + 0.5 < preferred_height,
        transcript_scroll_required: transcript_scroll_required
            || applied_height + 0.5 < preferred_height,
    })
}

pub fn hide_interview_windows_best_effort<R: Runtime>(app: &AppHandle<R>) {
    for label in INTERVIEW_WINDOW_LABELS {
        if let Some(window) = app.get_webview_window(label) {
            if let Err(error) = window.hide() {
                eprintln!("Failed to hide interview window {}: {}", label, error);
            }
        }
    }
}

enum FocusWindowPlacement {
    Top,
    Bottom,
}

fn focus_geometry_submission(
    size: tauri::LogicalSize<f64>,
    position: tauri::LogicalPosition<f64>,
    _target_scale: f64,
) -> (tauri::Size, tauri::Position) {
    // macOS converts Physical using the receiving window's old backing scale.
    #[cfg(target_os = "macos")]
    {
        (
            tauri::Size::Logical(size),
            tauri::Position::Logical(position),
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        (
            tauri::Size::Physical(size.to_physical::<u32>(_target_scale)),
            tauri::Position::Physical(position.to_physical::<i32>(_target_scale)),
        )
    }
}

fn resolve_focus_window_vertical_layout(
    available_height: f64,
    preferred_controls_height: f64,
) -> (f64, f64) {
    let available_height = available_height.max(FOCUS_CONTROLS_HEIGHT + 1.0);
    let maximum_controls_height = (available_height - FOCUS_ANSWER_MIN_HEIGHT)
        .max(FOCUS_CONTROLS_HEIGHT)
        .min(FOCUS_CONTROLS_MAX_HEIGHT)
        .min(available_height - 1.0);
    let controls_height = preferred_controls_height
        .max(FOCUS_CONTROLS_HEIGHT)
        .min(maximum_controls_height);
    let answer_height = (available_height - controls_height).max(1.0);

    (answer_height, controls_height)
}

fn clamp_focus_controls_geometry(
    preferred_width: f64,
    preferred_height: f64,
    maximum_width: f64,
    maximum_height: f64,
) -> (f64, f64) {
    let maximum_width = maximum_width
        .max(MIN_WINDOW_WIDTH)
        .min(FOCUS_CONTROLS_MAX_WIDTH);
    let minimum_width = FOCUS_CONTROLS_WIDTH.min(maximum_width);
    let maximum_height = maximum_height
        .max(FOCUS_CONTROLS_HEIGHT)
        .min(FOCUS_CONTROLS_MAX_HEIGHT);

    (
        preferred_width
            .max(FOCUS_CONTROLS_WIDTH)
            .clamp(minimum_width, maximum_width),
        preferred_height
            .max(FOCUS_CONTROLS_HEIGHT)
            .clamp(FOCUS_CONTROLS_HEIGHT, maximum_height),
    )
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

fn focus_target_position(
    origin: tauri::LogicalPosition<f64>,
    monitor_size: tauri::LogicalSize<f64>,
    window_size: tauri::LogicalSize<f64>,
    placement: FocusWindowPlacement,
) -> tauri::LogicalPosition<f64> {
    let x = origin.x + (monitor_size.width - window_size.width) / 2.0;
    let y = match placement {
        FocusWindowPlacement::Top => origin.y + FOCUS_TOP_MARGIN as f64,
        FocusWindowPlacement::Bottom => {
            origin.y + monitor_size.height - window_size.height - FOCUS_BOTTOM_MARGIN as f64
        }
    };
    tauri::LogicalPosition::new(x, y.max(origin.y))
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

#[cfg(test)]
mod tests {
    use super::{
        clamp_focus_controls_geometry, focus_geometry_submission, focus_target_position,
        resolve_focus_window_vertical_layout, FocusWindowPlacement, FOCUS_ANSWER_WINDOW_LABEL,
        FOCUS_CONTROLS_HEIGHT, FOCUS_CONTROLS_MAX_HEIGHT, FOCUS_CONTROLS_MAX_WIDTH,
        FOCUS_CONTROLS_WIDTH, FOCUS_CONTROLS_WINDOW_LABEL, INTERVIEW_WINDOW_LABELS,
        MAIN_WINDOW_LABEL,
    };

    #[test]
    fn emergency_hide_orders_focus_windows_before_the_main_window() {
        assert_eq!(
            INTERVIEW_WINDOW_LABELS,
            [
                FOCUS_ANSWER_WINDOW_LABEL,
                FOCUS_CONTROLS_WINDOW_LABEL,
                MAIN_WINDOW_LABEL,
            ]
        );
    }

    #[test]
    fn focus_controls_geometry_keeps_short_transcripts_compact() {
        assert_eq!(
            clamp_focus_controls_geometry(
                FOCUS_CONTROLS_WIDTH,
                FOCUS_CONTROLS_HEIGHT,
                FOCUS_CONTROLS_MAX_WIDTH,
                FOCUS_CONTROLS_MAX_HEIGHT,
            ),
            (FOCUS_CONTROLS_WIDTH, FOCUS_CONTROLS_HEIGHT)
        );
    }

    #[test]
    fn focus_controls_geometry_respects_monitor_and_answer_window_limits() {
        assert_eq!(
            clamp_focus_controls_geometry(1280.0, 350.0, 1100.0, 250.0),
            (1100.0, 280.0)
        );
    }

    #[test]
    fn focus_answer_window_fills_the_space_above_compact_controls() {
        assert_eq!(
            resolve_focus_window_vertical_layout(1000.0, FOCUS_CONTROLS_HEIGHT),
            (720.0, 280.0)
        );
    }

    #[test]
    fn focus_controls_growth_preserves_the_answer_minimum_when_space_allows() {
        assert_eq!(
            resolve_focus_window_vertical_layout(600.0, FOCUS_CONTROLS_MAX_HEIGHT),
            (300.0, 300.0)
        );
    }

    #[test]
    fn focus_windows_never_overlap_on_a_short_available_viewport() {
        let (answer_height, controls_height) =
            resolve_focus_window_vertical_layout(480.0, FOCUS_CONTROLS_MAX_HEIGHT);

        assert_eq!((answer_height, controls_height), (200.0, 280.0));
        assert_eq!(answer_height + controls_height, 480.0);
    }

    #[test]
    fn focus_positions_use_target_size_and_monitor_origin_without_current_window_reads() {
        let origin = tauri::LogicalPosition::new(-1920.0, 100.0);
        let extent = tauri::LogicalSize::new(1920.0, 1080.0);
        let target = tauri::LogicalSize::new(1280.0, 440.0);
        let position = focus_target_position(origin, extent, target, FocusWindowPlacement::Bottom);
        assert_eq!(position.x, -1600.0);
        assert_eq!(position.y, 684.0);
        assert_eq!(
            position.x + target.width / 2.0,
            origin.x + extent.width / 2.0
        );
        let top = focus_target_position(origin, extent, target, FocusWindowPlacement::Top);
        assert_eq!(top.y, 112.0);
        // These are target physical coordinates, before platform submission.
        let physical = position.to_physical::<i32>(2.0);
        assert_eq!((physical.x, physical.y), (-3200, 1368));
        let size = target.to_physical::<u32>(2.0);
        assert_eq!((size.width, size.height), (2560, 880));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn focus_macos_submission_survives_each_windows_previous_backing_scale() {
        use tauri::{LogicalPosition, LogicalSize, PhysicalPosition, PhysicalSize};

        for target_scale in [1.0, 2.0] {
            for (answer_previous_scale, controls_previous_scale) in
                [(1.0, 1.0), (1.0, 2.0), (2.0, 1.0), (2.0, 2.0)]
            {
                for (x, y) in [(0.0, 0.0), (-1920.0, -1080.0), (1920.0, -240.0)] {
                    let origin = PhysicalPosition::new(x * target_scale, y * target_scale)
                        .to_logical::<f64>(target_scale);
                    let extent = PhysicalSize::new(1920.0 * target_scale, 1080.0 * target_scale)
                        .to_logical::<f64>(target_scale);
                    for preferred_height in [FOCUS_CONTROLS_HEIGHT, FOCUS_CONTROLS_MAX_HEIGHT] {
                        let (answer_height, controls_height) =
                            resolve_focus_window_vertical_layout(1000.0, preferred_height);
                        let (width, height) = clamp_focus_controls_geometry(
                            1280.0,
                            controls_height,
                            1280.0,
                            controls_height,
                        );
                        for (size, placement, previous_scale, expected_position) in [
                            (
                                LogicalSize::new(920.0, answer_height),
                                FocusWindowPlacement::Top,
                                answer_previous_scale,
                                LogicalPosition::new(x + 500.0, y + 12.0),
                            ),
                            (
                                LogicalSize::new(width, height),
                                FocusWindowPlacement::Bottom,
                                controls_previous_scale,
                                LogicalPosition::new(x + 320.0, y + 1024.0 - height),
                            ),
                        ] {
                            let position = focus_target_position(origin, extent, size, placement);
                            let (submitted_size, submitted_position) =
                                focus_geometry_submission(size, position, target_scale);
                            assert!(matches!(submitted_size, tauri::Size::Logical(_)));
                            assert!(matches!(submitted_position, tauri::Position::Logical(_)));
                            // Same DPI conversion used by Tao's macOS setters before AppKit.
                            assert_eq!(submitted_size.to_logical::<f64>(previous_scale), size);
                            assert_eq!(
                                submitted_position.to_logical::<f64>(previous_scale),
                                expected_position
                            );
                        }
                    }
                }
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn focus_non_macos_submission_retains_target_physical_geometry() {
        let size = tauri::LogicalSize::new(920.0, 440.0);
        let position = tauri::LogicalPosition::new(-1600.0, -396.0);
        for scale in [1.0, 2.0] {
            let (submitted_size, submitted_position) =
                focus_geometry_submission(size, position, scale);
            assert_eq!(
                submitted_size,
                tauri::Size::Physical(size.to_physical::<u32>(scale))
            );
            assert_eq!(
                submitted_position,
                tauri::Position::Physical(position.to_physical::<i32>(scale))
            );
        }
    }
}
