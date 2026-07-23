import assert from "node:assert/strict";
import test from "node:test";
import { consumeTaxonomyAdjudicationResponse } from "../src/lib/meeting/taxonomy-adjudication-response.js";
import {
  buildTaxonomyAdjudicationRequest,
  type LlmTaxonomyAdjudication,
} from "../src/lib/meeting/taxonomy-adjudication.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";

test("classifies configured-route content separately from JSON parsing", async () => {
  const request = buildRequest();
  const output: LlmTaxonomyAdjudication = {
    schemaVersion: 2,
    speechAct: "directive",
    questionType: "ai-ml-system-design",
    relation: "new-parent",
    evidenceMode: "hypothetical-design",
    action: "answer",
    normalizedQuestion: request.question.text,
    primaryAskSpans: [
      {
        turnId: "turn-a",
        text: request.question.text,
      },
    ],
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

test("identifies provider error text without misreporting a JSON parse failure", async () => {
  const result = await consumeTaxonomyAdjudicationResponse({
    request: buildRequest(),
    signal: new AbortController().signal,
    responseStream: chunks(
      "API request failed: 400 Bad Request - unsupported generation config"
    ),
  });

  assert.equal(result.providerDisposition, "provider-error-content");
  assert.equal(result.parseDisposition, "not-run-provider-error-content");
  assert.deepEqual(result.parsed, {
    ok: false,
    reason: "provider-error-content",
    errorKind: "provider",
    evidenceSpansValid: false,
  });
});

test("classifies deterministic credential failures without invoking JSON parsing", async () => {
  const result = await consumeTaxonomyAdjudicationResponse({
    request: buildRequest(),
    signal: new AbortController().signal,
    responseStream: chunks(
      "API request failed: 400 Bad Request - Please pass a valid API key"
    ),
  });

  assert.equal(result.providerDisposition, "provider-auth-error");
  assert.equal(result.parseDisposition, "not-run-provider-auth-error");
  assert.deepEqual(result.parsed, {
    ok: false,
    reason: "provider-auth-error",
    errorKind: "provider",
    evidenceSpansValid: false,
  });
});

test("keeps an empty provider completion distinct from parser failure", async () => {
  const result = await consumeTaxonomyAdjudicationResponse({
    request: buildRequest(),
    signal: new AbortController().signal,
    responseStream: chunks(""),
  });

  assert.equal(result.providerDisposition, "completed-empty");
  assert.equal(result.parseDisposition, "not-run-completed-empty");
  assert.deepEqual(result.parsed, {
    ok: false,
    reason: "completed-empty",
    errorKind: "provider",
    evidenceSpansValid: false,
  });
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
  });
}

async function* chunks(...values: string[]) {
  for (const value of values) yield value;
}
