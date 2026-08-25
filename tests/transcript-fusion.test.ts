import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  decideExpiredConfirmationRecovery,
  findDuplicateSystemAudioTurnForMeTurn,
  shouldSuppressDuplicateSystemAudioTurn,
} from "../src/lib/meeting/transcript-fusion.js";
import type { TranscriptTurn } from "../src/lib/meeting/types.js";

const duplicateText =
  "Could you explain how the distributed cache handles concurrent writes";

test("keeps medium-confidence microphone evidence when suppression is false", () => {
  const systemTurn = makeTurn({
    id: "system",
    speaker: "them",
    source: "system-audio",
    startedAt: 0,
    endedAt: 4_000,
  });
  const microphoneTurn = makeTurn({
    id: "microphone",
    speaker: "me",
    source: "microphone",
    startedAt: 6_000,
    endedAt: 8_000,
  });

  const decision = findDuplicateSystemAudioTurnForMeTurn(microphoneTurn, [
    systemTurn,
  ]);
  assert.equal(decision.confidence, "medium");
  assert.equal(decision.suppress, false);
});

test("suppresses only a high-confidence overlapping echo in either direction", () => {
  const systemTurn = makeTurn({
    id: "system",
    speaker: "them",
    source: "system-audio",
    startedAt: 1_000,
    endedAt: 5_000,
  });
  const microphoneTurn = makeTurn({
    id: "microphone",
    speaker: "me",
    source: "microphone",
    startedAt: 1_200,
    endedAt: 4_800,
  });

  assert.equal(
    findDuplicateSystemAudioTurnForMeTurn(microphoneTurn, [systemTurn])
      .suppress,
    true
  );
  assert.equal(
    shouldSuppressDuplicateSystemAudioTurn(systemTurn, [microphoneTurn])
      .suppress,
    true
  );
});

test("uses the producer suppression disposition in both hook consumers", () => {
  const hookSource = readFileSync(
    `${process.cwd()}/src/hooks/useMeetingAssistant.ts`,
    "utf8"
  );
  const microphoneConsumer = hookSource.slice(
    hookSource.indexOf("findDuplicateSystemAudioTurnForMeTurn"),
    hookSource.indexOf("if (classification.promptEligible)")
  );

  assert.equal(
    microphoneConsumer.includes("if (duplicateDecision.suppress)"),
    true
  );
  assert.equal(
    microphoneConsumer.includes('duplicateDecision.confidence !== "low"'),
    false
  );
});

test("preserves expired confirmation content without turning exact filler into an ask", () => {
  assert.deepEqual(
    decideExpiredConfirmationRecovery({
      wordEquivalent: 1,
      exactHighFiller: false,
    }),
    {
      appendTranscript: true,
      publishRecoveryTarget: true,
      reason: "contentful-confirmation-expired",
    }
  );
  assert.deepEqual(
    decideExpiredConfirmationRecovery({
      wordEquivalent: 1,
      exactHighFiller: true,
    }),
    {
      appendTranscript: true,
      publishRecoveryTarget: false,
      reason: "exact-filler-confirmation-expired",
    }
  );
});

function makeTurn(input: {
  id: string;
  speaker: TranscriptTurn["speaker"];
  source: TranscriptTurn["source"];
  startedAt: number;
  endedAt: number;
}): TranscriptTurn {
  return {
    ...input,
    text: duplicateText,
    isFinal: true,
  };
}
