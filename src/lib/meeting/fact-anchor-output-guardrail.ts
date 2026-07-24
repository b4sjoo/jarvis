import { parseMeetingAnswer } from "./meeting-answer.js";
import type {
  AnswerDisposition,
  FactAnchorDecision,
  MeetingAnswerProfile,
  ParsedMeetingAnswer,
} from "./types.js";

export type FactAnchorOutputCommitSource =
  | "model-output"
  | "safe-replacement";

export interface FactAnchorOutputDecision {
  modelOutputAuthorized: boolean;
  commitSource: FactAnchorOutputCommitSource;
  reason:
    | "fact-anchor-not-required"
    | "matching-authority-contract"
    | "missing-answer-disposition"
    | "missing-supporting-anchor"
    | "unsupported-anchor-id"
    | "disposition-mismatch"
    | "unsafe-clarification-shape"
    | "unsafe-unanchored-first-person-claim"
    | "incomplete-model-output";
  effectiveContent: string;
  effectiveAnswer: ParsedMeetingAnswer;
  reportedDisposition?: AnswerDisposition;
  reportedAnchorIds: string[];
  unsupportedAnchorIds: string[];
}

export function enforceFactAnchorOutput({
  decision,
  parsedAnswer,
  expectedProfile,
}: {
  decision: FactAnchorDecision | undefined;
  parsedAnswer: ParsedMeetingAnswer;
  expectedProfile?: MeetingAnswerProfile;
}): FactAnchorOutputDecision {
  if (!decision || decision.requiredFor === "none") {
    return authorizeOriginal(
      parsedAnswer,
      "fact-anchor-not-required"
    );
  }

  const unsupportedAnchorIds = parsedAnswer.supportingAnchorIds.filter(
    (anchorId) => !decision.supportedAnchorIds.includes(anchorId)
  );
  if (
    parsedAnswer.parseStatus === "empty" ||
    parsedAnswer.parseStatus === "partial"
  ) {
    return replaceWithSafeClarification({
      decision,
      parsedAnswer,
      expectedProfile,
      reason: "incomplete-model-output",
      unsupportedAnchorIds,
    });
  }
  if (!parsedAnswer.answerDisposition) {
    return replaceWithSafeClarification({
      decision,
      parsedAnswer,
      expectedProfile,
      reason: "missing-answer-disposition",
      unsupportedAnchorIds,
    });
  }
  if (unsupportedAnchorIds.length > 0) {
    return replaceWithSafeClarification({
      decision,
      parsedAnswer,
      expectedProfile,
      reason: "unsupported-anchor-id",
      unsupportedAnchorIds,
    });
  }

  if (
    parsedAnswer.answerDisposition === "clarification" ||
    parsedAnswer.answerDisposition === "supported-choices"
  ) {
    if (isSafeClarifyingDisposition(parsedAnswer, decision)) {
      return authorizeOriginal(parsedAnswer, "matching-authority-contract");
    }
    return replaceWithSafeClarification({
      decision,
      parsedAnswer,
      expectedProfile,
      reason: "unsafe-clarification-shape",
      unsupportedAnchorIds,
    });
  }

  if (
    decision.state === "strong-anchor" &&
    parsedAnswer.answerDisposition === "factual-with-anchor"
  ) {
    if (parsedAnswer.supportingAnchorIds.length === 0) {
      return replaceWithSafeClarification({
        decision,
        parsedAnswer,
        expectedProfile,
        reason: "missing-supporting-anchor",
        unsupportedAnchorIds,
      });
    }
    return authorizeOriginal(parsedAnswer, "matching-authority-contract");
  }

  if (
    decision.state === "weak-anchor" &&
    decision.action === "answer-with-caveats" &&
    parsedAnswer.answerDisposition === "bounded-with-caveat"
  ) {
    if (containsFirstPersonClaim(parsedAnswer)) {
      return replaceWithSafeClarification({
        decision,
        parsedAnswer,
        expectedProfile,
        reason: "unsafe-unanchored-first-person-claim",
        unsupportedAnchorIds,
      });
    }
    return authorizeOriginal(parsedAnswer, "matching-authority-contract");
  }

  return replaceWithSafeClarification({
    decision,
    parsedAnswer,
    expectedProfile,
    reason: "disposition-mismatch",
    unsupportedAnchorIds,
  });
}

export function formatFactAnchorOutputDecisionForTrace(
  decision: FactAnchorOutputDecision,
  options: { partialOutputHeld?: boolean } = {}
): Record<string, unknown> {
  return {
    factAnchorOutputCommitSource: decision.commitSource,
    factAnchorModelOutputAuthorized: decision.modelOutputAuthorized,
    factAnchorOutputReason: decision.reason,
    factAnchorReportedDisposition: decision.reportedDisposition,
    factAnchorReportedIds: decision.reportedAnchorIds,
    factAnchorUnsupportedIds: decision.unsupportedAnchorIds,
    factAnchorSafeReplacement:
      decision.commitSource === "safe-replacement",
    factAnchorPartialOutputHeld: options.partialOutputHeld ?? false,
  };
}

function authorizeOriginal(
  parsedAnswer: ParsedMeetingAnswer,
  reason: FactAnchorOutputDecision["reason"]
): FactAnchorOutputDecision {
  return {
    modelOutputAuthorized: true,
    commitSource: "model-output",
    reason,
    effectiveContent: parsedAnswer.rawContent,
    effectiveAnswer: parsedAnswer,
    reportedDisposition: parsedAnswer.answerDisposition,
    reportedAnchorIds: parsedAnswer.supportingAnchorIds,
    unsupportedAnchorIds: [],
  };
}

function replaceWithSafeClarification({
  decision,
  parsedAnswer,
  expectedProfile,
  reason,
  unsupportedAnchorIds,
}: {
  decision: FactAnchorDecision;
  parsedAnswer: ParsedMeetingAnswer;
  expectedProfile?: MeetingAnswerProfile;
  reason: FactAnchorOutputDecision["reason"];
  unsupportedAnchorIds: string[];
}): FactAnchorOutputDecision {
  const hasVerifiedChoices =
    decision.action === "offer-supported-choices" &&
    decision.state === "weak-anchor" &&
    decision.supportedAnchorTitles.length > 0;
  const disposition: AnswerDisposition = hasVerifiedChoices
    ? "supported-choices"
    : "clarification";
  const clarifyingQuestion = buildSafeClarifyingQuestion(decision);
  const clarifyingOptions = hasVerifiedChoices
    ? decision.supportedAnchorTitles.join(" | ")
    : "-";
  const effectiveContent = [
    "中文思路: 当前生成结果没有通过事实锚点校验。先澄清可验证的经历或个人事实，避免编造。",
    "Answer: -",
    `Clarifying question: ${clarifyingQuestion}`,
    `Clarifying options: ${clarifyingOptions}`,
    `Answer disposition: ${disposition}`,
    "Supporting anchor IDs: -",
  ].join("\n");

  return {
    modelOutputAuthorized: false,
    commitSource: "safe-replacement",
    reason,
    effectiveContent,
    effectiveAnswer: parseMeetingAnswer(effectiveContent, {
      expectedProfile,
    }),
    reportedDisposition: parsedAnswer.answerDisposition,
    reportedAnchorIds: parsedAnswer.supportingAnchorIds,
    unsupportedAnchorIds,
  };
}

function buildSafeClarifyingQuestion(decision: FactAnchorDecision) {
  if (decision.requiredFor === "personal-logistics") {
    return "Could you confirm the relevant personal detail before I answer?";
  }
  if (decision.requiredFor === "behavioral") {
    return "Which verified experience should I use for this answer?";
  }
  return "Which verified project should I use for this answer?";
}

function isSafeClarifyingDisposition(
  parsedAnswer: ParsedMeetingAnswer,
  decision: FactAnchorDecision
) {
  if (
    parsedAnswer.answerDisposition !== "clarification" &&
    parsedAnswer.answerDisposition !== "supported-choices"
  ) {
    return false;
  }
  if (!parsedAnswer.sections.clarifyingQuestion) return false;
  if (hasSubstantiveAnswerSections(parsedAnswer)) return false;

  if (parsedAnswer.answerDisposition === "supported-choices") {
    if (
      decision.action !== "offer-supported-choices" ||
      decision.state !== "weak-anchor" ||
      parsedAnswer.sections.clarifyingOptions.length === 0
    ) {
      return false;
    }
    const allowedTitles = new Set(
      decision.supportedAnchorTitles.map(normalizeChoice)
    );
    return parsedAnswer.sections.clarifyingOptions.every((option) =>
      allowedTitles.has(normalizeChoice(option.label))
    );
  }

  return true;
}

function hasSubstantiveAnswerSections(parsedAnswer: ParsedMeetingAnswer) {
  return Boolean(
    parsedAnswer.sections.answer ||
      parsedAnswer.sections.approach ||
      parsedAnswer.sections.whiteboard ||
      parsedAnswer.sections.code ||
      parsedAnswer.sections.complexity
  );
}

function containsFirstPersonClaim(parsedAnswer: ParsedMeetingAnswer) {
  const text = [
    parsedAnswer.sections.answer,
    parsedAnswer.sections.approach,
  ]
    .filter(Boolean)
    .join(" ");
  return /\b(?:i|i'm|i've|i'd|my|me|mine|we|we're|we've|our|ours)\b|我|我们/i.test(
    text
  );
}

function normalizeChoice(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
