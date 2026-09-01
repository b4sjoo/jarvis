import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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
let cliCompiled = false;

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

  ensureCliCompiled();

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

test("projects raw committed source-transition identity into longitudinal parent action", async (t) => {
  ensureCliCompiled();
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "jarvis-longitudinal-lifecycle-")
  );
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const sessionDirectory = path.join(fixtureRoot, "session-lifecycle");
  const outputDirectory = path.join(fixtureRoot, "output");
  await Promise.all([
    mkdir(path.join(sessionDirectory, "transcripts"), { recursive: true }),
    mkdir(path.join(sessionDirectory, "traces"), { recursive: true }),
    mkdir(path.join(sessionDirectory, "human-evaluation"), {
      recursive: true,
    }),
  ]);
  await Promise.all([
    writeFile(
      path.join(sessionDirectory, "manifest.json"),
      JSON.stringify({
        sessionId: "session-lifecycle",
        status: "stopped",
        recordingIntegrity: { status: "complete" },
      }),
      "utf8"
    ),
    writeFile(
      path.join(sessionDirectory, "transcripts", "turns.jsonl"),
      `${JSON.stringify({
        id: "turn-lifecycle",
        speaker: "them",
        text: "Design an AI retrieval system.",
      })}\n`,
      "utf8"
    ),
    writeFile(
      path.join(sessionDirectory, "traces", "trace-lifecycle.json"),
      JSON.stringify({
        trace: {
          id: "trace-lifecycle",
          kind: "advisor",
          status: "success",
          startedAt: 1,
          durationMs: 5,
          metadata: {
            logicalQuestionUnitId: "question-lifecycle",
            taskRelation: "new-parent",
            taskMutationAuthorized: true,
            settledExecutionPlanTaskMutationCommand: "preserve",
            taskLifecycleParentBeforeId: "stale-before",
            taskLifecycleParentAfterId: "stale-after",
            taskLifecycleParentBeforeType: "coding",
            taskLifecycleParentAfterType: "behavioral",
            sourceTransitionRuntimeKind: "replace-parent",
            sourceTransitionDurableAuthorized: true,
            sourceTransitionDurableMutationApplied: true,
            sourceTransitionParentBeforeId: "parent-design",
            sourceTransitionParentAfterId: "parent-design",
            sourceTransitionParentBeforeType: "general-system-design",
            sourceTransitionParentAfterType: "ai-ml-system-design",
          },
        },
      }),
      "utf8"
    ),
    writeFile(
      path.join(
        sessionDirectory,
        "human-evaluation",
        "question-evaluations.json"
      ),
      JSON.stringify({
        evaluations: [legacyLifecycleEvaluation()],
      }),
      "utf8"
    ),
  ]);

  const result = runCli([
    "--session",
    sessionDirectory,
    "--output",
    outputDirectory,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(
    await readFile(path.join(outputDirectory, "report.json"), "utf8")
  );
  assert.deepEqual(report.continuityFunnel.parentActionAgreement, {
    numerator: 1,
    denominator: 1,
    rate: 1,
  });
});

function ensureCliCompiled() {
  if (cliCompiled) return;
  const compilation = spawnSync(tscPath, ["-p", tsconfigPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(compilation.status, 0, compilation.stderr);
  cliCompiled = true;
}

function legacyLifecycleEvaluation() {
  const notApplicable = { verdict: "not_applicable", reasons: [] };
  return {
    id: "evaluation-lifecycle",
    sessionId: "session-lifecycle",
    questionId: "question-lifecycle",
    traceIds: ["trace-lifecycle"],
    expectedRelation: "new-parent",
    expectedParentAction: "retype",
    selectedDiagramOverlayIds: [],
    classification: notApplicable,
    playbook: notApplicable,
    playbookPhase: notApplicable,
    memory: notApplicable,
    whiteboard: notApplicable,
    manualPhaseTransition: notApplicable,
    diagramOverlay: notApplicable,
    guardrail: notApplicable,
    answer: notApplicable,
    memoryEntryLabels: [],
    missingExpectedMemory: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}
