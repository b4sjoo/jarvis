import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256 } from "../src/lib/calling/index.js";
import {
  inspectStatementSourceAuthority,
  parseCommitmentDetail,
  parseDeadlineDetail,
  parseSnapshotModelProposal,
  requireStructuredStatementDetails,
  type SqlDatabase,
} from "../src/lib/preparation/index.js";

const read = (path: string) => readFileSync(path, "utf8");

test("Task 1 P0 preserves applied migration 4 and moves later deletion work to migration 5", () => {
  const migration4 = read("src-tauri/src/db/migrations/moss-case-authority-closure.sql");
  const migration5 = read("src-tauri/src/db/migrations/moss-case-deletion-recovery.sql");
  const registry = read("src-tauri/src/db/main.rs");
  assert.equal(
    createHash("sha384").update(migration4).digest("hex"),
    "4bfa7b72397bf831e22ced78555b84b4a9f47a0f4785b942b43e0ac628597e87d4a36ccd6f2ae68b915bafaa44d4f7dc"
  );
  assert.match(migration4, /source_status TEXT NOT NULL DEFAULT 'current'/);
  assert.match(migration4, /CREATE TABLE case_statement_events/);
  assert.match(migration4, /commitment_detail_json/);
  assert.match(migration4, /deadline_detail_json/);
  assert.match(migration4, /item_refs_json TEXT NOT NULL DEFAULT '\[\]'/);
  assert.match(migration4, /CREATE TABLE material_deletion_operations/);
  assert.doesNotMatch(migration4, /RENAME TO case_deletion_operations_v1/);
  assert.match(migration5, /RENAME TO case_deletion_operations_v1/);
  assert.match(migration5, /'restore-failed'/);
  assert.match(migration5, /'finalize-failed'/);
  assert.match(migration5, /WHEN state = 'failed' THEN 'restore-failed'/);
  assert.match(registry, /moss-case-authority-closure\.sql/);
  assert.match(registry, /version:\s*5[\s\S]*moss-case-deletion-recovery\.sql/);
});

test("Task 1 P0 migration 5 upgrades an applied v4 deletion receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moss-migration-v5-"));
  const database = join(directory, "upgrade.db");
  const setup = join(directory, "setup.sql");
  const migration5 = read("src-tauri/src/db/migrations/moss-case-deletion-recovery.sql");
  try {
    await writeFile(setup, `
      PRAGMA foreign_keys = ON;
      CREATE TABLE case_deletion_operations (
        operation_id TEXT PRIMARY KEY NOT NULL,
        case_id TEXT NOT NULL,
        case_id_hash TEXT NOT NULL,
        linked_session_ids_json TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL CHECK (state IN (
          'prepared', 'staged', 'db-deleted', 'complete', 'failed'
        )),
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_case_deletion_operations_state
        ON case_deletion_operations(state, updated_at);
      INSERT INTO case_deletion_operations (
        operation_id, case_id, case_id_hash, state, created_at, updated_at
      ) VALUES ('operation-1', 'case-1', 'hash-1', 'failed', 1, 1);
    `);
    execFileSync("sqlite3", [database, `.read ${setup}`]);
    const migrationPath = join(directory, "migration-5.sql");
    await writeFile(migrationPath, migration5);
    execFileSync("sqlite3", [database, `.read ${migrationPath}`]);
    const state = execFileSync(
      "sqlite3",
      [database, "SELECT state FROM case_deletion_operations WHERE operation_id = 'operation-1';"],
      { encoding: "utf8" }
    ).trim();
    assert.equal(state, "restore-failed");
    const foreignKeyErrors = execFileSync(
      "sqlite3",
      [database, "PRAGMA foreign_key_check;"],
      { encoding: "utf8" }
    ).trim();
    assert.equal(foreignKeyErrors, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Task 1 P0 migration chain creates a clean database through version 5", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moss-migration-chain-"));
  const database = join(directory, "fresh.db");
  const migrations = [
    "moss-runtime-baseline.sql",
    "moss-case-preparation.sql",
    "moss-case-hardening.sql",
    "moss-case-authority-closure.sql",
    "moss-case-deletion-recovery.sql",
  ].map((filename) => read(`src-tauri/src/db/migrations/${filename}`));
  try {
    execFileSync("sqlite3", [database], {
      input: migrations.join("\n"),
      encoding: "utf8",
    });
    const tables = execFileSync(
      "sqlite3",
      [database, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;"],
      { encoding: "utf8" }
    );
    assert.match(tables, /case_statement_events/);
    assert.match(tables, /material_deletion_operations/);
    assert.match(tables, /snapshot_artifacts/);
    const foreignKeyErrors = execFileSync(
      "sqlite3",
      [database, "PRAGMA foreign_key_check;"],
      { encoding: "utf8" }
    ).trim();
    assert.equal(foreignKeyErrors, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Task 1 P0 commitment and deadline details use narrow structured contracts", () => {
  const commitment = parseCommitmentDetail({
    promisorPartyId: "party-merchant",
    beneficiaryPartyId: "party-candidate",
    action: "Send the written decision",
    conditions: ["after review"],
    certainty: "conditional",
    lifecycle: "pending-confirmation",
  }, 0);
  assert.equal(commitment?.promisorPartyId, "party-merchant");
  assert.deepEqual(commitment?.conditions, ["after review"]);

  const deadline = parseDeadlineDetail({
    linkedStatementId: "statement-commitment",
    originalPhrase: "by Friday at 5 PM Pacific",
    precision: "exact",
    dayKind: "business",
    timezone: "America/Los_Angeles",
    resolvedDate: "2026-08-14T17:00:00-07:00",
  }, 0);
  assert.equal(deadline?.linkedStatementId, "statement-commitment");
  assert.equal(deadline?.dayKind, "business");
  assert.throws(
    () => requireStructuredStatementDetails({ kind: "commitment" }),
    /Commitment details are required/
  );
  assert.throws(
    () => requireStructuredStatementDetails({ kind: "deadline" }),
    /Deadline details are required/
  );
});

test("Task 1 P0 statement edits supersede immutable records and revalidate sources", () => {
  const statements = read("src/lib/preparation/statement-service.ts");
  const authority = read("src/lib/preparation/source-authority.ts");
  const conversation = read("src/lib/preparation/conversation-service.ts");
  const materials = read("src/lib/preparation/material-service.ts");
  assert.match(statements, /id: `statement_\$\{crypto\.randomUUID\(\)\}`/);
  assert.match(statements, /supersedesId: current\.id/);
  assert.match(statements, /eventType: "edited"/);
  assert.match(statements, /removeStatementId: replacedConfirmedId/);
  assert.match(authority, /conversation-message-revision-changed/);
  assert.match(authority, /material-extraction-superseded/);
  assert.match(authority, /call-turn-hash-changed/);
  assert.match(conversation, /reconcileCaseStatementSourceAuthority/);
  assert.match(materials, /reconcileCaseStatementSourceAuthority/);
});

test("Task 1 P0 source authority detects a superseded conversation revision", async () => {
  const content = "The merchant confirmed the refund.";
  const database: SqlDatabase & { status: string } = {
    status: "committed",
    async select<T>(query: string): Promise<T> {
      if (query.includes("FROM case_statements")) {
        return [{ id: "statement-1", revision: 1, source_status: "current" }] as T;
      }
      if (query.includes("FROM case_statement_sources")) {
        return [{
          id: "source-1",
          statement_id: "statement-1",
          source_kind: "conversation",
          source_id: "message-1",
          source_revision: 1,
          content_hash: await sha256(content),
          quoted_text: content,
        }] as T;
      }
      if (query.includes("FROM preparation_messages")) {
        return [{ revision: 1, content, role: "user", status: this.status }] as T;
      }
      return [] as T;
    },
    async execute() {
      return { rowsAffected: 1 };
    },
  };
  assert.equal((await inspectStatementSourceAuthority(database, "statement-1")).status, "current");
  database.status = "superseded";
  const stale = await inspectStatementSourceAuthority(database, "statement-1");
  assert.equal(stale.status, "stale");
  assert.match(stale.reasons[0] ?? "", /conversation-message-superseded/);
});

test("Task 1 P0 snapshots fail closed and expose item-level provenance", () => {
  const snapshots = read("src/lib/preparation/snapshot-service.ts");
  const inspector = read("src/pages/cases/SnapshotPanel.tsx");
  assert.match(snapshots, /Unresolved: no sourced stage guidance was produced\./);
  assert.match(snapshots, /unresolvedStageIds/);
  assert.match(snapshots, /unsupported-playbook-wording/);
  assert.match(snapshots, /item_refs_json/);
  assert.match(snapshots, /current\.source_status !== "current"/);
  assert.match(snapshots, /reconcileCaseStatementSourceAuthority\(transaction/);
  assert.match(inspector, /itemRefs/);

  const proposal = parseSnapshotModelProposal(JSON.stringify({
    playbook: { stages: [], fallbackMoves: [] },
    speechBiasTerms: [],
  }));
  assert.equal(proposal.unresolvedStageIds.length, 5);
  assert.ok(proposal.playbook.stages.every((stage) => stage.goal.startsWith("Unresolved:")));
});

test("Task 1 P0 material and Case deletion remain recoverable after partial failure", () => {
  const material = read("src/lib/preparation/material-service.ts");
  const privacy = read("src/lib/preparation/privacy-service.ts");
  const native = read("src-tauri/src/content_storage.rs");
  assert.match(material, /recoverPendingMaterialDeletions/);
  assert.match(material, /state = 'restore-failed'/);
  assert.match(material, /state = 'finalize-failed'/);
  assert.match(privacy, /WHERE state NOT IN \('restored', 'complete'\)/);
  assert.match(privacy, /state = 'restore-failed'/);
  assert.match(privacy, /state = 'finalize-failed'/);
  assert.match(native, /stage_content_deletion_at_root/);
  assert.match(native, /restore_content_deletion_at_root/);
  assert.match(native, /finalize_content_deletion_at_root/);
});

test("Task 1 P0 exposes explicit Case and CallPlan lifecycle controls", () => {
  const service = read("src/lib/preparation/case-service.ts");
  const workspace = read("src/pages/cases/index.tsx");
  assert.match(service, /requireTransition\([\s\S]*entity: "Case"/);
  assert.match(service, /requireTransition\([\s\S]*entity: "CallPlan"/);
  assert.match(service, /sourceCommandId: id\("update_case_command"\)/);
  assert.match(workspace, /Edit case and lifecycle/);
  assert.match(workspace, /Lifecycle state/);
  assert.match(workspace, /Case status/);
  assert.match(workspace, /caseForm\.initialStatus \?\? caseForm\.status/);
  assert.match(workspace, /planForm\.initialState \?\? planForm\.state/);
});
