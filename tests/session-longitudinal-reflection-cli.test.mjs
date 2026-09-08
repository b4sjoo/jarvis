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

test("Task152 single and longitudinal CLIs share exact operation/truth rows without changing raw evidence", async (t) => {
  ensureCliCompiled();
  const compile = spawnSync(tscPath, ["-p", "tsconfig.taxonomy-adjudication-reflection.json"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(compile.status, 0, compile.stdout + compile.stderr);
  const root = await mkdtemp(path.join(tmpdir(), "jarvis-task152-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = path.join(root, "recording");
  const metadata = {
    currentQuestionSessionId: "runtime-a", currentQuestionRuntimeEpoch: 3,
    currentQuestionUnitId: "Q1", currentQuestionRevision: 2,
    currentQuestionSourceHash: "source-a", currentQuestionSourceTurnIds: ["turn-a"],
    questionTypeAdjudicationOperationId: "T7", questionTypeAdjudicationRuntimeSessionId: "runtime-a",
    questionTypeAdjudicationRuntimeEpoch: 3, questionTypeAdjudicationUnitId: "Q1", questionTypeAdjudicationUnitRevision: 2,
    questionTypeAdjudicationCandidateType: "coding", questionTypeAdjudicationParseValid: true,
  };
  const proposal = { recordedAt: 10, traceId: "origin", sessionId: "session_recording_a", metadata };
  const relation = { ...proposal, recordedAt: 20, metadata: { ...metadata,
    taskRelationParentAffinityOperationId: "P1", taskRelationParentAffinityParsedDecision: "related",
    taskRelationParentAffinityParseValid: true, taskRelationSplitCanonicalOperationId: "C1",
    taskRelationSplitCanonicalParsedRelation: "new-parent", taskRelationSplitCanonicalParseValid: true,
    taskRelationSplitCanonicalLeaseAuthorized: false, taskRelationSplitCanonicalDisposition: "stale",
    taskRelationSplitParentPredecessorOperationId: "P1",
    runtimeSettlementTypeOperationId: "T7", runtimeSettlementOperationId: "R9", currentQuestionSettlementId: "S12",
    taskRelationOrderedResolutionStatus: "resolved", taskRelationOrderedResolutionRelation: "followup-parent",
  } };
  const subject = { attemptId: "origin", questionId: "Q1", traceIds: ["origin"], sourceTurnIds: ["turn-a"] };
  const files = {
    "manifest.json": JSON.stringify({ sessionId: "session_recording_a" }),
    "taxonomy/question-type-adjudications.jsonl": JSON.stringify(proposal) + "\n",
    "runtime-inference/task-relation-decisions.jsonl": [relation, relation].map(JSON.stringify).join("\n") + "\n",
    "taxonomy/question-type-adjudication-outcomes.jsonl": JSON.stringify({ schemaVersion: 2, outcomeId: "outcome", operationId: "R9", recordingSessionId: "session_recording_a", runtimeSessionId: "runtime-a", sessionId: "runtime-a", runtimeEpoch: 3, logicalQuestionUnitId: "Q1", logicalQuestionUnitRevision: 2, traceId: "consumer", originTraceId: "origin", settlementOperationId: "R9", settlementId: "S12", stage: "release", disposition: "settlement-applied", settlementApplied: true, recordedAt: 25 }) + "\n",
    "human-evaluation/projections-v2.json": JSON.stringify({ projections: [{ sessionId: "runtime-a", subject, computedAt: 40, observed: { traceId: "origin", traceHash: "hash", questionType: "coding" } }] }),
    "human-evaluation/ground-truth-v2.jsonl": "",
    "traces/origin.json": JSON.stringify({ exportedAt: 50, trace: { id: "origin", status: "success", metadata: { ...relation.metadata, sourceTransitionDurableMutationApplied: true, sourceTransitionDurableAuthorized: true, sourceTransitionParentAfterId: "parent-final", currentQuestionSettlementRelation: "followup-parent" } } }),
  };
  for (const [filename, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(session, filename)), { recursive: true });
    await writeFile(path.join(session, filename), contents);
  }
  const taxonomyCli = path.join(repoRoot, ".tmp-taxonomy-adjudication-reflection/scripts/reflect-taxonomy-adjudication-session.js");
  const singleOutput = path.join(root, "single");
  const longitudinalOutput = path.join(root, "longitudinal");
  const runSingle = () => spawnSync(process.execPath, [taxonomyCli, "--session", session, "--output", singleOutput], { cwd: repoRoot, encoding: "utf8" });
  const single = runSingle();
  assert.equal(single.status, 0, single.stderr);
  const longitudinal = runCli(["--session", session, "--output", longitudinalOutput, "--allow-incomplete"]);
  assert.equal(longitudinal.status, 0, longitudinal.stderr);
  const read = async (dir, file) => JSON.parse(await readFile(path.join(dir, file), "utf8"));
  const type = await read(singleOutput, "question-type-outcomes.json");
  const split = await read(singleOutput, "relation-reflection.json");
  const long = await read(longitudinalOutput, "report.json");
  assert.deepEqual(type.rows, long.adjudicationEvidence[0].questionType.rows);
  assert.deepEqual(split.rows, long.adjudicationEvidence[0].relation.rows);
  assert.equal(type.metrics.labeledProposals, 0);
  assert.equal(type.metrics.proposalOperations, 1);
  assert.equal(type.metrics.joinCoverage, 1);
  assert.equal(type.metrics.terminalCoverage, 0);
  assert.equal(split.metrics.currentOperations, 2);
  assert.equal(split.metrics.legacyOperations, 0);
  assert.equal(split.rows.find(row => row.operationId === "C1").candidateRelation, "new-parent");
  assert.equal(split.rows.find(row => row.operationId === "C1").orderedRelation, "followup-parent");
  assert.equal(split.rows.find(row => row.operationId === "C1").observedParentId, "parent-final");
  assert.equal(split.metrics.mutationApplied, 1);
  assert.equal(runSingle().status, 0);
  assert.deepEqual((await read(singleOutput, "question-type-outcomes.json")).rows, type.rows);
  for (const [filename, contents] of Object.entries(files)) assert.equal(await readFile(path.join(session, filename), "utf8"), contents, filename);

  const uiTruth = JSON.stringify({ schemaVersion: 2, eventId: "current-ui-truth", sessionId: "runtime-a", subject,
    fact: { kind: "expected-task-settlement", expectedQuestionType: "behavioral", expectedRelation: "followup-parent", expectedParentAction: "preserve" },
    provenance: { source: "explicit-ui", actor: "human", collection: "organic", sourceTraceId: "origin", recordedAt: 60 },
    confirmation: "confirmed" }) + "\n";
  await writeFile(path.join(session, "human-evaluation/ground-truth-v2.jsonl"), uiTruth);
  assert.equal(runSingle().status, 0);
  assert.equal(runCli(["--session", session, "--output", longitudinalOutput, "--allow-incomplete"]).status, 0);
  const labeledType = await read(singleOutput, "question-type-outcomes.json");
  const labeledSplit = await read(singleOutput, "relation-reflection.json");
  const labeledLong = await read(longitudinalOutput, "report.json");
  assert.equal(labeledType.metrics.labeledProposals, 1);
  assert.equal(labeledType.rows[0].typeCorrect, false);
  assert.equal(labeledSplit.rows.find(row => row.operationId === "C1").candidateCorrect, false);
  assert.deepEqual(labeledType.rows, labeledLong.adjudicationEvidence[0].questionType.rows);
  assert.deepEqual(labeledSplit.rows, labeledLong.adjudicationEvidence[0].relation.rows);
  assert.equal(await readFile(path.join(session, "human-evaluation/ground-truth-v2.jsonl"), "utf8"), uiTruth);
});

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
