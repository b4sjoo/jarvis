use std::time::{Duration, Instant};

pub const WAIT_BOUND: Duration = Duration::from_secs(8);
pub const STAGES: [&str; 3] = [
    "freezing-new-work",
    "draining-runtime-and-capture",
    "finalizing-recording-and-traces",
];

#[derive(Clone, Debug)]
pub struct StepReceipt {
    pub stage: String,
    pub result: String,
    pub elapsed_ms: u64,
}

pub struct ShutdownGate {
    pub origin: String,
    pub attempt: u64,
    pub waiting: bool,
    pub forced: bool,
    pub exit_authorized: bool,
    pub started: Instant,
    wait_started: Instant,
    pub results: Vec<StepReceipt>,
    pub unresolved_recording_folder: Option<String>,
}

impl ShutdownGate {
    pub fn new(origin: &str, now: Instant) -> Self {
        Self {
            origin: origin.into(),
            attempt: 1,
            waiting: true,
            forced: false,
            exit_authorized: false,
            started: now,
            wait_started: now,
            results: Vec::new(),
            unresolved_recording_folder: None,
        }
    }

    pub fn expire(&mut self, attempt: u64, now: Instant) -> bool {
        if self.attempt != attempt
            || !self.waiting
            || now.duration_since(self.wait_started) < WAIT_BOUND
        {
            return false;
        }
        self.waiting = false;
        if self.results.len() < STAGES.len() {
            self.results.push(StepReceipt {
                stage: STAGES[self.results.len()].into(),
                result: "timed-out".into(),
                elapsed_ms: WAIT_BOUND.as_millis() as u64,
            });
        }
        true
    }

    pub fn retry(&mut self, now: Instant) -> bool {
        if self.waiting || self.exit_authorized {
            return false;
        }
        self.attempt += 1;
        self.wait_started = now;
        self.waiting = true;
        self.results
            .retain(|r| r.result == "settled" || r.result == "skipped");
        true
    }

    pub fn report(
        &mut self,
        attempt: u64,
        receipt: StepReceipt,
        folder: Option<String>,
        now: Instant,
    ) -> bool {
        self.expire(attempt, now);
        if attempt != self.attempt || !self.waiting || self.exit_authorized {
            return false;
        }
        let Some(index) = STAGES.iter().position(|stage| *stage == receipt.stage) else {
            return false;
        };
        if !matches!(
            receipt.result.as_str(),
            "settled" | "skipped" | "failed-retryable" | "timed-out"
        ) {
            return false;
        }
        if index < self.results.len() {
            return self.results[index].result == receipt.result;
        }
        if index != self.results.len() {
            return false;
        }
        self.waiting = receipt.result == "settled" || receipt.result == "skipped";
        if self.waiting || folder.is_some() {
            self.unresolved_recording_folder = folder;
        }
        self.results.push(receipt);
        true
    }

    pub fn complete(&mut self, attempt: u64, now: Instant) -> bool {
        self.expire(attempt, now);
        if self.attempt != attempt
            || !self.waiting
            || self.exit_authorized
            || self.results.len() != STAGES.len()
            || self
                .results
                .iter()
                .any(|r| r.result != "settled" && r.result != "skipped")
        {
            return false;
        }
        self.waiting = false;
        self.exit_authorized = true;
        true
    }

    pub fn force(&mut self, attempt: u64, now: Instant) -> bool {
        self.expire(attempt, now);
        if self.attempt != attempt || self.waiting || self.exit_authorized {
            return false;
        }
        self.forced = true;
        self.exit_authorized = true;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn settled(index: usize) -> StepReceipt {
        StepReceipt {
            stage: STAGES[index].into(),
            result: "settled".into(),
            elapsed_ms: 1,
        }
    }
    #[test]
    fn timeout_is_not_exit_and_late_completion_needs_retry() {
        let now = Instant::now();
        let mut gate = ShutdownGate::new("application-exit", now);
        assert!(gate.report(1, settled(0), None, now));
        assert!(gate.expire(1, now + WAIT_BOUND));
        assert!(!gate.exit_authorized);
        assert!(!gate.report(1, settled(1), None, now + WAIT_BOUND));
        assert!(!gate.complete(1, now + WAIT_BOUND));
        assert!(gate.retry(now + WAIT_BOUND));
        assert!(!gate.retry(now + WAIT_BOUND));
        assert!(!gate.expire(1, now + WAIT_BOUND * 3));
        assert!(gate.report(2, settled(0), None, now + WAIT_BOUND));
        assert!(gate.report(2, settled(1), None, now + WAIT_BOUND));
        assert!(gate.report(2, settled(2), None, now + WAIT_BOUND));
        assert!(gate.complete(2, now + WAIT_BOUND));
        assert!(!gate.complete(2, now + WAIT_BOUND));
    }
    #[test]
    fn explicit_force_preserves_failure_and_folder() {
        let now = Instant::now();
        let mut gate = ShutdownGate::new("dashboard", now);
        assert!(!gate.force(1, now));
        let mut failure = settled(0);
        failure.result = "failed-retryable".into();
        assert!(gate.report(1, failure, Some("same-folder".into()), now));
        assert!(!gate.complete(1, now));
        assert!(gate.force(1, now));
        assert_eq!(gate.results[0].result, "failed-retryable");
        assert_eq!(
            gate.unresolved_recording_folder.as_deref(),
            Some("same-folder")
        );
    }
    #[test]
    fn native_deadline_wins_even_if_timer_has_not_run() {
        let now = Instant::now();
        let mut gate = ShutdownGate::new("dashboard", now);
        assert!(!gate.report(1, settled(2), None, now));
        for index in 0..3 {
            assert!(gate.report(1, settled(index), None, now));
        }
        assert!(!gate.complete(1, now + WAIT_BOUND));
        assert!(!gate.exit_authorized);
    }

    #[test]
    fn failed_publication_cannot_erase_the_known_unresolved_folder() {
        let now = Instant::now();
        let mut gate = ShutdownGate::new("dashboard", now);
        assert!(gate.report(1, settled(0), Some("recording-A".into()), now));
        assert!(gate.report(1, settled(1), Some("recording-A".into()), now));
        let mut failed = settled(2);
        failed.result = "failed-retryable".into();
        assert!(gate.report(1, failed, None, now));
        assert_eq!(
            gate.unresolved_recording_folder.as_deref(),
            Some("recording-A")
        );
        assert!(!gate.complete(1, now));
    }
}
