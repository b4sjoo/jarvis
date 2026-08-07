import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildLocalIntentAnnotationPilot } from "../scripts/lib/local-intent-annotation-pilot.js";
import { LocalIntentAnnotationStore } from "../scripts/lib/local-intent-annotation-store.js";
import { routeLocalIntentAnnotationRequest } from "../scripts/lib/local-intent-annotation-workbench.js";
import type {
  LocalIntentAnnotationPilotCard,
  LocalIntentAnnotationSubmission,
} from "../scripts/lib/local-intent-annotation-schema.js";

test("builds a deterministic blinded 80-card pilot with balanced strata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jarvis-intent-pilot-"));
  const corpus = path.join(root, "corpus");
  const firstOutput = path.join(root, "pilot-a");
  const secondOutput = path.join(root, "pilot-b");
  await createCorpusFixture(corpus, 96);

  const first = await buildLocalIntentAnnotationPilot({
    corpusRoot: corpus,
    outputRoot: firstOutput,
    seed: "pilot-seed",
    size: 80,
    now: 1,
  });
  const second = await buildLocalIntentAnnotationPilot({
    corpusRoot: corpus,
    outputRoot: secondOutput,
    seed: "pilot-seed",
    size: 80,
    now: 2,
  });

  assert.equal(first.manifest.pilotId, second.manifest.pilotId);
  assert.equal(first.cards.length, 80);
  assert.deepEqual(first.manifest.stratumCounts, {
    "clear-technical": 20,
    "transition-boundary": 20,
    "discourse-boundary": 20,
    "phase-correction-constraint": 20,
  });
  assert.equal(
    new Set(first.selectionAudit.map((row) => row.rootGroupId)).size,
    80
  );
  assert.equal(
    await readFile(path.join(firstOutput, "pilot-cards.jsonl"), "utf8"),
    await readFile(path.join(secondOutput, "pilot-cards.jsonl"), "utf8")
  );
  assert.equal(
    await readFile(path.join(firstOutput, "pilot-selection-audit.jsonl"), "utf8"),
    await readFile(path.join(secondOutput, "pilot-selection-audit.jsonl"), "utf8")
  );
  for (const card of first.cards) {
    assert.deepEqual(Object.keys(card).sort(), [
      "cardId",
      "context",
      "contextHash",
      "exampleId",
      "ordinal",
      "pilotId",
      "schemaVersion",
      "source",
      "sourceHash",
      "sourceText",
      "sourceUnitId",
    ]);
    assert.ok(card.context.interveningMeText.length > 0);
    assert.equal("hiddenCandidateIds" in card, false);
    assert.equal("stratum" in card, false);
    assert.equal("score" in card, false);
  }
});

test("persists append-only revisions and resumes from the latest annotation", async () => {
  const fixture = await createPilotFixture(8);
  let now = 500;
  const store = await LocalIntentAnnotationStore.open({
    pilotRoot: fixture.pilot,
    annotationRoot: fixture.annotations,
    annotator: "season",
    now: () => now,
  });
  const card = store.cards[0];
  const first = await store.submit(confirmedSubmission(card, 100, 200));
  now = 700;
  const second = await store.submit({
    ...confirmedSubmission(card, 300, 400),
    labels: {
      ...confirmedSubmission(card, 300, 400).labels!,
      questionType: "general-system-design",
    },
  });

  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.equal(second.supersedesAnnotationId, first.annotationId);
  assert.equal(store.latestRecords("initial")[0].annotationId, second.annotationId);
  assert.equal(store.progress().completedCards, 1);
  assert.equal(store.progress().latestRevisionCount, 1);
  assert.equal(
    (await readFile(path.join(fixture.annotations, "annotations.jsonl"), "utf8"))
      .trim()
      .split("\n").length,
    2
  );

  const reopened = await LocalIntentAnnotationStore.open({
    pilotRoot: fixture.pilot,
    annotationRoot: fixture.annotations,
    annotator: "season",
    now: () => 800,
  });
  assert.equal(reopened.latestRecords("initial")[0].revision, 2);
  await assert.rejects(
    reopened.submit({
      ...confirmedSubmission(reopened.cards[1], 500, 600),
      evaluationFacts: undefined,
    }),
    /requires all semantic blocks and Should Advise/
  );
});

test("serves token-protected blinded routes and accepts a valid card", async () => {
  const fixture = await createPilotFixture(8);
  const store = await LocalIntentAnnotationStore.open({
    pilotRoot: fixture.pilot,
    annotationRoot: fixture.annotations,
    annotator: "season",
  });
  const page = await dispatchWorkbenchRequest({
    store,
    url: "/?token=fixture-token",
    method: "GET",
  });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(page.body, /Task 155 · Blinded Pilot/);

  const forbidden = await dispatchWorkbenchRequest({
    store,
    url: "/api/state",
    method: "GET",
  });
  assert.equal(forbidden.status, 403);
  const stateResponse = await dispatchWorkbenchRequest({
    store,
    url: "/api/state",
    method: "GET",
    token: "fixture-token",
  });
  assert.equal(stateResponse.status, 200);
  const state = JSON.parse(stateResponse.body) as {
    cards: LocalIntentAnnotationPilotCard[];
    progress: { completedCards: number };
  };
  assert.equal(state.cards.length, 8);
  assert.equal(state.progress.completedCards, 0);
  assert.equal("hiddenCandidateValues" in state.cards[0], false);

  const response = await dispatchWorkbenchRequest({
    store,
    url: "/api/annotations",
    method: "POST",
    token: "fixture-token",
    body: JSON.stringify(confirmedSubmission(state.cards[0], 100, 200)),
  });
  assert.equal(response.status, 200);
  const body = JSON.parse(response.body) as {
    record: { revision: number };
    progress: { completedCards: number };
  };
  assert.equal(body.record.revision, 1);
  assert.equal(body.progress.completedCards, 1);
});

async function dispatchWorkbenchRequest(input: {
  store: LocalIntentAnnotationStore;
  url: string;
  method: string;
  token?: string;
  body?: string;
}) {
  const request = Readable.from(input.body ? [Buffer.from(input.body)] : []) as IncomingMessage;
  request.url = input.url;
  request.method = input.method;
  request.headers = {
    host: "127.0.0.1",
    ...(input.token ? { "x-jarvis-annotation-token": input.token } : {}),
  };
  const headers = new Map<string, string>();
  let body = "";
  const responseState = {
    statusCode: 200,
    writableEnded: false,
    setHeader(name: string, value: string | number | readonly string[]) {
      headers.set(name.toLowerCase(), String(value));
      return this;
    },
    end(value?: string | Uint8Array) {
      body = value ? Buffer.from(value).toString("utf8") : "";
      responseState.writableEnded = true;
      return responseState;
    },
  };
  const response = responseState as unknown as ServerResponse;
  await routeLocalIntentAnnotationRequest({
    request,
    response,
    token: "fixture-token",
    store: input.store,
  });
  return { status: response.statusCode, headers, body };
}

function confirmedSubmission(
  card: LocalIntentAnnotationPilotCard,
  startedAt: number,
  submittedAt: number
): LocalIntentAnnotationSubmission {
  return {
    pilotId: card.pilotId,
    cardId: card.cardId,
    exampleId: card.exampleId,
    sourceHash: card.sourceHash,
    contextHash: card.contextHash,
    pass: "initial",
    status: "confirmed",
    labels: {
      speechAct: { primary: "question", secondary: [] },
      questionType: "coding",
      phaseControl: {
        transitionIntent: "none",
        assumptionAuthorized: "no",
        requirementsComplete: "no",
      },
    },
    evaluationFacts: { shouldAdvise: "advise" },
    interaction: { startedAt, submittedAt },
  };
}

async function createPilotFixture(size: number) {
  const root = await mkdtemp(path.join(os.tmpdir(), "jarvis-intent-labels-"));
  const corpus = path.join(root, "corpus");
  const pilot = path.join(root, "pilot");
  const annotations = path.join(root, "annotations");
  await createCorpusFixture(corpus, Math.max(size + 8, 16));
  await buildLocalIntentAnnotationPilot({
    corpusRoot: corpus,
    outputRoot: pilot,
    seed: "store-seed",
    size,
    now: 1,
  });
  return { root, corpus, pilot, annotations };
}

async function createCorpusFixture(corpusRoot: string, count: number) {
  await mkdir(corpusRoot, { recursive: true });
  const examples = [];
  const candidates = [];
  const reviews = [];
  const inventory = [];
  const texts = [
    "Please move on to the next phase and assume the remaining requirements.",
    "Mm, okay.",
    "Now let's switch to another system design question.",
    "Please design a URL shortener and estimate QPS.",
  ];
  for (let index = 0; index < count; index += 1) {
    const containerId = `container-${index}`;
    const exampleId = `example-${index}`;
    const sourceText = `${texts[index % texts.length]} Case ${index}.`;
    inventory.push({ containerId, integrity: "complete" });
    examples.push({
      schemaVersion: 1,
      exampleId,
      sourceUnitId: `unit-${index}`,
      unitKind: "lqu-revision",
      sourceKind: "session-recording",
      sourceText,
      semanticText: sourceText,
      language: "en",
      modality: "voice",
      createdAt: index + 1,
      provenance: {
        sessionIdHash: `session-hash-${Math.floor(index / 4)}`,
        orderedSourceTurnIdHashes: [`turn-${index}`],
        sourceObservationIdHashes: [],
        sourceTraceIdHashes: [],
        sourceRefs: [
          {
            containerId,
            relativePath: "transcripts/turns.jsonl",
            pointer: `line:${index + 1}`,
            recordHash: `record-${index}`,
          },
        ],
        materialization: "recorded-exact",
      },
      boundedContext: {
        activeParentType: "general-system-design",
        activePhase: "requirements",
        previousInterviewerText: `Previous interviewer turn ${index}`,
        interveningMeText: [`Intervening answer ${index}`],
      },
      grouping: {
        rootGroupId: `root-${index}`,
        sessionGroupId: `session-${Math.floor(index / 4)}`,
        interviewGroupId: `interview-${Math.floor(index / 12)}`,
        problemFamilyId: `problem-${index}`,
      },
      eligibility: "train-candidate",
    });
    candidates.push({
      schemaVersion: 1,
      candidateId: `candidate-${index}`,
      exampleId,
      head: "question-type",
      value:
        index % 4 === 3
          ? "general-system-design"
          : index % 4 === 2
            ? "coding"
            : "unknown",
      applicability: "applicable",
      authority: "runtime-observed",
      confirmation: "none",
      sourceJoin: "exact-id",
      sourceIntegrity: "complete",
      disposition: "weak",
      supportingEventIds: [],
      conflictIds: [],
    });
    if (index % 4 === 2) {
      reviews.push({
        schemaVersion: 1,
        itemId: `review-${index}`,
        exampleId,
        head: "question-type",
        reason: "gold-weak-disagreement",
        priority: 0,
        candidateIds: [`candidate-${index}`],
        status: "open",
      });
    }
  }
  await writeFile(
    path.join(corpusRoot, "build-manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      builderRevision: "fixture-v1",
      seed: "fixture",
      cutoff: "2026-08-08T00:00:00.000Z",
      sourceSnapshotHash: "source",
      configHash: "config",
      buildId: "fixture-build",
      outputs: [],
    })}\n`,
    "utf8"
  );
  await writeJsonLines(path.join(corpusRoot, "normalized-examples.jsonl"), examples);
  await writeJsonLines(path.join(corpusRoot, "label-candidates.jsonl"), candidates);
  await writeJsonLines(path.join(corpusRoot, "review-queue.jsonl"), reviews);
  await writeJsonLines(path.join(corpusRoot, "source-inventory.jsonl"), inventory);
}

async function writeJsonLines(filePath: string, rows: unknown[]) {
  await writeFile(
    filePath,
    rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""),
    "utf8"
  );
}
