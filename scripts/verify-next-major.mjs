#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  evaluateVerificationBudget,
  loadVerificationBudget,
  NEXT_MAJOR_VERIFICATION_GATES,
  validateVerificationBudget,
} from "./lib/next-major-verification.mjs";

const repositoryRoot = process.cwd();
const reportPath = path.resolve(
  repositoryRoot,
  ".tmp-architecture",
  "next-major-verification-report.json"
);
const budget = loadVerificationBudget(repositoryRoot);
const budgetErrors = budget ? validateVerificationBudget(budget) : [];
if (budgetErrors.length > 0) {
  for (const error of budgetErrors) console.error(`Verification budget: ${error}`);
  process.exit(1);
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceCommit: readCurrentCommit(),
  workingTreeChangeCount: readWorkingTreeChangeCount(),
  command: "npm run verify:next-major",
  status: "running",
  gates: [],
};

let failed = false;
for (const gate of NEXT_MAJOR_VERIFICATION_GATES) {
  if (failed) {
    report.gates.push({
      name: gate.name,
      command: formatCommand(gate),
      status: "skipped",
    });
    continue;
  }

  console.log(`\n[verify:next-major] ${gate.name}: ${formatCommand(gate)}`);
  const startedAt = Date.now();
  const result = spawnSync(gate.command, gate.args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  });
  const durationMs = Date.now() - startedAt;
  const status = result.status === 0 ? "passed" : "failed";
  const budgetResult = evaluateVerificationBudget(gate.name, durationMs, budget);
  report.gates.push({
    name: gate.name,
    command: formatCommand(gate),
    status,
    exitCode: result.status,
    durationMs,
    budget: budgetResult,
  });
  if (budgetResult?.exceeded) {
    console.warn(
      `[verify:next-major] ${gate.name} exceeded its investigation threshold ` +
        `(${durationMs}ms > ${budgetResult.investigationThresholdMs}ms).`
    );
  }
  if (status === "failed") failed = true;
}

report.status = failed ? "failed" : "passed";
report.durationMs = report.gates.reduce(
  (total, gate) => total + (gate.durationMs ?? 0),
  0
);
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `\n[verify:next-major] ${report.status}: ${path.relative(repositoryRoot, reportPath)}`
);
process.exit(failed ? 1 : 0);

function formatCommand(gate) {
  return [gate.command, ...gate.args].join(" ");
}

function readCurrentCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function readWorkingTreeChangeCount() {
  try {
    return execFileSync("git", ["status", "--porcelain"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean).length;
  } catch {
    return undefined;
  }
}
