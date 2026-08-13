import { useEffect, useMemo, useState } from "react";
import {
  ArchiveX,
  Circle,
  LayoutDashboard,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Square,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import mossLogo from "@/assets/moss-mark.png";
import type { CallingAssistantController } from "@/hooks/useCallingAssistant";
import { callStatusLabel } from "@/lib/calling";
import "./calling.css";

const AUDIO_NOTICE_ACCEPTED_KEY = "moss.call-audio-notice-accepted.v1";

const formatAudioTime = (durationMs: number) => {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

const estimatePcmStorage = (durationMs: number) => {
  const bytes = Math.max(0, durationMs / 1_000) * 48_000 * 2 * 2;
  return bytes < 1_024 ** 2
    ? `${Math.max(1, Math.round(bytes / 1_024))} KB`
    : `${(bytes / 1_024 ** 2).toFixed(1)} MB`;
};

export default function CallingPage({
  controller,
  embedded = false,
  onOpenControlCenter,
}: {
  controller: CallingAssistantController;
  embedded?: boolean;
  onOpenControlCenter?: () => void;
}) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [showAudioNotice, setShowAudioNotice] = useState(false);
  const [audioClock, setAudioClock] = useState(() => Date.now());
  const latestThem = useMemo(() => [...controller.runtime.transcript].reverse().find((turn) => turn.speaker === "them"), [controller.runtime.transcript]);
  const currentEvaluation = useMemo(
    () => controller.runtime.humanEvaluations.find(
      (fact) => fact.guidanceRevision === controller.runtime.guidanceRevision
    ),
    [controller.runtime.guidanceRevision, controller.runtime.humanEvaluations]
  );
  const historicalRecoverables = useMemo(
    () => controller.recoverableRecordings.filter(
      (recording) => recording.callSessionId !== controller.runtime.callSessionId
    ),
    [controller.recoverableRecordings, controller.runtime.callSessionId]
  );
  const run = async (action: () => Promise<void>) => {
    setActionError(null);
    try { await action(); } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
  };
  const state = controller.runtime.state;
  const canStart = ["planned", "closed", "start-failed", "abandoned"].includes(state);
  const preparation = controller.runtime.preparation;
  const audioManifest = controller.audioRecordingManifest;
  const audioIsWriting = audioManifest?.state === "recording";
  const recordedDurationMs = Math.max(
    0,
    ...(audioManifest?.channels.map((channel) => channel.durationMs) ?? [])
  );
  const audioDurationMs = recordedDurationMs + (
    audioIsWriting ? Math.max(0, audioClock - audioManifest.requestedAt) : 0
  );
  const canToggleAudio = ["live", "paused"].includes(state)
    || (state === "recovering" && controller.audioRecordingDesired);
  const audioStatus = controller.audioRecordingArmed
    ? "Armed"
    : audioIsWriting
      ? `REC ${formatAudioTime(audioDurationMs)} · ~${estimatePcmStorage(audioDurationMs)}`
      : audioManifest?.state === "partial" || audioManifest?.state === "error"
        ? "Partial audio"
        : controller.audioRecordingDesired
          ? "Starting"
          : null;

  useEffect(() => {
    if (!audioIsWriting) return;
    const timer = window.setInterval(() => setAudioClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [audioIsWriting]);

  const toggleAudioRecording = () => {
    if (controller.audioRecordingDesired) {
      void run(controller.stopAudioRecording);
      return;
    }
    if (window.localStorage.getItem(AUDIO_NOTICE_ACCEPTED_KEY) === "true") {
      void run(controller.startAudioRecording);
      return;
    }
    setShowAudioNotice(true);
  };

  const confirmAudioRecording = () => {
    window.localStorage.setItem(AUDIO_NOTICE_ACCEPTED_KEY, "true");
    setShowAudioNotice(false);
    void run(controller.startAudioRecording);
  };

  return (
    <div className={`moss-shell${embedded ? " moss-shell-embedded" : ""}`}>
      {!embedded && <header className="moss-topbar">
        {onOpenControlCenter && (
          <button
            className="icon-button"
            onClick={onOpenControlCenter}
            aria-label="Open control center"
            title="Control center"
          >
            <LayoutDashboard size={18} />
          </button>
        )}
        <div className="moss-brand" data-tauri-drag-region><span className="brand-mark"><img src={mossLogo} alt="" aria-hidden="true" /></span><div><strong>MOSS</strong><span>Calling Helper</span></div></div>
        <div className={`status status-${state}`} data-tauri-drag-region><span />{callStatusLabel(state)}</div>
      </header>}

      <section className="moss-guidance" aria-live="polite">
        <div className="section-heading"><span>Live Guidance</span><small>{preparation.mode === "prepared" ? `Prepared · ${preparation.runtime.objective}` : "Neutral · no preparation snapshot"} · revision {controller.runtime.guidanceRevision}</small></div>
        {controller.runtime.visibleGuidance ? (
          <div className="guidance-layout">
            <div className="guidance-primary"><h2>Say</h2>{controller.runtime.visibleGuidance.say.map((line) => <p key={line}>{line}</p>)}</div>
            <div className="guidance-secondary">
              <div><h3>Ask</h3>{controller.runtime.visibleGuidance.ask.length ? controller.runtime.visibleGuidance.ask.map((line) => <p key={line}>{line}</p>) : <p className="muted">No clarification needed.</p>}</div>
              <div><h3>Avoid</h3>{controller.runtime.visibleGuidance.avoid.length ? controller.runtime.visibleGuidance.avoid.map((line) => <p key={line}>{line}</p>) : <p className="muted">No active warning.</p>}</div>
            </div>
            <div className="guidance-footer"><span><b>Call state</b> {controller.runtime.visibleGuidance.callState}</span><span><b>Next move</b> {controller.runtime.visibleGuidance.nextMove}</span></div>
            <div className="guidance-evaluation" aria-label="Evaluate this guidance">
              <span>{currentEvaluation ? "Feedback recorded" : "Was this useful?"}</span>
              <button
                className={currentEvaluation?.label === "helpful" ? "evaluation-selected" : "icon-button"}
                disabled={Boolean(currentEvaluation) || !["live", "paused", "recovering"].includes(state)}
                onClick={() => void run(() => controller.evaluateGuidance("helpful"))}
                aria-label="Mark guidance helpful"
                title="Helpful"
              ><ThumbsUp size={15} /></button>
              <button
                className={currentEvaluation?.label === "not-useful" ? "evaluation-selected" : "icon-button"}
                disabled={Boolean(currentEvaluation) || !["live", "paused", "recovering"].includes(state)}
                onClick={() => void run(() => controller.evaluateGuidance("not-useful"))}
                aria-label="Mark guidance not useful"
                title="Not useful"
              ><ThumbsDown size={15} /></button>
            </div>
          </div>
        ) : (
          <div className="empty-guidance"><img className="empty-guidance-mark" src={mossLogo} alt="" aria-hidden="true" /><p>Guidance appears here after an actionable counterparty turn.</p></div>
        )}
      </section>

      <section className="moss-transcript">
        <div className="section-heading"><span>Latest Counterparty Turn</span><small>{controller.runtime.latestSettlement?.counterpartyMove ?? "unsettled"}</small></div>
        <p>{latestThem?.text ?? "Listening has not started."}</p>
      </section>

      {!controller.nativeRuntimeAvailable && (
        <div className="moss-runtime-notice" role="status">
          Browser preview is active. Native audio and local call recording are
          available in the MOSS desktop app.
        </div>
      )}

      {historicalRecoverables.length > 0 && (
        <section className="recording-recovery" aria-label="Recoverable call recordings">
          <strong>Unfinished recordings</strong>
          {historicalRecoverables.map((recording) => (
            <div key={recording.callSessionId}>
              <span title={recording.recordingPath}>{recording.callSessionId} · {recording.state} · {recording.eventCount} events</span>
              <button className="icon-button" onClick={() => void run(() => controller.retryRecoveredRecording(recording.callSessionId))} aria-label={`Retry closing ${recording.callSessionId}`} title="Retry close"><RotateCcw size={15} /></button>
              <button className="icon-button" onClick={() => void run(() => controller.abandonRecoveredRecording(recording.callSessionId))} aria-label={`Abandon ${recording.callSessionId}`} title="Abandon recording"><ArchiveX size={15} /></button>
            </div>
          ))}
        </section>
      )}

      {(actionError || controller.runtime.lastError || controller.recordingError || controller.audioRecordingError) && <div className="moss-error">{actionError ?? controller.runtime.lastError ?? controller.recordingError ?? controller.audioRecordingError}</div>}

      <footer className="moss-actions">
        {canStart && <button className="primary-button" disabled={!controller.nativeRuntimeAvailable} title={controller.nativeRuntimeAvailable ? undefined : "Available in the desktop app"} onClick={() => void run(controller.start)}><Play size={17} />{state === "start-failed" ? "Retry start" : "Start call"}</button>}
        {state === "live" && <button className="secondary-button" onClick={() => void run(controller.pause)}><Pause size={17} />Pause</button>}
        {(state === "paused" || state === "recovering") && <button className="primary-button" onClick={() => void run(controller.resume)}><Play size={17} />Resume</button>}
        {(["live", "paused", "recovering"] as string[]).includes(state) && (
          <div className="audio-recording-control">
            <button
              className={controller.audioRecordingDesired ? "recording-button recording-button-active" : "recording-button"}
              disabled={!canToggleAudio}
              onClick={toggleAudioRecording}
              aria-label={controller.audioRecordingDesired ? "Stop call audio recording" : "Record call audio"}
              title={controller.audioRecordingDesired ? "Stop audio recording" : "Record both sides locally"}
            >
              {controller.audioRecordingDesired ? <Square size={13} fill="currentColor" /> : <Circle size={17} fill="currentColor" />}
            </button>
            {audioStatus && <span className={audioIsWriting ? "audio-recording-status audio-recording-status-live" : "audio-recording-status"}>{audioStatus}</span>}
          </div>
        )}
        {(["live", "paused", "recovering"] as string[]).includes(state) && <button className="secondary-button" disabled={!latestThem || !controller.configured.advisor} onClick={() => void run(controller.requestGuidance)}><Sparkles size={17} />Advise</button>}
        {(["live", "paused", "recovering", "start-failed"] as string[]).includes(state) && <button className="danger-button" onClick={() => void run(controller.end)}><Square size={15} />End</button>}
        {state === "close-failed" && <button className="primary-button" onClick={() => void run(controller.retryClose)}><RotateCcw size={16} />Retry close</button>}
        {state === "close-failed" && <button className="danger-button" onClick={() => void run(controller.abandonClose)}><ArchiveX size={16} />Abandon</button>}
        <span className="route-health">{controller.nativeRuntimeAvailable ? "Desktop" : "Browser preview"} · Runtime {controller.configured.runtime ? "ready" : "local fallback"} · Advisor {controller.configured.advisor ? "ready" : "not set"} · STT {controller.configured.stt ? "ready" : "not set"}{controller.recordingStatus ? ` · Recording ${controller.recordingStatus.state}` : ""}</span>
      </footer>

      {showAudioNotice && (
        <div className="audio-notice-layer">
          <section className="audio-notice" role="dialog" aria-modal="true" aria-labelledby="audio-notice-title">
            <header>
              <div>
                <span>Local audio evidence</span>
                <h2 id="audio-notice-title">Record both sides of this call?</h2>
              </div>
              <button className="icon-button" onClick={() => setShowAudioNotice(false)} aria-label="Close recording notice"><X size={17} /></button>
            </header>
            <p>MOSS will save separate local tracks for your microphone and system audio. Temporary audio becomes eligible for deletion 72 hours after the call closes.</p>
            <p>You are responsible for obtaining any consent required by the participants and applicable law.</p>
            <footer>
              <button className="secondary-button" onClick={() => setShowAudioNotice(false)}>Cancel</button>
              <button className="danger-button" onClick={confirmAudioRecording}><Circle size={15} fill="currentColor" />Start recording</button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
