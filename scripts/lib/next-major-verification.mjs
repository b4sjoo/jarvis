import fs from "node:fs";
import path from "node:path";

export const NEXT_MAJOR_VERIFICATION_GATES = Object.freeze([
  {
    name: "architecture",
    command: "node",
    args: ["scripts/verify-architecture.mjs", "--report"],
  },
  { name: "tests", command: "npm", args: ["test"] },
  { name: "frontend-build", command: "npm", args: ["run", "build"] },
  {
    name: "rust-check",
    command: "cargo",
    args: ["check", "--manifest-path", "src-tauri/Cargo.toml"],
  },
]);

export function loadVerificationBudget(repositoryRoot = process.cwd()) {
  const budgetPath = path.join(
    repositoryRoot,
    "architecture",
    "verification-budget.json"
  );
  if (!fs.existsSync(budgetPath)) return undefined;
  return JSON.parse(fs.readFileSync(budgetPath, "utf8"));
}

export function evaluateVerificationBudget(gateName, durationMs, budget) {
  const gate = budget?.gates?.find((entry) => entry.name === gateName);
  if (!gate) return undefined;
  return {
    baselineMs: gate.baselineMs,
    investigationThresholdMs: gate.investigationThresholdMs,
    exceeded: durationMs > gate.investigationThresholdMs,
  };
}

export function validateVerificationBudget(budget) {
  const errors = [];
  if (budget?.schemaVersion !== 1) {
    errors.push("verification budget schemaVersion must equal 1");
  }
  if (!Array.isArray(budget?.gates)) {
    errors.push("verification budget gates must be an array");
    return errors;
  }
  const expected = new Set(NEXT_MAJOR_VERIFICATION_GATES.map((gate) => gate.name));
  const seen = new Set();
  for (const gate of budget.gates) {
    if (!expected.has(gate.name)) errors.push(`unknown verification gate ${gate.name}`);
    if (seen.has(gate.name)) errors.push(`duplicate verification gate ${gate.name}`);
    seen.add(gate.name);
    if (!Number.isFinite(gate.baselineMs) || gate.baselineMs <= 0) {
      errors.push(`${gate.name} baselineMs must be positive`);
    }
    if (
      !Number.isFinite(gate.investigationThresholdMs) ||
      gate.investigationThresholdMs < gate.baselineMs * 1.2
    ) {
      errors.push(`${gate.name} threshold must be at least baseline plus 20%`);
    }
  }
  for (const name of expected) {
    if (!seen.has(name)) errors.push(`missing verification gate ${name}`);
  }
  return errors;
}
