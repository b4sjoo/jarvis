import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRuntimeInferenceModelInput,
  findRuntimeEnvelopeLeakage,
  formatRuntimeInferenceOperationForTrace,
  getRuntimeInferenceOperationDefinition,
  hashRuntimeSemanticPayload,
  serializeRuntimeSemanticPayload,
} from "../src/lib/meeting/runtime-inference.js";
import { RESPONSE_OPPORTUNITY_MAX_OUTPUT_TOKENS } from "../src/lib/meeting/short-intent-gate.js";
import {
  formatRuntimeInferenceCircuitForTrace,
  RuntimeInferenceSessionCircuitBreaker,
} from "../src/lib/meeting/runtime-inference-health.js";
import {
  RuntimeInferenceOperationRuntime,
  type RuntimeInferenceRuntimeJob,
} from "../src/lib/meeting/runtime-inference-runtime.js";
import {
  resolveRuntimeInferenceModelRouteFromSnapshot,
  type MeetingModelProviderSnapshot,
} from "../src/lib/meeting/meeting-model-route.js";
import {
  validateCrossSourceTransitionLease,
  type CrossSourceTransitionLease,
} from "../src/lib/meeting/runtime-inference-validation.js";

function runtimeJob(
  operationKind: RuntimeInferenceRuntimeJob["operationKind"],
  operationId: string
): RuntimeInferenceRuntimeJob {
  return {
    operationId,
    operationKind,
    sessionId: "session-a",
    budgetKey: "question-a",
    budgetSlot: "default",
    budgetReason: "test",
  };
}

test("registers each atomic runtime operation with an isolated policy", () => {
  const taxonomy = getRuntimeInferenceOperationDefinition(
    "taxonomy-adjudication"
  );
  const questionType = getRuntimeInferenceOperationDefinition(
    "question-type-adjudication"
  );
  const responseOpportunity = getRuntimeInferenceOperationDefinition(
    "response-opportunity-inference"
  );
  const metadata = getRuntimeInferenceOperationDefinition(
    "meeting-metadata-inference"
  );
  const projectSelection = getRuntimeInferenceOperationDefinition(
    "project-selection-inference"
  );
  const whiteboard = getRuntimeInferenceOperationDefinition(
    "whiteboard-syntax-repair"
  );
  const relation = getRuntimeInferenceOperationDefinition(
    "task-relation-adjudication"
  );
  const childAffinity = getRuntimeInferenceOperationDefinition(
    "task-relation-child-affinity"
  );
  const parentAffinity = getRuntimeInferenceOperationDefinition(
    "task-relation-parent-affinity"
  );
  const canonicalRelation = getRuntimeInferenceOperationDefinition(
    "task-relation-canonical-shadow"
  );
  const answerResolution = getRuntimeInferenceOperationDefinition(
    "answer-resolution"
  );
  const evidenceRequirement = getRuntimeInferenceOperationDefinition(
    "evidence-requirement"
  );
  const sourceLinkage = getRuntimeInferenceOperationDefinition(
    "source-linkage-adjudication"
  );

  assert.equal(taxonomy.lane, "critical");
  assert.equal(taxonomy.providerTier, "fast");
  assert.equal(taxonomy.quiescenceMs, 450);
  assert.equal(questionType.lane, "critical");
  assert.equal(questionType.providerTier, "intelligent");
  assert.equal(questionType.timeoutMs, 6_000);
  assert.equal(questionType.maxOutputTokens, 512);
  assert.equal(questionType.quiescenceMs, 350);
  assert.equal(responseOpportunity.lane, "critical");
  assert.equal(responseOpportunity.providerTier, "fast");
  assert.equal(responseOpportunity.timeoutMs, 3_000);
  assert.equal(
    responseOpportunity.maxOutputTokens,
    RESPONSE_OPPORTUNITY_MAX_OUTPUT_TOKENS
  );
  assert.equal(responseOpportunity.quiescenceMs, 0);
  assert.equal(metadata.lane, "background");
  assert.equal(metadata.timeoutMs, 5_000);
  assert.deepEqual(projectSelection, {
    workloadClass: "runtime",
    operationKind: "project-selection-inference",
    providerTier: "fast",
    lane: "critical",
    timeoutMs: 3_000,
    maxOutputTokens: 512,
    quiescenceMs: 0,
    maxStartsPerBudgetSlot: 1,
  });
  assert.equal(whiteboard.timeoutMs, 3_000);
  assert.equal(whiteboard.maxOutputTokens, 768);
  assert.equal(relation.lane, "critical");
  assert.equal(childAffinity.lane, "evaluation");
  assert.equal(parentAffinity.lane, "evaluation");
  assert.equal(canonicalRelation.lane, "evaluation");
  assert.equal(childAffinity.providerTier, "intelligent");
  assert.equal(parentAffinity.providerTier, "intelligent");
  assert.equal(canonicalRelation.providerTier, "intelligent");
  assert.equal(childAffinity.timeoutMs, 7_000);
  assert.equal(parentAffinity.timeoutMs, 7_000);
  assert.equal(canonicalRelation.timeoutMs, 6_000);
  assert.equal(relation.timeoutMs, 5_000);
  assert.equal(relation.maxOutputTokens, 512);
  assert.equal(childAffinity.maxOutputTokens, 1024);
  assert.equal(parentAffinity.maxOutputTokens, 1024);
  assert.equal(canonicalRelation.maxOutputTokens, 1024);
  assert.equal(answerResolution.lane, "background");
  assert.equal(answerResolution.timeoutMs, 1_500);
  assert.equal(answerResolution.maxOutputTokens, 512);
  assert.equal(evidenceRequirement.lane, "critical");
  assert.equal(evidenceRequirement.timeoutMs, 3_000);
  assert.equal(evidenceRequirement.maxOutputTokens, 256);
  assert.equal(sourceLinkage.lane, "critical");
  assert.equal(sourceLinkage.timeoutMs, 2_000);
  assert.equal(sourceLinkage.maxOutputTokens, 256);
  assert.equal(relation.quiescenceMs, 350);
});

test("validates cross-source transitions against both source identities", () => {
  const lease: CrossSourceTransitionLease = {
    operationKind: "source-linkage-adjudication",
    sessionId: "session-a",
    runtimeEpoch: 4,
    operationRevision: 2,
    from: {
      logicalQuestionUnitId: "voice-question",
      logicalQuestionRevision: 3,
      sourceHash: "voice-source-hash",
    },
    to: {
      evidenceId: "screen-observation",
      evidenceHash: "screen-evidence-hash",
    },
    sourceSettlementId: "source-settlement-a",
  };

  assert.equal(
    validateCrossSourceTransitionLease({ lease, current: { ...lease } })
      .authorized,
    true
  );
  assert.deepEqual(
    validateCrossSourceTransitionLease({
      lease,
      current: {
        ...lease,
        to: { ...lease.to, evidenceId: "newer-screen" },
      },
    }).mismatchedFacets,
    ["transition-to-evidence"]
  );
  assert.deepEqual(
    validateCrossSourceTransitionLease({
      lease,
      current: {
        ...lease,
        from: { ...lease.from, sourceHash: "replaced-voice" },
        to: { ...lease.to, evidenceHash: "replaced-screen" },
        sourceSettlementId: "replaced-settlement",
      },
    }).mismatchedFacets,
    [
      "transition-from-source-hash",
      "transition-to-evidence-hash",
      "transition-source-settlement",
    ]
  );
});

test("serializes semantic payloads deterministically", () => {
  const left = {
    currentQuestion: { sourceTexts: ["What would you monitor?"] },
    activeParent: { objective: "Explain reliability.", topic: "Oasis" },
  };
  const right = {
    activeParent: { topic: "Oasis", objective: "Explain reliability." },
    currentQuestion: { sourceTexts: ["What would you monitor?"] },
  };

  assert.equal(
    serializeRuntimeSemanticPayload(left),
    serializeRuntimeSemanticPayload(right)
  );
  assert.equal(hashRuntimeSemanticPayload(left), hashRuntimeSemanticPayload(right));
});

test("keeps runtime envelope fields out of model-visible semantic payloads", () => {
  const clean = {
    sourceSpans: [{ index: 0, text: "Design a cache." }],
    activeParent: { topic: "Caching" },
  };
  assert.deepEqual(findRuntimeEnvelopeLeakage(clean), []);

  const modelInput = buildRuntimeInferenceModelInput({
    systemPrompt: "Classify one bounded input.",
    semanticPayload: clean,
  });
  assert.equal(modelInput.userMessage.includes("Design a cache."), true);
  assert.equal(modelInput.semanticPayloadDigest, hashRuntimeSemanticPayload(clean));
  assert.equal(
    modelInput.modelVisibleChars,
    modelInput.systemPrompt.length + modelInput.userMessage.length
  );

  assert.deepEqual(
    findRuntimeEnvelopeLeakage({
      sourceHash: "opaque",
      nested: { parentRevision: 3, text: "Keep this." },
    }),
    ["sourceHash", "nested.parentRevision"]
  );
  assert.throws(
    () =>
      buildRuntimeInferenceModelInput({
        systemPrompt: "Classify one bounded input.",
        semanticPayload: { logicalQuestionUnitId: "question-a", text: "Hi" },
      }),
    /envelope-only fields: logicalQuestionUnitId/
  );
});

test("isolates quota consumption by operation", async () => {
  const taxonomy = new RuntimeInferenceOperationRuntime<
    RuntimeInferenceRuntimeJob,
    string
  >("taxonomy-adjudication");
  const metadata = new RuntimeInferenceOperationRuntime<
    RuntimeInferenceRuntimeJob,
    string
  >("meeting-metadata-inference");
  const questionType = new RuntimeInferenceOperationRuntime<
    RuntimeInferenceRuntimeJob,
    string
  >("question-type-adjudication");
  const taskRelation = new RuntimeInferenceOperationRuntime<
    RuntimeInferenceRuntimeJob,
    string
  >("task-relation-adjudication");
  const responseOpportunity = new RuntimeInferenceOperationRuntime<
    RuntimeInferenceRuntimeJob,
    string
  >("response-opportunity-inference");
  const settlements: string[] = [];

  const schedule = (
    runtime: RuntimeInferenceOperationRuntime<
      RuntimeInferenceRuntimeJob,
      string
    >,
    job: RuntimeInferenceRuntimeJob
  ) => {
    runtime.schedule(
      {
        job,
        execute: async () => job.operationId,
        onSettled: (settlement) =>
          settlements.push(
            `${job.operationKind}:${settlement.disposition}`
          ),
      },
      0
    );
  };

  schedule(
    taxonomy,
    runtimeJob("taxonomy-adjudication", "taxonomy-1")
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  schedule(
    taxonomy,
    runtimeJob("taxonomy-adjudication", "taxonomy-2")
  );
  schedule(
    metadata,
    runtimeJob("meeting-metadata-inference", "metadata-1")
  );
  schedule(
    questionType,
    runtimeJob("question-type-adjudication", "question-type-1")
  );
  schedule(
    taskRelation,
    runtimeJob("task-relation-adjudication", "task-relation-1")
  );
  schedule(
    responseOpportunity,
    runtimeJob(
      "response-opportunity-inference",
      "response-opportunity-1"
    )
  );
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.deepEqual(settlements, [
    "taxonomy-adjudication:completed",
    "taxonomy-adjudication:budget-exhausted",
    "meeting-metadata-inference:completed",
    "question-type-adjudication:completed",
    "task-relation-adjudication:completed",
    "response-opportunity-inference:completed",
  ]);
});

test("isolates one-start quotas by budget slot within the same question", async () => {
  const runtime = new RuntimeInferenceOperationRuntime<
    RuntimeInferenceRuntimeJob,
    string
  >("task-relation-adjudication");
  const dispositions: string[] = [];
  const schedule = (operationId: string, budgetSlot: string) => {
    runtime.schedule(
      {
        job: {
          ...runtimeJob("task-relation-adjudication", operationId),
          budgetSlot,
        },
        execute: async () => operationId,
        onSettled: (settlement) =>
          dispositions.push(settlement.disposition),
      },
      0
    );
  };

  schedule("correction-7", "manual-correction:7");
  await new Promise((resolve) => setTimeout(resolve, 5));
  schedule("correction-8", "manual-correction:8");
  await new Promise((resolve) => setTimeout(resolve, 5));
  schedule("correction-8-duplicate", "manual-correction:8");
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(dispositions, [
    "completed",
    "completed",
    "budget-exhausted",
  ]);
});

test("rejects an operation submitted to the wrong runtime", () => {
  const runtime = new RuntimeInferenceOperationRuntime<
    RuntimeInferenceRuntimeJob,
    string
  >("taxonomy-adjudication");
  let disposition = "";

  runtime.schedule({
    job: runtimeJob(
      "meeting-metadata-inference",
      "metadata-wrong-lane"
    ),
    execute: async () => "unexpected",
    onSettled: (settlement) => {
      disposition = settlement.disposition;
    },
  });

  assert.equal(disposition, "operation-mismatch");
});

test("project selection uses the existing runtime budget once per final Me slot, including failure", async () => {
  const runtime = new RuntimeInferenceOperationRuntime<RuntimeInferenceRuntimeJob, string>(
    "project-selection-inference"
  );
  let calls = 0;
  const schedule = (turn: string, fail = false) => new Promise<string>((resolve) => {
    runtime.schedule({
      job: {
        ...runtimeJob("project-selection-inference", `selection-${calls}-${turn}`),
        budgetKey: "pending-parent:binding-0",
        budgetSlot: `final-me:${turn}`,
      },
      execute: async () => {
        calls++;
        if (fail) throw new Error("fixture provider failure");
        return "proposal";
      },
      onSettled: (settlement) => resolve(settlement.disposition),
    });
  });
  assert.equal(await schedule("turn-1", true), "error");
  assert.equal(await schedule("turn-1"), "budget-exhausted");
  assert.equal(await schedule("turn-2"), "completed");
  assert.equal(await schedule("turn-2"), "budget-exhausted");
  assert.equal(calls, 2);
  runtime.cancelAll();
});

test("isolates provider circuits by operation and session", () => {
  const circuit = new RuntimeInferenceSessionCircuitBreaker();
  const opened = circuit.open({
    operationKind: "taxonomy-adjudication",
    sessionId: "session-a",
    reason: "provider-auth-error",
    now: 100,
  });
  const metadata = circuit.read(
    "meeting-metadata-inference",
    "session-a"
  );
  const nextSession = circuit.read(
    "taxonomy-adjudication",
    "session-b"
  );

  assert.equal(opened.state.open, true);
  assert.equal(metadata.open, false);
  assert.equal(nextSession.open, false);
  assert.equal(
    formatRuntimeInferenceCircuitForTrace(
      opened.state,
      opened.newlyOpened
    ).runtimeInferenceCircuitOperationKind,
    "taxonomy-adjudication"
  );
});

test("routes Fast Runtime work through the override and Intelligent work through Main Advisor", () => {
  const snapshot: MeetingModelProviderSnapshot = {
    providers: [
      {
        id: "shared",
        curl:
          'curl https://example.test -H "Authorization: {{API_KEY}}"',
      },
    ],
    selectedProvider: {
      provider: "shared",
      variables: { API_KEY: "secret", MODEL: "advisor" },
    },
    codingProvider: {
      provider: "shared",
      variables: { API_KEY: "secret", MODEL: "coding" },
    },
    taxonomyAdjudicationProvider: {
      provider: "shared",
      variables: { MODEL: "runtime" },
    },
  };
  const fastRoute = resolveRuntimeInferenceModelRouteFromSnapshot({
    snapshot,
    operationKind: "task-relation-adjudication",
  });
  const intelligentRoute = resolveRuntimeInferenceModelRouteFromSnapshot({
    snapshot,
    operationKind: "question-type-adjudication",
  });
  const projectSelectionRoute = resolveRuntimeInferenceModelRouteFromSnapshot({
    snapshot,
    operationKind: "project-selection-inference",
  });

  assert.equal(fastRoute.route, "runtime-inference-override");
  assert.equal(fastRoute.providerTier, "fast");
  assert.equal(fastRoute.selectedProvider.variables.MODEL, "runtime");
  assert.equal(projectSelectionRoute.route, fastRoute.route);
  assert.equal(projectSelectionRoute.providerTier, "fast");
  assert.deepEqual(projectSelectionRoute.selectedProvider, fastRoute.selectedProvider);
  assert.equal(intelligentRoute.route, "main");
  assert.equal(intelligentRoute.providerTier, "intelligent");
  assert.equal(intelligentRoute.provider?.id, "shared");
  assert.equal(intelligentRoute.selectedProvider.variables.API_KEY, "secret");
  assert.equal(intelligentRoute.selectedProvider.variables.MODEL, "advisor");
  assert.notEqual(
    fastRoute.configFingerprint,
    intelligentRoute.configFingerprint
  );
});

test("formats stable generic telemetry for the existing taxonomy operation", () => {
  assert.deepEqual(
    formatRuntimeInferenceOperationForTrace("taxonomy-adjudication"),
    {
      modelWorkloadClass: "runtime",
      runtimeInferenceOperationKind: "taxonomy-adjudication",
      runtimeInferenceProviderTier: "fast",
      runtimeInferenceLane: "critical",
      runtimeInferenceTimeoutMs: 4_000,
      runtimeInferenceMaxOutputTokens: 256,
      runtimeInferenceQuiescenceMs: 450,
      runtimeInferenceMaxStartsPerBudgetSlot: 1,
    }
  );
});
