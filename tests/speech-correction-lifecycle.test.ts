import assert from "node:assert/strict";
import test from "node:test";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import {
  buildSpeechBiasContext,
  normalizeTranscriptWithSpeechBias,
} from "../src/lib/meeting/speech-bias.js";
import type { SpeechCorrection } from "../src/lib/meeting/types.js";

test("manual rules carry correction identity and stop after deactivation", () => {
  const context = new MeetingContextManager().getState();
  const correction = makeCorrection();
  const activeBias = buildSpeechBiasContext(context, [correction]);
  const activeResult = normalizeTranscriptWithSpeechBias(
    "Please explain rec.",
    activeBias
  );

  assert.equal(activeResult.text, "Please explain RAG.");
  assert.deepEqual(
    activeResult.appliedRules.map((rule) => rule.correctionId),
    [correction.id]
  );

  const inactiveBias = buildSpeechBiasContext(context, [
    { ...correction, deactivatedAt: 2_000 },
  ]);
  const inactiveResult = normalizeTranscriptWithSpeechBias(
    "Please explain rec.",
    inactiveBias
  );
  assert.equal(inactiveResult.text, "Please explain rec.");
  assert.equal(inactiveBias.correctionRules.length, 0);
  assert.equal(
    inactiveBias.terms.some((term) => term.source === "correction"),
    false
  );
});

test("a new active correction can reuse a pair previously deactivated", () => {
  const context = new MeetingContextManager().getState();
  const oldCorrection = { ...makeCorrection(), deactivatedAt: 2_000 };
  const newCorrection = { ...makeCorrection(), id: "correction-2" };
  const bias = buildSpeechBiasContext(context, [oldCorrection, newCorrection]);

  assert.deepEqual(
    bias.correctionRules
      .map((rule) => rule.correctionId)
      .filter((correctionId): correctionId is string => Boolean(correctionId)),
    ["correction-2"]
  );
});

function makeCorrection(): SpeechCorrection {
  return {
    id: "correction-1",
    input: "RAG not rec",
    term: "RAG",
    from: "rec",
    to: "RAG",
    createdAt: 1_000,
    appliedCount: 0,
  };
}
