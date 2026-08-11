import {
  decodeJson,
  loadPreparationDatabase,
  type SqlDatabase,
} from "./database.js";
import { sha256 } from "../calling/immutable-snapshot.js";
import type {
  PreparationEvaluationSubjectKind,
  PreparationHumanEvaluation,
  PreparationHumanEvaluationLabel,
} from "./types.js";

interface OperationRow {
  id: string;
  operation_id: string;
  operation_kind: string;
  status: string;
  payload_json: string;
  occurred_at: number;
}

interface EvaluationRow {
  id: string;
  case_id: string;
  call_session_id: string | null;
  snapshot_id: string | null;
  subject_kind: PreparationEvaluationSubjectKind;
  subject_id: string;
  label: PreparationHumanEvaluationLabel;
  note: string | null;
  source: "explicit" | "derived";
  occurred_at: number;
}

interface VisibleArtifactRow {
  artifact_id: string;
  section: string;
  snapshot_id: string;
  call_session_id: string;
  target: string;
  visible_at: number;
}

interface ArtifactReceiptTraceRow {
  id: string;
  operation_id: string;
  section: string;
  target: string;
  status: string;
  reason: string | null;
  occurred_at: number;
}

interface PrivacyAuditTraceRow {
  id: string;
  operation_id: string;
  action: string;
  status: string;
  item_counts_json: string;
  occurred_at: number;
}

export interface PreparationTraceEvent {
  id: string;
  operationId: string;
  operationKind: string;
  status: string;
  payloadSummary: Record<string, unknown>;
  occurredAt: number;
}

export interface PreparationOperationMetric {
  operationKind: string;
  operationCount: number;
  failedCount: number;
  p50DurationMs?: number;
  p95DurationMs?: number;
  averageContextChars?: number;
  averageResponseChars?: number;
}

export interface VisibleSnapshotArtifactUsage {
  usageId: string;
  artifactId: string;
  section: string;
  snapshotId: string;
  callSessionId: string;
  target: string;
  visibleAt: number;
  latestEvaluation?: PreparationHumanEvaluation;
}

export interface PreparationEvaluationSubject {
  subjectKind: Exclude<PreparationEvaluationSubjectKind, "snapshot-artifact">;
  subjectId: string;
  title: string;
  detail: string;
  latestEvaluation?: PreparationHumanEvaluation;
}

export interface CrossCaseIsolationFinding {
  code: string;
  count: number;
  detail: string;
}

export interface ValidationReadinessItem {
  id: string;
  label: string;
  satisfied: boolean;
  evidence: string;
}

export interface PreparationEvaluationDashboard {
  trace: PreparationTraceEvent[];
  operationMetrics: PreparationOperationMetric[];
  artifactReceiptCounts: Record<string, number>;
  evaluationCounts: Record<string, number>;
  visibleArtifacts: VisibleSnapshotArtifactUsage[];
  evaluationSubjects: PreparationEvaluationSubject[];
  isolationFindings: CrossCaseIsolationFinding[];
  validationReadiness: ValidationReadinessItem[];
  totals: {
    materials: number;
    selectedExtractions: number;
    readySnapshots: number;
    preparedSessions: number;
    closedPreparedSessions: number;
    reviewedPostCallUpdates: number;
  };
}

export const EVALUATION_LABELS: Record<
  PreparationEvaluationSubjectKind,
  PreparationHumanEvaluationLabel[]
> = {
  "material-extraction": ["complete", "partial", "wrong", "unreadable"],
  retrieval: ["helpful", "irrelevant", "missing", "polluting"],
  "statement-proposal": ["correct", "needs-edit", "unsupported", "duplicate"],
  "snapshot-artifact": ["helpful", "irrelevant", "polluting", "over-constraining"],
  "post-call-update": ["correct", "missed", "wrong-party", "wrong-condition", "wrong-date"],
};

export const CROSS_CASE_ISOLATION_QUERIES: Array<{
  code: string;
  detail: string;
  query: string;
}> = [
  {
    code: "material-plan-scope",
    detail: "Materials must use a CallPlan from the same Case.",
    query: `SELECT COUNT(*) AS count FROM case_materials material
      JOIN call_plans plan ON plan.id = material.call_plan_id
      WHERE material.case_id = ? AND plan.case_id <> material.case_id`,
  },
  {
    code: "conversation-plan-scope",
    detail: "Conversations must use a CallPlan from the same Case.",
    query: `SELECT COUNT(*) AS count FROM preparation_conversations conversation
      JOIN call_plans plan ON plan.id = conversation.call_plan_id
      WHERE conversation.case_id = ? AND plan.case_id <> conversation.case_id`,
  },
  {
    code: "snapshot-source-scope",
    detail: "Snapshots must freeze one CaseRevision and CallPlan from their Case.",
    query: `SELECT COUNT(*) AS count FROM call_preparation_snapshots snapshot
      JOIN case_revisions revision ON revision.id = snapshot.case_revision_id
      JOIN call_plans plan ON plan.id = snapshot.call_plan_id
      WHERE snapshot.case_id = ?
        AND (revision.case_id <> snapshot.case_id OR plan.case_id <> snapshot.case_id)`,
  },
  {
    code: "binding-snapshot-scope",
    detail: "Prepared CallSessions must bind to one snapshot lineage.",
    query: `SELECT COUNT(*) AS count FROM call_session_preparation_bindings binding
      JOIN call_preparation_snapshots snapshot ON snapshot.id = binding.snapshot_id
      WHERE binding.case_id = ? AND binding.mode = 'prepared'
        AND (snapshot.case_id <> binding.case_id
          OR snapshot.case_revision_id <> binding.case_revision_id
          OR snapshot.call_plan_id <> binding.call_plan_id
          OR snapshot.content_hash <> binding.snapshot_content_hash)`,
  },
  {
    code: "receipt-artifact-scope",
    detail: "Artifact receipts must reference the artifact from the bound snapshot.",
    query: `SELECT COUNT(*) AS count FROM snapshot_artifact_receipts receipt
      JOIN call_session_preparation_bindings binding ON binding.call_session_id = receipt.call_session_id
      JOIN snapshot_artifacts artifact ON artifact.id = receipt.artifact_id
      WHERE binding.case_id = ?
        AND (receipt.snapshot_id <> binding.snapshot_id
          OR artifact.snapshot_id <> receipt.snapshot_id)`,
  },
  {
    code: "post-call-session-scope",
    detail: "Post-call proposals must come from a prepared session for the same Case.",
    query: `SELECT COUNT(*) AS count FROM pending_case_updates pending
      JOIN call_session_preparation_bindings binding ON binding.call_session_id = pending.call_session_id
      WHERE pending.case_id = ?
        AND (binding.mode <> 'prepared' OR binding.case_id <> pending.case_id)`,
  },
  {
    code: "evaluation-snapshot-scope",
    detail: "Snapshot evaluations must remain inside their Case.",
    query: `SELECT COUNT(*) AS count FROM preparation_human_evaluations evaluation
      JOIN call_preparation_snapshots snapshot ON snapshot.id = evaluation.snapshot_id
      WHERE evaluation.case_id = ? AND snapshot.case_id <> evaluation.case_id`,
  },
];

const mapEvaluation = (row: EvaluationRow): PreparationHumanEvaluation => ({
  id: row.id,
  caseId: row.case_id,
  callSessionId: row.call_session_id ?? undefined,
  snapshotId: row.snapshot_id ?? undefined,
  subjectKind: row.subject_kind,
  subjectId: row.subject_id,
  label: row.label,
  note: row.note ?? undefined,
  source: row.source,
  occurredAt: row.occurred_at,
});

const safePayloadSummary = (payload: unknown): Record<string, unknown> => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  return Object.fromEntries(
    Object.entries(payload as Record<string, unknown>).slice(0, 12).map(([key, value]) => {
      if (typeof value === "string") {
        if (/prompt|content|transcript/i.test(key)) return [key, `${value.length} chars`];
        return [key, value.length > 140 ? `${value.slice(0, 137)}...` : value];
      }
      if (Array.isArray(value)) return [key, `${value.length} items`];
      if (value && typeof value === "object") return [key, "structured"];
      return [key, value];
    })
  );
};

const numeric = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const percentile = (values: number[], probability: number) => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return Math.round(sorted[Math.max(0, Math.ceil(sorted.length * probability) - 1)]);
};

const average = (values: number[]) =>
  values.length
    ? Math.round(values.reduce((total, value) => total + value, 0) / values.length)
    : undefined;

export function summarizeOperationMetrics(rows: OperationRow[]) {
  const grouped = new Map<string, OperationRow[]>();
  for (const row of rows) {
    const key = `${row.operation_kind}:${row.operation_id}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  const byKind = new Map<
    string,
    { durations: number[]; contexts: number[]; responses: number[]; failed: number; count: number }
  >();
  for (const group of grouped.values()) {
    group.sort((left, right) => left.occurred_at - right.occurred_at);
    const kind = group[0].operation_kind;
    const metric = byKind.get(kind) ?? {
      durations: [],
      contexts: [],
      responses: [],
      failed: 0,
      count: 0,
    };
    metric.count += 1;
    if (group.some((row) => row.status === "failed")) metric.failed += 1;
    const payloads = group.map((row) => decodeJson<Record<string, unknown>>(row.payload_json, {}));
    const recordedDuration = payloads.map((payload) => numeric(payload.durationMs)).find((value) => value !== undefined);
    if (recordedDuration !== undefined) metric.durations.push(recordedDuration);
    else if (group.length > 1) metric.durations.push(group[group.length - 1].occurred_at - group[0].occurred_at);
    for (const payload of payloads) {
      const directContext = numeric(payload.contextChars);
      if (directContext !== undefined) metric.contexts.push(directContext);
      for (const key of ["userPrompt", "prompt"] as const) {
        if (typeof payload[key] === "string") metric.contexts.push(payload[key].length);
      }
      const responseChars = numeric(payload.responseChars);
      if (responseChars !== undefined) metric.responses.push(responseChars);
    }
    byKind.set(kind, metric);
  }
  return [...byKind.entries()]
    .map(([operationKind, metric]): PreparationOperationMetric => ({
      operationKind,
      operationCount: metric.count,
      failedCount: metric.failed,
      p50DurationMs: percentile(metric.durations, 0.5),
      p95DurationMs: percentile(metric.durations, 0.95),
      averageContextChars: average(metric.contexts),
      averageResponseChars: average(metric.responses),
    }))
    .sort((left, right) => right.operationCount - left.operationCount);
}

export class PreparationEvaluationService {
  constructor(private readonly database: SqlDatabase) {}

  static async open() {
    return new PreparationEvaluationService(await loadPreparationDatabase());
  }

  async loadDashboard(caseId: string): Promise<PreparationEvaluationDashboard> {
    const caseIdHash = await sha256(caseId);
    const [
      operations,
      receiptRows,
      evaluationRows,
      visibleRows,
      receiptTraceRows,
      privacyTraceRows,
      materialSubjects,
      retrievalSubjects,
      statementSubjects,
      postCallSubjects,
    ] = await Promise.all([
      this.database.select<OperationRow[]>(
        "SELECT * FROM preparation_operation_events WHERE case_id = ? ORDER BY occurred_at DESC LIMIT 250",
        [caseId]
      ),
      this.database.select<Array<{ status: string; count: number }>>(
        `SELECT receipt.status, COUNT(*) AS count FROM snapshot_artifact_receipts receipt
         JOIN call_session_preparation_bindings binding ON binding.call_session_id = receipt.call_session_id
         WHERE binding.case_id = ? GROUP BY receipt.status`,
        [caseId]
      ),
      this.database.select<EvaluationRow[]>(
        "SELECT * FROM preparation_human_evaluations WHERE case_id = ? ORDER BY occurred_at DESC",
        [caseId]
      ),
      this.database.select<VisibleArtifactRow[]>(
        `SELECT artifact.id AS artifact_id, artifact.section, receipt.snapshot_id,
         receipt.call_session_id, receipt.target, MAX(receipt.occurred_at) AS visible_at
         FROM snapshot_artifact_receipts receipt
         JOIN snapshot_artifacts artifact ON artifact.id = receipt.artifact_id
         JOIN call_preparation_snapshots snapshot ON snapshot.id = receipt.snapshot_id
         WHERE snapshot.case_id = ? AND receipt.status = 'visible'
         GROUP BY artifact.id, artifact.section, receipt.snapshot_id,
           receipt.call_session_id, receipt.target
         ORDER BY visible_at DESC`,
        [caseId]
      ),
      this.database.select<ArtifactReceiptTraceRow[]>(
        `SELECT receipt.id, receipt.operation_id, artifact.section, receipt.target,
         receipt.status, receipt.reason, receipt.occurred_at
         FROM snapshot_artifact_receipts receipt
         JOIN snapshot_artifacts artifact ON artifact.id = receipt.artifact_id
         JOIN call_session_preparation_bindings binding ON binding.call_session_id = receipt.call_session_id
         WHERE binding.case_id = ? ORDER BY receipt.occurred_at DESC LIMIT 250`,
        [caseId]
      ),
      this.database.select<PrivacyAuditTraceRow[]>(
        `SELECT id, operation_id, action, status, item_counts_json, occurred_at
         FROM case_privacy_audits WHERE case_id_hash = ?
         ORDER BY occurred_at DESC LIMIT 100`,
        [caseIdHash]
      ),
      this.database.select<Array<{
        subject_id: string;
        title: string;
        status: string;
        method: string;
      }>>(
        `SELECT run.id AS subject_id, material.display_name AS title,
         run.status, run.method FROM case_materials material
         JOIN extraction_runs run ON run.id = material.selected_extraction_run_id
         WHERE material.case_id = ? ORDER BY material.updated_at DESC LIMIT 80`,
        [caseId]
      ),
      this.database.select<Array<{
        subject_id: string;
        title: string;
        status: string;
      }>>(
        `SELECT operation_id AS subject_id, operation_kind AS title, status
         FROM preparation_operation_events
         WHERE case_id = ? AND status = 'dispatched'
           AND operation_kind IN ('preparation-conversation', 'statement-proposal', 'snapshot-model-proposal')
         ORDER BY occurred_at DESC LIMIT 80`,
        [caseId]
      ),
      this.database.select<Array<{
        subject_id: string;
        kind: string;
        content: string;
        review_state: string;
      }>>(
        `SELECT id AS subject_id, kind, content, review_state FROM case_statements
         WHERE case_id = ? AND created_by = 'complex-model-proposal'
         ORDER BY updated_at DESC LIMIT 80`,
        [caseId]
      ),
      this.database.select<Array<{
        subject_id: string;
        kind: string;
        proposed_statement_json: string;
        review_state: string;
      }>>(
        `SELECT id AS subject_id, kind, proposed_statement_json, review_state
         FROM pending_case_updates WHERE case_id = ? ORDER BY updated_at DESC LIMIT 80`,
        [caseId]
      ),
    ]);
    const [totalsRows, isolationFindings] = await Promise.all([
      this.database.select<Array<{
        materials: number;
        selected_extractions: number;
        ready_snapshots: number;
        prepared_sessions: number;
        closed_prepared_sessions: number;
        reviewed_post_call_updates: number;
      }>>(
        `SELECT
          (SELECT COUNT(*) FROM case_materials WHERE case_id = ?) AS materials,
          (SELECT COUNT(*) FROM case_materials WHERE case_id = ? AND selected_extraction_run_id IS NOT NULL) AS selected_extractions,
          (SELECT COUNT(*) FROM call_preparation_snapshots WHERE case_id = ? AND state = 'ready') AS ready_snapshots,
          (SELECT COUNT(*) FROM call_session_preparation_bindings WHERE case_id = ? AND mode = 'prepared') AS prepared_sessions,
          (SELECT COUNT(*) FROM call_session_preparation_bindings binding
            JOIN call_runtime_sessions session ON session.id = binding.call_session_id
            WHERE binding.case_id = ? AND binding.mode = 'prepared' AND session.state = 'closed') AS closed_prepared_sessions,
          (SELECT COUNT(*) FROM pending_case_updates WHERE case_id = ? AND review_state IN ('accepted', 'edited')) AS reviewed_post_call_updates`,
        [caseId, caseId, caseId, caseId, caseId, caseId]
      ),
      this.runCrossCaseIsolationAudit(caseId),
    ]);
    const totalsRow = totalsRows[0] ?? {
      materials: 0,
      selected_extractions: 0,
      ready_snapshots: 0,
      prepared_sessions: 0,
      closed_prepared_sessions: 0,
      reviewed_post_call_updates: 0,
    };
    const evaluations = evaluationRows.map(mapEvaluation);
    const latestBySubject = new Map<string, PreparationHumanEvaluation>();
    for (const evaluation of evaluations) {
      const key = `${evaluation.subjectKind}:${evaluation.subjectId}`;
      if (!latestBySubject.has(key)) {
        latestBySubject.set(key, evaluation);
      }
    }
    const visibleArtifacts = visibleRows.map((row) => {
      const usageId = this.artifactUsageId(row.artifact_id, row.call_session_id, row.target);
      return {
        usageId,
        artifactId: row.artifact_id,
        section: row.section,
        snapshotId: row.snapshot_id,
        callSessionId: row.call_session_id,
        target: row.target,
        visibleAt: row.visible_at,
        latestEvaluation: latestBySubject.get(`snapshot-artifact:${usageId}`),
      };
    });
    const evaluationSubjects: PreparationEvaluationSubject[] = [
      ...materialSubjects.map((row) => ({
        subjectKind: "material-extraction" as const,
        subjectId: row.subject_id,
        title: row.title,
        detail: `${row.method} · ${row.status}`,
        latestEvaluation: latestBySubject.get(`material-extraction:${row.subject_id}`),
      })),
      ...retrievalSubjects.map((row) => ({
        subjectKind: "retrieval" as const,
        subjectId: row.subject_id,
        title: row.title,
        detail: `${row.status} · ${row.subject_id.slice(-12)}`,
        latestEvaluation: latestBySubject.get(`retrieval:${row.subject_id}`),
      })),
      ...statementSubjects.map((row) => ({
        subjectKind: "statement-proposal" as const,
        subjectId: row.subject_id,
        title: `${row.kind} proposal`,
        detail: `${row.review_state} · ${row.content.slice(0, 180)}`,
        latestEvaluation: latestBySubject.get(`statement-proposal:${row.subject_id}`),
      })),
      ...postCallSubjects.map((row) => {
        const proposal = decodeJson<{ content?: string }>(row.proposed_statement_json, {});
        return {
          subjectKind: "post-call-update" as const,
          subjectId: row.subject_id,
          title: `${row.kind} update`,
          detail: `${row.review_state} · ${(proposal.content ?? "No proposal content").slice(0, 180)}`,
          latestEvaluation: latestBySubject.get(`post-call-update:${row.subject_id}`),
        };
      }),
    ];
    const totals = {
      materials: totalsRow.materials,
      selectedExtractions: totalsRow.selected_extractions,
      readySnapshots: totalsRow.ready_snapshots,
      preparedSessions: totalsRow.prepared_sessions,
      closedPreparedSessions: totalsRow.closed_prepared_sessions,
      reviewedPostCallUpdates: totalsRow.reviewed_post_call_updates,
    };
    const trace = [
      ...operations.map((row): PreparationTraceEvent => ({
        id: row.id,
        operationId: row.operation_id,
        operationKind: row.operation_kind,
        status: row.status,
        payloadSummary: safePayloadSummary(decodeJson(row.payload_json, {})),
        occurredAt: row.occurred_at,
      })),
      ...receiptTraceRows.map((row): PreparationTraceEvent => ({
        id: row.id,
        operationId: row.operation_id,
        operationKind: `snapshot-artifact:${row.target}`,
        status: row.status,
        payloadSummary: {
          section: row.section,
          reason: row.reason ?? undefined,
        },
        occurredAt: row.occurred_at,
      })),
      ...privacyTraceRows.map((row): PreparationTraceEvent => ({
        id: row.id,
        operationId: row.operation_id,
        operationKind: `case-privacy:${row.action}`,
        status: row.status,
        payloadSummary: safePayloadSummary(decodeJson(row.item_counts_json, {})),
        occurredAt: row.occurred_at,
      })),
    ].sort((left, right) => right.occurredAt - left.occurredAt).slice(0, 300);
    return {
      trace,
      operationMetrics: summarizeOperationMetrics(operations),
      artifactReceiptCounts: Object.fromEntries(
        receiptRows.map((row) => [row.status, row.count])
      ),
      evaluationCounts: evaluations.reduce<Record<string, number>>((counts, evaluation) => {
        counts[evaluation.label] = (counts[evaluation.label] ?? 0) + 1;
        return counts;
      }, {}),
      visibleArtifacts,
      evaluationSubjects,
      isolationFindings,
      validationReadiness: [
        {
          id: "materials",
          label: "Source material and selected extraction exist",
          satisfied: totals.materials > 0 && totals.selectedExtractions === totals.materials,
          evidence: `${totals.selectedExtractions}/${totals.materials} materials selected`,
        },
        {
          id: "snapshot",
          label: "A Ready snapshot exists",
          satisfied: totals.readySnapshots > 0,
          evidence: `${totals.readySnapshots} Ready snapshots`,
        },
        {
          id: "visible-lineage",
          label: "Visible guidance has artifact lineage",
          satisfied: visibleArtifacts.length > 0,
          evidence: `${visibleArtifacts.length} visible artifact usages`,
        },
        {
          id: "two-calls",
          label: "Two prepared calls completed for continuity validation",
          satisfied: totals.closedPreparedSessions >= 2,
          evidence: `${totals.closedPreparedSessions} closed prepared calls`,
        },
        {
          id: "post-call",
          label: "A post-call proposal was human reviewed",
          satisfied: totals.reviewedPostCallUpdates > 0,
          evidence: `${totals.reviewedPostCallUpdates} accepted or edited updates`,
        },
        {
          id: "isolation",
          label: "Cross-Case isolation audit is clean",
          satisfied: isolationFindings.every((finding) => finding.count === 0),
          evidence: `${isolationFindings.reduce((sum, finding) => sum + finding.count, 0)} violations`,
        },
      ],
      totals,
    };
  }

  async recordEvaluation(input: {
    caseId: string;
    subjectKind: PreparationEvaluationSubjectKind;
    subjectId: string;
    label: PreparationHumanEvaluationLabel;
    note?: string;
    callSessionId?: string;
    snapshotId?: string;
    source?: "explicit" | "derived";
  }) {
    if (!EVALUATION_LABELS[input.subjectKind].includes(input.label)) {
      throw new Error(`${input.label} is not valid for ${input.subjectKind}.`);
    }
    const ownership = await this.requireSubjectOwnership(input);
    const evaluation: PreparationHumanEvaluation = {
      id: `preparation_evaluation_${crypto.randomUUID()}`,
      caseId: input.caseId,
      callSessionId: ownership.callSessionId ?? input.callSessionId,
      snapshotId: ownership.snapshotId ?? input.snapshotId,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      label: input.label,
      note: input.note?.trim() || undefined,
      source: input.source ?? "explicit",
      occurredAt: Date.now(),
    };
    await this.database.execute(
      `INSERT INTO preparation_human_evaluations (
        id, case_id, call_session_id, snapshot_id, subject_kind,
        subject_id, label, note, source, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        evaluation.id,
        evaluation.caseId,
        evaluation.callSessionId ?? null,
        evaluation.snapshotId ?? null,
        evaluation.subjectKind,
        evaluation.subjectId,
        evaluation.label,
        evaluation.note ?? null,
        evaluation.source,
        evaluation.occurredAt,
      ]
    );
    return evaluation;
  }

  async runCrossCaseIsolationAudit(caseId: string) {
    const findings: CrossCaseIsolationFinding[] = [];
    for (const item of CROSS_CASE_ISOLATION_QUERIES) {
      const rows = await this.database.select<Array<{ count: number }>>(item.query, [caseId]);
      findings.push({
        code: item.code,
        count: Number(rows[0]?.count ?? 0),
        detail: item.detail,
      });
    }
    return findings;
  }

  artifactUsageId(artifactId: string, callSessionId: string, target: string) {
    return `${artifactId}::${callSessionId}::${target}`;
  }

  private async requireSubjectOwnership(input: {
    caseId: string;
    subjectKind: PreparationEvaluationSubjectKind;
    subjectId: string;
    callSessionId?: string;
    snapshotId?: string;
  }): Promise<{ callSessionId?: string; snapshotId?: string }> {
    if (input.subjectKind === "snapshot-artifact") {
      const [artifactId, callSessionId, target] = input.subjectId.split("::");
      if (!artifactId || !callSessionId || !target) {
        throw new Error("Snapshot artifact evaluation must identify one visible usage.");
      }
      const rows = await this.database.select<Array<{ snapshot_id: string }>>(
        `SELECT receipt.snapshot_id FROM snapshot_artifact_receipts receipt
         JOIN snapshot_artifacts artifact ON artifact.id = receipt.artifact_id
         JOIN call_preparation_snapshots snapshot ON snapshot.id = receipt.snapshot_id
         WHERE snapshot.case_id = ? AND receipt.artifact_id = ?
           AND receipt.call_session_id = ? AND receipt.target = ?
           AND receipt.status = 'visible' LIMIT 1`,
        [input.caseId, artifactId, callSessionId, target]
      );
      if (!rows[0]) throw new Error("Only a visible snapshot artifact can be evaluated.");
      return { callSessionId, snapshotId: rows[0].snapshot_id };
    }
    const queryByKind: Record<Exclude<PreparationEvaluationSubjectKind, "snapshot-artifact">, string> = {
      "material-extraction": `SELECT run.id FROM extraction_runs run
        JOIN case_materials material ON material.id = run.material_id
        WHERE material.case_id = ? AND run.id = ?`,
      retrieval: `SELECT id FROM preparation_operation_events
        WHERE case_id = ? AND operation_id = ?`,
      "statement-proposal": "SELECT id FROM case_statements WHERE case_id = ? AND id = ?",
      "post-call-update": "SELECT id FROM pending_case_updates WHERE case_id = ? AND id = ?",
    };
    const rows = await this.database.select<Array<{ id: string }>>(
      queryByKind[input.subjectKind],
      [input.caseId, input.subjectId]
    );
    if (!rows[0]) throw new Error("Evaluation subject belongs to another Case or no longer exists.");
    return {};
  }
}
