use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use uuid::Uuid;
use zip::ZipArchive;

const CONTENT_SOURCES_DIR: &str = "content-sources";
const MAX_IDENTIFIER_CHARS: usize = 128;
const TEXT_MAX_BYTES: u64 = 10 * 1024 * 1024;
const IMAGE_MAX_BYTES: u64 = 25 * 1024 * 1024;
const PDF_MAX_BYTES: u64 = 50 * 1024 * 1024;
const DOCX_MAX_BYTES: u64 = 25 * 1024 * 1024;
const DOCX_MAX_ENTRIES: usize = 512;
const DOCX_MAX_UNCOMPRESSED_BYTES: u64 = 100 * 1024 * 1024;
const DOCX_CONTENT_TYPES_MAX_BYTES: u64 = 1024 * 1024;
const COPY_BUFFER_BYTES: usize = 64 * 1024;
const MULTIMODAL_READ_MAX_BYTES: u64 = 50 * 1024 * 1024;
const DOCX_MIME_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCX_MAIN_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedContentFile {
    original_file_name: String,
    mime_type: String,
    extension: String,
    size_bytes: u64,
    checksum_sha256: String,
    storage_relative_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentFilePayload {
    mime_type: String,
    extension: String,
    size_bytes: u64,
    checksum_sha256: String,
    base64_data: String,
}

#[derive(Clone, Copy)]
struct ContentFormat {
    extension: &'static str,
    mime_type: &'static str,
    max_bytes: u64,
}

#[tauri::command]
pub fn import_content_file(
    app: AppHandle,
    collection_id: String,
    content_id: String,
    source_path: String,
) -> Result<ImportedContentFile, String> {
    validate_identifier(&collection_id, "collection id")?;
    let relative_root = PathBuf::from(CONTENT_SOURCES_DIR).join(&collection_id);
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    import_content_at_root(
        &app_data.join(&relative_root),
        &relative_root,
        &content_id,
        Path::new(&source_path),
    )
}

#[tauri::command]
pub fn delete_content_file(
    app: AppHandle,
    collection_id: String,
    content_id: String,
) -> Result<bool, String> {
    validate_identifier(&collection_id, "collection id")?;
    validate_identifier(&content_id, "content id")?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    let collection_root = app_data.join(CONTENT_SOURCES_DIR).join(&collection_id);
    let content_root = collection_root.join(&content_id);
    reject_symlink(&collection_root)?;
    reject_symlink(&content_root)?;
    if !content_root.exists() {
        return Ok(false);
    }
    if !content_root.is_dir() {
        return Err("Content storage is not a directory.".to_string());
    }
    for entry in fs::read_dir(&content_root)
        .map_err(|error| format!("Failed to inspect content storage: {error}"))?
    {
        let path = entry
            .map_err(|error| format!("Failed to inspect content storage: {error}"))?
            .path();
        reject_symlink(&path)?;
    }
    fs::remove_dir_all(&content_root)
        .map_err(|error| format!("Failed to delete content storage: {error}"))?;
    if collection_root
        .read_dir()
        .map_err(|error| format!("Failed to inspect content collection: {error}"))?
        .next()
        .is_none()
    {
        fs::remove_dir(&collection_root)
            .map_err(|error| format!("Failed to clean empty content collection: {error}"))?;
    }
    Ok(true)
}

#[tauri::command]
pub fn read_content_file_base64(
    app: AppHandle,
    collection_id: String,
    content_id: String,
    extension: String,
) -> Result<ContentFilePayload, String> {
    validate_identifier(&collection_id, "collection id")?;
    validate_identifier(&content_id, "content id")?;
    let extension = extension.trim().to_ascii_lowercase();
    let mime_type = match extension.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "heic" | "heif" => "image/heic",
        _ => return Err("Only PDF and image materials support multimodal recovery.".to_string()),
    };
    let normalized_extension = if extension == "jpeg" {
        "jpg"
    } else if extension == "heif" {
        "heic"
    } else {
        extension.as_str()
    };
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    let collection_root = app_data.join(CONTENT_SOURCES_DIR).join(&collection_id);
    let content_root = collection_root.join(&content_id);
    let path = content_root.join(format!("original.{normalized_extension}"));
    reject_symlink(&collection_root)?;
    reject_symlink(&content_root)?;
    reject_symlink(&path)?;
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("Failed to inspect material for recovery: {error}"))?;
    if !metadata.is_file() || metadata.len() > MULTIMODAL_READ_MAX_BYTES {
        return Err("Material cannot be loaded within the multimodal size limit.".to_string());
    }
    let bytes = fs::read(&path)
        .map_err(|error| format!("Failed to read material for recovery: {error}"))?;
    let checksum_sha256 = format!("{:x}", Sha256::digest(&bytes));
    Ok(ContentFilePayload {
        mime_type: mime_type.to_string(),
        extension: normalized_extension.to_string(),
        size_bytes: metadata.len(),
        checksum_sha256,
        base64_data: STANDARD.encode(bytes),
    })
}

fn import_content_at_root(
    collection_root: &Path,
    collection_relative_root: &Path,
    content_id: &str,
    source_path: &Path,
) -> Result<ImportedContentFile, String> {
    validate_identifier(content_id, "content id")?;
    reject_symlink(collection_root)?;

    let source_metadata = fs::symlink_metadata(source_path)
        .map_err(|error| format!("Failed to inspect selected content: {error}"))?;
    if source_metadata.file_type().is_symlink() || !source_metadata.is_file() {
        return Err("Selected content must be a regular file.".to_string());
    }

    let original_file_name = source_path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Selected content has no valid file name.".to_string())?
        .to_string();
    let format = detect_content_format(source_path, source_metadata.len())?;

    fs::create_dir_all(collection_root)
        .map_err(|error| format!("Failed to create content collection: {error}"))?;
    reject_symlink(collection_root)?;

    let staging_root = collection_root.join(".staging");
    reject_symlink(&staging_root)?;
    fs::create_dir_all(&staging_root)
        .map_err(|error| format!("Failed to create content staging directory: {error}"))?;
    reject_symlink(&staging_root)?;

    let target_root = collection_root.join(content_id);
    reject_symlink(&target_root)?;
    if target_root.exists() {
        return Err("Content storage already exists.".to_string());
    }

    let staging_dir = staging_root.join(format!("{}--{}.partial", content_id, Uuid::new_v4()));
    fs::create_dir(&staging_dir)
        .map_err(|error| format!("Failed to stage selected content: {error}"))?;
    let stored_name = format!("original.{}", format.extension);
    let staging_path = staging_dir.join(&stored_name);

    let copy_result = copy_and_hash(source_path, &staging_path);
    let (size_bytes, checksum_sha256) = match copy_result {
        Ok(result) => result,
        Err(error) => {
            let _ = fs::remove_dir_all(&staging_dir);
            return Err(error);
        }
    };

    if size_bytes != source_metadata.len() {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err("Selected content changed while it was being imported.".to_string());
    }

    if let Err(error) = fs::rename(&staging_dir, &target_root) {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(format!("Failed to commit imported content: {error}"));
    }

    let storage_relative_path = collection_relative_root
        .join(content_id)
        .join(stored_name);
    Ok(ImportedContentFile {
        original_file_name,
        mime_type: format.mime_type.to_string(),
        extension: format.extension.to_string(),
        size_bytes,
        checksum_sha256,
        storage_relative_path: path_to_relative_string(&storage_relative_path),
    })
}

fn copy_and_hash(source_path: &Path, staging_path: &Path) -> Result<(u64, String), String> {
    let mut source = File::open(source_path)
        .map_err(|error| format!("Failed to open selected content: {error}"))?;
    let mut target = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(staging_path)
        .map_err(|error| format!("Failed to stage selected content: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let mut size_bytes = 0_u64;

    loop {
        let count = source
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read selected content: {error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        target
            .write_all(&buffer[..count])
            .map_err(|error| format!("Failed to copy selected content: {error}"))?;
        size_bytes += count as u64;
    }
    target
        .sync_all()
        .map_err(|error| format!("Failed to sync selected content: {error}"))?;

    Ok((size_bytes, format!("{:x}", hasher.finalize())))
}

fn detect_content_format(path: &Path, size_bytes: u64) -> Result<ContentFormat, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "Content must have a supported extension.".to_string())?;
    let format = match extension.as_str() {
        "pdf" => ContentFormat {
            extension: "pdf",
            mime_type: "application/pdf",
            max_bytes: PDF_MAX_BYTES,
        },
        "docx" => ContentFormat {
            extension: "docx",
            mime_type: DOCX_MIME_TYPE,
            max_bytes: DOCX_MAX_BYTES,
        },
        "txt" => ContentFormat {
            extension: "txt",
            mime_type: "text/plain",
            max_bytes: TEXT_MAX_BYTES,
        },
        "md" | "markdown" => ContentFormat {
            extension: "md",
            mime_type: "text/markdown",
            max_bytes: TEXT_MAX_BYTES,
        },
        "png" => ContentFormat {
            extension: "png",
            mime_type: "image/png",
            max_bytes: IMAGE_MAX_BYTES,
        },
        "jpg" | "jpeg" => ContentFormat {
            extension: "jpg",
            mime_type: "image/jpeg",
            max_bytes: IMAGE_MAX_BYTES,
        },
        "heic" | "heif" => ContentFormat {
            extension: "heic",
            mime_type: "image/heic",
            max_bytes: IMAGE_MAX_BYTES,
        },
        _ => {
            return Err(
                "Supported content files are PDF, DOCX, TXT, Markdown, PNG, JPEG, and HEIC."
                    .to_string(),
            )
        }
    };

    if size_bytes > format.max_bytes {
        return Err(format!(
            "Selected content exceeds the {} MB limit for this file type.",
            format.max_bytes / 1024 / 1024
        ));
    }
    validate_file_signature(path, &format)?;
    Ok(format)
}

fn validate_file_signature(path: &Path, format: &ContentFormat) -> Result<(), String> {
    if format.mime_type.starts_with("text/") {
        let bytes = fs::read(path)
            .map_err(|error| format!("Failed to validate selected text content: {error}"))?;
        if bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() {
            return Err("Selected text content must be valid UTF-8 text.".to_string());
        }
        return Ok(());
    }
    if format.mime_type == DOCX_MIME_TYPE {
        return validate_docx_container(path);
    }

    let mut file = File::open(path)
        .map_err(|error| format!("Failed to validate selected content: {error}"))?;
    let mut header = [0_u8; 64];
    let count = file
        .read(&mut header)
        .map_err(|error| format!("Failed to validate selected content: {error}"))?;
    let header = &header[..count];
    let valid = match format.mime_type {
        "application/pdf" => header.starts_with(b"%PDF-"),
        "image/png" => header.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]),
        "image/jpeg" => header.starts_with(&[0xff, 0xd8, 0xff]),
        "image/heic" => is_heic_header(header),
        _ => false,
    };
    if !valid {
        return Err("Selected content does not match its file extension.".to_string());
    }
    Ok(())
}

fn validate_docx_container(path: &Path) -> Result<(), String> {
    let file = File::open(path)
        .map_err(|error| format!("Failed to validate selected DOCX content: {error}"))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|_| "Selected DOCX content is not a valid OOXML archive.".to_string())?;
    if archive.len() == 0 || archive.len() > DOCX_MAX_ENTRIES {
        return Err("Selected DOCX content has an unsafe archive structure.".to_string());
    }

    let mut total_uncompressed_bytes = 0_u64;
    let mut has_document = false;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|_| "Selected DOCX content has an invalid archive entry.".to_string())?;
        if entry.enclosed_name().is_none() {
            return Err("Selected DOCX content contains an unsafe archive path.".to_string());
        }
        total_uncompressed_bytes = total_uncompressed_bytes
            .checked_add(entry.size())
            .ok_or_else(|| "Selected DOCX content is too large to inspect safely.".to_string())?;
        if total_uncompressed_bytes > DOCX_MAX_UNCOMPRESSED_BYTES {
            return Err("Selected DOCX content expands beyond the safe limit.".to_string());
        }
        if entry.name() == "word/document.xml" && !entry.is_dir() {
            has_document = true;
        }
    }
    if !has_document {
        return Err("Selected DOCX content is missing the main Word document.".to_string());
    }

    let content_types = {
        let mut entry = archive
            .by_name("[Content_Types].xml")
            .map_err(|_| "Selected DOCX content is missing its content types.".to_string())?;
        if entry.size() > DOCX_CONTENT_TYPES_MAX_BYTES {
            return Err("Selected DOCX content types exceed the safe limit.".to_string());
        }
        let mut content = String::new();
        entry
            .read_to_string(&mut content)
            .map_err(|_| "Selected DOCX content types are not valid UTF-8 XML.".to_string())?;
        content
    };
    if !content_types.contains(DOCX_MAIN_CONTENT_TYPE) {
        return Err("Selected file is not a standard macro-free DOCX document.".to_string());
    }

    let mut document = archive
        .by_name("word/document.xml")
        .map_err(|_| "Selected DOCX content is missing the main Word document.".to_string())?;
    if document.size() == 0 {
        return Err("Selected DOCX content has an empty main document.".to_string());
    }
    let mut marker = [0_u8; 1];
    document
        .read_exact(&mut marker)
        .map_err(|_| "Selected DOCX main document cannot be read safely.".to_string())?;
    Ok(())
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > MAX_IDENTIFIER_CHARS {
        return Err(format!("Invalid {label}."));
    }
    if !value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(format!("Invalid {label}."));
    }
    Ok(())
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("Content storage cannot be a symlink.".to_string())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to inspect content storage: {error}")),
    }
}

fn is_heic_header(header: &[u8]) -> bool {
    if header.len() < 12 || &header[4..8] != b"ftyp" {
        return false;
    }
    header[8..].chunks_exact(4).any(|brand| {
        matches!(
            brand,
            b"heic" | b"heix" | b"hevc" | b"hevx" | b"mif1" | b"msf1"
        )
    })
}

fn path_to_relative_string(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    fn test_root() -> PathBuf {
        std::env::temp_dir().join(format!("moss-content-test-{}", Uuid::new_v4()))
    }

    fn write_test_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let file = File::create(path).unwrap();
        let mut archive = ZipWriter::new(file);
        for (name, content) in entries {
            archive
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            archive.write_all(content).unwrap();
        }
        archive.finish().unwrap();
    }

    #[test]
    fn imports_content_through_a_staged_hashed_commit() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let source = root.join("case notes.pdf");
        fs::write(&source, b"%PDF-1.7\nsource bytes").unwrap();
        let collection = root.join("collection");

        let imported = import_content_at_root(
            &collection,
            Path::new("content-sources/case-1"),
            "content-1",
            &source,
        )
        .unwrap();

        assert_eq!(imported.original_file_name, "case notes.pdf");
        assert_eq!(imported.mime_type, "application/pdf");
        assert_eq!(imported.extension, "pdf");
        assert_eq!(
            fs::read(collection.join("content-1/original.pdf")).unwrap(),
            b"%PDF-1.7\nsource bytes"
        );
        assert_eq!(
            imported.storage_relative_path,
            "content-sources/case-1/content-1/original.pdf"
        );
        assert!(collection.join(".staging").read_dir().unwrap().next().is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_path_identifiers_and_signature_mismatches() {
        for invalid in ["", "../secret", "nested/path", "dot.name", "white space"] {
            assert!(validate_identifier(invalid, "content id").is_err());
        }

        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let fake_pdf = root.join("fake.pdf");
        fs::write(&fake_pdf, b"not a PDF").unwrap();
        let binary_text = root.join("binary.txt");
        fs::write(&binary_text, [0xff, 0x00]).unwrap();
        assert!(detect_content_format(&fake_pdf, 9).is_err());
        assert!(detect_content_format(&binary_text, 2).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn accepts_only_a_standard_macro_free_docx_container() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let docx = root.join("packet.docx");
        let content_types = format!(
            "<Types><Override PartName=\"/word/document.xml\" ContentType=\"{DOCX_MAIN_CONTENT_TYPE}\"/></Types>"
        );
        write_test_zip(
            &docx,
            &[
                ("[Content_Types].xml", content_types.as_bytes()),
                ("word/document.xml", b"<w:document><w:body/></w:document>"),
            ],
        );
        assert!(detect_content_format(&docx, fs::metadata(&docx).unwrap().len()).is_ok());

        let arbitrary_zip = root.join("notes.docx");
        write_test_zip(&arbitrary_zip, &[("notes.txt", b"not a Word document")]);
        assert!(detect_content_format(
            &arbitrary_zip,
            fs::metadata(&arbitrary_zip).unwrap().len()
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_sources_and_targets() {
        use std::os::unix::fs::symlink;

        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.txt");
        fs::write(&source, b"trusted text").unwrap();
        let source_link = root.join("source-link.txt");
        symlink(&source, &source_link).unwrap();
        assert!(import_content_at_root(
            &root.join("collection-a"),
            Path::new("content-sources/a"),
            "content-1",
            &source_link,
        )
        .is_err());

        let external = root.join("external");
        fs::create_dir_all(&external).unwrap();
        let collection_link = root.join("collection-link");
        symlink(&external, &collection_link).unwrap();
        assert!(import_content_at_root(
            &collection_link,
            Path::new("content-sources/b"),
            "content-1",
            &source,
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
