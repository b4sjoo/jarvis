import assert from "node:assert/strict";
import test from "node:test";
import {
  formatCapacityEstimationGuardrailForPrompt,
  formatCapacityEstimationGuardrailForTrace,
  resolveCapacityEstimationGuardrail,
} from "../src/lib/meeting/capacity-estimation-guardrail.js";

test("rejects numeric QPS from inventory and a traffic ratio without time basis", () => {
  const decision = resolveCapacityEstimationGuardrail({
    questionType: "general-system-design",
    sourceText:
      "Assume 100 million URLs and a 10:1 read/write ratio, then refine the architecture.",
  });

  assert.equal(decision.disposition, "missing-time-basis");
  assert.equal(decision.hasInventory, true);
  assert.equal(decision.hasTrafficRatio, true);
  assert.equal(decision.numericQpsAuthorized, false);
  assert.match(
    formatCapacityEstimationGuardrailForPrompt(decision),
    /Do not emit a numeric QPS range/
  );
});

test("authorizes derivation from request volume per time window", () => {
  const decision = resolveCapacityEstimationGuardrail({
    questionType: "general-system-design",
    sourceText:
      "We expect 100 million requests per day with a 4x peak factor.",
  });

  assert.equal(decision.disposition, "derivable-time-basis");
  assert.equal(decision.hasTimeBasedVolume, true);
  assert.equal(decision.numericQpsAuthorized, true);
});

test("authorizes derivation only when population has a per-actor cadence", () => {
  const populationOnly = resolveCapacityEstimationGuardrail({
    questionType: "general-system-design",
    sourceText: "Assume 10 million DAU and a 3x peak factor.",
  });
  const withCadence = resolveCapacityEstimationGuardrail({
    questionType: "general-system-design",
    sourceText:
      "Assume 10 million DAU, 5 actions per user per day, and a 3x peak factor.",
  });

  assert.equal(populationOnly.numericQpsAuthorized, false);
  assert.equal(populationOnly.disposition, "missing-time-basis");
  assert.equal(withCadence.numericQpsAuthorized, true);
  assert.equal(withCadence.disposition, "derivable-time-basis");
});

test("does not apply the General SD QPS guard to another canonical type", () => {
  const decision = resolveCapacityEstimationGuardrail({
    questionType: "ai-ml-system-design",
    sourceText: "The serving target is 5,000 QPS.",
  });

  assert.equal(decision.disposition, "not-applicable");
  assert.equal(decision.numericQpsAuthorized, false);
});

test("formats payload-free trace evidence", () => {
  const metadata = formatCapacityEstimationGuardrailForTrace(
    resolveCapacityEstimationGuardrail({
      questionType: "general-system-design",
      sourceText: "The target is 5,000 QPS.",
    })
  );

  assert.deepEqual(metadata, {
    capacityEstimationDisposition: "direct-throughput",
    capacityEstimationNumericQpsAuthorized: true,
    capacityEstimationHasDirectThroughput: true,
    capacityEstimationHasTimeBasedVolume: false,
    capacityEstimationHasActorPopulation: false,
    capacityEstimationHasPerActorCadence: false,
    capacityEstimationHasIntervalCadence: false,
    capacityEstimationHasInventory: false,
    capacityEstimationHasTrafficRatio: false,
    capacityEstimationHasPeakFactor: false,
  });
});
