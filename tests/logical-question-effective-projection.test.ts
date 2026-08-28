import assert from "node:assert/strict";
import test from "node:test";
import { applyActiveQuestionTermCorrection } from "../src/lib/meeting/active-question-term-correction.js";
import {
  projectAdvisorTranscriptForLogicalQuestion,
  projectEffectiveLogicalQuestionSources,
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
  assert.match(response.sourceSpans[0]?.text ?? "", /RAG/);
  assert.doesNotMatch(response.sourceSpans[0]?.text ?? "", /ride-sharing/i);
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
  return {
    id: "logical-question-1",
    revision: 1,
    sessionId: "session-1",
    runtimeEpoch: 1,
    currentTurnId: "turn-1",
    sourceTurnIds: ["turn-1"],
    sources: [{ turnId: "turn-1", text, startedAt: 1, endedAt: 2 }],
    normalizedText: text,
    startedAt: 1,
    updatedAt: 2,
    compositionReasons: ["independent-current-turn"],
    boundaryReason: "independent-current-turn",
    truncated: false,
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
