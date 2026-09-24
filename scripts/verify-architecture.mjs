#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  createArchitectureContractBaseline,
  discoverArchitecture,
  evaluateArchitectureAnalysis,
  loadArchitectureContract,
} from "./lib/architecture-analysis.mjs";
import { loadDeletionLedger } from "./lib/maintainability-deletion-ledger.mjs";

const repositoryRoot = process.cwd();
const verificationStartedAt = Date.now();

if (
  process.argv.includes("--print-baseline") ||
  process.argv.includes("--write-baseline")
) {
  let sourceCommit = "unknown";
  try {
    sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    // A source archive without Git can still print a usable baseline.
  }
  let baseline;
  try {
    const existingContract = loadArchitectureContract(repositoryRoot);
    baseline = `${JSON.stringify(
      createArchitectureContractBaseline(existingContract, sourceCommit),
      null,
      2
    )}\n`;
  } catch (error) {
    console.error(`Architecture baseline update failed: ${error.message}`);
    process.exit(1);
  }
  if (process.argv.includes("--write-baseline")) {
    const contractPath = path.resolve(
      repositoryRoot,
      "architecture",
      "architecture-contract.json"
    );
    if (!process.argv.includes("--force-baseline")) {
      console.error(
        "Architecture contract already exists; pass --force-baseline only after reviewing the metadata update."
      );
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(contractPath), { recursive: true });
    fs.writeFileSync(contractPath, baseline);
    console.log(`Architecture baseline: ${path.relative(repositoryRoot, contractPath)}`);
  } else {
    console.log(baseline.trimEnd());
  }
  process.exit(0);
}

const analysis = discoverArchitecture(repositoryRoot);
const contract = loadArchitectureContract(repositoryRoot);
const ledger = loadDeletionLedger(repositoryRoot);
const evaluation = evaluateArchitectureAnalysis({
  analysis,
  contract,
  ledger,
});

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(evaluation, null, 2));
} else {
  console.log(formatMetrics(evaluation.metrics));
}

if (process.argv.includes("--report")) {
  const currentCommit = readCurrentCommit(repositoryRoot);
  const reportPath = path.resolve(
    repositoryRoot,
    ".tmp-architecture",
    "architecture-report.json"
  );
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sourceCommit: currentCommit,
      baselineSourceCommit: contract.sourceCommit,
      workingTreeChangeCount: readWorkingTreeChangeCount(repositoryRoot),
      command: "npm run verify:architecture",
      durationMs: Date.now() - verificationStartedAt,
      knownIpcExceptions: contract.ipc.reconciliation,
      ...evaluation,
    }, null, 2)}\n`
  );
  console.log(`Architecture report: ${path.relative(repositoryRoot, reportPath)}`);
}

if (!evaluation.ok) {
  console.error("Architecture verification failed:");
  for (const error of evaluation.errors) console.error(`- ${error}`);
  process.exit(1);
}

function formatMetrics(metrics) {
  return [
    "Architecture verification passed",
    `task-writers=${metrics.taskWriterCallsites}/${metrics.taskWriterModules} modules`,
    `legacy-imports=${metrics.liveLegacyImports}`,
    `cycles=${metrics.importCycles}/${metrics.importCycleEdges} edges`,
    `meeting-barrel-consumers=${metrics.broadMeetingBarrelConsumers}`,
    `ipc-commands=${metrics.registeredCommands}/${metrics.staticFrontendInvokes + metrics.wrappedFrontendInvokes} called`,
    `ipc-known-exceptions=${metrics.frontendCommandsWithoutNativeRegistration + metrics.nativeCommandsWithoutFrontendCall}`,
    `ledger=${metrics.deletionLedgerEntries}`,
  ].join(" | ");
}

function readCurrentCommit(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function readWorkingTreeChangeCount(cwd) {
  try {
    return execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean).length;
  } catch {
    return undefined;
  }
}
