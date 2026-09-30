import type { FactAnchorDecision, MeetingAnswerProfile, WhiteboardFormatPreference } from "./types.js";
import { parseMeetingAnswer, serializeMeetingAnswer } from "./meeting-answer.js";
import { enforceFactAnchorOutput, projectFactAnchorStreamingPartial } from "./fact-anchor-output-guardrail.js";
import { applyWhiteboardFormatPolicy } from "./whiteboard-format-policy.js";
import { decideStagedAnswerPartial, projectStagedAnswerOnlyContent } from "./staged-answer-delivery.js";

/** Applies the same existing content rules to either source's authorized candidate. */
export function prepareGeneratedAnswer(input: {
  content: string;
  profile: MeetingAnswerProfile;
  factAnchorDecision: FactAnchorDecision;
  whiteboardPreference: WhiteboardFormatPreference;
}) {
  let parsedAnswer = parseMeetingAnswer(input.content, { expectedProfile: input.profile });
  const auditStartedAt = performance.now();
  const factDecision = enforceFactAnchorOutput({
    decision: input.factAnchorDecision,
    parsedAnswer,
    expectedProfile: input.profile,
  });
  let content = factDecision.effectiveContent;
  parsedAnswer = factDecision.effectiveAnswer;
  const factAuditDurationMs = performance.now() - auditStartedAt;
  const whiteboardDecision = applyWhiteboardFormatPolicy({
    whiteboard: parsedAnswer.sections.whiteboard,
    preference: input.whiteboardPreference,
  });
  if (
    whiteboardDecision.effectiveWhiteboard &&
    whiteboardDecision.effectiveWhiteboard !== parsedAnswer.sections.whiteboard
  ) {
    parsedAnswer = {
      ...parsedAnswer,
      sections: { ...parsedAnswer.sections, whiteboard: whiteboardDecision.effectiveWhiteboard },
    };
    content = serializeMeetingAnswer(parsedAnswer);
    parsedAnswer = { ...parsedAnswer, rawContent: content };
  }
  return { content, parsedAnswer, factDecision, factAuditDurationMs, whiteboardDecision };
}

export function prepareGeneratedAnswerPartial(input: {
  content: string;
  factAnchorDecision: FactAnchorDecision;
  readDelivery(content: string): Omit<Parameters<typeof decideStagedAnswerPartial>[0], "accumulated">;
}) {
  const factPartial = projectFactAnchorStreamingPartial({
    decision: input.factAnchorDecision,
    content: input.content,
  });
  const content = projectStagedAnswerOnlyContent(factPartial.visibleContent);
  const deliveryInput = input.readDelivery(content);
  const delivery = decideStagedAnswerPartial({ ...deliveryInput, accumulated: content });
  return { content, factPartial, delivery, deliveryInput };
}
