import { useEffect, useMemo, useState } from "react";
import {
  ArchiveX,
  Download,
  FolderOpen,
  RefreshCw,
  RotateCcw,
  ThumbsUp,
} from "lucide-react";
import type { CallingAssistantController } from "@/hooks/useCallingAssistant";
import {
  exportCallRecording,
  revealCallRecording,
  revealCallRecordingsRoot,
  type CallRecordingState,
  type CallRecordingSummary,
} from "@/lib/calling";
import "./sessions.css";

type RecordingFilter = "all" | "unfinished" | "closed";

const unfinishedStates = new Set<CallRecordingState>([
  "open",
  "closing",
  "close-failed",
]);

const formatDate = (value?: number) =>
  value
    ? new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(value)
    : "In progress";

const formatDuration = (recording: CallRecordingSummary) => {
  const end = recording.status.endedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - recording.status.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
};

export default function SessionsPage({
  controller,
}: {
  controller: CallingAssistantController;
}) {
  const [filter, setFilter] = useState<RecordingFilter>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void controller.refreshCallRecordings();
  }, [controller.refreshCallRecordings]);

  const recordings = useMemo(() => {
    const current = controller.recordingStatus;
    return controller.callRecordings
      .map((recording) =>
        current?.callSessionId === recording.status.callSessionId
          ? {
              ...recording,
              status: current,
              humanEvaluationCount: controller.runtime.humanEvaluations.length,
            }
          : recording
      )
      .filter((recording) => {
        if (filter === "unfinished") {
          return (
            unfinishedStates.has(recording.status.state) ||
            recording.status.health !== "healthy" ||
            Boolean(recording.integrityError)
          );
        }
        if (filter === "closed") return recording.status.state === "closed";
        return true;
      });
  }, [
    controller.callRecordings,
    controller.recordingStatus,
    controller.runtime.humanEvaluations.length,
    filter,
  ]);

  const run = async (key: string, action: () => Promise<unknown>, success: string) => {
    setBusy(key);
    setError(null);
    setMessage(null);
    try {
      await action();
      setMessage(success);
      await controller.refreshCallRecordings();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="sessions-page" aria-labelledby="sessions-title">
      <header className="sessions-header">
        <div>
          <span className="settings-eyebrow">Local evidence</span>
          <h2 id="sessions-title">Call sessions</h2>
          <p>Recordings contain runtime events, model operations, and guidance feedback. Raw audio is not retained.</p>
        </div>
        <div className="sessions-header-actions">
          <button
            className="icon-button"
            onClick={() => void run("refresh", controller.refreshCallRecordings, "Session list refreshed.")}
            disabled={busy !== null}
            aria-label="Refresh call sessions"
            title="Refresh"
          >
            <RefreshCw size={16} className={busy === "refresh" ? "spin" : undefined} />
          </button>
          <button
            className="secondary-button"
            onClick={() => void run("root", revealCallRecordingsRoot, "Opened the recordings folder.")}
            disabled={busy !== null}
          >
            <FolderOpen size={16} />
            Open folder
          </button>
        </div>
      </header>

      <div className="session-tabs" role="tablist" aria-label="Session filters">
        {(["all", "unfinished", "closed"] as RecordingFilter[]).map((value) => (
          <button
            key={value}
            role="tab"
            aria-selected={filter === value}
            className={filter === value ? "session-tab session-tab-active" : "session-tab"}
            onClick={() => setFilter(value)}
          >
            {value === "all" ? "All" : value === "unfinished" ? "Needs attention" : "Closed"}
          </button>
        ))}
      </div>

      {(message || error) && (
        <div className={error ? "settings-message settings-error" : "settings-message"} role={error ? "alert" : "status"}>
          {error ?? message}
        </div>
      )}

      <div className="session-list">
        {recordings.length === 0 ? (
          <div className="empty-sessions">
            <FolderOpen size={22} />
            <strong>No sessions in this view</strong>
            <span>Start a call to create a local recording.</span>
          </div>
        ) : (
          recordings.map((recording) => {
            const { status } = recording;
            const unfinished = unfinishedStates.has(status.state);
            const incomplete = status.health !== "healthy";
            const isCurrent = controller.recordingStatus?.callSessionId === status.callSessionId;
            return (
              <article className="session-row" key={status.callSessionId}>
                <div className="session-primary">
                  <div>
                    <strong title={status.callSessionId}>{status.callSessionId}</strong>
                    <span className={`recording-state recording-state-${status.state}`}>{status.state}</span>
                    {incomplete && (
                      <span className={`recording-health recording-health-${status.health}`}>
                        {status.health}
                      </span>
                    )}
                  </div>
                  <small>
                    {formatDate(status.startedAt)} · {formatDuration(recording)}
                    {status.endedAt ? ` · ended ${formatDate(status.endedAt)}` : ""}
                  </small>
                  {recording.integrityError && <span className="session-integrity">{recording.integrityError}</span>}
                  {status.incompletenessReasons.length > 0 && (
                    <span className="session-integrity">
                      Evidence incomplete: {status.incompletenessReasons.join(", ")}
                    </span>
                  )}
                </div>

                <div className="session-metrics">
                  <span>
                    <b>{status.persistedEventCount}/{status.attemptedEventCount}</b> events saved
                  </span>
                  {status.droppedEventCount > 0 && (
                    <span className="session-dropped"><b>{status.droppedEventCount}</b> dropped</span>
                  )}
                  <span><ThumbsUp size={13} /><b>{recording.humanEvaluationCount}</b> evaluations</span>
                  <span><b>{recording.manifestAvailable ? "Yes" : "No"}</b> manifest</span>
                </div>

                <div className="session-actions">
                  {unfinished && (
                    <button
                      className="icon-button"
                      onClick={() => void run(
                        `retry-${status.callSessionId}`,
                        isCurrent ? controller.retryClose : () => controller.retryRecoveredRecording(status.callSessionId),
                        "Recording closed."
                      )}
                      disabled={busy !== null}
                      aria-label={`Retry closing ${status.callSessionId}`}
                      title="Retry close"
                    >
                      <RotateCcw size={15} />
                    </button>
                  )}
                  {unfinished && (
                    <button
                      className="icon-button danger-icon"
                      onClick={() => void run(
                        `abandon-${status.callSessionId}`,
                        isCurrent ? controller.abandonClose : () => controller.abandonRecoveredRecording(status.callSessionId),
                        "Recording marked abandoned."
                      )}
                      disabled={busy !== null}
                      aria-label={`Abandon ${status.callSessionId}`}
                      title="Abandon"
                    >
                      <ArchiveX size={15} />
                    </button>
                  )}
                  <button
                    className="icon-button"
                    onClick={() => void run(`reveal-${status.callSessionId}`, () => revealCallRecording(status.callSessionId), "Opened the session folder.")}
                    disabled={busy !== null}
                    aria-label={`Show ${status.callSessionId} in Finder`}
                    title="Show in Finder"
                  >
                    <FolderOpen size={15} />
                  </button>
                  <button
                    className="icon-button"
                    onClick={() => void run(`export-${status.callSessionId}`, () => exportCallRecording(status.callSessionId), "Export created and revealed in Finder.")}
                    disabled={busy !== null}
                    aria-label={`Export ${status.callSessionId}`}
                    title="Export ZIP"
                  >
                    <Download size={15} />
                  </button>
                </div>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
