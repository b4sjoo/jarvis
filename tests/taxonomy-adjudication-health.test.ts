import assert from "node:assert/strict";
import test from "node:test";
import {
  formatTaxonomyAdjudicationCircuitForTrace,
  TaxonomyAdjudicationSessionCircuitBreaker,
} from "../src/lib/meeting/taxonomy-adjudication-health.js";

test("opens once for a deterministic provider failure within one session", () => {
  const circuit = new TaxonomyAdjudicationSessionCircuitBreaker();
  const first = circuit.open({
    sessionId: "session-a",
    reason: "provider-auth-error",
    detail: "invalid key",
    now: 100,
  });
  const repeated = circuit.open({
    sessionId: "session-a",
    reason: "provider-auth-error",
    now: 200,
  });

  assert.equal(first.newlyOpened, true);
  assert.equal(repeated.newlyOpened, false);
  assert.equal(repeated.state.openedAt, 100);
  assert.equal(repeated.state.detail, "invalid key");
});

test("a new meeting session receives a closed circuit", () => {
  const circuit = new TaxonomyAdjudicationSessionCircuitBreaker();
  circuit.open({
    sessionId: "session-a",
    reason: "provider-configuration-error",
  });

  assert.deepEqual(circuit.read("session-b"), {
    sessionId: "session-b",
    open: false,
  });
});

test("circuit trace metadata distinguishes first failure from later skips", () => {
  const circuit = new TaxonomyAdjudicationSessionCircuitBreaker();
  const opened = circuit.open({
    sessionId: "session-a",
    reason: "provider-auth-error",
    now: 100,
  });
  const metadata = formatTaxonomyAdjudicationCircuitForTrace(
    opened.state,
    opened.newlyOpened
  );

  assert.equal(metadata.taxonomyAdjudicationCircuitOpen, true);
  assert.equal(metadata.taxonomyAdjudicationCircuitNewlyOpened, true);
  assert.equal(
    metadata.taxonomyAdjudicationCircuitReason,
    "provider-auth-error"
  );
});
