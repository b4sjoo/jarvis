import assert from "node:assert/strict";
import test from "node:test";
import {
  createRuntimeInferenceContextSnapshot,
  createRuntimeInferenceRequest,
  formatRuntimeInferenceOperationForTrace,
  getRuntimeInferenceOperationDefinition,
} from "../src/lib/meeting/runtime-inference.js";
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
  const metadata = getRuntimeInferenceOperationDefinition(
    "meeting-metadata-inference"
  );
  const whiteboard = getRuntimeInferenceOperationDefinition(
    "whiteboard-syntax-repair"
  );
  const relation = getRuntimeInferenceOperationDefinition(
    "task-relation-adjudication"
  );

  assert.equal(taxonomy.lane, "critical");
  assert.equal(taxonomy.quiescenceMs, 450);
  assert.equal(questionType.lane, "critical");
  assert.equal(questionType.timeoutMs, 3_000);
  assert.equal(questionType.maxOutputTokens, 128);
  assert.equal(questionType.quiescenceMs, 350);
  assert.equal(metadata.lane, "background");
  assert.equal(whiteboard.timeoutMs, 3_000);
  assert.equal(whiteboard.maxOutputTokens, 768);
  assert.equal(relation.lane, "critical");
  assert.equal(relation.timeoutMs, 3_000);
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
  const taxonomy = createRuntimeInferenceRequest({
    requestId: "request-taxonomy",
    operationKind: "taxonomy-adjudication",
    contextSnapshot: snapshot,
    operationRevision: 1,
    input: { question: "Design a cache." },
  });
  const metadata = createRuntimeInferenceRequest({
    requestId: "request-metadata",
    operationKind: "meeting-metadata-inference",
    contextSnapshot: snapshot,
    operationRevision: 1,
    input: { company: "Reddit" },
  });

  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.payload), true);
  assert.equal(taxonomy.contextSnapshotId, metadata.contextSnapshotId);
  assert.equal(taxonomy.contextSnapshotHash, metadata.contextSnapshotHash);
  assert.equal(taxonomy.lane, "critical");
  assert.equal(metadata.lane, "background");
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
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.deepEqual(settlements, [
    "taxonomy-adjudication:completed",
    "taxonomy-adjudication:budget-exhausted",
    "meeting-metadata-inference:completed",
    "question-type-adjudication:completed",
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
