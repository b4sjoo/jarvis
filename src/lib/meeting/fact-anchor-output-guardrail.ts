import {
  parseMeetingAnswer,
  serializeMeetingAnswer,
} from "./meeting-answer.js";
import type {
  AnswerDisposition,
  FactAnchorDecision,
  MeetingAnswerProfile,
  ParsedMeetingAnswer,
} from "./types.js";

export type FactAnchorOutputCommitSource =
  | "model-output"
  | "sanitized-model-output"
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
    | "bounded-output-sanitized"
    | "incomplete-model-output";
  effectiveContent: string;
  effectiveAnswer: ParsedMeetingAnswer;
  reportedDisposition?: AnswerDisposition;
  reportedAnchorIds: string[];
  unsupportedAnchorIds: string[];
  sanitizedClaimCount: number;
  preservedClaimCount: number;
  sanitizedSections: string[];
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

  if (
    decision.state === "weak-anchor" &&
    decision.action === "answer-with-caveats" &&
    parsedAnswer.answerDisposition === "bounded-with-caveat"
  ) {
    const sanitized = sanitizeBoundedFactOutput(
      parsedAnswer,
      expectedProfile
    );
    if (
      sanitized.sanitizedClaimCount === 0 &&
      unsupportedAnchorIds.length === 0
    ) {
      return authorizeOriginal(
        parsedAnswer,
        "matching-authority-contract"
      );
    }
    if (hasUsefulBoundedAnswer(sanitized.effectiveAnswer)) {
      return {
        modelOutputAuthorized: false,
        commitSource: "sanitized-model-output",
        reason: "bounded-output-sanitized",
        effectiveContent: sanitized.effectiveContent,
        effectiveAnswer: sanitized.effectiveAnswer,
        reportedDisposition: parsedAnswer.answerDisposition,
        reportedAnchorIds: parsedAnswer.supportingAnchorIds,
        unsupportedAnchorIds,
        sanitizedClaimCount: sanitized.sanitizedClaimCount,
        preservedClaimCount: sanitized.preservedClaimCount,
        sanitizedSections: sanitized.sanitizedSections,
      };
    }
    return replaceWithSafeClarification({
      decision,
      parsedAnswer,
      expectedProfile,
      reason: "unsafe-unanchored-first-person-claim",
      unsupportedAnchorIds,
      sanitizedClaimCount: sanitized.sanitizedClaimCount,
      preservedClaimCount: sanitized.preservedClaimCount,
      sanitizedSections: sanitized.sanitizedSections,
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
    factAnchorClaimSanitizationApplied:
      decision.commitSource === "sanitized-model-output",
    factAnchorSanitizedClaimCount: decision.sanitizedClaimCount,
    factAnchorPreservedClaimCount: decision.preservedClaimCount,
    factAnchorSanitizedSections: decision.sanitizedSections,
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
    sanitizedClaimCount: 0,
    preservedClaimCount: 0,
    sanitizedSections: [],
  };
}

function replaceWithSafeClarification({
  decision,
  parsedAnswer,
  expectedProfile,
  reason,
  unsupportedAnchorIds,
  sanitizedClaimCount = 0,
  preservedClaimCount = 0,
  sanitizedSections = [],
}: {
  decision: FactAnchorDecision;
  parsedAnswer: ParsedMeetingAnswer;
  expectedProfile?: MeetingAnswerProfile;
  reason: FactAnchorOutputDecision["reason"];
  unsupportedAnchorIds: string[];
  sanitizedClaimCount?: number;
  preservedClaimCount?: number;
  sanitizedSections?: string[];
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
    sanitizedClaimCount,
    preservedClaimCount,
    sanitizedSections,
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

function sanitizeBoundedFactOutput(
  parsedAnswer: ParsedMeetingAnswer,
  expectedProfile: MeetingAnswerProfile | undefined
) {
  const sections = {
    ...parsedAnswer.sections,
    clarifyingOptions: [...parsedAnswer.sections.clarifyingOptions],
  };
  let sanitizedClaimCount = 0;
  let preservedClaimCount = 0;
  const sanitizedSections: string[] = [];

  for (const section of ["chineseThinking", "answer", "approach"] as const) {
    const result = sanitizeBoundedClaimSection(sections[section]);
    sections[section] = result.text || undefined;
    sanitizedClaimCount += result.removed;
    preservedClaimCount += result.preserved;
    if (result.removed > 0) sanitizedSections.push(section);
  }

  const sanitizedAnswer: ParsedMeetingAnswer = {
    ...parsedAnswer,
    sections,
    supportingAnchorIds: [],
  };
  const effectiveContent = serializeMeetingAnswer(sanitizedAnswer);
  return {
    effectiveContent,
    effectiveAnswer: parseMeetingAnswer(effectiveContent, {
      expectedProfile,
    }),
    sanitizedClaimCount,
    preservedClaimCount,
    sanitizedSections,
  };
}

function sanitizeBoundedClaimSection(value: string | undefined) {
  if (!value?.trim()) {
    return { text: "", removed: 0, preserved: 0 };
  }

  let removed = 0;
  let preserved = 0;
  const lines = value
    .split(/\n+/)
    .map((line) => {
      const units =
        line.match(/[^.!?。！？]+[.!?。！？]?/gu) ?? [line];
      const kept = units.filter((unit) => {
        if (isUnsupportedPersonalClaim(unit)) {
          removed += 1;
          return false;
        }
        if (unit.trim()) preserved += 1;
        return Boolean(unit.trim());
      });
      return kept.join(" ").trim();
    })
    .filter(Boolean);

  return { text: lines.join("\n"), removed, preserved };
}

function isUnsupportedPersonalClaim(value: string) {
  const text = value.trim();
  if (!FIRST_PERSON_PATTERN.test(text)) return false;

  const clearlyHypothetical =
    HYPOTHETICAL_FIRST_PERSON_PATTERN.test(text) ||
    HYPOTHETICAL_FIRST_PERSON_CHINESE_PATTERN.test(text);
  const hardPersonalFact =
    HARD_PERSONAL_FACT_PATTERN.test(text) ||
    HARD_PERSONAL_FACT_CHINESE_PATTERN.test(text);
  const quantitativeClaim = /(?:[$%]|\b\d[\d,.]*\b)/.test(text);

  if (clearlyHypothetical && !quantitativeClaim) return false;

  return hardPersonalFact || quantitativeClaim || !clearlyHypothetical;
}

function hasUsefulBoundedAnswer(parsedAnswer: ParsedMeetingAnswer) {
  return Boolean(
    parsedAnswer.sections.answer ||
      parsedAnswer.sections.approach ||
      parsedAnswer.sections.clarifyingQuestion
  );
}

const FIRST_PERSON_PATTERN =
  /\b(?:i|i'm|i've|i'd|my|me|mine|we|we're|we've|our|ours)\b|我|我们/i;
const HYPOTHETICAL_FIRST_PERSON_PATTERN =
  /\b(?:i|we)\s+(?:would|could|can|should|might|recommend|suggest|propose|start|focus|frame)\b|\bi'd\s+(?:start|focus|frame|recommend|suggest|propose)\b/i;
const HYPOTHETICAL_FIRST_PERSON_CHINESE_PATTERN =
  /(?:我|我们)(?:会|可以|应该|建议|倾向于|将会|打算)/u;
const HARD_PERSONAL_FACT_PATTERN =
  /\b(?:i|we|my|our)\b.{0,90}\b(?:built|designed|implemented|developed|led|owned|delivered|deployed|launched|used|chose|selected|measured|validated|tested|debugged|fixed|reduced|improved|achieved|saved|collaborated|worked|created|migrated|operated|monitored|decided|responsible)\b|\b(?:my|our)\s+(?:team|project|system|service|role|contribution)\b/i;
const HARD_PERSONAL_FACT_CHINESE_PATTERN =
  /(?:我|我们|我的|我们的).{0,80}(?:构建|设计|实现|开发|领导|负责|主导|交付|部署|上线|使用|选择|测量|验证|测试|调试|修复|减少|提升|完成|节省|合作|迁移|运维|监控|决定)|(?:我的|我们的)(?:角色|贡献|团队|项目|系统|服务)/u;

function normalizeChoice(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
