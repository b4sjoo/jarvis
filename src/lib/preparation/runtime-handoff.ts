import type { ActiveCallTransition } from "../calling/active-call-runtime.js";
import type {
  PreparedArtifactReceiptStatus,
  PreparedArtifactTarget,
  RuntimePreparationContext,
} from "../calling/types.js";
import {
  encodeJson,
  loadPreparationDatabase,
  type SqlDatabase,
  withTransaction,
} from "./database.js";
import type { CallPreparationSnapshotBundle } from "./types.js";

const TARGET_SECTIONS: Record<PreparedArtifactTarget, string[]> = {
  stt: ["speechBiasTerms"],
  runtime: ["callBrief", "playbookSnapshot"],
  advisor: [
    "caseSnapshot",
    "callBrief",
    "playbookSnapshot",
    "evidenceIndex",
    "safetyConstraints",
  ],
  "post-call": [
    "caseSnapshot",
    "callBrief",
    "evidenceIndex",
    "safetyConstraints",
  ],
};

export function createNeutralRuntimePreparation(input: {
  callSessionId: string;
  boundAt?: number;
}): RuntimePreparationContext {
  return {
    mode: "neutral",
    callSessionId: input.callSessionId,
    boundAt: input.boundAt ?? Date.now(),
  };
}

export function createPreparedRuntimePreparation(input: {
  callSessionId: string;
  snapshot: CallPreparationSnapshotBundle;
  boundAt?: number;
}): RuntimePreparationContext {
  if (input.snapshot.state !== "ready") {
    throw new Error("Only a Ready preparation snapshot can start a call.");
  }
  const artifacts = input.snapshot.artifactManifest.map((artifact) => ({
    artifactId: artifact.artifactId,
    section: artifact.section,
    contentHash: artifact.contentHash,
    sourceRefs: artifact.sourceRefs.map((source) => ({
      sourceKind: source.sourceKind,
      sourceId: source.sourceId,
      contentHash: source.contentHash,
    })),
  }));
  const idsFor = (target: PreparedArtifactTarget) => {
    const sections = TARGET_SECTIONS[target];
    return artifacts
      .filter((artifact) => sections.includes(artifact.section))
      .map((artifact) => artifact.artifactId);
  };
  return {
    mode: "prepared",
    callSessionId: input.callSessionId,
    boundAt: input.boundAt ?? Date.now(),
    caseId: input.snapshot.caseId,
    caseRevisionId: input.snapshot.caseRevisionId,
    callPlanId: input.snapshot.callPlanId,
    snapshotId: input.snapshot.id,
    snapshotContentHash: input.snapshot.contentHash,
    artifacts,
    artifactIdsByTarget: {
      stt: idsFor("stt"),
      runtime: idsFor("runtime"),
      advisor: idsFor("advisor"),
      "post-call": idsFor("post-call"),
    },
    stt: {
      speechBiasTerms: input.snapshot.speechBiasTerms.map((item) => item.term),
    },
    runtime: {
      objective: input.snapshot.callBrief.objective,
      acceptableOutcomes: input.snapshot.callBrief.acceptableOutcomes,
      questionsToAsk: input.snapshot.callBrief.questionsToAsk,
      knownRisks: input.snapshot.callBrief.knownRisks,
      stages: input.snapshot.playbookSnapshot.stages,
      fallbackMoves: input.snapshot.playbookSnapshot.fallbackMoves,
    },
    advisor: {
      callBrief: input.snapshot.callBrief,
      caseSnapshot: input.snapshot.caseSnapshot,
      playbook: input.snapshot.playbookSnapshot,
      evidenceIndex: input.snapshot.evidenceIndex,
      safetyConstraints: input.snapshot.safetyConstraints,
    },
    postCall: {
      callBrief: input.snapshot.callBrief,
      caseSnapshot: input.snapshot.caseSnapshot,
      evidenceIndex: input.snapshot.evidenceIndex,
      safetyConstraints: input.snapshot.safetyConstraints,
    },
  };
}

export interface SnapshotArtifactReceiptInput {
  preparation: RuntimePreparationContext;
  target: PreparedArtifactTarget;
  status: PreparedArtifactReceiptStatus;
  operationId: string;
  reason?: string;
  occurredAt?: number;
}

export class RuntimeHandoffService {
  #tail: Promise<void> = Promise.resolve();
  #lastError: unknown;

  constructor(private readonly database: SqlDatabase) {}

  static async open() {
    return new RuntimeHandoffService(await loadPreparationDatabase());
  }

  async bind(preparation: RuntimePreparationContext) {
    const startedAt = Date.now();
    await withTransaction(this.database, async () => {
      await this.database.execute(
        `INSERT INTO call_runtime_sessions (
          id, state, runtime_epoch, logical_revision, created_at, updated_at
        ) VALUES (?, 'planned', 0, 0, ?, ?)
        ON CONFLICT(id) DO NOTHING`,
        [preparation.callSessionId, preparation.boundAt, preparation.boundAt]
      );
      if (preparation.mode === "prepared") {
        const rows = await this.database.select<Array<{
          state: string;
          content_hash: string;
          case_revision_id: string;
          call_plan_id: string;
        }>>(
          `SELECT state, content_hash, case_revision_id, call_plan_id
           FROM call_preparation_snapshots WHERE id = ? AND case_id = ?`,
          [preparation.snapshotId, preparation.caseId]
        );
        const snapshot = rows[0];
        if (
          !snapshot ||
          snapshot.state !== "ready" ||
          snapshot.content_hash !== preparation.snapshotContentHash ||
          snapshot.case_revision_id !== preparation.caseRevisionId ||
          snapshot.call_plan_id !== preparation.callPlanId
        ) {
          throw new Error("Ready snapshot changed before CallSession binding.");
        }
      }
      const existing = await this.database.select<Array<{
        mode: string;
        snapshot_id: string | null;
        snapshot_content_hash: string | null;
      }>>(
        "SELECT mode, snapshot_id, snapshot_content_hash FROM call_session_preparation_bindings WHERE call_session_id = ?",
        [preparation.callSessionId]
      );
      if (existing[0]) {
        const same = existing[0].mode === preparation.mode &&
          existing[0].snapshot_id === (preparation.mode === "prepared" ? preparation.snapshotId : null) &&
          existing[0].snapshot_content_hash === (preparation.mode === "prepared" ? preparation.snapshotContentHash : null);
        if (!same) throw new Error("CallSession already has another preparation binding.");
        return;
      }
      await this.database.execute(
        `INSERT INTO call_session_preparation_bindings (
          call_session_id, case_id, case_revision_id, call_plan_id, snapshot_id,
          snapshot_content_hash, mode, bound_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        preparation.mode === "prepared"
          ? [
              preparation.callSessionId,
              preparation.caseId,
              preparation.caseRevisionId,
              preparation.callPlanId,
              preparation.snapshotId,
              preparation.snapshotContentHash,
              preparation.mode,
              preparation.boundAt,
            ]
          : [preparation.callSessionId, null, null, null, null, null, preparation.mode, preparation.boundAt]
      );
      if (preparation.mode === "prepared") {
        await this.database.execute(
          `INSERT INTO preparation_operation_events (
            id, case_id, call_plan_id, operation_id, operation_kind, status, payload_json, occurred_at
          ) VALUES (?, ?, ?, ?, 'call-session-binding', 'committed', ?, ?)`,
          [
            `preparation_event_${crypto.randomUUID()}`,
            preparation.caseId,
            preparation.callPlanId,
            preparation.callSessionId,
            encodeJson({
              snapshotId: preparation.snapshotId,
              snapshotContentHash: preparation.snapshotContentHash,
              durationMs: Date.now() - startedAt,
            }),
            Date.now(),
          ]
        );
      }
    });
  }

  recordTransition(transition: ActiveCallTransition) {
    this.enqueue(async () => {
      const sequenceRows = await this.database.select<Array<{ next_sequence: number }>>(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM call_runtime_events WHERE call_session_id = ?",
        [transition.after.callSessionId]
      );
      await withTransaction(this.database, async () => {
        await this.database.execute(
          `INSERT INTO call_runtime_events (
            id, call_session_id, sequence, event_kind, payload_json, occurred_at
          ) VALUES (?, ?, ?, 'runtime-command', ?, ?)`,
          [
            `runtime_event_${crypto.randomUUID()}`,
            transition.after.callSessionId,
            sequenceRows[0]?.next_sequence ?? 1,
            encodeJson({
              command: transition.command,
              before: {
                state: transition.before.state,
                runtimeEpoch: transition.before.runtimeEpoch,
                evidenceRevision: transition.before.evidenceRevision,
                logicalRevision: transition.before.logicalRevision,
                guidanceRevision: transition.before.guidanceRevision,
              },
              after: {
                state: transition.after.state,
                runtimeEpoch: transition.after.runtimeEpoch,
                evidenceRevision: transition.after.evidenceRevision,
                logicalRevision: transition.after.logicalRevision,
                guidanceRevision: transition.after.guidanceRevision,
              },
            }),
            transition.after.updatedAt,
          ]
        );
        await this.database.execute(
          `UPDATE call_runtime_sessions SET state = ?, runtime_epoch = ?, logical_revision = ?,
           started_at = COALESCE(started_at, ?), closed_at = ?, updated_at = ? WHERE id = ?`,
          [
            transition.after.state,
            transition.after.runtimeEpoch,
            transition.after.logicalRevision,
            transition.command.type === "StartCall" ? transition.after.updatedAt : null,
            transition.after.state === "closed" ? transition.after.updatedAt : null,
            transition.after.updatedAt,
            transition.after.callSessionId,
          ]
        );
      });
    });
  }

  recordArtifactReceipt(input: SnapshotArtifactReceiptInput) {
    if (input.preparation.mode !== "prepared") return;
    const preparation = input.preparation;
    const artifactIds = preparation.artifactIdsByTarget[input.target];
    if (!artifactIds.length) return;
    const occurredAt = input.occurredAt ?? Date.now();
    this.enqueue(async () => {
      await withTransaction(this.database, async () => {
        for (const artifactId of artifactIds) {
          await this.database.execute(
            `INSERT INTO snapshot_artifact_receipts (
              id, call_session_id, snapshot_id, artifact_id, operation_id,
              target, status, reason, occurred_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              `snapshot_receipt_${crypto.randomUUID()}`,
              preparation.callSessionId,
              preparation.snapshotId,
              artifactId,
              input.operationId,
              input.target,
              input.status,
              input.reason ?? null,
              occurredAt,
            ]
          );
        }
      });
    });
  }

  async drain() {
    await this.#tail;
    if (this.#lastError) {
      const error = this.#lastError;
      this.#lastError = undefined;
      throw error;
    }
  }

  private enqueue(operation: () => Promise<void>) {
    this.#tail = this.#tail
      .catch(() => undefined)
      .then(operation)
      .catch((error) => {
        this.#lastError = error;
      });
    return this.#tail;
  }
}
