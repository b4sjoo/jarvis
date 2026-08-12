import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverArchitecture,
  evaluateArchitectureAnalysis,
  loadArchitectureContract,
} from "../scripts/lib/architecture-analysis.mjs";
import { loadDeletionLedger } from "../scripts/lib/maintainability-deletion-ledger.mjs";

const repositoryRoot = process.cwd();
const baselineAnalysis = discoverArchitecture(repositoryRoot);
const baselineContract = loadArchitectureContract(repositoryRoot);
const baselineLedger = loadDeletionLedger(repositoryRoot);

function evaluate({ analysis = baselineAnalysis, contract = baselineContract, ledger = baselineLedger } = {}) {
  return evaluateArchitectureAnalysis({ analysis, contract, ledger });
}

function expectFailure(result, fragment) {
  assert.equal(result.ok, false);
  assert.equal(
    result.errors.some((error) => error.includes(fragment)),
    true,
    `Expected ${JSON.stringify(fragment)} in:\n${result.errors.join("\n")}`
  );
}

test("accepts the tracked architecture baseline", () => {
  const result = evaluate();
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.metrics.taskWriterCallsites, 2);
  assert.equal(result.metrics.taskWriterModules, 1);
  assert.equal(result.metrics.liveLegacyImports, 0);
  assert.equal(result.metrics.importCycles, 5);
  assert.equal(result.metrics.frontendCommandsWithoutNativeRegistration, 1);
});

test("rejects a task mutation from a new module", () => {
  const analysis = structuredClone(baselineAnalysis);
  analysis.taskMutationCalls.push({
    file: "src/lib/example/new-task-writer.ts",
    line: 1,
    method: "setActiveMeetingTaskState",
  });
  expectFailure(evaluate({ analysis }), "task-writer: unauthorized module");
});

test("rejects a live import of a legacy reader", () => {
  const analysis = structuredClone(baselineAnalysis);
  analysis.legacyReaderImports.push({
    file: "src/lib/meeting/live-producer.ts",
    target: "src/lib/legacy-readers/old-recording.ts",
  });
  expectFailure(evaluate({ analysis }), "legacy-reader: live module");
});

test("rejects a new import cycle and a new edge inside a known cycle", () => {
  const newCycle = structuredClone(baselineAnalysis);
  newCycle.importCycles.push(["src/example/a.ts", "src/example/b.ts"]);
  newCycle.importCycleEdges.push("src/example/a.ts -> src/example/b.ts");
  expectFailure(evaluate({ analysis: newCycle }), "import-cycle:");

  const newEdge = structuredClone(baselineAnalysis);
  newEdge.importCycleEdges.push(
    "src/lib/meeting/active-meeting-task.ts -> src/lib/meeting/trace.ts"
  );
  expectFailure(evaluate({ analysis: newEdge }), "import-cycle-edge:");
});

test("rejects a new broad meeting barrel consumer", () => {
  const analysis = structuredClone(baselineAnalysis);
  analysis.broadMeetingBarrelConsumers.push("src/lib/example/barrel-consumer.ts");
  expectFailure(evaluate({ analysis }), "meeting-barrel: new consumer");
});

test("rejects command registry drift and new dynamic IPC boundaries", () => {
  const missingHandler = structuredClone(baselineAnalysis);
  missingHandler.ipc.registeredCommands = missingHandler.ipc.registeredCommands.filter(
    (command) => command !== "capture_to_base64"
  );
  expectFailure(evaluate({ analysis: missingHandler }), "ipc.registeredCommands");

  const dynamicBoundary = structuredClone(baselineAnalysis);
  dynamicBoundary.ipc.dynamicFrontendInvokeCallsites.push({
    file: "src/lib/example/dynamic-ipc.ts",
    maxCallsites: 1,
  });
  expectFailure(evaluate({ analysis: dynamicBoundary }), "unregistered dynamic callsite");
});

test("resolves frontend-only Focus events and wrapped command literals", () => {
  assert.deepEqual(baselineAnalysis.ipc.staticFrontendEmittedEvents, [
    "meeting-focus-action",
    "meeting-focus-snapshot",
  ]);
  assert.equal(
    baselineAnalysis.ipc.wrappedFrontendInvokes.includes(
      "start_meeting_session_recording"
    ),
    true
  );
  assert.deepEqual(baselineAnalysis.ipc.dynamicFrontendEmitCallsites, []);
});

test("rejects recurrence of a deleted ledger surface", () => {
  const ledger = structuredClone(baselineLedger);
  ledger.entries[0].status = "deleted";
  ledger.entries[0].forbiddenPatterns = ["useMeetingAssistant"];
  expectFailure(evaluate({ ledger }), "deleted-surface:");
});
