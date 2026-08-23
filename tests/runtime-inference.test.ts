import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRuntimeInferenceModelInput,
  createRuntimeInferenceContextSnapshot,
  createRuntimeInferenceInvocation,
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
  const whiteboard = getRuntimeInferenceOperationDefinition(
    "whiteboard-syntax-repair"
  );
  const relation = getRuntimeInferenceOperationDefinition(
    "task-relation-adjudication"
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
  assert.equal(taxonomy.quiescenceMs, 450);
  assert.equal(questionType.lane, "critical");
  assert.equal(questionType.timeoutMs, 3_000);
  assert.equal(questionType.maxOutputTokens, 128);
  assert.equal(questionType.quiescenceMs, 350);
  assert.equal(responseOpportunity.lane, "critical");
  assert.equal(responseOpportunity.timeoutMs, 1_500);
  assert.equal(
    responseOpportunity.maxOutputTokens,
    RESPONSE_OPPORTUNITY_MAX_OUTPUT_TOKENS
  );
  assert.equal(responseOpportunity.quiescenceMs, 0);
  assert.equal(metadata.lane, "background");
  assert.equal(whiteboard.timeoutMs, 3_000);
  assert.equal(whiteboard.maxOutputTokens, 768);
  assert.equal(relation.lane, "critical");
  assert.equal(relation.timeoutMs, 3_000);
  assert.equal(relation.maxOutputTokens, 256);
  assert.equal(answerResolution.lane, "background");
  assert.equal(answerResolution.timeoutMs, 1_500);
  assert.equal(answerResolution.maxOutputTokens, 256);
  assert.equal(evidenceRequirement.lane, "background");
  assert.equal(evidenceRequirement.timeoutMs, 1_500);
  assert.equal(evidenceRequirement.maxOutputTokens, 256);
  assert.equal(sourceLinkage.lane, "critical");
  assert.equal(sourceLinkage.timeoutMs, 1_500);
  assert.equal(relation.quiescenceMs, 350);
});

test("builds immutable shared snapshots and operation-specific requests", () => {
  const snapshot = createRuntimeInferenceContextSnapshot({
    id: "snapshot-a",
    hash: "hash-a",
    sessionId: "session-a",
    runtimeEpoch: 3,
    revision: 4,
    createdAt: 100,
    payload: { latestTurnId: "turn-a" },
  });
  const taxonomy = createRuntimeInferenceInvocation({
    requestId: "request-taxonomy",
    operationKind: "taxonomy-adjudication",
    contextSnapshot: snapshot,
    operationRevision: 1,
    semanticPayload: { question: "Design a cache." },
  });
  const metadata = createRuntimeInferenceInvocation({
    requestId: "request-metadata",
    operationKind: "meeting-metadata-inference",
    contextSnapshot: snapshot,
    operationRevision: 1,
    semanticPayload: { company: "Reddit" },
  });

  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.payload), true);
  assert.equal(Object.isFrozen(taxonomy), true);
  assert.equal(Object.isFrozen(taxonomy.envelope), true);
  assert.equal(Object.isFrozen(taxonomy.semanticPayload), true);
  assert.equal(
    taxonomy.envelope.contextSnapshotId,
    metadata.envelope.contextSnapshotId
  );
  assert.equal(
    taxonomy.envelope.contextSnapshotHash,
    metadata.envelope.contextSnapshotHash
  );
  assert.equal(taxonomy.envelope.lane, "critical");
  assert.equal(metadata.envelope.lane, "background");
  assert.equal(
    taxonomy.envelope.semanticPayloadDigest,
    hashRuntimeSemanticPayload(taxonomy.semanticPayload)
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

test("resolves every runtime operation through the compatible taxonomy override", () => {
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
    codingProvider: { provider: "", variables: {} },
    taxonomyAdjudicationProvider: {
      provider: "shared",
      variables: { MODEL: "runtime" },
    },
  };
  const route = resolveRuntimeInferenceModelRouteFromSnapshot({
    snapshot,
    operationKind: "task-relation-adjudication",
  });

  assert.equal(route.route, "runtime-inference-override");
  assert.equal(route.operationKind, "task-relation-adjudication");
  assert.equal(route.provider?.id, "shared");
  assert.equal(route.selectedProvider.variables.API_KEY, "secret");
  assert.equal(route.selectedProvider.variables.MODEL, "runtime");
});

test("formats stable generic telemetry for the existing taxonomy operation", () => {
  assert.deepEqual(
    formatRuntimeInferenceOperationForTrace("taxonomy-adjudication"),
    {
      modelWorkloadClass: "runtime",
      runtimeInferenceOperationKind: "taxonomy-adjudication",
      runtimeInferenceLane: "critical",
      runtimeInferenceTimeoutMs: 4_000,
      runtimeInferenceMaxOutputTokens: 256,
      runtimeInferenceQuiescenceMs: 450,
      runtimeInferenceMaxStartsPerBudgetSlot: 1,
    }
  );
});
