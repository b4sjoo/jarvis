import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("writes a replay-safe procedure for a scripted recording", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "jarvis-procedure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = path.join(root, "session-scripted");
  await writeSessionFixture(session, true);

  const result = runCompiler(session);
  assert.equal(result.status, 0, result.stderr);
  const procedurePath = path.join(
    session,
    "runtime-regression",
    "session-procedure.v1.json"
  );
  const procedure = JSON.parse(await readFile(procedurePath, "utf8"));

  assert.equal(procedure.schemaVersion, 1);
  assert.equal(procedure.execution.defaultBarrier, "typed-terminal");
  assert.equal(procedure.steps.length, 2);
  assert.equal(procedure.steps[0].kind, "them-text");
  assert.equal(procedure.steps[0].expected.questionType, "coding");
  assert.equal(procedure.steps[1].kind, "force-advise");
  assert.deepEqual(procedure.steps[1].input, {});
  assert.equal("targetStepId" in procedure.steps[1].input, false);
  assert.equal(
    procedure.steps[1].observed.logicalQuestionUnitId,
    "original-lqu"
  );
});

test("skips an organic recording without writing a procedure", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "jarvis-procedure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = path.join(root, "session-organic");
  await writeSessionFixture(session, false);

  const result = runCompiler(session);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /session-is-not-scripted/);
  await assert.rejects(
    readFile(
      path.join(
        session,
        "runtime-regression",
        "session-procedure.v1.json"
      ),
      "utf8"
    ),
    { code: "ENOENT" }
  );
});

function runCompiler(sessionDirectory) {
  return spawnSync(
    "npm",
    [
      "run",
      "session:procedure:reflect",
      "--",
      "--session",
      sessionDirectory,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: process.env,
    }
  );
}

async function writeSessionFixture(sessionDirectory, scriptedValidation) {
  await mkdir(path.join(sessionDirectory, "transcripts"), {
    recursive: true,
  });
  await mkdir(path.join(sessionDirectory, "human-evaluation"), {
    recursive: true,
  });
  await mkdir(path.join(sessionDirectory, "runtime-regression"), {
    recursive: true,
  });
  await writeFile(
    path.join(sessionDirectory, "manifest.json"),
    `${JSON.stringify({
      sessionId: "recording-1",
      folderName: path.basename(sessionDirectory),
      endedAt: 500,
      ...(scriptedValidation ? { scriptedValidation: true } : {}),
      recordingIntegrity: { status: "complete" },
    })}\n`,
    "utf8"
  );
  await writeFile(
    path.join(sessionDirectory, "transcripts", "turns.jsonl"),
    `${JSON.stringify({
      id: "turn-1",
      speaker: "them",
      source: "system-audio",
      text: "Implement an LRU cache.",
      startedAt: 100,
      endedAt: 100,
      isFinal: true,
    })}\n`,
    "utf8"
  );
  await writeFile(
    path.join(sessionDirectory, "timeline.jsonl"),
    [
      {
        id: "timeline-turn",
        kind: "transcript-turn",
        createdAt: 100,
        metadata: { turnId: "turn-1" },
      },
      {
        id: "timeline-action",
        kind: "manual-runtime-action",
        createdAt: 200,
        metadata: { actionId: "action-1", stage: "requested" },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n",
    "utf8"
  );
  await writeFile(
    path.join(
      sessionDirectory,
      "runtime-regression",
      "manual-actions.v1.jsonl"
    ),
    [
      {
        schemaVersion: 1,
        actionId: "action-1",
        action: "force-advise",
        stage: "requested",
        runtimeSessionId: "meeting-1",
        runtimeEpoch: 1,
        uiSurface: "meeting-response-actions",
        occurredAt: 200,
      },
      {
        schemaVersion: 1,
        actionId: "action-1",
        action: "force-advise",
        stage: "terminal",
        runtimeSessionId: "meeting-1",
        runtimeEpoch: 1,
        uiSurface: "meeting-response-actions",
        occurredAt: 250,
        traceId: "trace-force",
        observedLogicalQuestionUnitId: "original-lqu",
        terminalDisposition: "completed",
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n",
    "utf8"
  );
  await writeFile(
    path.join(
      sessionDirectory,
      "human-evaluation",
      "projections-v2.json"
    ),
    `${JSON.stringify({
      projections: [
        {
          schemaVersion: 2,
          projectionId: "projection-1",
          sessionId: "meeting-1",
          subject: { traceIds: [], sourceTurnIds: ["turn-1"] },
          derivationVersion: "human-evaluation-v2.11",
          inputEventIds: ["truth-1"],
          semanticInputEventIds: ["truth-1"],
          interventionOnlyEventIds: [],
          inputTraceHashes: [],
          activeFacts: {
            "expected-task-settlement": {
              schemaVersion: 2,
              eventId: "truth-1",
              sessionId: "meeting-1",
              subject: { traceIds: [], sourceTurnIds: ["turn-1"] },
              fact: {
                kind: "expected-task-settlement",
                expectedQuestionType: "coding",
                expectedRelation: "new-parent",
                expectedParentAction: "create",
              },
              provenance: {
                source: "explicit-ui",
                actor: "human",
                collection: "scripted-validation",
                recordedAt: 450,
              },
              confirmation: "confirmed",
            },
          },
          verdicts: {},
          conflicts: [],
          computedAt: 450,
        },
      ],
    })}\n`,
    "utf8"
  );
}
