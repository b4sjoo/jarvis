import assert from "node:assert/strict";
import test from "node:test";
import { materialSnapshotEligible } from "../src/lib/preparation/material-service.js";
import type { ExtractionRun } from "../src/lib/preparation/types.js";

const run = (status: ExtractionRun["status"]): ExtractionRun => ({
  id: "run",
  materialId: "material",
  method: "native-text",
  engine: "test",
  engineVersion: "1",
  optionsHash: "options",
  outputHash: "output",
  status,
  qualitySignals: [],
  createdAt: 1,
});

test("ready extraction is eligible without conflating review authority", () => {
  assert.equal(materialSnapshotEligible({ run: run("ready"), reviewStatus: "pending" }), true);
  assert.equal(materialSnapshotEligible({ run: run("needs-review"), reviewStatus: "pending" }), false);
  assert.equal(materialSnapshotEligible({ run: run("needs-review"), reviewStatus: "approved" }), true);
  assert.equal(materialSnapshotEligible({ run: run("failed"), reviewStatus: "approved" }), false);
});
