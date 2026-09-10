import type { ActiveMeetingTask } from "../src/lib/meeting/meeting-task-contracts.js";
import assert from "node:assert/strict";
import test from "node:test";

import type { CurrentQuestionSettlementDecision } from "../src/lib/meeting/current-question-settlement.js";
import { selectInterviewPlaybook } from "../src/lib/meeting/interview-playbook.js";
import type { MeetingModelProviderSnapshot } from "../src/lib/meeting/meeting-model-route.js";
import { buildSettledAdvisorExecutionPlan } from "../src/lib/meeting/settled-advisor-execution-plan.js";
import { resolveMemoryInterviewFamilyGateDecision } from "../src/lib/memory/interview-family.js";
import type { MemoryEntry } from "../src/lib/memory/types.js";

const providers: MeetingModelProviderSnapshot = {
  providers: [
    { id: "main", curl: "https://main.test" },
    { id: "coding", curl: "https://coding.test" },
  ],
  selectedProvider: { provider: "main", variables: {} },
  codingProvider: { provider: "coding", variables: {} },
};

test("a concrete Behavioral settlement supersedes a conflicting Brief prior", () => {
  const decision = resolveMemoryInterviewFamilyGateDecision({
    entry: memoryEntry({
      interviewFamilies: ["behavioral"],
      useCases: ["behavioral_interview"],
    }),
    interviewTypes: ["coding"],
    questionType: "behavioral",
    memoryPolicy: {
      id: "behavioral_story",
      allowedFamilies: ["behavioral"],
    },
  });

  assert.equal(decision.rejectReason, undefined);
  assert.equal(decision.disposition, "explicit-family-allow");
});

test("a concrete settlement reselects instead of reusing a stale active Playbook", () => {
  const activePlaybook = selectInterviewPlaybook({
    questionType: "coding",
    query: "Implement a queue.",
  });
  const selected = selectInterviewPlaybook({
    questionType: "behavioral",
    query: "Tell me about a difficult disagreement.",
    activeTaskPlaybook: activePlaybook,
  });

  assert.equal(selected?.questionType, "behavioral");
  assert.equal(selected?.id, "behavioral_story");
  assert.equal(selected?.phase, "story_selection");
});

test("committed response owner keeps route, Playbook, memory, and prompt consumers coherent", () => {
  const task = activeTask("behavioral");
  const stalePlaybook = selectInterviewPlaybook({
    questionType: "coding",
    query: "Implement a queue.",
  });
  const plan = buildSettledAdvisorExecutionPlan({
    settlement: settlement({ questionType: "behavioral" }),
    activeMeetingTask: task,
    preBoundaryQuestionType: "coding",
    taskBoundaryCommitted: true,
    childOwnsResponse: false,
    providerSnapshot: providers,
    playbook: stalePlaybook,
    memoryUseCase: "behavioral_interview",
    askFrame: "past-project",
    topicDomain: "backend",
    sourceQuestion: "Tell me about a difficult disagreement.",
    createdAt: 100,
  });

  assert.equal(plan.responseOwner.questionType, "behavioral");
  assert.equal(plan.modelRoute.route, "main");
  assert.equal(plan.promptContract.profile, "compact-spoken");
  assert.equal(plan.memoryPolicy.questionType, "behavioral");
  assert.equal(
    plan.downstreamQuestionTypeAuthority,
    "committed-settlement"
  );
  assert.equal(plan.responsePlaybook?.questionType, "behavioral");
  assert.equal(plan.playbook?.questionType, "behavioral");
  assert.equal(
    plan.responsePlaybookDisposition,
    "reselected-incompatible-playbook"
  );
  assert.equal(plan.memoryPolicy.retrievalPolicyId, "behavioral_story");
  assert.equal(plan.parentTrajectoryPlaybook, undefined);
});

function settlement(
  overrides: Partial<CurrentQuestionSettlementDecision> = {}
): CurrentQuestionSettlementDecision {
  return {
    settlementId: "settlement-a",
    logicalQuestionUnitId: "question-a",
    revision: 1,
    sessionId: "session-a",
    runtimeEpoch: 1,
    sourceKind: "voice",
    sourceTurnIds: ["turn-a"],
    sourceObservationIds: [],
    sourceHash: "source-a",
    questionType: "behavioral",
    relation: "new-parent",
    action: "answer",
    evidenceMode: "personal-experience",
    authority: "deterministic-fast-path",
    authoritySource: "accepted-transcript",
    typeAuthoritySource: "deterministic-fast-path",
    relationAuthoritySource: "deterministic-fast-path",
    actionAuthoritySource: "deterministic-fast-path",
    typeMutationAuthorized: true,
    relationMutationAuthorized: true,
    parentMutationAuthorized: true,
    responseAuthorized: true,
    confidence: 0.95,
    manualCorrectionRevision: 0,
    rejectedProposals: [],
    reasons: ["parent-mutation-authorized", "response-authorized"],
    ...overrides,
  };
}

function activeTask(
  questionType: ActiveMeetingTask["parent"]["questionType"]
): ActiveMeetingTask {
  return {
    id: "parent-a",
    runtimeRevision: 1,
    source: "voice",
    parent: {
      id: "parent-a",
      questionType,
      topic: "Tell me about a difficult disagreement.",
      playbookPhase: "story_selection",
      phaseProgress: {},
      supportedFactAnchors: [],
      createdAt: 10,
      updatedAt: 20,
      revisions: 1,
      sourceQuestionUnitId: "question-a",
      sourceQuestionRevision: 1,
      settlementId: "settlement-a",
    },
  };
}

function memoryEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "memory-a",
    sourceIds: [],
    type: "personal_story",
    title: "A supported disagreement story",
    content: "A supported story.",
    scope: "global",
    tags: [],
    keywords: [],
    priority: "normal",
    enabled: true,
    injectionMode: "retrieval",
    useCases: ["meeting_assistant"],
    confidentiality: "normal",
    curationStatus: "curated",
    relatedEntryIds: [],
    evidenceEntryIds: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}
