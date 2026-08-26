import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  `${process.cwd()}/src/hooks/useMeetingAssistant.ts`,
  "utf8"
);

test("routes accepted production STT turns through one canonical ingress", () => {
  const transport = sourceSlice(
    "  const processQueuedSpeechSegment = useCallback(",
    "  const enqueueSpeechDetected = useCallback"
  );
  const ingress = sourceSlice(
    "  const processCanonicalTurnIngress = useCallback(",
    "  const processQueuedSpeechSegment = useCallback"
  );

  assert.match(
    transport,
    /turn\.audioSessionId = segment\.sessionId;\s+await processCanonicalTurnIngress\(\{ turn, segment \}\);/
  );
  assert.match(transport, /transcribeMeetingAudio/);
  assert.match(ingress, /projectPrimaryAsk/);
  assert.match(ingress, /decideResponseOpportunityLocalRoute/);
  assert.match(ingress, /buildLogicalQuestionForTurn/);
  assert.match(ingress, /scheduleSemanticTaxonomyShadow/);
  assert.match(ingress, /scheduleAdvisorAfterQuestionTypeWindow/);
});

test("keeps STT transport concerns outside canonical ingress", () => {
  const ingress = sourceSlice(
    "  const processCanonicalTurnIngress = useCallback(",
    "  const processQueuedSpeechSegment = useCallback"
  );

  assert.doesNotMatch(ingress, /transcribeMeetingAudio/);
  assert.doesNotMatch(ingress, /buildSpeechBiasContext/);
  assert.doesNotMatch(ingress, /normalizeTranscriptWithSpeechBias/);
  assert.doesNotMatch(ingress, /displayTranscriptAssemblerRef/);
  assert.doesNotMatch(ingress, /base64WavToBlob/);
});

function sourceSlice(startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  assert.ok(end > start, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}
