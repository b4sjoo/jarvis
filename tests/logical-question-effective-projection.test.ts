import assert from "node:assert/strict";
import test from "node:test";
import { applyActiveQuestionTermCorrection } from "../src/lib/meeting/active-question-term-correction.js";
import {
  projectAdvisorTranscriptForLogicalQuestion,
  projectEffectiveLogicalQuestionSources,
  projectEffectiveSourceTurnGroup,
  projectEffectiveTextForSourceTurn,
  type EffectiveLogicalQuestionModelRecord,
} from "../src/lib/meeting/logical-question-effective-projection.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import { buildResponseOpportunityRequest } from "../src/lib/meeting/response-opportunity-contract.js";
import { projectLogicalQuestionForAdjudication } from "../src/lib/meeting/taxonomy-adjudication.js";
import type {
  SpeechCorrection,
  TranscriptTurn,
} from "../src/lib/meeting/types.js";

test("projects one corrected semantic source while preserving raw source identity", () => {
  const corrected = correct(unit("Design a ride-sharing system for delivery."));
  const projection = projectEffectiveLogicalQuestionSources(corrected);

  assert.equal(projection.corrected, true);
  assert.deepEqual(projection.rawSourceTurnIds, ["turn-1"]);
  assert.deepEqual(projection.sourceTurnIds, ["turn-1"]);
  assert.match(projection.effectiveText, /RAG/);
  assert.doesNotMatch(projection.effectiveText, /ride-sharing/i);
  assert.equal(
    corrected.sources[0]?.text,
    "Design a ride-sharing system for delivery."
  );
});

test("PC1 historical effective spans and current correction project at a later execution epoch", () => {
  const corrected = correct(unit("Design a ride-sharing system for delivery."));
  const record = modelRecord(corrected);
  const originalRecord = structuredClone(record);
  const originalUnit = structuredClone(corrected);
  for (const logicalQuestionUnit of [undefined, corrected]) {
    for (const runtimeEpoch of [2, 3]) {
      const input = { effectiveRecords: [record], logicalQuestionUnit, sessionId: "session-1", runtimeEpoch };
      const single = projectEffectiveTextForSourceTurn({ ...input, turnId: "turn-1", text: corrected.sources[0].text });
      const batch = projectEffectiveSourceTurnGroup({ ...input, sources: [{ turnId: "turn-1", text: corrected.sources[0].text }] });
      const transcript = projectAdvisorTranscriptForLogicalQuestion({ ...input, turns: [turn("turn-1", "them", corrected.sources[0].text, 1)] });
      assert.match(single.text, /RAG/);
      assert.equal(single.logicalQuestionRevision, corrected.revision);
      assert.equal(batch.sources[0].text, single.text);
      assert.match(transcript.transcript, /RAG/);
      assert.doesNotMatch(transcript.transcript, /ride-sharing/);
    }
  }
  assert.deepEqual(record, originalRecord);
  assert.deepEqual(corrected, originalUnit);
});

test("PC5 historical projection selects latest revision before correction eligibility", () => {
  const corrected = correct(unit("Design a ride-sharing system for delivery."));
  const old = modelRecord(corrected);
  const latest = { ...old, logicalQuestionRevision: old.logicalQuestionRevision + 1,
    correctionIds: [], updatedAt: old.updatedAt + 1 };
  const input = { sources: [{ turnId: "turn-1", text: "Latest uncorrected source." }],
    effectiveRecords: [old, latest], sessionId: "session-1", runtimeEpoch: 3 };
  const result = projectEffectiveSourceTurnGroup(input);
  assert.deepEqual(result.sources, input.sources);
  assert.deepEqual(result.correctionIds, []);
  for (const patch of [{ runtimeEpoch: 4 }, { sessionId: "other-session" }]) {
    const rejected = projectEffectiveSourceTurnGroup({ ...input, effectiveRecords: [{ ...old, ...patch }],
      logicalQuestionUnit: { ...corrected, ...patch } });
    assert.deepEqual(rejected.sources, input.sources);
    assert.equal(rejected.replaced, false);
  }
});

test("uses the corrected projection for taxonomy and response opportunity", () => {
  const corrected = correct(unit("Design a ride-sharing system for delivery."));
  const taxonomy = projectLogicalQuestionForAdjudication(corrected);
  const response = buildResponseOpportunityRequest({
    logicalQuestionUnit: corrected,
    effectiveSources:
      projectEffectiveLogicalQuestionSources(corrected).sources,
  });

  assert.match(taxonomy.text, /RAG/);
  assert.doesNotMatch(taxonomy.text, /ride-sharing/i);
  assert.match(response.decisionSpans[0]?.text ?? "", /RAG/);
  assert.doesNotMatch(response.decisionSpans[0]?.text ?? "", /ride-sharing/i);
});

test("replaces covered Them turns only in the model transcript", () => {
  const corrected = correct(unit("Design a ride-sharing system for delivery."));
  const turns: TranscriptTurn[] = [
    turn("turn-setup", "them", "Let us discuss architecture.", 1),
    turn("turn-me", "me", "Do you mean an AI system?", 2),
    turn("turn-1", "them", "Design a ride-sharing system for delivery.", 3),
  ];
  const projection = projectAdvisorTranscriptForLogicalQuestion({
    turns,
    includedTurnIds: turns.map((item) => item.id),
    logicalQuestionUnit: corrected,
  });

  assert.equal(projection.replaced, true);
  assert.match(projection.transcript, /Them: Let us discuss architecture/);
  assert.match(projection.transcript, /Me: Do you mean an AI system/);
  assert.match(
    projection.transcript,
    /Corrected LQU logical-question-1 revision 2/
  );
  assert.match(projection.transcript, /RAG/);
  assert.doesNotMatch(projection.transcript, /ride-sharing/i);
  assert.match(projection.latestTurn?.text ?? "", /RAG/);
});

test("projects a corrected parent LQU during a later follow-up", () => {
  const correctedParent = correct(unit("Design a ride-sharing system for delivery."));
  const followUp = makeUnit({
    id: "logical-question-follow-up",
    turnId: "turn-follow-up",
    text: "What would you monitor in production?",
    startedAt: 5,
  });
  const projection = projectAdvisorTranscriptForLogicalQuestion({
    turns: [
      turn("turn-1", "them", "Design a ride-sharing system for delivery.", 1),
      turn("turn-follow-up", "them", followUp.normalizedText, 5),
    ],
    includedTurnIds: ["turn-1", "turn-follow-up"],
    logicalQuestionUnit: followUp,
    effectiveRecords: [modelRecord(correctedParent)],
    sessionId: "session-1",
    runtimeEpoch: 1,
  });

  assert.match(projection.transcript, /Design a RAG system/);
  assert.match(projection.transcript, /What would you monitor/);
  assert.doesNotMatch(projection.transcript, /ride-sharing/i);
  assert.deepEqual(projection.projectedLogicalQuestionUnitIds, [
    "logical-question-1",
  ]);
  assert.equal(projection.projectedTurnCount, 1);
});

test("projects multiple corrected LQUs while preserving Me and unrelated turns", () => {
  const first = correct(unit("Design a ride-sharing system for delivery."));
  const second = correct(
    makeUnit({
      id: "logical-question-2",
      turnId: "turn-2",
      text: "Compare ride-sharing retrieval options.",
      startedAt: 4,
    })
  );
  const projection = projectAdvisorTranscriptForLogicalQuestion({
    turns: [
      turn("turn-1", "them", "Design a ride-sharing system for delivery.", 1),
      turn("turn-me", "me", "Do you mean RAG?", 2),
      turn("turn-unrelated", "them", "Keep the answer concise.", 3),
      turn("turn-2", "them", "Compare ride-sharing retrieval options.", 4),
    ],
    includedTurnIds: ["turn-1", "turn-me", "turn-unrelated", "turn-2"],
    effectiveRecords: [modelRecord(first), modelRecord(second)],
    sessionId: "session-1",
    runtimeEpoch: 1,
  });

  assert.doesNotMatch(projection.transcript, /ride-sharing/i);
  assert.match(projection.transcript, /Me: Do you mean RAG/);
  assert.match(projection.transcript, /Them: Keep the answer concise/);
  assert.deepEqual(projection.projectedLogicalQuestionUnitIds, [
    "logical-question-1",
    "logical-question-2",
  ]);
});

test("lets an uncorrected in-flight revision supersede a corrected ledger record", () => {
  const corrected = correct(unit("Design a ride-sharing system for delivery."));
  const reversed = {
    ...unit("Design a ride-sharing system for delivery."),
    revision: corrected.revision + 1,
    updatedAt: corrected.updatedAt + 1,
  };
  const projection = projectAdvisorTranscriptForLogicalQuestion({
    turns: [
      turn("turn-1", "them", "Design a ride-sharing system for delivery.", 1),
    ],
    logicalQuestionUnit: reversed,
    effectiveRecords: [modelRecord(corrected)],
    sessionId: "session-1",
    runtimeEpoch: 1,
  });

  assert.equal(projection.replaced, false);
  assert.match(projection.transcript, /ride-sharing/);
  assert.doesNotMatch(projection.transcript, /Corrected LQU/);
});

test("keeps natural spoken corrections as raw conversation evidence", () => {
  const naturalCorrection: EffectiveLogicalQuestionModelRecord = {
    sessionId: "session-1",
    runtimeEpoch: 1,
    logicalQuestionUnitId: "logical-question-natural",
    logicalQuestionRevision: 2,
    sourceTurnIds: ["turn-old", "turn-natural-correction"],
    text: "Design a RAG system.",
    correctionIds: [],
    updatedAt: 4,
    settledAt: 5,
  };
  const projection = projectAdvisorTranscriptForLogicalQuestion({
    turns: [
      turn("turn-old", "them", "Design a ride-sharing system.", 1),
      turn("turn-natural-correction", "them", "Sorry, I mean RAG.", 2),
    ],
    effectiveRecords: [naturalCorrection],
    sessionId: "session-1",
    runtimeEpoch: 1,
  });

  assert.equal(projection.replaced, false);
  assert.match(projection.transcript, /ride-sharing/);
  assert.match(projection.transcript, /Sorry, I mean RAG/);
});

test("projects one corrected setup turn without widening its source scope", () => {
  const corrected = correct(unit("The ride-sharing corpus changes daily."));
  const record = modelRecord(corrected);
  const projection = projectEffectiveTextForSourceTurn({
    turnId: "turn-1",
    text: "The ride-sharing corpus changes daily.",
    effectiveRecords: [record],
    sessionId: "session-1",
    runtimeEpoch: 1,
  });

  assert.equal(projection.replaced, true);
  assert.match(projection.text, /RAG/);
  assert.doesNotMatch(projection.text, /ride-sharing/i);
  assert.equal(projection.logicalQuestionUnitId, "logical-question-1");
});

test("projects every corrected source in a bounded setup group", () => {
  const corrected = correct(unit("The ride-sharing corpus changes daily."));
  const projection = projectEffectiveSourceTurnGroup({
    sources: [
      {
        turnId: "turn-1",
        text: "The ride-sharing corpus changes daily.",
        startedAt: 1,
      },
      {
        turnId: "turn-2",
        text: "Documents have access control lists.",
        startedAt: 2,
      },
    ],
    effectiveRecords: [modelRecord(corrected)],
    sessionId: "session-1",
    runtimeEpoch: 1,
  });

  assert.equal(projection.replaced, true);
  assert.deepEqual(projection.replacedTurnIds, ["turn-1"]);
  assert.match(projection.sources[0]?.text ?? "", /RAG/);
  assert.doesNotMatch(projection.sources[0]?.text ?? "", /ride-sharing/i);
  assert.equal(
    projection.sources[1]?.text,
    "Documents have access control lists."
  );
  assert.deepEqual(projection.correctionIds, ["correction-1"]);
});

test("an explicit empty source selection remains empty with corrected ledger evidence", () => {
  const corrected = correct(unit("Design a ride-sharing system for delivery."));
  const projection = projectAdvisorTranscriptForLogicalQuestion({
    turns: [turn("turn-1", "them", "Design a ride-sharing system for delivery.", 1)],
    includedTurnIds: [],
    effectiveRecords: [modelRecord(corrected)],
  });
  assert.equal(projection.transcript, "");
  assert.equal(projection.latestTurn, undefined);
  assert.equal(projection.rawChars, 0);
  assert.equal(projection.projectedTurnCount, 0);
});

test("partial corrected source selection bounds both transcript and latest-turn text", () => {
  const original = unit("The ride-sharing corpus is private.");
  const second = { turnId: "turn-2", text: "The ride-sharing index is public.", startedAt: 3, endedAt: 4 };
  const corrected = correct({
    ...original,
    currentTurnId: second.turnId,
    sourceTurnIds: ["turn-1", second.turnId],
    sources: [...original.sources, second],
    normalizedText: `${original.normalizedText} ${second.text}`,
  });
  const projection = projectAdvisorTranscriptForLogicalQuestion({
    turns: [turn("turn-1", "them", original.normalizedText, 1), turn(second.turnId, "them", second.text, 3)],
    includedTurnIds: [second.turnId],
    effectiveRecords: [modelRecord(corrected)],
  });
  assert.match(projection.transcript, /RAG index is public/);
  assert.match(projection.latestTurn?.text ?? "", /RAG index is public/);
  assert.doesNotMatch(projection.transcript, /corpus is private|ride-sharing/);
  assert.doesNotMatch(projection.latestTurn?.text ?? "", /corpus is private|ride-sharing/);
});

test("C4/C5 group selects ledger once while preserving order, repeated IDs and source metadata", () => {
  const corrected = correct(unit("The ride-sharing corpus changes daily."));
  let selections = 0;
  const effectiveRecords = new Proxy([modelRecord(corrected)], {
    get(target, key, receiver) {
      if (key === "filter") selections += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  const sources = [
    { turnId: "other", text: "Public documentation.", startedAt: 9 },
    { turnId: "turn-1", text: "The ride-sharing corpus changes daily.", startedAt: 1 },
    { turnId: "turn-1", text: "Duplicate source slot.", startedAt: 2 },
  ];
  const before = structuredClone(sources);
  const input = { sources, effectiveRecords, sessionId: "session-1", runtimeEpoch: 1 };
  const result = projectEffectiveSourceTurnGroup(input);
  assert.equal(selections, 1);
  assert.deepEqual(result.sources.map(({ turnId, startedAt }) => ({ turnId, startedAt })), sources.map(({ turnId, startedAt }) => ({ turnId, startedAt })));
  assert.deepEqual(result.replacedTurnIds, ["turn-1", "turn-1"]);
  assert.deepEqual(result.correctionIds, ["correction-1"]);
  assert.deepEqual(sources, before);
  for (const [index, source] of sources.entries()) {
    assert.equal(result.sources[index].text, projectEffectiveTextForSourceTurn({ ...input, ...source }).text);
  }
});

test("C1/C4 batch latest revision wins before correction filtering and respects session/epoch", () => {
  const corrected = correct(unit("Design a ride-sharing system."));
  const old = modelRecord(corrected);
  const cancelled = { ...old, logicalQuestionRevision: old.logicalQuestionRevision + 1, correctionIds: [], text: "Design a ride-sharing system." };
  const foreign = { ...old, logicalQuestionRevision: 99, sessionId: "foreign", text: "Forbidden session." };
  const differentEpoch = { ...old, logicalQuestionRevision: 100, runtimeEpoch: 2, text: "Forbidden epoch." };
  const input = { sources: [{ turnId: "turn-1", text: "Design a ride-sharing system." }], effectiveRecords: [old, cancelled, foreign, differentEpoch], sessionId: "session-1", runtimeEpoch: 1 };
  const result = projectEffectiveSourceTurnGroup(input);
  assert.equal(result.replaced, false);
  assert.deepEqual(result.sources, input.sources);
  assert.deepEqual(result.correctionIds, []);
  const inFlight = { ...unit(input.sources[0].text), revision: old.logicalQuestionRevision };
  assert.equal(projectEffectiveSourceTurnGroup({ ...input, effectiveRecords: [old], logicalQuestionUnit: inFlight }).replaced, false);
});

test("C2 batch partial sources never substitute an entire multi-turn record", () => {
  const record = modelRecord(correct(unit("The ride-sharing corpus is private.")));
  record.sourceTurnIds.push("turn-2");
  record.text += " Secret information from another source.";
  const sources = [{ turnId: "turn-2", text: "Only this selected text." }];
  const input = { sources, effectiveRecords: [record], sessionId: "session-1", runtimeEpoch: 1 };
  assert.deepEqual(projectEffectiveSourceTurnGroup(input).sources, sources);
  record.effectiveSourceTexts!.push({ turnId: "turn-2", text: "Effective selected text." });
  record.effectiveSourceTexts!.push({ turnId: "turn-2", text: "Later duplicate must not win." });
  const result = projectEffectiveSourceTurnGroup(input);
  assert.equal(result.sources[0].text, "Effective selected text.");
  assert.doesNotMatch(result.sources[0].text, /Secret|private|duplicate/);
  assert.deepEqual(projectEffectiveSourceTurnGroup({ ...input, sources: [] }).sources, []);
});

test("C1 batch overlapping streams preserve ownership tie-breaks and metadata ordering", () => {
  const base = modelRecord(correct(unit("The ride-sharing corpus changes daily.")));
  const owner = { ...base, logicalQuestionUnitId: "logical-question-z", correctionIds: ["correction-z"], effectiveSourceTexts: [{ turnId: "turn-1", text: "Winning effective source." }] };
  const sources = [{ turnId: "turn-1", text: "The ride-sharing corpus changes daily." }];
  const input = { sources, effectiveRecords: [owner, base], sessionId: "session-1", runtimeEpoch: 1 };
  const result = projectEffectiveSourceTurnGroup(input);
  const single = projectEffectiveTextForSourceTurn({ ...input, ...sources[0] });
  assert.equal(result.sources[0].text, "Winning effective source.");
  assert.equal(result.sources[0].text, single.text);
  assert.deepEqual(result.logicalQuestionUnitIds, [owner.logicalQuestionUnitId]);
  assert.deepEqual(result.logicalQuestionRevisions, [owner.logicalQuestionRevision]);
  assert.deepEqual(result.correctionIds, owner.correctionIds);
});

test("C5 synchronous supplied current-LQU projection is reused without reading its raw sources again", () => {
  const corrected = correct(unit("The ride-sharing corpus changes daily."));
  const logicalQuestionProjection = projectEffectiveLogicalQuestionSources(corrected);
  const guarded = { ...corrected };
  Object.defineProperty(guarded, "sources", { get() { throw new Error("current LQU was projected twice"); } });
  const result = projectEffectiveSourceTurnGroup({
    sources: corrected.sources,
    logicalQuestionUnit: guarded,
    logicalQuestionProjection,
    sessionId: corrected.sessionId,
    runtimeEpoch: corrected.runtimeEpoch,
  });
  assert.match(result.sources[0].text, /RAG/);
  assert.deepEqual(result.correctionIds, logicalQuestionProjection.correctionIds);
});

function correct(logicalQuestionUnit: LogicalQuestionUnit) {
  const correction: SpeechCorrection = {
    id: "correction-1",
    input: "RAG not ride-sharing",
    term: "RAG",
    from: "ride-sharing",
    to: "RAG",
    createdAt: 2,
    appliedCount: 0,
  };
  return applyActiveQuestionTermCorrection({
    correction,
    logicalQuestionUnit,
    correctionTraceId: "trace-correction",
    manualCorrectionRevision: 1,
    now: 4,
  }).logicalQuestionUnit;
}

function unit(text: string): LogicalQuestionUnit {
  return makeUnit({ text });
}

function makeUnit(input: {
  id?: string;
  turnId?: string;
  text: string;
  startedAt?: number;
}): LogicalQuestionUnit {
  const turnId = input.turnId ?? "turn-1";
  const startedAt = input.startedAt ?? 1;
  return {
    id: input.id ?? "logical-question-1",
    revision: 1,
    sessionId: "session-1",
    runtimeEpoch: 1,
    currentTurnId: turnId,
    sourceTurnIds: [turnId],
    sources: [
      {
        turnId,
        text: input.text,
        startedAt,
        endedAt: startedAt + 1,
      },
    ],
    normalizedText: input.text,
    startedAt,
    updatedAt: startedAt + 1,
    compositionReasons: ["independent-current-turn"],
    boundaryReason: "independent-current-turn",
    truncated: false,
  };
}

function modelRecord(
  logicalQuestionUnit: LogicalQuestionUnit
): EffectiveLogicalQuestionModelRecord {
  const projection = projectEffectiveLogicalQuestionSources(
    logicalQuestionUnit
  );
  return {
    sessionId: logicalQuestionUnit.sessionId,
    runtimeEpoch: logicalQuestionUnit.runtimeEpoch,
    logicalQuestionUnitId: logicalQuestionUnit.id,
    logicalQuestionRevision: logicalQuestionUnit.revision,
    sourceTurnIds: [...logicalQuestionUnit.sourceTurnIds],
    text: projection.effectiveText,
    correctionIds: [...projection.correctionIds],
    effectiveSourceTexts: projection.effectiveSourceTexts,
    updatedAt: logicalQuestionUnit.updatedAt,
    settledAt: logicalQuestionUnit.updatedAt,
  };
}

function turn(
  id: string,
  speaker: "me" | "them",
  text: string,
  at: number
): TranscriptTurn {
  return {
    id,
    speaker,
    text,
    startedAt: at,
    endedAt: at + 1,
    isFinal: true,
    source: speaker === "me" ? "microphone" : "system-audio",
  };
}
