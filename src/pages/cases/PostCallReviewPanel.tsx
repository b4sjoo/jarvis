import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  FilePlus2,
  History,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import MossSelect from "@/components/ui/MossSelect";
import {
  PostCallReviewService,
  type LinkedCallSession,
  type PendingCaseUpdate,
} from "@/lib/preparation";

export default function PostCallReviewPanel({
  caseId,
  onRevisionChange,
  onPlanChange,
}: {
  caseId: string;
  onRevisionChange: () => Promise<void>;
  onPlanChange: () => Promise<void>;
}) {
  const [service, setService] = useState<PostCallReviewService | null>(null);
  const [sessions, setSessions] = useState<LinkedCallSession[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [updates, setUpdates] = useState<PendingCaseUpdate[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async (
    owner: PostCallReviewService,
    preferredSessionId?: string
  ) => {
    const nextSessions = await owner.listLinkedSessions(caseId);
    setSessions(nextSessions);
    const nextSessionId = preferredSessionId && nextSessions.some((item) => item.callSessionId === preferredSessionId)
      ? preferredSessionId
      : nextSessions[0]?.callSessionId ?? "";
    setSessionId(nextSessionId);
    const nextUpdates = await owner.listPending(caseId, nextSessionId || undefined);
    setUpdates(nextUpdates);
    setDrafts(Object.fromEntries(nextUpdates.map((item) => [item.id, item.proposedStatement.content])));
  }, [caseId]);

  useEffect(() => {
    let active = true;
    void PostCallReviewService.open().then(async (owner) => {
      if (!active) return;
      setService(owner);
      await refresh(owner);
    }).catch((reason) => active && setError(String(reason)));
    return () => { active = false; };
  }, [refresh]);

  useEffect(() => {
    if (!service || !sessionId) return;
    let active = true;
    void service.listPending(caseId, sessionId).then((next) => {
      if (!active) return;
      setUpdates(next);
      setDrafts(Object.fromEntries(next.map((item) => [item.id, item.proposedStatement.content])));
    }).catch((reason) => active && setError(String(reason)));
    return () => { active = false; };
  }, [caseId, service, sessionId]);

  const selected = useMemo(
    () => sessions.find((item) => item.callSessionId === sessionId) ?? null,
    [sessionId, sessions]
  );

  const run = async (operation: () => Promise<void>, success?: string) => {
    if (!service) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await operation();
      await refresh(service, sessionId);
      if (success) setMessage(success);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return <section className="post-call-panel">
    <header className="case-section-toolbar">
      <div><h3>Post-call review</h3><p>Convert sourced call events into reviewed Case revisions.</p></div>
      <div>
        <MossSelect
          ariaLabel="Completed call session"
          value={sessionId}
          onValueChange={setSessionId}
          options={[
            { value: "", label: "Choose a prepared call" },
            ...sessions.map((session) => ({
              value: session.callSessionId,
              label: `${session.callPlanTitle} · ${session.state}`,
            })),
          ]}
        />
        <button type="button" title="Refresh linked sessions" disabled={busy} onClick={() => service && void run(() => refresh(service, sessionId))}><RotateCcw size={14} /></button>
      </div>
    </header>

    {(error || message) ? <div className={error ? "case-inline-error" : "case-inline-message"} role={error ? "alert" : "status"}><span>{error ?? message}</span><button type="button" onClick={() => { setError(null); setMessage(null); }}><X size={13} /></button></div> : null}

    {!selected ? <div className="material-empty"><History size={22} /><p>Complete a call started from a Ready snapshot to review it here.</p></div> : <>
      <div className="post-call-session-summary">
        <div><span>Call plan</span><strong>{selected.callPlanTitle}</strong></div>
        <div><span>Session</span><strong title={selected.callSessionId}>{selected.callSessionId}</strong></div>
        <div><span>Status</span><strong>{selected.state}</strong></div>
        <div><span>Snapshot</span><strong>{selected.snapshotContentHash.slice(0, 14)}...</strong></div>
      </div>

      <div className="post-call-actions">
        <button type="button" disabled={busy || selected.state !== "closed"} onClick={() => void run(async () => { await service?.propose(selected.callSessionId); }, "Post-call proposals are ready for review.")}><RefreshCw size={14} className={busy ? "spin" : ""} /> Generate proposals</button>
        <button type="button" disabled={busy || !updates.some((item) => ["accepted", "edited"].includes(item.reviewState))} onClick={() => void run(async () => { await service?.createFollowUpPlan(selected.callSessionId); await onPlanChange(); }, "A draft follow-up CallPlan was created.")}><FilePlus2 size={14} /> Create follow-up plan</button>
      </div>

      <div className="post-call-update-list">
        {updates.map((update) => {
          const draft = drafts[update.id] ?? update.proposedStatement.content;
          const changed = draft.trim() !== update.proposedStatement.content.trim();
          return <article key={update.id} className={`post-call-update ${update.reviewState}`}>
            <header><span>{update.kind}</span><em>{update.reviewState} · rev {update.rowRevision}</em></header>
            <textarea value={draft} disabled={update.reviewState !== "pending"} onChange={(event) => setDrafts((current) => ({ ...current, [update.id]: event.target.value }))} />
            <div className="post-call-sources"><strong>{update.sourceTurnIds.length} exact call source{update.sourceTurnIds.length === 1 ? "" : "s"}</strong>{update.sourceTurnIds.map((id) => <code key={id}>{id}</code>)}</div>
            {update.reviewState === "pending" ? <footer>
              <button type="button" disabled={busy} onClick={() => void run(async () => { await service?.review({ updateId: update.id, expectedRevision: update.rowRevision, action: changed ? "edit" : "accept", editedContent: draft }); await onRevisionChange(); }, changed ? "Edited update confirmed." : "Update confirmed.")}><Check size={13} /> {changed ? "Edit and confirm" : "Confirm"}</button>
              <button type="button" disabled={busy} onClick={() => void run(async () => { await service?.review({ updateId: update.id, expectedRevision: update.rowRevision, action: "reject" }); }, "Update rejected.")}><X size={13} /> Reject</button>
            </footer> : null}
          </article>;
        })}
        {!updates.length ? <div className="material-empty"><History size={20} /><p>No post-call proposals for this session.</p></div> : null}
      </div>
    </>}
  </section>;
}
