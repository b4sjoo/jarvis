use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType as PngFilterType, PngEncoder};
use image::imageops::{resize, FilterType as ResizeFilterType};
use image::{ColorType, GenericImageView, ImageEncoder};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::Emitter;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use xcap::{Monitor, Window as XcapWindow};

#[derive(Debug, Serialize, Deserialize)]
pub struct SelectionCoords {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone)]
pub struct MonitorInfo {
    pub image: image::RgbaImage,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureTargetInfo {
    pub target_type: String,
    pub capture_method: String,
    pub app_name: Option<String>,
    pub title: Option<String>,
    pub monitor_name: Option<String>,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub image_width: u32,
    pub image_height: u32,
    pub original_image_width: Option<u32>,
    pub original_image_height: Option<u32>,
    pub optimized_for_screen_context: bool,
    pub capture_timings_ms: Option<CaptureTimingInfo>,
    pub cursor: Option<CaptureCursorInfo>,
    pub focus_region: Option<CaptureFocusRegionInfo>,
    pub fallback_reason: Option<String>,
    pub candidates: Vec<CaptureCandidateInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureTimingInfo {
    pub total_ms: u64,
    pub window_lookup_ms: Option<u64>,
    pub image_capture_ms: u64,
    pub image_optimize_ms: u64,
    pub image_encode_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureCursorInfo {
    pub global_x: i32,
    pub global_y: i32,
    pub target_x: i32,
    pub target_y: i32,
    pub normalized_x: Option<f64>,
    pub normalized_y: Option<f64>,
    pub inside_target: bool,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureFocusRegionInfo {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub image_width: u32,
    pub image_height: u32,
    pub original_image_width: u32,
    pub original_image_height: u32,
    pub cursor_x: u32,
    pub cursor_y: u32,
    pub source: String,
}

#[derive(Debug, Clone)]
struct FocusCropResult {
    image: image::RgbaImage,
    region: CaptureFocusRegionInfo,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureCandidateInfo {
    pub app_name: String,
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub skipped_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureToBase64Result {
    pub image_base64: String,
    pub image_media_type: String,
    pub focus_image_base64: Option<String>,
    pub focus_image_media_type: Option<String>,
    pub target: CaptureTargetInfo,
}

const SCREEN_CONTEXT_MAX_LONG_EDGE: u32 = 2048;
const SCREEN_CONTEXT_FOCUS_CROP_MAX_LONG_EDGE: u32 = 1280;
const SCREEN_CONTEXT_FOCUS_BAND_HEIGHT_RATIO: f64 = 0.18;
const SCREEN_CONTEXT_FOCUS_BAND_MIN_HEIGHT: u32 = 260;
const SCREEN_CONTEXT_FOCUS_BAND_MAX_HEIGHT: u32 = 420;
const SCREEN_CONTEXT_JPEG_QUALITY: u8 = 82;
const IMAGE_MEDIA_TYPE_PNG: &str = "image/png";
const IMAGE_MEDIA_TYPE_JPEG: &str = "image/jpeg";

// Store captured images from all monitors temporarily for cropping
pub struct CaptureState {
    pub captured_monitors: Arc<Mutex<HashMap<usize, MonitorInfo>>>,
    pub overlay_active: Arc<AtomicBool>,
}

impl Default for CaptureState {
    fn default() -> Self {
        Self {
            captured_monitors: Arc::default(),
            overlay_active: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[tauri::command]
pub async fn start_screen_capture(app: tauri::AppHandle) -> Result<(), String> {
    // Get all monitors
    let capture_monitors = Monitor::all().map_err(|e| format!("Failed to get monitors: {}", e))?;

    if capture_monitors.is_empty() {
        return Err("No monitors found".to_string());
    }

    // Get monitor layout info from Tauri for accurate sizing/positioning
    let tauri_monitors = app
        .available_monitors()
        .map_err(|e| format!("Failed to get monitor layout: {}", e))?;

    if tauri_monitors.len() != capture_monitors.len() {
        eprintln!(
            "Monitor count mismatch between capture ({}) and layout ({}); falling back to capture dimensions",
            capture_monitors.len(),
            tauri_monitors.len()
        );
    }

    let state = app.state::<CaptureState>();
    if state.overlay_active.load(Ordering::SeqCst) {
        // Attempt to clean up any stale overlays before proceeding
        let _ = close_overlay_window(app.clone());
    }
    state.overlay_active.store(true, Ordering::SeqCst);
    let mut captured_monitors = HashMap::new();

    // Capture all monitors and store their info
    for (idx, monitor) in capture_monitors.iter().enumerate() {
        let captured_image = monitor.capture_image().map_err(|e| {
            state.overlay_active.store(false, Ordering::SeqCst);
            format!("Failed to capture monitor {}: {}", idx, e)
        })?;

        let monitor_info = MonitorInfo {
            image: captured_image,
        };

        captured_monitors.insert(idx, monitor_info);
    }

    // Store all captured monitors
    *state.captured_monitors.lock().unwrap() = captured_monitors;

    // Clean up any existing overlay windows before creating new ones
    for (label, window) in app.webview_windows() {
        if label.starts_with("capture-overlay-") {
            window.destroy().ok();
        }
    }

    // Create overlay windows for all monitors
    for (idx, monitor) in capture_monitors.iter().enumerate() {
        let (logical_width, logical_height, logical_x, logical_y) =
            if let Some(display) = tauri_monitors.get(idx) {
                let scale_factor = display.scale_factor();
                let size = display.size();
                let position = display.position();

                // Size values are in physical pixels; convert to logical units for window placement
                let width = size.width as f64 / scale_factor;
                let height = size.height as f64 / scale_factor;
                let x = position.x as f64 / scale_factor;
                let y = position.y as f64 / scale_factor;

                (width, height, x, y)
            } else {
                // Fallback to xcap monitor info if Tauri monitor data is unavailable/mismatched
                (
                    monitor.width() as f64,
                    monitor.height() as f64,
                    monitor.x() as f64,
                    monitor.y() as f64,
                )
            };

        let window_label = format!("capture-overlay-{}", idx);

        let overlay =
            WebviewWindowBuilder::new(&app, &window_label, WebviewUrl::App("index.html".into()))
                .title("Screen Capture")
                .inner_size(logical_width, logical_height)
                .position(logical_x, logical_y)
                .transparent(true)
                .always_on_top(true)
                .decorations(false)
                .skip_taskbar(true)
                .resizable(false)
                .closable(false)
                .minimizable(false)
                .maximizable(false)
                .visible(false)
                .focused(true)
                .accept_first_mouse(true)
                .build()
                .map_err(|e| {
                    state.overlay_active.store(false, Ordering::SeqCst);
                    format!("Failed to create overlay window {}: {}", idx, e)
                })?;

        // Wait a short moment for content to load before showing
        thread::sleep(Duration::from_millis(100));

        overlay.show().ok();
        overlay.set_always_on_top(true).ok();

        if monitor.is_primary() {
            overlay.set_focus().ok();
            overlay
                .request_user_attention(Some(tauri::UserAttentionType::Critical))
                .ok();
        }
    }

    // Give a moment for all windows to settle, then focus primary again
    std::thread::sleep(std::time::Duration::from_millis(100));

    for (idx, monitor) in capture_monitors.iter().enumerate() {
        if monitor.is_primary() {
            let window_label = format!("capture-overlay-{}", idx);
            if let Some(window) = app.get_webview_window(&window_label) {
                window.set_focus().ok();
            }
            break;
        }
    }

    Ok(())
}

// close overlay window
#[tauri::command]
pub fn close_overlay_window(app: tauri::AppHandle) -> Result<(), String> {
    // Get all webview windows and close those that are capture overlays
    let webview_windows = app.webview_windows();

    for (label, window) in webview_windows.iter() {
        if label.starts_with("capture-overlay-") {
            window.destroy().ok();
        }
    }

    // Clear captured monitors from state
    let state = app.state::<CaptureState>();
    state.captured_monitors.lock().unwrap().clear();
    state.overlay_active.store(false, Ordering::SeqCst);

    // Emit an event to the main window to signal that the overlay has been closed
    if let Some(main_window) = app.get_webview_window("main") {
        main_window.emit("capture-closed", ()).unwrap();
    }

    Ok(())
}

#[tauri::command]
pub async fn capture_selected_area(
    app: tauri::AppHandle,
    coords: SelectionCoords,
    monitor_index: usize,
) -> Result<String, String> {
    // Get the stored captured monitors
    let state = app.state::<CaptureState>();
    let mut captured_monitors = state.captured_monitors.lock().unwrap();

    let monitor_info = captured_monitors.remove(&monitor_index).ok_or({
        state.overlay_active.store(false, Ordering::SeqCst);
        format!("No captured image found for monitor {}", monitor_index)
    })?;

    // Validate coordinates
    if coords.width == 0 || coords.height == 0 {
        return Err("Invalid selection dimensions".to_string());
    }

    let img_width = monitor_info.image.width();
    let img_height = monitor_info.image.height();

    // Ensure coordinates are within bounds
    let x = coords.x.min(img_width.saturating_sub(1));
    let y = coords.y.min(img_height.saturating_sub(1));
    let width = coords.width.min(img_width - x);
    let height = coords.height.min(img_height - y);

    // Crop the image to the selected area
    let cropped = monitor_info.image.view(x, y, width, height).to_image();

    let base64_str = encode_png_image_to_base64(&cropped)?;

    captured_monitors.clear();
    drop(captured_monitors);

    // Close all overlay windows
    let webview_windows = app.webview_windows();
    for (label, window) in webview_windows.iter() {
        if label.starts_with("capture-overlay-") {
            window.destroy().ok();
        }
    }

    // Emit event with base64 data
    app.emit("captured-selection", &base64_str)
        .map_err(|e| format!("Failed to emit captured-selection event: {}", e))?;

    state.overlay_active.store(false, Ordering::SeqCst);

    Ok(base64_str)
}

fn encode_png_image_to_base64(image: &image::RgbaImage) -> Result<String, String> {
    let mut png_buffer = Vec::new();
    PngEncoder::new_with_quality(
        &mut png_buffer,
        CompressionType::Fast,
        PngFilterType::Adaptive,
    )
    .write_image(
        image.as_raw(),
        image.width(),
        image.height(),
        ColorType::Rgba8.into(),
    )
    .map_err(|e| format!("Failed to encode to PNG: {}", e))?;

    Ok(base64::engine::general_purpose::STANDARD.encode(png_buffer))
}

fn encode_jpeg_image_to_base64(image: &image::RgbaImage) -> Result<String, String> {
    let mut rgb_buffer = Vec::with_capacity((image.width() * image.height() * 3) as usize);
    for pixel in image.as_raw().chunks_exact(4) {
        rgb_buffer.extend_from_slice(&pixel[..3]);
    }

    let mut jpeg_buffer = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg_buffer, SCREEN_CONTEXT_JPEG_QUALITY)
        .write_image(
            &rgb_buffer,
            image.width(),
            image.height(),
            ColorType::Rgb8.into(),
        )
        .map_err(|e| format!("Failed to encode to JPEG: {}", e))?;

    Ok(base64::engine::general_purpose::STANDARD.encode(jpeg_buffer))
}

fn optimize_screen_context_image(image: image::RgbaImage) -> image::RgbaImage {
    optimize_image_to_long_edge(image, SCREEN_CONTEXT_MAX_LONG_EDGE)
}

fn optimize_focus_crop_image(image: image::RgbaImage) -> image::RgbaImage {
    optimize_image_to_long_edge(image, SCREEN_CONTEXT_FOCUS_CROP_MAX_LONG_EDGE)
}

fn optimize_image_to_long_edge(image: image::RgbaImage, max_long_edge: u32) -> image::RgbaImage {
    let width = image.width();
    let height = image.height();
    let long_edge = width.max(height);

    if long_edge <= max_long_edge {
        return image;
    }

    let scale = max_long_edge as f64 / long_edge as f64;
    let next_width = ((width as f64 * scale).round() as u32).max(1);
    let next_height = ((height as f64 * scale).round() as u32).max(1);

    resize(&image, next_width, next_height, ResizeFilterType::Nearest)
}

fn elapsed_ms(start: Instant) -> u64 {
    start.elapsed().as_millis().min(u64::MAX as u128) as u64
}

fn is_jarvis_window(window: &XcapWindow) -> bool {
    let app_name = window.app_name().trim().to_lowercase();
    let title = window.title().trim().to_lowercase();

    app_name.contains("jarvis") || title == "jarvis - ai assistant"
}

fn active_window_skip_reason(window: &XcapWindow) -> Option<String> {
    if window.is_minimized() {
        return Some("minimized".to_string());
    }
    if is_jarvis_window(window) {
        return Some("jarvis".to_string());
    }
    if window.title().trim().is_empty() {
        return Some("empty-title".to_string());
    }
    if window.width() < 160 || window.height() < 120 {
        return Some("too-small".to_string());
    }

    None
}

fn is_active_window_candidate(window: &XcapWindow) -> bool {
    active_window_skip_reason(window).is_none()
}

fn capture_cursor_info_for_bounds(
    cursor: Option<(i32, i32)>,
    target_x: i32,
    target_y: i32,
    target_width: u32,
    target_height: u32,
) -> Option<CaptureCursorInfo> {
    let (global_x, global_y) = cursor?;
    let relative_x = global_x - target_x;
    let relative_y = global_y - target_y;
    let target_width_i32 = target_width as i32;
    let target_height_i32 = target_height as i32;
    let inside_target = relative_x >= 0
        && relative_y >= 0
        && relative_x < target_width_i32
        && relative_y < target_height_i32;

    Some(CaptureCursorInfo {
        global_x,
        global_y,
        target_x: relative_x,
        target_y: relative_y,
        normalized_x: inside_target.then(|| relative_x as f64 / target_width.max(1) as f64),
        normalized_y: inside_target.then(|| relative_y as f64 / target_height.max(1) as f64),
        inside_target,
        source: current_cursor_position_source().to_string(),
    })
}

fn build_cursor_focus_crop(
    image: &image::RgbaImage,
    cursor: Option<&CaptureCursorInfo>,
    target_width: u32,
    target_height: u32,
) -> Option<FocusCropResult> {
    let cursor = cursor?;
    if !cursor.inside_target || target_width == 0 || target_height == 0 {
        return None;
    }

    let image_width = image.width();
    let image_height = image.height();
    if image_width == 0 || image_height == 0 {
        return None;
    }

    let cursor_x = ((cursor.target_x.max(0) as f64 / target_width.max(1) as f64)
        * image_width as f64)
        .round()
        .clamp(0.0, image_width.saturating_sub(1) as f64) as u32;
    let cursor_y = ((cursor.target_y.max(0) as f64 / target_height.max(1) as f64)
        * image_height as f64)
        .round()
        .clamp(0.0, image_height.saturating_sub(1) as f64) as u32;

    let crop_width = image_width;
    let crop_height = ((image_height as f64 * SCREEN_CONTEXT_FOCUS_BAND_HEIGHT_RATIO).round()
        as u32)
        .max(SCREEN_CONTEXT_FOCUS_BAND_MIN_HEIGHT)
        .min(SCREEN_CONTEXT_FOCUS_BAND_MAX_HEIGHT)
        .min(image_height)
        .max(1);
    let crop_x = 0;
    let crop_y = centered_crop_start(cursor_y, crop_height, image_height);

    let cropped = image
        .view(crop_x, crop_y, crop_width, crop_height)
        .to_image();
    let optimized = optimize_focus_crop_image(cropped);
    let optimized_width = optimized.width();
    let optimized_height = optimized.height();
    let scale_x = optimized_width as f64 / crop_width.max(1) as f64;
    let scale_y = optimized_height as f64 / crop_height.max(1) as f64;

    Some(FocusCropResult {
        image: optimized,
        region: CaptureFocusRegionInfo {
            x: crop_x,
            y: crop_y,
            width: crop_width,
            height: crop_height,
            image_width: optimized_width,
            image_height: optimized_height,
            original_image_width: image_width,
            original_image_height: image_height,
            cursor_x: ((cursor_x - crop_x) as f64 * scale_x).round() as u32,
            cursor_y: ((cursor_y - crop_y) as f64 * scale_y).round() as u32,
            source: "cursor-horizontal-band".to_string(),
        },
    })
}

fn centered_crop_start(center: u32, size: u32, max: u32) -> u32 {
    if size >= max {
        return 0;
    }

    center
        .saturating_sub(size / 2)
        .min(max.saturating_sub(size))
}

#[cfg(target_os = "macos")]
fn current_cursor_position() -> Option<(i32, i32)> {
    let event = cidre::cg::Event::with_src(None)?;
    let location = event.location();
    Some((location.x.round() as i32, location.y.round() as i32))
}

#[cfg(not(target_os = "macos"))]
fn current_cursor_position() -> Option<(i32, i32)> {
    None
}

#[cfg(target_os = "macos")]
fn current_cursor_position_source() -> &'static str {
    "cg-event-location"
}

#[cfg(not(target_os = "macos"))]
fn current_cursor_position_source() -> &'static str {
    "unavailable"
}

fn capture_candidates(windows: &[XcapWindow]) -> Vec<CaptureCandidateInfo> {
    windows
        .iter()
        .take(8)
        .map(|window| CaptureCandidateInfo {
            app_name: window.app_name().to_string(),
            title: window.title().to_string(),
            x: window.x(),
            y: window.y(),
            width: window.width(),
            height: window.height(),
            skipped_reason: active_window_skip_reason(window),
        })
        .collect()
}

fn window_monitor_crop(window: &XcapWindow) -> Result<(image::RgbaImage, String), String> {
    let monitors = Monitor::all().map_err(|e| format!("Failed to get monitors: {}", e))?;
    if monitors.is_empty() {
        return Err("No monitors found".to_string());
    }

    let window_left = window.x();
    let window_top = window.y();
    let window_right = window_left.saturating_add(window.width() as i32);
    let window_bottom = window_top.saturating_add(window.height() as i32);

    let mut best_monitor: Option<Monitor> = None;
    let mut best_area: i64 = 0;

    for monitor in monitors {
        let monitor_left = monitor.x();
        let monitor_top = monitor.y();
        let monitor_right = monitor_left.saturating_add(monitor.width() as i32);
        let monitor_bottom = monitor_top.saturating_add(monitor.height() as i32);

        let overlap_width =
            (window_right.min(monitor_right) - window_left.max(monitor_left)).max(0);
        let overlap_height =
            (window_bottom.min(monitor_bottom) - window_top.max(monitor_top)).max(0);
        let area = (overlap_width as i64) * (overlap_height as i64);

        if area > best_area {
            best_area = area;
            best_monitor = Some(monitor);
        }
    }

    let monitor = best_monitor.ok_or_else(|| "Window does not overlap a monitor".to_string())?;
    let monitor_image = monitor
        .capture_image()
        .map_err(|e| format!("Failed to capture monitor for active-window crop: {}", e))?;

    let scale_x = monitor_image.width() as f64 / monitor.width().max(1) as f64;
    let scale_y = monitor_image.height() as f64 / monitor.height().max(1) as f64;

    let crop_left = window_left.max(monitor.x());
    let crop_top = window_top.max(monitor.y());
    let crop_right = window_right.min(monitor.x().saturating_add(monitor.width() as i32));
    let crop_bottom = window_bottom.min(monitor.y().saturating_add(monitor.height() as i32));

    let crop_x = ((crop_left - monitor.x()) as f64 * scale_x)
        .round()
        .max(0.0) as u32;
    let crop_y = ((crop_top - monitor.y()) as f64 * scale_y).round().max(0.0) as u32;
    let crop_width = ((crop_right - crop_left).max(0) as f64 * scale_x).round() as u32;
    let crop_height = ((crop_bottom - crop_top).max(0) as f64 * scale_y).round() as u32;

    if crop_width == 0 || crop_height == 0 {
        return Err("Active window crop has zero size".to_string());
    }

    let crop_width = crop_width.min(monitor_image.width().saturating_sub(crop_x));
    let crop_height = crop_height.min(monitor_image.height().saturating_sub(crop_y));

    if crop_width == 0 || crop_height == 0 {
        return Err("Active window crop is outside monitor image bounds".to_string());
    }

    let cropped = monitor_image
        .view(crop_x, crop_y, crop_width, crop_height)
        .to_image();

    Ok((cropped, monitor.name().to_string()))
}

async fn capture_active_window_to_base64() -> Result<CaptureToBase64Result, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let total_started_at = Instant::now();
        let lookup_started_at = Instant::now();
        let windows = XcapWindow::all().map_err(|e| format!("Failed to get windows: {}", e))?;
        let candidates = capture_candidates(&windows);
        let window = windows
            .into_iter()
            .find(is_active_window_candidate)
            .ok_or_else(|| "No suitable active window found".to_string())?;
        let window_lookup_ms = elapsed_ms(lookup_started_at);
        let cursor = capture_cursor_info_for_bounds(
            current_cursor_position(),
            window.x(),
            window.y(),
            window.width(),
            window.height(),
        );

        let capture_started_at = Instant::now();
        let (image, capture_method, monitor_name, fallback_reason) =
            match window_monitor_crop(&window) {
                Ok((image, monitor_name)) => (
                    image,
                    "active-window-monitor-crop".to_string(),
                    Some(monitor_name),
                    None,
                ),
                Err(crop_error) => {
                    let image = window
                        .capture_image()
                        .map_err(|e| format!("Failed to capture active window: {}", e))?;
                    (
                        image,
                        "active-window-api".to_string(),
                        Some(window.current_monitor().name().to_string()),
                        Some(format!(
                            "Monitor crop failed; used window API fallback: {}",
                            crop_error
                        )),
                    )
                }
            };
        let image_capture_ms = elapsed_ms(capture_started_at);
        let original_image_width = image.width();
        let original_image_height = image.height();
        let focus_crop =
            build_cursor_focus_crop(&image, cursor.as_ref(), window.width(), window.height());

        let optimize_started_at = Instant::now();
        let image = optimize_screen_context_image(image);
        let image_optimize_ms = elapsed_ms(optimize_started_at);
        let optimized_for_screen_context =
            image.width() != original_image_width || image.height() != original_image_height;

        let encode_started_at = Instant::now();
        let image_base64 = encode_jpeg_image_to_base64(&image)?;
        let (focus_image_base64, focus_image_media_type, focus_region) =
            if let Some(focus_crop) = focus_crop {
                (
                    Some(encode_jpeg_image_to_base64(&focus_crop.image)?),
                    Some(IMAGE_MEDIA_TYPE_JPEG.to_string()),
                    Some(focus_crop.region),
                )
            } else {
                (None, None, None)
            };
        let image_encode_ms = elapsed_ms(encode_started_at);

        let target = CaptureTargetInfo {
            target_type: "active-window".to_string(),
            capture_method,
            app_name: Some(window.app_name().to_string()),
            title: Some(window.title().to_string()),
            monitor_name,
            x: window.x(),
            y: window.y(),
            width: window.width(),
            height: window.height(),
            image_width: image.width(),
            image_height: image.height(),
            original_image_width: Some(original_image_width),
            original_image_height: Some(original_image_height),
            optimized_for_screen_context,
            capture_timings_ms: Some(CaptureTimingInfo {
                total_ms: elapsed_ms(total_started_at),
                window_lookup_ms: Some(window_lookup_ms),
                image_capture_ms,
                image_optimize_ms,
                image_encode_ms,
            }),
            cursor,
            focus_region,
            fallback_reason,
            candidates,
        };

        Ok(CaptureToBase64Result {
            image_base64,
            image_media_type: IMAGE_MEDIA_TYPE_JPEG.to_string(),
            focus_image_base64,
            focus_image_media_type,
            target,
        })
    })
    .await
    .map_err(|e| format!("Task panicked: {}", e))?
}

async fn capture_current_monitor_to_base64(
    window: tauri::WebviewWindow,
    optimize_for_screen_context: bool,
) -> Result<CaptureToBase64Result, String> {
    let monitor_fallback = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());

    let geometry = match (window.outer_position(), window.outer_size()) {
        (Ok(position), Ok(size)) => {
            let width = size.width.min(i32::MAX as u32) as i32;
            let height = size.height.min(i32::MAX as u32) as i32;
            let left = position.x;
            let top = position.y;
            (
                left,
                top,
                left.saturating_add(width),
                top.saturating_add(height),
                left.saturating_add(width / 2),
                top.saturating_add(height / 2),
            )
        }
        _ => {
            if let Some(monitor) = &monitor_fallback {
                let position = monitor.position();
                let size = monitor.size();
                let width = size.width.min(i32::MAX as u32) as i32;
                let height = size.height.min(i32::MAX as u32) as i32;
                let left = position.x;
                let top = position.y;
                (
                    left,
                    top,
                    left.saturating_add(width),
                    top.saturating_add(height),
                    left.saturating_add(width / 2),
                    top.saturating_add(height / 2),
                )
            } else {
                (0, 0, 0, 0, 0, 0)
            }
        }
    };

    let (window_left, window_top, window_right, window_bottom, window_center_x, window_center_y) =
        geometry;

    tauri::async_runtime::spawn_blocking(move || {
        let total_started_at = Instant::now();
        let monitors = Monitor::all().map_err(|e| format!("Failed to get monitors: {}", e))?;
        if monitors.is_empty() {
            return Err("No monitors found".to_string());
        }

        let mut best_idx: Option<usize> = None;
        let mut best_area: i64 = 0;

        for (idx, monitor) in monitors.iter().enumerate() {
            let monitor_left = monitor.x();
            let monitor_top = monitor.y();
            let monitor_right = monitor_left.saturating_add(monitor.width() as i32);
            let monitor_bottom = monitor_top.saturating_add(monitor.height() as i32);

            let overlap_width =
                (window_right.min(monitor_right) - window_left.max(monitor_left)).max(0);
            let overlap_height =
                (window_bottom.min(monitor_bottom) - window_top.max(monitor_top)).max(0);
            let area = (overlap_width as i64) * (overlap_height as i64);

            if area > best_area {
                best_area = area;
                best_idx = Some(idx);
            }
        }

        let target_idx = if let Some(idx) = best_idx {
            idx
        } else {
            let mut closest_idx = 0usize;
            let mut closest_distance = i128::MAX;

            for (idx, monitor) in monitors.iter().enumerate() {
                let monitor_center_x = monitor.x().saturating_add(monitor.width() as i32 / 2);
                let monitor_center_y = monitor.y().saturating_add(monitor.height() as i32 / 2);
                let dx = (window_center_x - monitor_center_x) as i128;
                let dy = (window_center_y - monitor_center_y) as i128;
                let distance = dx * dx + dy * dy;

                if distance < closest_distance {
                    closest_distance = distance;
                    closest_idx = idx;
                }
            }

            closest_idx
        };

        let monitor = monitors
            .into_iter()
            .enumerate()
            .find_map(|(idx, monitor)| {
                if idx == target_idx {
                    Some(monitor)
                } else {
                    None
                }
            })
            .ok_or_else(|| "Failed to determine target monitor".to_string())?;
        let cursor = capture_cursor_info_for_bounds(
            current_cursor_position(),
            monitor.x(),
            monitor.y(),
            monitor.width(),
            monitor.height(),
        );

        let capture_started_at = Instant::now();
        let image = monitor
            .capture_image()
            .map_err(|e| format!("Failed to capture image: {}", e))?;
        let image_capture_ms = elapsed_ms(capture_started_at);
        let original_image_width = image.width();
        let original_image_height = image.height();
        let focus_crop = if optimize_for_screen_context {
            build_cursor_focus_crop(&image, cursor.as_ref(), monitor.width(), monitor.height())
        } else {
            None
        };

        let optimize_started_at = Instant::now();
        let image = if optimize_for_screen_context {
            optimize_screen_context_image(image)
        } else {
            image
        };
        let image_optimize_ms = elapsed_ms(optimize_started_at);
        let optimized_for_screen_context =
            image.width() != original_image_width || image.height() != original_image_height;

        let encode_started_at = Instant::now();
        let (image_base64, image_media_type) = if optimize_for_screen_context {
            (
                encode_jpeg_image_to_base64(&image)?,
                IMAGE_MEDIA_TYPE_JPEG.to_string(),
            )
        } else {
            (
                encode_png_image_to_base64(&image)?,
                IMAGE_MEDIA_TYPE_PNG.to_string(),
            )
        };
        let (focus_image_base64, focus_image_media_type, focus_region) =
            if let Some(focus_crop) = focus_crop {
                (
                    Some(encode_jpeg_image_to_base64(&focus_crop.image)?),
                    Some(IMAGE_MEDIA_TYPE_JPEG.to_string()),
                    Some(focus_crop.region),
                )
            } else {
                (None, None, None)
            };
        let image_encode_ms = elapsed_ms(encode_started_at);

        let target = CaptureTargetInfo {
            target_type: "current-monitor".to_string(),
            capture_method: "current-monitor".to_string(),
            app_name: None,
            title: Some(monitor.name().to_string()),
            monitor_name: Some(monitor.name().to_string()),
            x: monitor.x(),
            y: monitor.y(),
            width: monitor.width(),
            height: monitor.height(),
            image_width: image.width(),
            image_height: image.height(),
            original_image_width: Some(original_image_width),
            original_image_height: Some(original_image_height),
            optimized_for_screen_context,
            capture_timings_ms: Some(CaptureTimingInfo {
                total_ms: elapsed_ms(total_started_at),
                window_lookup_ms: None,
                image_capture_ms,
                image_optimize_ms,
                image_encode_ms,
            }),
            cursor,
            focus_region,
            fallback_reason: None,
            candidates: Vec::new(),
        };

        Ok(CaptureToBase64Result {
            image_base64,
            image_media_type,
            focus_image_base64,
            focus_image_media_type,
            target,
        })
    })
    .await
    .map_err(|e| format!("Task panicked: {}", e))?
}

#[tauri::command]
pub async fn capture_screen_context_to_base64(
    window: tauri::WebviewWindow,
    target: Option<String>,
) -> Result<CaptureToBase64Result, String> {
    match target.as_deref().unwrap_or("active-window") {
        "active-window" => match capture_active_window_to_base64().await {
            Ok(result) => Ok(result),
            Err(error) => {
                let mut result = capture_current_monitor_to_base64(window, true).await?;
                result.target.fallback_reason =
                    Some(format!("Active window capture failed: {}", error));
                Ok(result)
            }
        },
        "current-monitor" => capture_current_monitor_to_base64(window, true).await,
        unknown => Err(format!("Unsupported screen context target: {}", unknown)),
    }
}

#[tauri::command]
pub async fn capture_to_base64(window: tauri::WebviewWindow) -> Result<String, String> {
    let result = capture_current_monitor_to_base64(window, false).await?;
    Ok(result.image_base64)
}
