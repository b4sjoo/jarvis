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
    "  const processPostBufferThemTurn = useCallback(",
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
  assert.match(ingress, /scheduleQuestionRuntime/);
  assert.match(ingress, /scheduleAdvisorAfterQuestionTypeWindow/);
});

test("keeps STT transport concerns outside canonical ingress", () => {
  const ingress = sourceSlice(
    "  const processPostBufferThemTurn = useCallback(",
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
    "  const processPostBufferThemTurn = useCallback(",
    "  const processQueuedSpeechSegment = useCallback"
  );
  const residualBranch = ingress.slice(
    ingress.indexOf("      let runtimeAdjudication:")
  );
  const semanticScheduleAt = residualBranch.indexOf(
    "runtimeAdjudication = scheduleQuestionRuntime"
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
    ingress,
    /responseOpportunityLocalDecision\.disposition ===\s*"deterministic-no-output"/
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

test("passes the active branch type as a bounded Question Type prior", () => {
  assert.match(
    source,
    /const currentBranchType = normalizeCanonicalQuestionType\([\s\S]{0,180}activeMeetingTask\?\.child\?\.questionType[\s\S]{0,120}activeParent\?\.questionType/
  );
  assert.match(
    source,
    /buildVoiceQuestionTypeStructuredHints\(\{[\s\S]{0,180}currentBranchType/
  );
});

test("builds Advisor plans from explicit pre and post mutation task snapshots", () => {
  assert.match(source, /mapSourceOwnedExecutionPlanCommand/);
  assert.match(
    source,
    /candidate\.kind === "phase-progress"[\s\S]{0,220}result\.phaseBefore !== result\.phaseAfter[\s\S]{0,220}update-parent-context/
  );
  assert.match(
    source,
    /expectedActiveMeetingTask:[\s\S]{0,160}originalPromptContext\.activeMeetingTask/
  );
  assert.match(
    source,
    /activeMeetingTask:[\s\S]{0,180}operationCommittedTaskMutationBeforePlan[\s\S]{0,120}postMutationActiveMeetingTask/
  );
});

test("maps progress-only Source transitions to parent context updates", () => {
  const commitStart = source.indexOf(
    "function commitSourceOwnedTransitionWithManager"
  );
  const commitEnd = source.indexOf(
    "function prepareGenerationDerivedTaskRuntimeCommit",
    commitStart
  );
  assert.ok(commitStart >= 0);
  assert.ok(commitEnd > commitStart);
  const commit = source.slice(commitStart, commitEnd);

  assert.match(commit, /resolveSourceOwnedRuntimeTransition\(\{/);
});

test("treats phase-requested Code as explicit Code intent", () => {
  assert.match(
    source,
    /const codeMutationWithoutCodeIntent =[\s\S]{0,260}generationArtifactIntent !== "revise-code"[\s\S]{0,160}requestedArtifacts\.includes\("code"\)/
  );
});

test("surfaces rejected Screen transitions without starting a provider", () => {
  const rejectionStart = source.indexOf(
    "if (!screenTransitionCommitted)"
  );
  const rejectionEnd = source.indexOf(
    "if (\n            sourceOwnedTransitionDurableMutationApplied(",
    rejectionStart
  );
  assert.ok(rejectionStart >= 0);
  assert.ok(rejectionEnd > rejectionStart);
  const rejection = source.slice(rejectionStart, rejectionEnd);

  assert.match(rejection, /Screen task transition failed:/);
  assert.match(rejection, /Try again\./);
  assert.doesNotMatch(rejection, /modelStepId/);
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
    /convergedSettlement\s*\? "input-evidence"\s*:\s*releaseAuthorized\s*\? "runtime-type-adjudication-output-only"/
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
