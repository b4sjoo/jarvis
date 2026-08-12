import { useMemo, useState } from "react";
import {
  ArchiveX,
  LayoutDashboard,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Square,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import mossLogo from "../../../src-tauri/icons/icon.png";
import type { CallingAssistantController } from "@/hooks/useCallingAssistant";
import { callStatusLabel } from "@/lib/calling";
import "./calling.css";


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
          <div className="empty-guidance"><Sparkles size={22} /><p>Guidance appears here after an actionable counterparty turn.</p></div>
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

      {(actionError || controller.runtime.lastError || controller.recordingError) && <div className="moss-error">{actionError ?? controller.runtime.lastError ?? controller.recordingError}</div>}

      <footer className="moss-actions">
        {canStart && <button className="primary-button" disabled={!controller.nativeRuntimeAvailable} title={controller.nativeRuntimeAvailable ? undefined : "Available in the desktop app"} onClick={() => void run(controller.start)}><Play size={17} />{state === "start-failed" ? "Retry start" : "Start call"}</button>}
        {state === "live" && <button className="secondary-button" onClick={() => void run(controller.pause)}><Pause size={17} />Pause</button>}
        {(state === "paused" || state === "recovering") && <button className="primary-button" onClick={() => void run(controller.resume)}><Play size={17} />Resume</button>}
        {(["live", "paused", "recovering"] as string[]).includes(state) && <button className="secondary-button" disabled={!latestThem || !controller.configured.advisor} onClick={() => void run(controller.requestGuidance)}><Sparkles size={17} />Advise</button>}
        {(["live", "paused", "recovering", "start-failed"] as string[]).includes(state) && <button className="danger-button" onClick={() => void run(controller.end)}><Square size={15} />End</button>}
        {state === "close-failed" && <button className="primary-button" onClick={() => void run(controller.retryClose)}><RotateCcw size={16} />Retry close</button>}
        {state === "close-failed" && <button className="danger-button" onClick={() => void run(controller.abandonClose)}><ArchiveX size={16} />Abandon</button>}
        <span className="route-health">{controller.nativeRuntimeAvailable ? "Desktop" : "Browser preview"} · Runtime {controller.configured.runtime ? "ready" : "local fallback"} · Advisor {controller.configured.advisor ? "ready" : "not set"} · STT {controller.configured.stt ? "ready" : "not set"}{controller.recordingStatus ? ` · Recording ${controller.recordingStatus.state}` : ""}</span>
      </footer>
    </div>
  );
}
