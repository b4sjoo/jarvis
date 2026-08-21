import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptPath = path.join(repoRoot, "scripts", "reflect-session-recordings.sh");
const packageJson = JSON.parse(
  await readFile(path.join(repoRoot, "package.json"), "utf8")
);
const reflectionCommands = Object.keys(packageJson.scripts).filter(
  (name) => name.endsWith(":reflect") && name !== "session:reflect"
);

async function createFixture() {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "jarvis-reflect-sessions-"));
  const sessionRoot = path.join(fixtureRoot, "recording root");
  const logPath = path.join(fixtureRoot, "npm-invocations.tsv");
  const fakeNpmPath = path.join(fixtureRoot, "fake-npm.sh");
  await mkdir(sessionRoot);
  await writeFile(
    fakeNpmPath,
    `#!/usr/bin/env bash
printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$1" "$2" "$3" "$4" "$5" >> "$REFLECTION_TEST_LOG"
if [[ "\${REFLECTION_FAIL_COMMAND:-}" == "$2" ]]; then
  exit 17
fi
`,
    "utf8"
  );
  await chmod(fakeNpmPath, 0o755);
  return { fixtureRoot, sessionRoot, logPath, fakeNpmPath };
}

function runScript(args, fixture, extraEnv = {}) {
  return spawnSync(scriptPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      JARVIS_SESSION_RECORDINGS_DIR: fixture.sessionRoot,
      NPM_BIN: fixture.fakeNpmPath,
      REFLECTION_TEST_LOG: fixture.logPath,
      ...extraEnv,
    },
  });
}

test("runs every reflection command for every unique session folder", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.fixtureRoot, { recursive: true, force: true }));
  const sessionNames = ["session-one", "session-two"];
  for (const sessionName of sessionNames) {
    await mkdir(path.join(fixture.sessionRoot, sessionName));
  }

  const result = runScript(
    [sessionNames[0], sessionNames[1], sessionNames[0]],
    fixture
  );

  assert.equal(result.status, 0, result.stderr);
  const invocations = (await readFile(fixture.logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => line.split("\t"));
  assert.equal(invocations.length, reflectionCommands.length * sessionNames.length);
  const canonicalSessionRoot = await realpath(fixture.sessionRoot);
  for (const sessionName of sessionNames) {
    for (const commandName of reflectionCommands) {
      assert.ok(
        invocations.some(
          ([run, command, separator, flag, sessionDirectory]) =>
            run === "run" &&
            command === commandName &&
            separator === "--" &&
            flag === "--session" &&
            sessionDirectory === path.join(canonicalSessionRoot, sessionName)
        ),
        `missing ${sessionName} :: ${commandName}`
      );
    }
  }
  assert.match(
    result.stdout,
    new RegExp(`${reflectionCommands.length * sessionNames.length} passed, 0 failed`)
  );
});

test("rejects missing, absolute, and unknown session folder arguments", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.fixtureRoot, { recursive: true, force: true }));

  const noArguments = runScript([], fixture);
  assert.equal(noArguments.status, 64);
  assert.match(noArguments.stderr, /provide at least one session folder name/);

  const absolutePath = runScript([path.join(fixture.sessionRoot, "session-one")], fixture);
  assert.equal(absolutePath.status, 64);
  assert.match(absolutePath.stderr, /folder names without path separators/);

  const missingFolder = runScript(["missing-session"], fixture);
  assert.equal(missingFolder.status, 66);
  assert.match(missingFolder.stderr, /session recording folder does not exist/);
});

test("continues remaining reflections and reports a nonzero summary after failure", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.fixtureRoot, { recursive: true, force: true }));
  await mkdir(path.join(fixture.sessionRoot, "session-one"));
  const failedCommand = reflectionCommands[1];

  const result = runScript(["session-one"], fixture, {
    REFLECTION_FAIL_COMMAND: failedCommand,
  });

  assert.equal(result.status, 1);
  const invocations = (await readFile(fixture.logPath, "utf8")).trim().split("\n");
  assert.equal(invocations.length, reflectionCommands.length);
  assert.match(result.stdout, /1 failed/);
  assert.match(result.stderr, new RegExp(`session-one :: ${failedCommand}`));
});
