import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAnswerRecoveryAdjudicationPrompts,
  buildVisualEvidenceCheckRequest,
  type AnswerRecoveryAdjudicationRequest,
} from "../src/lib/meeting/answer-recovery-adjudication.js";
import {
  buildAnswerSufficiencyAdjudicationPrompts,
  type AnswerSufficiencyAdjudicationRequest,
} from "../src/lib/meeting/answer-sufficiency-adjudication.js";
import {
  buildMeetingMetadataInferencePrompts,
  type MeetingMetadataInferenceRequest,
} from "../src/lib/meeting/meeting-metadata-inference.js";
import {
  buildQuestionTypeAdjudicationPrompts,
  type QuestionTypeAdjudicationRequest,
} from "../src/lib/meeting/question-type-adjudication.js";
import {
  findRuntimeEnvelopeLeakage,
} from "../src/lib/meeting/runtime-inference.js";
import {
  buildResponseOpportunityPrompts,
} from "../src/lib/meeting/short-intent-gate.js";
import type { ResponseOpportunityRequest } from "../src/lib/meeting/response-opportunity-contract.js";
import {
  buildSourceLinkageAdjudicationPrompts,
  type SourceLinkageAdjudicationRequest,
} from "../src/lib/meeting/source-linkage-adjudication.js";
import {
  buildTaskRelationAdjudicationPrompts,
  type TaskRelationAdjudicationRequest,
} from "../src/lib/meeting/task-relation-adjudication.js";
import {
  buildTaxonomyAdjudicationPrompts,
  type TaxonomyAdjudicationProjection,
  type TaxonomyAdjudicationRequest,
} from "../src/lib/meeting/taxonomy-adjudication.js";
import {
  buildWhiteboardSyntaxRepairPrompts,
  type WhiteboardSyntaxRepairRequest,
} from "../src/lib/meeting/whiteboard-syntax-repair.js";

const questionProjection: TaxonomyAdjudicationProjection = {
  text: "What would you monitor in production?",
  sourceTurns: [
    { turnId: "turn-current", text: "What would you monitor in production?" },
  ],
  sourceTurnIds: ["turn-current"],
  omittedSourceTurnIds: [],
  originalChars: 37,
  projectedChars: 37,
  projectionReason: "within-limit",
  safe: true,
};

function parseUserMessage(value: string) {
  return JSON.parse(value) as unknown;
}

test("keeps envelope fields out of every runtime LLM prompt", () => {
  const taxonomy: TaxonomyAdjudicationRequest = {
    schemaVersion: 2,
    promptVersion: "taxonomy-adjudication-v3-compact",
    logicalQuestionUnitId: "question-current",
    logicalQuestionUnitRevision: 2,
    question: questionProjection,
    sourceLanguage: "en",
    sttUncertaintyMarkers: ["provider-confidence-unavailable"],
    activeParent: {
      idHash: "parent-hash",
      revision: 4,
      questionType: "project-deep-dive",
      topic: "Oasis reliability",
      playbookPhase: "project_narrative",
    },
    taskSwitchEvidence: [],
  };
  const questionType: QuestionTypeAdjudicationRequest = {
    schemaVersion: 1,
    promptVersion: "question-type-adjudication-v1",
    logicalQuestionUnitId: "question-current",
    logicalQuestionUnitRevision: 2,
    question: questionProjection,
  };
  const responseOpportunity: ResponseOpportunityRequest = {
    schemaVersion: 4,
    promptVersion: "response-opportunity-v4-decision-target",
    logicalQuestionUnitId: "question-current",
    logicalQuestionUnitRevision: 2,
    currentTurnId: "turn-current",
    sourceHash: "source-hash",
    decisionSpans: [
      { turnId: "turn-current", text: "What would you monitor in production?" },
    ],
    boundedContext: "What would you monitor in production?",
    boundedContextSourceTurnIds: ["turn-current"],
    contextCapsule: {
      pendingClarification: {
        summary: "Should I focus on monitoring?",
        supportStatus: "final-output-authorized",
        logicalQuestionUnitId: "question-prior",
        logicalQuestionUnitRevision: 1,
        parentId: "parent-a",
        playbookPhase: "project_narrative",
        createdAt: 100,
        unresolved: true,
      },
    },
    manualForceAdvise: false,
  };
  const metadata: MeetingMetadataInferenceRequest = {
    schemaVersion: 1,
    promptVersion: "meeting-metadata-inference-v1",
    sessionId: "session-a",
    operationRevision: 1,
    openingEvidence: {
      turns: [
        { id: "turn-a", text: "Welcome to Box.", startedAt: 10, endedAt: 20 },
      ],
      sourceHash: "opening-hash",
      revision: 1,
      totalChars: 15,
      omittedTurnCount: 0,
    },
  };
  const whiteboard: WhiteboardSyntaxRepairRequest = {
    promptVersion: "whiteboard-syntax-repair-v2",
    schemaVersion: 1,
    input: {
      mermaid: "flowchart LR\nA-->B",
      parserError: "line 2",
      parserContext: "2: A-->B",
      diagramKind: "flowchart",
    },
  };
  const relation: TaskRelationAdjudicationRequest = {
    schemaVersion: 3,
    promptVersion: "task-relation-adjudication-v3-direct",
    logicalQuestionUnitId: "question-current",
    logicalQuestionUnitRevision: 2,
    sourceSettlementId: "settlement-a",
    sourceHash: "relation-hash",
    currentQuestion: questionProjection,
    activeParent: {
      parentId: "parent-a",
      revision: 4,
      topic: "Oasis reliability",
      compactObjective: "Explain implementation tradeoffs.",
      sourceTurnIds: ["turn-parent"],
      acceptedConstraints: [],
      sharedScenarioEntities: [],
    },
    activeChild: {
      childId: "child-a",
      question: "Explain HNSW.",
      sourceTurnIds: ["turn-child"],
    },
    recentSourceEvidence: [
      {
        turnId: "turn-prior",
        text: "Availability during failures.",
        role: "constraint",
        selectionReason: "role-hint",
        sourceScope: "parent-scope",
      },
    ],
    recentBranchEvidence: [],
    recentParentEvidence: [
      {
        turnId: "turn-prior",
        text: "Availability during failures.",
        role: "constraint",
        selectionReason: "role-hint",
        sourceScope: "parent-scope",
      },
    ],
    recentTransitions: [
      { turnId: "turn-transition", text: "Back to the main design." },
    ],
    recentEvidenceDiagnostics: {
      eligiblePriorTurnCount: 2,
      selectedTurnCount: 1,
      rawFallbackCount: 0,
      falseEmpty: false,
      parentBoundaryFound: true,
      parentScopedSelectedCount: 1,
      crossBoundarySelectedCount: 0,
      currentSourceFallbackCount: 0,
      lquSelectedCount: 0,
      rawSupplementCount: 0,
      acknowledgementExcludedCount: 0,
      logisticsExcludedCount: 0,
      coveredTurnCount: 0,
      branchEvidenceCount: 0,
      parentEvidenceCount: 1,
    },
  };
  const answerRecovery: AnswerRecoveryAdjudicationRequest = {
    schemaVersion: 2,
    promptVersion: "answer-resolution-adjudication-v1",
    operationKind: "answer-resolution",
    logicalQuestionUnitId: "question-current",
    logicalQuestionUnitRevision: 2,
    answerRevision: 3,
    sourceHash: "answer-hash",
    questionText: "Explain lines 35 through 38.",
    answerText: "I cannot see those lines.",
  };
  const sourceLinkage: SourceLinkageAdjudicationRequest = {
    schemaVersion: 1,
    promptVersion: "source-linkage-adjudication-v1",
    logicalQuestionUnitId: "question-current",
    logicalQuestionUnitRevision: 2,
    screenObservationId: "screen-a",
    sourceHash: "linkage-hash",
    voiceSourceHash: "voice-source-hash",
    sourceSettlementId: "voice-settlement",
    screenEvidenceHash: "screen-evidence-hash",
    voiceQuestion: "Explain lines 35 through 38.",
    screenQuestion: "Implement an LRU cache.",
    screenEvidenceSummary: "Lines 35 through 38 are visible.",
    activeParentObjective: "Implement an LRU cache.",
  };
  const answerSufficiency: AnswerSufficiencyAdjudicationRequest = {
    schemaVersion: 1,
    promptVersion: "answer-sufficiency-adjudication-prompt-v1",
    identity: {
      traceId: "trace-a",
      questionId: "question-a",
      logicalQuestionUnitId: "question-current",
      logicalQuestionUnitRevision: 2,
      answerRevision: 3,
    },
    questionText: "Explain the tradeoff.",
    answerText: "I need more information.",
    artifactState: { expected: ["answer"], missing: [] },
  };

  const prompts = {
    taxonomy: buildTaxonomyAdjudicationPrompts(taxonomy),
    questionType: buildQuestionTypeAdjudicationPrompts(questionType),
    responseOpportunity: buildResponseOpportunityPrompts(responseOpportunity),
    meetingMetadata: buildMeetingMetadataInferencePrompts(metadata),
    whiteboard: buildWhiteboardSyntaxRepairPrompts(whiteboard),
    taskRelation: buildTaskRelationAdjudicationPrompts(relation),
    answerResolution: buildAnswerRecoveryAdjudicationPrompts(answerRecovery),
    evidenceRequirement: buildAnswerRecoveryAdjudicationPrompts(
      buildVisualEvidenceCheckRequest({
        logicalQuestionUnitId: "question-current",
        logicalQuestionUnitRevision: 2,
        questionSourceHash: "question-source",
        questionText: "Explain lines 35 through 38.",
      })!
    ),
    sourceLinkage: buildSourceLinkageAdjudicationPrompts(sourceLinkage),
    answerSufficiency:
      buildAnswerSufficiencyAdjudicationPrompts(answerSufficiency),
  };
  const leakage = Object.fromEntries(
    Object.entries(prompts).map(([name, prompt]) => [
      name,
      findRuntimeEnvelopeLeakage(parseUserMessage(prompt.userMessage)),
    ])
  );

  for (const [name, paths] of Object.entries(leakage)) {
    assert.deepEqual(paths, [], `${name} leaked runtime envelope fields`);
  }

  for (const name of [
    "questionType",
    "taskRelation",
  ] as const) {
    assert.match(prompts[name].systemPrompt, /minified JSON object/i);
    assert.match(prompts[name].systemPrompt, /no markdown fence/i);
  }
});
