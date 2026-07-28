import assert from "node:assert/strict";
import test from "node:test";
import {
  decideSemanticTaxonomyShadowEligibility,
  decideSemanticTaxonomyUnknownRescue,
  formatSemanticTaxonomyShadowMetadata,
} from "../src/lib/meeting/semantic-taxonomy-shadow.js";
import { inferQuestionTypeDecisionFromText } from "../src/lib/meeting/task-taxonomy.js";

test("semantic shadow accepts substantive interviewer turns without authorizing advice", () => {
  assert.deepEqual(
    decideSemanticTaxonomyShadowEligibility({
      speaker: "them",
      turnGateAction: "answer-refresh",
      wordEquivalent: 8,
    }),
    {
      eligible: true,
      reason: "accepted-latest-interviewer-turn",
      wordEquivalent: 8,
    }
  );
  assert.equal(
    decideSemanticTaxonomyShadowEligibility({
      speaker: "them",
      turnGateAction: "state-update",
      wordEquivalent: 8,
    }).reason,
    "substantive-suppressed-or-context-turn"
  );
  assert.equal(
    decideSemanticTaxonomyShadowEligibility({
      speaker: "them",
      turnGateAction: "ignore",
      wordEquivalent: 2,
    }).eligible,
    false
  );
  assert.equal(
    decideSemanticTaxonomyShadowEligibility({
      speaker: "me",
      turnGateAction: "answer-refresh",
      wordEquivalent: 8,
    }).eligible,
    false
  );
});

test("semantic evidence remains non-authoritative in compatibility enforcement mode", () => {
  const enforcement = decideSemanticTaxonomyUnknownRescue({
    mode: "enforcement",
    lexicalType: "unknown",
    deterministicType: "unknown",
    recommendedType: "field-knowledge",
    wouldRescue: true,
    hasManualCorrection: false,
  });
  assert.equal(enforcement.applied, false);
  assert.equal(enforcement.effectiveType, "unknown");
  assert.equal(enforcement.parentMutationBlocked, true);
  assert.equal(enforcement.reason, "semantic-evidence-non-authoritative");

  const shadow = decideSemanticTaxonomyUnknownRescue({
    mode: "shadow",
    lexicalType: "unknown",
    deterministicType: "unknown",
    recommendedType: "coding",
    wouldRescue: true,
    hasManualCorrection: false,
  });
  assert.equal(shadow.applied, false);
  assert.equal(shadow.effectiveType, "unknown");
});

test("semantic compatibility mode preserves manual, lexical, route, and parent authority", () => {
  const base = {
    mode: "enforcement" as const,
    lexicalType: "unknown" as const,
    deterministicType: "unknown" as const,
    recommendedType: "ai-ml-system-design" as const,
    wouldRescue: true,
    hasManualCorrection: false,
  };
  assert.equal(
    decideSemanticTaxonomyUnknownRescue({
      ...base,
      hasManualCorrection: true,
    }).reason,
    "manual-correction-authoritative"
  );
  assert.equal(
    decideSemanticTaxonomyUnknownRescue({
      ...base,
      lexicalType: "coding",
      deterministicType: "coding",
    }).reason,
    "concrete-lexical-type-authoritative"
  );
  assert.equal(
    decideSemanticTaxonomyUnknownRescue({
      ...base,
      deterministicType: "project-deep-dive",
    }).reason,
    "deterministic-route-type-authoritative"
  );
  const parentConflict = decideSemanticTaxonomyUnknownRescue({
    ...base,
    activeParentType: "general-system-design",
  });
  assert.equal(parentConflict.applied, false);
  assert.equal(parentConflict.parentMutationBlocked, true);
  assert.equal(
    parentConflict.reason,
    "semantic-evidence-non-authoritative-with-active-parent"
  );
});

test("shadow metadata preserves lexical behavior and records would-rescue only", () => {
  const lexical = inferQuestionTypeDecisionFromText(
    "How would you build a nearest neighbor search service?"
  );
  const eligibility = decideSemanticTaxonomyShadowEligibility({
    speaker: "them",
    turnGateAction: "answer-refresh",
    wordEquivalent: 9,
  });
  const metadata = formatSemanticTaxonomyShadowMetadata({
    turnId: "turn_1",
    sessionId: "session_1",
    runtimeEpoch: 4,
    lexical,
    eligibility,
    runtime: {
      readiness: "ready",
      modelVersion: "model-v1",
      coldFallbackCount: 0,
      reusedAfterAudioRecovery: false,
      queueDepth: 0,
      maxQueueDepth: 1,
      coalescedCount: 0,
      staleCount: 0,
      timeoutCount: 0,
      abandonedCount: 0,
    },
    embedding: {
      status: "success",
      input: {
        sessionId: "session_1",
        runtimeEpoch: 4,
        turnId: "turn_1",
        texts: ["question"],
        kind: "query",
      },
      embeddings: [[0.1]],
      durationMs: 21,
      modelVersion: "model-v1",
      cacheHit: false,
      telemetry: {
        requestId: "request_1",
        event: "settled",
        consumer: "interviewer-intent",
        coalescingKey: "session_1:current-question",
        revision: 1,
        outcome: "success",
        queueWaitMs: 3,
        computeMs: 18,
        totalMs: 21,
        deadlineProfile: "warm",
        deadlinePhase: "compute",
        deadlineMs: 350,
        coalesced: false,
        stale: false,
        abandoned: false,
        cacheHit: false,
        queueDepth: 0,
        maxQueueDepth: 1,
      },
    },
    semantic: {
      candidateType: "ai-ml-system-design",
      calibratedConfidence: 0.88,
      margin: 0.04,
      accepted: true,
      rejectionReasons: [],
      perTypeScores: {},
      positivePrototypeIds: ["aiml_1"],
      hardNegativePrototypeIds: ["aiml_hn_1"],
      modelVersion: "model-v1",
      prototypeVersion: "prototype-v1",
      calibrationVersion: "calibration-v1",
    },
    hybrid: {
      lexicalType: "unknown",
      effectiveType: "unknown",
      recommendedType: "ai-ml-system-design",
      outcome: "semantic-would-rescue",
      reason: "calibrated-semantic-candidate-for-lexical-unknown",
      semanticDisposition: "abstain",
      wouldRescue: true,
      lexicalAuthoritative: false,
      semantic: undefined,
    },
  });

  assert.equal(metadata.taxonomyHybridWouldRescue, true);
  assert.equal(
    metadata.taxonomyHybridEffectiveType,
    lexical.type ?? "unknown"
  );
  assert.equal(metadata.taxonomySemanticRescueApplied, false);
  assert.equal(metadata.taxonomySemanticBehaviorMutationBlocked, true);
});
