import type { AdvisorPromptContext } from "./meeting-context-contracts.js";
import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import { projectEffectiveLogicalQuestionSources } from "./logical-question-effective-projection.js";


export function applyEffectiveCurrentQuestionContext(input: {
  context: AdvisorPromptContext;
  logicalQuestionUnit: LogicalQuestionUnit;
}): AdvisorPromptContext {
  const projection = projectEffectiveLogicalQuestionSources(
    input.logicalQuestionUnit
  );
  return {
    ...input.context,
    transcript: projection.answerFocusText
      ? `Them: ${projection.answerFocusText}`
      : "",
    advisorPromptSourceTurnIds: [...projection.rawSourceTurnIds],
    screenContext: "",
    responseOnlyParentReadContext: undefined,
    taskRuntime: {
      revision: input.context.taskRuntime.revision,
      lastMutation: input.context.taskRuntime.lastMutation,
    },
    activeMeetingTask: undefined,
    rollingSummary: "",
    userProfileContext: "",
    memoryContext: undefined,
    interviewPlaybook: undefined,
    playbookPhaseDecision: undefined,
    factAnchorDecision: undefined,
    projectBindingDecision: undefined,
    openingRoute: undefined,
    confirmedMeFacts: undefined,
    responseActionContextScope: undefined,
    advisorEvidencePacket: undefined,
  };
}

export function formatEffectiveCurrentQuestionContextForTrace(input: {
  applied: boolean;
  logicalQuestionUnit?: LogicalQuestionUnit;
}) {
  return {
    effectiveCurrentQuestionContextApplied: input.applied,
    effectiveCurrentQuestionContextLogicalQuestionUnitId:
      input.logicalQuestionUnit?.id,
    effectiveCurrentQuestionContextLogicalQuestionRevision:
      input.logicalQuestionUnit?.revision,
    effectiveCurrentQuestionContextSourceTurnIds:
      input.logicalQuestionUnit?.sourceTurnIds,
  };
}
