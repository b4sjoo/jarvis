use crate::preparation_storage::{
    app_data_path, path_to_relative_string, preparation_relative_root, reject_symlink,
    validate_preparation_identifier, validate_storage_token,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use uuid::Uuid;
use zip::ZipArchive;

const TEXT_MAX_BYTES: u64 = 10 * 1024 * 1024;
const IMAGE_MAX_BYTES: u64 = 25 * 1024 * 1024;
const PDF_MAX_BYTES: u64 = 50 * 1024 * 1024;
const DOCX_MAX_BYTES: u64 = 25 * 1024 * 1024;
const DOCX_MAX_ENTRIES: usize = 512;
const DOCX_MAX_UNCOMPRESSED_BYTES: u64 = 100 * 1024 * 1024;
const DOCX_CONTENT_TYPES_MAX_BYTES: u64 = 1024 * 1024;
const COPY_BUFFER_BYTES: usize = 64 * 1024;
const DOCX_MIME_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCX_MAIN_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPreparationMaterialFile {
    original_file_name: String,
    mime_type: String,
    extension: String,
    size_bytes: u64,
    checksum_sha256: String,
    storage_relative_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedPreparationMaterialDeletion {
    token: Option<String>,
}

#[derive(Clone, Copy)]
struct MaterialFormat {
    extension: &'static str,
    mime_type: &'static str,
    max_bytes: u64,
}

#[tauri::command]
pub fn import_preparation_material_file(
    app: AppHandle,
    workspace_kind: String,
    workspace_id: String,
    material_id: String,
    source_path: String,
) -> Result<ImportedPreparationMaterialFile, String> {
    let relative_root = preparation_relative_root(&workspace_kind, &workspace_id)?;
    let root = app_data_path(&app, &relative_root)?;
    import_material_at_root(&root, &relative_root, &material_id, Path::new(&source_path))
}

#[tauri::command]
pub fn stage_preparation_material_storage_delete(
    app: AppHandle,
    workspace_kind: String,
    workspace_id: String,
    material_id: String,
) -> Result<StagedPreparationMaterialDeletion, String> {
    validate_preparation_identifier(&material_id, "material id")?;
    let relative_root = preparation_relative_root(&workspace_kind, &workspace_id)?;
    let root = app_data_path(&app, &relative_root)?;
    let material_root = root.join("materials").join(&material_id);
    if !material_root.exists() {
        return Ok(StagedPreparationMaterialDeletion { token: None });
    }
    reject_symlink(&material_root)?;

    let token = format!("{}--{}", material_id, Uuid::new_v4());
    let trash = material_trash_path(&root, &token)?;
    if let Some(parent) = trash.parent() {
        reject_symlink(parent)?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create material trash: {error}"))?;
    }
    fs::rename(&material_root, &trash)
        .map_err(|error| format!("Failed to stage material deletion: {error}"))?;
    Ok(StagedPreparationMaterialDeletion { token: Some(token) })
}

#[tauri::command]
pub fn restore_preparation_material_storage_delete(
    app: AppHandle,
    workspace_kind: String,
    workspace_id: String,
    material_id: String,
    token: String,
) -> Result<(), String> {
    validate_material_delete_token(&material_id, &token)?;
    let relative_root = preparation_relative_root(&workspace_kind, &workspace_id)?;
    let root = app_data_path(&app, &relative_root)?;
    let material_root = root.join("materials").join(&material_id);
    if material_root.exists() {
        return Err("Preparation material storage already exists.".to_string());
    }
    let trash = material_trash_path(&root, &token)?;
    reject_symlink(&trash)?;
    fs::rename(&trash, &material_root)
        .map_err(|error| format!("Failed to restore material deletion: {error}"))
}

#[tauri::command]
pub fn commit_preparation_material_storage_delete(
    app: AppHandle,
    workspace_kind: String,
    workspace_id: String,
    token: String,
) -> Result<bool, String> {
    let relative_root = preparation_relative_root(&workspace_kind, &workspace_id)?;
    let root = app_data_path(&app, &relative_root)?;
    let trash = material_trash_path(&root, &token)?;
    if !trash.exists() {
        return Ok(false);
    }
    reject_symlink(&trash)?;
    fs::remove_dir_all(&trash)
        .map_err(|error| format!("Failed to commit material deletion: {error}"))?;
    Ok(true)
}

fn import_material_at_root(
    workspace_root: &Path,
    workspace_relative_root: &Path,
    material_id: &str,
    source_path: &Path,
) -> Result<ImportedPreparationMaterialFile, String> {
    validate_preparation_identifier(material_id, "material id")?;
    reject_symlink(workspace_root)?;
    let source_metadata = fs::symlink_metadata(source_path)
        .map_err(|error| format!("Failed to inspect selected material: {error}"))?;
    if source_metadata.file_type().is_symlink() || !source_metadata.is_file() {
        return Err("Selected preparation material must be a regular file.".to_string());
    }

    let original_file_name = source_path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Selected preparation material has no valid file name.".to_string())?
        .to_string();
    let format = detect_material_format(source_path, source_metadata.len())?;

    let materials_root = workspace_root.join("materials");
    reject_symlink(&materials_root)?;
    fs::create_dir_all(&materials_root)
        .map_err(|error| format!("Failed to create material storage: {error}"))?;
    let staging_root = materials_root.join(".staging");
    reject_symlink(&staging_root)?;
    fs::create_dir_all(&staging_root)
        .map_err(|error| format!("Failed to create material staging: {error}"))?;

    let staging_path = staging_root.join(format!("{}--{}.partial", material_id, Uuid::new_v4()));
    let target_root = materials_root.join(material_id);
    reject_symlink(&target_root)?;
    if target_root.exists() {
        return Err("Preparation material storage already exists.".to_string());
    }

    let copy_result = copy_and_hash(source_path, &staging_path);
    let (size_bytes, checksum_sha256) = match copy_result {
        Ok(result) => result,
        Err(error) => {
            let _ = fs::remove_file(&staging_path);
            return Err(error);
        }
    };

    if size_bytes != source_metadata.len() {
        let _ = fs::remove_file(&staging_path);
        return Err("Selected material changed while it was being imported.".to_string());
    }

    fs::create_dir(&target_root)
        .map_err(|error| format!("Failed to create material directory: {error}"))?;
    let stored_name = format!("original.{}", format.extension);
    let target_path = target_root.join(&stored_name);
    if let Err(error) = fs::rename(&staging_path, &target_path) {
        let _ = fs::remove_file(&staging_path);
        let _ = fs::remove_dir(&target_root);
        return Err(format!("Failed to commit imported material: {error}"));
    }

    let storage_relative_path = workspace_relative_root
        .join("materials")
        .join(material_id)
        .join(stored_name);
    Ok(ImportedPreparationMaterialFile {
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
        .map_err(|error| format!("Failed to open selected material: {error}"))?;
    let mut target = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(staging_path)
        .map_err(|error| format!("Failed to stage selected material: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let mut size_bytes = 0_u64;
    loop {
        let count = source
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read selected material: {error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        target
            .write_all(&buffer[..count])
            .map_err(|error| format!("Failed to copy selected material: {error}"))?;
        size_bytes += count as u64;
    }
    target
        .sync_all()
        .map_err(|error| format!("Failed to sync selected material: {error}"))?;
    Ok((size_bytes, format!("{:x}", hasher.finalize())))
}

fn detect_material_format(path: &Path, size_bytes: u64) -> Result<MaterialFormat, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "Preparation material must have a supported extension.".to_string())?;
    let format = match extension.as_str() {
        "pdf" => MaterialFormat {
            extension: "pdf",
            mime_type: "application/pdf",
            max_bytes: PDF_MAX_BYTES,
        },
        "docx" => MaterialFormat {
            extension: "docx",
            mime_type: DOCX_MIME_TYPE,
            max_bytes: DOCX_MAX_BYTES,
        },
        "txt" => MaterialFormat {
            extension: "txt",
            mime_type: "text/plain",
            max_bytes: TEXT_MAX_BYTES,
        },
        "md" | "markdown" => MaterialFormat {
            extension: "md",
            mime_type: "text/markdown",
            max_bytes: TEXT_MAX_BYTES,
        },
        "png" => MaterialFormat {
            extension: "png",
            mime_type: "image/png",
            max_bytes: IMAGE_MAX_BYTES,
        },
        "jpg" | "jpeg" => MaterialFormat {
            extension: "jpg",
            mime_type: "image/jpeg",
            max_bytes: IMAGE_MAX_BYTES,
        },
        "heic" | "heif" => MaterialFormat {
            extension: "heic",
            mime_type: "image/heic",
            max_bytes: IMAGE_MAX_BYTES,
        },
        _ => return Err(
            "Supported preparation materials are PDF, DOCX, TXT, Markdown, PNG, JPEG, and HEIC."
                .to_string(),
        ),
    };
    if size_bytes > format.max_bytes {
        return Err(format!(
            "Selected material exceeds the {} MB limit for this file type.",
            format.max_bytes / 1024 / 1024
        ));
    }
    validate_file_signature(path, &format)?;
    Ok(format)
}

fn validate_file_signature(path: &Path, format: &MaterialFormat) -> Result<(), String> {
    if format.mime_type.starts_with("text/") {
        let bytes = fs::read(path)
            .map_err(|error| format!("Failed to validate selected text material: {error}"))?;
        if bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() {
            return Err("Selected text material must be valid UTF-8 text.".to_string());
        }
        return Ok(());
    }
    if format.mime_type == DOCX_MIME_TYPE {
        return validate_docx_container(path);
    }

    let mut file = File::open(path)
        .map_err(|error| format!("Failed to validate selected material: {error}"))?;
    let mut header = [0_u8; 64];
    let count = file
        .read(&mut header)
        .map_err(|error| format!("Failed to validate selected material: {error}"))?;
    let header = &header[..count];
    let valid = match format.mime_type {
        "application/pdf" => header.starts_with(b"%PDF-"),
        "image/png" => header.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]),
        "image/jpeg" => header.starts_with(&[0xff, 0xd8, 0xff]),
        "image/heic" => is_heic_header(header),
        _ => false,
    };
    if !valid {
        return Err("Selected material content does not match its file extension.".to_string());
    }
    Ok(())
}

fn validate_docx_container(path: &Path) -> Result<(), String> {
    let file = File::open(path)
        .map_err(|error| format!("Failed to validate selected DOCX material: {error}"))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|_| "Selected DOCX material is not a valid OOXML archive.".to_string())?;
    if archive.len() == 0 || archive.len() > DOCX_MAX_ENTRIES {
        return Err("Selected DOCX material has an unsafe archive structure.".to_string());
    }

    let mut total_uncompressed_bytes = 0_u64;
    let mut has_document = false;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|_| "Selected DOCX material has an invalid archive entry.".to_string())?;
        if entry.enclosed_name().is_none() {
            return Err("Selected DOCX material contains an unsafe archive path.".to_string());
        }
        total_uncompressed_bytes = total_uncompressed_bytes
            .checked_add(entry.size())
            .ok_or_else(|| "Selected DOCX material is too large to inspect safely.".to_string())?;
        if total_uncompressed_bytes > DOCX_MAX_UNCOMPRESSED_BYTES {
            return Err("Selected DOCX material expands beyond the safe limit.".to_string());
        }
        if entry.name() == "word/document.xml" && !entry.is_dir() {
            has_document = true;
        }
    }
    if !has_document {
        return Err("Selected DOCX material is missing the main Word document.".to_string());
    }

    let content_types = {
        let mut entry = archive
            .by_name("[Content_Types].xml")
            .map_err(|_| "Selected DOCX material is missing its content types.".to_string())?;
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
        .map_err(|_| "Selected DOCX material is missing the main Word document.".to_string())?;
    if document.size() == 0 {
        return Err("Selected DOCX material has an empty main document.".to_string());
    }
    let mut marker = [0_u8; 1];
    document
        .read_exact(&mut marker)
        .map_err(|_| "Selected DOCX main document cannot be read safely.".to_string())?;
    Ok(())
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

fn material_trash_path(workspace_root: &Path, token: &str) -> Result<PathBuf, String> {
    validate_storage_token(token)?;
    Ok(workspace_root.join("materials").join(".trash").join(token))
}

fn validate_material_delete_token(material_id: &str, token: &str) -> Result<(), String> {
    validate_preparation_identifier(material_id, "material id")?;
    validate_storage_token(token)?;
    if !token.starts_with(&format!("{}--", material_id)) {
        return Err("Preparation material delete token does not match material.".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    fn test_root() -> PathBuf {
        std::env::temp_dir().join(format!("jarvis-material-test-{}", Uuid::new_v4()))
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
    fn imports_an_immutable_file_with_generated_storage_name() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let source = root.join("candidate resume.pdf");
        fs::write(&source, b"%PDF-1.7\nsource bytes").unwrap();
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();

        let imported = import_material_at_root(
            &workspace,
            Path::new("interview-preparation/workspace-1"),
            "material-1",
            &source,
        )
        .unwrap();

        assert_eq!(imported.original_file_name, "candidate resume.pdf");
        assert_eq!(imported.mime_type, "application/pdf");
        assert_eq!(imported.extension, "pdf");
        assert_eq!(
            fs::read(workspace.join("materials/material-1/original.pdf")).unwrap(),
            b"%PDF-1.7\nsource bytes"
        );
        assert_eq!(
            imported.storage_relative_path,
            "interview-preparation/workspace-1/materials/material-1/original.pdf"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_extension_content_mismatches_and_non_utf8_text() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let fake_pdf = root.join("fake.pdf");
        fs::write(&fake_pdf, b"not a PDF").unwrap();
        let binary_text = root.join("binary.txt");
        fs::write(&binary_text, [0xff, 0x00]).unwrap();

        assert!(detect_material_format(&fake_pdf, 9).is_err());
        assert!(detect_material_format(&binary_text, 2).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn accepts_a_standard_macro_free_docx_container() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let docx = root.join("interview packet.docx");
        let content_types = format!(
            "<Types><Override PartName=\"/word/document.xml\" ContentType=\"{DOCX_MAIN_CONTENT_TYPE}\"/></Types>"
        );
        write_test_zip(
            &docx,
            &[
                ("[Content_Types].xml", content_types.as_bytes()),
                (
                    "word/document.xml",
                    b"<w:document xmlns:w=\"wordprocessingml\"><w:body/></w:document>",
                ),
            ],
        );

        let format = detect_material_format(&docx, fs::metadata(&docx).unwrap().len()).unwrap();
        assert_eq!(format.extension, "docx");
        assert_eq!(format.mime_type, DOCX_MIME_TYPE);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_non_docx_zip_macro_enabled_and_corrupt_docx_files() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();

        let arbitrary_zip = root.join("notes.docx");
        write_test_zip(&arbitrary_zip, &[("notes.txt", b"not a Word document")]);
        assert!(detect_material_format(
            &arbitrary_zip,
            fs::metadata(&arbitrary_zip).unwrap().len()
        )
        .is_err());

        let macro_docx = root.join("macro.docx");
        write_test_zip(
            &macro_docx,
            &[
                (
                    "[Content_Types].xml",
                    b"<Types><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.ms-word.document.macroEnabled.main+xml\"/></Types>",
                ),
                (
                    "word/document.xml",
                    b"<w:document xmlns:w=\"wordprocessingml\"><w:body/></w:document>",
                ),
            ],
        );
        assert!(
            detect_material_format(&macro_docx, fs::metadata(&macro_docx).unwrap().len()).is_err()
        );

        let corrupt_docx = root.join("corrupt.docx");
        fs::write(&corrupt_docx, b"PK not really a ZIP archive").unwrap();
        assert!(
            detect_material_format(&corrupt_docx, fs::metadata(&corrupt_docx).unwrap().len())
                .is_err()
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_docx_archives_over_the_entry_limit() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let docx = root.join("too-many-entries.docx");
        let file = File::create(&docx).unwrap();
        let mut archive = ZipWriter::new(file);
        for index in 0..=DOCX_MAX_ENTRIES {
            archive
                .start_file(
                    format!("word/entry-{index}.xml"),
                    SimpleFileOptions::default(),
                )
                .unwrap();
        }
        archive.finish().unwrap();

        assert!(detect_material_format(&docx, fs::metadata(&docx).unwrap().len()).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn material_delete_tokens_are_bound_to_material_ids() {
        assert!(validate_material_delete_token(
            "material-a",
            "material-a--550e8400-e29b-41d4-a716-446655440000"
        )
        .is_ok());
        assert!(validate_material_delete_token(
            "material-a",
            "material-b--550e8400-e29b-41d4-a716-446655440000"
        )
        .is_err());
    }
}
