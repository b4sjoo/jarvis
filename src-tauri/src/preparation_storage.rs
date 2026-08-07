use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const INTERVIEW_PREPARATION_DIR: &str = "interview-preparation";
const CASE_PREPARATION_DIR: &str = "case-preparation";
const MAX_WORKSPACE_ID_CHARS: usize = 128;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparationWorkspaceStorageInfo {
    relative_root: String,
    created: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedPreparationWorkspaceDeletion {
    token: Option<String>,
}

#[tauri::command]
pub fn ensure_preparation_workspace_storage(
    app: AppHandle,
    workspace_kind: String,
    workspace_id: String,
) -> Result<PreparationWorkspaceStorageInfo, String> {
    let relative_root = preparation_relative_root(&workspace_kind, &workspace_id)?;
    let root = app_data_path(&app, &relative_root)?;
    reject_symlink(&root)?;
    let created = !root.exists();

    for directory in ["materials", "exports", "snapshots"] {
        fs::create_dir_all(root.join(directory))
            .map_err(|error| format!("Failed to create preparation workspace storage: {error}"))?;
    }

    Ok(PreparationWorkspaceStorageInfo {
        relative_root: path_to_relative_string(&relative_root),
        created,
    })
}

#[tauri::command]
pub fn stage_preparation_workspace_storage_delete(
    app: AppHandle,
    workspace_kind: String,
    workspace_id: String,
) -> Result<StagedPreparationWorkspaceDeletion, String> {
    let relative_root = preparation_relative_root(&workspace_kind, &workspace_id)?;
    let root = app_data_path(&app, &relative_root)?;
    if !root.exists() {
        return Ok(StagedPreparationWorkspaceDeletion { token: None });
    }
    reject_symlink(&root)?;
    let token = format!("{}--{}", workspace_id, Uuid::new_v4());
    let trash = preparation_trash_path(&app, &workspace_kind, &token)?;
    if let Some(parent) = trash.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create preparation workspace trash: {error}"))?;
    }
    fs::rename(&root, &trash)
        .map_err(|error| format!("Failed to stage preparation workspace deletion: {error}"))?;
    Ok(StagedPreparationWorkspaceDeletion { token: Some(token) })
}

#[tauri::command]
pub fn restore_preparation_workspace_storage_delete(
    app: AppHandle,
    workspace_kind: String,
    workspace_id: String,
    token: String,
) -> Result<(), String> {
    validate_delete_token(&workspace_id, &token)?;
    let relative_root = preparation_relative_root(&workspace_kind, &workspace_id)?;
    let root = app_data_path(&app, &relative_root)?;
    if root.exists() {
        return Err("Preparation workspace storage already exists.".to_string());
    }
    let trash = preparation_trash_path(&app, &workspace_kind, &token)?;
    reject_symlink(&trash)?;
    fs::rename(&trash, &root)
        .map_err(|error| format!("Failed to restore preparation workspace storage: {error}"))
}

#[tauri::command]
pub fn commit_preparation_workspace_storage_delete(
    app: AppHandle,
    workspace_kind: String,
    token: String,
) -> Result<bool, String> {
    validate_storage_token(&token)?;
    let trash = preparation_trash_path(&app, &workspace_kind, &token)?;
    if !trash.exists() {
        return Ok(false);
    }
    reject_symlink(&trash)?;
    fs::remove_dir_all(&trash)
        .map_err(|error| format!("Failed to commit preparation workspace deletion: {error}"))?;
    Ok(true)
}

fn preparation_relative_root(kind: &str, workspace_id: &str) -> Result<PathBuf, String> {
    validate_workspace_id(workspace_id)?;
    let namespace = match kind {
        "interview" => INTERVIEW_PREPARATION_DIR,
        "case" => CASE_PREPARATION_DIR,
        _ => return Err("Unsupported preparation workspace kind.".to_string()),
    };
    Ok(PathBuf::from(namespace).join(workspace_id))
}

fn validate_workspace_id(workspace_id: &str) -> Result<(), String> {
    if workspace_id.is_empty() || workspace_id.len() > MAX_WORKSPACE_ID_CHARS {
        return Err("Invalid preparation workspace id.".to_string());
    }
    if !workspace_id
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Invalid preparation workspace id.".to_string());
    }
    Ok(())
}

fn validate_storage_token(token: &str) -> Result<(), String> {
    if token.is_empty() || token.len() > 256 {
        return Err("Invalid preparation storage delete token.".to_string());
    }
    if !token
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Invalid preparation storage delete token.".to_string());
    }
    Ok(())
}

fn validate_delete_token(workspace_id: &str, token: &str) -> Result<(), String> {
    validate_workspace_id(workspace_id)?;
    validate_storage_token(token)?;
    if !token.starts_with(&format!("{}--", workspace_id)) {
        return Err("Preparation storage delete token does not match workspace.".to_string());
    }
    Ok(())
}

fn preparation_trash_path(
    app: &AppHandle,
    workspace_kind: &str,
    token: &str,
) -> Result<PathBuf, String> {
    validate_storage_token(token)?;
    let namespace = match workspace_kind {
        "interview" => INTERVIEW_PREPARATION_DIR,
        "case" => CASE_PREPARATION_DIR,
        _ => return Err("Unsupported preparation workspace kind.".to_string()),
    };
    app_data_path(app, &PathBuf::from(namespace).join(".trash").join(token))
}

fn app_data_path(app: &AppHandle, relative_root: &Path) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    Ok(app_data.join(relative_root))
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("Preparation workspace storage cannot be a symlink.".to_string())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Failed to inspect preparation workspace storage: {error}"
        )),
    }
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

    #[test]
    fn maps_supported_workspace_kinds_to_separate_roots() {
        assert_eq!(
            preparation_relative_root("interview", "process-123").unwrap(),
            PathBuf::from("interview-preparation/process-123")
        );
        assert_eq!(
            preparation_relative_root("case", "case_123").unwrap(),
            PathBuf::from("case-preparation/case_123")
        );
    }

    #[test]
    fn rejects_path_traversal_and_unknown_kinds() {
        for invalid in ["", "../secret", "nested/path", "dot.name", "white space"] {
            assert!(preparation_relative_root("interview", invalid).is_err());
        }
        assert!(preparation_relative_root("other", "safe-id").is_err());
    }

    #[test]
    fn delete_tokens_are_bound_to_their_workspace() {
        assert!(validate_delete_token("workspace-a", "workspace-a--token-1").is_ok());
        assert!(validate_delete_token("workspace-a", "workspace-b--token-1").is_err());
        assert!(validate_storage_token("../escape").is_err());
    }
}
