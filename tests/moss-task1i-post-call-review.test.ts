import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sha256 } from "../src/lib/calling/index.js";
import {
  PostCallReviewService,
  parsePostCallProposalResponse,
  type PendingCaseUpdate,
  type SqlDatabase,
} from "../src/lib/preparation/index.js";

test("Task 1I parses only sourced post-call update proposals", () => {
  const parsed = parsePostCallProposalResponse(`\`\`\`json
    {"updates":[{"kind":"deadline","content":"The counterparty committed to reply by Friday at 5 PM Pacific.","sourceTurnIds":["turn-1"],"dateTime":"2026-08-14T17:00:00-07:00","deadlineDetail":{"linkedStatementId":"commitment-1","originalPhrase":"by Friday at 5 PM Pacific","precision":"exact","dayKind":"calendar","timezone":"America/Los_Angeles","resolvedDate":"2026-08-14T17:00:00-07:00"}}]}
  \`\`\``);
  assert.equal(parsed[0].kind, "deadline");
  assert.deepEqual(parsed[0].sourceTurnIds, ["turn-1"]);
  assert.throws(
    () => parsePostCallProposalResponse('{"updates":[{"kind":"commitment","content":"Call back","sourceTurnIds":[]}]}'),
    /source turns/
  );
  assert.throws(
    () => parsePostCallProposalResponse('{"updates":[{"kind":"summary","content":"Anything","sourceTurnIds":["turn-1"]}]}'),
    /unknown kind/
  );
});

class ReviewDatabase implements SqlDatabase {
  readonly executed: Array<{ query: string; values: unknown[] }> = [];
  pending!: PendingCaseUpdate;
  turnText = "I will send the written decision by Friday at 5 PM Pacific.";

  async select<T>(query: string): Promise<T> {
    if (query.includes("FROM pending_case_updates WHERE id")) {
      return [{
        id: this.pending.id,
        case_id: this.pending.caseId,
        call_session_id: this.pending.callSessionId,
        kind: this.pending.kind,
        proposed_statement_json: JSON.stringify(this.pending.proposedStatement),
        source_turn_ids_json: JSON.stringify(this.pending.sourceTurnIds),
        review_state: this.pending.reviewState,
        row_revision: this.pending.rowRevision,
        created_at: this.pending.createdAt,
        updated_at: this.pending.updatedAt,
      }] as T;
    }
    if (query.includes("FROM call_runtime_events")) {
      return [{ payload_json: JSON.stringify({
        command: {
          type: "SubmitTranscriptTurn",
          turn: { id: "turn-1", speaker: "them", text: this.turnText, occurredAt: 4 },
        },
      }) }] as T;
    }
    if (query.includes("FROM case_parties")) {
      return [{ id: "party-counterparty" }] as T;
    }
    if (query.includes("FROM case_revisions revision")) {
      return [{
        id: "case-revision-1",
        case_id: "case-1",
        revision: 1,
        parent_revision_id: null,
        primary_objective: "Obtain a written decision",
        acceptable_fallbacks_json: "[]",
        party_ids_json: "[]",
        statement_ids_json: "[]",
        next_action_ids_json: "[]",
        source_command_id: "initial",
        created_at: 1,
      }] as T;
    }
    return [] as T;
  }

  async execute(query: string, values: unknown[] = []) {
    this.executed.push({ query, values });
    return { rowsAffected: 1 };
  }
}

test("Task 1I human acceptance atomically creates a sourced statement and CaseRevision", async () => {
  const database = new ReviewDatabase();
  database.pending = {
    id: "pending-1",
    caseId: "case-1",
    callSessionId: "call-1",
    kind: "commitment",
    proposedStatement: {
      caseId: "case-1",
      kind: "commitment",
      content: "The counterparty will send the decision by Friday.",
      sourceRefs: [{
        id: "source-1",
        sourceKind: "call-turn",
        sourceId: "turn-1",
        contentHash: await sha256(database.turnText),
        quotedText: database.turnText,
      }],
      claimState: "asserted",
      allowedUses: ["call-preparation", "advisor-grounding"],
      createdBy: "complex-model-proposal",
      sourceStatus: "current",
      sourceStaleReasons: [],
      commitmentDetail: {
        promisorPartyId: "party-counterparty",
        action: "Send the written decision",
        conditions: [],
        certainty: "explicit",
        lifecycle: "active",
      },
    },
    sourceTurnIds: ["turn-1"],
    reviewState: "pending",
    rowRevision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  await new PostCallReviewService(database).review({
    updateId: "pending-1",
    expectedRevision: 1,
    action: "accept",
  });
  assert.ok(database.executed.some((entry) => entry.query.includes("INSERT INTO case_statements")));
  assert.ok(database.executed.some((entry) => entry.query.includes("INSERT INTO case_statement_sources")));
  assert.ok(database.executed.some((entry) => entry.query.includes("INSERT INTO case_revisions")));
  assert.ok(database.executed.some((entry) => entry.query.includes("UPDATE cases SET current_revision_id")));
  assert.ok(database.executed.some((entry) => entry.query.includes("UPDATE pending_case_updates")));
});

test("Task 1I refuses review when its exact source turn no longer matches", async () => {
  const database = new ReviewDatabase();
  database.pending = {
    id: "pending-1",
    caseId: "case-1",
    callSessionId: "call-1",
    kind: "commitment",
    proposedStatement: {
      caseId: "case-1",
      kind: "commitment",
      content: "The counterparty will reply.",
      sourceRefs: [{ id: "source-1", sourceKind: "call-turn", sourceId: "turn-1", contentHash: "wrong" }],
      claimState: "asserted",
      allowedUses: ["call-preparation"],
      createdBy: "complex-model-proposal",
      sourceStatus: "current",
      sourceStaleReasons: [],
      commitmentDetail: {
        promisorPartyId: "party-counterparty",
        action: "Reply",
        conditions: [],
        certainty: "explicit",
        lifecycle: "active",
      },
    },
    sourceTurnIds: ["turn-1"],
    reviewState: "pending",
    rowRevision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  await assert.rejects(
    () => new PostCallReviewService(database).review({ updateId: "pending-1", expectedRevision: 1, action: "accept" }),
    /source turn changed/
  );
  assert.equal(database.executed.some((entry) => entry.query.includes("INSERT INTO case_statements")), false);
});

test("Task 1I keeps the complex model proposal separate from human authority", () => {
  const service = readFileSync("src/lib/preparation/post-call-service.ts", "utf8");
  assert.match(service, /review_state, row_revision[\s\S]*'pending'/);
  assert.match(service, /input\.action === "edit" \? "edited" : "accepted"/);
  assert.match(service, /Post-call proposals require a successfully closed CallSession/);
  assert.match(service, /target, status[\s\S]*'post-call'/);
});
