import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSourceLinkageAdjudicationPrompts,
  buildSourceLinkageAdjudicationRequest,
  authorizeSourceLinkageAdjudicationLease,
  createSourceLinkageAdjudicationLease,
  parseSourceLinkageAdjudicationOutput,
} from "../src/lib/meeting/source-linkage-adjudication.js";

test("binds a screen only with bilateral grounded evidence", () => {
  const request = buildSourceLinkageAdjudicationRequest({
    logicalQuestionUnitId: "lqu-lines",
    logicalQuestionUnitRevision: 2,
    screenObservationId: "screen-1",
    voiceSourceHash: "voice-source-1",
    sourceSettlementId: "voice-settlement-1",
    voiceQuestion: "Could you explain lines 46 through 49?",
    screenQuestion: "Implement LRU cache",
    screenEvidenceSummary: "Lines 46 through 49 show the eviction loop.",
    activeParentObjective: "Implement LRU cache",
  });
  assert.ok(request);
  const prompts = buildSourceLinkageAdjudicationPrompts(request);
  assert.match(prompts.systemPrompt, /supplies evidence requested/);
  assert.match(prompts.systemPrompt, /Time proximity, topic overlap/);
  const modelInput = JSON.parse(prompts.userMessage) as Record<string, unknown>;
  assert.deepEqual(modelInput, {
    screenEvidenceSummary: "Lines 46 through 49 show the eviction loop.",
    screenQuestion: "Implement LRU cache",
    voiceQuestion: "Could you explain lines 46 through 49?",
  });
  assert.equal("logicalQuestionUnitId" in modelInput, false);
  assert.equal("screenObservationId" in modelInput, false);
  assert.equal("sourceHash" in modelInput, false);
  assert.equal("activeParentObjective" in modelInput, false);
  const parsed = parseSourceLinkageAdjudicationOutput(
    JSON.stringify({
      schemaVersion: 1,
      decision: "bind-voice",
      voiceEvidenceSpans: ["lines 46 through 49"],
      screenEvidenceSpans: ["Lines 46 through 49"],
    }),
    request
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok ? parsed.value.decision : undefined, "bind-voice");
});

test("uses an independent screen question without voice evidence", () => {
  const request = buildSourceLinkageAdjudicationRequest({
    logicalQuestionUnitId: "lqu-old",
    logicalQuestionUnitRevision: 1,
    screenObservationId: "screen-2",
    voiceSourceHash: "voice-source-2",
    voiceQuestion: "Could you explain the current code?",
    screenQuestion: "Tell me about a time you disagreed with a teammate.",
  });
  assert.ok(request);
  const parsed = parseSourceLinkageAdjudicationOutput(
    JSON.stringify({
      schemaVersion: 1,
      decision: "use-screen",
      voiceEvidenceSpans: [],
      screenEvidenceSpans: [
        "Tell me about a time you disagreed with a teammate.",
      ],
    }),
    request
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok ? parsed.value.decision : undefined, "use-screen");
});

test("rejects linkage without the required source evidence", () => {
  const request = buildSourceLinkageAdjudicationRequest({
    logicalQuestionUnitId: "lqu-lines",
    logicalQuestionUnitRevision: 1,
    screenObservationId: "screen-3",
    voiceSourceHash: "voice-source-3",
    voiceQuestion: "Could you explain lines 46 through 49?",
    screenQuestion: "Implement LRU cache",
  });
  assert.ok(request);
  const missingBilateral = parseSourceLinkageAdjudicationOutput(
    JSON.stringify({
      schemaVersion: 1,
      decision: "bind-voice",
      voiceEvidenceSpans: ["lines 46 through 49"],
      screenEvidenceSpans: [],
    }),
    request
  );
  const ungrounded = parseSourceLinkageAdjudicationOutput(
    JSON.stringify({
      schemaVersion: 1,
      decision: "use-screen",
      voiceEvidenceSpans: [],
      screenEvidenceSpans: ["Merge intervals"],
    }),
    request
  );

  assert.equal(missingBilateral.ok, false);
  assert.equal(ungrounded.ok, false);
});

test("validates Voice and Screen as a cross-source transition", () => {
  const request = buildSourceLinkageAdjudicationRequest({
    logicalQuestionUnitId: "lqu-lines",
    logicalQuestionUnitRevision: 2,
    screenObservationId: "screen-1",
    voiceSourceHash: "voice-source-1",
    sourceSettlementId: "voice-settlement-1",
    voiceQuestion: "Could you explain lines 46 through 49?",
    screenQuestion: "Implement LRU cache",
    screenEvidenceSummary: "Lines 46 through 49 show the eviction loop.",
  });
  assert.ok(request);
  const lease = createSourceLinkageAdjudicationLease({
    sessionId: "session-1",
    runtimeEpoch: 3,
    request,
    manualCorrectionRevision: 1,
  });
  const transition = {
    operationKind: "source-linkage-adjudication" as const,
    sessionId: "session-1",
    runtimeEpoch: 3,
    operationRevision: 2,
    from: {
      logicalQuestionUnitId: "lqu-lines",
      logicalQuestionRevision: 2,
      sourceHash: "voice-source-1",
      correctionRevision: 1,
    },
    to: {
      evidenceId: "screen-1",
      evidenceHash: request.screenEvidenceHash,
      correctionRevision: 1,
    },
    sourceSettlementId: "voice-settlement-1",
  };

  assert.equal(
    authorizeSourceLinkageAdjudicationLease(lease, {
      currentOperationId: lease.operationId,
      transition,
    }).authorized,
    true
  );
  const stale = authorizeSourceLinkageAdjudicationLease(lease, {
    currentOperationId: lease.operationId,
    transition: {
      ...transition,
      to: { ...transition.to, evidenceId: "screen-newer" },
    },
  });
  assert.equal(stale.authorized, false);
  assert.deepEqual(stale.mismatchedFacets, ["transition-to-evidence"]);
});
