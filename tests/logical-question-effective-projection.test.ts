import assert from "node:assert/strict";
import test from "node:test";
import { applyActiveQuestionTermCorrection } from "../src/lib/meeting/active-question-term-correction.js";
import {
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
      assert.match(single.text, /RAG/);
      assert.equal(single.logicalQuestionRevision, corrected.revision);
      assert.equal(batch.sources[0].text, single.text);
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
