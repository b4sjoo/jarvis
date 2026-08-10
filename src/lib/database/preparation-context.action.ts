import type {
  PreparationMaterialContextCandidate,
  PreparationMaterialContextRepository,
} from "@/lib/preparation/context-types";
import { getDatabase } from "./config";

interface PreparationContextChunkRow {
  chunk_id: string;
  process_id: string;
  material_id: string;
  material_revision_id: string;
  material_name: string;
  material_status: "ready" | "needs-review";
  scope_kind: "workspace" | "round";
  scope_id: string | null;
  content: string;
  search_text: string;
  page: number | null;
  section: string | null;
  source_method: string;
  confidence: number | null;
  extraction_metadata: string | null;
}

export const preparationMaterialContextRepository: PreparationMaterialContextRepository = {
  async searchCandidates(input) {
    const db = await getDatabase();
    const queryTokens = input.queryTokens.slice(0, 10);
    const preferredMaterialIds = input.preferredMaterialIds.slice(0, 12);
    const searchConditions = [
      ...queryTokens.map(
        () => "(c.search_text LIKE ? ESCAPE '\\' OR lower(m.display_name) LIKE ? ESCAPE '\\')"
      ),
      ...(preferredMaterialIds.length
        ? [
            `m.id IN (${preferredMaterialIds.map(() => "?").join(", ")})`,
          ]
        : []),
    ];
    if (!searchConditions.length) return [];

    const searchValues = [
      ...queryTokens.flatMap((token) => {
        const pattern = `%${escapeLike(token.toLowerCase())}%`;
        return [pattern, pattern];
      }),
      ...preferredMaterialIds,
    ];
    const preferredReviewClause = preferredMaterialIds.length
      ? `OR (
           (r.review_status = 'needs-review' OR r.extraction_status = 'needs-review')
           AND m.id IN (${preferredMaterialIds.map(() => "?").join(", ")})
         )`
      : "";
    const rows = await db.select<PreparationContextChunkRow[]>(
      `SELECT
         c.id AS chunk_id,
         m.workspace_id AS process_id,
         m.id AS material_id,
         c.material_revision_id,
         m.display_name AS material_name,
         CASE
           WHEN r.review_status = 'approved' THEN 'ready'
           WHEN r.review_status = 'needs-review' OR r.extraction_status = 'needs-review'
             THEN 'needs-review'
           ELSE 'ready'
         END AS material_status,
         m.scope_kind,
         m.scope_id,
         c.content,
         c.search_text,
         c.page,
         c.section,
         c.source_method,
         c.confidence,
         r.extraction_metadata
       FROM preparation_material_chunks c
       JOIN preparation_material_revisions r
         ON r.id = c.material_revision_id
        AND r.extraction_request_id = c.extraction_request_id
       JOIN preparation_materials m ON m.id = c.material_id
       JOIN interview_processes p ON p.id = m.workspace_id
       WHERE p.id = ?
         AND m.status <> 'deleted' AND m.deleted_at IS NULL
         AND r.extraction_status IN ('ready', 'needs-review')
         AND (
           (
             r.review_status = 'approved'
             OR (
               r.extraction_status = 'ready'
               AND r.review_status = 'unreviewed'
             )
           )
           ${preferredReviewClause}
         )
         AND r.revision = (
           SELECT MAX(latest.revision)
           FROM preparation_material_revisions latest
           WHERE latest.material_id = m.id
         )
         AND (
           m.scope_kind = 'workspace'
           OR (m.scope_kind = 'round' AND m.scope_id = ?)
         )
         AND (${searchConditions.join(" OR ")})
       ORDER BY
         CASE WHEN m.scope_kind = 'round' THEN 0 ELSE 1 END,
         m.updated_at DESC,
         c.ordinal ASC
       LIMIT ?`,
      [
        input.processId,
        ...preferredMaterialIds,
        input.roundId ?? "",
        ...searchValues,
        input.limit,
      ]
    );
    return rows.map(mapCandidate);
  },
};

function mapCandidate(
  row: PreparationContextChunkRow
): PreparationMaterialContextCandidate {
  const metadata = parseExtractionMetadata(row.extraction_metadata);
  return {
    chunkId: row.chunk_id,
    processId: row.process_id,
    materialId: row.material_id,
    materialRevisionId: row.material_revision_id,
    materialName: row.material_name,
    materialStatus: row.material_status,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id ?? undefined,
    content: row.content,
    searchText: row.search_text,
    page: row.page ?? undefined,
    section: row.section ?? undefined,
    sourceMethod: row.source_method,
    confidence: row.confidence ?? undefined,
    pageCount: metadata.pageCount,
    ocrAverageConfidence: metadata.ocrAverageConfidence,
    warningCodes: metadata.warningCodes,
  };
}

function parseExtractionMetadata(value: string | null): {
  warningCodes: string[];
  pageCount?: number;
  ocrAverageConfidence?: number;
} {
  if (!value) return { warningCodes: [] };
  try {
    const parsed = JSON.parse(value) as {
      warningCodes?: unknown;
      pageCount?: unknown;
      ocrAverageConfidence?: unknown;
    };
    return {
      warningCodes: Array.isArray(parsed.warningCodes)
        ? parsed.warningCodes.filter(
            (warning): warning is string => typeof warning === "string"
          )
        : [],
      pageCount:
        typeof parsed.pageCount === "number" ? parsed.pageCount : undefined,
      ocrAverageConfidence:
        typeof parsed.ocrAverageConfidence === "number"
          ? parsed.ocrAverageConfidence
          : undefined,
    };
  } catch {
    return { warningCodes: [] };
  }
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
