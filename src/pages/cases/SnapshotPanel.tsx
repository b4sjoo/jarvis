import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  FileClock,
  Play,
  RefreshCw,
  ShieldAlert,
  X,
} from "lucide-react";
import {
  CallPreparationSnapshotService,
  diffSnapshotBundles,
  type CallPlan,
  type CallPreparationSnapshotBundle,
} from "@/lib/preparation";

interface SnapshotPanelProps {
  caseId: string;
  plans: CallPlan[];
  onStartCall?: (snapshot: CallPreparationSnapshotBundle) => Promise<void>;
}

const SECTION_LABELS: Array<{
  key: keyof Pick<CallPreparationSnapshotBundle,
    "caseSnapshot" | "callBrief" | "playbookSnapshot" | "speechBiasTerms" | "evidenceIndex" | "safetyConstraints" | "sourceManifest">;
  label: string;
}> = [
  { key: "caseSnapshot", label: "Case state" },
  { key: "callBrief", label: "Call brief" },
  { key: "playbookSnapshot", label: "Playbook" },
  { key: "speechBiasTerms", label: "Speech bias" },
  { key: "evidenceIndex", label: "Evidence index" },
  { key: "safetyConstraints", label: "Safety constraints" },
  { key: "sourceManifest", label: "Source manifest" },
];

export default function SnapshotPanel({ caseId, plans, onStartCall }: SnapshotPanelProps) {
  const [service, setService] = useState<CallPreparationSnapshotService | null>(null);
  const [planId, setPlanId] = useState(plans[0]?.id ?? "");
  const [snapshots, setSnapshots] = useState<CallPreparationSnapshotBundle[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [section, setSection] = useState<(typeof SECTION_LABELS)[number]["key"]>("callBrief");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!plans.some((plan) => plan.id === planId)) setPlanId(plans[0]?.id ?? "");
  }, [planId, plans]);

  const refresh = useCallback(async (owner: CallPreparationSnapshotService, preferredId?: string) => {
    const next = await owner.list(caseId);
    setSnapshots(next);
    setSelectedId((current) => {
      const candidate = preferredId ?? current;
      return candidate && next.some((item) => item.id === candidate) ? candidate : next[0]?.id ?? null;
    });
  }, [caseId]);

  useEffect(() => {
    let active = true;
    void CallPreparationSnapshotService.open().then(async (owner) => {
      if (!active) return;
      setService(owner);
      await refresh(owner);
    }).catch((reason) => active && setError(String(reason)));
    return () => { active = false; };
  }, [refresh]);

  const selected = useMemo(() => snapshots.find((item) => item.id === selectedId) ?? null, [selectedId, snapshots]);
  const previous = useMemo(() => selected
    ? snapshots.filter((item) => item.callPlanId === selected.callPlanId && item.version < selected.version).sort((a, b) => b.version - a.version)[0]
    : undefined, [selected, snapshots]);
  const diff = useMemo(() => selected ? diffSnapshotBundles(selected, previous) : [], [previous, selected]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await operation(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  };

  return <section className="snapshot-panel">
    <header className="case-section-toolbar">
      <div><h3>Call preparation snapshots</h3><p>Freeze reviewed state into one explicit runtime handoff.</p></div>
      <div><select value={planId} onChange={(event) => setPlanId(event.target.value)} aria-label="Call plan to prepare"><option value="">Choose call plan</option>{plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.title}</option>)}</select><button type="button" disabled={busy || !planId} onClick={() => { if (!service || !planId) return; void run(async () => { const compiled = await service.compileDraft({ caseId, callPlanId: planId }); await refresh(service, compiled.id); }); }}><RefreshCw size={14} className={busy ? "spin" : ""} /> Compile draft</button></div>
    </header>
    {error ? <div className="case-inline-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}><X size={13} /></button></div> : null}
    <div className="snapshot-layout">
      <aside className="snapshot-list">
        {snapshots.map((snapshot) => <button type="button" key={snapshot.id} className={snapshot.id === selectedId ? "active" : ""} onClick={() => setSelectedId(snapshot.id)}><FileClock size={16} /><span><strong>{plans.find((plan) => plan.id === snapshot.callPlanId)?.title ?? "Call plan"} · v{snapshot.version}</strong><small>{snapshot.state} · {new Date(snapshot.compiledAt).toLocaleString()}</small></span></button>)}
        {!snapshots.length ? <div className="material-empty"><FileClock size={21} /><p>No compiled snapshots.</p></div> : null}
      </aside>
      {selected ? <div className="snapshot-inspector">
        <header><div><span>{selected.state} · v{selected.version}</span><h3>{plans.find((plan) => plan.id === selected.callPlanId)?.title ?? "Call preparation"}</h3><p>{selected.contentHash.slice(0, 24)}...</p></div><div>{selected.state === "draft" ? <button type="button" className="primary" disabled={busy} onClick={() => void run(async () => { await service?.markReady(selected.id); if (service) await refresh(service, selected.id); })}><CheckCircle2 size={14} /> Mark ready</button> : null}{selected.state === "ready" && onStartCall ? <button type="button" className="primary" disabled={busy} onClick={() => void run(async () => { await onStartCall(selected); })}><Play size={14} /> Start call</button> : null}{selected.state !== "invalidated" ? <button type="button" disabled={busy} onClick={() => { if (!window.confirm("Invalidate this immutable snapshot?")) return; void run(async () => { await service?.invalidate(selected.id, "invalidated-by-user"); if (service) await refresh(service, selected.id); }); }}>Invalidate</button> : null}</div></header>
        {selected.warnings.length ? <section className="snapshot-warnings"><h4>Warnings</h4>{selected.warnings.map((warning, index) => <article key={`${warning.code}-${index}`} className={warning.severity}><ShieldAlert size={14} /><span><strong>{warning.code}</strong><p>{warning.message}</p></span></article>)}</section> : null}
        <nav>{SECTION_LABELS.map((item) => <button type="button" key={item.key} className={section === item.key ? "active" : ""} onClick={() => setSection(item.key)}>{item.label}</button>)}</nav>
        <section className="snapshot-section"><header><h4>{SECTION_LABELS.find((item) => item.key === section)?.label}</h4><span>{selected.artifactManifest.find((item) => item.section === section)?.contentHash.slice(0, 14) ?? "manifest"}</span></header><pre>{JSON.stringify(selected[section], null, 2)}</pre></section>
        <section className="snapshot-provenance"><h4>Version diff and provenance</h4><p>{diff.join(", ")}</p>{selected.artifactManifest.map((artifact) => <article key={artifact.artifactId}><span><strong>{artifact.section}</strong><small>{artifact.artifactPath}</small></span><em>{artifact.sourceRefs.length} sources</em></article>)}</section>
      </div> : <div className="material-empty"><p>Select a snapshot to inspect every compiled section.</p></div>}
    </div>
  </section>;
}
