import { useEffect, useMemo, useState } from "react";
import {
  ArchiveX,
  Download,
  FolderOpen,
  Headphones,
  Info,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import type { CallingAssistantController } from "@/hooks/useCallingAssistant";
import {
  exportCallRecording,
  deleteCallAudioRecording,
  getCallAudioRecording,
  preserveCallAudioRecording,
  revealCallAudioRecording,
  revealCallRecording,
  revealCallRecordingsRoot,
  type CallAudioManifest,
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

const pad = (value: number) => String(value).padStart(2, "0");

const formatDate = (value?: number | null) => {
  if (!value) return "—";
  const date = new Date(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const formatDateTime = (value?: number | null) => {
  if (!value) return "—";
  const date = new Date(value);
  return `${formatDate(value)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const formatDuration = (recording: CallRecordingSummary) => {
  const end = recording.status.endedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - recording.status.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
};

const formatAudioDuration = (durationMs: number) => {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
};

const formatBytes = (bytes: number) => {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 ** 2) return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_024 ** 3) return `${(bytes / 1_024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1_024 ** 3).toFixed(2)} GB`;
};

const audioRetentionLabel = (audio: {
  retentionMode: "temporary" | "preserved" | "deleted";
  expiresAt: number | null;
} | null) => {
  if (!audio) return "No audio";
  if (audio.retentionMode === "deleted") return "Audio deleted";
  if (audio.retentionMode === "preserved") return "Audio preserved";
  return audio.expiresAt ? formatDateTime(audio.expiresAt) : "Temporary audio";
};

const AUDIO_EXPIRE_SOON_MS = 24 * 60 * 60 * 1_000;

const audioExpiryState = (
  audio: CallRecordingSummary["audioRecording"],
  now: number
) => {
  if (
    !audio ||
    audio.retentionMode !== "temporary" ||
    audio.expiresAt === null
  ) return null;
  if (audio.expiresAt <= now) return "expired";
  return audio.expiresAt - now <= AUDIO_EXPIRE_SOON_MS ? "soon" : null;
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
  const [audioSessionId, setAudioSessionId] = useState<string | null>(null);
  const [audioManifest, setAudioManifest] = useState<CallAudioManifest | null>(null);
  const [infoSessionId, setInfoSessionId] = useState<string | null>(null);
  const [exportSessionId, setExportSessionId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void controller.refreshCallRecordings();
  }, [controller.refreshCallRecordings]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

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
            Boolean(recording.integrityError) ||
            audioExpiryState(recording.audioRecording, now) !== null
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
    now,
  ]);

  const infoRecording = recordings.find(
    (recording) => recording.status.callSessionId === infoSessionId
  ) ?? null;
  const exportRecording = recordings.find(
    (recording) => recording.status.callSessionId === exportSessionId
  ) ?? null;

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

  const openAudio = async (callSessionId: string) => {
    setBusy(`audio-${callSessionId}`);
    setError(null);
    try {
      const manifest = await getCallAudioRecording(callSessionId);
      setAudioManifest(manifest);
      setAudioSessionId(manifest ? callSessionId : null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const updateAudio = async (
    key: string,
    action: () => Promise<CallAudioManifest>,
    success: string
  ) => {
    setBusy(key);
    setError(null);
    setMessage(null);
    try {
      const manifest = await action();
      setAudioManifest(manifest);
      setMessage(success);
      await controller.refreshCallRecordings();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const exportSession = (
    recording: CallRecordingSummary,
    includeAudio: boolean
  ) => {
    setExportSessionId(null);
    return run(
      `export-${recording.status.callSessionId}`,
      () => exportCallRecording(recording.status.callSessionId, includeAudio),
      includeAudio
        ? "Export with audio created and revealed in Finder."
        : "Session export created and revealed in Finder."
    );
  };

  return (
    <section className="sessions-page" aria-labelledby="sessions-title">
      <header className="sessions-header">
        <div>
          <span className="settings-eyebrow">Local evidence</span>
          <h2 id="sessions-title">Call sessions</h2>
          <p>Recordings contain runtime events, model operations, and guidance feedback. Audio exists only when you explicitly record it.</p>
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
            const expiryState = audioExpiryState(recording.audioRecording, now);
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
                    {expiryState && (
                      <span className={`audio-expiry audio-expiry-${expiryState}`}>
                        {expiryState === "expired" ? "AUDIO EXPIRED" : "AUDIO EXPIRE SOON"}
                      </span>
                    )}
                  </div>
                  <small>
                    {formatDate(status.startedAt)} · {formatDuration(recording)}
                  </small>
                </div>

                <div className="session-actions">
                  <button
                    className="icon-button"
                    onClick={() => setInfoSessionId(status.callSessionId)}
                    disabled={busy !== null}
                    aria-label={`Review details for ${status.callSessionId}`}
                    title="Session information"
                  >
                    <Info size={15} />
                  </button>
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
                    className={audioSessionId === status.callSessionId ? "icon-button session-action-active" : "icon-button"}
                    onClick={() => void openAudio(status.callSessionId)}
                    disabled={busy !== null || !recording.audioRecording}
                    aria-label={`Review audio for ${status.callSessionId}`}
                    title={recording.audioRecording ? "Review audio evidence" : "No audio recording"}
                  >
                    <Headphones size={15} />
                  </button>
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
                    onClick={() => {
                      const audioAvailable = Boolean(
                        recording.audioRecording &&
                        recording.audioRecording.retentionMode !== "deleted" &&
                        recording.audioRecording.chunkCount > 0
                      );
                      if (audioAvailable) {
                        setExportSessionId(status.callSessionId);
                      } else {
                        void exportSession(recording, false);
                      }
                    }}
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

      {infoRecording && (
        <div className="session-modal-layer" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setInfoSessionId(null);
        }}>
          <section className="session-modal" role="dialog" aria-modal="true" aria-labelledby="session-info-title">
            <header>
              <div>
                <span>Session information</span>
                <h3 id="session-info-title">{infoRecording.status.callSessionId}</h3>
              </div>
              <button className="icon-button" onClick={() => setInfoSessionId(null)} aria-label="Close session information" title="Close">
                <X size={16} />
              </button>
            </header>
            <dl className="session-detail-grid">
              <div><dt>Started</dt><dd>{formatDateTime(infoRecording.status.startedAt)}</dd></div>
              <div><dt>Ended</dt><dd>{formatDateTime(infoRecording.status.endedAt)}</dd></div>
              <div><dt>Duration</dt><dd>{formatDuration(infoRecording)}</dd></div>
              <div><dt>State</dt><dd>{infoRecording.status.state}</dd></div>
              <div><dt>Health</dt><dd>{infoRecording.status.health}</dd></div>
              <div><dt>Events</dt><dd>{infoRecording.status.persistedEventCount}/{infoRecording.status.attemptedEventCount}</dd></div>
              <div><dt>Dropped events</dt><dd>{infoRecording.status.droppedEventCount}</dd></div>
              <div><dt>Guidance feedback</dt><dd>{infoRecording.humanEvaluationCount}</dd></div>
            </dl>
            {(infoRecording.integrityError || infoRecording.status.incompletenessReasons.length > 0) && (
              <div className="session-detail-warning">
                <strong>Evidence incomplete:</strong>
                {infoRecording.integrityError && <span>{infoRecording.integrityError}</span>}
                {infoRecording.status.incompletenessReasons.map((reason) => <span key={reason}>{reason}</span>)}
              </div>
            )}
          </section>
        </div>
      )}

      {audioSessionId && audioManifest && (
        <div className="session-modal-layer" onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            setAudioSessionId(null);
            setAudioManifest(null);
          }
        }}>
          <section className="session-modal session-audio-modal" role="dialog" aria-modal="true" aria-labelledby="audio-info-title">
            <header>
              <div>
                <span>Audio information</span>
                <h3 id="audio-info-title">{audioManifest.callSessionId}</h3>
              </div>
              <button className="icon-button" onClick={() => {
                setAudioSessionId(null);
                setAudioManifest(null);
              }} aria-label="Close audio information" title="Close">
                <X size={16} />
              </button>
            </header>

            <div className="session-audio-summary">
              <strong>{audioRetentionLabel(audioManifest)}</strong>
              <span>{formatBytes(audioManifest.channels.reduce((sum, channel) => sum + channel.byteCount, 0))}</span>
            </div>

            <dl className="session-detail-grid session-audio-detail-grid">
              <div><dt>Recording state</dt><dd>{audioManifest.state}</dd></div>
              <div><dt>Retention</dt><dd>{audioManifest.retentionMode}</dd></div>
              <div><dt>Audio chunks</dt><dd>{audioManifest.chunks.length}</dd></div>
              <div><dt>Audio revision</dt><dd>{audioManifest.audioRecordingRevision}</dd></div>
              <div><dt>Counterparty duration</dt><dd>{formatAudioDuration(audioManifest.channels.find((channel) => channel.channel === "them")?.durationMs ?? 0)}</dd></div>
              <div><dt>Your duration</dt><dd>{formatAudioDuration(audioManifest.channels.find((channel) => channel.channel === "me")?.durationMs ?? 0)}</dd></div>
              <div><dt>Started</dt><dd>{formatDateTime(audioManifest.startedAt)}</dd></div>
              <div><dt>Stopped</dt><dd>{formatDateTime(audioManifest.stoppedAt)}</dd></div>
              <div><dt>Expiration date</dt><dd>{formatDateTime(audioManifest.expiresAt)}</dd></div>
              <div><dt>Preserved</dt><dd>{formatDateTime(audioManifest.preservedAt)}</dd></div>
            </dl>

            <div className="session-audio-health">
              {audioManifest.channels.map((channel) => (
                <span key={channel.channel} className={`audio-health audio-health-${channel.health}`}>
                  <b>{channel.channel === "them" ? "Counterparty" : "You"}</b> {channel.health} · {channel.chunkCount} chunks · {channel.gapCount} gaps
                </span>
              ))}
            </div>

            {(audioManifest.lastError || audioManifest.failureStage) && (
              <div className="session-detail-warning">
                <strong>Audio evidence incomplete:</strong>
                {audioManifest.failureStage && <span>{audioManifest.failureStage}</span>}
                {audioManifest.lastError && <span>{audioManifest.lastError}</span>}
              </div>
            )}

            <footer className="session-audio-actions">
              {audioManifest.retentionMode === "temporary" && audioManifest.state !== "deleted" && (
                <button className="secondary-button" disabled={busy !== null} onClick={() => void updateAudio(
                  `preserve-${audioSessionId}`,
                  () => preserveCallAudioRecording({ callSessionId: audioSessionId, expectedRevision: audioManifest.audioRecordingRevision }),
                  "Audio preserved until you delete it."
                )}><ShieldCheck size={14} />Preserve</button>
              )}
              {audioManifest.retentionMode !== "deleted" && (
                <button className="danger-button" disabled={busy !== null} onClick={() => {
                  if (!window.confirm("Permanently delete this session's audio? Transcript, events, and the deletion tombstone will remain.")) return;
                  void updateAudio(
                    `delete-audio-${audioSessionId}`,
                    () => deleteCallAudioRecording({ callSessionId: audioSessionId, expectedRevision: audioManifest.audioRecordingRevision }),
                    "Audio deleted; structured session evidence remains."
                  );
                }}><Trash2 size={14} />Delete</button>
              )}
              <button
                className="secondary-button"
                disabled={busy !== null || audioManifest.retentionMode === "deleted"}
                onClick={() => void run(
                  `reveal-audio-${audioSessionId}`,
                  () => revealCallAudioRecording(audioSessionId),
                  "Opened the audio folder."
                )}
              ><FolderOpen size={14} />Open folder</button>
            </footer>
          </section>
        </div>
      )}

      {exportRecording && (
        <div className="session-modal-layer" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setExportSessionId(null);
        }}>
          <section className="session-modal session-export-modal" role="dialog" aria-modal="true" aria-labelledby="session-export-title">
            <header>
              <div>
                <span>Session export</span>
                <h3 id="session-export-title">Include retained audio?</h3>
              </div>
              <button className="icon-button" onClick={() => setExportSessionId(null)} aria-label="Cancel session export" title="Cancel">
                <X size={16} />
              </button>
            </header>
            <p>Audio exports are independent copies and are not covered by MOSS's 72-hour cleanup policy.</p>
            <footer>
              <button className="secondary-button" onClick={() => void exportSession(exportRecording, false)} disabled={busy !== null}>Without audio</button>
              <button className="primary-button" onClick={() => void exportSession(exportRecording, true)} disabled={busy !== null}>Include audio</button>
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}
