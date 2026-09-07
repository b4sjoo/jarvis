import assert from "node:assert/strict";
import test from "node:test";
import type { ActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import type { CurrentQuestionSettlementDecision } from "../src/lib/meeting/current-question-settlement.js";
import { selectInterviewPlaybook } from "../src/lib/meeting/interview-playbook.js";
import { parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";
import type { MeetingModelProviderSnapshot } from "../src/lib/meeting/meeting-model-route.js";
import { authorizeManualScreenPresentationArtifacts } from "../src/lib/meeting/screen-artifact-authority.js";
import { buildSettledAdvisorExecutionPlan } from "../src/lib/meeting/settled-advisor-execution-plan.js";
import { commitStableAnswerRevision } from "../src/lib/meeting/stable-answer.js";
import type {
  AdvisorSuggestion,
  SelectedInterviewPlaybook,
} from "../src/lib/meeting/types.js";

const providers: MeetingModelProviderSnapshot = {
  providers: [{ id: "main", curl: "https://main.test/{{IMAGE}}" }],
  selectedProvider: { provider: "main", variables: {} },
  codingProvider: { provider: "", variables: {} },
};

function implementationPlaybook(): SelectedInterviewPlaybook {
  const selected = selectInterviewPlaybook({
    questionType: "coding",
    query: "Implement the cache.",
  });
  assert.ok(selected);
  return { ...selected, phase: "implementation_validation" };
}

function activeTask(playbook: SelectedInterviewPlaybook): ActiveMeetingTask {
  return {
    id: "design-parent",
    runtimeRevision: 2,
    source: "screen",
    parent: {
      id: "design-parent",
      questionType: "ai-ml-system-design",
      topic: "Design a RAG service.",
      playbookPhase: "architecture_decision",
      phaseProgress: {},
      supportedFactAnchors: [],
      revisions: 2,
      createdAt: 1,
      updatedAt: 2,
    },
    child: {
      id: "coding-child",
      questionType: "coding",
      relation: "child-probe",
      intent: "unknown",
      question: "Implement the cache.",
      basedOnTurnIds: [],
      basedOnObservationIds: ["screen-code"],
      createdAt: 2,
      updatedAt: 2,
      phaseState: {
        phase: "implementation_validation",
        revision: 1,
        playbook,
        phaseProgress: {},
      },
    },
  };
}

function settlement(): CurrentQuestionSettlementDecision {
  return {
    settlementId: "screen-settlement",
    logicalQuestionUnitId: "screen-lqu",
    revision: 1,
    sessionId: "session-a",
    runtimeEpoch: 1,
    sourceKind: "screen",
    sourceTurnIds: [],
    sourceObservationIds: ["screen-code"],
    sourceHash: "screen-source",
    questionType: "coding",
    relation: "child-probe",
    action: "answer",
    evidenceMode: "unknown",
    authority: "runtime-adjudication",
    authoritySource: "runtime-adjudication",
    typeAuthoritySource: "runtime-adjudication",
    relationAuthoritySource: "runtime-adjudication",
    actionAuthoritySource: "deterministic-fast-path",
    typeMutationAuthorized: true,
    relationMutationAuthorized: true,
    parentMutationAuthorized: false,
    responseAuthorized: true,
    confidence: 0.99,
    manualCorrectionRevision: 0,
    rejectedProposals: [],
    reasons: ["response-authorized"],
  };
}

function screenPlan(boundVoicePrimaryAsk: boolean) {
  const playbook = implementationPlaybook();
  return buildSettledAdvisorExecutionPlan({
    settlement: settlement(),
    activeMeetingTask: activeTask(playbook),
    preBoundaryQuestionType: "ai-ml-system-design",
    taskBoundaryCommitted: false,
    childOwnsResponse: true,
    providerSnapshot: providers,
    playbook,
    memoryUseCase: "coding_interview",
    askFrame: "direct-answer",
    topicDomain: "backend",
    sourceQuestion: boundVoicePrimaryAsk
      ? "Explain lines 35 through 38."
      : "Implement the cache.",
    subtaskIntent: boundVoicePrimaryAsk ? "concept-probe" : "unknown",
    artifactRequest: { manualScreen: { boundVoicePrimaryAsk } },
    requiresVision: true,
    createdAt: 3,
  });
}

function suggestion(id: string, answer: string, code: string): AdvisorSuggestion {
  const content = [
    `Answer: ${answer}`,
    "Approach: Use the committed implementation phase.",
    "Code:",
    "```python",
    code,
    "```",
    "Complexity: O(1) time and O(n) space.",
    "Whiteboard: -",
  ].join("\n");
  return {
    id,
    kind: "answer",
    content,
    meetingAnswer: parseMeetingAnswer(content, { expectedProfile: "coding" }),
    createdAt: 4,
    basedOnTurnIds: [],
    basedOnObservationIds: ["screen-code"],
    confidence: "high",
  };
}

test("publishes a manual Screen artifact only inside its frozen Plan bounds", () => {
  const plan = screenPlan(false);
  const candidate = suggestion(
    "screen-candidate",
    "Use a dictionary-backed cache.",
    "def get(key): return cache[key]"
  );
  const selection = authorizeManualScreenPresentationArtifacts({
    requestedArtifacts: plan.requestedArtifacts,
    parsedAnswer: candidate.meetingAnswer!,
  });
  const stable = commitStableAnswerRevision({
    candidate,
    authorizedArtifacts: selection.authorizedArtifacts,
    taskId: "design-parent",
    sectionOwner: {
      kind: "active-child",
      parentId: "design-parent",
      childId: "coding-child",
    },
    logicalQuestionUnitId: plan.logicalQuestionUnitId,
    logicalQuestionRevision: plan.logicalQuestionRevision,
    sessionId: plan.sessionId,
    runtimeEpoch: plan.runtimeEpoch,
    questionSourceHash: plan.sourceHash,
    settlementId: plan.settlementId,
    committedAt: 5,
  });

  assert.equal(plan.artifactPolicy.allowCode, false);
  assert.deepEqual(plan.requestedArtifacts, ["answer", "code", "complexity"]);
  assert.deepEqual(selection.authorizedArtifacts, [
    "answer",
    "code",
    "complexity",
  ]);
  assert.match(stable!.suggestion.meetingAnswer!.sections.code!, /def get/);
});

test("does not let parsed Code expand a Voice-owned Screen recovery Plan", () => {
  const original = suggestion(
    "original",
    "Use the existing implementation.",
    "def get(key): return old_cache[key]"
  );
  const current = commitStableAnswerRevision({
    candidate: original,
    authorizedArtifacts: ["answer", "code", "complexity"],
    taskId: "design-parent",
    sectionOwner: {
      kind: "active-child",
      parentId: "design-parent",
      childId: "coding-child",
    },
    logicalQuestionUnitId: "screen-lqu",
    logicalQuestionRevision: 1,
    sessionId: "session-a",
    runtimeEpoch: 1,
    questionSourceHash: "screen-source",
    settlementId: "screen-settlement",
    committedAt: 5,
  });
  assert.ok(current);
  const plan = screenPlan(true);
  const candidate = suggestion(
    "recovery",
    "Those lines update recency.",
    "def get(key): return invented_replacement[key]"
  );
  const selection = authorizeManualScreenPresentationArtifacts({
    requestedArtifacts: plan.requestedArtifacts,
    parsedAnswer: candidate.meetingAnswer!,
  });
  const stable = commitStableAnswerRevision({
    current,
    candidate,
    authorizedArtifacts: selection.authorizedArtifacts,
    taskId: "design-parent",
    sectionOwner: {
      kind: "active-child",
      parentId: "design-parent",
      childId: "coding-child",
    },
    logicalQuestionUnitId: plan.logicalQuestionUnitId,
    logicalQuestionRevision: plan.logicalQuestionRevision,
    sessionId: plan.sessionId,
    runtimeEpoch: plan.runtimeEpoch,
    questionSourceHash: plan.sourceHash,
    settlementId: plan.settlementId,
    committedAt: 6,
  });

  assert.deepEqual(plan.requestedArtifacts, ["answer"]);
  assert.deepEqual(selection.authorizedArtifacts, ["answer"]);
  assert.match(stable!.suggestion.meetingAnswer!.sections.code!, /old_cache/);
  assert.doesNotMatch(
    stable!.suggestion.meetingAnswer!.sections.code!,
    /invented_replacement/
  );
});
