import assert from "node:assert/strict";
import test from "node:test";
import {
  ResponseOpportunityGenerationGateCoordinator,
  resolveResponseOpportunityEffectiveCommand,
  resolveResponseOpportunityRefreshAuthority,
} from "../src/lib/meeting/response-opportunity-generation-gate.js";
import { decideRefreshAuthority } from "../src/lib/meeting/answer-generation-lease.js";
import { decideAdvisorTurnIntent } from "../src/lib/meeting/advisor-turn-intent.js";

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

test("lets one response opportunity gate own refresh authority", () => {
  const localDenied = decideRefreshAuthority({
    source: "live-turn",
    turnIntentDecision: decideAdvisorTurnIntent("Kubernetes.", {
      hasActiveTask: true,
    }),
  });
  const coordinator = new ResponseOpportunityGenerationGateCoordinator();
  const pending = coordinator.create(lease());

  const speculative = resolveResponseOpportunityRefreshAuthority({
    localAuthority: localDenied,
    operationId: pending.operationId,
    snapshot: pending,
  });
  assert.equal(speculative.authorized, true);
  assert.equal(speculative.reason, "response-opportunity-pending");

  const authorized = coordinator.settle({
    operationId: pending.operationId,
    disposition: "output-authorized",
    reason: "runtime-output-request",
  });
  const released = resolveResponseOpportunityRefreshAuthority({
    localAuthority: localDenied,
    operationId: pending.operationId,
    snapshot: authorized,
  });
  assert.equal(released.authorized, true);
  assert.equal(released.reason, "response-opportunity-output-authorized");

  const suppressingCoordinator =
    new ResponseOpportunityGenerationGateCoordinator();
  suppressingCoordinator.create(lease("operation-suppress"));
  const suppressed = suppressingCoordinator.settle({
    operationId: "operation-suppress",
    disposition: "output-suppressed",
    reason: "runtime-no-output",
  });
  const denied = resolveResponseOpportunityRefreshAuthority({
    localAuthority: {
      ...localDenied,
      authorized: true,
      kind: "automatic-substantive",
      reason: "substantive-turn",
      maySupersedeGeneration: true,
    },
    operationId: "operation-suppress",
    snapshot: suppressed,
  });
  assert.equal(denied.authorized, false);
  assert.equal(
    denied.reason,
    "response-opportunity-preserve-stable-answer"
  );
});

test("leaves refresh authority unchanged when no response gate exists", () => {
  const local = decideRefreshAuthority({
    source: "live-turn",
    turnIntentDecision: decideAdvisorTurnIntent("Yeah, yeah.", {
      hasActiveTask: true,
    }),
  });

  assert.equal(
    resolveResponseOpportunityRefreshAuthority({ localAuthority: local }),
    local
  );
});
