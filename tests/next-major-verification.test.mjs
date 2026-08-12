import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateVerificationBudget,
  loadVerificationBudget,
  NEXT_MAJOR_VERIFICATION_GATES,
  validateVerificationBudget,
} from "../scripts/lib/next-major-verification.mjs";

test("runs next-major verification gates in the required order", () => {
  assert.deepEqual(
    NEXT_MAJOR_VERIFICATION_GATES.map((gate) => gate.name),
    ["architecture", "tests", "frontend-build", "rust-check"]
  );
});

test("accepts the tracked baseline and flags only threshold overruns", () => {
  const budget = loadVerificationBudget();
  assert.ok(budget);
  assert.deepEqual(validateVerificationBudget(budget), []);
  const architecture = budget.gates.find((gate) => gate.name === "architecture");
  assert.ok(architecture);
  assert.equal(
    evaluateVerificationBudget(
      "architecture",
      architecture.investigationThresholdMs,
      budget
    )?.exceeded,
    false
  );
  assert.equal(
    evaluateVerificationBudget(
      "architecture",
      architecture.investigationThresholdMs + 1,
      budget
    )?.exceeded,
    true
  );
});

test("rejects missing gates and thresholds below baseline plus 20 percent", () => {
  const budget = structuredClone(loadVerificationBudget());
  budget.gates = budget.gates.filter((gate) => gate.name !== "rust-check");
  budget.gates[0].investigationThresholdMs = budget.gates[0].baselineMs;
  const errors = validateVerificationBudget(budget);
  assert.equal(errors.some((error) => error.includes("at least baseline")), true);
  assert.equal(errors.some((error) => error.includes("missing verification gate")), true);
});
