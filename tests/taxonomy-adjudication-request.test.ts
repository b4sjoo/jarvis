import assert from "node:assert/strict";
import test from "node:test";
import { consumeTaxonomyAdjudicationResponse } from "../src/lib/meeting/taxonomy-adjudication-response.js";
import {
  buildTaxonomyAdjudicationRequest,
  type LlmTaxonomyAdjudication,
} from "../src/lib/meeting/taxonomy-adjudication.js";
import { inferQuestionTypeDecisionFromText } from "../src/lib/meeting/task-taxonomy.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";

test("classifies configured-route content separately from JSON parsing", async () => {
  const request = buildRequest();
  const output: LlmTaxonomyAdjudication = {
    schemaVersion: 1,
    questionType: "ai-ml-system-design",
    relation: "new-parent",
    normalizedQuestion: request.question.text,
    standalone: true,
    evidenceSpans: ["RAG system"],
    confidence: 0.92,
  };
  const json = JSON.stringify(output);
  const result = await consumeTaxonomyAdjudicationResponse({
    request,
    signal: new AbortController().signal,
    responseStream: chunks(json.slice(0, 40), json.slice(40)),
  });

  assert.equal(result.providerDisposition, "completed-with-content");
  assert.equal(result.parseDisposition, "valid-json");
  assert.equal(result.parsed.ok, true);
});

test("identifies provider error text before reporting malformed JSON", async () => {
  const result = await consumeTaxonomyAdjudicationResponse({
    request: buildRequest(),
    signal: new AbortController().signal,
    responseStream: chunks(
      "API request failed: 400 Bad Request - unsupported generation config"
    ),
  });

  assert.equal(result.providerDisposition, "provider-error-content");
  assert.equal(result.parseDisposition, "malformed-json");
  assert.equal(result.parsed.ok, false);
});

test("keeps an empty provider completion distinct from parser failure", async () => {
  const result = await consumeTaxonomyAdjudicationResponse({
    request: buildRequest(),
    signal: new AbortController().signal,
    responseStream: chunks(""),
  });

  assert.equal(result.providerDisposition, "completed-empty");
  assert.equal(result.parseDisposition, "empty-output");
  assert.equal(result.parsed.ok, false);
});

function buildRequest() {
  const text = "Design a RAG system for a trip planning app.";
  const logicalQuestionUnit: LogicalQuestionUnit = {
    id: "logical-a",
    revision: 1,
    sessionId: "session-a",
    runtimeEpoch: 1,
    currentTurnId: "turn-a",
    sourceTurnIds: ["turn-a"],
    sources: [{ turnId: "turn-a", text, startedAt: 1, endedAt: 2 }],
    normalizedText: text,
    startedAt: 1,
    updatedAt: 2,
    compositionReasons: ["independent-current-turn"],
    boundaryReason: "independent-current-turn",
    truncated: false,
  };
  return buildTaxonomyAdjudicationRequest({
    logicalQuestionUnit,
    lexical: inferQuestionTypeDecisionFromText(text),
  });
}

async function* chunks(...values: string[]) {
  for (const value of values) yield value;
}
