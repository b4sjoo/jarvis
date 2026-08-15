import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCommittedTaskBoundaryParent,
  commitTaskBoundaryCandidate,
  createTaskBoundaryCandidate,
  decideLlmTypeRepairFirstParentAdmission,
  expireTaskBoundaryCandidate,
  taskBoundarySurvivesAdvisorOutcome,
} from "../src/lib/meeting/task-boundary-transaction.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import {
  authorizeRuntimeCommit,
  buildRuntimeCommitSnapshot,
  createRuntimeCommitToken,
  rebaseRuntimeCommitToken,
} from "../src/lib/meeting/runtime-commit-authorization.js";
import {
  createProvisionalCurrentQuestion,
  settleCurrentQuestion,
} from "../src/lib/meeting/current-question-settlement.js";
import { projectPrimaryAsk } from "../src/lib/meeting/primary-ask-projection.js";
import {
  buildResponseOpportunityRequest,
  createResponseOpportunityContextCapsule,
} from "../src/lib/meeting/short-intent-gate.js";
import { setTestActiveParent } from "./helpers/meeting-task-runtime.js";

function logicalQuestion(
  text = "Design a food delivery service"
): LogicalQuestionUnit {
  return {
    id: "logical-question-a",
    revision: 2,
    sessionId: "session-a",
    runtimeEpoch: 3,
    currentTurnId: "turn-b",
    sourceTurnIds: ["turn-a", "turn-b"],
    sources: [
      { turnId: "turn-a", text: "Design a food", startedAt: 10, endedAt: 20 },
      { turnId: "turn-b", text: "delivery service", startedAt: 30, endedAt: 40 },
    ],
    normalizedText: text,
    startedAt: 10,
    updatedAt: 40,
    compositionReasons: ["replaced-advisor-question"],
    boundaryReason: "bounded-continuation",
    truncated: false,
  };
}

test("commits a complete high-authority new parent before advisor execution", () => {
  const unit = logicalQuestion();
  const candidate = createTaskBoundaryCandidate({
    logicalQuestionUnit: unit,
    proposedQuestionType: "general-system-design",
    proposedRelation: "new-parent",
    authoritySource: "accepted-transcript",
    confidence: 0.92,
    questionComplete: true,
    mutationAuthorized: true,
    commitParent: true,
    now: 100,
  });
  assert.ok(candidate);
  assert.equal(candidate.commitPolicy, "immediate");
  assert.equal(candidate.currentQuestion.revision, 2);
  assert.equal(candidate.mutationAuthority.parentMutationAuthorized, true);

  const parent = buildCommittedTaskBoundaryParent({
    candidate,
    logicalQuestionUnit: unit,
    source: "voice",
    questionInstanceId: "question-a",
    now: 110,
  });
  assert.ok(parent);
  const committed = commitTaskBoundaryCandidate(candidate, parent.id, 110);

  assert.equal(parent.topic, "Design a food delivery service");
  assert.deepEqual(parent.canonicalQuestionSourceTurnIds, ["turn-a", "turn-b"]);
  assert.equal(committed.state, "committed");
  assert.equal(taskBoundarySurvivesAdvisorOutcome(committed, "cancelled"), true);
  assert.equal(taskBoundarySurvivesAdvisorOutcome(committed, "error"), true);
});

test("admits the first parent only after type and response opportunity settle on the same LQU", () => {
  const text = "Please design a URL shortener.";
  const primaryAskProjection = projectPrimaryAsk({
    turnId: "turn-b",
    text,
  });
  const unit: LogicalQuestionUnit = {
    ...logicalQuestion(text),
    sourceTurnIds: ["turn-b"],
    sources: [
      {
        turnId: "turn-b",
        text,
        startedAt: 30,
        endedAt: 40,
      },
    ],
    primaryAskProjection,
  };
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: unit,
    sourceKind: "voice",
  });
  const repairedSettlement = settleCurrentQuestion({
    currentQuestion,
    llmProposal: {
      source: "llm-type-repair",
      sessionId: unit.sessionId,
      runtimeEpoch: unit.runtimeEpoch,
      logicalQuestionUnitId: unit.id,
      revision: unit.revision,
      sourceHash: currentQuestion.sourceHash,
      questionType: "general-system-design",
      relation: "unknown",
      action: "answer",
      confidence: 0.97,
      typeEvidenceAuthorized: true,
      relationEvidenceAuthorized: false,
      actionEvidenceAuthorized: false,
    },
    manualCorrectionRevision: 0,
    policy: {
      allowLlmTypeRepair: true,
      runtimeMutationAuthorized: false,
      questionComplete: true,
      commitParent: false,
    },
  });
  const responseOpportunityRequest = buildResponseOpportunityRequest({
    logicalQuestionUnit: unit,
  });
  const responseOpportunityGate = {
    operationId: "response-opportunity-a",
    sessionId: unit.sessionId,
    runtimeEpoch: unit.runtimeEpoch,
    logicalQuestionUnitId: unit.id,
    logicalQuestionUnitRevision: unit.revision,
    sourceHash: responseOpportunityRequest.sourceHash,
    manualCorrectionRevision: 0,
    disposition: "output-authorized" as const,
    reason: "high-confidence-output-request",
    createdAt: 90,
    settledAt: 95,
  };

  const decision = decideLlmTypeRepairFirstParentAdmission({
    logicalQuestionUnit: unit,
    settlement: repairedSettlement,
    hasActiveParent: false,
    outputAuthorityAuthorized: true,
    responseOpportunityGate,
  });
  const blockedWithParent = decideLlmTypeRepairFirstParentAdmission({
    logicalQuestionUnit: unit,
    settlement: repairedSettlement,
    hasActiveParent: true,
    outputAuthorityAuthorized: true,
    responseOpportunityGate,
  });

  assert.equal(decision.authorized, true);
  assert.equal(decision.proposedRelation, "new-parent");
  assert.deepEqual(decision.command, {
    kind: "create-parent",
    type: "general-system-design",
    topic: text,
  });
  assert.equal(
    decision.responseOpportunityOperationId,
    responseOpportunityGate.operationId
  );
  assert.equal(blockedWithParent.authorized, false);
  assert.equal(blockedWithParent.reason, "active-parent-present");

  const pending = decideLlmTypeRepairFirstParentAdmission({
    logicalQuestionUnit: unit,
    settlement: repairedSettlement,
    hasActiveParent: false,
    outputAuthorityAuthorized: true,
    responseOpportunityGate: {
      ...responseOpportunityGate,
      disposition: "pending",
      settledAt: undefined,
    },
  });
  assert.equal(pending.authorized, false);
  assert.equal(pending.reason, "response-opportunity-not-authorized");
});

test("admits a contextual response gate without recomputing its leased source hash", () => {
  const text = "Yes, use one million daily active users.";
  const primaryAskProjection = projectPrimaryAsk({
    turnId: "turn-b",
    text,
  });
  const unit: LogicalQuestionUnit = {
    ...logicalQuestion(text),
    sourceTurnIds: ["turn-b"],
    sources: [
      {
        turnId: "turn-b",
        text,
        startedAt: 30,
        endedAt: 40,
      },
    ],
    primaryAskProjection,
  };
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: unit,
    sourceKind: "voice",
  });
  const repairedSettlement = settleCurrentQuestion({
    currentQuestion,
    llmProposal: {
      source: "llm-type-repair",
      sessionId: unit.sessionId,
      runtimeEpoch: unit.runtimeEpoch,
      logicalQuestionUnitId: unit.id,
      revision: unit.revision,
      sourceHash: currentQuestion.sourceHash,
      questionType: "general-system-design",
      relation: "unknown",
      action: "answer",
      confidence: 0.96,
      typeEvidenceAuthorized: true,
      relationEvidenceAuthorized: false,
      actionEvidenceAuthorized: false,
    },
    manualCorrectionRevision: 0,
    policy: {
      allowLlmTypeRepair: true,
      runtimeMutationAuthorized: false,
      questionComplete: true,
      commitParent: false,
    },
  });
  const contextCapsule = createResponseOpportunityContextCapsule({
    clarification: "What traffic scale should we assume?",
    logicalQuestionUnitId: "logical-question-previous",
    logicalQuestionUnitRevision: 1,
    parentId: "parent-previous",
    playbookPhase: "requirements",
    createdAt: 25,
    unresolved: true,
  });
  const responseOpportunityRequest = buildResponseOpportunityRequest({
    logicalQuestionUnit: unit,
    contextCapsule,
  });

  const decision = decideLlmTypeRepairFirstParentAdmission({
    logicalQuestionUnit: unit,
    settlement: repairedSettlement,
    hasActiveParent: false,
    outputAuthorityAuthorized: true,
    responseOpportunityGate: {
      operationId: "response-opportunity-contextual",
      sessionId: unit.sessionId,
      runtimeEpoch: unit.runtimeEpoch,
      logicalQuestionUnitId: unit.id,
      logicalQuestionUnitRevision: unit.revision,
      sourceHash: responseOpportunityRequest.sourceHash,
      manualCorrectionRevision: 0,
      disposition: "output-authorized",
      reason: "pending-clarification-resolved",
      createdAt: 45,
      settledAt: 50,
    },
  });

  assert.equal(decision.authorized, true);
  assert.equal(decision.proposedRelation, "new-parent");
  assert.equal(decision.command?.type, "general-system-design");
});

test("keeps setup objects in the committed parent topic", () => {
  const text =
    "Now add surge pricing and explain which components need to change.";
  const primaryAskProjection = projectPrimaryAsk({
    turnId: "turn-b",
    text,
  });
  const unit: LogicalQuestionUnit = {
    ...logicalQuestion(
      primaryAskProjection.normalizedPrimaryAsk ?? text
    ),
    sourceTurnIds: ["turn-b"],
    sources: [
      {
        turnId: "turn-b",
        text,
        startedAt: 30,
        endedAt: 40,
      },
    ],
    primaryAskProjection,
  };
  const candidate = createTaskBoundaryCandidate({
    logicalQuestionUnit: unit,
    proposedQuestionType: "general-system-design",
    proposedRelation: "new-parent",
    authoritySource: "accepted-transcript",
    confidence: 0.95,
    questionComplete: true,
    mutationAuthorized: true,
    commitParent: true,
  });
  assert.ok(candidate);

  const parent = buildCommittedTaskBoundaryParent({
    candidate,
    logicalQuestionUnit: unit,
    source: "voice",
  });

  assert.equal(
    parent?.topic,
    "add surge pricing explain which components need to change."
  );
});

test("binds a committed parent to the authoritative current-question settlement", () => {
  const unit = logicalQuestion();
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: unit,
    sourceKind: "voice",
    now: 90,
  });
  const settlement = settleCurrentQuestion({
    currentQuestion,
    deterministicProposal: {
      source: "deterministic-fast-path",
      sessionId: unit.sessionId,
      runtimeEpoch: unit.runtimeEpoch,
      logicalQuestionUnitId: unit.id,
      revision: unit.revision,
      sourceHash: currentQuestion.sourceHash,
      questionType: "general-system-design",
      relation: "new-parent",
      action: "answer",
      confidence: 0.94,
      typeEvidenceAuthorized: true,
      relationEvidenceAuthorized: true,
      actionEvidenceAuthorized: true,
    },
    manualCorrectionRevision: 0,
    policy: {
      runtimeMutationAuthorized: true,
      questionComplete: true,
      commitParent: true,
    },
  });
  const candidate = createTaskBoundaryCandidate({
    logicalQuestionUnit: unit,
    currentQuestion,
    settlement,
    proposedQuestionType: "coding",
    proposedRelation: "followup-parent",
    authoritySource: "accepted-transcript",
    questionComplete: true,
    mutationAuthorized: true,
    commitParent: true,
    now: 100,
  });
  assert.ok(candidate);
  assert.equal(candidate.proposedQuestionType, "general-system-design");
  assert.equal(candidate.proposedRelation, "new-parent");
  assert.equal(candidate.commitPolicy, "immediate");

  const parent = buildCommittedTaskBoundaryParent({
    candidate,
    logicalQuestionUnit: unit,
    source: "voice",
    now: 110,
  });
  assert.ok(parent);
  assert.equal(parent.settlementId, settlement.settlementId);
});

test("keeps an incomplete boundary pending until its bounded completion", () => {
  const candidate = createTaskBoundaryCandidate({
    logicalQuestionUnit: logicalQuestion("Design a system that"),
    proposedQuestionType: "unknown",
    proposedRelation: "unknown",
    authoritySource: "accepted-transcript",
    confidence: 0.8,
    questionComplete: false,
    mutationAuthorized: true,
    commitParent: true,
    now: 100,
  });
  assert.ok(candidate);
  assert.equal(candidate.commitPolicy, "await-adjacent-completion");
  assert.equal(candidate.mutationDisposition, "pending-incomplete-question");
  assert.equal(candidate.currentQuestion.normalizedText, "Design a system that");
  assert.equal(candidate.mutationAuthority.responseAuthorized, true);
  assert.equal(candidate.mutationAuthority.parentMutationAuthorized, false);
  assert.equal(expireTaskBoundaryCandidate(candidate, 1_000)?.state, "pending");
  assert.equal(expireTaskBoundaryCandidate(candidate, 16_000)?.state, "expired");
});

test("a committed boundary survives cancellation of its advisor owner", () => {
  const manager = new MeetingContextManager();
  const unit = logicalQuestion();
  const candidate = createTaskBoundaryCandidate({
    logicalQuestionUnit: unit,
    proposedQuestionType: "general-system-design",
    proposedRelation: "new-parent",
    authoritySource: "accepted-transcript",
    confidence: 0.9,
    questionComplete: true,
    mutationAuthorized: true,
    commitParent: true,
  });
  assert.ok(candidate);
  const token = createRuntimeCommitToken({
    operationId: "advisor-a",
    pipeline: "advisor",
    snapshot: buildRuntimeCommitSnapshot({
      runtimeEpoch: 3,
      contextState: manager.getState(),
    }),
  });
  assert.equal(
    authorizeRuntimeCommit({
      token,
      current: buildRuntimeCommitSnapshot({
        runtimeEpoch: 3,
        contextState: manager.getState(),
      }),
      currentOperationId: "advisor-a",
    }).authorized,
    true
  );
  const parent = buildCommittedTaskBoundaryParent({
    candidate,
    logicalQuestionUnit: unit,
    source: "voice",
  });
  assert.ok(parent);
  setTestActiveParent(manager, parent);
  const rebased = rebaseRuntimeCommitToken({
    token,
    snapshot: buildRuntimeCommitSnapshot({
      runtimeEpoch: 3,
      contextState: manager.getState(),
    }),
  });
  const committed = commitTaskBoundaryCandidate(candidate, parent.id);

  assert.equal(rebased.parentExpectation.kind, "exact");
  assert.equal(manager.getState().taskRuntime.parent?.id, parent.id);
  assert.equal(taskBoundarySurvivesAdvisorOutcome(committed, "cancelled"), true);
});

test("a precommitted parent re-roots prompt transcript at its first source turn", () => {
  const manager = new MeetingContextManager();
  manager.addTranscriptTurn({
    id: "turn-old",
    speaker: "them",
    source: "system-audio",
    text: "Implement a queue using two stacks",
    startedAt: 1,
    endedAt: 2,
    isFinal: true,
  });
  manager.addTranscriptTurn({
    id: "turn-a",
    speaker: "them",
    source: "system-audio",
    text: "Design a food",
    startedAt: 10,
    endedAt: 20,
    isFinal: true,
  });
  manager.addTranscriptTurn({
    id: "turn-b",
    speaker: "them",
    source: "system-audio",
    text: "delivery service",
    startedAt: 30,
    endedAt: 40,
    isFinal: true,
  });
  const unit = logicalQuestion();
  const candidate = createTaskBoundaryCandidate({
    logicalQuestionUnit: unit,
    proposedQuestionType: "general-system-design",
    proposedRelation: "new-parent",
    authoritySource: "accepted-transcript",
    confidence: 0.9,
    questionComplete: true,
    mutationAuthorized: true,
    commitParent: true,
  });
  assert.ok(candidate);
  const parent = buildCommittedTaskBoundaryParent({
    candidate,
    logicalQuestionUnit: unit,
    source: "voice",
  });
  assert.ok(parent);
  setTestActiveParent(manager, parent);

  const prompt = manager.buildAdvisorPromptContext();
  assert.doesNotMatch(prompt.transcript, /queue using two stacks/);
  assert.match(prompt.transcript, /Design a food/);
  assert.match(prompt.transcript, /delivery service/);
});

test("abstains from precommitting follow-ups and non-parent task types", () => {
  const followup = createTaskBoundaryCandidate({
    logicalQuestionUnit: logicalQuestion(),
    proposedQuestionType: "general-system-design",
    proposedRelation: "followup-parent",
    authoritySource: "accepted-transcript",
    confidence: 0.9,
    questionComplete: true,
    mutationAuthorized: true,
    commitParent: true,
  });
  const fieldKnowledge = createTaskBoundaryCandidate({
    logicalQuestionUnit: logicalQuestion("What is RAG?"),
    proposedQuestionType: "field-knowledge",
    proposedRelation: "new-parent",
    authoritySource: "accepted-transcript",
    confidence: 0.9,
    questionComplete: true,
    mutationAuthorized: true,
    commitParent: true,
  });

  assert.equal(followup?.mutationDisposition, "abstained-non-boundary-relation");
  assert.equal(fieldKnowledge?.mutationDisposition, "abstained-non-parent-type");
});

test("keeps a complete unknown question provisional and blocks parent mutation", () => {
  const candidate = createTaskBoundaryCandidate({
    logicalQuestionUnit: logicalQuestion("Could you explain the tradeoff?"),
    proposedQuestionType: "unknown",
    proposedRelation: "new-parent",
    authoritySource: "accepted-transcript",
    confidence: 0.4,
    questionComplete: true,
    mutationAuthorized: true,
    commitParent: true,
  });

  assert.ok(candidate);
  assert.equal(candidate.currentQuestion.revision, 2);
  assert.equal(candidate.mutationAuthority.responseAuthorized, true);
  assert.equal(candidate.mutationAuthority.typeMutationAuthorized, false);
  assert.equal(candidate.mutationAuthority.parentMutationAuthorized, false);
  assert.equal(candidate.commitPolicy, "await-adjacent-completion");
  assert.equal(candidate.mutationDisposition, "abstained-non-parent-type");
});
