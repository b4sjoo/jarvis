import assert from "node:assert/strict";
import test from "node:test";
import {
  composeProfileContent,
  createPreparationProfileSourceFingerprint,
  createPreparationCompositionService,
  parsePreparationNarrative,
} from "../src/lib/preparation/preparation-composition-service.js";
import {
  parsePreparationStatementProposals,
  stablePreparationHash,
} from "../src/lib/preparation/statement-proposal-service.js";
import { createPreparationStatementService } from "../src/lib/preparation/statement-service.js";
import type {
  InterviewPreparationProfileRevision,
  PreparationCompositionRepository,
  PreparationStatementRepository,
  PreparationStatementWithSources,
} from "../src/lib/preparation/statement-types.js";

const PROCESS_SCOPE = { kind: "process" as const };

test("statement proposal parser enforces the requested scope", () => {
  const response = `<preparation_statement_proposals>{"statements":[{
    "domain":"project-evidence",
    "content":"I implemented the consolidation strategy layer.",
    "scope":"process",
    "sourceLabels":["U1"],
    "ownership":"candidate-owned",
    "confidence":0.9,
    "prohibitedWording":[],
    "allowedInterviewFamilies":["project-deep-dive"]
  }]}</preparation_statement_proposals>`;
  const parsed = parsePreparationStatementProposals(response, PROCESS_SCOPE);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.domain, "project-evidence");
  assert.equal(parsed[0]?.scope.kind, "process");

  assert.throws(
    () =>
      parsePreparationStatementProposals(
        response.replace('"scope":"process"', '"scope":"round"'),
        PROCESS_SCOPE
      ),
    /change statement scope/u
  );
});

test("profile projection includes only supplied confirmed statements without merging domains", () => {
  const content = composeProfileContent([
    statement({ id: "evidence", domain: "project-evidence", content: "Built A" }),
    statement({ id: "risk", domain: "risk", content: "Avoid claiming B" }),
    statement({ id: "unknown", domain: "unknown", content: "Needs categorization" }),
  ]);
  assert.deepEqual(content.evidence, ["Built A"]);
  assert.deepEqual(content.risks, ["Avoid claiming B"]);
  assert.deepEqual(content.other, ["Needs categorization"]);
  assert.equal(content.strategy.length, 0);
});

test("profile composer reuses an identical confirmed-statement fingerprint", async () => {
  const confirmed = statement({ id: "fact", content: "Confirmed fact" });
  const profiles: InterviewPreparationProfileRevision[] = [];
  const repository = compositionRepository(profiles);
  const service = createPreparationCompositionService({
    statements: statementRepository([confirmed]),
    composition: repository,
    interviewProcesses: activeProcessRepository(),
    fetchResponse: async function* () {},
    now: () => 100,
    createId: () => "profile-id",
  });

  const first = await service.composeProfile({
    processId: "process-1",
    scope: PROCESS_SCOPE,
  });
  const second = await service.composeProfile({
    processId: "process-1",
    scope: PROCESS_SCOPE,
  });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(profiles.length, 1);
  assert.equal(first.profile.sourceFingerprint, second.profile.sourceFingerprint);
});

test("narrative parser rejects unknown statement labels and node kinds", () => {
  const confirmed = statement({ id: "fact", content: "Confirmed fact" });
  const valid = `<preparation_narrative_graph>{"nodes":[{
    "localId":"N1","kind":"positioning","title":"Positioning",
    "content":"A grounded opening.","targetSeconds":30,
    "statementLabels":["S1"]
  }],"edges":[]}</preparation_narrative_graph>`;
  assert.equal(parsePreparationNarrative(valid, [confirmed]).nodes.length, 1);
  assert.throws(
    () => parsePreparationNarrative(valid.replace('"S1"', '"S9"'), [confirmed]),
    /unknown statement/u
  );
  assert.throws(
    () =>
      parsePreparationNarrative(
        valid.replace('"positioning"', '"invented-kind"'),
        [confirmed]
      ),
    /unknown narrative node kind/u
  );
});

test("narrative parser repairs bounded edge aliases and drops unknown optional edges", () => {
  const confirmed = statement({ id: "fact", content: "Confirmed fact" });
  const response = `<preparation_narrative_graph>{"nodes":[{
    "localId":"N1","kind":"positioning","title":"Positioning",
    "content":"A grounded opening.","statementLabels":["S1"]
  },{
    "localId":"N2","kind":"main-story-90s","title":"Main story",
    "content":"A grounded story.","statementLabels":["S1"]
  }],"edges":[
    {"from":"N1","to":"N2","relation":"Elaborates On"},
    {"from":"N2","to":"N1","relation":"leads-to"}
  ]}</preparation_narrative_graph>`;
  const parsed = parsePreparationNarrative(response, [confirmed]);
  assert.deepEqual(parsed.edges, [
    { from: "N1", to: "N2", relation: "expands" },
  ]);
  assert.deepEqual(parsed.edgeDiagnostics.normalized, [
    "Elaborates On->expands",
  ]);
  assert.deepEqual(parsed.edgeDiagnostics.dropped, ["unknown:leads-to"]);
});

test("stable preparation hash is deterministic and content-sensitive", () => {
  assert.equal(stablePreparationHash("same"), stablePreparationHash("same"));
  assert.notEqual(stablePreparationHash("same"), stablePreparationHash("different"));
});

test("profile fingerprint changes when confirmed statement authority changes", () => {
  const original = statement({ id: "fact", content: "Confirmed fact" });
  const revised = {
    ...original,
    content: "Confirmed corrected fact",
    normalizedContent: "confirmed corrected fact",
    revision: original.revision + 1,
  };
  assert.notEqual(
    createPreparationProfileSourceFingerprint([original]),
    createPreparationProfileSourceFingerprint([revised])
  );
});

test("candidate evidence requires resolved ownership before confirmation", async () => {
  const proposed = {
    ...statement({ id: "proposal", content: "I built it" }),
    status: "proposed" as const,
    authority: "model-generated" as const,
    ownership: "unresolved" as const,
    revision: 0,
    lastReviewAction: "proposed" as const,
    lastReviewActor: "model" as const,
  };
  let reviewed = false;
  const repository = statementRepository([proposed]);
  repository.review = async () => {
    reviewed = true;
    return true;
  };
  const service = createPreparationStatementService({
    repository,
    interviewProcesses: activeProcessRepository(),
    now: () => 10,
  });
  await assert.rejects(
    service.review({
      processId: "process-1",
      statementId: proposed.id,
      expectedRevision: 0,
      status: "confirmed",
    }),
    /Resolve ownership/u
  );
  assert.equal(reviewed, false);

  await service.review({
    processId: "process-1",
    statementId: proposed.id,
    expectedRevision: 0,
    status: "confirmed",
    ownership: "candidate-owned",
  });
  assert.equal(reviewed, true);
});

test("an edited statement and its review decision advance separate audit revisions", async () => {
  const proposed = {
    ...statement({ id: "proposal", content: "Original content" }),
    status: "proposed" as const,
    authority: "model-generated" as const,
    revision: 0,
    lastReviewAction: "proposed" as const,
    lastReviewActor: "model" as const,
  };
  let reviewInput:
    | Parameters<PreparationStatementRepository["review"]>[0]
    | undefined;
  const repository = statementRepository([proposed]);
  repository.review = async (input) => {
    reviewInput = input;
    return true;
  };
  const service = createPreparationStatementService({
    repository,
    interviewProcesses: activeProcessRepository(),
    now: () => 10,
  });

  await service.review({
    processId: "process-1",
    statementId: proposed.id,
    expectedRevision: 0,
    status: "confirmed",
    content: "Edited content",
  });
  assert.equal(reviewInput?.revisionIncrement, 2);
  assert.equal(reviewInput?.action, "confirmed");

  await service.review({
    processId: "process-1",
    statementId: proposed.id,
    expectedRevision: 0,
    status: "rejected",
  });
  assert.equal(reviewInput?.revisionIncrement, 1);
  assert.equal(reviewInput?.action, "rejected");
});

function statement(input: {
  id: string;
  domain?: PreparationStatementWithSources["domain"];
  content: string;
}): PreparationStatementWithSources {
  return {
    id: input.id,
    processId: "process-1",
    scope: PROCESS_SCOPE,
    domain: input.domain ?? "candidate-fact",
    content: input.content,
    normalizedContent: input.content.toLowerCase(),
    status: "confirmed",
    authority: "user-confirmed",
    ownership: "candidate-owned",
    prohibitedWording: [],
    allowedInterviewFamilies: [],
    proposalOperationId: "operation-1",
    revision: 1,
    lastReviewAction: "confirmed",
    lastReviewActor: "user",
    createdAt: 1,
    updatedAt: 2,
    reviewedAt: 2,
    sources: [
      {
        id: `${input.id}-source`,
        statementId: input.id,
        sourceType: "user-confirmation",
        sourceId: `${input.id}:1`,
        title: "User confirmation",
        createdAt: 2,
      },
    ],
  };
}

function statementRepository(
  statements: PreparationStatementWithSources[]
): PreparationStatementRepository {
  return {
    async beginProposalOperation() {},
    async stageProposalBatch() {},
    async commitProposalOperation() { return true; },
    async settleProposalOperation() {},
    async list(input) {
      return statements.filter(
        (item) =>
          !input.statuses?.length || input.statuses.includes(item.status)
      );
    },
    async get(_processId, statementId) {
      return statements.find((item) => item.id === statementId);
    },
    async listEvents() { return []; },
    async review() { return true; },
  };
}

function compositionRepository(
  profiles: InterviewPreparationProfileRevision[]
): PreparationCompositionRepository {
  return {
    async getProfileByFingerprint(input) {
      return profiles.find(
        (profile) => profile.sourceFingerprint === input.sourceFingerprint
      );
    },
    async insertProfile(input) { profiles.push(input.profile); },
    async getLatestProfile() { return profiles.at(-1); },
    async listProfiles() { return [...profiles].reverse(); },
    async nextNarrativeRevision() { return 1; },
    async insertNarrativeGraph() {},
    async listNarrativeGraphs() { return []; },
    async getNarrativeGraph() { return undefined; },
    async reviewNarrativeNode() { return true; },
  };
}

function activeProcessRepository() {
  return {
    async insertProcess() {},
    async updateProcess() {},
    async getProcess() {
      return {
        id: "process-1",
        workspaceId: "process-1",
        title: "Interview",
        status: "active" as const,
        createdAt: 1,
        updatedAt: 1,
      };
    },
    async listProcesses() { return []; },
    async insertRound() {},
    async updateRound() {},
    async deleteRound() {},
    async getRound() { return undefined; },
    async listRounds() { return []; },
    async setActiveRound() {},
  };
}
