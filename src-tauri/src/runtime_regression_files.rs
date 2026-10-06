use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Cursor, Read};
use std::path::Path;

// Match the existing preparation text/image bounds. This is a Debug-only,
// read-only adapter; it never selects a task or starts inference.
const TEXT_MAX_BYTES: u64 = 10 * 1024 * 1024;
const IMAGE_MAX_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRegressionFile {
    absolute_path: String,
    sha256: String,
    text: Option<String>,
    base64: Option<String>,
    media_type: Option<String>,
}

#[tauri::command]
pub async fn read_runtime_regression_file(
    asset_root: String,
    path: String,
    allow_absolute: bool,
    expected_sha256: Option<String>,
    image: bool,
) -> Result<RuntimeRegressionFile, String> {
    if !cfg!(debug_assertions) {
        return Err("Replay file access requires a Debug build.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        read_file(
            Path::new(&asset_root),
            Path::new(&path),
            allow_absolute,
            expected_sha256.as_deref(),
            image,
        )
    })
    .await
    .map_err(|_| "Replay file worker failed.".to_string())?
}

fn read_file(
    root: &Path,
    path: &Path,
    allow_absolute: bool,
    expected: Option<&str>,
    image: bool,
) -> Result<RuntimeRegressionFile, String> {
    let root = root
        .canonicalize()
        .map_err(|_| "Replay asset root is unavailable.")?;
    if !root.is_dir() {
        return Err("Replay asset root is not a directory.".into());
    }
    if path.is_absolute() && !allow_absolute {
        return Err("Absolute replay assets are not enabled.".into());
    }
    let file = root
        .join(path)
        .canonicalize()
        .map_err(|_| "Replay asset is unavailable.")?;
    if !path.is_absolute() && !file.starts_with(&root) {
        return Err("Replay asset escapes its root.".into());
    }
    let limit = if image {
        IMAGE_MAX_BYTES
    } else {
        TEXT_MAX_BYTES
    };
    if !file
        .metadata()
        .map_err(|_| "Replay asset metadata is unavailable.")?
        .is_file()
    {
        return Err("Replay asset is not a regular file.".into());
    }
    let opened = File::open(&file).map_err(|_| "Replay asset cannot be opened.")?;
    if !opened
        .metadata()
        .map_err(|_| "Replay asset metadata is unavailable.")?
        .is_file()
    {
        return Err("Replay asset is not a file.".into());
    }
    let mut bytes = Vec::new();
    opened
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Replay asset cannot be read.")?;
    if bytes.len() as u64 > limit {
        return Err("Replay asset exceeds the file size limit.".into());
    }
    let sha256 = format!("sha256:{:x}", Sha256::digest(&bytes));
    if expected.is_some_and(|value| value != sha256) {
        return Err("Replay asset digest mismatch.".into());
    }
    let (text, base64, media_type) = if image {
        let mut reader = image::ImageReader::new(Cursor::new(&bytes))
            .with_guessed_format()
            .map_err(|_| "Replay image format is invalid.")?;
        let media = match reader.format() {
            Some(image::ImageFormat::Png) => "image/png",
            Some(image::ImageFormat::Jpeg) => "image/jpeg",
            Some(image::ImageFormat::WebP) => "image/webp",
            _ => return Err("Replay image format is unsupported.".into()),
        };
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(16_384);
        limits.max_image_height = Some(16_384);
        limits.max_alloc = Some(128 * 1024 * 1024);
        reader.limits(limits);
        reader
            .decode()
            .map_err(|_| "Replay image is damaged or exceeds image limits.")?;
        (
            None,
            Some(general_purpose::STANDARD.encode(bytes)),
            Some(media.to_string()),
        )
    } else {
        let text = String::from_utf8(bytes).map_err(|_| "Replay JSON is not UTF-8.")?;
        serde_json::from_str::<serde_json::Value>(&text).map_err(|_| "Replay JSON is invalid.")?;
        (Some(text), None, Some("application/json".into()))
    };
    Ok(RuntimeRegressionFile {
        absolute_path: file.to_string_lossy().into_owned(),
        sha256,
        text,
        base64,
        media_type,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    struct Directory(std::path::PathBuf);
    impl Directory {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("jarvis-replay-file-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn replay_json_is_bounded_read_only_and_digest_checked() {
        let dir = Directory::new();
        let file = dir.0.join("procedure.json");
        let original = b"{\"schemaVersion\":1}";
        fs::write(&file, original).unwrap();
        let result = read_file(&dir.0, Path::new("procedure.json"), false, None, false).unwrap();
        assert_eq!(result.text.as_deref(), Some("{\"schemaVersion\":1}"));
        assert!(read_file(
            &dir.0,
            Path::new("procedure.json"),
            false,
            Some(&result.sha256),
            false
        )
        .is_ok());
        assert!(read_file(
            &dir.0,
            Path::new("procedure.json"),
            false,
            Some("changed"),
            false
        )
        .is_err());
        assert!(read_file(&dir.0, &file, false, None, false).is_err());
        assert!(read_file(&dir.0, &file, true, Some(&result.sha256), false).is_ok());
        assert_eq!(fs::read(&file).unwrap(), original);
        assert!(read_file(&dir.0, Path::new("missing.json"), false, None, false).is_err());
        fs::write(&file, "invalid").unwrap();
        assert!(read_file(&dir.0, Path::new("procedure.json"), false, None, false).is_err());
        fs::write(&file, vec![b' '; TEXT_MAX_BYTES as usize + 1]).unwrap();
        assert!(read_file(&dir.0, Path::new("procedure.json"), false, None, false).is_err());
    }

    #[test]
    fn replay_images_are_decoded_without_reencoding() {
        let dir = Directory::new();
        let file = dir.0.join("image.png");
        image::RgbImage::new(2, 2).save(&file).unwrap();
        let result = read_file(&dir.0, Path::new("image.png"), false, None, true).unwrap();
        assert_eq!(result.media_type.as_deref(), Some("image/png"));
        assert_eq!(
            general_purpose::STANDARD
                .decode(result.base64.unwrap())
                .unwrap(),
            fs::read(&file).unwrap()
        );
        fs::write(&file, b"\x89PNG\r\n\x1a\n").unwrap();
        assert!(read_file(&dir.0, Path::new("image.png"), false, None, true).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn replay_relative_paths_and_symlinks_cannot_escape_the_asset_root() {
        let root = Directory::new();
        let outside = Directory::new();
        let file = outside.0.join("outside.json");
        fs::write(&file, "{}").unwrap();
        std::os::unix::fs::symlink(&file, root.0.join("link.json")).unwrap();
        assert!(read_file(&root.0, Path::new("link.json"), false, None, false).is_err());
        assert!(read_file(&root.0, Path::new("../outside.json"), false, None, false).is_err());
        assert!(read_file(&root.0, Path::new("."), false, None, false).is_err());
    }
}
