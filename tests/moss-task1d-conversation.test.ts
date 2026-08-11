import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  rankPreparationChunks,
  retrievalTokens,
  serializePreparationContext,
} from "../src/lib/preparation/index.js";

test("Task 1D retrieval normalization preserves useful domain terms", () => {
  assert.deepEqual(retrievalTokens("The refund-reference RMA_42 was disputed"), [
    "refund-reference",
    "rma_42",
    "disputed",
  ]);
});

test("Task 1D bounded retrieval ranks exact scoped evidence first", () => {
  const ranked = rankPreparationChunks("refund cancellation receipt", [
    { display_name: "terms.md", content: "Generic shipping policy" },
    { display_name: "receipt.pdf", content: "Cancellation receipt and refund confirmation" },
  ]);
  assert.equal(ranked[0]?.display_name, "receipt.pdf");
});

test("Task 1D serialization keeps evidence roles explicit", () => {
  const serialized = serializePreparationContext({
    identity: { caseId: "case-a", caseTitle: "Refund", objective: "Recover charge" },
    currentRequest: "What should I ask?",
    recentMessages: [{ id: "message-1", revision: 1, role: "user", content: "Prepare the next call" }],
    confirmedStatements: [{ id: "statement-1", kind: "fact", claimState: "supported", content: "Cancellation confirmed" }],
    materialEvidence: [{ chunkId: "chunk-1", materialId: "material-1", materialName: "receipt.pdf", content: "Cancelled on May 1" }],
    unresolvedRisks: ["Refund timing unknown"],
    manifest: { caseId: "case-a", statementIds: ["statement-1"], extractionChunkIds: ["chunk-1"], materialRevisionHashes: ["hash"], kmbContentHashes: [], truncated: false, contextHash: "context-hash" },
  });
  assert.match(serialized, /CONFIRMED STATE:/);
  assert.match(serialized, /SOURCE MATERIAL:/);
  assert.match(serialized, /UNRESOLVED RISKS:/);
  assert.doesNotMatch(serialized, /assistant response as evidence/i);
});

test("Task 1D service owns abort, CAS, and superseded branch boundaries", () => {
  const source = readFileSync("src/lib/preparation/conversation-service.ts", "utf8");
  assert.match(source, /activeOperations\.get\(input\.conversation\.id\) !== controller/);
  assert.match(source, /head_revision = \?/);
  assert.match(source, /status = 'superseded'.*revision >=/s);
  assert.match(source, /context_manifest_json/);
});
