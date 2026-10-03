import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { globSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NEXT_MAJOR_VERIFICATION_GATES } from "../scripts/lib/next-major-verification.mjs";

// Task 202A: the default test entry discovers tests by directory convention.
// Root tests/*.test.mjs and every compiled tests/**/*.test.ts are in range;
// tests/helpers, tests/fixtures and tests/native-smoke are not.
const root = fileURLToPath(new URL("..", import.meta.url));
const steps = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts.test.split(" && ");
const runnerStep = steps.at(-1);
// Nothing is filtered out: every argument after `node --test` has to be a range pattern.
const runnerArguments = runnerStep.replace(/^node --test\s+/, "").match(/"[^"]*"|\S+/g) ?? [];
const patterns = runnerArguments.map(argument => argument.replace(/^"|"$/g, ""));
const outsideRange = /(^|\/)tests\/(helpers|fixtures|native-smoke)\//;
const selectedBy = cwd => globSync(patterns, { cwd, exclude: name => name === "node_modules" })
  .map(file => file.split(path.sep).join("/")).sort();

function temporaryTree(t, files) {
  const tree = mkdtempSync(path.join(tmpdir(), "jarvis-test-discovery-"));
  t.after(() => rmSync(tree, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.join(tree, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(tree, file), text);
  }
  return tree;
}

function filesUnder(directory, prefix = directory) {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const file = `${prefix}/${entry.name}`;
    return entry.isDirectory() ? filesUnder(`${directory}/${entry.name}`, file) : [file];
  });
}

test("default entry cleans, compiles, then hands two quoted range patterns and nothing else to one runner", () => {
  assert.deepEqual(steps.slice(0, -1), ["node scripts/clean-test-output.mjs", "tsc -p tsconfig.test.json"]);
  for (const argument of runnerArguments) {
    assert.match(argument, /^"[^"-][^"]*"$/,
      `${argument} must be a quoted pattern: the runner expands it, not the shell, and it is not a runner option`);
    assert.match(argument, /\*/, `${argument} names a file; tests are discovered by range, not listed by hand`);
  }
  // Exact text. Concurrency, a name or skip filter, only-mode and isolation each change
  // what a default run executes, so no other argument may ride along.
  assert.equal(runnerStep, 'node --test ".tmp-tests/tests/**/*.test.js" "tests/*.test.mjs"');
});

test("the runner expands the entry on a controlled tree: every in-range file once, nothing else", t => {
  // Each probe records from inside its test body: the log shows which tests ran, not only which files loaded.
  const recordCommonJs = `require("node:test")("probe", () => require("node:fs").appendFileSync(process.env.DISCOVERY_LOG, ` +
    `require("node:path").relative(process.cwd(), __filename) + "\\n"));\n`;
  const recordModule = `import { appendFileSync } from "node:fs";\nimport path from "node:path";\n` +
    `import test from "node:test";\nimport { fileURLToPath } from "node:url";\n` +
    `test("probe", () => appendFileSync(process.env.DISCOVERY_LOG, ` +
    `path.relative(process.cwd(), fileURLToPath(import.meta.url)) + "\\n"));\n`;
  const inRange = [
    ".tmp-tests/tests/nested/deeper/added.test.js",
    ".tmp-tests/tests/nested/added.test.js",
    ".tmp-tests/tests/root.test.js",
    "tests/added-later.test.mjs",
    "tests/root.test.mjs",
  ].sort();
  const outOfRange = [
    ".tmp-tests/src/lib/meeting/unit.test.js",
    ".tmp-tests/tests/fixtures/corpus.js",
    ".tmp-tests/tests/helpers/harness.js",
    ".tmp-tests/tests/native-smoke/vite.config.js",
    "tests/fixtures/backend.test.mjs",
    "tests/helpers/readers.test.mjs",
    "tests/native-smoke/build.mjs",
    "tests/native-smoke/isolation.test.mjs",
    "tests/nested/added.test.mjs",
  ];
  const tree = temporaryTree(t, {
    ...Object.fromEntries([...inRange, ...outOfRange].map(file => [file, file.endsWith(".mjs") ? recordModule : recordCommonJs])),
    "tests/source.test.ts": "throw new Error('sources are compiled first and never run directly');\n",
    "discovery.log": "",
  });
  const { NODE_TEST_CONTEXT: _nested, ...environment } = process.env;
  // The exact package.json text goes through the shell npm would use.
  const run = spawnSync(runnerStep, {
    cwd: tree, shell: true, encoding: "utf8",
    env: { ...environment, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
      DISCOVERY_LOG: path.join(tree, "discovery.log") },
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  // One passing test per in-range file, nothing failed, skipped or cancelled. The runner also counts a
  // file whose tests were all filtered out as one pass, so the log written by the test bodies decides what ran.
  const summary = Object.fromEntries([...run.stdout.matchAll(/^(?:#|ℹ) (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm)]
    .map(([, key, count]) => [key, Number(count)]));
  assert.deepEqual(summary, { tests: inRange.length, pass: inRange.length, fail: 0, cancelled: 0, skipped: 0, todo: 0 },
    run.stdout + run.stderr);
  const executed = readFileSync(path.join(tree, "discovery.log"), "utf8").trim().split("\n").sort();
  assert.deepEqual(executed, inRange, "each in-range file runs its test exactly once and no other file runs");
  assert.deepEqual(selectedBy(tree), inRange, "the same expansion decides the repository check below");
});

test("the repository: every root MJS and every compiled TS test is in range, support directories are not", t => {
  const compilerOptions = JSON.parse(readFileSync(path.join(root, "tsconfig.test.json"), "utf8")).compilerOptions;
  const compiled = file => path.posix.join(compilerOptions.outDir, path.posix.relative(compilerOptions.rootDir, file))
    .replace(/\.ts$/, ".js");
  const present = filesUnder("tests");
  const rootModules = present.filter(file => /^tests\/[^/]+\.test\.mjs$/.test(file));
  const typescriptTests = present.filter(file => file.endsWith(".test.ts"));
  assert.ok(rootModules.length > 0 && typescriptTests.length > 0);
  // Mirror the real names so the answer does not depend on a prior compile.
  const mirror = temporaryTree(t, Object.fromEntries([
    ...present.filter(file => /\.(mjs|js)$/.test(file)),
    ...present.filter(file => file.endsWith(".ts")).map(compiled),
  ].map(file => [file, ""])));
  const selected = selectedBy(mirror);
  assert.equal(new Set(selected).size, selected.length, "no file is selected twice");
  assert.deepEqual(selected, [...rootModules, ...typescriptTests.map(compiled)].sort());
  assert.deepEqual(selected.filter(file => outsideRange.test(file)), []);
  t.diagnostic(`${rootModules.length} root MJS and ${typescriptTests.length} compiled TS tests are in range`);
});

test("next-major verification keeps using this entry and native smoke stays opt-in", () => {
  assert.deepEqual(NEXT_MAJOR_VERIFICATION_GATES.find(gate => gate.name === "tests"),
    { name: "tests", command: "npm", args: ["test"] });
  assert.doesNotMatch(steps.join(" && "), /native-smoke/);
});
