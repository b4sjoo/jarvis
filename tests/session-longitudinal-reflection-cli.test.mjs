import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const tscPath = path.join(repoRoot, "node_modules", ".bin", "tsc");
const tsconfigPath = path.join(
  repoRoot,
  "tsconfig.session-longitudinal-evaluation.json"
);
const cliPath = path.join(
  repoRoot,
  ".tmp-session-longitudinal-evaluation",
  "scripts",
  "reflect-session-longitudinal-evaluation.js"
);

test("enforces release evidence at the longitudinal reflection CLI boundary", async (t) => {
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "jarvis-longitudinal-cli-")
  );
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const sessionDirectory = path.join(fixtureRoot, "session-incomplete");
  const rejectedOutputDirectory = path.join(fixtureRoot, "rejected-output");
  const exploratoryOutputDirectory = path.join(
    fixtureRoot,
    "exploratory-output"
  );
  await mkdir(sessionDirectory);

  const compilation = spawnSync(tscPath, ["-p", tsconfigPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(compilation.status, 0, compilation.stderr);

  const rejected = runCli([
    "--session",
    sessionDirectory,
    "--output",
    rejectedOutputDirectory,
  ]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Session evidence is incomplete for release evaluation/);
  assert.match(rejected.stderr, /manifest-missing/);
  assert.match(rejected.stderr, /transcript-missing/);
  assert.match(rejected.stderr, /trace-evidence-missing/);
  await assert.rejects(
    access(path.join(rejectedOutputDirectory, "report.json"))
  );

  const exploratory = runCli([
    "--session",
    sessionDirectory,
    "--output",
    exploratoryOutputDirectory,
    "--allow-incomplete",
  ]);
  assert.equal(exploratory.status, 0, exploratory.stderr);
  assert.match(exploratory.stdout, /"releaseEvidenceEligible": false/);
  const report = JSON.parse(
    await readFile(
      path.join(exploratoryOutputDirectory, "report.json"),
      "utf8"
    )
  );
  assert.equal(report.evidenceScope.releaseEligible, false);
  assert.deepEqual(report.evidenceScope.failures, [
    {
      directory: sessionDirectory,
      reasons: [
        "manifest-missing",
        "transcript-missing",
        "trace-evidence-missing",
      ],
    },
  ]);
});

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}
