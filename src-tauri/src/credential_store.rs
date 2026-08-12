const KEYCHAIN_SERVICE: &str = "dev.seasonsg.moss.provider-credentials";
const ALLOWED_KEYS: [&str; 4] = [
    "moss.provider.runtime.api-key",
    "moss.provider.advisor.api-key",
    "moss.provider.complex.api-key",
    "moss.provider.stt.api-key",
];

fn validate_key(key: &str) -> Result<(), String> {
    if ALLOWED_KEYS.contains(&key) {
        Ok(())
    } else {
        Err("MOSS rejected an unsupported provider credential key.".to_string())
    }
}

#[cfg(target_os = "macos")]
fn read_secret(key: &str) -> Result<Option<String>, String> {
    use security_framework::passwords::get_generic_password;

    const ITEM_NOT_FOUND: i32 = -25_300;
    match get_generic_password(KEYCHAIN_SERVICE, key) {
        Ok(value) => String::from_utf8(value)
            .map(Some)
            .map_err(|_| "The stored provider credential is not valid UTF-8.".to_string()),
        Err(error) if error.code() == ITEM_NOT_FOUND => Ok(None),
        Err(error) => Err(format!(
            "macOS Keychain could not read the provider credential (status {}).",
            error.code()
        )),
    }
}

#[cfg(target_os = "macos")]
fn write_secret(key: &str, secret: &str) -> Result<(), String> {
    use security_framework::passwords::set_generic_password;

    set_generic_password(KEYCHAIN_SERVICE, key, secret.as_bytes()).map_err(|error| {
        format!(
            "macOS Keychain could not save the provider credential (status {}).",
            error.code()
        )
    })
}

#[cfg(target_os = "macos")]
fn delete_secret(key: &str) -> Result<(), String> {
    use security_framework::passwords::delete_generic_password;

    const ITEM_NOT_FOUND: i32 = -25_300;
    match delete_generic_password(KEYCHAIN_SERVICE, key) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == ITEM_NOT_FOUND => Ok(()),
        Err(error) => Err(format!(
            "macOS Keychain could not delete the provider credential (status {}).",
            error.code()
        )),
    }
}

#[cfg(not(target_os = "macos"))]
fn read_secret(_key: &str) -> Result<Option<String>, String> {
    Err("Secure provider credential storage is not available in this desktop build.".to_string())
}

#[cfg(not(target_os = "macos"))]
fn write_secret(_key: &str, _secret: &str) -> Result<(), String> {
    Err("Secure provider credential storage is not available in this desktop build.".to_string())
}

#[cfg(not(target_os = "macos"))]
fn delete_secret(_key: &str) -> Result<(), String> {
    Err("Secure provider credential storage is not available in this desktop build.".to_string())
}

#[tauri::command]
pub fn get_provider_secret(key: String) -> Result<Option<String>, String> {
    validate_key(&key)?;
    read_secret(&key)
}

#[tauri::command]
pub fn save_provider_secret(key: String, secret: String) -> Result<(), String> {
    validate_key(&key)?;
    if secret.trim().is_empty() {
        return Err("MOSS cannot save an empty provider credential.".to_string());
    }
    write_secret(&key, &secret)
}

#[tauri::command]
pub fn remove_provider_secret(key: String) -> Result<(), String> {
    validate_key(&key)?;
    delete_secret(&key)
}
