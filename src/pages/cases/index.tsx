import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  ChevronRight,
  Edit3,
  FileText,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { isTauriRuntime } from "@/lib/calling";
import MossSelect from "@/components/ui/MossSelect";
import {
  CALL_PLAN_TRANSITIONS,
  CASE_TRANSITIONS,
  CasePreparationService,
  CasePrivacyService,
  buildCallPlanTimeOptions,
  localCallPlanScheduleToTimestamp,
  timestampToLocalCallPlanSchedule,
  type CallPlan,
  type CallPlanState,
  type CallPreparationSnapshotBundle,
  type CaseRecord,
  type CaseRevision,
  type CaseState,
} from "@/lib/preparation";
import "./cases.css";
import MaterialPanel from "./MaterialPanel";
import ConversationPanel from "./ConversationPanel";
import ReviewedStatePanel from "./ReviewedStatePanel";
import SnapshotPanel from "./SnapshotPanel";
import PostCallReviewPanel from "./PostCallReviewPanel";
import EvaluationPanel from "./EvaluationPanel";

export type CaseWorkspaceView =
  | "overview"
  | "plans"
  | "materials"
  | "conversations"
  | "reviewed"
  | "snapshots"
  | "post-call"
  | "evaluation";

export const CASE_WORKSPACE_VIEWS: Array<{
  id: CaseWorkspaceView;
  label: string;
}> = [
  { id: "overview", label: "Overview" },
  { id: "plans", label: "Call plans" },
  { id: "materials", label: "Materials" },
  { id: "conversations", label: "Conversations" },
  { id: "reviewed", label: "Reviewed state" },
  { id: "snapshots", label: "Snapshots" },
  { id: "post-call", label: "Post-call" },
  { id: "evaluation", label: "Evaluation" },
];

const splitLines = (value: string) =>
  value.split("\n").map((item) => item.trim()).filter(Boolean);

interface CaseForm {
  id?: string;
  revision?: number;
  initialStatus?: CaseState;
  title: string;
  objective: string;
  fallbacks: string;
  caseType: string;
  status: CaseState;
}

interface PlanForm {
  id?: string;
  revision?: number;
  initialState?: CallPlanState;
  state: CallPlanState;
  title: string;
  objective: string;
  outcomes: string;
  questions: string;
  risks: string;
  scheduledDate: string;
  scheduledTime: string;
}

const lifecycleOptions = <T extends string>(
  current: T,
  transitions: Record<T, readonly T[]>
) => [current, ...transitions[current]];

const blankCase = (): CaseForm => ({ title: "", objective: "", fallbacks: "", caseType: "", status: "open" });
const blankPlan = (): PlanForm => ({
  state: "draft",
  title: "",
  objective: "",
  outcomes: "",
  questions: "",
  risks: "",
  scheduledDate: "",
  scheduledTime: "",
});

export default function CasesPage({
  onStartPreparedCall,
}: {
  onStartPreparedCall?: (
    snapshot: CallPreparationSnapshotBundle
  ) => Promise<void>;
}) {
  const [service, setService] = useState<CasePreparationService | null>(null);
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [revision, setRevision] = useState<CaseRevision | null>(null);
  const [plans, setPlans] = useState<CallPlan[]>([]);
  const [view, setView] = useState<CaseWorkspaceView>("overview");
  const [caseForm, setCaseForm] = useState<CaseForm | null>(null);
  const [planForm, setPlanForm] = useState<PlanForm | null>(null);
  const [conversationExpanded, setConversationExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedCase = useMemo(
    () => cases.find((item) => item.id === selectedCaseId) ?? null,
    [cases, selectedCaseId]
  );

  const refreshCases = useCallback(async (owner: CasePreparationService) => {
    const next = await owner.listCases();
    setCases(next);
    setSelectedCaseId((current) =>
      current && next.some((item) => item.id === current)
        ? current
        : next[0]?.id ?? null
    );
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let active = true;
    void Promise.all([CasePreparationService.open(), CasePrivacyService.open()])
      .then(async ([owner]) => {
        if (!active) return;
        setService(owner);
        await refreshCases(owner);
      })
      .catch((reason) => active && setError(String(reason)))
    return () => { active = false; };
  }, [refreshCases]);

  useEffect(() => {
    if (!service || !selectedCaseId) {
      setRevision(null);
      setPlans([]);
      return;
    }
    let active = true;
    void Promise.all([
      service.getCurrentRevision(selectedCaseId),
      service.listCallPlans(selectedCaseId),
    ])
      .then(([nextRevision, nextPlans]) => {
        if (!active) return;
        setRevision(nextRevision);
        setPlans(nextPlans);
      })
      .catch((reason) => active && setError(String(reason)));
    return () => { active = false; };
  }, [selectedCaseId, service]);

  useEffect(() => {
    setConversationExpanded(false);
  }, [selectedCaseId]);

  useEffect(() => {
    if (view !== "conversations") setConversationExpanded(false);
  }, [view]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const submitCase = () => {
    if (!service || !caseForm) return;
    void run(async () => {
      if (caseForm.id && caseForm.revision) {
        await service.updateCase({
          caseId: caseForm.id,
          expectedRevision: caseForm.revision,
          title: caseForm.title,
          status: caseForm.status,
          caseType: caseForm.caseType,
          primaryObjective: caseForm.objective,
          acceptableFallbacks: splitLines(caseForm.fallbacks),
        });
        await refreshCases(service);
        setRevision(await service.getCurrentRevision(caseForm.id));
      } else {
        const created = await service.createCase({
          title: caseForm.title,
          primaryObjective: caseForm.objective,
          acceptableFallbacks: splitLines(caseForm.fallbacks),
          caseType: caseForm.caseType,
        });
        await refreshCases(service);
        setSelectedCaseId(created.record.id);
      }
      setCaseForm(null);
    });
  };

  const editCase = () => {
    if (!selectedCase || !revision) return;
    setCaseForm({
      id: selectedCase.id,
      revision: selectedCase.rowRevision,
      initialStatus: selectedCase.status,
      title: selectedCase.title,
      objective: revision.primaryObjective,
      fallbacks: revision.acceptableFallbacks.join("\n"),
      caseType: selectedCase.caseType ?? "",
      status: selectedCase.status,
    });
  };

  const editPlan = (plan: CallPlan) => {
    const schedule = timestampToLocalCallPlanSchedule(plan.scheduledAt);
    setPlanForm({
      id: plan.id,
      revision: plan.rowRevision,
      initialState: plan.state,
      state: plan.state,
      title: plan.title,
      objective: plan.objective,
      outcomes: plan.acceptableOutcomes.join("\n"),
      questions: plan.questionsToAsk.join("\n"),
      risks: plan.knownRisks.join("\n"),
      scheduledDate: schedule.date,
      scheduledTime: schedule.time,
    });
  };

  const submitPlan = () => {
    if (!service || !selectedCaseId || !planForm) return;
    void run(async () => {
      const scheduledAt = localCallPlanScheduleToTimestamp({
        date: planForm.scheduledDate,
        time: planForm.scheduledTime,
      });
      if (planForm.id && planForm.revision) {
        await service.updateCallPlan({
          planId: planForm.id,
          expectedRevision: planForm.revision,
          title: planForm.title,
          objective: planForm.objective,
          state: planForm.state,
          acceptableOutcomes: splitLines(planForm.outcomes),
          questionsToAsk: splitLines(planForm.questions),
          knownRisks: splitLines(planForm.risks),
          scheduledAt,
        });
      } else {
        await service.createCallPlan({
          caseId: selectedCaseId,
          title: planForm.title,
          objective: planForm.objective,
          acceptableOutcomes: splitLines(planForm.outcomes),
          questionsToAsk: splitLines(planForm.questions),
          knownRisks: splitLines(planForm.risks),
          scheduledAt,
        });
      }
      setPlans(await service.listCallPlans(selectedCaseId));
      setPlanForm(null);
    });
  };

  if (!isTauriRuntime()) {
    return <section className="case-route-boundary"><ShieldCheck size={26} /><h2>Case data stays on this device</h2><p>Open the MOSS desktop app to use Case Preparation.</p></section>;
  }

  return (
    <div className={`case-workspace${conversationExpanded ? " conversation-expanded" : ""}`}>
      <aside className="case-sidebar">
        <header><div><span>Case workspace</span><h2>Cases</h2></div><button type="button" title="Create case" onClick={() => setCaseForm(blankCase())}><Plus size={17} /></button></header>
        <div className="case-list">
          {cases.map((item) => (
            <button key={item.id} type="button" className={item.id === selectedCaseId ? "active" : ""} onClick={() => setSelectedCaseId(item.id)}>
              <i className={item.status} /><span><strong>{item.title}</strong><small>{item.caseType || "Uncategorized"}</small></span><ChevronRight size={15} />
            </button>
          ))}
          {cases.length === 0 ? <div className="case-empty"><p>No cases yet.</p><button type="button" onClick={() => setCaseForm(blankCase())}><Plus size={15} /> Create case</button></div> : null}
        </div>
      </aside>

      <main className="case-main">
        {selectedCase ? <>
          <header className="case-header"><div><div><h2>{selectedCase.title}</h2><span>{selectedCase.status}</span></div><p>{revision?.primaryObjective}</p></div><button type="button" title="Edit case and lifecycle" disabled={!revision} onClick={editCase}><Edit3 size={15} /></button></header>
          <nav className="case-tabs" aria-label="Case preparation sections">
            {CASE_WORKSPACE_VIEWS.map((item) => <button type="button" key={item.id} className={item.id === view ? "active" : ""} onClick={() => setView(item.id)}>{item.label}</button>)}
          </nav>
          <div className="case-content">
            {view === "overview" ? <div className="case-overview">
              <section><h3>Primary objective</h3><p>{revision?.primaryObjective}</p></section>
              <section><h3>Acceptable fallbacks</h3>{revision?.acceptableFallbacks.length ? <ul>{revision.acceptableFallbacks.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="muted">No confirmed fallback.</p>}</section>
              <section><h3>Next call</h3>{plans[0] ? <button className="case-plan-link" type="button" onClick={() => { setView("plans"); editPlan(plans[0]); }}><span><strong>{plans[0].title}</strong><small>{plans[0].objective}</small></span><ChevronRight size={16} /></button> : <button className="case-add-link" type="button" onClick={() => { setView("plans"); setPlanForm(blankPlan()); }}><Plus size={15} /> Add a call plan</button>}</section>
              <section><h3>Confirmed revision</h3><p>Revision {revision?.revision ?? 0}</p><small className="muted">Confirmed state is versioned, not overwritten.</small></section>
            </div> : null}

            {view === "plans" ? <section className="case-plans">
              <header><div><h3>Call plans</h3><p>Plan a specific objective, questions, outcomes, and risks.</p></div><button type="button" onClick={() => setPlanForm(blankPlan())}><Plus size={15} /> Add plan</button></header>
              <div>{plans.map((plan) => <article key={plan.id}>
                <div className="case-plan-date"><CalendarClock size={16} />{plan.scheduledAt ? new Date(plan.scheduledAt).toLocaleString() : "Not scheduled"}</div>
                <div><h4>{plan.title}<span>{plan.state}</span></h4><p>{plan.objective}</p><small>{plan.questionsToAsk.length} questions · {plan.knownRisks.length} risks</small></div>
                <div className="case-plan-actions"><button type="button" onClick={() => editPlan(plan)}>Edit lifecycle</button><button type="button" title="Delete plan" onClick={() => { if (!service || !window.confirm(`Delete ${plan.title} and all scoped data?`)) return; void run(async () => { await service.deleteCallPlan(plan.id); setPlans(await service.listCallPlans(selectedCase.id)); }); }}><Trash2 size={14} /></button></div>
              </article>)}</div>
            </section> : null}

            {view === "materials" ? <MaterialPanel caseId={selectedCase.id} plans={plans} /> : null}

            {view === "conversations" ? <ConversationPanel caseId={selectedCase.id} plans={plans} expanded={conversationExpanded} onExpandedChange={setConversationExpanded} /> : null}

            {view === "reviewed" ? <ReviewedStatePanel caseId={selectedCase.id} onRevisionChange={async () => { if (service) setRevision(await service.getCurrentRevision(selectedCase.id)); }} /> : null}

            {view === "snapshots" ? <SnapshotPanel caseId={selectedCase.id} plans={plans} onStartCall={onStartPreparedCall} /> : null}

            {view === "post-call" ? <PostCallReviewPanel caseId={selectedCase.id} onRevisionChange={async () => { if (service) setRevision(await service.getCurrentRevision(selectedCase.id)); }} onPlanChange={async () => { if (service) setPlans(await service.listCallPlans(selectedCase.id)); }} /> : null}

            {view === "evaluation" ? <EvaluationPanel caseId={selectedCase.id} onCaseDeleted={async () => { if (service) await refreshCases(service); setView("overview"); }} /> : null}

            {!(["overview", "plans", "materials", "conversations", "reviewed", "snapshots", "post-call", "evaluation"] as CaseWorkspaceView[]).includes(view) ? <section className="case-future"><ShieldCheck size={22} /><h3>{CASE_WORKSPACE_VIEWS.find((item) => item.id === view)?.label}</h3><p>This surface activates in its dedicated Task 1 slice.</p></section> : null}
          </div>
        </> : <section className="case-route-boundary"><FileText size={26} /><h2>Prepare one call at a time</h2><p>Create a case to establish the state that future calls may use.</p><button type="button" onClick={() => setCaseForm(blankCase())}><Plus size={15} /> Create case</button></section>}
      </main>

      {error ? <div className="case-toast" role="alert">{error}<button type="button" onClick={() => setError(null)}><X size={14} /></button></div> : null}

      {caseForm ? <div className="case-modal-layer"><section className="case-modal" role="dialog" aria-modal="true">
        <header><div><span>{caseForm.id ? "Case lifecycle" : "New case"}</span><h2>{caseForm.id ? "Edit the case" : "Establish the objective"}</h2></div><button type="button" onClick={() => setCaseForm(null)}><X size={17} /></button></header>
        <label>Title<input autoFocus value={caseForm.title} onChange={(event) => setCaseForm({ ...caseForm, title: event.target.value })} /></label>
        <label>Primary objective<textarea value={caseForm.objective} onChange={(event) => setCaseForm({ ...caseForm, objective: event.target.value })} /></label>
        <label>Acceptable fallbacks <small>One per line</small><textarea value={caseForm.fallbacks} onChange={(event) => setCaseForm({ ...caseForm, fallbacks: event.target.value })} /></label>
        <label>Case type <small>Optional and descriptive only</small><input value={caseForm.caseType} onChange={(event) => setCaseForm({ ...caseForm, caseType: event.target.value })} /></label>
        {caseForm.id ? <label>Status<MossSelect ariaLabel="Case status" value={caseForm.status} onValueChange={(status) => setCaseForm({ ...caseForm, status: status as CaseState })} options={lifecycleOptions(caseForm.initialStatus ?? caseForm.status, CASE_TRANSITIONS).map((status) => ({ value: status, label: status }))} /></label> : null}
        <footer><button className="secondary" type="button" onClick={() => setCaseForm(null)}>Cancel</button><button type="button" disabled={busy} onClick={submitCase}>{caseForm.id ? "Save case" : "Create case"}</button></footer>
      </section></div> : null}

      {planForm ? <div className="case-modal-layer"><section className="case-modal wide" role="dialog" aria-modal="true">
        <header><div><span>Call plan</span><h2>{planForm.id ? "Edit the planned call" : "Plan the next call"}</h2></div><button type="button" onClick={() => setPlanForm(null)}><X size={17} /></button></header>
        <div className="case-form-row plan-primary-fields">
          <label>Title<input autoFocus value={planForm.title} onChange={(event) => setPlanForm({ ...planForm, title: event.target.value })} /></label>
          <fieldset className="case-schedule-field">
            <legend>Scheduled time</legend>
            <div>
              <input aria-label="Scheduled date" type="date" value={planForm.scheduledDate} onChange={(event) => setPlanForm({ ...planForm, scheduledDate: event.target.value })} />
              <MossSelect
                ariaLabel="Scheduled time"
                value={planForm.scheduledTime}
                onValueChange={(scheduledTime) => setPlanForm({ ...planForm, scheduledTime })}
                options={[
                  { value: "", label: "Select time" },
                  ...buildCallPlanTimeOptions(planForm.scheduledTime),
                ]}
              />
            </div>
          </fieldset>
        </div>
        <label>Objective<textarea value={planForm.objective} onChange={(event) => setPlanForm({ ...planForm, objective: event.target.value })} /></label>
        {planForm.id ? <label>Lifecycle state<MossSelect ariaLabel="Call plan state" value={planForm.state} onValueChange={(state) => setPlanForm({ ...planForm, state: state as CallPlanState })} options={lifecycleOptions(planForm.initialState ?? planForm.state, CALL_PLAN_TRANSITIONS).map((state) => ({ value: state, label: state }))} /></label> : null}
        <div className="case-form-row thirds"><label>Acceptable outcomes<textarea value={planForm.outcomes} onChange={(event) => setPlanForm({ ...planForm, outcomes: event.target.value })} placeholder="One per line" /></label><label>Questions to ask<textarea value={planForm.questions} onChange={(event) => setPlanForm({ ...planForm, questions: event.target.value })} placeholder="One per line" /></label><label>Known risks<textarea value={planForm.risks} onChange={(event) => setPlanForm({ ...planForm, risks: event.target.value })} placeholder="One per line" /></label></div>
        <footer><button className="secondary" type="button" onClick={() => setPlanForm(null)}>Cancel</button><button type="button" disabled={busy} onClick={submitPlan}>Save plan</button></footer>
      </section></div> : null}
    </div>
  );
}
