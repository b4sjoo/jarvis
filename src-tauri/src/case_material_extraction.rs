use lopdf::Document;
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::panic::{catch_unwind, AssertUnwindSafe};
use tauri::{AppHandle, Manager};
use zip::ZipArchive;

const CONTENT_SOURCES_DIR: &str = "content-sources";
const MAX_IDENTIFIER_CHARS: usize = 128;
const MAX_TEXT_CHARS: usize = 2_000_000;
const MAX_CHUNK_CHARS: usize = 1_800;
const MAX_CHUNKS: usize = 2_000;
const DOCX_XML_MAX_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Clone)]
struct SourceBlock {
    content: String,
    page_number: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeExtractionChunk {
    ordinal: usize,
    content: String,
    page_number: Option<u32>,
    char_start: usize,
    char_end: usize,
    confidence: Option<f32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeExtractionResult {
    method: String,
    engine: String,
    engine_version: String,
    output_hash: String,
    status: String,
    quality_signals: Vec<String>,
    text_chars: usize,
    page_count: Option<usize>,
    chunks: Vec<NativeExtractionChunk>,
}

#[tauri::command]
pub async fn extract_case_material(
    app: AppHandle,
    case_id: String,
    material_id: String,
    extension: String,
) -> Result<NativeExtractionResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_identifier(&case_id, "case id")?;
        validate_identifier(&material_id, "material id")?;
        let extension = normalize_extension(&extension)?;
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
        let material_root = app_data
            .join(CONTENT_SOURCES_DIR)
            .join(&case_id)
            .join(&material_id);
        reject_symlink(&material_root)?;
        let path = material_root.join(format!("original.{extension}"));
        reject_symlink(&path)?;
        if !path.is_file() {
            return Err("Case material original is unavailable.".to_string());
        }
        extract_at_path(&path, extension)
    })
    .await
    .map_err(|error| format!("Case material extraction task failed: {error}"))?
}

fn extract_at_path(path: &Path, extension: &str) -> Result<NativeExtractionResult, String> {
    let (method, blocks, page_count, mut quality_signals) = match extension {
        "txt" | "md" => (
            "native-text",
            text_blocks(&fs::read_to_string(path).map_err(|error| {
                format!("Failed to read local text material: {error}")
            })?),
            None,
            Vec::new(),
        ),
        "docx" => ("native-text", parse_docx(path)?, None, Vec::new()),
        "pdf" => parse_pdf(path)?,
        "png" | "jpg" | "heic" => (
            "native-text",
            Vec::new(),
            None,
            vec!["image-only".to_string()],
        ),
        _ => return Err("Case material format cannot be extracted.".to_string()),
    };

    let (combined, chunks, truncated) = build_chunks(&blocks);
    if truncated {
        quality_signals.push("text-truncated".to_string());
    }
    if combined.trim().is_empty() {
        quality_signals.push("empty".to_string());
    }
    if combined.matches('\u{fffd}').count() > 2 {
        quality_signals.push("replacement-characters".to_string());
    }
    quality_signals.sort();
    quality_signals.dedup();
    let needs_review = quality_signals.iter().any(|code| {
        matches!(
            code.as_str(),
            "empty"
                | "image-only"
                | "embedded-images-unread"
                | "text-truncated"
                | "pdf-page-failed"
                | "replacement-characters"
        )
    });
    let output_hash = format!("{:x}", Sha256::digest(combined.as_bytes()));
    Ok(NativeExtractionResult {
        method: method.to_string(),
        engine: "moss-native-extractor".to_string(),
        engine_version: env!("CARGO_PKG_VERSION").to_string(),
        output_hash,
        status: if needs_review { "needs-review" } else { "ready" }.to_string(),
        quality_signals,
        text_chars: combined.chars().count(),
        page_count,
        chunks,
    })
}

fn parse_docx(path: &Path) -> Result<Vec<SourceBlock>, String> {
    let file = File::open(path)
        .map_err(|error| format!("Failed to open DOCX material: {error}"))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|_| "DOCX material is not a valid OOXML archive.".to_string())?;
    let mut document = archive
        .by_name("word/document.xml")
        .map_err(|_| "DOCX material is missing word/document.xml.".to_string())?;
    if document.size() > DOCX_XML_MAX_BYTES {
        return Err("DOCX document XML exceeds the extraction limit.".to_string());
    }
    let mut xml = String::new();
    document
        .read_to_string(&mut xml)
        .map_err(|_| "DOCX document XML is not valid UTF-8.".to_string())?;

    let mut reader = Reader::from_str(&xml);
    reader.config_mut().trim_text(true);
    let mut blocks = Vec::new();
    let mut paragraph = String::new();
    loop {
        match reader.read_event() {
            Ok(Event::Text(text)) => {
                let value = text
                    .decode()
                    .map_err(|error| format!("Failed to decode DOCX text: {error}"))?;
                if !paragraph.is_empty() {
                    paragraph.push(' ');
                }
                paragraph.push_str(&value);
            }
            Ok(Event::End(element))
                if matches!(element.name().as_ref(), b"w:p" | b"w:tc") =>
            {
                let content = normalize_text(&paragraph);
                paragraph.clear();
                if !content.is_empty() {
                    blocks.push(SourceBlock {
                        content,
                        page_number: None,
                    });
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => return Err(format!("Failed to parse DOCX XML: {error}")),
        }
    }
    Ok(blocks)
}

fn parse_pdf(
    path: &Path,
) -> Result<(&'static str, Vec<SourceBlock>, Option<usize>, Vec<String>), String> {
    match catch_unwind(AssertUnwindSafe(|| parse_pdf_inner(path))) {
        Ok(result) => result,
        Err(_) => Ok((
            "native-text",
            Vec::new(),
            None,
            vec!["pdf-page-failed".to_string()],
        )),
    }
}

fn parse_pdf_inner(
    path: &Path,
) -> Result<(&'static str, Vec<SourceBlock>, Option<usize>, Vec<String>), String> {
    let mut document = Document::load(path)
        .map_err(|error| format!("Failed to load digital PDF: {error}"))?;
    if document.is_encrypted() {
        document
            .decrypt("")
            .map_err(|error| format!("Failed to decrypt PDF: {error}"))?;
    }
    let pages = document.get_pages();
    let page_count = pages.len();
    let mut blocks = Vec::new();
    let mut signals = Vec::new();
    let mut has_images = false;
    for (page_number, page_id) in &pages {
        if document
            .get_page_images(*page_id)
            .is_ok_and(|images| !images.is_empty())
        {
            has_images = true;
        }
        match catch_unwind(AssertUnwindSafe(|| document.extract_text(&[*page_number]))) {
            Ok(Ok(text)) => blocks.extend(text_blocks(&text).into_iter().map(|mut block| {
                block.page_number = Some(*page_number);
                block
            })),
            _ => signals.push("pdf-page-failed".to_string()),
        }
    }
    if has_images {
        signals.push("embedded-images-unread".to_string());
    }
    Ok(("native-text", blocks, Some(page_count), signals))
}

fn text_blocks(content: &str) -> Vec<SourceBlock> {
    content
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .split("\n\n")
        .map(normalize_text)
        .filter(|value| !value.is_empty())
        .map(|content| SourceBlock {
            content,
            page_number: None,
        })
        .collect()
}

fn normalize_text(content: &str) -> String {
    content.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn build_chunks(blocks: &[SourceBlock]) -> (String, Vec<NativeExtractionChunk>, bool) {
    let mut combined = String::new();
    let mut chunks = Vec::new();
    let mut truncated = false;
    for block in blocks {
        for piece in split_block(&block.content) {
            if chunks.len() >= MAX_CHUNKS || combined.chars().count() >= MAX_TEXT_CHARS {
                truncated = true;
                break;
            }
            if !combined.is_empty() {
                combined.push_str("\n\n");
            }
            let start = combined.chars().count();
            let remaining = MAX_TEXT_CHARS.saturating_sub(start);
            let content = piece.chars().take(remaining).collect::<String>();
            combined.push_str(&content);
            let end = combined.chars().count();
            chunks.push(NativeExtractionChunk {
                ordinal: chunks.len(),
                content,
                page_number: block.page_number,
                char_start: start,
                char_end: end,
                confidence: None,
            });
            if piece.chars().count() > remaining {
                truncated = true;
                break;
            }
        }
        if truncated {
            break;
        }
    }
    (combined, chunks, truncated)
}

fn split_block(content: &str) -> Vec<String> {
    if content.chars().count() <= MAX_CHUNK_CHARS {
        return vec![content.to_string()];
    }
    let mut chunks = Vec::new();
    let mut current = String::new();
    for word in content.split_whitespace() {
        let next = current.chars().count() + usize::from(!current.is_empty()) + word.chars().count();
        if next > MAX_CHUNK_CHARS && !current.is_empty() {
            chunks.push(current);
            current = String::new();
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(word);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn normalize_extension(value: &str) -> Result<&'static str, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "txt" => Ok("txt"),
        "md" | "markdown" => Ok("md"),
        "docx" => Ok("docx"),
        "pdf" => Ok("pdf"),
        "png" => Ok("png"),
        "jpg" | "jpeg" => Ok("jpg"),
        "heic" | "heif" => Ok("heic"),
        _ => Err("Unsupported extraction format.".to_string()),
    }
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > MAX_IDENTIFIER_CHARS
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(format!("Invalid {label}."));
    }
    Ok(())
}

fn reject_symlink(path: &PathBuf) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("Case material storage cannot be a symlink.".to_string())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to inspect case material path: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use uuid::Uuid;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    #[test]
    fn text_extraction_chunks_without_losing_offsets() {
        let root = std::env::temp_dir().join(format!("moss-extract-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("notes.txt");
        fs::write(&path, "First fact.\n\nSecond fact.").unwrap();
        let result = extract_at_path(&path, "txt").unwrap();
        assert_eq!(result.status, "ready");
        assert_eq!(result.chunks.len(), 2);
        assert!(result.chunks[1].char_start > result.chunks[0].char_end);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn docx_extraction_reads_document_xml() {
        let root = std::env::temp_dir().join(format!("moss-extract-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("notes.docx");
        let file = File::create(&path).unwrap();
        let mut archive = ZipWriter::new(file);
        archive.start_file("word/document.xml", SimpleFileOptions::default()).unwrap();
        archive.write_all(b"<w:document><w:body><w:p><w:r><w:t>Reference 42</w:t></w:r></w:p></w:body></w:document>").unwrap();
        archive.finish().unwrap();
        let result = extract_at_path(&path, "docx").unwrap();
        assert_eq!(result.chunks[0].content, "Reference 42");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn images_fail_closed_to_needs_review() {
        let root = std::env::temp_dir().join(format!("moss-extract-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("image.png");
        fs::write(&path, b"unused").unwrap();
        let result = extract_at_path(&path, "png").unwrap();
        assert_eq!(result.status, "needs-review");
        assert!(result.quality_signals.contains(&"image-only".to_string()));
        fs::remove_dir_all(root).unwrap();
    }
}
