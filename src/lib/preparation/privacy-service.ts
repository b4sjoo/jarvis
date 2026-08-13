import { invoke } from "@tauri-apps/api/core";
import { sha256 } from "../calling/index.js";
import {
  encodeJson,
  loadPreparationDatabase,
  type SqlDatabase,
  withTransaction,
} from "./database.js";
import { PreparationConversationService } from "./conversation-service.js";

export interface CaseExportResult {
  path: string;
  fileCount: number;
  sourceBytes: number;
  checksumSha256: string;
}

export interface CaseDeletionResult {
  operationId: string;
  deletedSessionCount: number;
  stagedFileGroupCount: number;
}

interface LinkedSessionRow {
  id: string;
  state: string;
}

interface DeletionOperationRow {
  operation_id: string;
  case_id: string;
  case_id_hash: string;
  linked_session_ids_json: string;
  state:
    | "prepared"
    | "staged"
    | "db-deleted"
    | "restore-failed"
    | "finalize-failed"
    | "restored"
    | "complete";
}

interface NativeStageResult {
  operationId: string;
  stagedContent: boolean;
  stagedRecordingCount: number;
  stagedAudioCount: number;
}

export interface CasePrivacyNativeTransport {
  exportCase(input: {
    caseId: string;
    metadataJson: string;
    callSessionIds: string[];
    includeAudio: boolean;
  }): Promise<CaseExportResult>;
  stageDeletion(input: {
    operationId: string;
    caseId: string;
    callSessionIds: string[];
  }): Promise<NativeStageResult>;
  restoreDeletion(operationId: string): Promise<unknown>;
  finalizeDeletion(operationId: string): Promise<unknown>;
}

const nativeTransport: CasePrivacyNativeTransport = {
  exportCase: (input) => invoke<CaseExportResult>("export_case_bundle", input),
  stageDeletion: (input) => invoke<NativeStageResult>("stage_case_deletion", input),
  restoreDeletion: (operationId) => invoke("restore_case_deletion", { operationId }),
  finalizeDeletion: (operationId) => invoke("finalize_case_deletion", { operationId }),
};

const EXPORT_QUERIES = [
  ["caseRevisions", "SELECT * FROM case_revisions WHERE case_id = ? ORDER BY revision"],
  ["parties", "SELECT * FROM case_parties WHERE case_id = ? ORDER BY created_at"],
  ["callPlans", "SELECT * FROM call_plans WHERE case_id = ? ORDER BY created_at"],
  ["materials", "SELECT * FROM case_materials WHERE case_id = ? ORDER BY created_at"],
  ["extractionRuns", `SELECT run.* FROM extraction_runs run
    JOIN case_materials material ON material.id = run.material_id
    WHERE material.case_id = ? ORDER BY run.created_at`],
  ["extractionChunks", `SELECT chunk.* FROM extraction_chunks chunk
    JOIN extraction_runs run ON run.id = chunk.extraction_run_id
    JOIN case_materials material ON material.id = run.material_id
    WHERE material.case_id = ? ORDER BY run.created_at, chunk.ordinal`],
  ["statements", "SELECT * FROM case_statements WHERE case_id = ? ORDER BY created_at"],
  ["statementSources", `SELECT source.* FROM case_statement_sources source
    JOIN case_statements statement ON statement.id = source.statement_id
    WHERE statement.case_id = ? ORDER BY source.created_at`],
  ["conversations", "SELECT * FROM preparation_conversations WHERE case_id = ? ORDER BY created_at"],
  ["messages", `SELECT message.* FROM preparation_messages message
    JOIN preparation_conversations conversation ON conversation.id = message.conversation_id
    WHERE conversation.case_id = ? ORDER BY conversation.created_at, message.revision`],
  ["snapshots", "SELECT * FROM call_preparation_snapshots WHERE case_id = ? ORDER BY compiled_at"],
  ["snapshotArtifacts", `SELECT artifact.* FROM snapshot_artifacts artifact
    JOIN call_preparation_snapshots snapshot ON snapshot.id = artifact.snapshot_id
    WHERE snapshot.case_id = ? ORDER BY artifact.created_at`],
  ["preparationBindings", `SELECT binding.* FROM call_session_preparation_bindings binding
    WHERE binding.case_id = ? ORDER BY binding.bound_at`],
  ["artifactReceipts", `SELECT receipt.* FROM snapshot_artifact_receipts receipt
    JOIN call_session_preparation_bindings binding ON binding.call_session_id = receipt.call_session_id
    WHERE binding.case_id = ? ORDER BY receipt.occurred_at`],
  ["runtimeSessions", `SELECT session.* FROM call_runtime_sessions session
    JOIN call_session_preparation_bindings binding ON binding.call_session_id = session.id
    WHERE binding.case_id = ? ORDER BY session.created_at`],
  ["runtimeEvents", `SELECT event.* FROM call_runtime_events event
    JOIN call_session_preparation_bindings binding ON binding.call_session_id = event.call_session_id
    WHERE binding.case_id = ? ORDER BY event.call_session_id, event.sequence`],
  ["recordingCloseAttempts", `SELECT attempt.* FROM call_recording_close_attempts attempt
    JOIN call_session_preparation_bindings binding ON binding.call_session_id = attempt.call_session_id
    WHERE binding.case_id = ? ORDER BY attempt.call_session_id, attempt.attempt`],
  ["pendingCaseUpdates", "SELECT * FROM pending_case_updates WHERE case_id = ? ORDER BY created_at"],
  ["operationEvents", "SELECT * FROM preparation_operation_events WHERE case_id = ? ORDER BY occurred_at"],
  ["humanEvaluations", "SELECT * FROM preparation_human_evaluations WHERE case_id = ? ORDER BY occurred_at"],
] as const;

export class CasePrivacyService {
  constructor(
    private readonly database: SqlDatabase,
    private readonly native: CasePrivacyNativeTransport = nativeTransport
  ) {}

  static async open() {
    const service = new CasePrivacyService(await loadPreparationDatabase());
    await service.recoverPendingDeletions();
    return service;
  }

  async exportCase(caseId: string, includeAudio = false): Promise<CaseExportResult> {
    const caseRows = await this.database.select<Record<string, unknown>[]>(
      "SELECT * FROM cases WHERE id = ?",
      [caseId]
    );
    if (!caseRows[0]) throw new Error("Case was not found.");
    const operationId = `case_export_${crypto.randomUUID()}`;
    const caseIdHash = await sha256(caseId);
    await this.writeAudit(caseIdHash, operationId, "export", "started", {});
    try {
      const linkedSessions = await this.listLinkedSessions(caseId);
      const tables: Record<string, Record<string, unknown>[]> = {};
      for (const [name, query] of EXPORT_QUERIES) {
        tables[name] = await this.database.select<Record<string, unknown>[]>(query, [caseId]);
      }
      tables.privacyAudits = await this.database.select<Record<string, unknown>[]>(
        "SELECT * FROM case_privacy_audits WHERE case_id_hash = ? ORDER BY occurred_at",
        [caseIdHash]
      );
      tables.deletionReceipts = await this.database.select<Record<string, unknown>[]>(
        `SELECT operation_id, case_id_hash, state, error, created_at, updated_at
         FROM case_deletion_operations WHERE case_id_hash = ? ORDER BY created_at`,
        [caseIdHash]
      );
      const metadata = {
        schemaVersion: 1,
        exportedAt: Date.now(),
        caseIdHash,
        case: caseRows[0],
        tables,
        privacy: {
          rawAudioIncluded: includeAudio,
          providerSecretsIncluded: false,
          materialBase64Included: false,
        },
      };
      const result = await this.native.exportCase({
        caseId,
        metadataJson: JSON.stringify(metadata),
        callSessionIds: linkedSessions.map((session) => session.id),
        includeAudio,
      });
      const itemCounts = Object.fromEntries(
        Object.entries(tables).map(([name, rows]) => [name, rows.length])
      );
      await this.writeAudit(caseIdHash, operationId, "export", "complete", {
        ...itemCounts,
        exportedFiles: result.fileCount,
        rawAudioIncluded: includeAudio,
      });
      return result;
    } catch (error) {
      await this.writeAudit(caseIdHash, operationId, "export", "failed", {});
      throw error;
    }
  }

  async deleteCase(caseId: string): Promise<CaseDeletionResult> {
    const caseRows = await this.database.select<Array<{ deletion_state: string }>>(
      "SELECT deletion_state FROM cases WHERE id = ?",
      [caseId]
    );
    if (!caseRows[0]) throw new Error("Case was not found.");
    if (caseRows[0].deletion_state === "deleting") {
      throw new Error("Case deletion is already in progress.");
    }
    const sessions = await this.listLinkedSessions(caseId);
    const unresolved = sessions.filter(
      (session) => !["closed", "abandoned", "start-failed"].includes(session.state)
    );
    if (unresolved.length) {
      throw new Error("Close or abandon every linked CallSession before deleting this Case.");
    }
    await this.cancelCaseConversationGenerations(caseId);
    const operationId = `case_delete_${crypto.randomUUID()}`;
    const caseIdHash = await sha256(caseId);
    const sessionIds = sessions.map((session) => session.id);
    const now = Date.now();
    await withTransaction(this.database, async (transaction) => {
      const marked = await transaction.execute(
        "UPDATE cases SET deletion_state = 'deleting', updated_at = ? WHERE id = ? AND deletion_state = 'active'",
        [now, caseId]
      );
      if (marked.rowsAffected !== 1) throw new Error("Case deletion ownership changed.");
      await transaction.execute(
        `INSERT INTO case_deletion_operations (
          operation_id, case_id, case_id_hash, linked_session_ids_json,
          state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'prepared', ?, ?)`,
        [operationId, caseId, caseIdHash, encodeJson(sessionIds), now, now]
      );
      await this.writeAudit(
        caseIdHash,
        operationId,
        "delete",
        "started",
        { linkedSessions: sessionIds.length },
        transaction
      );
    });

    let staged: NativeStageResult;
    try {
      staged = await this.native.stageDeletion({
        operationId,
        caseId,
        callSessionIds: sessionIds,
      });
      await this.database.execute(
        "UPDATE case_deletion_operations SET state = 'staged', updated_at = ? WHERE operation_id = ? AND state = 'prepared'",
        [Date.now(), operationId]
      );
    } catch (error) {
      await this.restoreFailedDeletion({ operationId, caseId, caseIdHash }, error);
      throw error;
    }

    try {
      await withTransaction(this.database, async (transaction) => {
        for (const sessionId of sessionIds) {
          await transaction.execute("DELETE FROM call_runtime_sessions WHERE id = ?", [sessionId]);
        }
        const deleted = await transaction.execute(
          "DELETE FROM cases WHERE id = ? AND deletion_state = 'deleting'",
          [caseId]
        );
        if (deleted.rowsAffected !== 1) throw new Error("Case deletion lost database ownership.");
        const marked = await transaction.execute(
          "UPDATE case_deletion_operations SET state = 'db-deleted', updated_at = ? WHERE operation_id = ? AND state = 'staged'",
          [Date.now(), operationId]
        );
        if (marked.rowsAffected !== 1) throw new Error("Case deletion receipt changed before commit.");
      });
    } catch (error) {
      await this.restoreFailedDeletion({ operationId, caseId, caseIdHash }, error);
      throw error;
    }

    try {
      await this.native.finalizeDeletion(operationId);
      await this.database.execute(
        `UPDATE case_deletion_operations SET state = 'complete', case_id = case_id_hash,
         linked_session_ids_json = '[]', error = NULL, updated_at = ?
         WHERE operation_id = ? AND state = 'db-deleted'`,
        [Date.now(), operationId]
      );
      await this.writeAudit(caseIdHash, operationId, "delete", "complete", {
        linkedSessions: sessionIds.length,
        stagedContentGroups: staged.stagedContent ? 1 : 0,
        stagedRecordings: staged.stagedRecordingCount,
        stagedAudioRecordings: staged.stagedAudioCount,
      });
      return {
        operationId,
        deletedSessionCount: sessionIds.length,
        stagedFileGroupCount:
          (staged.stagedContent ? 1 : 0) +
          staged.stagedRecordingCount +
          staged.stagedAudioCount,
      };
    } catch (error) {
      await this.database.execute(
        `UPDATE case_deletion_operations SET state = 'finalize-failed',
         error = ?, updated_at = ? WHERE operation_id = ? AND state = 'db-deleted'`,
        [this.errorMessage(error), Date.now(), operationId]
      );
      await this.writeAudit(caseIdHash, operationId, "delete", "failed", {
        databaseDeleted: true,
      });
      throw new Error("Case data was removed from the database, but file cleanup must recover on next launch.");
    }
  }

  async recoverPendingDeletions() {
    const operations = await this.database.select<DeletionOperationRow[]>(
      `SELECT operation_id, case_id, case_id_hash, linked_session_ids_json, state
       FROM case_deletion_operations
       WHERE state NOT IN ('restored', 'complete')
       ORDER BY created_at`
    );
    const recovered: string[] = [];
    for (const operation of operations) {
      try {
        const caseRows = await this.database.select<Array<{ id: string }>>(
          "SELECT id FROM cases WHERE id = ?",
          [operation.case_id]
        );
        if (
          operation.state === "db-deleted" ||
          operation.state === "finalize-failed" ||
          !caseRows[0]
        ) {
          await this.native.finalizeDeletion(operation.operation_id);
          await this.database.execute(
            `UPDATE case_deletion_operations SET state = 'complete', case_id = case_id_hash,
             linked_session_ids_json = '[]', error = NULL, updated_at = ?
             WHERE operation_id = ?`,
            [Date.now(), operation.operation_id]
          );
        } else {
          await this.native.restoreDeletion(operation.operation_id);
          await withTransaction(this.database, async (transaction) => {
            await transaction.execute(
              "UPDATE cases SET deletion_state = 'active', updated_at = ? WHERE id = ? AND deletion_state = 'deleting'",
              [Date.now(), operation.case_id]
            );
            await transaction.execute(
              `UPDATE case_deletion_operations SET state = 'restored', error = ?,
               updated_at = ? WHERE operation_id = ?`,
              ["Recovered before database deletion completed.", Date.now(), operation.operation_id]
            );
          });
        }
        await this.writeAudit(
          operation.case_id_hash,
          operation.operation_id,
          "recovery",
          "complete",
          { priorState: operation.state }
        );
        recovered.push(operation.operation_id);
      } catch (error) {
        const caseRows = await this.database.select<Array<{ id: string }>>(
          "SELECT id FROM cases WHERE id = ?",
          [operation.case_id]
        ).catch(() => []);
        await this.database.execute(
          `UPDATE case_deletion_operations SET state = ?, error = ?, updated_at = ?
           WHERE operation_id = ?`,
          [
            caseRows[0] ? "restore-failed" : "finalize-failed",
            this.errorMessage(error),
            Date.now(),
            operation.operation_id,
          ]
        ).catch(() => undefined);
        await this.writeAudit(
          operation.case_id_hash,
          operation.operation_id,
          "recovery",
          "failed",
          { priorState: operation.state }
        ).catch(() => undefined);
      }
    }
    return recovered;
  }

  private async listLinkedSessions(caseId: string) {
    return this.database.select<LinkedSessionRow[]>(
      `SELECT session.id, session.state FROM call_runtime_sessions session
       JOIN call_session_preparation_bindings binding ON binding.call_session_id = session.id
       WHERE binding.case_id = ? ORDER BY session.created_at`,
      [caseId]
    );
  }

  private async cancelCaseConversationGenerations(caseId: string) {
    const rows = await this.database.select<Array<{ id: string }>>(
      "SELECT id FROM preparation_conversations WHERE case_id = ?",
      [caseId]
    );
    const service = new PreparationConversationService(this.database);
    for (const row of rows) service.cancel(row.id, "case-deletion");
  }

  private async restoreFailedDeletion(
    input: { operationId: string; caseId: string; caseIdHash: string },
    originalError: unknown
  ) {
    try {
      await this.native.restoreDeletion(input.operationId);
      await withTransaction(this.database, async (transaction) => {
        await transaction.execute(
          `UPDATE cases SET deletion_state = 'active', updated_at = ?
           WHERE id = ? AND deletion_state = 'deleting'`,
          [Date.now(), input.caseId]
        );
        await transaction.execute(
          `UPDATE case_deletion_operations SET state = 'restored', error = ?,
           updated_at = ? WHERE operation_id = ?`,
          [this.errorMessage(originalError), Date.now(), input.operationId]
        );
      });
    } catch (restoreError) {
      await this.database.execute(
        `UPDATE case_deletion_operations SET state = 'restore-failed',
         error = ?, updated_at = ? WHERE operation_id = ?`,
        [this.errorMessage(restoreError), Date.now(), input.operationId]
      ).catch(() => undefined);
    }
    await this.writeAudit(
      input.caseIdHash,
      input.operationId,
      "delete",
      "failed",
      {}
    ).catch(() => undefined);
  }

  private async writeAudit(
    caseIdHash: string,
    operationId: string,
    action: "export" | "delete" | "recovery",
    status: "started" | "complete" | "failed",
    itemCounts: Record<string, unknown>,
    database: SqlDatabase = this.database
  ) {
    await database.execute(
      `INSERT INTO case_privacy_audits (
        id, case_id_hash, operation_id, action, status, item_counts_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        `privacy_audit_${crypto.randomUUID()}`,
        caseIdHash,
        operationId,
        action,
        status,
        encodeJson(itemCounts),
        Date.now(),
      ]
    );
  }

  private errorMessage(error: unknown) {
    return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
  }
}
