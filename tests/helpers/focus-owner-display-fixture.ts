import type { ActiveMeetingTask } from "../../src/lib/meeting/meeting-task-contracts.js";
import type { AdvisorSuggestion, MeetingTrace } from "../../src/lib/meeting/types.js";
import { getActiveMeetingTaskTraceMetadata } from "../../src/lib/meeting/active-meeting-task.js";
import { commitStableAnswerRevision } from "../../src/lib/meeting/stable-answer.js";
import { parseMeetingAnswer } from "../../src/lib/meeting/meeting-answer.js";

export function createFocusOwnerDisplayFixture(input: {
  differentParent?: boolean;
  committedUpdate?: boolean;
  selectedChild?: boolean;
  matchingChild?: boolean;
  adviseOnly?: boolean;
} = {}) {
  const original: ActiveMeetingTask = {
    id: "parent-A", source: "voice", runtimeRevision: 1,
    parent: { id: "parent-A", questionType: "general-system-design", topic: "Selected A service design",
      playbookPhase: "requirement_clarification", phaseProgress: {}, supportedFactAnchors: [], createdAt: 1, updatedAt: 1 },
    ...(input.selectedChild ? { child: {
      id: "child-A", questionType: "coding" as const, relation: "child-probe" as const, intent: "implementation-probe" as const,
      question: "Selected A implementation", createdAt: 1, updatedAt: 1, basedOnTurnIds: ["turn-A"], basedOnObservationIds: [],
    } } : {}),
  };
  const content = "Answer: Selected A answer\nCode:\n```ts\nselected_A();\n```";
  const suggestion: AdvisorSuggestion = {
    id: "answer-A", sourceTraceId: "trace-A", kind: "answer", confidence: "high", content,
    meetingAnswer: parseMeetingAnswer(content), generationPhase: input.selectedChild ? "baseline_reasoning" : "requirement_clarification",
    taskId: "parent-A", parentTaskId: "parent-A", taskSource: "voice",
    questionType: input.adviseOnly ? "field-knowledge" : input.selectedChild ? "coding" : "general-system-design",
    questionLineage: { questionInstanceId: "question-A", questionOriginTraceId: "trace-A" },
    createdAt: 1, basedOnTurnIds: ["turn-A"], basedOnObservationIds: [],
  };
  const stable = commitStableAnswerRevision({ candidate: suggestion, authorizedArtifacts: ["answer", "code"],
    taskId: "parent-A", logicalQuestionUnitId: "lqu-A", logicalQuestionRevision: 1, sessionId: "session",
    settlementSnapshot: { relation: input.adviseOnly ? "none" : input.selectedChild ? "child-probe" : "new-parent" },
    sectionOwner: input.selectedChild ? { kind: "active-child", parentId: "parent-A", childId: "child-A" }
      : { kind: "parent-mainline", parentId: "parent-A" },
  })!;
  const activeTask: ActiveMeetingTask = {
    ...original, id: input.differentParent ? "parent-B" : "parent-A",
    parent: { ...original.parent, id: input.differentParent ? "parent-B" : "parent-A",
      questionType: input.differentParent ? "coding" : input.committedUpdate ? "ai-ml-system-design" : "general-system-design",
      playbookPhase: input.committedUpdate ? "design_framing" : "requirement_clarification" },
    child: {
      id: input.matchingChild ? "child-A" : "child-B", questionType: "coding", relation: "child-probe", intent: "implementation-probe",
      question: input.matchingChild ? "Selected A implementation" : "Background B implementation",
      createdAt: 2, updatedAt: 2, basedOnTurnIds: ["turn-B"], basedOnObservationIds: [],
      phaseState: { phase: "implementation_validation", revision: 2, phaseProgress: {}, playbook: {
        id: "coding_algorithm", label: "Coding", phase: "implementation_validation", questionType: "coding", confidence: 1,
        reason: "fixture", memoryPolicy: { id: "coding" }, firstMove: "implement", clarifyingStrategy: "constraints", outputContract: "code", followUpPolicy: "continue" },
      },
    },
  };
  const trace: MeetingTrace = { id: "trace-A", kind: "voice", status: "success", startedAt: 1, steps: [], inputs: [], outputs: [],
    metadata: { ...getActiveMeetingTaskTraceMetadata(original), effectiveCurrentQuestionSettlementQuestionType: suggestion.questionType,
      settledExecutionPlanRelation: input.adviseOnly ? "none" : input.selectedChild ? "child-probe" : "new-parent",
      settledExecutionPlanRelationApplicable: !input.adviseOnly,
      currentQuestionPreview: "Selected A service design", questionInstanceId: "question-A" },
  };
  const target = { sessionId: "session", logicalQuestionUnitId: "lqu-A", logicalQuestionRevision: 1,
    suggestionId: "answer-A", traceId: "trace-A", generationId: "answer-A", stableRevision: stable.revision };
  return {
    adviseDisplay: { locked: true, stable, target },
    meeting: { activeMeetingTask: activeTask, traces: [trace],
      latestSuggestion: { ...suggestion, id: "answer-B", sourceTraceId: "trace-B", questionType: "coding" },
      currentQuestionLineage: { questionInstanceId: "question-B" },
      phaseOutputNotice: input.adviseOnly ? "Foreign Coding child phase notice."
        : input.committedUpdate ? "Selected A: design framing output pending." : "Selected A: clarification output pending.",
    },
  };
}
