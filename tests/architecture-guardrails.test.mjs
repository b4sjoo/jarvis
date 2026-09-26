import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectRustEmittedEvents,
  createArchitectureContractBaseline,
  discoverArchitecture,
  evaluateArchitectureAnalysis,
  loadArchitectureContract,
} from "../scripts/lib/architecture-analysis.mjs";
import { loadDeletionLedger } from "../scripts/lib/maintainability-deletion-ledger.mjs";

const repositoryRoot = process.cwd();
const baselineAnalysis = discoverArchitecture(repositoryRoot);
const baselineContract = loadArchitectureContract(repositoryRoot);
const baselineLedger = loadDeletionLedger(repositoryRoot);
// Targeted validator cases pin unrelated IPC facts; the tracked-baseline test uses live discovery.
const controlledAnalysis = structuredClone(baselineAnalysis);
controlledAnalysis.ipc = structuredClone(baselineContract.ipc);
delete controlledAnalysis.ipc.reconciliation;
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-architecture-"));
fs.mkdirSync(path.join(fixtureRoot, "src"), { recursive: true });
fs.mkdirSync(path.join(fixtureRoot, "src-tauri/src"), { recursive: true });
fs.writeFileSync(path.join(fixtureRoot, "src/fixture.ts"), "export const fixture = 1;\n");
fs.writeFileSync(path.join(fixtureRoot, "src-tauri/src/lib.rs"), "");
const fixtureContract = { ...baselineContract, repositoryRoot: fixtureRoot };
after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

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

function evaluate({ analysis = controlledAnalysis, contract = fixtureContract, ledger = baselineLedger } = {}) {
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
  const result = evaluate({ analysis: baselineAnalysis, contract: baselineContract });
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.metrics.liveLegacyImports, 0);
  assert.equal(result.metrics.frontendCommandsWithoutNativeRegistration, 0);
});

test("small validator fixture passes before targeted negatives", () => {
  const result = evaluate();
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("C196: actual source graphs may shrink, split or remove an allowed cycle", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-cycle-contraction-"));
  try {
    fs.mkdirSync(path.join(root, "src/lib/meeting"), { recursive: true });
    fs.mkdirSync(path.join(root, "src-tauri/src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src-tauri/src/lib.rs"), "");
    fs.writeFileSync(path.join(root, "src/lib/meeting/index.ts"), "export {};\n");
    const file = (name) => `src/${name}.ts`;
    const full = { a: ["b"], b: ["a", "c"], c: ["d"], d: ["c", "a"] };
    const contract = structuredClone(baselineContract);
    contract.repositoryRoot = root;
    contract.imports.allowedCycles = [["a", "b", "c", "d"].map(file)];
    contract.imports.allowedCycleEdges = Object.entries(full).flatMap(([from, targets]) => targets.map(to => `${file(from)} -> ${file(to)}`));
    contract.imports.acyclicModules = [];
    contract.imports.contractDependencies = {};
    contract.imports.broadMeetingBarrelAllowedConsumers = [file("a"), file("b")];
    const run = (graph, policy = contract, barrel = []) => {
      for (const name of ["a", "b", "c", "d", "e"]) {
        fs.writeFileSync(path.join(root, file(name)), [
          ...(graph[name] ?? []).map(target => `import "./${target}";`),
          ...(barrel.includes(name) ? ['import "./lib/meeting/index";'] : []),
        ].join("\n"));
      }
      const found = discoverArchitecture(root);
      const analysis = structuredClone(controlledAnalysis);
      for (const key of ["importCycles", "importCycleEdges", "importDependencies", "broadMeetingBarrelConsumers"]) analysis[key] = found[key];
      return evaluate({ analysis, contract: policy });
    };
    for (const graph of [full, { a: ["b"], b: ["a"] }, { a: ["b"], b: ["a"], c: ["d"], d: ["c"] }, { a: ["b"], b: ["c"] }, {}]) {
      const result = run(graph);
      assert.equal(result.ok, true, result.errors.join("\n"));
    }
    expectFailure(run({ ...full, a: ["b", "c"] }), "import-cycle-edge:");
    expectFailure(run({ ...full, a: ["b", "e"], e: ["a"] }), "import-cycle:");
    const separated = structuredClone(contract);
    separated.imports.allowedCycles = [[file("a"), file("b")], [file("c"), file("d")]];
    assert.equal(run({ a: ["b"], b: ["a"], c: ["d"], d: ["c"] }, separated).ok, true);
    expectFailure(run(full, separated), "import-cycle:");
    const protectedPolicy = structuredClone(contract);
    protectedPolicy.imports.acyclicModules = [file("a")];
    expectFailure(run(full, protectedPolicy), "protected-module-cycle:");
    const restricted = structuredClone(contract);
    restricted.imports.contractDependencies[file("a")] = [];
    expectFailure(run(full, restricted), "contract-dependency:");
    for (const subset of [[], ["a"], ["b"], ["a", "b"]]) assert.equal(run({}, contract, subset).ok, true);
    expectFailure(run({}, contract, ["a", "b", "e"]), "meeting-barrel: new consumer");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("C196: changed policy fields fail closed when missing or malformed", () => {
  assert.equal("broadMeetingBarrelMaxConsumers" in baselineContract.imports, false);
  for (const key of ["allowedCycles", "allowedCycleEdges", "broadMeetingBarrelAllowedConsumers"]) {
    for (const value of [undefined, null, {}, [null]]) {
      const contract = structuredClone(fixtureContract);
      if (value === undefined) delete contract.imports[key]; else contract.imports[key] = value;
      expectFailure(evaluate({ contract }), `architecture contract imports.${key}`);
    }
  }
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
      fs.writeFileSync(path.join(directory, "meeting-task-contracts.ts"), "export interface State {}\n");
      fs.writeFileSync(path.join(directory, "runtime.ts"), 'import type { State } from "./meeting-task-contracts"; export interface Runtime { state: State }');
      fs.writeFileSync(path.join(directory, "index.ts"), 'export * from "./runtime";');
      const contract = structuredClone(baselineContract);
      contract.repositoryRoot = root;
      assert.equal(evaluate({ contract }).ok, true);
      fs.writeFileSync(path.join(directory, "meeting-task-contracts.ts"), source);
      const discovered = discoverArchitecture(root);
      const analysis = structuredClone(controlledAnalysis);
      analysis.importDependencies.push(...discovered.importDependencies);
      analysis.importCycles.push(...discovered.importCycles);
      analysis.importCycleEdges.push(...discovered.importCycleEdges);
      const result = evaluate({ analysis, contract });
      expectFailure(result, "contract-dependency:");
      assert.equal(result.errors.every((error) => /^(contract-dependency|protected-module|import-cycle)/.test(error)), true, result.errors.join("\n"));
      if (name !== "computed module") {
        assert.ok(discovered.importCycles.some(group => group.includes("src/lib/meeting/meeting-task-contracts.ts")));
        expectFailure(result, "protected-module-cycle:");
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("the ID leaf cannot reacquire a Context Manager or Hook dependency", () => {
  for (const target of ["src/lib/meeting/context-manager.ts", "src/hooks/useMeetingAssistant.ts"]) {
    const analysis = structuredClone(controlledAnalysis);
    analysis.importDependencies.push({ file: "src/lib/meeting/meeting-id.ts", target });
    expectFailure(evaluate({ analysis }), "contract-dependency:");
  }
});

test("rejects a task mutation from a new module", () => {
  const analysis = structuredClone(controlledAnalysis);
  analysis.taskMutationCalls.push({
    file: "src/lib/example/new-task-writer.ts",
    line: 1,
    method: "setActiveMeetingTaskState",
  });
  expectFailure(evaluate({ analysis }), "task-writer: unauthorized module");
});

test("rejects a live import of a legacy reader", () => {
  const analysis = structuredClone(controlledAnalysis);
  analysis.legacyReaderImports.push({
    file: "src/lib/meeting/live-producer.ts",
    target: "src/lib/legacy-readers/old-recording.ts",
  });
  expectFailure(evaluate({ analysis }), "legacy-reader: live module");
});

test("rejects a new import cycle and a new edge inside a known cycle", () => {
  const newCycle = structuredClone(controlledAnalysis);
  newCycle.importCycles.push(["src/example/a.ts", "src/example/b.ts"]);
  newCycle.importCycleEdges.push("src/example/a.ts -> src/example/b.ts");
  expectFailure(evaluate({ analysis: newCycle }), "import-cycle:");

  const newEdge = structuredClone(controlledAnalysis);
  newEdge.importCycleEdges.push(
    "src/lib/meeting/active-meeting-task.ts -> src/lib/meeting/trace.ts"
  );
  expectFailure(evaluate({ analysis: newEdge }), "import-cycle-edge:");
});

test("rejects a new broad meeting barrel consumer", () => {
  const analysis = structuredClone(controlledAnalysis);
  analysis.broadMeetingBarrelConsumers.push("src/lib/example/barrel-consumer.ts");
  expectFailure(evaluate({ analysis }), "meeting-barrel: new consumer");
});

test("rejects command registry drift and new dynamic IPC boundaries", () => {
  const missingHandler = structuredClone(controlledAnalysis);
  missingHandler.ipc.registeredCommands = missingHandler.ipc.registeredCommands.filter(
    (command) => command !== "capture_to_base64"
  );
  expectFailure(evaluate({ analysis: missingHandler }), "ipc.registeredCommands");

  const dynamicBoundary = structuredClone(controlledAnalysis);
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
  const pattern = "export function useMeetingAssistant()";
  ledger.entries[0].forbiddenPatterns = [pattern];
  ledger.entries[1].forbiddenPatterns = [pattern];
  const result = evaluate({ contract: baselineContract, ledger });
  assert.deepEqual(result.errors, [ledger.entries[0], ledger.entries[1]].map(
    (entry) => `deleted-surface: ${entry.id} pattern ${JSON.stringify(pattern)} reappeared in src/hooks/useMeetingAssistant.ts`
  ));
});

test("recurrence reads each file once per evaluation and observes source changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-recurrence-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "src-tauri/src"), { recursive: true });
    const source = path.join(root, "src/a.ts");
    const rust = path.join(root, "src-tauri/src/b.rs");
    const added = path.join(root, "src/c.ts");
    fs.writeFileSync(source, "export const active = true;\n");
    fs.writeFileSync(rust, "fn active() {}\n");
    const contract = { ...baselineContract, repositoryRoot: root };
    const ledger = structuredClone(baselineLedger);
    ledger.entries[0].forbiddenPatterns = ["RETIRED_A", "RETIRED_SHARED"];
    ledger.entries[1].forbiddenPatterns = ["RETIRED_SHARED"];

    function run() {
      const reads = new Map();
      const original = fs.readFileSync;
      fs.readFileSync = function (file, ...args) {
        if (typeof file === "string" && file.startsWith(`${root}${path.sep}`)) {
          reads.set(file, (reads.get(file) ?? 0) + 1);
        }
        return original.call(this, file, ...args);
      };
      try {
        return { result: evaluate({ contract, ledger }), reads };
      } finally {
        fs.readFileSync = original;
      }
    }

    const base = run();
    assert.equal(base.result.ok, true, base.result.errors.join("\n"));
    assert.deepEqual([...base.reads.values()], [1, 1]);

    fs.writeFileSync(source, "RETIRED_A RETIRED_SHARED\n");
    fs.writeFileSync(rust, "RETIRED_SHARED\n");
    const changed = run();
    const expectedError = (entry, pattern, file) =>
      `deleted-surface: ${entry.id} pattern ${JSON.stringify(pattern)} reappeared in ${file}`;
    assert.deepEqual(changed.result.errors, [
      expectedError(ledger.entries[0], "RETIRED_A", "src/a.ts"),
      expectedError(ledger.entries[0], "RETIRED_SHARED", "src/a.ts"),
      expectedError(ledger.entries[0], "RETIRED_SHARED", "src-tauri/src/b.rs"),
      expectedError(ledger.entries[1], "RETIRED_SHARED", "src/a.ts"),
      expectedError(ledger.entries[1], "RETIRED_SHARED", "src-tauri/src/b.rs"),
    ]);
    assert.deepEqual([...changed.reads.values()], [1, 1]);

    fs.writeFileSync(source, "export const active = false;\n");
    fs.rmSync(rust);
    fs.writeFileSync(added, "RETIRED_SHARED\n");
    const replaced = run();
    assert.deepEqual(replaced.result.errors, [
      expectedError(ledger.entries[0], "RETIRED_SHARED", "src/c.ts"),
      expectedError(ledger.entries[1], "RETIRED_SHARED", "src/c.ts"),
    ]);
    assert.deepEqual([...replaced.reads.values()], [1, 1]);

    fs.rmSync(added);
    const removed = run();
    assert.equal(removed.result.ok, true, removed.result.errors.join("\n"));
    assert.deepEqual([...removed.reads.values()], [1]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("baseline update preserves policy and requires explicit protected fields", () => {
  const existing = structuredClone(baselineContract);
  existing.taskMutation.methodNames = ["obsolete-copy"];
  const expected = structuredClone(existing);
  delete expected.repositoryRoot;
  delete expected.taskMutation.methodNames;
  expected.sourceCommit = "updated-commit";
  assert.deepEqual(createArchitectureContractBaseline(existing, "updated-commit"), expected);
  assert.equal("methodNames" in baselineContract.taskMutation, false);

  for (const key of ["acyclicModules", "contractDependencies"]) {
    const contract = structuredClone(fixtureContract);
    delete contract.imports[key];
    expectFailure(evaluate({ contract }), `imports.${key}`);
    assert.throws(() => createArchitectureContractBaseline(contract, "updated-commit"), new RegExp(`imports\\.${key}`));
  }
  for (const [key, value] of [
    ["acyclicModules", "invalid"],
    ["acyclicModules", [null]],
    ["contractDependencies", []],
    ["contractDependencies", { "src/example.ts": "invalid" }],
  ]) {
    const contract = structuredClone(fixtureContract);
    contract.imports[key] = value;
    expectFailure(evaluate({ contract }), `imports.${key}`);
    assert.throws(() => createArchitectureContractBaseline(contract, "updated-commit"), new RegExp(`imports\\.${key}`));
  }
  const empty = structuredClone(fixtureContract);
  empty.imports.acyclicModules = [];
  empty.imports.contractDependencies = {};
  assert.equal(evaluate({ contract: empty }).ok, true);
});

test("baseline CLI round trip cannot authorize newly discovered callers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-baseline-cli-"));
  const contractPath = path.join(root, "architecture/architecture-contract.json");
  const script = path.join(repositoryRoot, "scripts/verify-architecture.mjs");
  const run = (...args) => spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
  });
  try {
    fs.mkdirSync(path.dirname(contractPath), { recursive: true });
    const original = structuredClone(baselineContract);
    delete original.repositoryRoot;
    original.taskMutation.methodNames = ["obsolete-copy"];
    fs.writeFileSync(contractPath, `${JSON.stringify(original)}\n`);
    const before = fs.readFileSync(contractPath, "utf8");

    const printed = run("--print-baseline");
    assert.equal(printed.status, 0, printed.stderr);
    const candidate = JSON.parse(printed.stdout);
    const expected = structuredClone(original);
    delete expected.taskMutation.methodNames;
    expected.sourceCommit = candidate.sourceCommit;
    assert.deepEqual(candidate, expected);
    assert.equal(fs.readFileSync(contractPath, "utf8"), before);

    const denied = run("--write-baseline");
    assert.equal(denied.status, 1);
    assert.equal(fs.readFileSync(contractPath, "utf8"), before);
    const written = run("--write-baseline", "--force-baseline");
    assert.equal(written.status, 0, written.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(contractPath, "utf8")), candidate);

    fs.mkdirSync(path.join(root, "src/lib/example"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/lib/example/new-caller.ts"), "manager.commitPreparedTaskRuntimeTransition();\n");
    const discovered = discoverArchitecture(root);
    const analysis = structuredClone(controlledAnalysis);
    analysis.taskMutationCalls.push(...discovered.taskMutationCalls);
    const contract = loadArchitectureContract(root);
    const result = evaluate({ analysis, contract });
    assert.deepEqual(result.errors, ["task-writer: unauthorized module src/lib/example/new-caller.ts"]);
    assert.equal(run("--write-baseline", "--force-baseline").status, 0);
    assert.deepEqual(loadArchitectureContract(root).taskMutation.allowedModules, baselineContract.taskMutation.allowedModules);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("baseline CLI rejects missing and damaged existing contracts even with force", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-baseline-invalid-"));
  const contractPath = path.join(root, "architecture/architecture-contract.json");
  const script = path.join(repositoryRoot, "scripts/verify-architecture.mjs");
  const run = () => spawnSync(process.execPath, [script, "--write-baseline", "--force-baseline"], {
    cwd: root,
    encoding: "utf8",
  });
  try {
    assert.equal(run().status, 1);
    assert.equal(fs.existsSync(contractPath), false);
    fs.mkdirSync(path.dirname(contractPath), { recursive: true });
    for (const content of ["{broken", ...["acyclicModules", "contractDependencies"].map((key) => {
      const contract = structuredClone(baselineContract);
      delete contract.repositoryRoot;
      delete contract.imports[key];
      return `${JSON.stringify(contract)}\n`;
    })]) {
      fs.writeFileSync(contractPath, content);
      const result = run();
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Architecture baseline update failed:/);
      assert.equal(fs.readFileSync(contractPath, "utf8"), content);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prepared and deadline API calls are discovered from source and constrained", () => {
  const methods = [
    "commitPreparedTaskRuntimeTransition",
    "rollbackPreparedTaskRuntimeTransition",
    "installPreparedTaskDeadlineUpdate",
    "rollbackPreparedTaskDeadlineUpdate",
  ];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-task-mutation-"));
  try {
    fs.mkdirSync(path.join(root, "src/lib/example"), { recursive: true });
    const contract = { ...baselineContract, repositoryRoot: root };
    assert.equal(evaluate({ contract }).ok, true);
    const source = [
      "const manager = {} as any;",
      ...methods.map((method) => `manager.${method}();`),
      `const mention = "${methods[0]}";`,
      `function ${methods[1]}() {}`,
      `${methods[1]}();`,
    ].join("\n");
    const unauthorizedFile = path.join(root, "src/lib/example/new-caller.ts");
    fs.writeFileSync(unauthorizedFile, source);
    const unauthorizedCalls = discoverArchitecture(root).taskMutationCalls;
    assert.deepEqual(unauthorizedCalls.map((call) => call.method), methods);
    const unauthorizedAnalysis = structuredClone(controlledAnalysis);
    unauthorizedAnalysis.taskMutationCalls.push(...unauthorizedCalls);
    assert.deepEqual(evaluate({ analysis: unauthorizedAnalysis, contract }).errors, [
      "task-writer: unauthorized module src/lib/example/new-caller.ts",
    ]);

    fs.rmSync(unauthorizedFile);
    fs.mkdirSync(path.join(root, "src/hooks"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/hooks/useMeetingAssistant.ts"), source);
    const extraCalls = discoverArchitecture(root).taskMutationCalls;
    assert.deepEqual(extraCalls.map((call) => call.method), methods);
    const overBudget = structuredClone(controlledAnalysis);
    overBudget.taskMutationCalls.push(...extraCalls);
    assert.deepEqual(evaluate({ analysis: overBudget, contract }).errors, [
      "task-writer: src/hooks/useMeetingAssistant.ts has 14 callsites; baseline allows 10",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
