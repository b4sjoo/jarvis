import { sha256 } from "../calling/index.js";
import {
  decodeJson,
  encodeJson,
  type SqlDatabase,
} from "./database.js";
import type { CaseSourceRef } from "./types.js";

interface StatementAuthorityRow {
  id: string;
  revision: number;
  source_status: "current" | "stale";
}

interface SourceAuthorityRow {
  id: string;
  statement_id: string;
  source_kind: CaseSourceRef["sourceKind"];
  source_id: string;
  source_revision: number | null;
  content_hash: string;
  quoted_text: string | null;
}

export interface StatementSourceAuthorityResult {
  statementId: string;
  status: "current" | "stale";
  reasons: string[];
}

const eventId = () => `statement_event_${crypto.randomUUID()}`;

async function validateSource(
  database: SqlDatabase,
  source: SourceAuthorityRow
): Promise<string | null> {
  if (source.source_kind === "user") {
    if (!source.quoted_text) return "user-entry-text-missing";
    return (await sha256(source.quoted_text)) === source.content_hash
      ? null
      : "user-entry-hash-changed";
  }
  if (source.source_kind === "conversation") {
    const rows = await database.select<Array<{
      revision: number;
      content: string;
      role: string;
      status: string;
    }>>(
      `SELECT revision, content, role, status FROM preparation_messages
       WHERE id = ?`,
      [source.source_id]
    );
    const current = rows[0];
    if (!current) return "conversation-message-missing";
    if (current.role !== "user" || current.status !== "committed") {
      return "conversation-message-superseded";
    }
    if (
      source.source_revision !== null &&
      current.revision !== source.source_revision
    ) {
      return "conversation-message-revision-changed";
    }
    return (await sha256(current.content)) === source.content_hash
      ? null
      : "conversation-message-hash-changed";
  }
  if (source.source_kind === "material") {
    const rows = await database.select<Array<{
      content_hash: string;
      selected_extraction_run_id: string | null;
      extraction_run_id: string;
      run_status: string;
      review_status: string;
    }>>(
      `SELECT chunk.content_hash, material.selected_extraction_run_id,
       run.id AS extraction_run_id, run.status AS run_status,
       material.review_status
       FROM extraction_chunks chunk
       JOIN extraction_runs run ON run.id = chunk.extraction_run_id
       JOIN case_materials material ON material.id = run.material_id
       WHERE chunk.id = ?`,
      [source.source_id]
    );
    const current = rows[0];
    if (!current) return "material-chunk-missing";
    if (current.selected_extraction_run_id !== current.extraction_run_id) {
      return "material-extraction-superseded";
    }
    const eligible =
      current.run_status === "ready" ||
      (current.run_status === "needs-review" &&
        current.review_status === "approved");
    if (!eligible) return "material-extraction-not-approved";
    return current.content_hash === source.content_hash
      ? null
      : "material-chunk-hash-changed";
  }
  if (source.source_kind === "call-turn") {
    const rows = await database.select<Array<{ payload_json: string }>>(
      `SELECT payload_json FROM call_runtime_events
       WHERE event_kind = 'runtime-command' ORDER BY occurred_at`,
      []
    );
    for (const row of rows) {
      const payload = decodeJson<{
        command?: { type?: string; turn?: { id?: string; text?: string } };
      }>(row.payload_json, {});
      const turn = payload.command?.turn;
      if (
        payload.command?.type === "SubmitTranscriptTurn" &&
        turn?.id === source.source_id &&
        typeof turn.text === "string"
      ) {
        return (await sha256(turn.text)) === source.content_hash
          ? null
          : "call-turn-hash-changed";
      }
    }
    return "call-turn-missing";
  }
  if (source.source_kind === "kmb") {
    return source.content_hash ? null : "kmb-hash-missing";
  }
  return "unsupported-statement-source-kind";
}

export async function inspectStatementSourceAuthority(
  database: SqlDatabase,
  statementId: string
): Promise<StatementSourceAuthorityResult> {
  const statements = await database.select<StatementAuthorityRow[]>(
    "SELECT id, revision, source_status FROM case_statements WHERE id = ?",
    [statementId]
  );
  if (!statements[0]) throw new Error("CaseStatement was not found.");
  const sources = await database.select<SourceAuthorityRow[]>(
    `SELECT id, statement_id, source_kind, source_id, source_revision,
     content_hash, quoted_text FROM case_statement_sources
     WHERE statement_id = ? ORDER BY created_at`,
    [statementId]
  );
  const reasons: string[] = [];
  for (const source of sources) {
    const reason = await validateSource(database, source);
    if (reason) reasons.push(`${source.id}:${reason}`);
  }
  return {
    statementId,
    status: reasons.length ? "stale" : "current",
    reasons,
  };
}

export async function reconcileCaseStatementSourceAuthority(
  database: SqlDatabase,
  caseId: string
): Promise<StatementSourceAuthorityResult[]> {
  const statements = await database.select<StatementAuthorityRow[]>(
    `SELECT id, revision, source_status FROM case_statements
     WHERE case_id = ? AND review_state = 'confirmed'`,
    [caseId]
  );
  const sources = await database.select<SourceAuthorityRow[]>(
    `SELECT source.* FROM case_statement_sources source
     JOIN case_statements statement ON statement.id = source.statement_id
     WHERE statement.case_id = ? ORDER BY source.created_at`,
    [caseId]
  );
  const results: StatementSourceAuthorityResult[] = [];
  for (const statement of statements) {
    const statementSources = sources.filter(
      (candidate) => candidate.statement_id === statement.id
    );
    const reasons: string[] = [];
    for (const source of statementSources) {
      const reason = await validateSource(database, source);
      if (reason) reasons.push(`${source.id}:${reason}`);
    }
    const status = reasons.length ? "stale" : "current";
    results.push({ statementId: statement.id, status, reasons });
    if (status === statement.source_status) {
      await database.execute(
        `UPDATE case_statements SET source_stale_reasons_json = ?
         WHERE id = ? AND source_status = ?`,
        [encodeJson(reasons), statement.id, status]
      );
      continue;
    }
    const occurredAt = Date.now();
    await database.execute(
      `UPDATE case_statements SET source_status = ?,
       source_stale_reasons_json = ?, updated_at = ? WHERE id = ?`,
      [status, encodeJson(reasons), occurredAt, statement.id]
    );
    await database.execute(
      `INSERT INTO case_statement_events (
        id, case_id, statement_id, event_type, statement_revision,
        payload_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        eventId(),
        caseId,
        statement.id,
        status === "stale" ? "source-stale" : "source-refreshed",
        statement.revision,
        encodeJson({ reasons }),
        occurredAt,
      ]
    );
  }
  return results;
}
