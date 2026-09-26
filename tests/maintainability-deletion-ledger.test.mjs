import assert from "node:assert/strict";
import test from "node:test";
import {
  loadDeletionLedger,
  validateDeletionLedger,
} from "../scripts/lib/maintainability-deletion-ledger.mjs";

// Approved retired surfaces at the C196 boundary; new ledger entries are allowed.
const requiredRetiredIds = [
  "temporary-native-stall-acceptance-hooks",
  "unused-native-provider-http",
  "local-turn-intent-permission-layer",
  "response-consistency-shadow-operation",
  "authorized-source-raw-window-intersection",
  "live-canonical-topic-semantic-fallbacks",
  "per-turn-effective-group-reselection",
  "generated-answer-task-writeback",
  "task-runtime-legacy-active-screen-root",
  "task-runtime-legacy-active-interview-root",
  "local-company-inference-authority",
  "source-owned-transition-intermediate-commit-authority",
  "direct-native-exit-without-runtime-drain",
  "native-audio-split-control-state",
  "recording-nontransactional-startup-publication",
  "recording-one-shot-terminal-manifest-close",
  "mutable-preparation-extraction-output",
  "destructive-curated-kmb-rebuild",
  "unversioned-preparation-snapshot-envelope",
  "best-effort-legacy-chat-startup-migration",
  "runtime-type-relation-release-switches",
  "response-only-relation-authority",
  "legacy-combined-intent-live-scheduling",
  "legacy-direct-relation-live-scheduling",
  "focus-unversioned-display-publication",
  "preparation-panel-read-publication-duplication",
  "human-evaluation-local-storage-writers",
  "legacy-system-audio-product",
  "local-model-product-mode",
  "runtime-inference-request-duplication",
  "meeting-dependency-contract-ownership",
  "unused-native-ipc-and-input-enumeration",
  "retired-runtime-inference-and-v1-producers",
];

function assertRetiredEntriesPreserved(ledger) {
  const result = validateDeletionLedger(ledger);
  assert.equal(result.ok, true, result.errors.join("\n"));
  for (const id of requiredRetiredIds) {
    const entry = ledger.entries.find(entry => entry.id === id);
    assert.ok(entry, `missing retired surface: ${id}`);
    assert.equal(entry.status, "deleted", id);
  }
}

test("accepts the tracked privacy-safe deletion ledger", () => {
  assertRetiredEntriesPreserved(loadDeletionLedger());
});

test("C196: ledger may grow without losing or downgrading retired protection", () => {
  const original = loadDeletionLedger();
  const extended = structuredClone(original);
  extended.entries.push({ ...structuredClone(original.entries[0]), id: "future-cleanup", status: "candidate" });
  assertRetiredEntriesPreserved(extended);
  for (const change of [
    ledger => { ledger.entries = []; },
    ledger => { ledger.entries = ledger.entries.filter(entry => entry.id !== requiredRetiredIds[0]); },
    ledger => { ledger.entries.find(entry => entry.id === requiredRetiredIds[0]).status = "candidate"; },
    ledger => { delete ledger.entries.find(entry => entry.id === requiredRetiredIds[0]).forbiddenPatterns; },
  ]) {
    const changed = structuredClone(original); change(changed);
    assert.throws(() => assertRetiredEntriesPreserved(changed));
  }
});

test("C196: status counters are checked on a fixed mixed-state fixture", () => {
  const original = loadDeletionLedger();
  const ledger = { ...original, entries: ["candidate", "migration-ready", "deleted", "retained"].map((status, index) => ({
    ...structuredClone(original.entries[0]), id: `fixture-${index}`, status,
  })) };
  const result = validateDeletionLedger(ledger);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.entryCount, 4);
  assert.deepEqual(result.statusCounts, { candidate: 1, "migration-ready": 1, deleted: 1, retained: 1 });
});

test("rejects duplicate ids and incomplete migration contracts", () => {
  const ledger = loadDeletionLedger();
  const duplicated = structuredClone(ledger.entries.find(entry => entry.verdict === "migrate-then-delete"));
  delete duplicated.replacement;
  ledger.entries.push(duplicated);

  const result = validateDeletionLedger(ledger);
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.includes("duplicates")), true);
  assert.equal(
    result.errors.some((error) => error.includes("replacement")),
    true
  );
});

test("requires deleted entries to provide recurrence guards", () => {
  const ledger = loadDeletionLedger();
  const candidate = ledger.entries.find(
    (entry) => entry.status === "deleted"
  );
  assert.ok(candidate);
  candidate.status = "deleted";
  delete candidate.forbiddenPatterns;

  const result = validateDeletionLedger(ledger);
  assert.equal(result.ok, false);
  assert.equal(
    result.errors.some((error) => error.includes("forbiddenPatterns")),
    true
  );
});

test("rejects private paths and secret-like values", () => {
  const ledger = loadDeletionLedger();
  ledger.entries[0].rollbackBoundary = "/Users/example/private/session-2026";

  const result = validateDeletionLedger(ledger);
  assert.equal(result.ok, false);
  assert.equal(
    result.errors.some((error) => error.includes("private or secret-like")),
    true
  );
});
