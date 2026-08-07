import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildLocalIntentCorpusReadiness } from "../scripts/lib/local-intent-corpus-readiness.js";
import {
  assertOutputSeparatedFromSources,
  assertSourceTreeUnchanged,
  snapshotSourceTree,
  streamJsonLines,
} from "../scripts/lib/local-intent-corpus-source-reader.js";

test("builds a deterministic private sidecar without modifying source trees", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jarvis-corpus-"));
  const recordings = path.join(root, "recordings");
  const captures = path.join(root, "captures");
  const overlays = path.join(root, "overlays.json");
  const output = path.join(root, "derived", "corpus");
  await createSessionFixture(recordings);
  await createSttFixture(captures);
  await writeFile(overlays, "[]\n", "utf8");
  const beforeRecordings = await snapshotSourceTree(recordings);
  const beforeCaptures = await snapshotSourceTree(captures);

  const first = await buildLocalIntentCorpusReadiness({
    recordingsRoot: recordings,
    sttCapturesRoot: captures,
    overlaysPath: overlays,
    outputRoot: output,
    seed: "fixture-seed",
    cutoff: "2026-08-08T00:00:00.000Z",
    now: 1,
  });
  const firstManifest = await readFile(
    path.join(output, "build-manifest.json"),
    "utf8"
  );
  const normalized = await readJsonLines(
    path.join(output, "normalized-examples.jsonl")
  );
  const labels = await readJsonLines(path.join(output, "label-ledger.jsonl"));
  const splitPlan = JSON.parse(
    await readFile(path.join(output, "split-plan.json"), "utf8")
  ) as { exampleAssignments: Record<string, string> };

  assert.equal(first.sourceCount, 2);
  assert.ok(first.exampleCount >= 3);
  assert.ok(normalized.some((row) => row.unitKind === "lqu-revision"));
  assert.ok(normalized.some((row) => row.sourceKind === "stt-evaluation-capture"));
  const sessionExample = normalized.find(
    (row) => row.unitKind === "lqu-revision"
  );
  const sttExamples = normalized.filter(
    (row) => row.sourceKind === "stt-evaluation-capture"
  );
  assert.ok(sessionExample);
  assert.equal(sttExamples.length, 2);
  assert.equal(
    sttExamples[0].grouping.sttVariantGroupId,
    sttExamples[1].grouping.sttVariantGroupId
  );
  assert.ok(
    sttExamples.some(
      (example) =>
        example.grouping.sessionGroupId === sessionExample.grouping.sessionGroupId
    )
  );
  assert.equal(
    splitPlan.exampleAssignments[sttExamples[0].exampleId],
    splitPlan.exampleAssignments[sessionExample.exampleId]
  );
  assert.equal(
    splitPlan.exampleAssignments[sttExamples[1].exampleId],
    splitPlan.exampleAssignments[sessionExample.exampleId]
  );
  assert.ok(
    labels.some(
      (row) =>
        row.heads?.["question-type"]?.state === "gold" &&
        row.heads?.["question-type"]?.value === "general-system-design"
    )
  );
  const followUpExample = normalized.find(
    (row) => row.sourceText === "What storage would you use?"
  );
  assert.equal(
    followUpExample?.boundedContext?.previousInterviewerText,
    "Design a fixture system."
  );
  assert.deepEqual(followUpExample?.boundedContext?.interveningMeText, [
    "I would start with the write path.",
  ]);
  assert.equal(first.qualityReport.goNoGo.threeHeadTraining, "no-go");
  assert.equal(
    first.qualityReport.usableSplitCountsByHead["speech-act"].excluded,
    first.exampleCount
  );
  assert.equal(
    Object.entries(
      first.qualityReport.usableSplitCountsByHead["question-type"]
    )
      .filter(([split]) => split !== "excluded")
      .reduce((sum, [, count]) => sum + count, 0),
    1
  );
  assert.doesNotMatch(
    await readFile(path.join(output, "quality-report.json"), "utf8"),
    /Design a fixture system/
  );

  const second = await buildLocalIntentCorpusReadiness({
    recordingsRoot: recordings,
    sttCapturesRoot: captures,
    overlaysPath: overlays,
    outputRoot: output,
    seed: "fixture-seed",
    cutoff: "2026-08-08T00:00:00.000Z",
    now: 2,
  });
  assert.equal(first.buildId, second.buildId);
  assert.equal(
    firstManifest,
    await readFile(path.join(output, "build-manifest.json"), "utf8")
  );
  assertSourceTreeUnchanged(
    beforeRecordings,
    await snapshotSourceTree(recordings)
  );
  assertSourceTreeUnchanged(beforeCaptures, await snapshotSourceTree(captures));
});

test("reports malformed JSONL rows and rejects output within a source root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jarvis-corpus-lines-"));
  const file = path.join(root, "rows.jsonl");
  await writeFile(file, '{"ok":true}\nnot-json\n', "utf8");
  const rows = [];
  for await (const row of streamJsonLines<Record<string, unknown>>(file)) rows.push(row);
  assert.equal(rows[0].value?.ok, true);
  assert.ok(rows[1].error);
  await assert.rejects(
    assertOutputSeparatedFromSources(path.join(root, "output"), [root]),
    /separate from source root/
  );
});

async function createSessionFixture(recordingsRoot: string) {
  const session = path.join(recordingsRoot, "session-fixture");
  await mkdir(path.join(session, "transcripts"), { recursive: true });
  await mkdir(path.join(session, "traces", "trace-1"), { recursive: true });
  await mkdir(path.join(session, "human-evaluation"), { recursive: true });
  await writeJson(path.join(session, "manifest.json"), {
    version: 1,
    sessionId: "session-fixture-native",
    status: "stopped",
    startedAt: 100,
    stoppedAt: 1000,
    recordingIntegrity: { status: "complete" },
  });
  await writeFile(
    path.join(session, "transcripts", "turns.jsonl"),
    [
      {
        id: "turn-1",
        speaker: "them",
        text: "Design a fixture system.",
        startedAt: 200,
        endedAt: 300,
        isFinal: true,
        source: "system-audio",
      },
      {
        id: "turn-me-1",
        speaker: "me",
        text: "I would start with the write path.",
        startedAt: 325,
        endedAt: 350,
        isFinal: true,
        source: "microphone",
      },
      {
        id: "turn-2",
        speaker: "them",
        text: "What storage would you use?",
        startedAt: 400,
        endedAt: 500,
        isFinal: true,
        source: "system-audio",
      },
    ].map((value) => JSON.stringify(value)).join("\n") + "\n",
    "utf8"
  );
  await writeJson(
    path.join(session, "traces", "trace-1", "current-question-settlement.json"),
    {
      version: 1,
      recordedAt: 310,
      sessionId: "session-fixture-native",
      traceId: "trace-1",
      currentQuestion: {
        logicalQuestionUnitId: "lqu-1",
        revision: 1,
        runtimeEpoch: 1,
        normalizedText: "Design a fixture system.",
        sourceTurnIds: ["turn-1"],
        sourceObservationIds: [],
        sourceKind: "voice",
      },
      settlement: { questionType: "general-system-design" },
      parentBefore: {},
      parentAfter: { questionType: "general-system-design" },
    }
  );
  await writeFile(
    path.join(session, "human-evaluation", "ground-truth-v2.jsonl"),
    `${JSON.stringify({
      schemaVersion: 2,
      eventId: "truth-1",
      sessionId: "session-fixture-native",
      subject: {
        traceIds: ["trace-1"],
        sourceTurnIds: ["turn-1"],
      },
      fact: {
        kind: "expected-question-type",
        expectedQuestionType: "general-system-design",
      },
      provenance: {
        source: "explicit-ui",
        actor: "human",
        recordedAt: 600,
      },
      confirmation: "confirmed",
    })}\n`,
    "utf8"
  );
}

async function createSttFixture(capturesRoot: string) {
  const capture = path.join(capturesRoot, "stt-eval-fixture");
  await mkdir(path.join(capture, "canonical"), { recursive: true });
  await mkdir(path.join(capture, "provider-events"), { recursive: true });
  await mkdir(path.join(capture, "references"), { recursive: true });
  await writeJson(path.join(capture, "manifest.json"), {
    schemaVersion: 1,
    sessionId: "stt-fixture-native",
    status: "stopped",
    startedAt: 200,
    endedAt: 800,
    finalization: { manifestFinalized: true, rawWriterDrained: true },
  });
  await writeFile(
    path.join(capture, "canonical", "transcript-turns.jsonl"),
    `${JSON.stringify({
      sessionId: "stt-fixture-native",
      recordedAt: 300,
      payload: {
        utteranceId: "turn-1",
        traceId: "trace-1",
        audioSessionId: "audio-1",
        audioSegmentSequence: 1,
        canonicalText: "Explain the fixture index.",
        recordedAt: 300,
        turn: { id: "turn-1", text: "Explain the fixture index." },
      },
    })}\n`,
    "utf8"
  );
  await writeFile(
    path.join(capture, "provider-events", "raw-transcript-revisions.jsonl"),
    `${JSON.stringify({
      sessionId: "stt-fixture-native",
      recordedAt: 290,
      payload: {
        utteranceId: "submitted-utterance-1",
        traceId: "trace-1",
        audioSessionId: "audio-1",
        audioSegmentSequence: 1,
        attemptId: "attempt-1",
        rawText: "Explain fixture index.",
        receivedAt: 290,
      },
    })}\n`,
    "utf8"
  );
  await writeFile(
    path.join(capture, "references", "human-corrections.jsonl"),
    "",
    "utf8"
  );
}

async function writeJson(filePath: string, value: unknown) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJsonLines(filePath: string) {
  return (await readFile(filePath, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>);
}
