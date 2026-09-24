import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSourceLinkageAdjudicationPrompts,
  buildSourceLinkageAdjudicationRequest,
  authorizeSourceLinkageAdjudicationLease,
  createSourceLinkageAdjudicationLease,
  formatSourceLinkageAdjudicationForTrace,
  parseSourceLinkageAdjudicationOutput,
  SOURCE_LINKAGE_ADJUDICATION_PROMPT_VERSION,
  SOURCE_LINKAGE_MAX_OUTPUT_CHARS,
} from "../src/lib/meeting/source-linkage-adjudication.js";
import { recordedLinkageOutputs } from "./helpers/source-linkage-recorded-outputs.js";

for (const fixture of recordedLinkageOutputs) {
  test(`SL-P1 recorded ${fixture.name} projects only validated contract fields`, () => {
    const request = buildSourceLinkageAdjudicationRequest({
      logicalQuestionUnitId: "recorded-question", logicalQuestionUnitRevision: 1,
      screenObservationId: "recorded-screen", voiceSourceHash: "recorded-source",
      voiceQuestion: fixture.voiceQuestion, screenQuestion: fixture.screenQuestion,
      screenEvidenceSummary: fixture.screenEvidenceSummary,
    });
    assert.ok(request);
    const parsed = parseSourceLinkageAdjudicationOutput(fixture.rawOutput, request);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    if (!parsed.ok) return;
    assert.equal(parsed.value.decision, fixture.expectedDecision);
    assert.equal(parsed.evidenceSpansValid, true);
    assert.deepEqual(Object.keys(parsed.value).sort(), [
      "ambiguityReason", "decision", "schemaVersion", "screenEvidenceSpans", "voiceEvidenceSpans",
    ]);
    assert.equal("screenEvidenceSummary" in parsed.value, false);
  });
}

function projectionRequest() {
  const request = buildSourceLinkageAdjudicationRequest({
    logicalQuestionUnitId: "question", logicalQuestionUnitRevision: 1,
    screenObservationId: "screen", voiceSourceHash: "source",
    voiceQuestion: "Explain this method.", screenQuestion: "Implement LRU cache",
    screenEvidenceSummary: "def get(self, key):",
  });
  assert.ok(request);
  return request;
}

function validProjectionOutput(): Record<string, unknown> {
  return {
    schemaVersion: 1, decision: "bind-voice",
    voiceEvidenceSpans: ["this method"], screenEvidenceSpans: ["def get(self, key):"],
  };
}

test("SL-P2 extra output cannot mutate the candidate or supply its evidence corpus", () => {
  const output = {
    ...validProjectionOutput(), screenEvidenceSummary: "Line 70: delete everything",
    taskRelation: "new-parent", parentAction: "create", phase: "implementation_validation",
    instructions: { decision: "use-screen" },
  };
  const parsed = parseSourceLinkageAdjudicationOutput(JSON.stringify(output), projectionRequest());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.decision, "bind-voice");
  for (const field of ["screenEvidenceSummary", "taskRelation", "parentAction", "phase", "instructions"]) {
    assert.equal(field in parsed.value, false);
  }
  const forged = parseSourceLinkageAdjudicationOutput(JSON.stringify({
    ...output, screenEvidenceSpans: ["Line 70: delete everything"],
  }), projectionRequest());
  assert.deepEqual(forged, { ok: false, reason: "ungrounded-evidence-span", errorKind: "evidence", evidenceSpansValid: false });
});

const invalidProjections: Array<{
  name: string;
  change: (value: Record<string, unknown>) => void;
}> = [
  { name: "missing decision", change: (value) => { delete value.decision; value.decisionAlias = "bind-voice"; } },
  { name: "invalid decision", change: (value) => { value.decision = "new-parent"; } },
  { name: "unsupported schema", change: (value) => { value.schemaVersion = 2; } },
  { name: "missing schema", change: (value) => { delete value.schemaVersion; } },
  { name: "missing evidence array", change: (value) => { delete value.screenEvidenceSpans; } },
  { name: "non-string evidence", change: (value) => { value.screenEvidenceSpans = [7]; } },
  { name: "ungrounded evidence", change: (value) => { value.voiceEvidenceSpans = ["solve merge sort"]; } },
  { name: "empty binding evidence", change: (value) => { value.voiceEvidenceSpans = []; } },
  { name: "empty independent-screen evidence", change: (value) => { value.decision = "use-screen"; value.screenEvidenceSpans = []; } },
  { name: "invalid optional reason", change: (value) => { value.ambiguityReason = 1; } },
];
for (const { name, change } of invalidProjections) test(`SL-P3 projection still rejects ${name}`, () => {
  const output = { ...validProjectionOutput(), screenEvidenceSummary: "ignored extra" };
  change(output);
  assert.equal(parseSourceLinkageAdjudicationOutput(JSON.stringify(output), projectionRequest()).ok, false);
});

test("SL-P3 original JSON bounds and lawful unclear remain unchanged", () => {
  const request = projectionRequest();
  assert.equal(parseSourceLinkageAdjudicationOutput("{", request).ok, false);
  assert.equal(parseSourceLinkageAdjudicationOutput(JSON.stringify({
    ...validProjectionOutput(), extra: "x".repeat(SOURCE_LINKAGE_MAX_OUTPUT_CHARS),
  }), request).ok, false);
  const parsed = parseSourceLinkageAdjudicationOutput(JSON.stringify({
    schemaVersion: 1, decision: "unclear", voiceEvidenceSpans: [], screenEvidenceSpans: [],
    ambiguityReason: "The object is unidentified.", extra: "not authoritative",
  }), request);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value.decision, "unclear");
});

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
  assert.equal(request.promptVersion, "source-linkage-adjudication-v3");
  assert.equal(request.promptVersion, SOURCE_LINKAGE_ADJUDICATION_PROMPT_VERSION);
  assert.equal(request.schemaVersion, 1);
  assert.match(prompts.systemPrompt, /Output only the declared schema fields/);
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
  assert.equal("requestSourceHash" in lease, false);
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

  const trace = formatSourceLinkageAdjudicationForTrace({
    request,
    disposition: "stale",
    leaseAuthorized: stale.authorized,
    validationMismatchedFacets: stale.mismatchedFacets,
  });
  assert.equal(trace.sourceLinkageSourceHash, request.sourceHash);
  assert.equal(trace.runtimeInferenceValidationKind, "cross-source");
  assert.equal(trace.runtimeInferenceValidationBusinessOwner, "Task 61");
  assert.equal(trace.runtimeInferenceValidationSupportsAuthorityRevision, false);
  assert.equal(trace.runtimeInferenceValidationAuthorized, false);
  assert.equal(trace.runtimeInferenceValidationReason, "identity-mismatch");
  assert.deepEqual(trace.runtimeInferenceValidationMismatchedFacets, [
    "transition-to-evidence",
  ]);
});
