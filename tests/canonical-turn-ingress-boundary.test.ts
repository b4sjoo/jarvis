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
  assert.match(ingress, /Canonical turn ingress admitted/);
  assert.match(ingress, /canonical-turn-ingress-admitted/);
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

test("joins every reviewed response opportunity before canonical publication and advisor dispatch", () => {
  const ingress = sourceSlice(
    "  const processCanonicalTurnIngress = useCallback(",
    "  const processQueuedSpeechSegment = useCallback"
  );
  const residualBranch = ingress.slice(
    ingress.indexOf("      let runtimeAdjudication:")
  );
  const semanticScheduleAt = residualBranch.indexOf(
    "runtimeAdjudication = scheduleSemanticTaxonomyShadow"
  );
  const responseScheduleAt = residualBranch.indexOf(
    "scheduleResponseOpportunityInference({"
  );
  const responseBranch = residualBranch.slice(responseScheduleAt);
  const reviewedTurnReturnAt = responseBranch.indexOf(
    "          return;\n        }"
  );

  assert.ok(semanticScheduleAt >= 0);
  assert.ok(responseScheduleAt > semanticScheduleAt);
  assert.ok(reviewedTurnReturnAt >= 0);
  assert.match(
    ingress,
    /runtimeIntentSettlementPending:\s*responseOpportunityLocalDecision\.runtimeReviewRequired/
  );
  assert.match(
    residualBranch,
    /runtime-required"\s*\? "answer-refresh"\s*: taxonomyTurnGateAction/
  );
  assert.match(
    source,
    /authorizationLogicalQuestionUnit:\s*logicalQuestionUnit/
  );
  assert.match(
    residualBranch,
    /onOutputAuthorized:[\s\S]*scheduleAdvisorAfterQuestionTypeWindow/
  );
  assert.match(
    residualBranch,
    /releasedLogicalQuestionUnit,\s*"input-evidence"/
  );
  assert.doesNotMatch(
    residualBranch,
    /releasedLogicalQuestionUnit,\s*"runtime-intent-answer"/
  );

  const responseOpportunity = sourceSlice(
    "  const scheduleResponseOpportunityInference = useCallback(",
    "  const scheduleMeetingMetadataInference = useCallback"
  );
  assert.match(
    responseOpportunity,
    /publishCanonicalLogicalQuestionTarget\(\{[\s\S]*logicalQuestionPublicationStage: "canonical-published"/
  );
  assert.match(
    responseOpportunity,
    /logicalQuestionPublicationStage: "response-suppressed"/
  );
  assert.match(responseOpportunity, /onOutputAuthorized\(\{/);
  assert.doesNotMatch(responseOpportunity, /\bscheduleAdvisor\(/);
});

test("settles Voice question type before Relation and passes one tuple to Advisor", () => {
  const consumer = sourceSlice(
    "  const scheduleAdvisorAfterQuestionTypeWindow = useCallback(",
    "  const buildLogicalQuestionForTurn = useCallback("
  );

  assert.match(consumer, /decideOrderedVoiceQuestionTypeResolution/);
  assert.match(
    consumer,
    /const effectiveType = resolveOrderedQuestionType\(\s*settledTypeOutcome\s*\)\.questionType/
  );
  assert.match(
    consumer,
    /settlementReleased \? settlement : undefined/
  );
  assert.doesNotMatch(
    consumer,
    /const fallbackType =[\s\S]{0,240}localQuestionType/
  );
});

test("settles first-parent admission in the shared coordinator", () => {
  const consumer = sourceSlice(
    "  const scheduleAdvisorAfterQuestionTypeWindow = useCallback(",
    "  const buildLogicalQuestionForTurn = useCallback("
  );

  assert.match(
    consumer,
    /coordinateOrderedSettlement\(\{/
  );
  assert.match(
    consumer,
    /const deterministicOrderedRelationProposal =[\s\S]*!relationCandidate[\s\S]*resolvedOrderedRelation/
  );
  assert.match(
    consumer,
    /convergedSettlement\s*\? "input-evidence"\s*:\s*releaseAuthorized\s*\? "runtime-type-repair"/
  );
  assert.doesNotMatch(
    source,
    /implicitResponseOnlyScopeAllowed/
  );
  assert.doesNotMatch(
    source,
    /finalizeCurrentQuestionFirstParentSettlement/
  );
});

function sourceSlice(startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  assert.ok(end > start, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}
