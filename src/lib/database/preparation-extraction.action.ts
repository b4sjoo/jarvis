import type {
  PreparationExtractionCandidate,
  PreparationExtractionMetadata,
  PreparationMaterialChunk,
  PreparationMaterialExtractionRepository,
} from "@/lib/preparation/extraction-types";
import type { PreparationMaterialRevisionStatus } from "@/lib/preparation/types";
import type { PreparationMaterialQualitySignal } from "@/lib/preparation/types";
import { getDatabase } from "./config";

interface ExtractionCandidateRow {
  workspace_id: string;
  material_id: string;
  extension: string | null;
  revision_id: string;
  revision: number;
  source_checksum_sha256: string;
  extraction_status: PreparationMaterialRevisionStatus;
  extraction_request_id: string | null;
  extraction_started_at: number | null;
  completed_at: number | null;
  extracted_text_relative_path: string | null;
  extraction_metadata: string | null;
  review_status: "unreviewed" | "needs-review" | "approved";
  review_actor: "runtime" | "model" | "user" | null;
  review_updated_at: number | null;
  quality_signals_json: string;
  derived_from_revision_id: string | null;
}

interface PreparationMaterialChunkRow {
  id: string;
  workspace_id: string;
  material_id: string;
  material_revision_id: string;
  extraction_request_id: string;
  ordinal: number;
  content: string;
  search_text: string;
  page: number | null;
  section: string | null;
  source_method: string;
  confidence: number | null;
  start_offset: number | null;
  end_offset: number | null;
  created_at: number;
}

const CURRENT_EXTRACTION_SELECT = `
  SELECT
    m.workspace_id,
    m.id AS material_id,
    m.extension,
    r.id AS revision_id,
    r.revision,
    r.source_checksum_sha256,
    r.extraction_status,
    r.extraction_request_id,
    r.extraction_started_at,
    r.completed_at,
    r.extracted_text_relative_path,
    r.extraction_metadata,
    r.review_status,
    r.review_actor,
    r.review_updated_at,
    r.quality_signals_json,
    r.derived_from_revision_id
  FROM preparation_materials m
  JOIN preparation_workspaces w ON w.id = m.workspace_id
  JOIN preparation_material_revisions r ON r.material_id = m.id
  WHERE m.status <> 'deleted' AND m.deleted_at IS NULL
    AND r.revision = (
      SELECT MAX(latest.revision)
      FROM preparation_material_revisions latest
      WHERE latest.material_id = m.id
    )`;

export const preparationMaterialExtractionRepository: PreparationMaterialExtractionRepository = {
  async getCurrent(materialId) {
    return getCurrentCandidate(materialId);
  },

  async listRecoverable(workspaceId, staleBefore) {
    const db = await getDatabase();
    const rows = await db.select<ExtractionCandidateRow[]>(
      `${CURRENT_EXTRACTION_SELECT}
       AND m.workspace_id = ?
       AND w.status = 'active'
       AND (
         r.extraction_status = 'pending'
         OR (
           r.extraction_status = 'extracting'
           AND (r.extraction_started_at IS NULL OR r.extraction_started_at <= ?)
         )
       )
       ORDER BY m.created_at ASC`,
      [workspaceId, staleBefore]
    );
    return rows.map(mapCandidate);
  },

  async claim(input) {
    const db = await getDatabase();
    const result = await db.execute(
      `UPDATE preparation_material_revisions
       SET extraction_status = 'extracting',
           extraction_request_id = ?,
           extraction_started_at = ?,
           completed_at = NULL,
           extraction_metadata = NULL,
           review_status = 'unreviewed',
           review_actor = 'runtime',
           review_updated_at = ?,
           quality_signals_json = '[]'
       WHERE id = ? AND material_id = ? AND source_checksum_sha256 = ?
         AND EXISTS (
           SELECT 1 FROM preparation_materials m
           JOIN preparation_workspaces w ON w.id = m.workspace_id
           WHERE m.id = preparation_material_revisions.material_id
             AND m.workspace_id = ?
             AND w.status = 'active'
             AND m.status <> 'deleted' AND m.deleted_at IS NULL
         )
         AND (
           extraction_status IN ('pending', 'failed')
           OR (
             ? = 1
             AND extraction_status IN ('extracting', 'ready', 'needs-review', 'unsupported')
           )
           OR (
             extraction_status = 'extracting'
             AND (extraction_started_at IS NULL OR extraction_started_at <= ?)
           )
         )`,
      [
        input.requestId,
        input.startedAt,
        input.startedAt,
        input.revisionId,
        input.materialId,
        input.sourceChecksumSha256,
        input.workspaceId,
        input.force ? 1 : 0,
        input.staleBefore,
      ]
    );
    if (result.rowsAffected === 0) return false;
    await db.execute(
      `DELETE FROM preparation_material_chunks
       WHERE material_revision_id = ? AND extraction_request_id <> ?`,
      [input.revisionId, input.requestId]
    );
    await db.execute(
      `UPDATE preparation_materials
       SET status = 'extracting', updated_at = ?
       WHERE id = ? AND workspace_id = ?
         AND status <> 'deleted' AND deleted_at IS NULL`,
      [input.startedAt, input.materialId, input.workspaceId]
    );
    return true;
  },

  async complete(input) {
    const db = await getDatabase();
    for (const chunk of input.chunks) {
      const inserted = await db.execute(
        `INSERT INTO preparation_material_chunks
          (id, workspace_id, material_id, material_revision_id,
           extraction_request_id, ordinal, content, search_text, page, section,
           source_method, confidence, start_offset, end_offset, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1
           FROM preparation_material_revisions r
           JOIN preparation_materials m ON m.id = r.material_id
           JOIN preparation_workspaces w ON w.id = m.workspace_id
           WHERE r.id = ? AND r.material_id = ?
             AND r.extraction_status = 'extracting'
             AND r.extraction_request_id = ?
             AND m.workspace_id = ?
             AND w.status = 'active'
             AND m.status <> 'deleted' AND m.deleted_at IS NULL
         )`,
        [
          chunk.id,
          chunk.workspaceId,
          chunk.materialId,
          chunk.materialRevisionId,
          chunk.extractionRequestId,
          chunk.ordinal,
          chunk.content,
          chunk.searchText,
          chunk.page ?? null,
          chunk.section ?? null,
          chunk.sourceMethod,
          chunk.confidence ?? null,
          chunk.startOffset ?? null,
          chunk.endOffset ?? null,
          chunk.createdAt,
          input.revisionId,
          input.materialId,
          input.requestId,
          input.workspaceId,
        ]
      );
      if (inserted.rowsAffected === 0) {
        await deleteRequestChunks(input.revisionId, input.requestId);
        return false;
      }
    }

    const completed = await db.execute(
      `UPDATE preparation_material_revisions
       SET extraction_status = ?,
           extracted_text_relative_path = ?,
           extraction_metadata = ?,
           review_status = ?,
           review_actor = ?,
           review_updated_at = ?,
           quality_signals_json = ?,
           completed_at = ?
       WHERE id = ? AND material_id = ?
         AND extraction_status = 'extracting'
         AND extraction_request_id = ?
         AND EXISTS (
           SELECT 1 FROM preparation_materials m
           JOIN preparation_workspaces w ON w.id = m.workspace_id
           WHERE m.id = preparation_material_revisions.material_id
             AND m.workspace_id = ?
             AND w.status = 'active'
             AND m.status <> 'deleted' AND m.deleted_at IS NULL
         )`,
      [
        input.status,
        input.extractedTextRelativePath ?? null,
        JSON.stringify(input.metadata),
        input.reviewStatus,
        input.reviewActor,
        input.completedAt,
        JSON.stringify(input.qualitySignals ?? []),
        input.completedAt,
        input.revisionId,
        input.materialId,
        input.requestId,
        input.workspaceId,
      ]
    );
    if (completed.rowsAffected === 0) {
      await deleteRequestChunks(input.revisionId, input.requestId);
      return false;
    }
    await db.execute(
      `UPDATE preparation_materials
       SET status = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?
         AND status <> 'deleted' AND deleted_at IS NULL`,
      [input.status, input.completedAt, input.materialId, input.workspaceId]
    );
    await db.execute(
      `DELETE FROM preparation_material_chunks
       WHERE material_revision_id = ? AND extraction_request_id <> ?`,
      [input.revisionId, input.requestId]
    );
    return true;
  },

  async fail(input) {
    const db = await getDatabase();
    const failed = await db.execute(
      `UPDATE preparation_material_revisions
       SET extraction_status = 'failed',
           extracted_text_relative_path = NULL,
           extraction_metadata = ?,
           completed_at = ?
       WHERE id = ? AND material_id = ?
         AND extraction_status = 'extracting'
         AND extraction_request_id = ?
         AND EXISTS (
           SELECT 1 FROM preparation_materials m
           JOIN preparation_workspaces w ON w.id = m.workspace_id
           WHERE m.id = preparation_material_revisions.material_id
             AND m.workspace_id = ?
             AND w.status = 'active'
             AND m.status <> 'deleted' AND m.deleted_at IS NULL
         )`,
      [
        JSON.stringify(input.metadata),
        input.completedAt,
        input.revisionId,
        input.materialId,
        input.requestId,
        input.workspaceId,
      ]
    );
    await deleteRequestChunks(input.revisionId, input.requestId);
    if (failed.rowsAffected === 0) return false;
    await db.execute(
      `UPDATE preparation_materials
       SET status = 'failed', updated_at = ?
       WHERE id = ? AND workspace_id = ?
         AND status <> 'deleted' AND deleted_at IS NULL`,
      [input.completedAt, input.materialId, input.workspaceId]
    );
    return true;
  },

  async createDerivedRevision(input) {
    const db = await getDatabase();
    const inserted = await db.execute(
      `INSERT INTO preparation_material_revisions
        (id, material_id, revision, source_checksum_sha256,
         extraction_status, extraction_request_id, extraction_started_at,
         extraction_metadata, review_status, review_actor, review_updated_at,
         quality_signals_json, derived_from_revision_id, created_at)
       SELECT ?, m.id, base.revision + 1, base.source_checksum_sha256,
              'extracting', ?, ?, NULL, ?, ?, ?, ?, base.id, ?
       FROM preparation_materials m
       JOIN preparation_workspaces w ON w.id = m.workspace_id
       JOIN preparation_material_revisions base
         ON base.id = ? AND base.material_id = m.id
       WHERE m.id = ? AND m.workspace_id = ?
         AND m.status <> 'deleted' AND m.deleted_at IS NULL
         AND w.status = 'active'
         AND base.id = (
           SELECT latest.id
           FROM preparation_material_revisions latest
           WHERE latest.material_id = m.id
           ORDER BY latest.revision DESC
           LIMIT 1
         )`,
      [
        input.revisionId,
        input.requestId,
        input.createdAt,
        input.reviewStatus,
        input.reviewActor,
        input.createdAt,
        JSON.stringify(input.qualitySignals ?? []),
        input.createdAt,
        input.baseRevisionId,
        input.materialId,
        input.workspaceId,
      ]
    );
    if (inserted.rowsAffected === 0) return undefined;
    try {
      await db.execute(
        `INSERT INTO preparation_material_review_events
          (id, workspace_id, material_id, material_revision_id, action, actor,
           reason_codes_json, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        [
          `${input.revisionId}-event`,
          input.workspaceId,
          input.materialId,
          input.revisionId,
          input.action,
          input.reviewActor,
          JSON.stringify((input.qualitySignals ?? []).map((signal) => signal.code)),
          input.createdAt,
        ]
      );
    } catch (error) {
      await db.execute(
        `DELETE FROM preparation_material_revisions
         WHERE id = ? AND material_id = ?
           AND extraction_status = 'extracting'
           AND extraction_request_id = ?
           AND derived_from_revision_id = ?`,
        [
          input.revisionId,
          input.materialId,
          input.requestId,
          input.baseRevisionId,
        ]
      );
      throw error;
    }
    return getCurrentCandidate(input.materialId);
  },

  async discardDerivedRevision(input) {
    const db = await getDatabase();
    const discarded = await db.execute(
      `DELETE FROM preparation_material_revisions
       WHERE id = ? AND material_id = ?
         AND extraction_status = 'extracting'
         AND extraction_request_id = ?
         AND derived_from_revision_id = ?
         AND id = (
           SELECT latest.id
           FROM preparation_material_revisions latest
           WHERE latest.material_id = ?
           ORDER BY latest.revision DESC
           LIMIT 1
         )
         AND EXISTS (
           SELECT 1 FROM preparation_materials m
           JOIN preparation_workspaces w ON w.id = m.workspace_id
           WHERE m.id = preparation_material_revisions.material_id
             AND m.workspace_id = ? AND w.status = 'active'
             AND m.status <> 'deleted' AND m.deleted_at IS NULL
         )`,
      [
        input.revisionId,
        input.materialId,
        input.requestId,
        input.baseRevisionId,
        input.materialId,
        input.workspaceId,
      ]
    );
    return discarded.rowsAffected > 0;
  },

  async setReviewState(input) {
    const db = await getDatabase();
    const updated = await db.execute(
      `UPDATE preparation_material_revisions
       SET review_status = ?, review_actor = ?, review_updated_at = ?,
           quality_signals_json = ?
       WHERE id = ? AND material_id = ?
         AND id = (
           SELECT latest.id
           FROM preparation_material_revisions latest
           WHERE latest.material_id = ?
           ORDER BY latest.revision DESC
           LIMIT 1
         )
         AND EXISTS (
           SELECT 1 FROM preparation_materials m
           JOIN preparation_workspaces w ON w.id = m.workspace_id
           WHERE m.id = preparation_material_revisions.material_id
             AND m.workspace_id = ? AND w.status = 'active'
             AND m.status <> 'deleted' AND m.deleted_at IS NULL
         )`,
      [
        input.reviewStatus,
        input.actor,
        input.updatedAt,
        JSON.stringify(input.qualitySignals ?? []),
        input.revisionId,
        input.materialId,
        input.materialId,
        input.workspaceId,
      ]
    );
    if (updated.rowsAffected === 0) return false;
    await db.execute(
      `UPDATE preparation_materials
       SET status = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?
         AND status <> 'deleted' AND deleted_at IS NULL`,
      [
        input.reviewStatus === "approved" ? "ready" : "needs-review",
        input.updatedAt,
        input.materialId,
        input.workspaceId,
      ]
    );
    await db.execute(
      `INSERT INTO preparation_material_review_events
        (id, workspace_id, material_id, material_revision_id, action, actor,
         reason_codes_json, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.eventId,
        input.workspaceId,
        input.materialId,
        input.revisionId,
        input.action,
        input.actor,
        JSON.stringify((input.qualitySignals ?? []).map((signal) => signal.code)),
        input.detail ?? null,
        input.updatedAt,
      ]
    );
    return true;
  },

  async listChunks(revisionId) {
    const db = await getDatabase();
    const rows = await db.select<PreparationMaterialChunkRow[]>(
      `SELECT c.*
       FROM preparation_material_chunks c
       JOIN preparation_material_revisions r
         ON r.id = c.material_revision_id
        AND r.extraction_request_id = c.extraction_request_id
       WHERE c.material_revision_id = ?
       ORDER BY c.ordinal ASC`,
      [revisionId]
    );
    return rows.map(mapChunk);
  },
};

async function getCurrentCandidate(materialId: string) {
  const db = await getDatabase();
  const rows = await db.select<ExtractionCandidateRow[]>(
    `${CURRENT_EXTRACTION_SELECT} AND m.id = ? LIMIT 1`,
    [materialId]
  );
  return rows[0] ? mapCandidate(rows[0]) : undefined;
}

async function deleteRequestChunks(revisionId: string, requestId: string) {
  const db = await getDatabase();
  await db.execute(
    `DELETE FROM preparation_material_chunks
     WHERE material_revision_id = ? AND extraction_request_id = ?`,
    [revisionId, requestId]
  );
}

function mapCandidate(row: ExtractionCandidateRow): PreparationExtractionCandidate {
  return {
    workspaceId: row.workspace_id,
    materialId: row.material_id,
    extension: row.extension ?? "",
    revisionId: row.revision_id,
    revision: row.revision,
    sourceChecksumSha256: row.source_checksum_sha256,
    status: row.extraction_status,
    requestId: row.extraction_request_id ?? undefined,
    startedAt: row.extraction_started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    extractedTextRelativePath: row.extracted_text_relative_path ?? undefined,
    metadata: parseMetadata(row.extraction_metadata),
    reviewStatus: row.review_status,
    reviewActor: row.review_actor ?? undefined,
    reviewUpdatedAt: row.review_updated_at ?? undefined,
    qualitySignals: parseQualitySignals(row.quality_signals_json),
    derivedFromRevisionId: row.derived_from_revision_id ?? undefined,
  };
}

function parseQualitySignals(value: string): PreparationMaterialQualitySignal[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((raw): PreparationMaterialQualitySignal | undefined => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
        const signal = raw as Record<string, unknown>;
        if (
          typeof signal.code !== "string" ||
          typeof signal.detail !== "string" ||
          (signal.source !== "runtime" && signal.source !== "model")
        ) {
          return undefined;
        }
        return {
          code: signal.code,
          detail: signal.detail,
          confidence:
            typeof signal.confidence === "number"
              ? signal.confidence
              : undefined,
          page: typeof signal.page === "number" ? signal.page : undefined,
          source: signal.source as PreparationMaterialQualitySignal["source"],
        };
      })
      .filter((signal): signal is PreparationMaterialQualitySignal => Boolean(signal));
  } catch {
    return [];
  }
}

function parseMetadata(value: string | null): PreparationExtractionMetadata | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as PreparationExtractionMetadata;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function mapChunk(row: PreparationMaterialChunkRow): PreparationMaterialChunk {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    materialId: row.material_id,
    materialRevisionId: row.material_revision_id,
    extractionRequestId: row.extraction_request_id,
    ordinal: row.ordinal,
    content: row.content,
    searchText: row.search_text,
    page: row.page ?? undefined,
    section: row.section ?? undefined,
    sourceMethod: row.source_method,
    confidence: row.confidence ?? undefined,
    startOffset: row.start_offset ?? undefined,
    endOffset: row.end_offset ?? undefined,
    createdAt: row.created_at,
  };
}
