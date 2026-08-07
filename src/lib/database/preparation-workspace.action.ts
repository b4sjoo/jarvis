import type {
  PreparationWorkspace,
  PreparationWorkspaceKind,
  PreparationWorkspaceRepository,
  PreparationWorkspaceStatus,
} from "@/lib/preparation/types";
import { getDatabase } from "./config";

interface PreparationWorkspaceRow {
  id: string;
  kind: PreparationWorkspaceKind;
  title: string;
  status: PreparationWorkspaceStatus;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export const preparationWorkspaceRepository: PreparationWorkspaceRepository = {
  async insert(workspace) {
    const db = await getDatabase();
    await db.execute(
      `INSERT INTO preparation_workspaces
        (id, kind, title, status, created_at, updated_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        workspace.id,
        workspace.kind,
        workspace.title,
        workspace.status,
        workspace.createdAt,
        workspace.updatedAt,
        workspace.archivedAt ?? null,
      ]
    );
  },

  async get(id) {
    const db = await getDatabase();
    const rows = await db.select<PreparationWorkspaceRow[]>(
      "SELECT * FROM preparation_workspaces WHERE id = ?",
      [id]
    );
    return rows[0] ? mapWorkspaceRow(rows[0]) : undefined;
  },

  async list(input = {}) {
    const db = await getDatabase();
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (input.kind) {
      clauses.push("kind = ?");
      parameters.push(input.kind);
    }
    if (!input.includeArchived) {
      clauses.push("status = 'active'");
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await db.select<PreparationWorkspaceRow[]>(
      `SELECT * FROM preparation_workspaces ${where} ORDER BY updated_at DESC`,
      parameters
    );
    return rows.map(mapWorkspaceRow);
  },

  async setLifecycle(input) {
    const db = await getDatabase();
    const result = await db.execute(
      `UPDATE preparation_workspaces
       SET status = ?, updated_at = ?, archived_at = ?
       WHERE id = ?`,
      [input.status, input.updatedAt, input.archivedAt ?? null, input.id]
    );
    if (result.rowsAffected === 0) {
      throw new Error("Preparation workspace not found.");
    }
  },

  async delete(id) {
    const db = await getDatabase();
    await db.execute("DELETE FROM preparation_workspaces WHERE id = ?", [id]);
  },
};

function mapWorkspaceRow(row: PreparationWorkspaceRow): PreparationWorkspace {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? undefined,
  };
}
