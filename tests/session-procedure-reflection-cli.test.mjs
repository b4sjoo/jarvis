import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  assert.deepEqual(procedure.steps[0].observed.contextSourceTurnIds, [
    "turn-setup",
    "turn-previous",
  ]);
  assert.equal(procedure.steps[0].observed.questionType, "coding");
  assert.equal(procedure.steps[0].observed.relation, "new-parent");
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

test("writes typed Screen fixture paths and digests without enabling replay", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "jarvis-procedure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = path.join(root, "session-screen");
  await writeSessionFixture(session, true);
  const screenshots = path.join(session, "screenshots");
  await mkdir(screenshots, { recursive: true });
  const image = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02]);
  const focusImage = Buffer.from([0xff, 0xd8, 0xff, 0x03, 0x04]);
  const metadata = Buffer.from('{"id":"screen-1"}\n', "utf8");
  await Promise.all([
    writeFile(path.join(screenshots, "screen-1.jpeg"), image),
    writeFile(path.join(screenshots, "screen-1.focus.jpeg"), focusImage),
    writeFile(path.join(screenshots, "screen-1.metadata.json"), metadata),
  ]);
  await writeFile(
    path.join(session, "timeline.jsonl"),
    `${JSON.stringify({
      id: "timeline-screen",
      kind: "screen-capture",
      createdAt: 300,
      traceId: "trace-screen",
      metadata: {
        observationId: "screen-1",
        imageMediaType: "image/jpeg",
        focusImageMediaType: "image/jpeg",
      },
      artifactRefs: [
        "screenshots/screen-1.jpeg",
        "screenshots/screen-1.focus.jpeg",
        "screenshots/screen-1.metadata.json",
      ],
    })}\n`,
    { flag: "a" }
  );
  const traceSummariesPath = path.join(
    session,
    "metrics",
    "trace-summaries.latest.json"
  );
  const traceSummaries = JSON.parse(
    await readFile(traceSummariesPath, "utf8")
  );
  traceSummaries.traces.push({
    traceId: "trace-screen",
    logicalQuestionUnitId: "lqu-screen",
    logicalQuestionUnitRevision: 1,
    logicalQuestionSourceTurnIds: [],
    logicalQuestionContextSourceTurnIds: [],
    questionType: "coding",
    taskRelation: "new-parent",
    currentQuestionSettlement: {
      questionType: "coding",
      relation: "new-parent",
      contextReadScope: "current-only",
      disposition: "committed-parent",
    },
    stableAnswerCommitDisposition: "committed",
    advisorOutputCommittedToUi: true,
    requestedArtifacts: ["answer", "code", "complexity"],
  });
  await writeFile(
    traceSummariesPath,
    `${JSON.stringify(traceSummaries)}\n`,
    "utf8"
  );

  const result = runCompiler(session);
  assert.equal(result.status, 0, result.stderr);
  const procedure = JSON.parse(
    await readFile(
      path.join(
        session,
        "runtime-regression",
        "session-procedure.v1.json"
      ),
      "utf8"
    )
  );
  const screen = procedure.steps.find(
    (step) => step.kind === "screen-input"
  );

  assert.equal(screen.replaySupport, "capture-only");
  assert.deepEqual(screen.provenance.sourceObservationIds, ["screen-1"]);
  assert.deepEqual(screen.input.screen, {
    image: {
      path: "screenshots/screen-1.jpeg",
      sha256: sha256(image),
      mediaType: "image/jpeg",
    },
    focusImage: {
      path: "screenshots/screen-1.focus.jpeg",
      sha256: sha256(focusImage),
      mediaType: "image/jpeg",
    },
    metadata: {
      path: "screenshots/screen-1.metadata.json",
      sha256: sha256(metadata),
      mediaType: "application/json",
    },
  });
  assert.deepEqual(screen.evidenceGaps, []);
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

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
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
  await mkdir(path.join(sessionDirectory, "metrics"), {
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
        id: "timeline-ingress",
        kind: "capture-lifecycle",
        createdAt: 95,
        traceId: "trace-turn-1",
        metadata: {
          stage: "canonical-turn-ingress-admitted",
          canonicalTurnIngressTurnId: "turn-1",
          traceId: "trace-turn-1",
        },
      },
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
    path.join(sessionDirectory, "metrics", "trace-summaries.latest.json"),
    `${JSON.stringify({
      version: 1,
      traces: [
        {
          traceId: "trace-turn-1",
          logicalQuestionUnitId: "lqu-turn-1",
          logicalQuestionUnitRevision: 1,
          logicalQuestionSourceTurnIds: ["turn-1"],
          logicalQuestionContextSourceTurnIds: ["turn-setup"],
          logicalQuestionRecentLogicalQuestionSourceTurnIds: [
            "turn-previous",
          ],
          primaryAskSourceTurnIds: ["turn-1"],
          responseOpportunityDecision: "output-request",
          questionType: "coding",
          taskRelation: "new-parent",
          currentQuestionSettlement: {
            questionType: "coding",
            relation: "new-parent",
            contextReadScope: "current-only",
            disposition: "committed-parent",
          },
          stableAnswerCommitDisposition: "committed",
          advisorOutputCommittedToUi: true,
          requestedArtifacts: ["answer"],
        },
      ],
    })}\n`,
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
          subject: {
            attemptId: "trace-turn-1",
            traceIds: ["trace-turn-1"],
            sourceTurnIds: ["turn-1"],
          },
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
              subject: {
                attemptId: "trace-turn-1",
                traceIds: ["trace-turn-1"],
                sourceTurnIds: ["turn-1"],
              },
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
