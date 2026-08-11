use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use uuid::Uuid;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

const CONTENT_SOURCES_DIR: &str = "content-sources";
const CALL_RECORDINGS_DIR: &str = "call-session-recordings";
const PRIVACY_STAGING_DIR: &str = ".case-privacy-staging";
const CASE_EXPORTS_DIR: &str = "case-exports";
const MAX_IDENTIFIER_CHARS: usize = 160;
const MAX_METADATA_BYTES: usize = 64 * 1024 * 1024;
const MAX_EXPORT_FILES: u64 = 20_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseDeletionStageResult {
    operation_id: String,
    staged_content: bool,
    staged_recording_count: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseDeletionRestoreResult {
    restored_content: bool,
    restored_recording_count: u64,
    stage_found: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseExportResult {
    path: String,
    file_count: u64,
    source_bytes: u64,
    checksum_sha256: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeletionManifest {
    version: u32,
    operation_id: String,
    case_id: String,
    call_session_ids: Vec<String>,
    staged_content: bool,
    staged_recording_ids: Vec<String>,
}

#[derive(Default)]
struct ArchiveStats {
    file_count: u64,
    source_bytes: u64,
}

#[tauri::command]
pub fn export_case_bundle(
    app: AppHandle,
    case_id: String,
    metadata_json: String,
    call_session_ids: Vec<String>,
) -> Result<CaseExportResult, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    export_at_root(&app_data, &case_id, &metadata_json, &call_session_ids)
}

#[tauri::command]
pub fn stage_case_deletion(
    app: AppHandle,
    operation_id: String,
    case_id: String,
    call_session_ids: Vec<String>,
) -> Result<CaseDeletionStageResult, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    stage_at_root(&app_data, &operation_id, &case_id, &call_session_ids)
}

#[tauri::command]
pub fn restore_case_deletion(
    app: AppHandle,
    operation_id: String,
) -> Result<CaseDeletionRestoreResult, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    restore_at_root(&app_data, &operation_id)
}

#[tauri::command]
pub fn finalize_case_deletion(app: AppHandle, operation_id: String) -> Result<bool, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    finalize_at_root(&app_data, &operation_id)
}

fn export_at_root(
    app_data: &Path,
    case_id: &str,
    metadata_json: &str,
    call_session_ids: &[String],
) -> Result<CaseExportResult, String> {
    validate_identifier(case_id, "case id")?;
    validate_session_ids(call_session_ids)?;
    if metadata_json.len() > MAX_METADATA_BYTES {
        return Err("Case export metadata exceeds the local safety limit.".to_string());
    }
    serde_json::from_str::<serde_json::Value>(metadata_json)
        .map_err(|error| format!("Case export metadata is not valid JSON: {error}"))?;

    let exports_root = app_data.join(CASE_EXPORTS_DIR);
    reject_symlink(&exports_root)?;
    fs::create_dir_all(&exports_root)
        .map_err(|error| format!("Failed to create Case export directory: {error}"))?;
    reject_symlink(&exports_root)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("System clock cannot create a Case export: {error}"))?
        .as_millis();
    let export_path = exports_root.join(format!("{case_id}-{timestamp}.zip"));
    reject_symlink(&export_path)?;
    let file = File::create(&export_path)
        .map_err(|error| format!("Failed to create Case export: {error}"))?;
    let mut archive = ZipWriter::new(file);
    let options = SimpleFileOptions::default();
    archive
        .start_file("case-export.json", options)
        .map_err(|error| format!("Failed to stage Case export metadata: {error}"))?;
    archive
        .write_all(metadata_json.as_bytes())
        .map_err(|error| format!("Failed to write Case export metadata: {error}"))?;
    let mut stats = ArchiveStats {
        file_count: 1,
        source_bytes: metadata_json.len() as u64,
    };

    let content_root = app_data.join(CONTENT_SOURCES_DIR).join(case_id);
    if content_root.exists() {
        archive_directory(
            &mut archive,
            &content_root,
            Path::new("materials"),
            &mut stats,
        )?;
    }
    for session_id in normalized_session_ids(call_session_ids) {
        let session_root = app_data.join(CALL_RECORDINGS_DIR).join(&session_id);
        if session_root.exists() {
            archive_directory(
                &mut archive,
                &session_root,
                &Path::new("recordings").join(&session_id),
                &mut stats,
            )?;
        }
    }

    let file = archive
        .finish()
        .map_err(|error| format!("Failed to finalize Case export: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Failed to sync Case export: {error}"))?;
    let checksum_sha256 = hash_file(&export_path)?;
    Ok(CaseExportResult {
        path: export_path.to_string_lossy().to_string(),
        file_count: stats.file_count,
        source_bytes: stats.source_bytes,
        checksum_sha256,
    })
}

fn stage_at_root(
    app_data: &Path,
    operation_id: &str,
    case_id: &str,
    call_session_ids: &[String],
) -> Result<CaseDeletionStageResult, String> {
    validate_identifier(operation_id, "deletion operation id")?;
    validate_identifier(case_id, "case id")?;
    validate_session_ids(call_session_ids)?;
    let staging_root = app_data.join(PRIVACY_STAGING_DIR);
    reject_symlink(&staging_root)?;
    fs::create_dir_all(&staging_root)
        .map_err(|error| format!("Failed to create deletion staging directory: {error}"))?;
    reject_symlink(&staging_root)?;
    let operation_root = staging_root.join(operation_id);
    reject_symlink(&operation_root)?;
    if operation_root.exists() {
        return Err("Case deletion operation is already staged.".to_string());
    }
    fs::create_dir(&operation_root)
        .map_err(|error| format!("Failed to create deletion operation staging: {error}"))?;

    let content_source = app_data.join(CONTENT_SOURCES_DIR).join(case_id);
    let content_target = operation_root.join("content");
    let recordings_target = operation_root.join("recordings");
    let mut staged_content = false;
    let mut staged_recording_ids = Vec::new();
    let stage_result = (|| {
        if content_source.exists() {
            reject_symlink(&content_source)?;
            fs::rename(&content_source, &content_target)
                .map_err(|error| format!("Failed to stage Case materials for deletion: {error}"))?;
            staged_content = true;
        }
        for session_id in normalized_session_ids(call_session_ids) {
            let source = app_data.join(CALL_RECORDINGS_DIR).join(&session_id);
            if !source.exists() {
                continue;
            }
            reject_symlink(&source)?;
            if !recordings_target.exists() {
                fs::create_dir(&recordings_target).map_err(|error| {
                    format!("Failed to create recording deletion staging: {error}")
                })?;
            }
            let target = recordings_target.join(&session_id);
            fs::rename(&source, &target).map_err(|error| {
                format!("Failed to stage linked recording for deletion: {error}")
            })?;
            staged_recording_ids.push(session_id);
        }
        let manifest = DeletionManifest {
            version: 1,
            operation_id: operation_id.to_string(),
            case_id: case_id.to_string(),
            call_session_ids: normalized_session_ids(call_session_ids),
            staged_content,
            staged_recording_ids: staged_recording_ids.clone(),
        };
        write_manifest(&operation_root, &manifest)
    })();

    if let Err(error) = stage_result {
        let _ = rollback_partial_stage(
            app_data,
            &operation_root,
            case_id,
            staged_content,
            &staged_recording_ids,
        );
        let _ = fs::remove_dir_all(&operation_root);
        return Err(error);
    }
    Ok(CaseDeletionStageResult {
        operation_id: operation_id.to_string(),
        staged_content,
        staged_recording_count: staged_recording_ids.len() as u64,
    })
}

fn restore_at_root(
    app_data: &Path,
    operation_id: &str,
) -> Result<CaseDeletionRestoreResult, String> {
    validate_identifier(operation_id, "deletion operation id")?;
    let operation_root = app_data.join(PRIVACY_STAGING_DIR).join(operation_id);
    reject_symlink(&operation_root)?;
    if !operation_root.exists() {
        return Ok(CaseDeletionRestoreResult {
            restored_content: false,
            restored_recording_count: 0,
            stage_found: false,
        });
    }
    let manifest = read_manifest(&operation_root)?;
    if manifest.operation_id != operation_id {
        return Err("Deletion staging manifest belongs to another operation.".to_string());
    }
    let restored_recording_count = rollback_partial_stage(
        app_data,
        &operation_root,
        &manifest.case_id,
        manifest.staged_content,
        &manifest.staged_recording_ids,
    )?;
    fs::remove_dir_all(&operation_root)
        .map_err(|error| format!("Failed to clean restored deletion staging: {error}"))?;
    Ok(CaseDeletionRestoreResult {
        restored_content: manifest.staged_content,
        restored_recording_count,
        stage_found: true,
    })
}

fn finalize_at_root(app_data: &Path, operation_id: &str) -> Result<bool, String> {
    validate_identifier(operation_id, "deletion operation id")?;
    let operation_root = app_data.join(PRIVACY_STAGING_DIR).join(operation_id);
    reject_symlink(&operation_root)?;
    if !operation_root.exists() {
        return Ok(false);
    }
    let manifest = read_manifest(&operation_root)?;
    if manifest.operation_id != operation_id {
        return Err("Deletion staging manifest belongs to another operation.".to_string());
    }
    fs::remove_dir_all(&operation_root)
        .map_err(|error| format!("Failed to finalize staged Case deletion: {error}"))?;
    Ok(true)
}

fn rollback_partial_stage(
    app_data: &Path,
    operation_root: &Path,
    case_id: &str,
    staged_content: bool,
    staged_recording_ids: &[String],
) -> Result<u64, String> {
    let mut restored_recordings = 0_u64;
    if staged_content {
        let source = operation_root.join("content");
        let target = app_data.join(CONTENT_SOURCES_DIR).join(case_id);
        if source.exists() {
            reject_symlink(&source)?;
            ensure_restore_parent(&target)?;
            if target.exists() {
                return Err("Case material restore target already exists.".to_string());
            }
            fs::rename(&source, &target)
                .map_err(|error| format!("Failed to restore staged Case materials: {error}"))?;
        }
    }
    for session_id in staged_recording_ids {
        validate_identifier(session_id, "call session id")?;
        let source = operation_root.join("recordings").join(session_id);
        if !source.exists() {
            continue;
        }
        reject_symlink(&source)?;
        let target = app_data.join(CALL_RECORDINGS_DIR).join(session_id);
        ensure_restore_parent(&target)?;
        if target.exists() {
            return Err("Linked recording restore target already exists.".to_string());
        }
        fs::rename(&source, &target)
            .map_err(|error| format!("Failed to restore staged call recording: {error}"))?;
        restored_recordings = restored_recordings.saturating_add(1);
    }
    Ok(restored_recordings)
}

fn archive_directory(
    archive: &mut ZipWriter<File>,
    source_root: &Path,
    archive_root: &Path,
    stats: &mut ArchiveStats,
) -> Result<(), String> {
    reject_symlink(source_root)?;
    if !source_root.is_dir() {
        return Err("Case export source is not a directory.".to_string());
    }
    let mut entries = fs::read_dir(source_root)
        .map_err(|error| format!("Failed to inspect Case export source: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to inspect Case export source: {error}"))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        reject_symlink(&path)?;
        let archive_path = archive_root.join(entry.file_name());
        let metadata = entry
            .metadata()
            .map_err(|error| format!("Failed to inspect Case export item: {error}"))?;
        if metadata.is_dir() {
            archive_directory(archive, &path, &archive_path, stats)?;
            continue;
        }
        if !metadata.is_file() {
            return Err("Case export source contains an unsupported filesystem item.".to_string());
        }
        stats.file_count = stats.file_count.saturating_add(1);
        if stats.file_count > MAX_EXPORT_FILES {
            return Err("Case export contains too many files.".to_string());
        }
        stats.source_bytes = stats.source_bytes.saturating_add(metadata.len());
        archive
            .start_file(
                path_to_archive_string(&archive_path)?,
                SimpleFileOptions::default(),
            )
            .map_err(|error| format!("Failed to stage Case export file: {error}"))?;
        let mut source = File::open(&path)
            .map_err(|error| format!("Failed to read Case export source: {error}"))?;
        std::io::copy(&mut source, archive)
            .map_err(|error| format!("Failed to write Case export file: {error}"))?;
    }
    Ok(())
}

fn write_manifest(operation_root: &Path, manifest: &DeletionManifest) -> Result<(), String> {
    let path = operation_root.join("stage-manifest.json");
    reject_symlink(&path)?;
    let payload = serde_json::to_vec_pretty(manifest)
        .map_err(|error| format!("Failed to serialize deletion staging manifest: {error}"))?;
    let temporary = operation_root.join(format!("manifest-{}.tmp", Uuid::new_v4()));
    let mut file = File::create(&temporary)
        .map_err(|error| format!("Failed to stage deletion manifest: {error}"))?;
    file.write_all(&payload)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Failed to sync deletion manifest: {error}"))?;
    fs::rename(&temporary, &path)
        .map_err(|error| format!("Failed to commit deletion manifest: {error}"))
}

fn read_manifest(operation_root: &Path) -> Result<DeletionManifest, String> {
    let path = operation_root.join("stage-manifest.json");
    reject_symlink(&path)?;
    let payload = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read deletion staging manifest: {error}"))?;
    serde_json::from_str(&payload)
        .map_err(|error| format!("Invalid deletion staging manifest: {error}"))
}

fn ensure_restore_parent(target: &Path) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "Restore target has no parent directory.".to_string())?;
    reject_symlink(parent)?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create restore target directory: {error}"))?;
    reject_symlink(parent)
}

fn validate_session_ids(values: &[String]) -> Result<(), String> {
    for value in values {
        validate_identifier(value, "call session id")?;
    }
    Ok(())
}

fn normalized_session_ids(values: &[String]) -> Vec<String> {
    let mut values = values.to_vec();
    values.sort();
    values.dedup();
    values
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
            Err("Case privacy storage cannot be a symlink.".to_string())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to inspect Case privacy storage: {error}")),
    }
}

fn path_to_archive_string(path: &Path) -> Result<String, String> {
    let value = path
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    if value.is_empty() || value.starts_with('/') || value.contains("../") {
        return Err("Case export path is unsafe.".to_string());
    }
    Ok(value)
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|error| format!("Failed to hash Case export: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("Failed to hash Case export: {error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::ZipArchive;

    fn test_root() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("moss-case-privacy-test-{}", Uuid::new_v4()))
    }

    #[test]
    fn exports_case_metadata_materials_and_linked_recordings() {
        let root = test_root();
        fs::create_dir_all(root.join("content-sources/case-1/material-1")).unwrap();
        fs::write(
            root.join("content-sources/case-1/material-1/original.txt"),
            b"source",
        )
        .unwrap();
        fs::create_dir_all(root.join("call-session-recordings/call-1")).unwrap();
        fs::write(
            root.join("call-session-recordings/call-1/events.jsonl"),
            b"event",
        )
        .unwrap();

        let exported = export_at_root(
            &root,
            "case-1",
            r#"{"version":1,"case":{"id":"case-1"}}"#,
            &["call-1".to_string()],
        )
        .unwrap();
        assert_eq!(exported.file_count, 3);
        let mut archive = ZipArchive::new(File::open(&exported.path).unwrap()).unwrap();
        assert!(archive.by_name("case-export.json").is_ok());
        assert!(archive.by_name("materials/material-1/original.txt").is_ok());
        assert!(archive.by_name("recordings/call-1/events.jsonl").is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn staged_case_deletion_can_restore_or_finalize() {
        let root = test_root();
        fs::create_dir_all(root.join("content-sources/case-1/material-1")).unwrap();
        fs::write(
            root.join("content-sources/case-1/material-1/original.txt"),
            b"source",
        )
        .unwrap();
        fs::create_dir_all(root.join("call-session-recordings/call-1")).unwrap();
        fs::write(
            root.join("call-session-recordings/call-1/events.jsonl"),
            b"event",
        )
        .unwrap();

        let staged = stage_at_root(&root, "delete-1", "case-1", &["call-1".to_string()]).unwrap();
        assert!(staged.staged_content);
        assert_eq!(staged.staged_recording_count, 1);
        assert!(!root.join("content-sources/case-1").exists());
        let restored = restore_at_root(&root, "delete-1").unwrap();
        assert!(restored.stage_found);
        assert!(root
            .join("content-sources/case-1/material-1/original.txt")
            .is_file());
        assert!(root
            .join("call-session-recordings/call-1/events.jsonl")
            .is_file());

        stage_at_root(&root, "delete-2", "case-1", &["call-1".to_string()]).unwrap();
        assert!(finalize_at_root(&root, "delete-2").unwrap());
        assert!(!root.join("content-sources/case-1").exists());
        assert!(!root.join("call-session-recordings/call-1").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_traversal_and_symlink_export_sources() {
        let root = test_root();
        assert!(stage_at_root(&root, "delete-1", "../case", &[]).is_err());
        assert!(export_at_root(&root, "../case", "{}", &[]).is_err());

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            fs::create_dir_all(root.join("content-sources/case-1")).unwrap();
            fs::write(root.join("outside.txt"), b"outside").unwrap();
            symlink(
                root.join("outside.txt"),
                root.join("content-sources/case-1/leak.txt"),
            )
            .unwrap();
            assert!(export_at_root(&root, "case-1", "{}", &[]).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }
}
