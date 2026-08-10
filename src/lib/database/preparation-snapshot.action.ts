import type {
  InterviewPreparationSnapshot,
  PreparationSnapshotActivationEvent,
  PreparationCurrentContext,
  PreparationCurrentContextEvent,
  PreparationSnapshotRepository,
} from "@/lib/preparation/snapshot-types";
import { ensurePreparationSnapshotArtifactManifest } from "@/lib/preparation/snapshot-artifact-manifest";
import { getDatabase } from "./config";

interface SnapshotRow {
  id: string;
  process_id: string;
  round_id: string;
  version: number;
  profile_revision_id: string;
  profile_revision: number;
  compiler_version: string;
  playbook_registry_version: string;
  runtime_capability_version: string;
  source_fingerprint: string;
  content_hash: string;
  runtime_char_count: number;
  snapshot_json: string;
  source_manifest_json: string;
  warnings_json: string;
  status: InterviewPreparationSnapshot["status"];
  created_at: number;
  activated_at: number | null;
}

interface ActivationEventRow {
  id: string;
  process_id: string;
  round_id: string;
  snapshot_id: string;
  previous_snapshot_id: string | null;
  action: PreparationSnapshotActivationEvent["action"];
  created_at: number;
}

interface CurrentContextRow {
  process_id: string | null;
  round_id: string | null;
  selected_snapshot_id: string | null;
  revision: number;
  updated_at: number;
}

interface CurrentContextEventRow {
  id: string;
  previous_process_id: string | null;
  previous_round_id: string | null;
  previous_snapshot_id: string | null;
  process_id: string | null;
  round_id: string | null;
  selected_snapshot_id: string | null;
  action: PreparationCurrentContextEvent["action"];
  revision: number;
  created_at: number;
}

const SNAPSHOT_SELECT = `
  SELECT id, process_id, round_id, version, profile_revision_id,
         profile_revision, compiler_version, playbook_registry_version,
         runtime_capability_version, source_fingerprint, content_hash,
         runtime_char_count, snapshot_json, source_manifest_json,
         warnings_json, status, created_at, activated_at
  FROM interview_preparation_snapshots
  WHERE build_status = 'committed'`;

export const preparationSnapshotRepository: PreparationSnapshotRepository = {
  async get(processId, snapshotId) {
    const db = await getDatabase();
    const rows = await db.select<SnapshotRow[]>(
      `${SNAPSHOT_SELECT} AND process_id = ? AND id = ? LIMIT 1`,
      [processId, snapshotId]
    );
    return rows[0] ? mapSnapshot(rows[0]) : undefined;
  },

  async getByContentHash(input) {
    const db = await getDatabase();
    const rows = await db.select<SnapshotRow[]>(
      `${SNAPSHOT_SELECT}
       AND process_id = ? AND round_id = ? AND content_hash = ?
       LIMIT 1`,
      [input.processId, input.roundId, input.contentHash]
    );
    return rows[0] ? mapSnapshot(rows[0]) : undefined;
  },

  async getActive(input) {
    const db = await getDatabase();
    const rows = await db.select<SnapshotRow[]>(
      `${SNAPSHOT_SELECT}
       AND process_id = ? AND round_id = ?
       AND id = (
         SELECT selected_snapshot_id
         FROM interview_preparation_current_context
         WHERE singleton_id = 1
           AND process_id = ? AND round_id = ?
       )
       LIMIT 1`,
      [input.processId, input.roundId, input.processId, input.roundId]
    );
    return rows[0] ? mapSnapshot(rows[0]) : undefined;
  },

  async list(input) {
    const db = await getDatabase();
    const rows = await db.select<SnapshotRow[]>(
      `${SNAPSHOT_SELECT}
       AND process_id = ? AND round_id = ?
       ORDER BY version DESC`,
      [input.processId, input.roundId]
    );
    return rows.map(mapSnapshot);
  },

  async nextVersion(input) {
    const db = await getDatabase();
    const rows = await db.select<Array<{ version: number }>>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS version
       FROM interview_preparation_snapshots
       WHERE process_id = ? AND round_id = ?`,
      [input.processId, input.roundId]
    );
    return rows[0]?.version ?? 1;
  },

  async getCurrentContext() {
    const db = await getDatabase();
    const rows = await db.select<CurrentContextRow[]>(
      `SELECT process_id, round_id, selected_snapshot_id, revision, updated_at
       FROM interview_preparation_current_context
       WHERE singleton_id = 1
       LIMIT 1`
    );
    return mapCurrentContext(rows[0]);
  },

  async setCurrentContext(input) {
    const db = await getDatabase();
    const updated = await db.execute(
      `UPDATE interview_preparation_current_context
       SET process_id = ?,
           round_id = ?,
           selected_snapshot_id = CASE
             WHEN process_id = ? AND round_id = ? THEN selected_snapshot_id
             ELSE NULL
           END,
           revision = revision + 1,
           updated_at = ?
       WHERE singleton_id = 1 AND revision = ?
         AND (process_id IS NOT ? OR round_id IS NOT ?)`,
      [
        input.processId,
        input.roundId,
        input.processId,
        input.roundId,
        input.updatedAt,
        input.expectedRevision,
        input.processId,
        input.roundId,
      ]
    );
    if (updated.rowsAffected > 0) return true;
    const context = await this.getCurrentContext();
    return (
      context.processId === input.processId &&
      context.roundId === input.roundId
    );
  },

  async insert(input) {
    const db = await getDatabase();
    const snapshot = input.snapshot;
    await db.execute(
      `DELETE FROM interview_preparation_snapshots
       WHERE process_id = ? AND round_id = ? AND build_status = 'staging'`,
      [snapshot.processId, snapshot.roundId]
    );
    const inserted = await db.execute(
      `INSERT INTO interview_preparation_snapshots
        (id, process_id, round_id, version, profile_revision_id,
         profile_revision, compiler_version, playbook_registry_version,
         runtime_capability_version, source_fingerprint, content_hash,
         runtime_char_count, snapshot_json, source_manifest_json,
         warnings_json, status, build_status, created_at, activated_at)
       SELECT ?, ?, round.id, ?, profile.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              'ready', 'staging', ?, NULL
       FROM interview_rounds round
       JOIN interview_processes process ON process.id = round.process_id
       JOIN preparation_workspaces workspace ON workspace.id = process.workspace_id
       JOIN interview_preparation_profile_revisions profile
         ON profile.id = ? AND profile.process_id = process.id
       WHERE round.id = ? AND round.process_id = ? AND round.archived_at IS NULL
         AND workspace.status = 'active'
         AND profile.scope_key = round.id AND profile.build_status = 'committed'
         AND profile.revision = ? AND profile.source_fingerprint = ?
         AND profile.content_hash = ?
         AND NOT EXISTS (
           SELECT 1 FROM interview_preparation_profile_revisions newer
           WHERE newer.process_id = profile.process_id
             AND newer.scope_key = profile.scope_key
             AND newer.build_status = 'committed'
             AND newer.revision > profile.revision
         )`,
      [
        snapshot.id,
        snapshot.processId,
        snapshot.version,
        snapshot.profileRevision,
        snapshot.compilerVersion,
        snapshot.playbookRegistryVersion,
        snapshot.runtimeCapabilityVersion,
        snapshot.sourceFingerprint,
        snapshot.contentHash,
        snapshot.runtimeCharCount,
        JSON.stringify(snapshot),
        JSON.stringify(snapshot.sourceManifest),
        JSON.stringify(snapshot.warnings),
        snapshot.createdAt,
        snapshot.profileRevisionId,
        snapshot.roundId,
        snapshot.processId,
        snapshot.profileRevision,
        snapshot.sourceManifest.profile.sourceFingerprint,
        snapshot.sourceManifest.profile.contentHash,
      ]
    );
    if (inserted.rowsAffected === 0) {
      throw new Error("Preparation inputs changed before the snapshot could be stored.");
    }

    try {
      for (const [ordinal, link] of input.statementRevisions.entries()) {
        const linked = await db.execute(
          `INSERT INTO preparation_snapshot_statement_links
            (snapshot_id, statement_id, statement_revision, ordinal)
           SELECT ?, statement.id, statement.revision, ?
           FROM preparation_statements statement
           JOIN preparation_statement_proposal_operations operation
             ON operation.id = statement.proposal_operation_id
           WHERE statement.id = ? AND statement.process_id = ?
             AND statement.revision = ? AND statement.status = 'confirmed'
             AND operation.status = 'committed'
             AND (statement.round_id IS NULL OR statement.round_id = ?)`,
          [
            snapshot.id,
            ordinal,
            link.statementId,
            snapshot.processId,
            link.statementRevision,
            snapshot.roundId,
          ]
        );
        if (linked.rowsAffected === 0) {
          throw new Error("A snapshot statement changed before compilation committed.");
        }
      }

      for (const link of input.narrativeNodeRevisions) {
        const linked = await db.execute(
          `INSERT INTO preparation_snapshot_narrative_node_links
            (snapshot_id, node_id, node_revision, ordinal)
           SELECT ?, node.id, node.revision, ?
           FROM preparation_narrative_nodes node
           JOIN preparation_narrative_graphs graph ON graph.id = node.graph_id
           WHERE node.id = ? AND node.revision = ?
             AND node.review_status = 'confirmed'
             AND graph.process_id = ? AND graph.round_id = ?
             AND graph.profile_revision_id = ?
             AND graph.status = 'current' AND graph.build_status = 'committed'`,
          [
            snapshot.id,
            link.ordinal,
            link.nodeId,
            link.nodeRevision,
            snapshot.processId,
            snapshot.roundId,
            snapshot.profileRevisionId,
          ]
        );
        if (linked.rowsAffected === 0) {
          throw new Error("A narrative node changed before compilation committed.");
        }
      }

      for (const link of input.materialRevisions) {
        const linked = await db.execute(
          `INSERT INTO preparation_snapshot_material_revision_links
            (snapshot_id, material_id, material_revision_id,
             source_checksum_sha256, ordinal)
           SELECT ?, material.id, revision.id, revision.source_checksum_sha256, ?
           FROM preparation_materials material
           JOIN preparation_material_revisions revision
             ON revision.material_id = material.id
           JOIN interview_processes process ON process.workspace_id = material.workspace_id
           WHERE material.id = ? AND process.id = ?
             AND revision.id = ?
             AND revision.source_checksum_sha256 = ?
             AND material.status = 'ready'
             AND (
               (revision.extraction_status = 'ready'
                 AND revision.review_status IN ('unreviewed', 'approved'))
               OR (revision.extraction_status = 'needs-review'
                 AND revision.review_status = 'approved')
             )
             AND material.deleted_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM preparation_material_revisions newer
               WHERE newer.material_id = revision.material_id
                 AND newer.revision > revision.revision
             )`,
          [
            snapshot.id,
            link.ordinal,
            link.materialId,
            snapshot.processId,
            link.materialRevisionId,
            link.sourceChecksumSha256,
          ]
        );
        if (linked.rowsAffected === 0) {
          throw new Error("A material revision changed before compilation committed.");
        }
      }

      for (const link of input.kmbEntries) {
        const linked = await db.execute(
          `INSERT INTO preparation_snapshot_kmb_entry_links
            (snapshot_id, entry_id, content_hash, ordinal)
           SELECT ?, entry.id, ?, ?
           FROM memory_entries entry
           WHERE entry.id = ? AND entry.enabled = 1`,
          [snapshot.id, link.contentHash, link.ordinal, link.entryId]
        );
        if (linked.rowsAffected === 0) {
          throw new Error("A curated memory entry changed before compilation committed.");
        }
      }

      await db.execute(
        `UPDATE interview_preparation_snapshots
         SET build_status = 'committed'
         WHERE id = ? AND build_status = 'staging'`,
        [snapshot.id]
      );
    } catch (error) {
      await db.execute(
        `DELETE FROM interview_preparation_snapshots
         WHERE id = ? AND build_status = 'staging'`,
        [snapshot.id]
      );
      throw error;
    }
  },

  async activate(input) {
    const db = await getDatabase();
    const updated = await db.execute(
      `UPDATE interview_preparation_current_context AS context
       SET process_id = ?, round_id = ?, selected_snapshot_id = ?,
           revision = revision + 1, updated_at = ?
       WHERE context.singleton_id = 1
         AND context.revision = ?
         AND context.selected_snapshot_id IS NOT ?
         AND EXISTS (
           SELECT 1 FROM interview_preparation_snapshots snapshot
           WHERE snapshot.id = ? AND snapshot.process_id = ?
             AND snapshot.round_id = ?
             AND snapshot.content_hash = ?
             AND snapshot.build_status = 'committed'
             AND snapshot.status IN ('ready', 'active', 'superseded')
             AND EXISTS (
               SELECT 1
               FROM interview_processes process
               JOIN preparation_workspaces workspace
                 ON workspace.id = process.workspace_id
               JOIN interview_rounds round ON round.process_id = process.id
               WHERE process.id = snapshot.process_id
                 AND round.id = snapshot.round_id
                 AND workspace.status = 'active'
                 AND round.archived_at IS NULL
             )
             AND EXISTS (
               SELECT 1
               FROM interview_preparation_profile_revisions profile
               WHERE profile.id = snapshot.profile_revision_id
                 AND profile.process_id = snapshot.process_id
                 AND profile.scope_key = snapshot.round_id
                 AND profile.build_status = 'committed'
             )
             AND NOT EXISTS (
               SELECT 1
               FROM preparation_snapshot_statement_links link
               JOIN preparation_statements statement
                 ON statement.id = link.statement_id
               JOIN preparation_statement_proposal_operations operation
                 ON operation.id = statement.proposal_operation_id
               WHERE link.snapshot_id = snapshot.id
                 AND (statement.revision <> link.statement_revision
                   OR statement.status <> 'confirmed'
                   OR operation.status <> 'committed')
             )
             AND NOT EXISTS (
               SELECT 1
               FROM preparation_snapshot_narrative_node_links link
               JOIN preparation_narrative_nodes node ON node.id = link.node_id
               JOIN preparation_narrative_graphs graph ON graph.id = node.graph_id
               WHERE link.snapshot_id = snapshot.id
                 AND (node.revision <> link.node_revision
                   OR node.review_status <> 'confirmed'
                   OR graph.status <> 'current'
                   OR graph.build_status <> 'committed'
                   OR graph.profile_revision_id <> snapshot.profile_revision_id)
             )
             AND NOT EXISTS (
               SELECT 1
               FROM preparation_snapshot_material_revision_links link
               JOIN preparation_materials material ON material.id = link.material_id
               JOIN preparation_material_revisions revision
                 ON revision.id = link.material_revision_id
               WHERE link.snapshot_id = snapshot.id
                 AND (revision.source_checksum_sha256 <>
                       link.source_checksum_sha256
                   OR material.status <> 'ready'
                   OR NOT (
                     (revision.extraction_status = 'ready'
                       AND revision.review_status IN ('unreviewed', 'approved'))
                     OR (revision.extraction_status = 'needs-review'
                       AND revision.review_status = 'approved')
                   )
                   OR material.deleted_at IS NOT NULL
                   OR EXISTS (
                     SELECT 1 FROM preparation_material_revisions newer
                     WHERE newer.material_id = revision.material_id
                       AND newer.revision > revision.revision
                   ))
             )
             AND NOT EXISTS (
               SELECT 1
               FROM preparation_snapshot_kmb_entry_links link
               LEFT JOIN memory_entries entry ON entry.id = link.entry_id
               WHERE link.snapshot_id = snapshot.id
                 AND (entry.id IS NULL OR entry.enabled <> 1)
             )
         )`,
      [
        input.processId,
        input.roundId,
        input.snapshotId,
        input.activatedAt,
        input.expectedContextRevision,
        input.snapshotId,
        input.snapshotId,
        input.processId,
        input.roundId,
        input.expectedContentHash,
      ]
    );
    if (updated.rowsAffected > 0) return true;
    const context = await this.getCurrentContext();
    return (
      context.processId === input.processId &&
      context.roundId === input.roundId &&
      context.selectedSnapshotId === input.snapshotId
    );
  },

  async deactivate(input) {
    const db = await getDatabase();
    const updated = await db.execute(
      `UPDATE interview_preparation_current_context AS context
       SET selected_snapshot_id = NULL, revision = revision + 1, updated_at = ?
       WHERE context.singleton_id = 1
         AND context.revision = ?
         AND context.process_id = ? AND context.round_id = ?
         AND context.selected_snapshot_id = ?
         AND EXISTS (
           SELECT 1
           FROM interview_processes process
           JOIN preparation_workspaces workspace ON workspace.id = process.workspace_id
           JOIN interview_rounds round ON round.process_id = process.id
           WHERE process.id = context.process_id
             AND round.id = context.round_id
             AND workspace.status = 'active' AND round.archived_at IS NULL
         )`,
      [
        input.deactivatedAt,
        input.expectedContextRevision,
        input.processId,
        input.roundId,
        input.snapshotId,
      ]
    );
    if (updated.rowsAffected > 0) return true;
    const context = await this.getCurrentContext();
    return (
      context.processId === input.processId &&
      context.roundId === input.roundId &&
      context.selectedSnapshotId === undefined
    );
  },

  async listActivationEvents(input) {
    const db = await getDatabase();
    const rows = await db.select<ActivationEventRow[]>(
      `SELECT id, process_id, round_id, snapshot_id, previous_snapshot_id,
              action, created_at
       FROM preparation_snapshot_activation_events
       WHERE process_id = ? AND round_id = ?
       ORDER BY created_at DESC, id DESC`,
      [input.processId, input.roundId]
    );
    return rows.map((row) => ({
      id: row.id,
      processId: row.process_id,
      roundId: row.round_id,
      snapshotId: row.snapshot_id,
      previousSnapshotId: row.previous_snapshot_id ?? undefined,
      action: row.action,
      createdAt: row.created_at,
    }));
  },

  async listCurrentContextEvents() {
    const db = await getDatabase();
    const rows = await db.select<CurrentContextEventRow[]>(
      `SELECT id, previous_process_id, previous_round_id,
              previous_snapshot_id, process_id, round_id,
              selected_snapshot_id, action, revision, created_at
       FROM preparation_current_context_events
       ORDER BY created_at DESC, revision DESC
       LIMIT 200`
    );
    return rows.map((row) => ({
      id: row.id,
      previousProcessId: row.previous_process_id ?? undefined,
      previousRoundId: row.previous_round_id ?? undefined,
      previousSnapshotId: row.previous_snapshot_id ?? undefined,
      processId: row.process_id ?? undefined,
      roundId: row.round_id ?? undefined,
      selectedSnapshotId: row.selected_snapshot_id ?? undefined,
      action: row.action,
      revision: row.revision,
      createdAt: row.created_at,
    }));
  },
};

function mapSnapshot(row: SnapshotRow): InterviewPreparationSnapshot {
  const payload = parseSnapshot(row.snapshot_json);
  return ensurePreparationSnapshotArtifactManifest({
    ...payload,
    id: row.id,
    processId: row.process_id,
    roundId: row.round_id,
    version: row.version,
    profileRevisionId: row.profile_revision_id,
    profileRevision: row.profile_revision,
    compilerVersion: row.compiler_version,
    playbookRegistryVersion: row.playbook_registry_version,
    runtimeCapabilityVersion: row.runtime_capability_version,
    sourceFingerprint: row.source_fingerprint,
    contentHash: row.content_hash,
    runtimeCharCount: row.runtime_char_count,
    sourceManifest: JSON.parse(row.source_manifest_json),
    warnings: JSON.parse(row.warnings_json),
    status: row.status,
    createdAt: row.created_at,
    activatedAt: row.activated_at ?? undefined,
  });
}

function parseSnapshot(value: string): InterviewPreparationSnapshot {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Stored preparation snapshot is invalid.");
  }
  return parsed as InterviewPreparationSnapshot;
}

function mapCurrentContext(row: CurrentContextRow | undefined): PreparationCurrentContext {
  return {
    processId: row?.process_id ?? undefined,
    roundId: row?.round_id ?? undefined,
    selectedSnapshotId: row?.selected_snapshot_id ?? undefined,
    revision: row?.revision ?? 0,
    updatedAt: row?.updated_at ?? 0,
  };
}
