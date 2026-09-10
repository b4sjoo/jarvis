import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { AIResponseEventBuilder, coordinateAIResponseAttempts } from "../src/lib/functions/ai-response-events.js";
import { consumeRuntimeInferenceResponse } from "../src/lib/meeting/runtime-inference-response.js";
import { getRuntimeInferenceOperationDefinition } from "../src/lib/meeting/runtime-inference.js";
import * as opportunity from "../src/lib/meeting/short-intent-gate.js";
import * as questionType from "../src/lib/meeting/question-type-adjudication.js";
import * as metadata from "../src/lib/meeting/meeting-metadata-inference.js";
import * as recovery from "../src/lib/meeting/answer-recovery-adjudication.js";
import * as linkage from "../src/lib/meeting/source-linkage-adjudication.js";
import * as split from "../src/lib/meeting/task-relation-split-shadow.js";
import * as whiteboard from "../src/lib/meeting/whiteboard-syntax-repair.js";
import { buildTaskRelationAdjudicationRequest } from "../src/lib/meeting/task-relation-adjudication.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import type { ActiveMeetingTask } from "../src/lib/meeting/meeting-task-contracts.js";

function productionFunction(file: string, name: string, env: Record<string, unknown>): any {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const node = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name);
  return vm.runInNewContext(ts.transpileModule(
    node.getText(source).replace(/^export\s+/, "") + `\n${name};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
  ).outputText, env);
}

const unit: LogicalQuestionUnit = {
  id: "question", revision: 2, sessionId: "session", runtimeEpoch: 1,
  currentTurnId: "turn", sourceTurnIds: ["turn"], normalizedText: "Explain lines 8 through 12.",
  sources: [{ turnId: "turn", text: "Explain lines 8 through 12.", startedAt: 10, endedAt: 20 }],
  startedAt: 10, updatedAt: 20, compositionReasons: ["independent-current-turn"],
  boundaryReason: "independent-current-turn", truncated: false,
};
const task: ActiveMeetingTask = {
  id: "parent", runtimeRevision: 1, source: "voice",
  parent: { id: "parent", questionType: "coding", topic: "Implement a cache", playbookPhase: "implementation_validation", phaseProgress: {}, supportedFactAnchors: [], createdAt: 1, updatedAt: 1 },
  child: { id: "child", questionType: "field-knowledge", relation: "child-probe", question: "Explain eviction", intent: "concept-probe", basedOnTurnIds: [], basedOnObservationIds: [], createdAt: 1, updatedAt: 1 },
};
const relation = buildTaskRelationAdjudicationRequest({ logicalQuestionUnit: unit, activeMeetingTask: task });
const splitInput = { request: relation, sessionId: "session", runtimeEpoch: 1, manualCorrectionRevision: 0 };
const affinities = split.buildTaskRelationAffinityRequests(splitInput);
const ro = opportunity.buildResponseOpportunityRequest({ logicalQuestionUnit: unit });
const qt = questionType.buildQuestionTypeAdjudicationRequest({ logicalQuestionUnit: unit });
const mm = metadata.buildMeetingMetadataInferenceRequest({
  sessionId: "session",
  evidence: metadata.projectMeetingMetadataOpeningEvidence({
    transcriptTurns: [{ id: "intro", speaker: "them", text: "I am from Acme.", startedAt: 10, endedAt: 20, isFinal: true, source: "system-audio" }],
    sessionStartedAt: 1,
  }),
});
const ar = recovery.buildAnswerRecoveryAdjudicationRequest({ operationKind: "answer-resolution", logicalQuestionUnitId: unit.id, logicalQuestionUnitRevision: 2, answerRevision: 1, questionText: unit.normalizedText, answerText: "Please provide the code." });
const ve = recovery.buildVisualEvidenceCheckRequest({ logicalQuestionUnitId: unit.id, logicalQuestionUnitRevision: 2, questionSourceHash: "source", questionText: unit.normalizedText });
const sl = linkage.buildSourceLinkageAdjudicationRequest({ logicalQuestionUnitId: unit.id, logicalQuestionUnitRevision: 2, screenObservationId: "screen", voiceSourceHash: "voice", voiceQuestion: unit.normalizedText, screenQuestion: "Implement cache", screenEvidenceSummary: "Lines 8 through 12 show eviction." });
const wb = whiteboard.createWhiteboardSyntaxRepairRequest({ whiteboard: "```mermaid\nflowchart TD\nA --> B\n```", parserError: "fixture syntax error" });

const cases: Array<{ kind: any; file: string; fn: string; request: any; prompts: any }> = [
  { kind: "response-opportunity-inference", file: "short-intent-gate-request", fn: "requestResponseOpportunity", request: ro, prompts: opportunity.buildResponseOpportunityPrompts(ro) },
  { kind: "question-type-adjudication", file: "question-type-adjudication-request", fn: "requestQuestionTypeAdjudication", request: qt, prompts: questionType.buildQuestionTypeAdjudicationPrompts(qt) },
  { kind: "meeting-metadata-inference", file: "meeting-metadata-inference-request", fn: "requestMeetingMetadataInference", request: mm, prompts: metadata.buildMeetingMetadataInferencePrompts(mm) },
  ...[ar, ve].map(request => ({ kind: request!.operationKind, file: "answer-recovery-adjudication-request", fn: "requestAnswerRecoveryAdjudication", request, prompts: recovery.buildAnswerRecoveryAdjudicationPrompts(request!) })),
  { kind: "source-linkage-adjudication", file: "source-linkage-adjudication-request", fn: "requestSourceLinkageAdjudication", request: sl, prompts: linkage.buildSourceLinkageAdjudicationPrompts(sl!) },
  ...[affinities.parent, affinities.child!].map(request => ({ kind: request.operationKind, file: "task-relation-split-shadow-request", fn: "requestTaskRelationSplitShadow", request, prompts: split.buildTaskRelationAffinityPrompts(request) })),
  { kind: "task-relation-canonical-shadow", file: "task-relation-split-shadow-request", fn: "requestTaskRelationSplitShadow", request: split.buildTaskRelationCanonicalShadowRequest(splitInput), prompts: split.buildTaskRelationCanonicalShadowPrompts(split.buildTaskRelationCanonicalShadowRequest(splitInput)) },
  { kind: "whiteboard-syntax-repair", file: "whiteboard-syntax-repair-request", fn: "requestWhiteboardSyntaxRepair", request: wb, prompts: whiteboard.buildWhiteboardSyntaxRepairPrompts(wb!) },
];

test("all live inference adapters use one request/collection entry", () => {
  const files = new Set(cases.map(c => c.file));
  assert.equal(files.size, 7);
  assert.equal(cases.length, 10);
  for (const file of files) {
    const path = `src/lib/meeting/${file}.ts`;
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const imports = source.statements.filter(ts.isImportDeclaration);
    assert.equal(imports.filter(node => ts.isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text === "./runtime-inference-request.js").length, 1, path);
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node)) {
        assert.ok(!["fetchAIResponseEvents", "consumeRuntimeInferenceResponse"].includes(node.expression.getText(source)), path);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
});

function harness(c: typeof cases[number], status: "content" | "empty" | "auth" | "abort") {
  const requests: any[] = [];
  const collectorInputs: any[] = [];
  const operation = getRuntimeInferenceOperationDefinition(c.kind);
  const env: Record<string, unknown> = {
    ...opportunity, ...questionType, ...metadata, ...recovery, ...linkage, ...split, ...whiteboard,
    Date, Error, JSON, getRuntimeInferenceOperationDefinition, OPERATION: operation,
    WHITEBOARD_REPAIR_OPERATION: operation,
    resolveAIResponseExecutionIdentity: (input: any) => ({ ...input.executionIdentity, requestId: "request", executionPlanId: "plan", modelId: "model", runtimeEpoch: 1 }),
    coordinateAIResponseAttempts,
    consumeRuntimeInferenceResponse: (input: any) => { collectorInputs.push(input); return consumeRuntimeInferenceResponse(input); },
    fetchAIResponseAttemptEvents: async function* (_input: unknown, id: any) {
      const builder = new AIResponseEventBuilder("provider", id);
      if (status === "content") yield builder.content("{}");
      yield builder.terminal(status === "abort" ? { status: "aborted", retryable: false }
        : status === "auth" ? { status: "failed", failureClass: "authentication", retryable: false, statusCode: 401 }
        : { status: status === "empty" ? "empty" : "success", retryable: false });
    },
  };
  const transport = productionFunction("src/lib/functions/ai-response.function.ts", "fetchAIResponseEvents", env);
  env.fetchAIResponseEvents = (input: any) => { requests.push(input); return transport(input); };
  env.requestRuntimeInferenceResponse = productionFunction("src/lib/meeting/runtime-inference-request.ts", "requestRuntimeInferenceResponse", env);
  return { requests, collectorInputs, operation, run: productionFunction(`src/lib/meeting/${c.file}.ts`, c.fn, env) };
}

for (const c of cases) {
  test(`production ${c.kind} keeps its parameters and terminal through common request wiring`, async () => {
    assert.ok(c.request);
    for (const status of ["content", "empty", "auth", "abort"] as const) {
      const h = harness(c, status);
      const signal = new AbortController().signal;
      const selectedProvider = { provider: "provider", variables: { model: "model" } };
      let tokens = 0;
      const resultPromise = h.run({ request: c.request, provider: { id: "provider" }, selectedProvider, signal, onFirstToken: () => tokens++, ...(c.kind === "question-type-adjudication" ? { timeoutMs: 7777, maxOutputTokens: 1024 } : {}) });
      if (status === "abort") await assert.rejects(resultPromise, { name: "AbortError" });
      else {
        const result = await resultPromise;
        assert.equal(result.providerDisposition, status === "auth" ? "provider-auth-error" : status === "empty" ? "completed-empty" : "completed-with-content");
        assert.equal(result.rawOutput, status === "content" ? "{}" : "");
        assert.equal(result.parsed.ok, false);
        assert.ok(result.providerOutcome);
        if (c.kind !== "whiteboard-syntax-repair") assert.equal(result.providerAttempts.length, 1);
      }
      assert.equal(h.requests.length, 1);
      const sent = h.requests[0];
      assert.equal(sent.systemPrompt, c.prompts.systemPrompt);
      assert.equal(sent.userMessage, c.prompts.userMessage);
      assert.equal(sent.selectedProvider, selectedProvider);
      assert.equal(sent.signal, signal);
      assert.equal(sent.applyResponseSettings, false);
      assert.equal(sent.requestOptions.timeoutMs, c.kind === "question-type-adjudication" ? 7777 : h.operation.timeoutMs);
      assert.equal(sent.requestOptions.maxOutputTokens, c.kind === "question-type-adjudication" ? 1024 : h.operation.maxOutputTokens);
      assert.equal("operationLabel" in sent, false);
      assert.equal("onFirstToken" in sent, false);
      assert.equal(tokens, status === "content" ? 1 : 0);
      if (c.kind === "meeting-metadata-inference") {
        assert.equal(sent.executionIdentity.logicalQuestionUnitId, "meeting-metadata:session");
        assert.equal(sent.executionIdentity.logicalQuestionRevision, c.request.operationRevision);
      } else if (c.kind !== "whiteboard-syntax-repair") {
        assert.equal(sent.executionIdentity.logicalQuestionUnitId, unit.id);
        assert.equal(sent.executionIdentity.logicalQuestionRevision, unit.revision);
      }
      assert.equal(h.collectorInputs[0].maxOutputChars, c.kind === "whiteboard-syntax-repair" ? whiteboard.WHITEBOARD_SYNTAX_REPAIR_MAX_RAW_OUTPUT_CHARS : undefined);
    }
  });
}
