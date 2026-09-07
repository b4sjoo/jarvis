import assert from "node:assert/strict";
import test from "node:test";
import type { ActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import type { AnswerArtifactSection } from "../src/lib/meeting/answer-generation-lease.js";
import type { CurrentQuestionSettlementDecision } from "../src/lib/meeting/current-question-settlement.js";
import { selectInterviewPlaybook } from "../src/lib/meeting/interview-playbook.js";
import type { MeetingModelProviderSnapshot } from "../src/lib/meeting/meeting-model-route.js";
import { decidePlaybookPhaseProgression } from "../src/lib/meeting/playbook-phase.js";
import { buildSettledAdvisorExecutionPlan } from "../src/lib/meeting/settled-advisor-execution-plan.js";
import type { CanonicalQuestionType } from "../src/lib/meeting/task-taxonomy.js";
import type {
  InterviewPlaybookPhase,
  InterviewSubtaskIntent,
  InterviewTaskRelation,
} from "../src/lib/meeting/types.js";

const providers: MeetingModelProviderSnapshot = {
  providers: [
    { id: "main", curl: "https://main.test" },
    { id: "coding", curl: "https://coding.test" },
  ],
  selectedProvider: { provider: "main", variables: {} },
  codingProvider: { provider: "coding", variables: {} },
};

interface ArtifactParityCase {
  id: string;
  input: {
    questionType: CanonicalQuestionType;
    relation: InterviewTaskRelation;
    question: string;
    currentPhase?: InterviewPlaybookPhase;
    phaseProgress?: Record<string, boolean>;
    subtaskIntent?: InterviewSubtaskIntent;
  };
  expected: {
    voiceRequestedArtifacts: AnswerArtifactSection[];
    screenRequestedArtifacts: AnswerArtifactSection[];
  };
}

const cases: ArtifactParityCase[] = [
  {
    id: "behavioral-answer",
    input: {
      questionType: "behavioral",
      relation: "new-parent",
      question: "Tell me about a difficult disagreement.",
    },
    expected: {
      voiceRequestedArtifacts: ["answer"],
      screenRequestedArtifacts: ["answer"],
    },
  },
  {
    id: "coding-baseline",
    input: {
      questionType: "coding",
      relation: "new-parent",
      question: "Solve longest substring without repeating characters.",
    },
    expected: {
      voiceRequestedArtifacts: ["answer"],
      screenRequestedArtifacts: ["answer"],
    },
  },
  {
    id: "coding-optimized-pseudocode",
    input: {
      questionType: "coding",
      relation: "followup-parent",
      question: "Optimize the solution and walk through the pseudocode.",
      currentPhase: "baseline_reasoning",
      phaseProgress: { baseline_reasoning: true },
      subtaskIntent: "complexity-probe",
    },
    expected: {
      voiceRequestedArtifacts: ["answer"],
      screenRequestedArtifacts: ["answer", "complexity"],
    },
  },
  {
    id: "coding-implementation-phase",
    input: {
      questionType: "coding",
      relation: "followup-parent",
      question: "Validate the complete implementation and its edge cases.",
      currentPhase: "implementation_validation",
      phaseProgress: {
        baseline_reasoning: true,
        optimized_pseudocode: true,
      },
    },
    expected: {
      voiceRequestedArtifacts: ["answer"],
      screenRequestedArtifacts: ["answer", "code", "complexity"],
    },
  },
  {
    id: "coding-explicit-implementation",
    input: {
      questionType: "coding",
      relation: "followup-parent",
      question: "Now implement the complete solution in Java.",
      currentPhase: "optimized_pseudocode",
      phaseProgress: {
        baseline_reasoning: true,
        optimized_pseudocode: true,
      },
      subtaskIntent: "implementation-probe",
    },
    expected: {
      voiceRequestedArtifacts: ["answer"],
      screenRequestedArtifacts: ["answer", "code", "complexity"],
    },
  },
  {
    id: "coding-explicit-complexity",
    input: {
      questionType: "coding",
      relation: "followup-parent",
      question: "What is the optimized time and space complexity?",
      currentPhase: "baseline_reasoning",
      phaseProgress: { baseline_reasoning: true },
      subtaskIntent: "complexity-probe",
    },
    expected: {
      voiceRequestedArtifacts: ["answer"],
      screenRequestedArtifacts: ["answer", "complexity"],
    },
  },
  {
    id: "general-system-design-whiteboard",
    input: {
      questionType: "general-system-design",
      relation: "new-parent",
      question: "Design a URL shortener.",
    },
    expected: {
      voiceRequestedArtifacts: ["answer", "whiteboard"],
      screenRequestedArtifacts: ["answer", "whiteboard"],
    },
  },
  {
    id: "ai-ml-system-design-whiteboard",
    input: {
      questionType: "ai-ml-system-design",
      relation: "new-parent",
      question: "Design a RAG system for trip planning.",
    },
    expected: {
      voiceRequestedArtifacts: ["answer", "whiteboard"],
      screenRequestedArtifacts: ["answer", "whiteboard"],
    },
  },
  {
    id: "project-deep-dive-answer",
    input: {
      questionType: "project-deep-dive",
      relation: "new-parent",
      question: "Why did you choose NDJSON for Oasis?",
    },
    expected: {
      voiceRequestedArtifacts: ["answer"],
      screenRequestedArtifacts: ["answer"],
    },
  },
  {
    id: "field-knowledge-answer",
    input: {
      questionType: "field-knowledge",
      relation: "new-parent",
      question: "How does HNSW search work?",
    },
    expected: {
      voiceRequestedArtifacts: ["answer"],
      screenRequestedArtifacts: ["answer"],
    },
  },
  {
    id: "unknown-current-only-answer",
    input: {
      questionType: "unknown",
      relation: "unknown",
      question: "Could you explain that?",
    },
    expected: {
      voiceRequestedArtifacts: ["answer"],
      screenRequestedArtifacts: ["answer"],
    },
  },
];

for (const parityCase of cases) {
  test(`compiles Voice and Screen requested artifacts independently: ${parityCase.id}`, () => {
    const phaseDecision = decidePlaybookPhaseProgression({
      questionType: parityCase.input.questionType,
      currentPhase: parityCase.input.currentPhase,
      phaseProgress: parityCase.input.phaseProgress,
      latestTurnText: parityCase.input.question,
      currentQuestion: parityCase.input.question,
      relation: parityCase.input.relation,
      subtaskIntent: parityCase.input.subtaskIntent,
    });
    const selectedPlaybook = selectInterviewPlaybook({
      questionType: parityCase.input.questionType,
      query: parityCase.input.question,
    });
    const phasedPlaybook = selectedPlaybook
      ? { ...selectedPlaybook, phase: phaseDecision.phase }
      : undefined;
    const task = createActiveTask(
      parityCase.input.questionType,
      phaseDecision.phase,
      phasedPlaybook
    );
    const currentSettlement = settlement({
      questionType: parityCase.input.questionType,
      relation: parityCase.input.relation,
      parentMutationAuthorized: parityCase.input.relation === "new-parent",
      relationMutationAuthorized: parityCase.input.relation !== "unknown",
    });
    const voicePlan = buildSettledAdvisorExecutionPlan({
      settlement: currentSettlement,
      activeMeetingTask: task,
      taskBoundaryCommitted: parityCase.input.relation === "new-parent",
      childOwnsResponse: false,
      providerSnapshot: providers,
      playbook: phasedPlaybook,
      memoryUseCase: "meeting_assistant",
      askFrame: "direct-answer",
      topicDomain: "backend",
      sourceQuestion: parityCase.input.question,
      subtaskIntent: parityCase.input.subtaskIntent,
      createdAt: 100,
    });
    const screenPlan = buildSettledAdvisorExecutionPlan({
      settlement: {
        ...currentSettlement,
        sourceKind: "screen",
        sourceTurnIds: [],
        sourceObservationIds: ["screen-parity"],
      },
      activeMeetingTask: task,
      taskBoundaryCommitted: parityCase.input.relation === "new-parent",
      childOwnsResponse: false,
      providerSnapshot: providers,
      playbook: phasedPlaybook,
      memoryUseCase: "meeting_assistant",
      askFrame: "direct-answer",
      topicDomain: "backend",
      sourceQuestion: parityCase.input.question,
      subtaskIntent: parityCase.input.subtaskIntent,
      artifactRequest: {
        manualScreen: { boundVoicePrimaryAsk: false },
      },
      createdAt: 100,
    });

    assert.deepEqual(
      voicePlan.requestedArtifacts,
      parityCase.expected.voiceRequestedArtifacts,
      `${parityCase.id}: unexpected Voice requestedArtifacts`
    );
    assert.deepEqual(
      screenPlan.requestedArtifacts,
      parityCase.expected.screenRequestedArtifacts,
      `${parityCase.id}: unexpected Screen requestedArtifacts`
    );
  });
}

function settlement(
  overrides: Partial<CurrentQuestionSettlementDecision>
): CurrentQuestionSettlementDecision {
  return {
    settlementId: "settlement-parity",
    logicalQuestionUnitId: "question-parity",
    revision: 1,
    sessionId: "session-parity",
    runtimeEpoch: 1,
    sourceKind: "voice",
    sourceTurnIds: ["turn-parity"],
    sourceObservationIds: [],
    sourceHash: "source-parity",
    questionType: "unknown",
    relation: "unknown",
    action: "answer",
    evidenceMode: "hypothetical-design",
    authority: "deterministic-fast-path",
    authoritySource: "accepted-transcript",
    typeAuthoritySource: "deterministic-fast-path",
    relationAuthoritySource: "deterministic-fast-path",
    actionAuthoritySource: "deterministic-fast-path",
    typeMutationAuthorized: true,
    relationMutationAuthorized: false,
    parentMutationAuthorized: false,
    responseAuthorized: true,
    confidence: 0.95,
    manualCorrectionRevision: 0,
    rejectedProposals: [],
    reasons: ["response-authorized"],
    ...overrides,
  };
}

function createActiveTask(
  questionType: CanonicalQuestionType,
  phase: InterviewPlaybookPhase,
  playbook: ReturnType<typeof selectInterviewPlaybook>
): ActiveMeetingTask | undefined {
  if (questionType === "unknown") return undefined;
  return {
    id: "parent-parity",
    runtimeRevision: 1,
    source: "voice",
    parent: {
      id: "parent-parity",
      questionType,
      topic: "Parity test question",
      playbook,
      playbookPhase: phase,
      phaseProgress: {},
      supportedFactAnchors: [],
      createdAt: 10,
      updatedAt: 20,
      revisions: 1,
      sourceQuestionUnitId: "question-parity",
      sourceQuestionRevision: 1,
      settlementId: "settlement-parity",
    },
  };
}
