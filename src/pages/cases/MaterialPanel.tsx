import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Check,
  FileSearch,
  LoaderCircle,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import {
  MaterialPreparationService,
  materialSnapshotEligible,
  type CallPlan,
  type CaseMaterial,
  type ExtractionChunk,
  type ExtractionRun,
} from "@/lib/preparation";

interface MaterialWithRun {
  material: CaseMaterial;
  run?: ExtractionRun;
}

export default function MaterialPanel({
  caseId,
  plans,
}: {
  caseId: string;
  plans: CallPlan[];
}) {
  const [service, setService] = useState<MaterialPreparationService | null>(null);
  const [scope, setScope] = useState<string>("case");
  const [items, setItems] = useState<MaterialWithRun[]>([]);
  const [selected, setSelected] = useState<MaterialWithRun | null>(null);
  const [chunks, setChunks] = useState<ExtractionChunk[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void MaterialPreparationService.open().then(setService).catch((reason) => setError(String(reason)));
  }, []);

  const refresh = useCallback(async () => {
    if (!service) return;
    const materials = await service.listMaterials(caseId, scope === "case" ? undefined : scope);
    const withRuns = await Promise.all(materials.map(async (material) => {
      const runs = await service.listExtractionRuns(material.id);
      return { material, run: runs.find((run) => run.id === material.selectedExtractionRunId) ?? runs[0] };
    }));
    setItems(withRuns);
    setSelected((current) => current ? withRuns.find((item) => item.material.id === current.material.id) ?? null : null);
  }, [caseId, scope, service]);

  useEffect(() => { void refresh().catch((reason) => setError(String(reason))); }, [refresh]);

  useEffect(() => {
    if (!service || !selected?.run) { setChunks([]); return; }
    void service.listChunks(selected.run.id).then(setChunks).catch((reason) => setError(String(reason)));
  }, [selected, service]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await operation(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  };

  const importFile = () => {
    if (!service) return;
    void run(async () => {
      const source = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Case materials", extensions: ["pdf", "docx", "txt", "md", "png", "jpg", "jpeg", "heic"] }],
      });
      if (!source) return;
      await service.importMaterial({ caseId, callPlanId: scope === "case" ? undefined : scope, sourcePath: source });
      await refresh();
    });
  };

  const eligibleCount = useMemo(() => items.filter((item) => item.run && materialSnapshotEligible({ run: item.run, reviewStatus: item.material.reviewStatus })).length, [items]);

  return <section className="material-panel">
    <header className="case-section-toolbar">
      <div><h3>Materials</h3><p>{eligibleCount} of {items.length} visible materials are snapshot eligible.</p></div>
      <div>
        <select aria-label="Material scope" value={scope} onChange={(event) => setScope(event.target.value)}>
          <option value="case">Entire case</option>
          {plans.map((plan) => <option value={plan.id} key={plan.id}>{plan.title}</option>)}
        </select>
        <button type="button" disabled={busy} onClick={importFile}>{busy ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />} Import</button>
      </div>
    </header>
    {error ? <div className="case-inline-error" role="alert">{error}<button type="button" onClick={() => setError(null)}><X size={14} /></button></div> : null}
    <div className="material-table" role="table">
      <div className="material-table-head" role="row"><span>Name</span><span>Scope</span><span>Extraction</span><span>Review</span><span /></div>
      {items.map((item) => {
        const eligible = Boolean(item.run && materialSnapshotEligible({ run: item.run, reviewStatus: item.material.reviewStatus }));
        return <div className="material-row" role="row" key={item.material.id}>
          <button type="button" className="material-name" onClick={() => setSelected(item)}><FileSearch size={16} /><span><strong>{item.material.displayName}</strong><small>{item.material.extension.toUpperCase()} · {(item.material.sizeBytes / 1024).toFixed(0)} KB</small></span></button>
          <span>{item.material.callPlanId ? plans.find((plan) => plan.id === item.material.callPlanId)?.title ?? "Call plan" : "Entire case"}</span>
          <span className={`material-state ${item.run?.status ?? "processing"}`}>{item.run?.status ?? "processing"}</span>
          <span className={eligible ? "material-eligible" : "material-review"}>{eligible ? "Eligible" : item.material.reviewStatus}</span>
          <div className="material-actions">
            {item.run?.status === "needs-review" && item.material.reviewStatus !== "approved" ? <button type="button" title="Approve extraction" onClick={() => void run(async () => { await service?.setReviewStatus(item.material, "approved"); await refresh(); })}><Check size={14} /></button> : null}
            <button type="button" title="Extract again" onClick={() => void run(async () => { await service?.extractMaterial(item.material); await refresh(); })}><RefreshCw size={14} /></button>
            <button type="button" title="Delete material" onClick={() => { if (!service || !window.confirm(`Delete ${item.material.displayName} and every extraction run?`)) return; void run(async () => { await service.deleteMaterial(item.material); setSelected(null); await refresh(); }); }}><Trash2 size={14} /></button>
          </div>
        </div>;
      })}
      {items.length === 0 ? <div className="material-empty"><FileSearch size={22} /><p>No material in this scope.</p></div> : null}
    </div>

    {selected ? <aside className="material-detail" aria-label="Material detail">
      <header><div><h3>{selected.material.displayName}</h3><p>{selected.run?.engine} {selected.run?.engineVersion}</p></div><button type="button" onClick={() => setSelected(null)}><X size={16} /></button></header>
      <dl><div><dt>Content hash</dt><dd>{selected.material.contentHash.slice(0, 18)}...</dd></div><div><dt>Output hash</dt><dd>{selected.run?.outputHash.slice(0, 18) ?? "Unavailable"}...</dd></div><div><dt>Scope</dt><dd>{selected.material.callPlanId ? "Call plan" : "Entire case"}</dd></div></dl>
      {selected.run?.qualitySignals.length ? <section><h4>Review signals</h4>{selected.run.qualitySignals.map((signal, index) => <p key={`${signal.code}-${index}`}>{signal.detail}</p>)}</section> : null}
      <section className="material-preview"><h4>Extracted preview</h4>{chunks.map((chunk) => <article key={chunk.id}>{chunk.pageNumber ? <small>Page {chunk.pageNumber}</small> : null}<p>{chunk.content}</p></article>)}{chunks.length === 0 ? <p>No text is available. Use explicit recovery or manual content.</p> : null}</section>
    </aside> : null}
  </section>;
}
