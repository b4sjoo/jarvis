import type {
  PreparationMaterial,
  PreparationMaterialRepository,
  PreparationMaterialScope,
  PreparationMaterialStatus,
} from "@/lib/preparation/types";
import { getDatabase } from "./config";

interface PreparationMaterialRow {
  id: string;
  workspace_id: string;
  scope_kind: "workspace" | "round";
  scope_id: string | null;
  display_name: string;
  original_file_name: string;
  mime_type: string;
  extension: string | null;
  size_bytes: number;
  checksum_sha256: string;
  storage_relative_path: string;
  status: PreparationMaterialStatus;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

const MATERIAL_SELECT = `
  SELECT
    m.id, m.workspace_id, m.scope_kind, m.scope_id, m.display_name,
    m.original_file_name, m.mime_type, m.extension, m.size_bytes,
    m.checksum_sha256, m.storage_relative_path,
    CASE
      WHEN m.status = 'deleted' OR m.deleted_at IS NOT NULL THEN 'deleted'
      ELSE COALESCE(
        (
          SELECT CASE latest.extraction_status
            WHEN 'pending' THEN 'received'
            ELSE latest.extraction_status
          END
          FROM preparation_material_revisions latest
          WHERE latest.material_id = m.id
          ORDER BY latest.revision DESC
          LIMIT 1
        ),
        m.status
      )
    END AS status,
    m.created_at, m.updated_at, m.deleted_at
  FROM preparation_materials m`;

export const preparationMaterialRepository: PreparationMaterialRepository = {
  async insert({ material, revision, sourceRef }) {
    const db = await getDatabase();
    await db.execute(
      `INSERT INTO preparation_materials
        (id, workspace_id, scope_kind, scope_id, display_name,
         original_file_name, mime_type, extension, size_bytes, checksum_sha256,
         storage_relative_path, status, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        material.id,
        material.workspaceId,
        material.scope.kind,
        material.scope.kind === "round" ? material.scope.roundId : null,
        material.displayName,
        material.originalFileName,
        material.mimeType,
        material.extension ?? null,
        material.sizeBytes,
        material.checksumSha256,
        material.storageRelativePath,
        material.status,
        material.createdAt,
        material.updatedAt,
        material.deletedAt ?? null,
      ]
    );

    try {
      await db.execute(
        `INSERT INTO preparation_material_revisions
          (id, material_id, revision, source_checksum_sha256,
           extraction_status, extracted_text_relative_path,
           extraction_metadata, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          revision.id,
          revision.materialId,
          revision.revision,
          revision.sourceChecksumSha256,
          revision.extractionStatus,
          revision.extractedTextRelativePath ?? null,
          revision.extractionMetadata ?? null,
          revision.createdAt,
          revision.completedAt ?? null,
        ]
      );
      await db.execute(
        `INSERT INTO preparation_source_refs
          (id, workspace_id, material_id, material_revision_id, source_kind,
           locator, content_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sourceRef.id,
          sourceRef.workspaceId,
          sourceRef.materialId ?? null,
          sourceRef.materialRevisionId ?? null,
          sourceRef.sourceKind,
          sourceRef.locator,
          sourceRef.contentHash,
          sourceRef.createdAt,
        ]
      );
    } catch (error) {
      await db
        .execute("DELETE FROM preparation_materials WHERE id = ?", [material.id])
        .catch(() => {});
      throw error;
    }
  },

  async get(id) {
    const db = await getDatabase();
    const rows = await db.select<PreparationMaterialRow[]>(
      `${MATERIAL_SELECT} WHERE m.id = ?`,
      [id]
    );
    return rows[0] ? mapMaterialRow(rows[0]) : undefined;
  },

  async list(workspaceId) {
    const db = await getDatabase();
    const rows = await db.select<PreparationMaterialRow[]>(
      `${MATERIAL_SELECT}
       WHERE m.workspace_id = ? AND m.status <> 'deleted' AND m.deleted_at IS NULL
       ORDER BY m.created_at DESC`,
      [workspaceId]
    );
    return rows.map(mapMaterialRow);
  },

  async findByChecksum(workspaceId, checksumSha256) {
    const db = await getDatabase();
    const rows = await db.select<PreparationMaterialRow[]>(
      `${MATERIAL_SELECT}
       WHERE m.workspace_id = ? AND m.checksum_sha256 = ?
         AND m.status <> 'deleted' AND m.deleted_at IS NULL
       LIMIT 1`,
      [workspaceId, checksumSha256]
    );
    return rows[0] ? mapMaterialRow(rows[0]) : undefined;
  },

  async updateScope(input) {
    const db = await getDatabase();
    const result = await db.execute(
      `UPDATE preparation_materials
       SET scope_kind = ?, scope_id = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?
         AND status <> 'deleted' AND deleted_at IS NULL`,
      [
        input.scope.kind,
        input.scope.kind === "round" ? input.scope.roundId : null,
        input.updatedAt,
        input.id,
        input.workspaceId,
      ]
    );
    if (result.rowsAffected === 0) {
      throw new Error("Preparation material not found.");
    }
  },

  async setLifecycle(input) {
    const db = await getDatabase();
    const result = await db.execute(
      `UPDATE preparation_materials
       SET status = ?, updated_at = ?, deleted_at = ?
       WHERE id = ? AND workspace_id = ?`,
      [
        input.status,
        input.updatedAt,
        input.deletedAt ?? null,
        input.id,
        input.workspaceId,
      ]
    );
    if (result.rowsAffected === 0) {
      throw new Error("Preparation material not found.");
    }
  },
};

function mapMaterialRow(row: PreparationMaterialRow): PreparationMaterial {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    scope: mapScope(row.scope_kind, row.scope_id),
    displayName: row.display_name,
    originalFileName: row.original_file_name,
    mimeType: row.mime_type,
    extension: row.extension ?? undefined,
    sizeBytes: row.size_bytes,
    checksumSha256: row.checksum_sha256,
    storageRelativePath: row.storage_relative_path,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
  };
}

function mapScope(
  kind: "workspace" | "round",
  scopeId: string | null
): PreparationMaterialScope {
  if (kind === "round" && scopeId) {
    return { kind: "round", roundId: scopeId };
  }
  return { kind: "workspace" };
}
