use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrLine {
    pub text: String,
    pub confidence: f32,
}

#[derive(Debug, Clone)]
pub struct OcrPage {
    pub lines: Vec<OcrLine>,
    pub average_confidence: f32,
}

#[cfg(target_os = "macos")]
pub fn ocr_pdf_page(
    path: &Path,
    zero_based_page_index: usize,
    max_dimension: usize,
) -> Result<OcrPage, String> {
    use std::ffi::{CStr, CString};
    use std::os::raw::c_char;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct NativeResult {
        success: bool,
        average_confidence: Option<f32>,
        lines: Vec<OcrLine>,
        error: Option<String>,
    }

    extern "C" {
        fn jarvis_ocr_pdf_page(
            pdf_path: *const c_char,
            page_index: usize,
            max_dimension: usize,
        ) -> *mut c_char;
        fn jarvis_free_ocr_result(value: *mut c_char);
    }

    let path = path
        .to_str()
        .ok_or_else(|| "PDF OCR path is not valid UTF-8.".to_string())?;
    let path = CString::new(path).map_err(|_| "PDF OCR path contains a null byte.".to_string())?;
    let pointer =
        unsafe { jarvis_ocr_pdf_page(path.as_ptr(), zero_based_page_index, max_dimension) };
    if pointer.is_null() {
        return Err("Native PDF OCR returned no result.".to_string());
    }
    let payload = unsafe { CStr::from_ptr(pointer).to_string_lossy().into_owned() };
    unsafe { jarvis_free_ocr_result(pointer) };
    let parsed: NativeResult = serde_json::from_str(&payload)
        .map_err(|error| format!("Native PDF OCR returned invalid JSON: {error}"))?;
    if !parsed.success {
        return Err(parsed
            .error
            .unwrap_or_else(|| "Native PDF OCR failed.".to_string()));
    }
    Ok(OcrPage {
        lines: parsed.lines,
        average_confidence: parsed.average_confidence.unwrap_or_default(),
    })
}

#[cfg(not(target_os = "macos"))]
pub fn ocr_pdf_page(
    _path: &Path,
    _zero_based_page_index: usize,
    _max_dimension: usize,
) -> Result<OcrPage, String> {
    Err("Local PDF OCR is currently available only on macOS.".to_string())
}
