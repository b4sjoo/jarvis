import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as questionType from "../src/lib/meeting/question-type-adjudication.js";
import * as taxonomy from "../src/lib/meeting/taxonomy-adjudication.js";
import * as inference from "../src/lib/meeting/runtime-inference.js";
import * as routes from "../src/lib/meeting/meeting-model-route.js";
import { normalizeCanonicalQuestionType } from "../src/lib/meeting/task-taxonomy.js";
import { RuntimeInferenceOperationRuntime } from "../src/lib/meeting/runtime-inference-runtime.js";
import { RuntimeInferenceProviderAdmissionCoordinator } from "../src/lib/meeting/runtime-inference-provider-admission.js";

const snapshot = {
  providers: [{ id: "main", curl: "https://main.test" }, { id: "fast", curl: "https://fast.test" }, { id: "coding", curl: "https://coding.test" }],
  selectedProvider: { provider: "main", variables: { model: "intelligent" } },
  taxonomyAdjudicationProvider: { provider: "fast", variables: { model: "fast" } },
  codingProvider: { provider: "coding", variables: { model: "coding-only" } },
};
const source = ts.createSourceFile("hook.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);
let callback = "";
function find(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "scheduleQuestionTypeAdjudication") {
    assert.ok(node.initializer && ts.isCallExpression(node.initializer));
    callback = node.initializer.arguments[0].getText(source);
  }
  ts.forEachChild(node, find);
}
find(source);
assert.ok(callback);

for (const [label, options, expected] of [
  ["default Voice", {}, "fast"],
  ["Replay shared Voice", { sourceKind: "voice" }, "fast"],
  ["Screen narrow", { sourceKind: "screen", automaticQuestionType: "field-knowledge" }, "intelligent"],
  ["Screen full", { sourceKind: "screen" }, "intelligent"],
  ["mixed", { sourceKind: "mixed" }, "intelligent"],
  ["Correction inference", { forceRuntimeExecution: true }, "intelligent"],
] as const) {
  test(`FR1/FR2 ${label}: production scheduler uses one route for request, admission and trace`, async () => {
    const metadata: Record<string, unknown> = {};
    let scheduled: any, requestInput: any;
    const environment = {
      ...questionType, ...taxonomy, ...inference, ...routes, Date, Promise,
      normalizeCanonicalQuestionType,
      contextManagerRef: { current: { clearExpiredActiveMeetingTask() {}, getState: () => ({ sessionId: "session" }) } },
      taxonomyAdjudicationSettingsRef: { current: { questionTypeMode: "enforcement" } },
      manualCorrectionOperationCoordinatorRef: { current: { getActiveOperationId: () => undefined } },
      questionTypeAdjudicationCircuitRef: { current: { read: () => ({ open: false }) } },
      questionTypeAdjudicationCandidateCacheRef: { current: { read: () => undefined } },
      meetingModelProviderSnapshotRef: { current: snapshot },
      runtimeEpochRef: { current: 1 }, manualCorrectionRevisionRef: { current: 0 },
      sessionRecordingManagerRef: { current: null },
      traceStoreRef: { current: { updateMetadata: (_id: string, value: object) => Object.assign(metadata, value), recordInput() {} } },
      questionTypeAdjudicationRuntimeRef: { current: { schedule: (value: unknown) => { scheduled = value; } } },
      formatRuntimeInferenceCircuitForTrace: () => ({}), formatRuntimeAxisConflictForTrace: () => ({}),
      decideQuestionTypeAdjudicationEligibility: () => ({ eligible: true, executionMode: "enforcement-window", triggerReasons: [] }),
      readSelectedProviderModelId: (selected: any) => selected.variables.model,
      requestQuestionTypeAdjudication: async (input: any) => { requestInput = input; return { ok: true }; },
      QUESTION_TYPE_ENFORCEMENT_WAIT_BUDGET_MS: 4000,
      VOICE_ORDERED_RELATION_FOREGROUND_BUDGET_MS: 4000,
      SCREEN_FIELD_KNOWLEDGE_REVIEW_WAIT_BUDGET_MS: 4000,
      SCREEN_FIELD_KNOWLEDGE_REVIEW_PROVIDER_TIMEOUT_MS: 6000,
    };
    const schedule = vm.runInNewContext(ts.transpileModule(`(${callback})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, environment);
    const text = "Implement an LRU cache.";
    const unit = { id: "lqu", revision: 1, sessionId: "session", runtimeEpoch: 1, currentTurnId: "turn", sourceTurnIds: ["turn"], normalizedText: text,
      sources: [{ turnId: "turn", text, startedAt: 1, endedAt: 2 }], startedAt: 1, updatedAt: 2, compositionReasons: [], boundaryReason: "independent-current-turn", truncated: false };
    schedule({ turn: { speaker: "them" }, traceId: "trace", turnGateAction: "answer-refresh", logicalQuestionUnit: unit,
      lexical: { type: "coding", confidence: 1, certainty: "known" }, ...options });
    assert.ok(scheduled);
    assert.equal(scheduled.job.providerTier, expected);
    assert.equal(metadata.runtimeInferenceProviderTier, expected);
    const coordinator = new RuntimeInferenceProviderAdmissionCoordinator(3, 0);
    const fast = routes.resolveRuntimeInferenceModelRouteFromSnapshot({ snapshot, operationKind: "question-type-adjudication", providerTier: "fast" });
    const intelligent = routes.resolveRuntimeInferenceModelRouteFromSnapshot({ snapshot, operationKind: "question-type-adjudication" });
    coordinator.configureProviderGroups({ fastFingerprint: fast.configFingerprint, intelligentFingerprint: intelligent.configFingerprint });
    const runtime = new RuntimeInferenceOperationRuntime("question-type-adjudication", coordinator);
    try {
      const settled: any = await new Promise(resolve => runtime.schedule({ job: scheduled.job, execute: scheduled.execute, onSettled: resolve }, 0));
      assert.equal(settled.disposition, "completed");
      assert.equal(settled.sharedAdmission.providerTier, expected);
      assert.equal(requestInput.provider.id, expected === "fast" ? "fast" : "main");
      assert.equal(requestInput.selectedProvider.variables.model, expected);
      assert.equal(requestInput.request.promptVersion, questionType.QUESTION_TYPE_ADJUDICATION_PROMPT_VERSION);
      assert.equal(metadata.runtimeInferenceProviderConfigFingerprint, expected === "fast" ? fast.configFingerprint : intelligent.configFingerprint);
      assert.notEqual(requestInput.provider.id, "coding");
      assert.equal(inference.getRuntimeInferenceOperationDefinition("question-type-adjudication").providerTier, "intelligent");
      assert.equal(inference.getRuntimeInferenceOperationDefinition("question-type-adjudication").timeoutMs, 6000);
    } finally { runtime.cancelAll("disposed"); }
  });
}
