import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Download,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  CasePrivacyService,
  EVALUATION_LABELS,
  PreparationEvaluationService,
  type PreparationEvaluationDashboard,
  type PreparationEvaluationSubjectKind,
  type PreparationHumanEvaluationLabel,
} from "@/lib/preparation";

const formatMetric = (value?: number, suffix = "") =>
  value === undefined ? "No sample" : `${value.toLocaleString()}${suffix}`;

export default function EvaluationPanel({
  caseId,
  onCaseDeleted,
}: {
  caseId: string;
  onCaseDeleted: () => Promise<void>;
}) {
  const [evaluationService, setEvaluationService] = useState<PreparationEvaluationService | null>(null);
  const [privacyService, setPrivacyService] = useState<CasePrivacyService | null>(null);
  const [dashboard, setDashboard] = useState<PreparationEvaluationDashboard | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async (service: PreparationEvaluationService) => {
    setDashboard(await service.loadDashboard(caseId));
  }, [caseId]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      PreparationEvaluationService.open(),
      CasePrivacyService.open(),
    ]).then(async ([evaluation, privacy]) => {
      if (!active) return;
      setEvaluationService(evaluation);
      setPrivacyService(privacy);
      await refresh(evaluation);
    }).catch((reason) => active && setError(String(reason)));
    return () => { active = false; };
  }, [refresh]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await operation();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const evaluateArtifact = (usageId: string, label: PreparationHumanEvaluationLabel) => {
    if (!evaluationService) return;
    void run(async () => {
      await evaluationService.recordEvaluation({
        caseId,
        subjectKind: "snapshot-artifact",
        subjectId: usageId,
        label,
      });
      await refresh(evaluationService);
    });
  };

  const evaluateSubject = (
    subjectKind: PreparationEvaluationSubjectKind,
    subjectId: string,
    label: PreparationHumanEvaluationLabel
  ) => {
    if (!evaluationService) return;
    void run(async () => {
      await evaluationService.recordEvaluation({ caseId, subjectKind, subjectId, label });
      await refresh(evaluationService);
    });
  };

  const exportCase = () => {
    if (!privacyService || !evaluationService) return;
    void run(async () => {
      const result = await privacyService.exportCase(caseId);
      setMessage(`Exported ${result.fileCount} files to ${result.path}`);
      await refresh(evaluationService);
    });
  };

  const deleteCase = () => {
    if (!privacyService) return;
    if (!window.confirm("Permanently delete this Case, its materials, prepared sessions, and linked recordings? This cannot be undone.")) return;
    void run(async () => {
      await privacyService.deleteCase(caseId);
      await onCaseDeleted();
    });
  };

  if (!dashboard) {
    return <section className="evaluation-loading"><RefreshCw className="spin" size={18} /> Loading evaluation evidence...</section>;
  }

  const isolationViolations = dashboard.isolationFindings.reduce(
    (total, finding) => total + finding.count,
    0
  );
  return (
    <section className="evaluation-panel">
      <header className="case-section-toolbar">
        <div><h3>Evaluation and privacy</h3><p>Trace effective preparation, audit isolation, and control the complete local Case lifecycle.</p></div>
        <div>
          <button type="button" disabled={busy} onClick={() => evaluationService && void run(() => refresh(evaluationService))}><RefreshCw size={14} /> Refresh</button>
          <button type="button" disabled={busy} onClick={exportCase}><Download size={14} /> Export</button>
          <button className="danger" type="button" disabled={busy} onClick={deleteCase}><Trash2 size={14} /> Delete</button>
        </div>
      </header>
      {error ? <div className="case-inline-error"><span>{error}</span></div> : null}
      {message ? <div className="case-inline-message"><span>{message}</span></div> : null}

      <div className="evaluation-summary">
        <div><span>Materials selected</span><strong>{dashboard.totals.selectedExtractions}/{dashboard.totals.materials}</strong></div>
        <div><span>Ready snapshots</span><strong>{dashboard.totals.readySnapshots}</strong></div>
        <div><span>Closed prepared calls</span><strong>{dashboard.totals.closedPreparedSessions}</strong></div>
        <div className={isolationViolations ? "danger" : "success"}><span>Cross-Case violations</span><strong>{isolationViolations}</strong></div>
      </div>

      <section className="evaluation-readiness">
        <header><h4>First validation domain readiness</h4><span>Refund or cancellation evidence scenario</span></header>
        <div>{dashboard.validationReadiness.map((item) => <article className={item.satisfied ? "satisfied" : "pending"} key={item.id}>
          {item.satisfied ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
          <span><strong>{item.label}</strong><small>{item.evidence}</small></span>
        </article>)}</div>
      </section>

      <section className="evaluation-metrics">
        <header><h4>Per-operation performance</h4><span>Local preparation trace, not model claims</span></header>
        <div className="evaluation-table-head"><span>Operation</span><span>Runs</span><span>Failures</span><span>P50</span><span>P95</span><span>Context</span></div>
        {dashboard.operationMetrics.map((metric) => <div className="evaluation-table-row" key={metric.operationKind}>
          <strong>{metric.operationKind}</strong>
          <span>{metric.operationCount}</span>
          <span>{metric.failedCount}</span>
          <span>{formatMetric(metric.p50DurationMs, " ms")}</span>
          <span>{formatMetric(metric.p95DurationMs, " ms")}</span>
          <span>{formatMetric(metric.averageContextChars, " chars")}</span>
        </div>)}
        {!dashboard.operationMetrics.length ? <p className="evaluation-empty">No preparation operations recorded yet.</p> : null}
      </section>

      <section className="evaluation-artifacts">
        <header><h4>Visible snapshot artifacts</h4><span>Only `visible` receipts are eligible for attribution.</span></header>
        {dashboard.visibleArtifacts.map((artifact) => <article key={artifact.usageId}>
          <div><ShieldCheck size={15} /><span><strong>{artifact.section}</strong><small>{artifact.target} · {artifact.callSessionId}</small></span></div>
          <div>{EVALUATION_LABELS["snapshot-artifact"].map((label) => <button
            type="button"
            key={label}
            className={artifact.latestEvaluation?.label === label ? "active" : ""}
            disabled={busy}
            onClick={() => evaluateArtifact(artifact.usageId, label)}
          >{label}</button>)}</div>
        </article>)}
        {!dashboard.visibleArtifacts.length ? <p className="evaluation-empty">No artifact has reached visible guidance yet.</p> : null}
      </section>

      <section className="evaluation-subjects">
        <header><h4>Human evaluation queue</h4><span>One fact can project to metrics without duplicate forms.</span></header>
        {dashboard.evaluationSubjects.map((subject) => <article key={`${subject.subjectKind}:${subject.subjectId}`}>
          <div><span><strong>{subject.title}</strong><small>{subject.subjectKind} · {subject.detail}</small></span></div>
          <div>{EVALUATION_LABELS[subject.subjectKind].map((label) => <button
            type="button"
            key={label}
            className={subject.latestEvaluation?.label === label ? "active" : ""}
            disabled={busy}
            onClick={() => evaluateSubject(subject.subjectKind, subject.subjectId, label)}
          >{label}</button>)}</div>
        </article>)}
        {!dashboard.evaluationSubjects.length ? <p className="evaluation-empty">No reviewable preparation subjects yet.</p> : null}
      </section>

      <section className="evaluation-trace">
        <header><h4>Preparation trace</h4><span>Latest {dashboard.trace.length} events</span></header>
        <div>{dashboard.trace.map((event) => <article key={event.id}>
          <Activity size={13} />
          <span><strong>{event.operationKind}</strong><small>{event.status} · {new Date(event.occurredAt).toLocaleString()}</small></span>
          <code>{event.operationId.slice(-12)}</code>
        </article>)}</div>
      </section>
    </section>
  );
}
