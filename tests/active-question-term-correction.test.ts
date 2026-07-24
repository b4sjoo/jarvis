import assert from "node:assert/strict";
import test from "node:test";
import {
  applyActiveQuestionTermCorrection,
  authorizeActiveQuestionTermCorrection,
  hasAppliedTermCorrection,
} from "../src/lib/meeting/active-question-term-correction.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import type { SpeechCorrection } from "../src/lib/meeting/types.js";

test("binds a bare HNSW correction to the current logical question", () => {
  const unit = makeLogicalQuestion(
    "How would you build an H and SW index for vector search?"
  );
  const correction = makeCorrection("HNSW");
  const result = applyActiveQuestionTermCorrection({
    correction,
    logicalQuestionUnit: unit,
    correctionTraceId: "trace_correction",
    manualCorrectionRevision: 4,
    now: 2_000,
  });

  assert.equal(result.logicalQuestionUnit.id, unit.id);
  assert.equal(result.logicalQuestionUnit.revision, 3);
  const correctedQuestion =
    result.logicalQuestionUnit.normalizedText.split("\n")[0];
  assert.match(correctedQuestion, /\bHNSW\b/);
  assert.doesNotMatch(correctedQuestion, /H and SW/i);
  assert.equal(result.logicalQuestionUnit.sources[0].text, unit.sources[0].text);
  assert.equal(result.transaction.replacedText, "H and SW");
  assert.equal(result.transaction.disposition, "current-question-overlay");
  assert.equal(result.transaction.logicalQuestionUnitRevision, 2);
  assert.equal(result.transaction.correctedLogicalQuestionUnitRevision, 3);
  assert.equal(
    hasAppliedTermCorrection(result.logicalQuestionUnit, correction),
    true
  );
});

test("adds a bounded overlay instead of guessing when no source phrase matches", () => {
  const unit = makeLogicalQuestion(
    "How would you choose the retrieval index for this system?"
  );
  const result = applyActiveQuestionTermCorrection({
    correction: makeCorrection("HNSW"),
    logicalQuestionUnit: unit,
    correctionTraceId: "trace_correction",
    manualCorrectionRevision: 2,
  });

  assert.equal(result.transaction.replacedText, undefined);
  assert.match(
    result.logicalQuestionUnit.normalizedText,
    /intended term is "HNSW"/
  );
  assert.equal(
    result.logicalQuestionUnit.normalizedText.length <= 1_200,
    true
  );
});

test("uses an explicit replacement without mutating raw logical-question sources", () => {
  const unit = makeLogicalQuestion("Explain rec and where its data is stored.");
  const correction: SpeechCorrection = {
    ...makeCorrection("RAG not rec"),
    term: "RAG",
    from: "rec",
    to: "RAG",
  };
  const result = applyActiveQuestionTermCorrection({
    correction,
    logicalQuestionUnit: unit,
    correctionTraceId: "trace_correction",
    manualCorrectionRevision: 3,
  });

  assert.match(result.logicalQuestionUnit.normalizedText, /Explain RAG/);
  assert.equal(result.logicalQuestionUnit.sources[0].text, unit.sources[0].text);
  assert.equal(result.transaction.replacedText, "rec");
});

test("rejects a term-correction lease after a newer question revision", () => {
  const result = applyActiveQuestionTermCorrection({
    correction: makeCorrection("HNSW"),
    logicalQuestionUnit: makeLogicalQuestion("Explain H and SW."),
    correctionTraceId: "trace_correction",
    manualCorrectionRevision: 5,
  });
  const current = {
    ...result.logicalQuestionUnit,
    revision: result.logicalQuestionUnit.revision + 1,
  };

  assert.deepEqual(
    authorizeActiveQuestionTermCorrection({
      transaction: result.transaction,
      currentLogicalQuestionUnit: current,
      currentSessionId: current.sessionId,
      currentRuntimeEpoch: current.runtimeEpoch,
      currentManualCorrectionRevision: 5,
    }),
    {
      authorized: false,
      reason: "logical-question-revision-mismatch",
    }
  );
});

test("authorizes only the current manual correction revision", () => {
  const result = applyActiveQuestionTermCorrection({
    correction: makeCorrection("HNSW"),
    logicalQuestionUnit: makeLogicalQuestion("Explain H and SW."),
    correctionTraceId: "trace_correction",
    manualCorrectionRevision: 5,
  });

  assert.equal(
    authorizeActiveQuestionTermCorrection({
      transaction: result.transaction,
      currentLogicalQuestionUnit: result.logicalQuestionUnit,
      currentSessionId: result.logicalQuestionUnit.sessionId,
      currentRuntimeEpoch: result.logicalQuestionUnit.runtimeEpoch,
      currentManualCorrectionRevision: 5,
    }).authorized,
    true
  );
  assert.equal(
    authorizeActiveQuestionTermCorrection({
      transaction: result.transaction,
      currentLogicalQuestionUnit: result.logicalQuestionUnit,
      currentSessionId: result.logicalQuestionUnit.sessionId,
      currentRuntimeEpoch: result.logicalQuestionUnit.runtimeEpoch,
      currentManualCorrectionRevision: 6,
    }).reason,
    "manual-correction-revision-mismatch"
  );
});

function makeLogicalQuestion(text: string): LogicalQuestionUnit {
  return {
    id: "logical_question_1",
    revision: 2,
    sessionId: "session_1",
    runtimeEpoch: 7,
    currentTurnId: "turn_1",
    sourceTurnIds: ["turn_1"],
    sources: [
      {
        turnId: "turn_1",
        text,
        startedAt: 1_000,
        endedAt: 1_500,
      },
    ],
    normalizedText: text,
    startedAt: 1_000,
    updatedAt: 1_500,
    compositionReasons: ["independent-current-turn"],
    boundaryReason: "independent-current-turn",
    truncated: false,
  };
}

function makeCorrection(input: string): SpeechCorrection {
  return {
    id: "speech_correction_1",
    input,
    term: input,
    to: input,
    createdAt: 1_900,
    appliedCount: 0,
  };
}
