import assert from "node:assert/strict";
import test from "node:test";
import {
  decideSemanticTaxonomyShadowEligibility,
  formatSemanticTaxonomyShadowMetadata,
} from "../src/lib/meeting/semantic-taxonomy-shadow.js";
import { inferQuestionTypeDecisionFromText } from "../src/lib/meeting/task-taxonomy.js";

test("semantic shadow only accepts answer-refresh interviewer turns", () => {
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
