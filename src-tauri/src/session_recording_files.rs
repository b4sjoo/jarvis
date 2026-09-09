use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

// Same-directory rename publishes one complete manifest. This is not a
// cross-file transaction or a promise of power-loss durability.
pub(crate) fn replace_manifest(path: &Path, payload: &[u8]) -> io::Result<()> {
    replace_manifest_with(path, payload, |file, bytes| file.write_all(bytes))
}

fn replace_manifest_with(
    path: &Path,
    payload: &[u8],
    write: impl FnOnce(&mut File, &[u8]) -> io::Result<()>,
) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Manifest needs a parent directory",
        )
    })?;
    let mut opened = None;
    for _ in 0..32 {
        let temporary = parent.join(format!(
            ".manifest-{}-{}.tmp",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => {
                opened = Some((temporary, file));
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    let (temporary, mut file) = opened.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::AlreadyExists,
            "Could not reserve a manifest temporary file",
        )
    })?;
    let result = (|| {
        write(&mut file, payload)?;
        file.flush()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    const RUNNING: &[u8] = br#"{"status":"running"}"#;
    const STOPPED: &[u8] = br#"{"status":"stopped","recordingIntegrity":{"status":"complete"}}"#;

    struct Directory(PathBuf);

    impl Directory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "jarvis-recording-files-{}-{}",
                std::process::id(),
                NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn manifest(&self) -> PathBuf {
            self.0.join("manifest.json")
        }
    }

    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn partial_write_failure_preserves_running_manifest_and_retry_replaces_it() {
        let directory = Directory::new();
        let path = directory.manifest();
        replace_manifest(&path, RUNNING).unwrap();
        let result = replace_manifest_with(&path, STOPPED, |file, bytes| {
            file.write_all(&bytes[..10])?;
            Err(io::Error::other("injected partial write failure"))
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&path).unwrap(), RUNNING);
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
        replace_manifest(&path, STOPPED).unwrap();
        assert_eq!(fs::read(&path).unwrap(), STOPPED);
        replace_manifest(&path, STOPPED).unwrap();
        assert_eq!(fs::read(&path).unwrap(), STOPPED);
    }

    #[test]
    fn replacement_failure_is_reported_and_does_not_remove_target() {
        let directory = Directory::new();
        let path = directory.manifest();
        fs::create_dir(&path).unwrap();
        assert!(replace_manifest(&path, STOPPED).is_err());
        assert!(path.is_dir());
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }

    #[test]
    fn interrupted_temporary_write_keeps_old_manifest() {
        let directory = Directory::new();
        let path = directory.manifest();
        replace_manifest(&path, RUNNING).unwrap();
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                &format!(
                    "{}::interrupt_child",
                    module_path!().split_once("::").unwrap().1
                ),
                "--nocapture",
            ])
            .env("JARVIS_RECORDING_INTERRUPT_TEST", &path)
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(23));
        assert_eq!(fs::read(&path).unwrap(), RUNNING);
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 2);
        replace_manifest(&path, STOPPED).unwrap();
        assert_eq!(fs::read(&path).unwrap(), STOPPED);
    }

    #[test]
    fn interrupt_child() {
        let Some(path) = std::env::var_os("JARVIS_RECORDING_INTERRUPT_TEST") else {
            return;
        };
        let _ = replace_manifest_with(Path::new(&path), STOPPED, |file, bytes| {
            file.write_all(&bytes[..10]).unwrap();
            file.flush().unwrap();
            std::process::exit(23);
        });
        panic!("child must exit before replacement");
    }

    #[test]
    fn characterize_manifest_publication() {
        let directory = Directory::new();
        let path = directory.manifest();
        let payload = format!(r#"{{"status":"stopped","padding":"{}"}}"#, "x".repeat(8192));
        for _ in 0..8 {
            fs::write(&path, &payload).unwrap();
            replace_manifest(&path, payload.as_bytes()).unwrap();
        }
        let mut direct = Vec::new();
        let mut atomic = Vec::new();
        for _ in 0..40 {
            let start = std::time::Instant::now();
            fs::write(&path, &payload).unwrap();
            direct.push(start.elapsed().as_micros());
            let start = std::time::Instant::now();
            replace_manifest(&path, payload.as_bytes()).unwrap();
            atomic.push(start.elapsed().as_micros());
        }
        direct.sort_unstable();
        atomic.sort_unstable();
        println!(
            "40 alternating warm 8KiB manifest writes (microseconds): direct median={} p95={} range={}..{}; atomic median={} p95={} range={}..{}",
            direct[20], direct[37], direct[0], direct[39],
            atomic[20], atomic[37], atomic[0], atomic[39]
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), payload);
    }
}
