use fs2::FileExt;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::Path;

#[derive(Debug)]
pub struct InstanceGuard {
    // Closing the handle releases ownership, including after an abnormal exit.
    _file: File,
}

impl InstanceGuard {
    pub fn acquire(data_dir: &Path) -> io::Result<Option<Self>> {
        fs::create_dir_all(data_dir)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(data_dir.join("instance.lock"))?;
        match file.try_lock_exclusive() {
            Ok(()) => Ok(Some(Self { _file: file })),
            Err(error) if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() => {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }
}

// Keep the lock file in place. Removing it lets another process lock a new inode.

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::path::PathBuf;
    use std::process::{Child, Command, Stdio};

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("jarvis-owner-test-{}-{}",
                std::process::id(), uuid::Uuid::new_v4())))
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }
    struct Probe(Child);
    impl Probe {
        fn spawn(dir: &Path) -> Self {
            Self(Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "single_instance::tests::child_probe", "--nocapture"])
                .env("JARVIS_INSTANCE_TEST_DIR", dir)
                .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
                .spawn().unwrap())
        }
        fn signal(&mut self) { self.0.stdin.as_mut().unwrap().write_all(b"continue\n").unwrap(); }
        fn result(&mut self) -> String {
            BufReader::new(self.0.stdout.as_mut().unwrap()).lines()
                .map(Result::unwrap).find_map(|line| line.strip_prefix("instance-test:").map(str::to_owned))
                .expect("child produced an ownership result")
        }
    }
    impl Drop for Probe {
        fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
    }

    #[test]
    fn child_probe() {
        let Some(dir) = std::env::var_os("JARVIS_INSTANCE_TEST_DIR") else { return; };
        let stdin = io::stdin();
        let mut line = String::new();
        stdin.read_line(&mut line).unwrap();
        let guard = InstanceGuard::acquire(Path::new(&dir)).unwrap();
        println!("instance-test:{}", if guard.is_some() { "acquired" } else { "duplicate" });
        io::stdout().flush().unwrap();
        if guard.is_some() { stdin.read_line(&mut line).unwrap(); }
    }

    #[test]
    fn four_simultaneous_starts_have_exactly_one_owner() {
        let dir = TestDir::new();
        let mut probes: Vec<_> = (0..4).map(|_| Probe::spawn(&dir.0)).collect();
        for probe in &mut probes { probe.signal(); }
        let results: Vec<_> = probes.iter_mut().map(Probe::result).collect();
        assert_eq!(results.iter().filter(|result| *result == "acquired").count(), 1);
        assert_eq!(results.iter().filter(|result| *result == "duplicate").count(), 3);
        for (probe, result) in probes.iter_mut().zip(results) {
            if result == "acquired" { probe.signal(); }
            assert!(probe.0.wait().unwrap().success());
        }
        assert!(dir.0.join("instance.lock").exists());
        assert!(InstanceGuard::acquire(&dir.0).unwrap().is_some());
    }

    #[test]
    fn killed_owner_releases_lock_without_deleting_file() {
        let dir = TestDir::new();
        let mut owner = Probe::spawn(&dir.0);
        owner.signal();
        assert_eq!(owner.result(), "acquired");
        assert!(InstanceGuard::acquire(&dir.0).unwrap().is_none());
        owner.0.kill().unwrap();
        owner.0.wait().unwrap();
        assert!(dir.0.join("instance.lock").exists());
        assert!(InstanceGuard::acquire(&dir.0).unwrap().is_some());
    }

    #[test]
    fn separate_data_identity_and_normal_release() {
        let dir = TestDir::new();
        let a = dir.0.join("ordinary");
        let b = dir.0.join("diagnostic");
        let guard_a = InstanceGuard::acquire(&a).unwrap().unwrap();
        let guard_b = InstanceGuard::acquire(&b).unwrap().unwrap();
        assert!(InstanceGuard::acquire(&a).unwrap().is_none());
        drop(guard_a);
        assert!(InstanceGuard::acquire(&a).unwrap().is_some());
        assert!(InstanceGuard::acquire(&b).unwrap().is_none());
        drop(guard_b);
    }

    #[test]
    fn invalid_lock_path_is_an_error_not_an_owner() {
        let dir = TestDir::new();
        fs::create_dir_all(dir.0.join("instance.lock")).unwrap();
        assert!(InstanceGuard::acquire(&dir.0).is_err());
    }
}
