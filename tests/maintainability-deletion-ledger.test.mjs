import assert from "node:assert/strict";
import test from "node:test";
import {
  loadDeletionLedger,
  validateDeletionLedger,
} from "../scripts/lib/maintainability-deletion-ledger.mjs";

test("accepts the tracked privacy-safe deletion ledger", () => {
  const result = validateDeletionLedger(loadDeletionLedger());
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.entryCount, 28);
  assert.deepEqual(result.statusCounts, {
    candidate: 0,
    "migration-ready": 0,
    deleted: 28,
    retained: 0,
  });
});

test("rejects duplicate ids and incomplete migration contracts", () => {
  const ledger = loadDeletionLedger();
  const duplicated = structuredClone(ledger.entries[0]);
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
