import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CasePrivacyService,
  CROSS_CASE_ISOLATION_QUERIES,
  PreparationEvaluationService,
  summarizeOperationMetrics,
  type SqlDatabase,
  type CasePrivacyNativeTransport,
} from "../src/lib/preparation/index.js";

class EvaluationDatabase implements SqlDatabase {
  readonly selected: Array<{ query: string; values: unknown[] }> = [];
  readonly executed: Array<{ query: string; values: unknown[] }> = [];
  visible = true;

  async select<T>(query: string, values: unknown[] = []): Promise<T> {
    this.selected.push({ query, values });
    if (query.includes("receipt.status = 'visible' LIMIT 1")) {
      return (this.visible ? [{ snapshot_id: "snapshot-a" }] : []) as T;
    }
    if (query.includes("COUNT(*) AS count")) return [{ count: 0 }] as T;
    return [] as T;
  }

  async execute(query: string, values: unknown[] = []) {
    this.executed.push({ query, values });
    return { rowsAffected: 1 };
  }
}

test("Task 1J compacts per-operation latency and context baselines", () => {
  const metrics = summarizeOperationMetrics([
    {
      id: "event-1",
      operation_id: "operation-1",
      operation_kind: "preparation-conversation",
      status: "dispatched",
      payload_json: JSON.stringify({ userPrompt: "x".repeat(120) }),
      occurred_at: 100,
    },
    {
      id: "event-2",
      operation_id: "operation-1",
      operation_kind: "preparation-conversation",
      status: "committed",
      payload_json: JSON.stringify({ durationMs: 950, responseChars: 42 }),
      occurred_at: 1_100,
    },
    {
      id: "event-3",
      operation_id: "operation-2",
      operation_kind: "preparation-conversation",
      status: "failed",
      payload_json: "{}",
      occurred_at: 2_000,
    },
  ]);
  assert.equal(metrics[0].operationCount, 2);
  assert.equal(metrics[0].failedCount, 1);
  assert.equal(metrics[0].p50DurationMs, 950);
  assert.equal(metrics[0].averageContextChars, 120);
  assert.equal(metrics[0].averageResponseChars, 42);
});

test("Task 1J evaluates only snapshot artifacts that reached visible guidance", async () => {
  const database = new EvaluationDatabase();
  const service = new PreparationEvaluationService(database);
  const usageId = service.artifactUsageId("artifact-a", "call-a", "advisor");
  const evaluation = await service.recordEvaluation({
    caseId: "case-a",
    subjectKind: "snapshot-artifact",
    subjectId: usageId,
    label: "helpful",
  });
  assert.equal(evaluation.snapshotId, "snapshot-a");
  assert.equal(evaluation.callSessionId, "call-a");
  assert.ok(database.executed.some((entry) => entry.query.includes("preparation_human_evaluations")));

  database.visible = false;
  await assert.rejects(
    () => service.recordEvaluation({
      caseId: "case-a",
      subjectKind: "snapshot-artifact",
      subjectId: usageId,
      label: "irrelevant",
    }),
    /Only a visible snapshot artifact/
  );
  await assert.rejects(
    () => service.recordEvaluation({
      caseId: "case-a",
      subjectKind: "snapshot-artifact",
      subjectId: usageId,
      label: "complete",
    }),
    /not valid/
  );
});

test("Task 1J runs every isolation audit inside one explicit Case scope", async () => {
  const database = new EvaluationDatabase();
  const findings = await new PreparationEvaluationService(database)
    .runCrossCaseIsolationAudit("case-a");
  assert.equal(findings.length, CROSS_CASE_ISOLATION_QUERIES.length);
  assert.ok(findings.every((finding) => finding.count === 0));
  assert.equal(database.selected.length, CROSS_CASE_ISOLATION_QUERIES.length);
  assert.ok(database.selected.every((entry) => entry.values.length === 1 && entry.values[0] === "case-a"));
});

test("Task 1J migration hardens evaluation, cross-Case scope, and recoverable deletion", () => {
  const migration = readFileSync(
    "src-tauri/src/db/migrations/moss-case-hardening.sql",
    "utf8"
  );
  for (const label of [
    "complete", "partial", "wrong", "unreadable", "helpful", "irrelevant",
    "missing", "polluting", "correct", "needs-edit", "unsupported", "duplicate",
    "over-constraining", "missed", "wrong-party", "wrong-condition", "wrong-date",
  ]) {
    assert.match(migration, new RegExp(`'${label}'`));
  }
  assert.match(migration, /case_deletion_operations/);
  assert.match(migration, /case_privacy_audits/);
  assert.match(migration, /trg_prepared_binding_scope_insert/);
  assert.match(migration, /trg_artifact_receipt_snapshot_scope_insert/);
  assert.match(migration, /deletion_state IN \('active', 'deleting'\)/);
});

test("Task 1J deletion stages files before database removal and preserves a durable receipt", () => {
  const privacy = readFileSync("src/lib/preparation/privacy-service.ts", "utf8");
  const native = readFileSync("src-tauri/src/case_privacy.rs", "utf8");
  const stage = privacy.indexOf("this.native.stageDeletion");
  const databaseDelete = privacy.indexOf('"DELETE FROM cases WHERE id = ? AND deletion_state = \'deleting\'"');
  const finalize = privacy.indexOf("this.native.finalizeDeletion");
  assert.ok(stage > -1 && databaseDelete > stage && finalize > databaseDelete);
  assert.match(privacy, /restore_case_deletion/);
  assert.match(privacy, /state = 'db-deleted'/);
  assert.doesNotMatch(privacy, /ai_providers|stt_providers|keychain/i);
  assert.match(privacy, /providerSecretsIncluded: false/);
  assert.match(privacy, /exportCase\(caseId: string, includeAudio = false\)/);
  assert.match(privacy, /rawAudioIncluded: includeAudio/);
  assert.match(native, /reject_symlink/);
});

test("Task 1J deletion workflow commits database removal only between native stage and finalize", async () => {
  const order: string[] = [];
  class PrivacyDatabase implements SqlDatabase {
    async select<T>(query: string): Promise<T> {
      if (query.includes("SELECT deletion_state FROM cases")) return [{ deletion_state: "active" }] as T;
      if (query.includes("FROM call_runtime_sessions session")) return [{ id: "call-a", state: "closed" }] as T;
      return [] as T;
    }

    async execute(query: string) {
      if (query.includes("DELETE FROM cases")) order.push("database-delete");
      return { rowsAffected: 1 };
    }
  }
  const native: CasePrivacyNativeTransport = {
    exportCase: async () => ({ path: "unused", fileCount: 0, sourceBytes: 0, checksumSha256: "hash" }),
    stageDeletion: async () => {
      order.push("native-stage");
      return { operationId: "delete-a", stagedContent: true, stagedRecordingCount: 1 };
    },
    restoreDeletion: async () => undefined,
    finalizeDeletion: async () => { order.push("native-finalize"); },
  };
  const result = await new CasePrivacyService(new PrivacyDatabase(), native).deleteCase("case-a");
  assert.deepEqual(order, ["native-stage", "database-delete", "native-finalize"]);
  assert.equal(result.deletedSessionCount, 1);
  assert.equal(result.stagedFileGroupCount, 2);
});

test("Task 1J exposes one dashboard for trace, attribution, isolation, export, and delete", () => {
  const page = readFileSync("src/pages/cases/EvaluationPanel.tsx", "utf8");
  const evaluation = readFileSync("src/lib/preparation/evaluation-service.ts", "utf8");
  const route = readFileSync("src/pages/cases/index.tsx", "utf8");
  assert.match(page, /First validation domain readiness/);
  assert.match(page, /Only `visible` receipts are eligible for attribution/);
  assert.match(page, /exportCase\(caseId, includeAudio\)/);
  assert.match(page, /exportCase\(false\)/);
  assert.match(page, /exportCase\(true\)/);
  assert.match(page, /deleteCase\(caseId\)/);
  assert.match(evaluation, /case-privacy:\$\{row\.action\}/);
  assert.match(evaluation, /FROM case_privacy_audits WHERE case_id_hash = \?/);
  assert.match(route, /id: "evaluation", label: "Evaluation"/);
});

test("Task 1J preparation transactions keep native connection affinity", () => {
  const database = readFileSync("src/lib/preparation/database.ts", "utf8");
  const native = readFileSync("src-tauri/src/preparation_transaction.rs", "utf8");
  const serviceSources = [
    "case-service.ts",
    "conversation-service.ts",
    "material-service.ts",
    "post-call-service.ts",
    "privacy-service.ts",
    "runtime-handoff.ts",
    "snapshot-service.ts",
    "statement-service.ts",
  ].map((file) => readFileSync(`src/lib/preparation/${file}`, "utf8")).join("\n");
  assert.match(database, /begin_preparation_transaction/);
  assert.match(database, /new NativeTransactionDatabase\(transactionId\)/);
  assert.match(database, /withWriteOwnership/);
  assert.match(native, /HashMap<String, SqliteConnection>/);
  assert.match(native, /BEGIN IMMEDIATE/);
  assert.match(native, /finish_transaction\(&transaction_id, "COMMIT"/);
  assert.doesNotMatch(serviceSources, /withTransaction\(this\.database, async \(\) =>/);
  assert.equal(
    serviceSources.match(/withTransaction\(this\.database, async \(transaction\)/g)?.length,
    24
  );
});
