import assert from "node:assert/strict";
import test from "node:test";
import {
  applyActiveQuestionTermCorrection,
  authorizeActiveQuestionTermCorrection,
  hasAppliedTermCorrection,
  reverseActiveQuestionTermCorrection,
} from "../src/lib/meeting/active-question-term-correction.js";
import {
  getLogicalQuestionAnswerFocusText,
  getLogicalQuestionSemanticEvidenceText,
  type LogicalQuestionUnit,
} from "../src/lib/meeting/logical-question-unit.js";
import { projectPrimaryAsk } from "../src/lib/meeting/primary-ask-projection.js";
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

test("recomputes both question projections when the corrected term is in setup", () => {
  const text =
    "Now add an H and SW retrieval index and explain which components need to change.";
  const primaryAskProjection = projectPrimaryAsk({
    turnId: "turn_1",
    text,
  });
  const unit: LogicalQuestionUnit = {
    ...makeLogicalQuestion(
      primaryAskProjection.normalizedPrimaryAsk ?? text
    ),
    sources: [
      {
        turnId: "turn_1",
        text,
        startedAt: 1_000,
        endedAt: 1_500,
      },
    ],
    primaryAskProjection,
  };
  const result = applyActiveQuestionTermCorrection({
    correction: {
      ...makeCorrection("HNSW"),
      from: "H and SW",
      to: "HNSW",
    },
    logicalQuestionUnit: unit,
    correctionTraceId: "trace_correction",
    manualCorrectionRevision: 4,
  });

  assert.match(
    getLogicalQuestionSemanticEvidenceText(
      result.logicalQuestionUnit
    ),
    /\bHNSW\b/
  );
  assert.doesNotMatch(
    getLogicalQuestionSemanticEvidenceText(
      result.logicalQuestionUnit
    ).split("\n")[0] ?? "",
    /H and SW/i
  );
  assert.match(
    getLogicalQuestionAnswerFocusText(
      result.logicalQuestionUnit
    ),
    /intended term is "HNSW"/
  );
  assert.equal(result.transaction.replacedText, "H and SW");
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

test("reverses only a correction owned by the current LQU", () => {
  const correction: SpeechCorrection = {
    ...makeCorrection("RAG not rec"),
    term: "RAG",
    from: "rec",
    to: "RAG",
  };
  const applied = applyActiveQuestionTermCorrection({
    correction,
    logicalQuestionUnit: makeLogicalQuestion(
      "Explain rec and where its data is stored."
    ),
    correctionTraceId: "trace_correction",
    manualCorrectionRevision: 3,
  }).logicalQuestionUnit;

  const reversed = reverseActiveQuestionTermCorrection({
    correction,
    logicalQuestionUnit: applied,
    corrections: [correction],
    now: 3_000,
  });

  assert.equal(reversed.reversed, true);
  if (!reversed.reversed) return;
  assert.equal(reversed.previousRevision, 3);
  assert.equal(reversed.nextRevision, 4);
  assert.match(reversed.logicalQuestionUnit.normalizedText, /Explain rec/);
  assert.doesNotMatch(reversed.logicalQuestionUnit.normalizedText, /RAG/);
  assert.equal(reversed.logicalQuestionUnit.termCorrectionOverlays, undefined);
  assert.match(
    reversed.logicalQuestionUnit.compositionReasons.join(" "),
    /manual-term-correction-reversal/
  );
});

test("does not reverse a literal target term without correction provenance", () => {
  const correction: SpeechCorrection = {
    ...makeCorrection("RAG not rec"),
    term: "RAG",
    from: "rec",
    to: "RAG",
  };
  const result = reverseActiveQuestionTermCorrection({
    correction,
    logicalQuestionUnit: makeLogicalQuestion(
      "Explain RAG and where its data is stored."
    ),
    corrections: [correction],
  });

  assert.deepEqual(result, {
    reversed: false,
    reason: "correction-not-applied-to-current-lqu",
  });
});

test("reconstructs a source-level speech replacement from pre-normalization text", () => {
  const correction: SpeechCorrection = {
    ...makeCorrection("RAG not rec"),
    term: "RAG",
    from: "rec",
    to: "RAG",
  };
  const logicalQuestionUnit: LogicalQuestionUnit = {
    ...makeLogicalQuestion("Explain RAG."),
    sources: [
      {
        turnId: "turn_1",
        text: "Explain RAG.",
        preNormalizationText: "Explain rec.",
        appliedSpeechCorrectionIds: [correction.id],
        startedAt: 1_000,
        endedAt: 1_500,
      },
    ],
  };

  const reversed = reverseActiveQuestionTermCorrection({
    correction,
    logicalQuestionUnit,
    corrections: [correction],
  });

  assert.equal(reversed.reversed, true);
  if (!reversed.reversed) return;
  assert.equal(reversed.logicalQuestionUnit.sources[0]?.text, "Explain rec.");
  assert.equal(
    reversed.logicalQuestionUnit.sources[0]?.appliedSpeechCorrectionIds,
    undefined
  );
  assert.match(reversed.logicalQuestionUnit.normalizedText, /Explain rec/);
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
