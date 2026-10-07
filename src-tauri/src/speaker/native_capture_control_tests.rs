use super::*;
use std::sync::{mpsc, Barrier};
use std::thread;

const TEST_WAIT: Duration = Duration::from_secs(3);

#[tokio::test]
async fn capture_can_start_and_stop_without_fabricating_a_sample_rate_before_audio() {
    let state = crate::AudioState::default();
    let (lease, _) = reserve(&state, "waiting-for-first-block");
    activate_capture_if_owner(
        &state,
        &lease,
        NativeCaptureMetadata {
            device_id: None,
            sample_rate: None,
            started_at_ms: 10,
        },
        || tokio::spawn(std::future::pending()),
    )
    .unwrap();
    complete_start(&state, &lease);
    let snapshot = capture_status_snapshot(&state).unwrap();
    assert!(snapshot.active);
    assert_eq!(snapshot.sample_rate, None);
    assert_eq!(snapshot.capture_generation, Some(lease.generation));
    assert_eq!(stop(&state, &lease).await, NativeStopDisposition::Stopped);
}

fn reserve(state: &crate::AudioState, name: &str) -> (NativeCaptureLease, NativeCaptureSignals) {
    let (lease, signals, _) =
        reserve_capture(state, NativeCaptureOwner::Meeting, name.to_string(), None).unwrap();
    (lease, signals)
}

fn metadata(lease: &NativeCaptureLease) -> NativeCaptureMetadata {
    NativeCaptureMetadata {
        device_id: Some(lease.session_id.clone()),
        sample_rate: Some(16_000 + lease.generation as u32),
        started_at_ms: lease.generation,
    }
}

fn activate(state: &crate::AudioState, lease: &NativeCaptureLease) {
    activate_capture_if_owner(state, lease, metadata(lease), || {
        tokio::spawn(std::future::pending())
    })
    .unwrap();
    complete_start(state, lease);
}

fn complete_start(state: &crate::AudioState, lease: &NativeCaptureLease) {
    clear_start_in_flight(&mut state.capture_control.lock().unwrap(), lease);
}

fn snapshot(state: &crate::AudioState) -> serde_json::Value {
    serde_json::to_value(capture_status_snapshot(state).unwrap()).unwrap()
}

fn assert_status_responds(state: &Arc<crate::AudioState>) -> MeetingAudioStatus {
    let (tx, rx) = mpsc::channel();
    let state = state.clone();
    let reader = thread::spawn(move || tx.send(capture_status_snapshot(&state)).unwrap());
    let status = rx
        .recv_timeout(TEST_WAIT)
        .expect("status waited on initialization or join")
        .unwrap();
    reader.join().unwrap();
    status
}

fn assert_tokens_distinct(a: &NativeCaptureSignals, b: &NativeCaptureSignals) {
    assert!(!Arc::ptr_eq(&a.stop_requested, &b.stop_requested));
    assert!(!Arc::ptr_eq(
        &a.termination_requested,
        &b.termination_requested
    ));
    assert!(!Arc::ptr_eq(&a.termination_request, &b.termination_request));
    assert!(!Arc::ptr_eq(&a.stopped, &b.stopped));
}

async fn stop(state: &crate::AudioState, lease: &NativeCaptureLease) -> NativeStopDisposition {
    stop_capture_for_owner(
        state,
        lease.owner,
        Some(&lease.session_id),
        Some(lease.generation),
    )
    .await
    .unwrap()
    .0
}

async fn delayed_start_cannot_touch_replacement(succeeds: bool) {
    let state = Arc::new(crate::AudioState::default());
    let (claimed_tx, claimed_rx) = mpsc::channel();
    let (finish_tx, finish_rx) = mpsc::channel();
    let worker_state = state.clone();
    // This thread is the controllable platform initialization boundary. It uses the
    // same reservation, publication and failure cleanup as start_audio_capture.
    let worker = thread::spawn(move || {
        let (a, signals) = reserve(&worker_state, "A");
        claimed_tx.send((a.clone(), signals.clone())).unwrap();
        finish_rx.recv_timeout(TEST_WAIT).unwrap();
        if succeeds {
            let result = activate_capture_if_owner(&worker_state, &a, metadata(&a), || {
                panic!("superseded initializer must not schedule a task")
            });
            assert_eq!(result.unwrap_err(), "Capture start was superseded");
        } else {
            release_starting_capture(&worker_state, a.owner, &a.session_id, a.generation);
        }
        complete_start(&worker_state, &a);
        assert!(signals.stop_requested.load(Ordering::Acquire));
    });
    let (a, a_signals) = claimed_rx.recv_timeout(TEST_WAIT).unwrap();
    let starting = assert_status_responds(&state);
    assert_eq!(starting.capture_session_id.as_deref(), Some("A"));
    assert!(starting.system_capture_active);
    assert!(starting.sample_rate.is_none());
    assert!(starting.device_id.is_none());
    assert!(starting.started_at_ms.is_none());
    assert_eq!(stop(&state, &a).await, NativeStopDisposition::Stopped);
    assert!(reserve_capture(&state, a.owner, "B-too-early".into(), None).is_err());
    finish_tx.send(()).unwrap();
    worker.join().unwrap();

    let (b, b_signals) = reserve(&state, "B");
    activate(&state, &b);
    assert_tokens_distinct(&a_signals, &b_signals);
    let task_id = {
        let control = state.capture_control.lock().unwrap();
        assert_eq!(
            request_debug_audio_fault(
                &control,
                b.owner,
                &b.session_id,
                b.generation,
                DebugAudioFaultKind::RecoverableStreamEnd.outcome("B-fault")
            )
            .unwrap(),
            DebugAudioFaultDisposition::Injected
        );
        control.task.as_ref().unwrap().id()
    };
    let before = snapshot(&state);

    // Also exercise the late terminal/debug-timeout and stale Stop paths.
    assert!(
        release_active_capture_if_owner(&state, a.owner, &a.session_id, a.generation)
            .unwrap()
            .is_none()
    );
    assert_eq!(stop(&state, &a).await, NativeStopDisposition::StaleRequest);
    {
        let control = state.capture_control.lock().unwrap();
        assert_eq!(control.lease.as_ref(), Some(&b));
        assert_eq!(control.phase, NativeCapturePhase::Active);
        assert_eq!(control.task.as_ref().unwrap().id(), task_id);
        assert!(Arc::ptr_eq(
            &control.signals.as_ref().unwrap().stop_requested,
            &b_signals.stop_requested
        ));
        assert!(Arc::ptr_eq(
            &control.signals.as_ref().unwrap().termination_requested,
            &b_signals.termination_requested
        ));
        assert!(Arc::ptr_eq(
            &control.signals.as_ref().unwrap().termination_request,
            &b_signals.termination_request
        ));
        assert_eq!(
            request_debug_audio_fault(
                &control,
                a.owner,
                &a.session_id,
                a.generation,
                CaptureRunOutcome::panic()
            )
            .unwrap(),
            DebugAudioFaultDisposition::StaleRequest
        );
    }
    a_signals
        .termination_requested
        .store(true, Ordering::Release);
    assert!(take_capture_termination_request(
        &a_signals.termination_requested,
        &a_signals.termination_request,
        a.owner,
        &a.session_id,
        a.generation
    )
    .is_none());
    assert_eq!(snapshot(&state), before);
    assert!(!b_signals.stop_requested.load(Ordering::Acquire));
    assert!(b_signals.termination_requested.load(Ordering::Acquire));
    let outcome = take_capture_termination_request(
        &b_signals.termination_requested,
        &b_signals.termination_request,
        b.owner,
        &b.session_id,
        b.generation,
    )
    .unwrap();
    assert_eq!(
        outcome.diagnostics.fault_injection_id.as_deref(),
        Some("B-fault")
    );
    let released = release_active_capture_if_owner(&state, b.owner, &b.session_id, b.generation)
        .unwrap()
        .unwrap();
    released.task.unwrap().abort();
}

#[tokio::test]
async fn foreground_deadline_releases_business_lease_but_not_native_start_slot() {
    let state = Arc::new(crate::AudioState::default());
    let (lease, _) = reserve(&state, "slow-start");
    let (release_tx, release_rx) = mpsc::channel();
    let (worker_ready_tx, worker_ready_rx) = mpsc::channel();
    let (result_tx, result_rx) = tokio::sync::oneshot::channel::<()>();
    let worker_state = state.clone();
    let worker_lease = lease.clone();
    let worker = thread::spawn(move || {
        worker_ready_tx.send(()).unwrap();
        release_rx.recv_timeout(TEST_WAIT).unwrap();
        let _ = result_tx.send(());
        complete_start(&worker_state, &worker_lease);
    });
    worker_ready_rx.recv_timeout(TEST_WAIT).unwrap();
    assert!(tokio::time::timeout(Duration::from_millis(25), result_rx)
        .await
        .is_err());
    assert_eq!(stop(&state, &lease).await, NativeStopDisposition::Stopped);
    assert!(reserve_capture(&state, lease.owner, "premature-retry".into(), None).is_err());
    release_tx.send(()).unwrap();
    worker.join().unwrap();
    let (next, _) = reserve(&state, "manual-retry");
    assert!(next.generation > lease.generation);
}

#[tokio::test]
async fn late_success_preserves_new_generation_metadata_task_and_signals() {
    delayed_start_cannot_touch_replacement(true).await;
}

#[tokio::test]
async fn late_failure_preserves_new_generation_metadata_task_and_signals() {
    delayed_start_cannot_touch_replacement(false).await;
}

#[tokio::test]
async fn blocked_join_keeps_status_coherent_and_duplicate_stop_waits() {
    let state = Arc::new(crate::AudioState::default());
    let (a, signals) = reserve(&state, "draining");
    let (drain_tx, drain_rx) = tokio::sync::oneshot::channel();
    activate_capture_if_owner(&state, &a, metadata(&a), || {
        tokio::spawn(async {
            drain_rx.await.unwrap();
        })
    })
    .unwrap();
    complete_start(&state, &a);
    let before = snapshot(&state);
    let mut first = Box::pin(stop_capture_for_owner(
        &state,
        a.owner,
        Some(&a.session_id),
        Some(a.generation),
    ));
    assert!(futures_util::poll!(first.as_mut()).is_pending());
    assert!(signals.stop_requested.load(Ordering::Acquire));
    let status = assert_status_responds(&state);
    assert_eq!(serde_json::to_value(status).unwrap(), before);
    let mut duplicate = Box::pin(stop_capture_for_owner(
        &state,
        a.owner,
        Some(&a.session_id),
        Some(a.generation),
    ));
    assert!(futures_util::poll!(duplicate.as_mut()).is_pending());
    assert!(reserve_capture(&state, a.owner, "too-early".into(), None).is_err());
    assert_eq!(
        state.capture_control.lock().unwrap().phase,
        NativeCapturePhase::Stopping
    );
    assert_eq!(snapshot(&state), before);
    assert!(
        release_active_capture_if_owner(&state, a.owner, &a.session_id, a.generation)
            .unwrap()
            .is_none()
    );

    drain_tx.send(()).unwrap();
    let (disposition, terminal_lease) = tokio::time::timeout(TEST_WAIT, first)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(disposition, NativeStopDisposition::Stopped);
    assert_eq!(terminal_lease, Some(a.clone()));
    // Let a new lease start before the duplicate Stop resumes.
    let (b, b_signals) = reserve(&state, "replacement");
    activate(&state, &b);
    let before_duplicate = snapshot(&state);
    let result = tokio::time::timeout(TEST_WAIT, duplicate)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result, (NativeStopDisposition::AlreadyIdle, None));
    assert_eq!(snapshot(&state), before_duplicate);
    assert!(!b_signals.stop_requested.load(Ordering::Acquire));
    release_active_capture_if_owner(&state, b.owner, &b.session_id, b.generation)
        .unwrap()
        .unwrap()
        .task
        .unwrap()
        .abort();
    assert_eq!(stop(&state, &b).await, NativeStopDisposition::AlreadyIdle);
}

#[tokio::test]
async fn stop_timeout_keeps_existing_750ms_drain_policy() {
    assert_eq!(GRACEFUL_CAPTURE_STOP_TIMEOUT_MS, 750);
    let state = crate::AudioState::default();
    let (lease, signals) = reserve(&state, "timeout");
    activate(&state, &lease);
    let abort = state
        .capture_control
        .lock()
        .unwrap()
        .task
        .as_ref()
        .unwrap()
        .abort_handle();
    let started = Instant::now();
    assert_eq!(stop(&state, &lease).await, NativeStopDisposition::Stopped);
    assert!(started.elapsed() >= Duration::from_millis(750));
    assert!(abort.is_finished());
    assert!(signals.stop_requested.load(Ordering::Acquire));
    let control = state.capture_control.lock().unwrap();
    assert_eq!(control.phase, NativeCapturePhase::Idle);
    assert!(control.task.is_none() && control.metadata.is_none() && control.signals.is_none());
}

#[tokio::test]
async fn invalid_config_and_unqualified_requests_leave_owner_unchanged() {
    let state = crate::AudioState::default();
    let mut invalid = VadConfig::default();
    invalid.hop_size = 0;
    assert!(reserve_capture(
        &state,
        NativeCaptureOwner::Meeting,
        "invalid".into(),
        Some(invalid)
    )
    .is_err());
    assert!(
        !capture_status_snapshot(&state)
            .unwrap()
            .system_capture_active
    );
    assert_eq!(state.capture_control.lock().unwrap().generation, 0);
    let (lease, signals) = reserve(&state, "valid");
    activate(&state, &lease);
    let before = snapshot(&state);
    for (owner, session, generation, expected) in [
        (
            lease.owner,
            None,
            Some(lease.generation),
            NativeStopDisposition::StaleRequest,
        ),
        (
            lease.owner,
            Some(lease.session_id.as_str()),
            None,
            NativeStopDisposition::StaleRequest,
        ),
        (
            NativeCaptureOwner::System,
            Some(lease.session_id.as_str()),
            Some(lease.generation),
            NativeStopDisposition::OwnerMismatch,
        ),
    ] {
        assert_eq!(
            stop_capture_for_owner(&state, owner, session, generation)
                .await
                .unwrap()
                .0,
            expected
        );
        assert_eq!(snapshot(&state), before);
        assert!(!signals.stop_requested.load(Ordering::Acquire));
    }
    release_active_capture_if_owner(&state, lease.owner, &lease.session_id, lease.generation)
        .unwrap()
        .unwrap()
        .task
        .unwrap()
        .abort();
}

#[tokio::test]
async fn running_vad_snapshot_does_not_follow_next_generation_template() {
    let state = crate::AudioState::default();
    let (a, _) = reserve(&state, "config-A");
    state.capture_control.lock().unwrap().vad_config.enabled = false;
    assert!(capture_status_snapshot(&state).unwrap().vad_enabled);
    activate(&state, &a);
    assert!(capture_status_snapshot(&state).unwrap().vad_enabled);
    release_active_capture_if_owner(&state, a.owner, &a.session_id, a.generation)
        .unwrap()
        .unwrap()
        .task
        .unwrap()
        .abort();
    assert!(!capture_status_snapshot(&state).unwrap().vad_enabled);
    let (b, _) = reserve(&state, "config-B");
    assert!(!capture_status_snapshot(&state).unwrap().vad_enabled);
    release_starting_capture(&state, b.owner, &b.session_id, b.generation);
    let control = state.capture_control.lock().unwrap();
    assert!(control.lease.is_none() && control.metadata.is_none() && control.task.is_none());
    assert!(control.signals.is_none() && control.capture_vad_config.is_none());
}

#[test]
fn initialization_failure_releases_only_matching_start_and_allows_retry() {
    let state = crate::AudioState::default();
    let (a, signals) = reserve(&state, "failed-init");
    let before = snapshot(&state);
    release_starting_capture(
        &state,
        NativeCaptureOwner::System,
        &a.session_id,
        a.generation,
    );
    release_starting_capture(&state, a.owner, "other-session", a.generation);
    release_starting_capture(&state, a.owner, &a.session_id, a.generation + 1);
    assert_eq!(snapshot(&state), before);
    assert!(!signals.stop_requested.load(Ordering::Acquire));
    release_starting_capture(&state, a.owner, &a.session_id, a.generation);
    assert!(signals.stop_requested.load(Ordering::Acquire));
    let idle = capture_status_snapshot(&state).unwrap();
    assert!(!idle.active && !idle.system_capture_active);
    assert!(idle.capture_owner.is_none() && idle.capture_generation.is_none());
    assert!(reserve_capture(&state, a.owner, "retry-too-early".into(), None).is_err());
    complete_start(&state, &a);
    let (b, _) = reserve(&state, "retry");
    assert!(b.generation > a.generation);
    let before_stale_failure = snapshot(&state);
    release_starting_capture(&state, a.owner, &a.session_id, a.generation);
    assert_eq!(snapshot(&state), before_stale_failure);
}

#[test]
fn superseded_initialized_resource_is_dropped_outside_owner_lock() {
    struct InitializedResource(Arc<crate::AudioState>, Arc<AtomicBool>);
    impl Drop for InitializedResource {
        fn drop(&mut self) {
            assert!(
                self.0.capture_control.try_lock().is_ok(),
                "resource destroyed under owner lock"
            );
            self.1.store(true, Ordering::Release);
        }
    }
    let state = Arc::new(crate::AudioState::default());
    let (a, _) = reserve(&state, "resource-A");
    release_starting_capture(&state, a.owner, &a.session_id, a.generation);
    assert!(reserve_capture(&state, a.owner, "resource-B-too-early".into(), None).is_err());
    let before = snapshot(&state);
    let dropped = Arc::new(AtomicBool::new(false));
    let resource = InitializedResource(state.clone(), dropped.clone());
    assert!(
        activate_capture_if_owner(&state, &a, metadata(&a), move || {
            drop(resource);
            panic!("superseded capture must not spawn")
        })
        .is_err()
    );
    assert!(dropped.load(Ordering::Acquire));
    assert_eq!(snapshot(&state), before);
    complete_start(&state, &a);
    let (b, _) = reserve(&state, "resource-B");
    assert!(b.generation > a.generation);
}

#[tokio::test]
async fn status_never_combines_identity_and_metadata_across_transitions() {
    let state = Arc::new(crate::AudioState::default());
    let (phase_tx, phase_rx) = mpsc::channel();
    let (read_tx, read_rx) = mpsc::channel();
    let reader_state = state.clone();
    let reader = thread::spawn(move || {
        while let Ok((generation, phase)) = phase_rx.recv() {
            let status = capture_status_snapshot(&reader_state).unwrap();
            match phase {
                NativeCapturePhase::Idle => {
                    assert!(!status.system_capture_active);
                    assert!(status.capture_generation.is_none());
                    assert!(status.device_id.is_none() && status.sample_rate.is_none());
                    assert!(status.started_at_ms.is_none());
                }
                NativeCapturePhase::Starting => {
                    assert_eq!(status.capture_generation, Some(generation));
                    assert!(status.system_capture_active && !status.active);
                    assert_eq!(status.capture_owner.as_deref(), Some("system"));
                    assert!(status.device_id.is_none() && status.sample_rate.is_none());
                    assert!(status.started_at_ms.is_none());
                }
                _ => {
                    assert_eq!(status.capture_generation, Some(generation));
                    assert_eq!(
                        status.capture_session_id,
                        Some(format!("system-{generation}"))
                    );
                    assert_eq!(status.device_id, status.capture_session_id);
                    assert_eq!(status.sample_rate, Some(16_000 + generation as u32));
                    assert_eq!(status.started_at_ms, Some(generation));
                    assert!(!status.active && status.system_capture_active);
                }
            }
            read_tx.send(()).unwrap();
        }
    });
    for generation in 1..=16 {
        let (lease, _, _) = reserve_capture(
            &state,
            NativeCaptureOwner::System,
            format!("system-{generation}"),
            None,
        )
        .unwrap();
        phase_tx
            .send((generation, NativeCapturePhase::Starting))
            .unwrap();
        read_rx.recv_timeout(TEST_WAIT).unwrap();
        let (drain_tx, drain_rx) = tokio::sync::oneshot::channel();
        activate_capture_if_owner(&state, &lease, metadata(&lease), || {
            tokio::spawn(async {
                drain_rx.await.unwrap();
            })
        })
        .unwrap();
        complete_start(&state, &lease);
        phase_tx
            .send((generation, NativeCapturePhase::Active))
            .unwrap();
        read_rx.recv_timeout(TEST_WAIT).unwrap();
        let mut stopping = Box::pin(stop(&state, &lease));
        assert!(futures_util::poll!(stopping.as_mut()).is_pending());
        phase_tx
            .send((generation, NativeCapturePhase::Stopping))
            .unwrap();
        read_rx.recv_timeout(TEST_WAIT).unwrap();
        drain_tx.send(()).unwrap();
        assert_eq!(stopping.await, NativeStopDisposition::Stopped);
        phase_tx
            .send((generation, NativeCapturePhase::Idle))
            .unwrap();
        read_rx.recv_timeout(TEST_WAIT).unwrap();
    }
    drop(phase_tx);
    reader.join().unwrap();
}

#[test]
fn simultaneous_claims_have_one_winner_and_independent_next_tokens() {
    let state = Arc::new(crate::AudioState::default());
    let barrier = Arc::new(Barrier::new(3));
    let workers: Vec<_> = [NativeCaptureOwner::Meeting, NativeCaptureOwner::System]
        .into_iter()
        .map(|owner| {
            let state = state.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                reserve_capture(&state, owner, owner.as_str().to_string(), None)
            })
        })
        .collect();
    barrier.wait();
    let winners: Vec<_> = workers
        .into_iter()
        .filter_map(|worker| worker.join().unwrap().ok())
        .collect();
    assert_eq!(winners.len(), 1);
    let (lease, signals, _) = &winners[0];
    release_starting_capture(&state, lease.owner, &lease.session_id, lease.generation);
    assert!(reserve_capture(&state, lease.owner, "next-too-early".into(), None).is_err());
    complete_start(&state, lease);
    let (next, next_signals) = reserve(&state, "next");
    assert!(next.generation > lease.generation);
    assert_tokens_distinct(signals, &next_signals);
}

#[tokio::test]
async fn terminal_outcomes_release_only_matching_active_owner() {
    let outcomes = [
        CaptureRunOutcome::panic(),
        CaptureRunOutcome::from_stream(SpeakerStreamTermination {
            reason: SpeakerStreamTerminationReason::BufferOverflow,
            dropped_samples: 24_000,
            consecutive_drops: 51,
            buffer_capacity: Some(131_072),
        }),
        DebugAudioFaultKind::RecoverableStreamEnd.outcome("recoverable"),
        DebugAudioFaultKind::FatalCaptureFailure.outcome("fatal"),
    ];
    for outcome in outcomes {
        let state = crate::AudioState::default();
        let (lease, signals) = reserve(&state, "terminal");
        activate(&state, &lease);
        {
            let control = state.capture_control.lock().unwrap();
            assert_eq!(
                request_debug_audio_fault(
                    &control,
                    lease.owner,
                    &lease.session_id,
                    lease.generation,
                    outcome.clone()
                )
                .unwrap(),
                DebugAudioFaultDisposition::Injected
            );
        }
        let received = take_capture_termination_request(
            &signals.termination_requested,
            &signals.termination_request,
            lease.owner,
            &lease.session_id,
            lease.generation,
        )
        .unwrap();
        assert_eq!(received, outcome);
        release_active_capture_if_owner(&state, lease.owner, &lease.session_id, lease.generation)
            .unwrap()
            .unwrap()
            .task
            .unwrap()
            .abort();
        assert!(release_active_capture_if_owner(
            &state,
            lease.owner,
            &lease.session_id,
            lease.generation
        )
        .unwrap()
        .is_none());
        let status = capture_status_snapshot(&state).unwrap();
        assert!(!status.system_capture_active);
        assert!(status.capture_session_id.is_none() && status.sample_rate.is_none());
        assert!(signals.stop_requested.load(Ordering::Acquire));
    }
}
