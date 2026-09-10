import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectRustEmittedEvents,
  discoverArchitecture,
  evaluateArchitectureAnalysis,
  loadArchitectureContract,
} from "../scripts/lib/architecture-analysis.mjs";
import { loadDeletionLedger } from "../scripts/lib/maintainability-deletion-ledger.mjs";

const repositoryRoot = process.cwd();
const baselineAnalysis = discoverArchitecture(repositoryRoot);
const baselineContract = loadArchitectureContract(repositoryRoot);
const baselineLedger = loadDeletionLedger(repositoryRoot);

test("Rust targeted emission records the event, not the recipient window", () => {
  assert.deepEqual(collectRustEmittedEvents(`
    const REQUEST_EVENT: &str = "shutdown-request";
    const STATUS_EVENT: &'static str = "shutdown-status";
    app.emit_to("main", REQUEST_EVENT, payload);
    app.emit_to(target, "literal-request", payload);
    app.emit(STATUS_EVENT, payload);
    app.emit("literal-status", payload);
  `), ["literal-request", "literal-status", "shutdown-request", "shutdown-status"]);
  assert.deepEqual(collectRustEmittedEvents('app.emit_to("main", unresolved, value);'), []);
  assert.deepEqual(collectRustEmittedEvents('app.emit(REQUEST_EVENT, value);'), []);
});

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
  assert.equal(result.metrics.importCycleEdges, 41);
  assert.equal(result.metrics.frontendCommandsWithoutNativeRegistration, 1);
});

test("all retired Meeting cycles and moved contracts remain acyclic", () => {
  const protectedModules = new Set(baselineContract.imports.acyclicModules);
  assert.equal(protectedModules.has("src/lib/meeting/logical-question-unit.ts"), true);
  assert.equal(protectedModules.has("src/lib/meeting/meeting-context-contracts.ts"), true);
  assert.equal(baselineAnalysis.importCycles.some(group => group.some(file => protectedModules.has(file))), false);
});

for (const [name, source] of [
  ["static type", 'import type { Runtime } from "./runtime"; export type State = Runtime;'],
  ["inline type", 'export type State = import("./runtime").Runtime;'],
  ["re-export", 'export type { Runtime as State } from "./runtime";'],
  ["barrel", 'export * from "./index";'],
  ["dynamic", 'export const load = () => import("./runtime");'],
  ["require", 'export const load = () => require("./runtime");'],
  ["computed module", 'export const load = (name: string) => import(name);'],
  ["self import", 'export type State = import("./meeting-task-contracts").State;'],
]) {
  test(`contract boundaries reject ${name} dependency through actual source analysis`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-contract-"));
    try {
      const directory = path.join(root, "src/lib/meeting");
      fs.mkdirSync(directory, { recursive: true });
      fs.mkdirSync(path.join(root, "src-tauri/src"), { recursive: true });
      fs.writeFileSync(path.join(root, "src-tauri/src/lib.rs"), "");
      fs.writeFileSync(path.join(directory, "meeting-task-contracts.ts"), source);
      fs.writeFileSync(path.join(directory, "runtime.ts"), 'import type { State } from "./meeting-task-contracts"; export interface Runtime { state: State }');
      fs.writeFileSync(path.join(directory, "index.ts"), 'export * from "./runtime";');
      const analysis = discoverArchitecture(root);
      const contract = structuredClone(baselineContract);
      contract.repositoryRoot = root;
      const result = evaluate({ analysis, contract });
      expectFailure(result, "contract-dependency:");
      if (name !== "computed module") {
        assert.ok(analysis.importCycles.some(group => group.includes("src/lib/meeting/meeting-task-contracts.ts")));
        expectFailure(result, "protected-module-cycle:");
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("the ID leaf cannot reacquire a Context Manager or Hook dependency", () => {
  for (const target of ["src/lib/meeting/context-manager.ts", "src/hooks/useMeetingAssistant.ts"]) {
    const analysis = structuredClone(baselineAnalysis);
    analysis.importDependencies.push({ file: "src/lib/meeting/meeting-id.ts", target });
    expectFailure(evaluate({ analysis }), "contract-dependency:");
  }
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

test("resolves registered frontend-only events and wrapped command literals", () => {
  for (const command of ["exit_app", "report_app_shutdown", "complete_app_shutdown", "get_app_shutdown"]) {
    assert.equal(baselineAnalysis.ipc.wrappedFrontendInvokes.includes(command), true, command);
  }
  for (const event of ["jarvis-shutdown-requested", "jarvis-shutdown-status"]) {
    assert.equal(baselineAnalysis.ipc.staticFrontendListenedEvents.includes(event), true, event);
    assert.equal(baselineAnalysis.ipc.nativeEmittedEvents.includes(event), true, event);
  }
  assert.equal(baselineAnalysis.ipc.nativeEmittedEvents.includes("main"), false);
  assert.deepEqual(baselineAnalysis.ipc.staticFrontendEmittedEvents, [
    "meeting-focus-action",
    "meeting-focus-snapshot",
    "preparation-snapshot-selection-invalidated",
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
