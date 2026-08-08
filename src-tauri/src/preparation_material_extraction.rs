use crate::preparation_storage::{
    app_data_path, path_to_relative_string, preparation_relative_root, reject_symlink,
    validate_preparation_identifier,
};
use lopdf::{Document, Object};
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::time::Instant;
use tauri::AppHandle;
use uuid::Uuid;
use zip::ZipArchive;

const MAX_EXTRACTED_TEXT_CHARS: usize = 2_000_000;
const MAX_CHUNK_CHARS: usize = 1_800;
const MAX_CHUNKS: usize = 2_000;
const DOCX_DOCUMENT_MAX_BYTES: u64 = 20 * 1024 * 1024;
const SUBSTANTIVE_IMAGE_MIN_SHORT_EDGE: i64 = 200;
const SUBSTANTIVE_IMAGE_MIN_PIXELS: i64 = 200_000;

#[derive(Debug, Clone)]
struct SourceBlock {
    content: String,
    page: Option<u32>,
    section: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedPreparationChunk {
    ordinal: usize,
    content: String,
    search_text: String,
    page: Option<u32>,
    section: Option<String>,
    start_offset: usize,
    end_offset: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparationMaterialExtractionResult {
    method: String,
    status: String,
    extracted_text_relative_path: Option<String>,
    text_chars: usize,
    page_count: Option<usize>,
    warning_codes: Vec<String>,
    duration_ms: u128,
    chunks: Vec<ExtractedPreparationChunk>,
}

struct ParsedMaterial {
    method: &'static str,
    blocks: Vec<SourceBlock>,
    page_count: Option<usize>,
    warning_codes: Vec<String>,
}

#[tauri::command]
pub async fn extract_preparation_material_file(
    app: AppHandle,
    workspace_kind: String,
    workspace_id: String,
    material_id: String,
    revision: u32,
    request_id: String,
    extension: String,
) -> Result<PreparationMaterialExtractionResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let relative_root = preparation_relative_root(&workspace_kind, &workspace_id)?;
        let workspace_root = app_data_path(&app, &relative_root)?;
        extract_material_at_root(
            &workspace_root,
            &relative_root,
            &material_id,
            revision,
            &request_id,
            &extension,
        )
    })
    .await
    .map_err(|error| format!("Preparation extraction task failed: {error}"))?
}

#[tauri::command]
pub fn discard_preparation_material_extraction_file(
    app: AppHandle,
    workspace_kind: String,
    workspace_id: String,
    material_id: String,
    revision: u32,
    request_id: String,
) -> Result<bool, String> {
    validate_preparation_identifier(&material_id, "material id")?;
    validate_preparation_identifier(&request_id, "extraction request id")?;
    if revision == 0 {
        return Err("Preparation extraction revision must be positive.".to_string());
    }
    let relative_root = preparation_relative_root(&workspace_kind, &workspace_id)?;
    let workspace_root = app_data_path(&app, &relative_root)?;
    discard_extracted_text(&workspace_root, &material_id, revision, &request_id)
}

fn extract_material_at_root(
    workspace_root: &Path,
    workspace_relative_root: &Path,
    material_id: &str,
    revision: u32,
    request_id: &str,
    extension: &str,
) -> Result<PreparationMaterialExtractionResult, String> {
    validate_preparation_identifier(material_id, "material id")?;
    validate_preparation_identifier(request_id, "extraction request id")?;
    if revision == 0 {
        return Err("Preparation extraction revision must be positive.".to_string());
    }
    let extension = normalize_extension(extension)?;
    reject_symlink(workspace_root)?;
    let material_root = workspace_root.join("materials").join(material_id);
    reject_symlink(&material_root)?;
    let original_path = material_root.join(format!("original.{extension}"));
    reject_symlink(&original_path)?;
    if !original_path.is_file() {
        return Err("Preparation material original is unavailable.".to_string());
    }

    let started = Instant::now();
    let mut parsed = parse_material(&original_path, extension)?;
    let (text, chunks, truncated) = build_chunks(&parsed.blocks);
    if truncated {
        parsed.warning_codes.push("text-truncated".to_string());
    }
    if !truncated
        && parsed.page_count.is_some_and(|page_count| page_count > 0)
        && chunks
            .iter()
            .filter_map(|chunk| chunk.page)
            .collect::<std::collections::HashSet<_>>()
            .len()
            < parsed.page_count.unwrap_or_default()
        && !chunks.is_empty()
    {
        parsed.warning_codes.push("empty-pages".to_string());
    }
    parsed.warning_codes.sort();
    parsed.warning_codes.dedup();

    let status = if text.trim().is_empty() {
        if !parsed
            .warning_codes
            .iter()
            .any(|code| code == "ocr-required")
        {
            parsed.warning_codes.push("empty-extraction".to_string());
        }
        "needs-review"
    } else if parsed
        .warning_codes
        .iter()
        .any(|code| warning_requires_review(code))
    {
        "needs-review"
    } else {
        "ready"
    };

    let extracted_text_relative_path = if text.trim().is_empty() {
        None
    } else {
        Some(write_extracted_text(
            workspace_root,
            workspace_relative_root,
            material_id,
            revision,
            request_id,
            &text,
        )?)
    };

    Ok(PreparationMaterialExtractionResult {
        method: parsed.method.to_string(),
        status: status.to_string(),
        extracted_text_relative_path,
        text_chars: text.chars().count(),
        page_count: parsed.page_count,
        warning_codes: parsed.warning_codes,
        duration_ms: started.elapsed().as_millis(),
        chunks,
    })
}

fn normalize_extension(extension: &str) -> Result<&str, String> {
    match extension.trim().to_ascii_lowercase().as_str() {
        "txt" => Ok("txt"),
        "md" | "markdown" => Ok("md"),
        "docx" => Ok("docx"),
        "pdf" => Ok("pdf"),
        "png" => Ok("png"),
        "jpg" | "jpeg" => Ok("jpg"),
        "heic" | "heif" => Ok("heic"),
        _ => Err("Preparation material format cannot be extracted.".to_string()),
    }
}

fn parse_material(path: &Path, extension: &str) -> Result<ParsedMaterial, String> {
    match extension {
        "txt" => Ok(ParsedMaterial {
            method: "plain-text",
            blocks: parse_plain_text(&read_utf8(path)?),
            page_count: None,
            warning_codes: Vec::new(),
        }),
        "md" => Ok(ParsedMaterial {
            method: "markdown",
            blocks: parse_markdown(&read_utf8(path)?),
            page_count: None,
            warning_codes: Vec::new(),
        }),
        "docx" => Ok(ParsedMaterial {
            method: "docx-text",
            blocks: parse_docx(path)?,
            page_count: None,
            warning_codes: Vec::new(),
        }),
        "pdf" => parse_pdf(path),
        "png" | "jpg" | "heic" => Ok(ParsedMaterial {
            method: "none",
            blocks: Vec::new(),
            page_count: None,
            warning_codes: vec!["ocr-required".to_string()],
        }),
        _ => Err("Preparation material format cannot be extracted.".to_string()),
    }
}

fn warning_requires_review(code: &str) -> bool {
    matches!(
        code,
        "empty-pages"
            | "text-truncated"
            | "embedded-images-unread"
            | "pdf-page-extraction-failed"
            | "pdf-page-parser-panic"
            | "pdf-parser-panic"
    )
}

fn parse_pdf(path: &Path) -> Result<ParsedMaterial, String> {
    match catch_unwind(AssertUnwindSafe(|| parse_pdf_inner(path))) {
        Ok(result) => result,
        Err(_) => Ok(ParsedMaterial {
            method: "pdf-text",
            blocks: Vec::new(),
            page_count: None,
            warning_codes: vec!["pdf-parser-panic".to_string()],
        }),
    }
}

fn parse_pdf_inner(path: &Path) -> Result<ParsedMaterial, String> {
    let mut document = Document::load(path)
        .map_err(|error| format!("Digital PDF document loading failed: {error}"))?;
    if document.is_encrypted() {
        document
            .decrypt("")
            .map_err(|error| format!("Digital PDF decryption failed: {error}"))?;
    }

    let page_count = document.get_pages().len();
    let mut warning_codes = Vec::new();
    if count_substantive_pdf_images(&document) > 0 {
        warning_codes.push("embedded-images-unread".to_string());
    }

    let mut blocks = Vec::new();
    for page_number in 1..=page_count as u32 {
        let result = catch_unwind(AssertUnwindSafe(|| document.extract_text(&[page_number])));
        match result {
            Ok(Ok(page_text)) => {
                blocks.extend(parse_plain_text(&page_text).into_iter().map(|mut block| {
                    block.page = Some(page_number);
                    block
                }));
            }
            Ok(Err(_)) => warning_codes.push("pdf-page-extraction-failed".to_string()),
            Err(_) => {
                #[cfg(test)]
                eprintln!("pdf page parser panic: page {page_number}");
                warning_codes.push("pdf-page-parser-panic".to_string());
            }
        }
    }

    Ok(ParsedMaterial {
        method: "pdf-text",
        blocks,
        page_count: Some(page_count),
        warning_codes,
    })
}

fn count_substantive_pdf_images(document: &Document) -> usize {
    document
        .objects
        .values()
        .filter_map(|object| object.as_stream().ok())
        .filter(|stream| {
            stream
                .dict
                .get(b"Subtype")
                .and_then(Object::as_name)
                .is_ok_and(|name| name == b"Image")
        })
        .filter(|stream| {
            let width = stream
                .dict
                .get(b"Width")
                .and_then(Object::as_i64)
                .unwrap_or_default();
            let height = stream
                .dict
                .get(b"Height")
                .and_then(Object::as_i64)
                .unwrap_or_default();
            width.min(height) >= SUBSTANTIVE_IMAGE_MIN_SHORT_EDGE
                && width.saturating_mul(height) >= SUBSTANTIVE_IMAGE_MIN_PIXELS
        })
        .count()
}

fn read_utf8(path: &Path) -> Result<String, String> {
    fs::read_to_string(path)
        .map_err(|error| format!("Failed to read preparation text material: {error}"))
}

fn parse_plain_text(content: &str) -> Vec<SourceBlock> {
    normalized_paragraphs(content)
        .into_iter()
        .map(|content| SourceBlock {
            content,
            page: None,
            section: None,
        })
        .collect()
}

fn parse_markdown(content: &str) -> Vec<SourceBlock> {
    let mut blocks = Vec::new();
    let mut heading_path: Vec<String> = Vec::new();
    let mut buffer: Vec<String> = Vec::new();
    let mut in_fence = false;

    let flush = |blocks: &mut Vec<SourceBlock>, buffer: &mut Vec<String>, path: &[String]| {
        let text = normalize_block(&buffer.join("\n"));
        buffer.clear();
        if !text.is_empty() {
            blocks.push(SourceBlock {
                content: text,
                page: None,
                section: (!path.is_empty()).then(|| path.join(" > ")),
            });
        }
    };

    for line in content.replace("\r\n", "\n").replace('\r', "\n").lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            buffer.push(line.to_string());
            continue;
        }
        if !in_fence {
            let hashes = trimmed
                .chars()
                .take_while(|character| *character == '#')
                .count();
            if (1..=6).contains(&hashes)
                && trimmed.chars().nth(hashes).is_some_and(char::is_whitespace)
            {
                flush(&mut blocks, &mut buffer, &heading_path);
                let heading = trimmed[hashes..].trim().to_string();
                heading_path.truncate(hashes - 1);
                heading_path.push(heading.clone());
                blocks.push(SourceBlock {
                    content: heading,
                    page: None,
                    section: Some(heading_path.join(" > ")),
                });
                continue;
            }
            if trimmed.is_empty() {
                flush(&mut blocks, &mut buffer, &heading_path);
                continue;
            }
        }
        buffer.push(line.to_string());
    }
    flush(&mut blocks, &mut buffer, &heading_path);
    blocks
}

fn parse_docx(path: &Path) -> Result<Vec<SourceBlock>, String> {
    let file =
        File::open(path).map_err(|error| format!("Failed to open DOCX for extraction: {error}"))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|_| "Stored DOCX is no longer a valid OOXML archive.".to_string())?;
    let mut document = archive
        .by_name("word/document.xml")
        .map_err(|_| "Stored DOCX is missing its main document.".to_string())?;
    if document.size() > DOCX_DOCUMENT_MAX_BYTES {
        return Err("DOCX main document exceeds the extraction limit.".to_string());
    }
    let mut xml = String::new();
    document
        .read_to_string(&mut xml)
        .map_err(|_| "DOCX main document is not valid UTF-8 XML.".to_string())?;
    parse_docx_xml(&xml)
}

fn parse_docx_xml(xml: &str) -> Result<Vec<SourceBlock>, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut blocks = Vec::new();
    let mut paragraph = String::new();
    let mut paragraph_style: Option<String> = None;
    let mut heading_path: Vec<String> = Vec::new();
    let mut in_paragraph = false;
    let mut in_text = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => match event.local_name().as_ref() {
                b"p" => {
                    in_paragraph = true;
                    paragraph.clear();
                    paragraph_style = None;
                }
                b"t" if in_paragraph => in_text = true,
                b"pStyle" if in_paragraph => {
                    paragraph_style = attribute_value(&event, &reader, b"val")?;
                }
                _ => {}
            },
            Ok(Event::Empty(event)) if in_paragraph => match event.local_name().as_ref() {
                b"tab" => paragraph.push('\t'),
                b"br" | b"cr" => paragraph.push('\n'),
                b"pStyle" => paragraph_style = attribute_value(&event, &reader, b"val")?,
                _ => {}
            },
            Ok(Event::Text(event)) if in_text && in_paragraph => {
                paragraph.push_str(
                    &event
                        .xml_content()
                        .map_err(|error| format!("DOCX text decode failed: {error}"))?,
                );
            }
            Ok(Event::CData(event)) if in_text && in_paragraph => {
                paragraph.push_str(
                    &event
                        .decode()
                        .map_err(|error| format!("DOCX text decode failed: {error}"))?,
                );
            }
            Ok(Event::End(event)) => match event.local_name().as_ref() {
                b"t" => in_text = false,
                b"p" if in_paragraph => {
                    let content = normalize_block(&paragraph);
                    if !content.is_empty() {
                        if let Some(level) = heading_level(paragraph_style.as_deref()) {
                            heading_path.truncate(level.saturating_sub(1));
                            heading_path.push(content.clone());
                        }
                        blocks.push(SourceBlock {
                            content,
                            page: None,
                            section: (!heading_path.is_empty()).then(|| heading_path.join(" > ")),
                        });
                    }
                    in_paragraph = false;
                    in_text = false;
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(error) => return Err(format!("DOCX XML parsing failed: {error}")),
            _ => {}
        }
    }
    Ok(blocks)
}

fn attribute_value(
    event: &BytesStart<'_>,
    reader: &Reader<&[u8]>,
    local_name: &[u8],
) -> Result<Option<String>, String> {
    for attribute in event.attributes().with_checks(false) {
        let attribute =
            attribute.map_err(|error| format!("DOCX attribute parsing failed: {error}"))?;
        if attribute.key.local_name().as_ref() == local_name {
            return attribute
                .decode_and_unescape_value(reader.decoder())
                .map(|value| Some(value.into_owned()))
                .map_err(|error| format!("DOCX attribute decode failed: {error}"));
        }
    }
    Ok(None)
}

fn heading_level(style: Option<&str>) -> Option<usize> {
    let normalized = style?.to_ascii_lowercase().replace([' ', '_', '-'], "");
    if normalized == "title" {
        return Some(1);
    }
    normalized
        .strip_prefix("heading")
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|level| (1..=6).contains(level))
}

fn normalized_paragraphs(content: &str) -> Vec<String> {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let mut paragraphs = Vec::new();
    let mut buffer = Vec::new();
    for line in normalized.lines() {
        if line.trim().is_empty() {
            let paragraph = normalize_block(&buffer.join("\n"));
            if !paragraph.is_empty() {
                paragraphs.push(paragraph);
            }
            buffer.clear();
        } else {
            buffer.push(line.to_string());
        }
    }
    let paragraph = normalize_block(&buffer.join("\n"));
    if !paragraph.is_empty() {
        paragraphs.push(paragraph);
    }
    paragraphs
}

fn normalize_block(content: &str) -> String {
    content
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn build_chunks(blocks: &[SourceBlock]) -> (String, Vec<ExtractedPreparationChunk>, bool) {
    let mut text = String::new();
    let mut chunks: Vec<ExtractedPreparationChunk> = Vec::new();
    let mut char_count = 0_usize;
    let mut truncated = false;

    'blocks: for block in blocks {
        for piece in split_to_limit(&block.content, MAX_CHUNK_CHARS) {
            if chunks.len() >= MAX_CHUNKS || char_count >= MAX_EXTRACTED_TEXT_CHARS {
                truncated = true;
                break 'blocks;
            }
            let separator_chars = usize::from(!text.is_empty()) * 2;
            let remaining = MAX_EXTRACTED_TEXT_CHARS
                .saturating_sub(char_count)
                .saturating_sub(separator_chars);
            if remaining == 0 {
                truncated = true;
                break 'blocks;
            }
            let piece_chars = piece.chars().count();
            let accepted = if piece_chars > remaining {
                truncated = true;
                truncate_chars(&piece, remaining)
            } else {
                piece
            };
            if accepted.is_empty() {
                break 'blocks;
            }

            let can_merge = chunks.last().is_some_and(|chunk| {
                chunk.page == block.page
                    && chunk.section == block.section
                    && chunk.content.chars().count() + 2 + accepted.chars().count()
                        <= MAX_CHUNK_CHARS
            });
            if !text.is_empty() {
                text.push_str("\n\n");
                char_count += 2;
            }
            let start_offset = char_count;
            text.push_str(&accepted);
            char_count += accepted.chars().count();

            if can_merge {
                let chunk = chunks
                    .last_mut()
                    .expect("chunk exists when merge is allowed");
                chunk.content.push_str("\n\n");
                chunk.content.push_str(&accepted);
                chunk.search_text = normalize_search_text(&chunk.content);
                chunk.end_offset = char_count;
            } else {
                chunks.push(ExtractedPreparationChunk {
                    ordinal: chunks.len(),
                    content: accepted,
                    search_text: String::new(),
                    page: block.page,
                    section: block.section.clone(),
                    start_offset,
                    end_offset: char_count,
                });
                let chunk = chunks.last_mut().expect("new chunk exists");
                chunk.search_text = normalize_search_text(&chunk.content);
            }
            if truncated {
                break 'blocks;
            }
        }
    }

    (text, chunks, truncated)
}

fn split_to_limit(content: &str, max_chars: usize) -> Vec<String> {
    if content.chars().count() <= max_chars {
        return (!content.is_empty())
            .then(|| content.to_string())
            .into_iter()
            .collect();
    }
    let mut pieces = Vec::new();
    let mut remaining = content.trim();
    while !remaining.is_empty() {
        let candidate = truncate_chars(remaining, max_chars);
        let split_byte = if candidate.len() < remaining.len() {
            candidate
                .rfind(char::is_whitespace)
                .filter(|index| *index >= max_chars / 2)
                .unwrap_or(candidate.len())
        } else {
            candidate.len()
        };
        let (head, tail) = remaining.split_at(split_byte);
        let head = head.trim();
        if !head.is_empty() {
            pieces.push(head.to_string());
        }
        remaining = tail.trim_start();
    }
    pieces
}

fn truncate_chars(content: &str, max_chars: usize) -> String {
    content.chars().take(max_chars).collect()
}

fn normalize_search_text(content: &str) -> String {
    content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn write_extracted_text(
    workspace_root: &Path,
    workspace_relative_root: &Path,
    material_id: &str,
    revision: u32,
    request_id: &str,
    text: &str,
) -> Result<String, String> {
    let extraction_root = workspace_root
        .join("materials")
        .join(material_id)
        .join("extraction")
        .join(revision.to_string());
    reject_symlink(&extraction_root)?;
    fs::create_dir_all(&extraction_root)
        .map_err(|error| format!("Failed to create preparation extraction storage: {error}"))?;
    let file_name = format!("extracted-{request_id}.txt");
    let target = extraction_root.join(&file_name);
    let staging = extraction_root.join(format!(".{file_name}-{}.partial", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&staging)
        .map_err(|error| format!("Failed to stage extracted text: {error}"))?;
    if let Err(error) = file
        .write_all(text.as_bytes())
        .and_then(|_| file.sync_all())
    {
        let _ = fs::remove_file(&staging);
        return Err(format!("Failed to write extracted text: {error}"));
    }
    fs::rename(&staging, &target).map_err(|error| {
        let _ = fs::remove_file(&staging);
        format!("Failed to commit extracted text: {error}")
    })?;
    Ok(path_to_relative_string(
        &workspace_relative_root
            .join("materials")
            .join(material_id)
            .join("extraction")
            .join(revision.to_string())
            .join(file_name),
    ))
}

fn discard_extracted_text(
    workspace_root: &Path,
    material_id: &str,
    revision: u32,
    request_id: &str,
) -> Result<bool, String> {
    let material_root = workspace_root.join("materials").join(material_id);
    let extraction_root = material_root.join("extraction");
    let revision_root = extraction_root.join(revision.to_string());
    let target = revision_root.join(format!("extracted-{request_id}.txt"));

    for path in [
        workspace_root,
        material_root.as_path(),
        extraction_root.as_path(),
        revision_root.as_path(),
        target.as_path(),
    ] {
        reject_symlink(path)?;
    }
    if !target.exists() {
        return Ok(false);
    }
    if !target.is_file() {
        return Err("Preparation extraction output is not a regular file.".to_string());
    }
    fs::remove_file(&target)
        .map_err(|error| format!("Failed to discard stale extracted text: {error}"))?;
    remove_directory_if_empty(&revision_root)?;
    remove_directory_if_empty(&extraction_root)?;
    remove_directory_if_empty(&material_root)?;
    Ok(true)
}

fn remove_directory_if_empty(path: &Path) -> Result<(), String> {
    if !path.is_dir() {
        return Ok(());
    }
    let mut entries = fs::read_dir(path)
        .map_err(|error| format!("Failed to inspect preparation extraction storage: {error}"))?;
    if entries.next().is_none() {
        fs::remove_dir(path)
            .map_err(|error| format!("Failed to clean preparation extraction storage: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fmt::Write as _;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    #[test]
    fn markdown_preserves_heading_path_and_chunk_offsets() {
        let blocks = parse_markdown(
            "# Interview\n\nOpening notes.\n\n## Coding\n\nUse a deque for the window.",
        );
        let (text, chunks, truncated) = build_chunks(&blocks);

        assert!(!truncated);
        assert!(text.contains("Use a deque"));
        assert_eq!(
            chunks.last().and_then(|chunk| chunk.section.as_deref()),
            Some("Interview > Coding")
        );
        assert_eq!(
            chunks.last().map(|chunk| chunk.end_offset),
            Some(text.chars().count())
        );
    }

    #[test]
    fn docx_xml_preserves_headings_paragraphs_and_table_order() {
        let xml = r#"<w:document xmlns:w="wordprocessingml"><w:body>
          <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Agentic Memory</w:t></w:r></w:p>
          <w:p><w:r><w:t>Stores durable facts.</w:t></w:r></w:p>
          <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Latency</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42 ms</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
        </w:body></w:document>"#;
        let blocks = parse_docx_xml(xml).unwrap();

        assert_eq!(blocks.len(), 4);
        assert_eq!(blocks[0].section.as_deref(), Some("Agentic Memory"));
        assert_eq!(blocks[1].content, "Stores durable facts.");
        assert_eq!(blocks[2].content, "Latency");
        assert_eq!(blocks[3].content, "42 ms");
    }

    #[test]
    fn extracts_a_docx_into_revision_owned_text() {
        let root = std::env::temp_dir().join(format!("jarvis-extraction-test-{}", Uuid::new_v4()));
        let material_root = root.join("materials/material-1");
        fs::create_dir_all(&material_root).unwrap();
        let docx = material_root.join("original.docx");
        let file = File::create(&docx).unwrap();
        let mut archive = ZipWriter::new(file);
        archive
            .start_file("word/document.xml", SimpleFileOptions::default())
            .unwrap();
        archive
            .write_all(b"<w:document xmlns:w=\"wordprocessingml\"><w:body><w:p><w:r><w:t>Interview guide</w:t></w:r></w:p></w:body></w:document>")
            .unwrap();
        archive.finish().unwrap();

        let result = extract_material_at_root(
            &root,
            Path::new("interview-preparation/workspace-1"),
            "material-1",
            1,
            "request-1",
            "docx",
        )
        .unwrap();

        assert_eq!(result.status, "ready");
        assert_eq!(result.chunks.len(), 1);
        assert_eq!(result.chunks[0].content, "Interview guide");
        assert!(root
            .join("materials/material-1/extraction/1/extracted-request-1.txt")
            .is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn extracts_a_digital_pdf_with_page_provenance() {
        let root = std::env::temp_dir().join(format!("jarvis-extraction-test-{}", Uuid::new_v4()));
        let material_root = root.join("materials/material-1");
        fs::create_dir_all(&material_root).unwrap();
        write_single_page_pdf(
            &material_root.join("original.pdf"),
            "Design a retrieval system",
        );

        let result = extract_material_at_root(
            &root,
            Path::new("interview-preparation/workspace-1"),
            "material-1",
            1,
            "request-1",
            "pdf",
        )
        .unwrap();

        assert_eq!(result.method, "pdf-text");
        assert_eq!(result.status, "ready");
        assert_eq!(result.page_count, Some(1));
        assert_eq!(result.chunks[0].page, Some(1));
        assert!(result.chunks[0].content.contains("retrieval system"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tolerates_malformed_pdf_operations_without_failing_the_document() {
        let root = std::env::temp_dir().join(format!("jarvis-extraction-test-{}", Uuid::new_v4()));
        let material_root = root.join("materials/material-1");
        fs::create_dir_all(&material_root).unwrap();
        write_pdf_with_malformed_form(
            &material_root.join("original.pdf"),
            "Recovered interview material",
        );

        let result = extract_material_at_root(
            &root,
            Path::new("interview-preparation/workspace-1"),
            "material-1",
            1,
            "request-1",
            "pdf",
        )
        .unwrap();

        assert_eq!(result.status, "ready");
        assert!(result
            .chunks
            .iter()
            .any(|chunk| chunk.content.contains("Recovered interview material")));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn mixed_pdf_with_substantive_images_requires_review() {
        let root = std::env::temp_dir().join(format!("jarvis-extraction-test-{}", Uuid::new_v4()));
        let material_root = root.join("materials/material-1");
        fs::create_dir_all(&material_root).unwrap();
        write_pdf_with_image(
            &material_root.join("original.pdf"),
            "Question text remains readable",
            936,
            364,
        );

        let result = extract_material_at_root(
            &root,
            Path::new("interview-preparation/workspace-1"),
            "material-1",
            1,
            "request-1",
            "pdf",
        )
        .unwrap();

        assert_eq!(result.status, "needs-review");
        assert!(result
            .warning_codes
            .iter()
            .any(|code| code == "embedded-images-unread"));
        assert!(result
            .chunks
            .iter()
            .any(|chunk| chunk.content.contains("Question text remains readable")));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn small_decorative_pdf_image_does_not_block_ready_status() {
        let root = std::env::temp_dir().join(format!("jarvis-extraction-test-{}", Uuid::new_v4()));
        let material_root = root.join("materials/material-1");
        fs::create_dir_all(&material_root).unwrap();
        write_pdf_with_image(
            &material_root.join("original.pdf"),
            "Digital material with a logo",
            312,
            104,
        );

        let result = extract_material_at_root(
            &root,
            Path::new("interview-preparation/workspace-1"),
            "material-1",
            1,
            "request-1",
            "pdf",
        )
        .unwrap();

        assert_eq!(result.status, "ready");
        assert!(!result
            .warning_codes
            .iter()
            .any(|code| code == "embedded-images-unread"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "set JARVIS_PDF_EXTRACTION_EVAL_PATH to a private real-world PDF"]
    fn evaluates_external_pdf_fixture_without_task_panic() {
        let path = std::env::var("JARVIS_PDF_EXTRACTION_EVAL_PATH")
            .expect("JARVIS_PDF_EXTRACTION_EVAL_PATH must be set");
        let root = std::env::temp_dir().join(format!("jarvis-extraction-eval-{}", Uuid::new_v4()));
        let material_root = root.join("materials/material-1");
        fs::create_dir_all(&material_root).unwrap();
        fs::copy(&path, material_root.join("original.pdf")).unwrap();
        let result = extract_material_at_root(
            &root,
            Path::new("interview-preparation/workspace-1"),
            "material-1",
            1,
            "request-1",
            "pdf",
        )
        .unwrap();

        eprintln!(
            "status={} pages={:?} chars={} chunks={} duration_ms={} warnings={:?}",
            result.status,
            result.page_count,
            result.text_chars,
            result.chunks.len(),
            result.duration_ms,
            result.warning_codes
        );
        assert!(result.page_count.is_some_and(|count| count > 0));
        assert!(result.text_chars > 0);
        assert!(!result.chunks.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn image_material_requires_explicit_ocr() {
        let parsed = parse_material(Path::new("unused.png"), "png").unwrap();
        assert!(parsed.blocks.is_empty());
        assert_eq!(parsed.warning_codes, vec!["ocr-required"]);
    }

    #[test]
    fn discards_only_the_request_owned_extraction_file() {
        let root = std::env::temp_dir().join(format!("jarvis-extraction-test-{}", Uuid::new_v4()));
        let revision_root = root.join("materials/material-1/extraction/1");
        fs::create_dir_all(&revision_root).unwrap();
        fs::write(revision_root.join("extracted-request-1.txt"), "stale").unwrap();
        fs::write(revision_root.join("extracted-request-2.txt"), "current").unwrap();

        assert!(discard_extracted_text(&root, "material-1", 1, "request-1").unwrap());
        assert!(!revision_root.join("extracted-request-1.txt").exists());
        assert!(revision_root.join("extracted-request-2.txt").is_file());

        fs::remove_dir_all(root).unwrap();
    }

    fn write_single_page_pdf(path: &Path, text: &str) {
        let escaped = text
            .replace('\\', "\\\\")
            .replace('(', "\\(")
            .replace(')', "\\)");
        let stream = format!("BT\n/F1 12 Tf\n72 720 Td\n({escaped}) Tj\nET\n");
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".to_string(),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_string(),
            format!("<< /Length {} >>\nstream\n{stream}endstream", stream.len()),
        ];
        write_pdf_objects(path, &objects);
    }

    fn write_pdf_with_malformed_form(path: &Path, text: &str) {
        let escaped = text
            .replace('\\', "\\\\")
            .replace('(', "\\(")
            .replace(')', "\\)");
        let page_stream = format!("/Fm1 Do\nBT\n/F1 12 Tf\n72 720 Td\n({escaped}) Tj\nET\n");
        let form_stream = "CS\n";
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> /XObject << /Fm1 6 0 R >> >> /Contents 5 0 R >>".to_string(),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_string(),
            format!("<< /Length {} >>\nstream\n{page_stream}endstream", page_stream.len()),
            format!("<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] /Length {} >>\nstream\n{form_stream}endstream", form_stream.len()),
        ];
        write_pdf_objects(path, &objects);
    }

    fn write_pdf_with_image(path: &Path, text: &str, width: i64, height: i64) {
        let escaped = text
            .replace('\\', "\\\\")
            .replace('(', "\\(")
            .replace(')', "\\)");
        let page_stream = format!("BT\n/F1 12 Tf\n72 720 Td\n({escaped}) Tj\nET\nq\n/Im1 Do\nQ\n");
        let image_stream = "Tm\n";
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 5 0 R >>".to_string(),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_string(),
            format!("<< /Length {} >>\nstream\n{page_stream}endstream", page_stream.len()),
            format!("<< /Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode /Length {} >>\nstream\n{image_stream}endstream", image_stream.len()),
        ];
        write_pdf_objects(path, &objects);
    }

    fn write_pdf_objects(path: &Path, objects: &[String]) {
        let mut pdf = String::from("%PDF-1.4\n");
        let mut offsets = Vec::with_capacity(objects.len());
        for (index, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            writeln!(&mut pdf, "{} 0 obj\n{}\nendobj", index + 1, object).unwrap();
        }
        let xref_offset = pdf.len();
        writeln!(&mut pdf, "xref\n0 {}", objects.len() + 1).unwrap();
        pdf.push_str("0000000000 65535 f \n");
        for offset in offsets {
            writeln!(&mut pdf, "{offset:010} 00000 n ").unwrap();
        }
        writeln!(
            &mut pdf,
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF",
            objects.len() + 1
        )
        .unwrap();
        fs::write(path, pdf).unwrap();
    }
}
