use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

const CREDENTIALS_DIR: &str = "credentials";
const CREDENTIALS_FILE: &str = "provider-credentials.json";
const VAULT_VERSION: u32 = 1;
const MAX_VAULT_BYTES: u64 = 64 * 1024;
const ALLOWED_KEYS: [&str; 4] = [
    "moss.provider.runtime.api-key",
    "moss.provider.advisor.api-key",
    "moss.provider.complex.api-key",
    "moss.provider.stt.api-key",
];

#[derive(Default)]
pub struct CredentialStoreState {
    operation_lock: Mutex<()>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialVault {
    version: u32,
    updated_at: u64,
    secrets: BTreeMap<String, String>,
}

impl Default for CredentialVault {
    fn default() -> Self {
        Self {
            version: VAULT_VERSION,
            updated_at: now_ms(),
            secrets: BTreeMap::new(),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn validate_key(key: &str) -> Result<(), String> {
    if ALLOWED_KEYS.contains(&key) {
        Ok(())
    } else {
        Err("MOSS rejected an unsupported provider credential key.".to_string())
    }
}

fn credentials_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(CREDENTIALS_DIR))
        .map_err(|error| {
            format!("MOSS could not resolve its private credential directory: {error}")
        })
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("MOSS refused a symbolic link in its credential vault path.".to_string())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "MOSS could not inspect its credential vault: {error}"
        )),
    }
}

#[cfg(unix)]
fn set_directory_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("MOSS could not secure its credential directory: {error}"))
}

#[cfg(not(unix))]
fn set_directory_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn set_file_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("MOSS could not secure its credential vault: {error}"))
}

#[cfg(not(unix))]
fn set_file_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn ensure_credentials_root(root: &Path) -> Result<(), String> {
    reject_symlink(root)?;
    fs::create_dir_all(root)
        .map_err(|error| format!("MOSS could not create its credential directory: {error}"))?;
    reject_symlink(root)?;
    set_directory_permissions(root)
}

fn validate_vault(vault: &CredentialVault) -> Result<(), String> {
    if vault.version != VAULT_VERSION {
        return Err(format!(
            "MOSS cannot read credential vault version {}.",
            vault.version
        ));
    }
    for (key, value) in &vault.secrets {
        validate_key(key)?;
        if value.trim().is_empty() {
            return Err("MOSS found an empty value in its credential vault.".to_string());
        }
    }
    Ok(())
}

fn read_vault_at_root(root: &Path) -> Result<CredentialVault, String> {
    let path = root.join(CREDENTIALS_FILE);
    reject_symlink(root)?;
    reject_symlink(&path)?;
    if !path.exists() {
        return Ok(CredentialVault::default());
    }
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("MOSS could not inspect its credential vault: {error}"))?;
    if !metadata.is_file() {
        return Err("MOSS credential vault is not a regular file.".to_string());
    }
    if metadata.len() > MAX_VAULT_BYTES {
        return Err("MOSS credential vault exceeds its maximum size.".to_string());
    }
    let payload = fs::read(&path)
        .map_err(|error| format!("MOSS could not read its local credential vault: {error}"))?;
    let vault: CredentialVault = serde_json::from_slice(&payload).map_err(|_| {
        "MOSS local credential vault is damaged. The existing file was left unchanged.".to_string()
    })?;
    validate_vault(&vault)?;
    Ok(vault)
}

fn create_private_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|error| format!("MOSS could not create a credential vault update: {error}"))
}

fn replace_file(temp_path: &Path, target_path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    if target_path.exists() {
        fs::remove_file(target_path).map_err(|error| {
            format!("MOSS could not replace its previous credential vault: {error}")
        })?;
    }
    fs::rename(temp_path, target_path)
        .map_err(|error| format!("MOSS could not commit its credential vault update: {error}"))
}

fn write_vault_at_root(root: &Path, vault: &CredentialVault) -> Result<(), String> {
    validate_vault(vault)?;
    ensure_credentials_root(root)?;
    let target_path = root.join(CREDENTIALS_FILE);
    reject_symlink(&target_path)?;
    let temp_path = root.join(format!(".{CREDENTIALS_FILE}.{}.tmp", Uuid::new_v4()));
    let payload = serde_json::to_vec(vault)
        .map_err(|error| format!("MOSS could not serialize its credential vault: {error}"))?;
    if payload.len() as u64 > MAX_VAULT_BYTES {
        return Err("MOSS credential vault exceeds its maximum size.".to_string());
    }

    let result = (|| {
        let mut file = create_private_file(&temp_path)?;
        file.write_all(&payload)
            .map_err(|error| format!("MOSS could not write its credential vault: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("MOSS could not sync its credential vault: {error}"))?;
        drop(file);
        set_file_permissions(&temp_path)?;
        replace_file(&temp_path, &target_path)?;
        set_file_permissions(&target_path)?;
        #[cfg(unix)]
        File::open(root)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("MOSS could not sync its credential directory: {error}"))?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn read_secret_at_root(root: &Path, key: &str) -> Result<Option<String>, String> {
    validate_key(key)?;
    Ok(read_vault_at_root(root)?.secrets.get(key).cloned())
}

fn write_secret_at_root(root: &Path, key: &str, secret: &str) -> Result<(), String> {
    validate_key(key)?;
    if secret.trim().is_empty() {
        return Err("MOSS cannot save an empty provider credential.".to_string());
    }
    let mut vault = read_vault_at_root(root)?;
    vault.updated_at = now_ms();
    vault.secrets.insert(key.to_string(), secret.to_string());
    write_vault_at_root(root, &vault)
}

fn delete_secret_at_root(root: &Path, key: &str) -> Result<(), String> {
    validate_key(key)?;
    let mut vault = read_vault_at_root(root)?;
    if vault.secrets.remove(key).is_none() {
        return Ok(());
    }
    vault.updated_at = now_ms();
    write_vault_at_root(root, &vault)
}

fn lock_store<'a>(
    state: &'a State<'_, CredentialStoreState>,
) -> Result<std::sync::MutexGuard<'a, ()>, String> {
    state
        .operation_lock
        .lock()
        .map_err(|_| "MOSS local credential vault lock is unavailable.".to_string())
}

#[tauri::command]
pub fn get_provider_secret(
    app: AppHandle,
    state: State<'_, CredentialStoreState>,
    key: String,
) -> Result<Option<String>, String> {
    let _guard = lock_store(&state)?;
    read_secret_at_root(&credentials_root(&app)?, &key)
}

#[tauri::command]
pub fn save_provider_secret(
    app: AppHandle,
    state: State<'_, CredentialStoreState>,
    key: String,
    secret: String,
) -> Result<(), String> {
    let _guard = lock_store(&state)?;
    write_secret_at_root(&credentials_root(&app)?, &key, &secret)
}

#[tauri::command]
pub fn remove_provider_secret(
    app: AppHandle,
    state: State<'_, CredentialStoreState>,
    key: String,
) -> Result<(), String> {
    let _guard = lock_store(&state)?;
    delete_secret_at_root(&credentials_root(&app)?, &key)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("moss-credential-vault-{label}-{}", Uuid::new_v4()))
    }

    #[test]
    fn provider_credentials_round_trip_independently() {
        let root = test_root("round-trip");
        for (index, key) in ALLOWED_KEYS.iter().enumerate() {
            write_secret_at_root(&root, key, &format!("secret-{index}")).unwrap();
        }
        for (index, key) in ALLOWED_KEYS.iter().enumerate() {
            assert_eq!(
                read_secret_at_root(&root, key).unwrap(),
                Some(format!("secret-{index}"))
            );
        }
        delete_secret_at_root(&root, ALLOWED_KEYS[1]).unwrap();
        assert_eq!(read_secret_at_root(&root, ALLOWED_KEYS[1]).unwrap(), None);
        assert_eq!(
            read_secret_at_root(&root, ALLOWED_KEYS[0]).unwrap(),
            Some("secret-0".to_string())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unsupported_keys_and_empty_secrets_fail_closed() {
        let root = test_root("allowlist");
        assert!(write_secret_at_root(&root, "moss.provider.other.api-key", "secret").is_err());
        assert!(write_secret_at_root(&root, ALLOWED_KEYS[0], "  ").is_err());
        assert!(!root.exists());
    }

    #[test]
    fn damaged_vault_is_not_overwritten() {
        let root = test_root("damaged");
        ensure_credentials_root(&root).unwrap();
        let path = root.join(CREDENTIALS_FILE);
        fs::write(&path, b"not-json").unwrap();
        set_file_permissions(&path).unwrap();
        assert!(write_secret_at_root(&root, ALLOWED_KEYS[0], "secret").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"not-json");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn vault_and_directory_use_private_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let root = test_root("permissions");
        write_secret_at_root(&root, ALLOWED_KEYS[0], "secret").unwrap();
        assert_eq!(
            fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(root.join(CREDENTIALS_FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn atomic_updates_leave_no_temporary_files() {
        let root = test_root("atomic");
        write_secret_at_root(&root, ALLOWED_KEYS[0], "first").unwrap();
        write_secret_at_root(&root, ALLOWED_KEYS[0], "second").unwrap();
        let names = fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(names, vec![CREDENTIALS_FILE.to_string()]);
        assert_eq!(
            read_secret_at_root(&root, ALLOWED_KEYS[0]).unwrap(),
            Some("second".to_string())
        );
        fs::remove_dir_all(root).unwrap();
    }
}
