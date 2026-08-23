import assert from "node:assert/strict";
import test from "node:test";
import {
  ResponseOpportunityGenerationGateCoordinator,
  resolveResponseOpportunityEffectiveCommand,
} from "../src/lib/meeting/response-opportunity-generation-gate.js";

function lease(operationId = "operation-a") {
  return {
    operationId,
    sessionId: "session-a",
    runtimeEpoch: 2,
    logicalQuestionUnitId: "lqu-a",
    logicalQuestionUnitRevision: 3,
    sourceHash: "source-a",
    manualCorrectionRevision: 4,
    createdAt: 100,
  };
}

test("binds a speculative generation gate to one response opportunity lease", () => {
  const coordinator = new ResponseOpportunityGenerationGateCoordinator();
  const created = coordinator.create(lease());

  assert.equal(created.disposition, "pending");
  assert.equal(
    coordinator.findOperationId({
      logicalQuestionUnitId: "lqu-a",
      logicalQuestionUnitRevision: 3,
    }),
    "operation-a"
  );
  const settled = coordinator.settle({
    operationId: "operation-a",
    disposition: "output-authorized",
    reason: "high-confidence-output-request",
    settledAt: 200,
  });
  assert.equal(settled?.disposition, "output-authorized");
  assert.equal(settled?.settledAt, 200);
});

test("waits for settlement and rejects a late second outcome", async () => {
  const coordinator = new ResponseOpportunityGenerationGateCoordinator();
  coordinator.create(lease());
  const pending = coordinator.wait("operation-a", 100);
  coordinator.settle({
    operationId: "operation-a",
    disposition: "output-suppressed",
    reason: "high-confidence-no-output-request",
  });

  assert.equal((await pending).disposition, "output-suppressed");
  assert.equal(
    coordinator.settle({
      operationId: "operation-a",
      disposition: "output-authorized",
      reason: "late-conflicting-result",
    })?.disposition,
    "output-suppressed"
  );
});

test("preserves local authority on wait timeout and rejects superseded work", async () => {
  const coordinator = new ResponseOpportunityGenerationGateCoordinator();
  coordinator.create(lease("operation-old"));
  const staleWait = coordinator.wait("operation-old", 100);
  coordinator.cancelAll("superseded-by-newer-input");
  assert.equal((await staleWait).disposition, "stale");

  coordinator.create(lease("operation-timeout"));
  const timedOut = await coordinator.wait("operation-timeout", 1);
  assert.equal(timedOut.disposition, "output-authorized");
  assert.equal(
    timedOut.reason,
    "local-output-authority-preserved:gate-wait-timeout"
  );
  assert.equal(
    resolveResponseOpportunityEffectiveCommand(timedOut),
    "output-authorized"
  );
  assert.equal(
    resolveResponseOpportunityEffectiveCommand(await staleWait),
    "preserve-stable-answer"
  );
});
