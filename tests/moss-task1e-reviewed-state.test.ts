import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  isHighImpactStatement,
  parseStatementProposalResponse,
} from "../src/lib/preparation/index.js";

test("Task 1E parses fenced structured proposals without granting authority", () => {
  const proposals = parseStatementProposalResponse(`\`\`\`json
  {"statements":[{"kind":"commitment","content":"Merchant will refund after approval","claimState":"asserted","sourceMessageIds":["message-1"],"sourceChunkIds":[],"allowedUses":["call-preparation"]}]}
  \`\`\``);
  assert.equal(proposals[0]?.kind, "commitment");
  assert.equal(proposals[0]?.claimState, "asserted");
  assert.equal(isHighImpactStatement(proposals[0]!.kind), true);
});

test("Task 1E rejects unknown proposal ontology", () => {
  assert.throws(() => parseStatementProposalResponse(
    '{"statements":[{"kind":"truth","content":"x","claimState":"supported"}]}'
  ), /unknown kind/);
});

test("Task 1E confirmation creates a new immutable CaseRevision", () => {
  const source = readFileSync("src/lib/preparation/statement-service.ts", "utf8");
  assert.match(source, /requireStatementConfirmation/);
  assert.match(source, /INSERT INTO case_revisions/);
  assert.match(source, /current_revision_id = \?.*current_revision_id = \?/s);
  assert.match(source, /Confirmed statements must be superseded/);
  assert.doesNotMatch(source, /UPDATE case_revisions SET/);
});
