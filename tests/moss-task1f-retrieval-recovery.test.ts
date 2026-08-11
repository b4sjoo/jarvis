import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  scoreCaseRetrievalCandidate,
  splitRecoveredContent,
} from "../src/lib/preparation/index.js";

test("Task 1F hybrid provider ranking favors exact relevant Case evidence", () => {
  const relevant = scoreCaseRetrievalCandidate("refund reference number", {
    sourceKind: "material",
    label: "refund receipt",
    content: "Reference number RMA 42",
  });
  const irrelevant = scoreCaseRetrievalCandidate("refund reference number", {
    sourceKind: "kmb",
    label: "shipping guidance",
    content: "Ask about delivery windows",
  });
  assert.ok(relevant > irrelevant);
});

test("Task 1F recovered output is chunked without replacing the source", () => {
  const chunks = splitRecoveredContent(`${"word ".repeat(500)}\n\nsecond page`, 200);
  assert.ok(chunks.length > 2);
  assert.equal(chunks.at(-1), "second page");
  const service = readFileSync("src/lib/preparation/material-service.ts", "utf8");
  assert.match(service, /method: "multimodal"/);
  assert.match(service, /'needs-review'/);
  assert.match(service, /INSERT INTO extraction_runs/);
  assert.doesNotMatch(service, /UPDATE extraction_chunks SET/);
});

test("Task 1F retrieval and native reads fail closed by Case identity", () => {
  const retrieval = readFileSync("src/lib/preparation/retrieval-service.ts", "utf8");
  const native = readFileSync("src-tauri/src/content_storage.rs", "utf8");
  assert.match(retrieval, /material\.case_id = \?/);
  assert.match(retrieval, /case_id = \? AND review_state = 'confirmed'/);
  assert.match(native, /validate_identifier\(&collection_id/);
  assert.match(native, /reject_symlink\(&content_root\)/);
});
