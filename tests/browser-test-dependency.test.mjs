import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { loadBrowserTestDependency } from "./helpers/browser-test-dependency.mjs";

// Task 202A: one rule decides whether the real-browser consumer tests skip,
// run or fail. The rule is exercised with isolated fake packages, then the
// consumer files themselves go through the Node runner to prove what each
// one reports. No real browser is started here.
const root = fileURLToPath(new URL("..", import.meta.url));
const sandbox = mkdtempSync(path.join(tmpdir(), "jarvis-browser-dependency-"));
after(() => rmSync(sandbox, { recursive: true, force: true }));

const notABrowser = path.join(sandbox, "not-a-browser");
const nowhere = path.join(sandbox, "nowhere");
const packages = {
  absent: {},
  // Loads, records each launch attempt, and behaves like a browser that cannot start.
  working: { "index.js": `exports.fixture = "working";\nexports.chromium = { async launch(options) {\n` +
    `  require("node:fs").appendFileSync(process.env.BROWSER_FIXTURE_LAUNCH_LOG, ` +
    `require("node:path").basename(process.argv[1]) + "\\t" + options.executablePath + "\\n");\n` +
    `  throw new Error("fixture browser cannot launch");\n} };\n` },
  "throws-on-load": { "index.js": `throw new Error("fixture package failed internally");\n` },
  "missing-transitive": { "index.js": `module.exports = require("fixture-dependency-that-is-not-installed");\n` },
  "wrong-export": { "index.js": `exports.firefox = { async launch() {} };\n` },
  "syntax-error": { "index.js": `module.exports = {\n` },
  "broken-entry": { "package.json": `{ "name": "playwright", "main": "./missing.js" }\n` },
  "empty-package": {},
};
for (const [name, files] of Object.entries(packages)) {
  mkdirSync(path.join(sandbox, name, name === "absent" ? "" : "node_modules/playwright"), { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(path.join(sandbox, name, "node_modules/playwright", file), text);
}
writeFileSync(notABrowser, "");
// A search path that is a plain file still means "not installed".
mkdirSync(path.join(sandbox, "blocked-directory"));
writeFileSync(path.join(sandbox, "blocked-directory", "node_modules"), "");
const packagePath = name => path.join(sandbox, name, "node_modules/playwright");
const resolverFrom = installed => createRequire(path.join(sandbox, installed) + path.sep);
const decide = (installed, env) => loadBrowserTestDependency({ env, require: resolverFrom(installed) });
// Node stops at each of these, so nothing outside the sandbox can stand in for them.
const broken = ["throws-on-load", "missing-transitive", "wrong-export", "syntax-error", "broken-entry"];
const ordinaryFailure = /only a package that is not installed at all may skip/;
const explicitFailure = /a real browser run was explicitly requested, so this is a failure and not a skip/;

// A resolver created inside the sandbox still searches NODE_PATH, ~/.node_modules,
// ~/.node_libraries and $PREFIX/lib/node. A playwright reachable there stands in for every
// fixture that has nothing of its own to load, so the cases built on those fixtures can
// only run where none is reachable.
const reachableFromSandbox = (() => { try { return resolverFrom("absent").resolve("playwright"); } catch { return undefined; } })();
const needsIsolatedSandbox = reachableFromSandbox !== undefined &&
  `The "absent" fixture resolves playwright at ${reachableFromSandbox}, outside the sandbox; ` +
  "the in-process cases that need the default package absent were not executed";

// Consumers are found by import, so a new one is covered without a name list.
const helper = "helpers/browser-test-dependency.mjs";
const self = path.basename(fileURLToPath(import.meta.url));
const rootTests = readdirSync(path.join(root, "tests")).filter(name => name.endsWith(".test.mjs") && name !== self).sort();
const imports = new Map(rootTests.map(name => [name,
  [...readFileSync(path.join(root, "tests", name), "utf8").matchAll(/from\s+["']\.\/([^"']+)["']/g)].map(match => match[1])]));
const ruleOwners = rootTests.filter(name => imports.get(name).includes(helper));
const consumers = [...ruleOwners];
for (let known = -1; known !== consumers.length;) {
  known = consumers.length;
  for (const name of rootTests) {
    if (!consumers.includes(name) && imports.get(name).some(target => consumers.includes(target))) consumers.push(name);
  }
}
consumers.sort();
// A floor without names: a file that goes back to a private require-and-catch leaves this
// graph and would no longer be exercised below.
const importers = consumers.filter(name => !ruleOwners.includes(name));
assert.ok(ruleOwners.length >= 2, `at least two root tests call the rule directly; found: ${ruleOwners.join(", ") || "none"}`);
assert.ok(importers.length >= 4,
  `at least four more root tests take the decision from a rule owner; found: ${importers.join(", ") || "none"}`);

const { NODE_TEST_CONTEXT: _nested, JARVIS_PLAYWRIGHT_MODULE: _module, JARVIS_CHROMIUM_EXECUTABLE: _executable, ...inherited } = process.env;
let runs = 0;
async function runThroughNodeRunner(files, configuration) {
  const launchLog = path.join(sandbox, `launch-${runs++}.log`);
  writeFileSync(launchLog, "");
  const results = await Promise.all(files.map(name => new Promise(resolve => {
    execFile(process.execPath, ["--test", "--test-reporter=tap", `tests/${name}`], {
      cwd: root, env: { ...inherited, BROWSER_FIXTURE_LAUNCH_LOG: launchLog, ...configuration }, timeout: 120000,
    }, (error, stdout, stderr) => {
      const count = key => Number(stdout.match(new RegExp(`^# ${key} (\\d+)$`, "m"))?.[1]);
      resolve({ name, status: error ? error.code : 0, output: stdout + stderr,
        counts: { tests: count("tests"), pass: count("pass"), fail: count("fail"), skipped: count("skipped"), cancelled: count("cancelled") } });
    });
  })));
  return { results, launches: readFileSync(launchLog, "utf8").split("\n").filter(Boolean).sort() };
}
function assertEveryFileFails({ results }, context) {
  for (const { name, status, counts, output } of results) {
    assert.equal(status, 1, `${context}: ${name} must exit non-zero\n${output}`);
    assert.deepEqual(counts, { tests: 1, pass: 0, fail: 1, skipped: 0, cancelled: 0 }, `${context}: ${name}`);
    assert.doesNotMatch(output, /# SKIP/, `${context}: ${name}`);
  }
}

// On a machine with Playwright installed an ordinary run uses a real browser,
// so the cases that need it absent can only run where it is absent.
const defaultAbsent = (() => { try { return loadBrowserTestDependency({ env: {} }).skip !== false; } catch { return false; } })();
const needsAbsentDefault = !defaultAbsent && "The default Playwright package is installed here; " + (needsIsolatedSandbox
  ? "the injected-resolver cases could not run either, so the missing-package branch was not executed"
  : "the injected-resolver cases cover the missing-package branch");

test("ordinary run: only a package that is not installed at all becomes a skip", { skip: needsIsolatedSandbox }, () => {
  const absent = decide("absent", {});
  assert.equal(absent.playwright, undefined);
  assert.match(absent.skip, /Playwright is not installed/);
  assert.match(absent.skip, /JARVIS_PLAYWRIGHT_MODULE/);
  assert.match(absent.skip, /JARVIS_CHROMIUM_EXECUTABLE/);
  assert.equal(decide("blocked-directory", {}).skip, absent.skip);
  // Same Node error code as the absent package, but the package directory exists.
  assert.throws(() => decide("empty-package", {}), ordinaryFailure);
});

test("ordinary run: an installed default package runs and a present but broken one fails", () => {
  const installed = decide("working", {});
  assert.equal(installed.skip, false);
  assert.equal(installed.playwright.fixture, "working");

  for (const name of broken) {
    assert.throws(() => decide(name, {}), ordinaryFailure, name);
  }
  // Same Node error code as the absent package, but a different module is missing.
  assert.throws(() => decide("missing-transitive", {}), error => error.cause.code === "MODULE_NOT_FOUND");
});

test("explicit run: a configured path is required, never skipped and never replaced", () => {
  // A working default install is present throughout, yet it never replaces the configured
  // module: not when that path is missing, and not when it resolves but cannot be loaded or used.
  for (const module of [nowhere, ""]) {
    assert.throws(() => decide("working", { JARVIS_PLAYWRIGHT_MODULE: module }), explicitFailure, JSON.stringify(module));
  }
  for (const name of [...broken, "empty-package"]) {
    assert.throws(() => decide("working", { JARVIS_PLAYWRIGHT_MODULE: packagePath(name) }), explicitFailure, name);
  }
  for (const executable of [nowhere, ""]) {
    assert.throws(() => decide("working", { JARVIS_CHROMIUM_EXECUTABLE: executable }), /is not an existing file/, JSON.stringify(executable));
  }
  const configured = decide("absent", { JARVIS_PLAYWRIGHT_MODULE: packagePath("working"), JARVIS_CHROMIUM_EXECUTABLE: notABrowser });
  assert.equal(configured.skip, false);
  assert.equal(configured.playwright.fixture, "working");
});

test("explicit run: configuring only the browser turns the absent default package into a failure",
  { skip: needsIsolatedSandbox }, () => {
    assert.throws(() => decide("absent", { JARVIS_CHROMIUM_EXECUTABLE: notABrowser }), explicitFailure);
  });

test("consumers without Playwright: each file reports one explicit skip and exits 0", { skip: needsAbsentDefault }, async t => {
  const { results, launches } = await runThroughNodeRunner(consumers, {});
  for (const { name, status, counts, output } of results) {
    assert.equal(status, 0, `${name}\n${output}`);
    // One test per file: importing a rule owner registers no second copy of its test.
    assert.deepEqual(counts, { tests: 1, pass: 0, fail: 0, skipped: 1, cancelled: 0 }, name);
    assert.match(output, /^ok 1 - .+ # SKIP Playwright is not installed/m, name);
  }
  assert.deepEqual(launches, []);
  t.diagnostic(`consumers: ${consumers.join(", ")}`);
});

test("consumers with a present default package that cannot load fail instead of skipping", { skip: needsAbsentDefault }, async () => {
  const run = await runThroughNodeRunner(consumers, { NODE_PATH: path.join(sandbox, "missing-transitive", "node_modules") });
  assertEveryFileFails(run, "missing-transitive default");
  for (const { name, output } of run.results) assert.match(output, /fixture-dependency-that-is-not-installed/, name);
});

test("consumers with an explicit module that is missing, throws or exports nothing usable exit non-zero", async () => {
  for (const module of [nowhere, packagePath("throws-on-load"), packagePath("wrong-export")]) {
    const run = await runThroughNodeRunner(consumers, { JARVIS_PLAYWRIGHT_MODULE: module });
    assertEveryFileFails(run, module);
    assert.deepEqual(run.launches, []);
  }
});

test("consumers with an explicit browser that is missing or cannot launch exit non-zero", async () => {
  const module = packagePath("working");
  const missing = await runThroughNodeRunner(consumers, { JARVIS_PLAYWRIGHT_MODULE: module, JARVIS_CHROMIUM_EXECUTABLE: nowhere });
  assertEveryFileFails(missing, "missing executable");
  assert.deepEqual(missing.launches, [], "a missing executable fails before any launch");

  // Every consumer enters its test body here, on any machine, at the cost of one production
  // bundle per file. One test and one launch per file: importing the shared module registers
  // no second copy of its test.
  const cannotLaunch = await runThroughNodeRunner(consumers, { JARVIS_PLAYWRIGHT_MODULE: module, JARVIS_CHROMIUM_EXECUTABLE: notABrowser });
  assertEveryFileFails(cannotLaunch, "launch failure");
  assert.deepEqual(cannotLaunch.launches, consumers.map(name => `${name}\t${notABrowser}`),
    "each file launches once, with the configured browser path");
});
