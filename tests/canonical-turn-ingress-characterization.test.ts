import assert from "node:assert/strict";
import test from "node:test";
import type { ActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import type { AnswerArtifactSection } from "../src/lib/meeting/answer-generation-lease.js";
import {
  decideAdvisorTurnIntent,
  isExactLowValueAcknowledgement,
} from "../src/lib/meeting/advisor-turn-intent.js";
import {
  createProvisionalCurrentQuestion,
  settleCurrentQuestion,
  type CurrentQuestionSettlementProposal,
} from "../src/lib/meeting/current-question-settlement.js";
import { selectInterviewPlaybook } from "../src/lib/meeting/interview-playbook.js";
import {
  decideLogicalQuestionMaterialization,
  decideLogicalQuestionPublication,
} from "../src/lib/meeting/logical-question-ownership.js";
import { composeLogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import type { MeetingModelProviderSnapshot } from "../src/lib/meeting/meeting-model-route.js";
import { decidePlaybookPhaseProgression } from "../src/lib/meeting/playbook-phase.js";
import {
  primaryAskAnswerFocusText,
  primaryAskClassifierText,
  projectPrimaryAsk,
} from "../src/lib/meeting/primary-ask-projection.js";
import { buildSettledAdvisorExecutionPlan } from "../src/lib/meeting/settled-advisor-execution-plan.js";
import { resolveAuthorizedAnswerArtifacts } from "../src/lib/meeting/stable-answer.js";
import {
  inferCanonicalQuestionTypeFromText,
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "../src/lib/meeting/task-taxonomy.js";
import { calculateWordEquivalent } from "../src/lib/meeting/transcript-fusion.js";
import type { TranscriptTurn } from "../src/lib/meeting/types.js";

const providers: MeetingModelProviderSnapshot = {
  providers: [
    { id: "main", curl: "https://main.test" },
    { id: "coding", curl: "https://coding.test" },
  ],
  selectedProvider: { provider: "main", variables: {} },
  codingProvider: { provider: "coding", variables: {} },
};

interface CharacterizationDigest {
  intent: string;
  action: string;
  materialized: boolean;
  published: boolean;
  questionType?: CanonicalQuestionType;
  relation?: string;
  playbookPhase?: string;
  requestedArtifacts?: AnswerArtifactSection[];
}

const cases: Array<{
  id: string;
  text: string;
  expected: CharacterizationDigest;
}> = [
  {
    id: "coding-parent",
    text: "Please write code to implement a stack.",
    expected: {
      intent: "direct-question",
      action: "answer-refresh",
      materialized: true,
      published: true,
      questionType: "coding",
      relation: "new-parent",
      playbookPhase: "baseline_reasoning",
      requestedArtifacts: ["answer"],
    },
  },
  {
    id: "general-system-design-parent",
    text: "Design a URL shortener and start with requirements.",
    expected: {
      intent: "direct-question",
      action: "answer-refresh",
      materialized: true,
      published: true,
      questionType: "general-system-design",
      relation: "new-parent",
      playbookPhase: "requirement_clarification",
      requestedArtifacts: ["answer", "whiteboard"],
    },
  },
  {
    id: "concept-question-local-abstention",
    text: "How does HNSW search work?",
    expected: {
      intent: "direct-question",
      action: "answer-refresh",
      materialized: true,
      published: true,
      questionType: "unknown",
      relation: "new-parent",
      playbookPhase: undefined,
      requestedArtifacts: ["answer"],
    },
  },
  {
    id: "exact-filler",
    text: "Mm, okay.",
    expected: {
      intent: "confirmation",
      action: "ignore",
      materialized: false,
      published: false,
    },
  },
];

for (const characterization of cases) {
  test(`characterizes accepted canonical turn: ${characterization.id}`, () => {
    assert.deepEqual(
      characterizeAcceptedTurn(characterization.text),
      characterization.expected
    );
  });
}

function characterizeAcceptedTurn(text: string): CharacterizationDigest {
  const turn: TranscriptTurn = {
    id: `turn:${text}`,
    speaker: "them",
    source: "system-audio",
    text,
    startedAt: 100,
    endedAt: 200,
    isFinal: true,
  };
  const primaryAsk = projectPrimaryAsk({ turnId: turn.id, text });
  const intent = decideAdvisorTurnIntent(text, {
    hasActiveTask: false,
    hasRecentQuestionContext: false,
  });
  const materialization = decideLogicalQuestionMaterialization({
    action: intent.action,
    wordEquivalent: calculateWordEquivalent(text),
    exactHighFiller: isExactLowValueAcknowledgement(text),
  });
  const publication = decideLogicalQuestionPublication({
    materialization,
    runtimeIntentSettlementPending: false,
  });
  const base: CharacterizationDigest = {
    intent: intent.intent,
    action: intent.action,
    materialized: materialization.materialize,
    published: publication.publishCanonical,
  };
  if (!materialization.materialize) return base;

  const logicalQuestion = composeLogicalQuestionUnit({
    currentTurn: turn,
    sessionId: "session-characterization",
    runtimeEpoch: 1,
    intentDecision: intent,
    primaryAskProjection: primaryAsk,
    now: 200,
  });
  const semanticText = primaryAskClassifierText(primaryAsk, text);
  const questionType =
    normalizeCanonicalQuestionType(
      inferCanonicalQuestionTypeFromText(semanticText)
    ) ?? "unknown";
  const currentQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit: logicalQuestion,
    sourceKind: "voice",
    now: 200,
  });
  const proposal: CurrentQuestionSettlementProposal = {
    source: "deterministic-fast-path",
    sessionId: currentQuestion.sessionId,
    runtimeEpoch: currentQuestion.runtimeEpoch,
    logicalQuestionUnitId: currentQuestion.logicalQuestionUnitId,
    revision: currentQuestion.revision,
    sourceHash: currentQuestion.sourceHash,
    questionType,
    relation: "new-parent",
    action: "answer",
    evidenceMode: "hypothetical-design",
    confidence: 0.95,
    typeEvidenceAuthorized: true,
    relationEvidenceAuthorized: true,
    actionEvidenceAuthorized: true,
  };
  const settlement = settleCurrentQuestion({
    operationId: `settlement:${turn.id}`,
    currentQuestion,
    deterministicProposal: proposal,
    manualCorrectionRevision: 0,
    policy: {
      runtimeMutationAuthorized: true,
      questionComplete: true,
      commitParent: true,
    },
  });
  const selectedPlaybook = selectInterviewPlaybook({
    questionType,
    query: text,
  });
  const phaseDecision = decidePlaybookPhaseProgression({
    questionType,
    playbookId: selectedPlaybook?.id,
    latestTurnText: text,
    currentQuestion: primaryAskAnswerFocusText(primaryAsk, text),
    relation: "new-parent",
  });
  const playbook = selectedPlaybook
    ? { ...selectedPlaybook, phase: phaseDecision.phase }
    : undefined;
  const task = createTask(questionType, phaseDecision.phase, playbook);
  const plan = buildSettledAdvisorExecutionPlan({
    settlement,
    activeMeetingTask: task,
    taskBoundaryCommitted: true,
    childOwnsResponse: false,
    providerSnapshot: providers,
    playbook,
    memoryUseCase: "meeting_assistant",
    askFrame: "direct-answer",
    topicDomain: "backend",
    sourceQuestion: text,
    createdAt: 200,
  });

  return {
    ...base,
    questionType,
    relation: settlement.relation,
    playbookPhase: plan.playbookPhase,
    requestedArtifacts: resolveAuthorizedAnswerArtifacts({
      artifactPolicy: plan.artifactPolicy,
      artifactIntent: plan.artifactIntent,
    }),
  };
}

function createTask(
  questionType: CanonicalQuestionType,
  playbookPhase: NonNullable<ActiveMeetingTask["parent"]["playbookPhase"]>,
  playbook: ActiveMeetingTask["parent"]["playbook"]
): ActiveMeetingTask {
  return {
    id: "parent-characterization",
    runtimeRevision: 1,
    source: "voice",
    parent: {
      id: "parent-characterization",
      questionType,
      topic: "Canonical ingress characterization",
      playbook,
      playbookPhase,
      phaseProgress: {},
      supportedFactAnchors: [],
      createdAt: 100,
      updatedAt: 200,
      revisions: 1,
      sourceQuestionUnitId: "turn-characterization",
      sourceQuestionRevision: 1,
      settlementId: "settlement-characterization",
    },
  };
}
