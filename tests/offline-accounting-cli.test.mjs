import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const repo = fileURLToPath(new URL("..", import.meta.url));
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "generatedAt").map(([key, item]) => [key, stable(item)])) : value;

test("OJ4 shared builders and both CLIs agree without sealing incomplete evidence", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "jarvis-batch1b-cli-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const compiled = process.env.JARVIS_BATCH1B_COMPILED_DIR ?? path.join(root, "compiled");
  if (!process.env.JARVIS_BATCH1B_COMPILED_DIR) {
    for (const config of ["tsconfig.taxonomy-adjudication-reflection.json", "tsconfig.session-longitudinal-evaluation.json"])
      execFileSync(path.join(repo, "node_modules/.bin/tsc"), ["-p", config, "--outDir", compiled], { cwd: repo });
  }
  const load = relative => import(pathToFileURL(path.join(compiled, relative)).href);
  const { buildQuestionTypeAdjudicationOutcomeReport } = await load("src/lib/meeting/question-type-adjudication-outcome.js");
  const { buildTaskRelationAdjudicationReflectionReport } = await load("src/lib/meeting/task-relation-adjudication-reflection.js");
  const { createHumanGroundTruthEventV2, deriveHumanEvaluationProjectionV2 } = await load("src/lib/meeting/human-ground-truth-v2.js");
  const session = path.join(root, "recording");
  const metadata = {
    currentQuestionSessionId: "runtime", currentQuestionRuntimeEpoch: 3,
    currentQuestionUnitId: "Q", currentQuestionRevision: 1,
    currentQuestionSourceHash: "source", currentQuestionSourceTurnIds: ["turn"],
    questionTypeAdjudicationOperationId: "T", questionTypeAdjudicationParseValid: false,
    taskRelationSplitCanonicalOperationId: "C", taskRelationSplitCanonicalParsedRelation: "child-probe",
    taskRelationSplitCanonicalParseValid: true, runtimeSettlementTypeOperationId: "T",
    runtimeSettlementOperationId: "R", currentQuestionSettlementId: "S", currentQuestionSettlementType: "ai-ml-system-design",
    settledExecutionPlanId: "P", settledExecutionPlanSettlementId: "S",
    settledExecutionPlanSessionId: "runtime", settledExecutionPlanRuntimeEpoch: 3,
    settledExecutionPlanLogicalQuestionUnitId: "Q", settledExecutionPlanLogicalQuestionRevision: 1,
    settledExecutionPlanSourceHash: "source", settledExecutionPlanSourceTurnIds: ["turn"],
    settledExecutionPlanAuthorized: true, settledExecutionPlanResponseAuthorized: true,
    advisorJobId: "J", advisorJobExpectedSessionId: "runtime", advisorJobExpectedRuntimeEpoch: 3,
    advisorJobOutcome: "committed", advisorJobCommitAuthorized: true,
    generationResultCommitDisposition: "committed", leaseAuthorizedAtCommit: true,
    latestUsefulAnswerVisibleCommitAuthorized: true, latestUsefulAnswerVisibleCommitRevision: 1,
    advisorOutputCommittedToUi: true, visibleAnswerRevisionAfter: 1,
  };
  const decision = { recordedAt: 1, sessionId: "session_recording_a", traceId: "attempt", metadata };
  const terminal = { ...decision, recordedAt: 3, exportedAt: 3, status: "success" };
  const subject = { attemptId: "attempt", questionId: "trace:attempt", traceIds: ["attempt"], sourceTurnIds: ["turn"] };
  const event = createHumanGroundTruthEventV2({ eventId: "truth", sessionId: "runtime", subject,
    fact: { kind: "expected-task-settlement", expectedQuestionType: "ai-ml-system-design", expectedRelation: "child-probe", expectedParentAction: "attach-child" },
    source: "explicit-ui", sourceTraceId: "attempt", now: 4 });
  const projection = deriveHumanEvaluationProjectionV2({ sessionId: "runtime", subject, events: [event], now: 5 });
  const evaluation = { id: "v1", sessionId: "runtime", questionId: "trace:attempt", traceIds: ["attempt"], expectedRelation: "child-probe", updatedAt: 4,
    selectedDiagramOverlayIds: [], memoryEntryLabels: [], missingExpectedMemory: [],
    ...Object.fromEntries(["classification", "playbook", "playbookPhase", "memory", "whiteboard", "manualPhaseTransition", "diagramOverlay", "guardrail", "answer"]
      .map(key => [key, { verdict: "not_applicable", reasons: [] }])),
  };
  const files = {
    "manifest.json": JSON.stringify({ sessionId: "session_recording_a", status: "running" }),
    "runtime-inference/task-relation-decisions.jsonl": JSON.stringify(decision) + "\n",
    "taxonomy/question-type-adjudications.jsonl": JSON.stringify(decision) + "\n",
    "taxonomy/question-type-adjudication-outcomes.jsonl": "",
    "human-evaluation/question-evaluations.json": JSON.stringify({ evaluations: [evaluation] }),
    "human-evaluation/projections-v2.json": JSON.stringify({ projections: [projection] }),
    "human-evaluation/ground-truth-v2.jsonl": JSON.stringify(event) + "\n",
    "traces/attempt.json": JSON.stringify({ exportedAt: 3, trace: { id: "attempt", status: "success", metadata } }),
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(session, name)), { recursive: true });
    await writeFile(path.join(session, name), content);
  }
  const run = (script, output) => execFileSync(process.execPath, [path.join(compiled, "scripts", script),
    "--session", session, "--output", path.join(root, output), "--allow-incomplete"], { cwd: repo });
  const read = async name => JSON.parse(await readFile(path.join(root, name), "utf8"));
  for (const n of [1, 2]) {
    run("reflect-taxonomy-adjudication-session.js", "single" + n);
    run("reflect-session-longitudinal-evaluation.js", "long" + n);
  }
  const singleType = await read("single1/question-type-outcomes.json");
  const singleRelation = await read("single1/relation-reflection.json");
  const longitudinal = await read("long1/report.json");
  assert.deepEqual(stable(singleType), stable(longitudinal.adjudicationEvidence[0].questionType));
  assert.deepEqual(stable(singleRelation), stable(longitudinal.adjudicationEvidence[0].relation));
  for (const [file, first] of [["question-type-outcomes.json", singleType], ["relation-reflection.json", singleRelation]])
    assert.deepEqual(stable(first), stable(await read("single2/" + file)));
  assert.deepEqual(stable(longitudinal), stable(await read("long2/report.json")));
  const directType = buildQuestionTypeAdjudicationOutcomeReport({ decisions: [decision], settlements: [decision, terminal], outcomes: [], projections: [projection] });
  const directRelation = buildTaskRelationAdjudicationReflectionReport({ decisions: [decision], settlements: [terminal], evaluations: [evaluation], projections: [projection] });
  assert.deepEqual(singleType.rows, JSON.parse(JSON.stringify(directType.rows)));
  assert.deepEqual(singleType.metrics, directType.metrics);
  assert.deepEqual(singleRelation.rows, JSON.parse(JSON.stringify(directRelation.rows)));
  assert.deepEqual(singleRelation.metrics, directRelation.metrics);
  assert.equal(singleRelation.metrics.coveredLegacyEvaluationCount, 1);
  assert.equal(singleRelation.metrics.unmatchedEvaluationCount, 0);
  assert.equal(singleType.metrics.productVisibleCommitted, 1);
  assert.equal(singleType.metrics.terminalCoverage, 0);
  assert.equal(singleType.metrics.validProposalOperations, 0);
  assert.equal(longitudinal.evidenceScope.releaseEligible, false);
  assert.equal(await readFile(path.join(session, "manifest.json"), "utf8"), files["manifest.json"]);
  assert.equal(await readFile(path.join(session, "human-evaluation/ground-truth-v2.jsonl"), "utf8"), files["human-evaluation/ground-truth-v2.jsonl"]);
});
