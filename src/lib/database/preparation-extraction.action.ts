import { invoke } from "@tauri-apps/api/core";
import type {
  PreparationExtractionCandidate,
  PreparationExtractionMetadata,
  PreparationMaterialChunk,
  PreparationMaterialExtractionRepository,
} from "@/lib/preparation/extraction-types";
import { getDatabase } from "./config";

interface ExtractionRow {
  workspace_id: string;
  material_id: string;
  extension: string | null;
  revision_id: string;
  revision: number;
  source_checksum_sha256: string;
  extraction_status: PreparationExtractionCandidate["status"];
  extraction_request_id: string | null;
  extraction_started_at: number | null;
  completed_at: number | null;
  extracted_text_relative_path: string | null;
  extraction_metadata: string | null;
  output_hash: string | null;
  review_status: PreparationExtractionCandidate["reviewStatus"];
  review_actor: PreparationExtractionCandidate["reviewActor"] | null;
  review_updated_at: number | null;
  review_event_id: string | null;
  quality_signals_json: string;
  derived_from_revision_id: string | null;
}

const EXTRACTION_SELECT = `SELECT m.workspace_id, m.id AS material_id, m.extension,
  r.id AS revision_id, r.revision, r.source_checksum_sha256, r.extraction_status,
  r.extraction_request_id, r.extraction_started_at, r.completed_at,
  r.extracted_text_relative_path, r.extraction_metadata, r.output_hash,
  r.review_status, r.review_actor, r.review_updated_at, r.quality_signals_json,
  r.derived_from_revision_id,
  (SELECT id FROM preparation_material_review_events WHERE material_revision_id = r.id
   ORDER BY rowid DESC LIMIT 1) AS review_event_id
  FROM preparation_materials m JOIN preparation_material_revisions r ON r.material_id = m.id
  JOIN preparation_workspaces w ON w.id = m.workspace_id
  WHERE m.status <> 'deleted' AND m.deleted_at IS NULL AND w.status = 'active'`;

export const preparationMaterialExtractionRepository: PreparationMaterialExtractionRepository = {
  getCurrent(materialId) {
    return readRevision("m.id = ? AND r.id = m.candidate_revision_id", [materialId]);
  },
  getSelected(materialId) {
    return readRevision("m.id = ? AND r.id = m.selected_revision_id", [materialId]);
  },
  getRevision(materialId, revisionId) {
    return readRevision("m.id = ? AND r.id = ?", [materialId, revisionId]);
  },
  async listRecoverable(workspaceId, staleBefore) {
    const db = await getDatabase();
    const rows = await db.select<ExtractionRow[]>(`${EXTRACTION_SELECT}
      AND m.workspace_id = ? AND r.id = m.candidate_revision_id
      AND (r.extraction_status = 'pending' OR (r.extraction_status = 'extracting'
        AND (r.extraction_started_at IS NULL OR r.extraction_started_at <= ?)))
      ORDER BY m.created_at ASC`, [workspaceId, staleBefore]);
    return rows.map(mapCandidate);
  },
  async claim(input) {
    await getDatabase();
    const id = await invoke<string | null>("preparation_extraction_claim", { input });
    return id ? this.getRevision(input.materialId, id) : undefined;
  },
  async complete(input) {
    await getDatabase();
    return invoke<boolean>("preparation_extraction_complete", { input });
  },
  async fail(input) {
    await getDatabase();
    return invoke<boolean>("preparation_extraction_fail", { input });
  },
  async createDerivedRevision(input) {
    const base = await this.getRevision(input.materialId, input.baseRevisionId);
    if (!base) return undefined;
    const id = await invoke<string | null>("preparation_extraction_claim", { input: {
      workspaceId: input.workspaceId, materialId: input.materialId,
      revisionId: input.baseRevisionId, newRevisionId: input.revisionId,
      sourceChecksumSha256: base.sourceChecksumSha256, requestId: input.requestId,
      startedAt: input.createdAt, staleBefore: input.createdAt, force: false,
      derived: { reviewStatus: input.reviewStatus, reviewActor: input.reviewActor,
        qualitySignals: input.qualitySignals ?? [], action: input.action },
    } });
    return id ? this.getRevision(input.materialId, id) : undefined;
  },
  async discardDerivedRevision(input) {
    // Settle only the failed candidate. Historical revision numbers are never recycled.
    return this.fail({ ...input, completedAt: Date.now(), metadata: {
      method: "none", textChars: 0, chunkCount: 0, warningCodes: ["extraction-failed"],
      durationMs: 0, offsetUnit: "unicode-scalar",
    } });
  },
  async setReviewState(input) {
    await getDatabase();
    return invoke<boolean>("preparation_extraction_review", { input: {
      ...input, expectedRequestId: input.expectedRequestId ?? null,
      expectedReviewEventId: input.expectedReviewEventId ?? null,
      qualitySignals: input.qualitySignals ?? [],
    } });
  },
  async listChunks(revisionId) {
    const db = await getDatabase();
    const rows = await db.select<Array<{
      id: string; workspace_id: string; material_id: string; material_revision_id: string;
      extraction_request_id: string; ordinal: number; content: string; search_text: string;
      page: number | null; section: string | null; source_method: string;
      confidence: number | null; start_offset: number | null; end_offset: number | null; created_at: number;
    }>>(`SELECT c.* FROM preparation_material_chunks c
      JOIN preparation_material_revisions r ON r.id = c.material_revision_id
        AND r.extraction_request_id = c.extraction_request_id
      JOIN preparation_materials m ON m.id = r.material_id
      JOIN preparation_workspaces w ON w.id = m.workspace_id
      WHERE r.id = ? AND m.deleted_at IS NULL AND m.status <> 'deleted' AND w.status = 'active'
      ORDER BY c.ordinal`, [revisionId]);
    return rows.map((row): PreparationMaterialChunk => ({
      id: row.id, workspaceId: row.workspace_id, materialId: row.material_id,
      materialRevisionId: row.material_revision_id, extractionRequestId: row.extraction_request_id,
      ordinal: row.ordinal, content: row.content, searchText: row.search_text,
      page: row.page ?? undefined, section: row.section ?? undefined, sourceMethod: row.source_method,
      confidence: row.confidence ?? undefined, startOffset: row.start_offset ?? undefined,
      endOffset: row.end_offset ?? undefined, createdAt: row.created_at,
    }));
  },
};

async function readRevision(condition: string, values: string[]) {
  const db = await getDatabase();
  const rows = await db.select<ExtractionRow[]>(`${EXTRACTION_SELECT} AND ${condition} LIMIT 1`, values);
  return rows[0] ? mapCandidate(rows[0]) : undefined;
}

function mapCandidate(row: ExtractionRow): PreparationExtractionCandidate {
  return {
    workspaceId: row.workspace_id, materialId: row.material_id, extension: row.extension ?? "",
    revisionId: row.revision_id, revision: row.revision, sourceChecksumSha256: row.source_checksum_sha256,
    status: row.extraction_status, requestId: row.extraction_request_id ?? undefined,
    startedAt: row.extraction_started_at ?? undefined, completedAt: row.completed_at ?? undefined,
    extractedTextRelativePath: row.extracted_text_relative_path ?? undefined,
    metadata: parseJson<PreparationExtractionMetadata | undefined>(row.extraction_metadata, undefined),
    outputHash: row.output_hash ?? undefined, reviewStatus: row.review_status,
    reviewActor: row.review_actor ?? undefined, reviewUpdatedAt: row.review_updated_at ?? undefined,
    reviewEventId: row.review_event_id ?? undefined,
    qualitySignals: parseJson(row.quality_signals_json, []),
    derivedFromRevisionId: row.derived_from_revision_id ?? undefined,
  };
}

function parseJson<T>(value: string | null, fallback: T): T {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}
