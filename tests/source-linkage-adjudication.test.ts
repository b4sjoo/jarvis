import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSourceLinkageAdjudicationPrompts,
  buildSourceLinkageAdjudicationRequest,
  authorizeSourceLinkageAdjudicationLease,
  createSourceLinkageAdjudicationLease,
  parseSourceLinkageAdjudicationOutput,
  SOURCE_LINKAGE_ADJUDICATION_PROMPT_VERSION,
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
  assert.match(prompts.systemPrompt, /warrants an image-evidence recovery attempt/);
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

test("SL-E1/E5 prompt contract keeps the recorded sparse payload without parent context or title deduplication", () => {
  // dca83w, screen_trace_1789445444692_ktxxy4: frozen semantic input, not an improved summary.
  const sparsePayload = {
    voiceQuestion: "Explain lines 31-37",
    screenQuestion: "Implement LRU cache",
    screenEvidenceSummary:
      "Line 31: def get(self, key: int) -> int: in class LRUCache Implement LRU cache",
  };
  const request = buildSourceLinkageAdjudicationRequest({
    logicalQuestionUnitId: "lqu-sparse-lines",
    logicalQuestionUnitRevision: 1,
    screenObservationId: "screen-sparse-lines",
    voiceSourceHash: "voice-sparse-lines",
    activeParentObjective: "Implement LRU cache in python",
    ...sparsePayload,
  });
  assert.ok(request);
  const prompts = buildSourceLinkageAdjudicationPrompts(request);
  assert.deepEqual(JSON.parse(prompts.userMessage), sparsePayload);
  assert.equal(request.promptVersion, "source-linkage-adjudication-v2");
  assert.equal(request.promptVersion, SOURCE_LINKAGE_ADJUDICATION_PROMPT_VERSION);
  assert.equal(request.schemaVersion, 1);
  assert.match(prompts.systemPrompt, /pointing inside part of the requested region is affirmative relevance evidence/);
  assert.match(prompts.systemPrompt, /only one line or a method signature/);
  assert.match(prompts.systemPrompt, /Complete method-body or requested-range coverage is not required/);
  assert.match(prompts.systemPrompt, /Binding authorizes an attempt, not proof/);
  assert.match(prompts.systemPrompt, /Advisor must limit claims to visible evidence/);
  assert.match(prompts.systemPrompt, /Use use-screen only with positive evidence of an unrelated object or a different current request/);
  assert.match(prompts.systemPrompt, /standing problem title, its independent answerability, different wording, or an incomplete summary alone cannot justify use-screen/);
  assert.match(prompts.systemPrompt, /Use unclear when bounded evidence cannot establish reasonable relevance or positive unrelatedness/);
  assert.match(prompts.systemPrompt, /Partial visibility without enough identifying evidence is uncertainty/);
  assert.match(prompts.systemPrompt, /exact verbatim substring from the matching input field/);
  assert.match(prompts.systemPrompt, /Do not classify question type, task relation, parent action, playbook phase, memory, or artifact intent/);

  // A supplied candidate tests grounding only; no model is run or scored here.
  const parsed = parseSourceLinkageAdjudicationOutput(JSON.stringify({
    schemaVersion: 1,
    decision: "bind-voice",
    voiceEvidenceSpans: ["Explain lines 31-37"],
    screenEvidenceSpans: ["Line 31: def get(self, key: int) -> int: in class LRUCache"],
  }), request);
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
