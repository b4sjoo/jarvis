import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { AIResponseEventBuilder, coordinateAIResponseAttempts } from "../src/lib/functions/ai-response-events.js";
import { consumeRuntimeInferenceResponse } from "../src/lib/meeting/runtime-inference-response.js";
import { buildQuestionTypeAdjudicationPrompts, buildQuestionTypeAdjudicationRequest, parseQuestionTypeAdjudicationOutput, createQuestionTypeSettlementProposal, decideOrderedVoiceQuestionTypeResolution } from "../src/lib/meeting/question-type-adjudication.js";
import { getRuntimeInferenceOperationDefinition } from "../src/lib/meeting/runtime-inference.js";
import { createProvisionalCurrentQuestion, settleCurrentQuestion } from "../src/lib/meeting/current-question-settlement.js";
import { decideFirstBatchRelationRelease } from "../src/lib/meeting/task-relation-split-shadow.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import { RuntimeInferenceOperationRuntime } from "../src/lib/meeting/runtime-inference-runtime.js";
import { MeetingAIResponseOutcomeError } from "../src/lib/meeting/meeting-ai-response.js";
import { createTaxonomyAdjudicationLease, authorizeTaxonomyAdjudicationLease } from "../src/lib/meeting/taxonomy-adjudication.js";

function productionFunction(file: string, name: string, env: Record<string, unknown>): any {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const node = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, `missing production function ${name}`);
  const code = node.getText(source).replace(/^export\s+/, "") + `\n${name};`;
  return vm.runInNewContext(ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, env);
}

const identity = {
  requestId: "type-op", executionPlanId: "type-op", modelId: "intelligent",
  sessionId: "meeting", runtimeEpoch: 1, logicalQuestionUnitId: "lqu", logicalQuestionRevision: 1,
};

const question = "What is HNSW?";
const unit: LogicalQuestionUnit = {
  id: "lqu", revision: 1, sessionId: "meeting", runtimeEpoch: 1,
  currentTurnId: "t1", sourceTurnIds: ["t1"], normalizedText: question,
  sources: [{ turnId: "t1", text: question, startedAt: 10, endedAt: 20 }],
  startedAt: 10, updatedAt: 20, compositionReasons: ["independent-current-turn"],
  boundaryReason: "independent-current-turn", truncated: false,
};
const request = buildQuestionTypeAdjudicationRequest({ logicalQuestionUnit: unit });
const valid = JSON.stringify({ v: 1, t: "field-knowledge", c: 0.96, e: "HNSW" });

function typeHarness(outputs: Array<string | number>, options: { costMs?: number; deadline?: number; current?: () => boolean; signal?: AbortSignal; reviewScope?: "full" | "field-vs-coding" } = {}) {
  let now = 1000;
  const calls: Array<{ params: any; id: any }> = [];
  const env: Record<string, unknown> = {
    Date: { now: () => now },
    OPERATION: getRuntimeInferenceOperationDefinition("question-type-adjudication"),
    buildQuestionTypeAdjudicationPrompts, parseQuestionTypeAdjudicationOutput, consumeRuntimeInferenceResponse,
    resolveAIResponseExecutionIdentity: () => identity,
    coordinateAIResponseAttempts: (input: any) => coordinateAIResponseAttempts({ ...input, now: () => now }),
    fetchAIResponseAttemptEvents: async function* (params: any, id: any) {
      const value = outputs[calls.length] ?? valid;
      calls.push({ params, id });
      const builder = new AIResponseEventBuilder("p", id, now);
      now += options.costMs ?? 400;
      if (typeof value === "number") {
        yield builder.terminal({ status: "failed", failureClass: value === 401 ? "authentication" : value === 429 ? "rate-limit" : "provider-http", retryable: value >= 500 || value === 429, statusCode: value }, now);
      } else {
        yield builder.content(value, now);
        yield builder.terminal({ status: "success", retryable: false }, now);
      }
    },
  };
  env.fetchAIResponseEvents = productionFunction("src/lib/functions/ai-response.function.ts", "fetchAIResponseEvents", env);
  env.requestRuntimeInferenceResponse = productionFunction("src/lib/meeting/runtime-inference-request.ts", "requestRuntimeInferenceResponse", env);
  const run = productionFunction("src/lib/meeting/question-type-adjudication-request.ts", "requestQuestionTypeAdjudication", env);
  return { calls, run: () => run({
    request: { ...request, reviewScope: options.reviewScope ?? "full" },
    provider: { id: "p" }, selectedProvider: { provider: "p", variables: {} },
    signal: options.signal ?? new AbortController().signal,
    timeoutMs: 6000, executionIdentity: identity,
    readRetryDeadlineAt: () => options.deadline ?? 5000,
    isExecutionCurrent: options.current ?? (() => true),
  }) };
}

test("Type retries 5xx or malformed content once through the production request and strict parser", async () => {
  for (const first of [503, '{"v":1,"t":"ai-ml-system-design","c":0.8']) {
    const h = typeHarness([first, valid]);
    const result = await h.run();
    assert.equal(h.calls.length, 2);
    assert.equal(result.parsed.ok, true);
    assert.equal(result.parsed.value.questionType, "field-knowledge");
    assert.equal(h.calls[1].params.systemPrompt, h.calls[0].params.systemPrompt);
    assert.equal(h.calls[1].params.userMessage, h.calls[0].params.userMessage);
    assert.equal(h.calls[1].id.requestId, h.calls[0].id.requestId);
    assert.notEqual(h.calls[1].id.attemptId, h.calls[0].id.attemptId);
    assert.equal(h.calls[1].params.requestOptions.timeoutMs, 3600);
    assert.equal(result.providerAttempts.length, 2);
  }
});

test("HTTP and JSON recovery share one extra attempt", async () => {
  const h = typeHarness([503, '{"v":1']);
  const result = await h.run();
  assert.equal(h.calls.length, 2);
  assert.equal(result.parsed.ok, false);
});

test("normal success, evidence mismatch, auth, 429, deadline and stale do not retry", async () => {
  for (const value of [valid, JSON.stringify({ v: 1, t: "coding", c: 0.95, e: "not in this question" }), 401, 429]) {
    const h = typeHarness([value]);
    await h.run();
    assert.equal(h.calls.length, 1);
  }
  const expired = typeHarness([503], { deadline: 1200 });
  await expired.run();
  assert.equal(expired.calls.length, 1);
  const stale = typeHarness([503], { current: () => false });
  await stale.run();
  assert.equal(stale.calls.length, 1);
});

test("Screen narrow recheck keeps its single-attempt policy", async () => {
  const h = typeHarness([503], { reviewScope: "field-vs-coding" });
  await h.run();
  assert.equal(h.calls.length, 1);
});

test("retry completion outside the original window cannot provide a Type candidate", async () => {
  const h = typeHarness([503, valid], { costMs: 600, deadline: 2000 });
  const result = await h.run();
  assert.equal(h.calls.length, 2);
  assert.equal(result.parsed.ok, false);
  assert.equal(result.providerOutcome.disposition, "stale");
});

test("a correction between attempts cancels before a second provider request", async () => {
  let reads = 0;
  const h = typeHarness([503, valid], { current: () => ++reads === 1 });
  await assert.rejects(h.run(), { name: "AbortError" });
  assert.equal(h.calls.length, 1);
});

test("a valid unexpected class is accepted without semantic reroll", async () => {
  const h = typeHarness([JSON.stringify({ v: 1, t: "ai-ml-system-design", c: 0.8, e: "HNSW" })]);
  const result = await h.run();
  assert.equal(h.calls.length, 1);
  assert.equal(result.parsed.value.questionType, "ai-ml-system-design");
});

test("recovered Type is settled once before the existing Relation matrix consumes it", async () => {
  for (const second of [valid, '{"v":1']) {
    const h = typeHarness([503, second]);
    const result = await h.run();
    const currentQuestion = createProvisionalCurrentQuestion({ logicalQuestionUnit: unit, sourceKind: "voice" });
    const settlement = result.parsed.ok ? settleCurrentQuestion({
      operationId: identity.requestId, currentQuestion,
      llmProposal: createQuestionTypeSettlementProposal({ currentQuestion, adjudication: result.parsed.value, expectedParentId: "rag-parent", expectedParentRevision: 1 }),
      activeParentId: "rag-parent", activeParentRevision: 1, manualCorrectionRevision: 0,
      policy: { allowRuntimeTypeAdjudication: true, runtimeTypeAdjudicationMinConfidence: 0, runtimeMutationAuthorized: false, questionComplete: true, commitParent: false },
    }) : undefined;
    const type = decideOrderedVoiceQuestionTypeResolution({ llmSettlement: settlement, llmAuthorized: Boolean(settlement?.typeMutationAuthorized), currentBranchType: "ai-ml-system-design" });
    const relation = decideFirstBatchRelationRelease({ currentQuestionType: type.questionType, activeParentQuestionType: "ai-ml-system-design", hasActiveChild: false, parentAffinity: { schemaVersion: 1, affinityKind: "parent", decision: "related", confidence: 0.95, currentEvidenceSpans: ["HNSW"], branchEvidenceSpans: ["retrieval"] } });
    assert.equal(type.questionType, second === valid ? "field-knowledge" : "ai-ml-system-design");
    assert.equal(relation.relation, second === valid ? "child-probe" : "followup-parent");
  }
});

test("production transport gives retry remaining time instead of another full timeout", async () => {
  let now = 1000;
  const budgets: number[] = [];
  const fetchEvents = productionFunction("src/lib/functions/ai-response.function.ts", "fetchAIResponseEvents", {
    Date: { now: () => now },
    resolveAIResponseExecutionIdentity: () => identity,
    coordinateAIResponseAttempts: (input: any) => coordinateAIResponseAttempts({ ...input, now: () => now }),
    fetchAIResponseAttemptEvents: async function* (params: any, attempt: any) {
      budgets.push(params.requestOptions.timeoutMs);
      const builder = new AIResponseEventBuilder("p", attempt, now);
      if (attempt.attemptNumber === 1) {
        now += 400;
        yield builder.terminal({ status: "failed", failureClass: "provider-http", retryable: true, statusCode: 503 }, now);
      } else {
        yield builder.content("ok", now);
        yield builder.terminal({ status: "success", retryable: false }, now);
      }
    },
  });
  const result = await consumeRuntimeInferenceResponse({
    responseEvents: fetchEvents({
      selectedProvider: { provider: "p" },
      requestOptions: { timeoutMs: 1000, retryPolicy: { maxAttempts: 2 }, readRetryDeadlineAt: () => 1800 },
    }),
    signal: new AbortController().signal, operationLabel: "Type",
  });
  assert.deepEqual(budgets, [1000, 400]);
  assert.equal(result.rawOutput, "ok");
  assert.equal(result.providerOutcome.attemptNumber, 2);
  assert.equal(result.providerOutcome.requestId, identity.requestId);
});

test("superseded Type runtime keeps both actual attempts without returning a result", async () => {
  let h: ReturnType<typeof typeHarness>;
  const runtime = new RuntimeInferenceOperationRuntime("question-type-adjudication");
  try {
    const settlement: any = await new Promise(resolve => runtime.schedule({
      job: { operationId: "type-op", operationKind: "question-type-adjudication", sessionId: "meeting", budgetKey: "lqu:1", budgetSlot: "type", budgetReason: "test" },
      execute: (_job, signal) => {
        h = typeHarness([503, valid], {
          signal,
          current: () => { if (h.calls.length === 2) runtime.cancelAll("superseded"); return true; },
        });
        return h.run();
      }, onSettled: resolve,
    }, 0));
    assert.equal(h!.calls.length, 2);
    assert.equal(settlement.result, undefined);
    assert.equal(settlement.disposition, "superseded");
    assert.ok(settlement.error instanceof MeetingAIResponseOutcomeError);
    assert.equal(settlement.error.name, "AbortError");
    assert.equal(settlement.error.attempts.length, 2);
    assert.equal(settlement.error.attempts[0].statusCode, 503);
  } finally {
    runtime.cancelAll("disposed");
  }
});

test("production Type lease accepts its provisional source and rejects newer manual or operation authority", () => {
  const file = ts.createSourceFile("hook.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);
  let declaration: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "authorizeTypeOperation") declaration = node;
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(declaration?.initializer);
  const operationRef = { current: { getCurrentOperationId: () => "type-op" } };
  const correctionRef = { current: 0 };
  const lease = createTaxonomyAdjudicationLease({ operationId: "type-op", sessionId: "meeting", runtimeEpoch: 1, logicalQuestionUnit: unit, manualCorrectionRevision: 0 });
  const authorize = vm.runInNewContext(ts.transpileModule(`(${declaration.initializer.getText(file)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    contextManagerRef: { current: { getState: () => ({ sessionId: "meeting" }) } },
    lease, authorizeTaxonomyAdjudicationLease,
    questionTypeAdjudicationRuntimeRef: operationRef, runtimeEpochRef: { current: 1 },
    authorizationLogicalQuestionUnit: unit, logicalQuestionUnitRef: { current: { ...unit, id: "older-global-unit" } },
    manualCorrectionRevisionRef: correctionRef,
  });
  assert.equal(authorize().authorized, true);
  correctionRef.current = 1;
  assert.equal(authorize().authorized, false);
  correctionRef.current = 0;
  operationRef.current.getCurrentOperationId = () => "new-type-op";
  assert.equal(authorize().authorized, false);
});
