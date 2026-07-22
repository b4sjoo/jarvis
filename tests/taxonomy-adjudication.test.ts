import assert from "node:assert/strict";
import test from "node:test";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import {
  authorizeTaxonomyAdjudicationLease,
  buildTaxonomyAdjudicationPrompts,
  buildTaxonomyAdjudicationRequest,
  createTaxonomyAdjudicationLease,
  decideTaxonomyAdjudicationEligibility,
  parseTaxonomyAdjudicationOutput,
  projectLogicalQuestionForAdjudication,
} from "../src/lib/meeting/taxonomy-adjudication.js";
import { inferQuestionTypeDecisionFromText } from "../src/lib/meeting/task-taxonomy.js";
import { TAXONOMY_ADJUDICATION_CORPUS } from "./fixtures/taxonomy-adjudication-corpus.js";

function unit(text: string, revision = 1): LogicalQuestionUnit {
  return {
    id: "logical-a",
    revision,
    sessionId: "session-a",
    runtimeEpoch: 2,
    currentTurnId: "turn-a",
    sourceTurnIds: ["turn-a"],
    sources: [
      { turnId: "turn-a", text, startedAt: 10, endedAt: 20 },
    ],
    normalizedText: text,
    startedAt: 10,
    updatedAt: 20,
    compositionReasons: ["independent-current-turn"],
    boundaryReason: "independent-current-turn",
    truncated: false,
  };
}

test("strictly parses a grounded adjudication and rejects invented evidence", () => {
  const logicalUnit = unit("Design a RAG system for a trip planning app.");
  const request = buildTaxonomyAdjudicationRequest({
    logicalQuestionUnit: logicalUnit,
    lexical: inferQuestionTypeDecisionFromText(logicalUnit.normalizedText),
    activeParent: {
      idHash: "parent-hash",
      questionType: "general-system-design",
      topic: "Design a trip planning app",
    },
  });
  const output = JSON.stringify({
    schemaVersion: 1,
    questionType: "ai-ml-system-design",
    relation: "linked-parent-extension",
    normalizedQuestion: logicalUnit.normalizedText,
    standalone: true,
    evidenceSpans: ["RAG system", "trip planning app"],
    confidence: 0.92,
  });

  assert.equal(parseTaxonomyAdjudicationOutput(output, request).ok, true);
  const invalid = parseTaxonomyAdjudicationOutput(
    JSON.stringify({
      ...JSON.parse(output),
      evidenceSpans: ["vector database benchmark"],
    }),
    request
  );
  assert.deepEqual(invalid, {
    ok: false,
    reason: "invalid-evidence-span",
    evidenceSpansValid: false,
  });
  assert.doesNotMatch(
    buildTaxonomyAdjudicationPrompts(request).userMessage,
    /api.?key/i
  );
});

test("preserves first anchor and latest constraint when projecting overflow", () => {
  const logicalUnit = unit("ignored");
  logicalUnit.sourceTurnIds = ["turn-a", "turn-b", "turn-c"];
  logicalUnit.sources = [
    {
      turnId: "turn-a",
      text: `Design an enterprise retrieval service ${"anchor ".repeat(120)}`,
      startedAt: 10,
      endedAt: 20,
    },
    {
      turnId: "turn-b",
      text: `Some repeated background ${"filler ".repeat(180)}`,
      startedAt: 30,
      endedAt: 40,
    },
    {
      turnId: "turn-c",
      text: "Now switch to hybrid search and keep p99 latency under 100ms.",
      startedAt: 50,
      endedAt: 60,
    },
  ];
  logicalUnit.normalizedText = logicalUnit.sources
    .map((source) => source.text)
    .join("\n");

  const projection = projectLogicalQuestionForAdjudication(logicalUnit, 420);
  assert.equal(projection.safe, true);
  assert.ok(projection.text.length <= 420);
  assert.match(projection.text, /Design an enterprise retrieval service/);
  assert.match(projection.text, /hybrid search/);
  assert.equal(projection.projectionReason, "anchor-switch-latest-constraint");
});

test("only ambiguous substantive interviewer units are eligible", () => {
  const corpusCase = TAXONOMY_ADJUDICATION_CORPUS.find(
    (candidate) => candidate.id === "unknown-coding-design-algorithm"
  );
  assert.ok(corpusCase);
  const lexical = inferQuestionTypeDecisionFromText(corpusCase.text);
  const eligible = decideTaxonomyAdjudicationEligibility({
    enabled: true,
    evaluationActive: true,
    speaker: "them",
    turnGateAction: "answer-refresh",
    projection: projectLogicalQuestionForAdjudication(unit(corpusCase.text)),
    lexical: { ...lexical, type: undefined, confidence: 0.4, margin: 0.05 },
    manualCorrectionActive: false,
  });
  assert.equal(eligible.eligible, true);
  assert.deepEqual(eligible.triggerReasons, ["lexical-unknown"]);

  assert.equal(
    decideTaxonomyAdjudicationEligibility({
      enabled: true,
      evaluationActive: true,
      speaker: "me",
      turnGateAction: "answer-refresh",
      projection: projectLogicalQuestionForAdjudication(unit(corpusCase.text)),
      lexical,
      manualCorrectionActive: false,
    }).eligible,
    false
  );
});

test("lease authorization drops stale revisions, boundaries, and corrections", () => {
  const logicalUnit = unit("Design an Uber-like service.", 2);
  const lease = createTaxonomyAdjudicationLease({
    operationId: "operation-a",
    sessionId: "session-a",
    runtimeEpoch: 2,
    logicalQuestionUnit: logicalUnit,
    taskBoundaryEpoch: 11,
    manualCorrectionRevision: 4,
    expectedParentId: "parent-a",
    requestedAt: 100,
  });
  const current = {
    currentOperationId: "operation-a",
    sessionId: "session-a",
    runtimeEpoch: 2,
    logicalQuestionUnit: logicalUnit,
    taskBoundaryEpoch: 11,
    manualCorrectionRevision: 4,
    activeParentId: "parent-a",
    logicalUnitClosed: false,
    selfHealingBudgetConsumed: false,
  };
  assert.deepEqual(authorizeTaxonomyAdjudicationLease(lease, current), {
    authorized: true,
  });
  assert.deepEqual(
    authorizeTaxonomyAdjudicationLease(lease, {
      ...current,
      logicalQuestionUnit: { ...logicalUnit, revision: 3 },
    }),
    {
      authorized: false,
      reason: "logical-unit-revision-mismatch",
    }
  );
  assert.deepEqual(
    authorizeTaxonomyAdjudicationLease(lease, {
      ...current,
      manualCorrectionRevision: 5,
    }),
    {
      authorized: false,
      reason: "manual-correction-revision-mismatch",
    }
  );
});

test("offline corpus covers multilingual, continuity, filler, and domain-switch cases", () => {
  assert.ok(TAXONOMY_ADJUDICATION_CORPUS.length >= 12);
  assert.ok(
    TAXONOMY_ADJUDICATION_CORPUS.some((item) =>
      /[\u4e00-\u9fff]/u.test(item.text)
    )
  );
  assert.ok(
    TAXONOMY_ADJUDICATION_CORPUS.some(
      (item) => item.expectedRelation === "linked-parent-extension"
    )
  );
  assert.ok(
    TAXONOMY_ADJUDICATION_CORPUS.some(
      (item) => item.expectedRelation === "child-probe"
    )
  );
  assert.ok(TAXONOMY_ADJUDICATION_CORPUS.some((item) => !item.shouldAdjudicate));
});
