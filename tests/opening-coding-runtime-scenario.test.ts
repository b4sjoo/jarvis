import assert from "node:assert/strict";
import test from "node:test";
import {
  decideAdvisorTaskMutation,
  authorizeAdvisorTaskMutation,
} from "../src/lib/meeting/advisor-trigger-job.js";
import {
  decideAdvisorTurnIntent,
  isExactLowValueAcknowledgement,
} from "../src/lib/meeting/advisor-turn-intent.js";
import {
  decideLogicalQuestionMaterialization,
} from "../src/lib/meeting/logical-question-ownership.js";
import { composeLogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import { projectPrimaryAsk } from "../src/lib/meeting/primary-ask-projection.js";
import {
  decideResponseOpportunityLocalRoute,
  decideResponseOpportunityRelease,
  resolveResponseOpportunityExecutionMode,
} from "../src/lib/meeting/short-intent-gate.js";
import { createTaskBoundaryCandidate } from "../src/lib/meeting/task-boundary-transaction.js";
import { inferQuestionTypeDecisionFromText } from "../src/lib/meeting/task-taxonomy.js";
import { calculateWordEquivalent } from "../src/lib/meeting/transcript-fusion.js";
import type { TranscriptTurn } from "../src/lib/meeting/types.js";
import {
  openingCodingRuntimeNegativeControls,
  openingCodingRuntimeScenarios,
  type OpeningCodingResponseOutcome,
} from "./fixtures/opening-coding-runtime-scenarios.js";

for (const scenario of openingCodingRuntimeScenarios) {
  test(`opening Coding vertical scenario: ${scenario.id}`, () => {
    const result = runScenario(
      scenario.input.text,
      scenario.input.responseOutcome
    );
    assert.deepEqual(result, scenario.expected);
  });
}

for (const control of openingCodingRuntimeNegativeControls) {
  test(`opening Coding negative control: ${control.id}`, () => {
    const intent = decideAdvisorTurnIntent(control.text, {
      hasActiveTask: false,
      hasRecentQuestionContext: false,
    });
    assert.notEqual(intent.action, "answer-refresh");
    assert.equal(
      inferQuestionTypeDecisionFromText(control.text).type,
      undefined
    );
  });
}

function runScenario(
  text: string,
  responseOutcome: OpeningCodingResponseOutcome
) {
  const intent = decideAdvisorTurnIntent(text, {
    hasActiveTask: false,
    hasRecentQuestionContext: false,
  });
  const responseRoute = decideResponseOpportunityLocalRoute({
    text,
    decision: intent,
  });
  assert.equal(intent.action, "answer-refresh");
  assert.equal(responseRoute.disposition, "deterministic-output");
  assert.equal(
    resolveResponseOpportunityExecutionMode(responseRoute),
    "speculative-authoritative"
  );

  const responseCommand = resolveResponseCommand(responseOutcome, intent);
  if (responseCommand === "output-suppressed") {
    return { runtimeAction: "suppress" as const, requestedArtifacts: [] };
  }

  const turn: TranscriptTurn = {
    id: "turn-opening-coding",
    speaker: "them",
    source: "system-audio",
    text,
    startedAt: 100,
    endedAt: 200,
    isFinal: true,
  };
  const logicalQuestionUnit = composeLogicalQuestionUnit({
    currentTurn: turn,
    sessionId: "session-opening-coding",
    runtimeEpoch: 1,
    intentDecision: intent,
    primaryAskProjection: projectPrimaryAsk({ turnId: turn.id, text }),
    now: 200,
  });
  const questionType = inferQuestionTypeDecisionFromText(text).type;
  assert.equal(questionType, "coding");
  const mutationAuthorization = authorizeAdvisorTaskMutation({
    authority: "input-evidence",
    turnIntentDecision: intent,
  });
  const mutationDecision = decideAdvisorTaskMutation({
    authority: "input-evidence",
    resolvedRelation: "new-parent",
    hasActiveParent: false,
    hasActiveChild: false,
    mutationAuthorized: mutationAuthorization.authorized,
  });
  const boundary = createTaskBoundaryCandidate({
    logicalQuestionUnit,
    proposedQuestionType: questionType,
    proposedRelation: "new-parent",
    authoritySource: "accepted-transcript",
    confidence: 0.98,
    questionComplete: decideLogicalQuestionMaterialization({
      action: intent.action,
      wordEquivalent: calculateWordEquivalent(text),
      exactHighFiller: isExactLowValueAcknowledgement(text),
    }).materialize,
    mutationAuthorized: mutationAuthorization.authorized,
    commitParent: mutationDecision.commitParent,
    now: 200,
  });
  assert.equal(boundary?.mutationDisposition, "commit-before-advisor");

  return {
    runtimeAction: "advise" as const,
    questionType: "coding" as const,
    relation: "new-parent" as const,
    parentAction: "create" as const,
    requestedArtifacts: ["answer" as const],
  };
}

function resolveResponseCommand(
  outcome: OpeningCodingResponseOutcome,
  intent: ReturnType<typeof decideAdvisorTurnIntent>
) {
  if (outcome === "timeout" || outcome === "invalid") {
    return "output-authorized" as const;
  }
  const decision = decideResponseOpportunityRelease({
    original: intent,
    result: {
      schemaVersion: 4,
      decision: outcome,
      confidence: 1,
      decisionTarget: "implement an LRU cache",
      targetSpans: [
        { turnId: "turn-opening-coding", text: "implement an LRU cache" },
      ],
      reason: outcome === "output-request" ? "directive" : "acknowledgement",
    },
  });
  return decision.generationDisposition;
}
