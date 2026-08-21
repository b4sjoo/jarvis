import {
  parseMeetingAnswer,
  serializeMeetingAnswer,
} from "./meeting-answer.js";
import type {
  AnswerDisposition,
  FactAnchorDecision,
  FactGuardrailVisibleNotice,
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
    | "incomplete-model-output"
    | "generation-contract-deferred"
    | "shadow-observed";
  effectiveContent: string;
  effectiveAnswer: ParsedMeetingAnswer;
  reportedDisposition?: AnswerDisposition;
  reportedAnchorIds: string[];
  unsupportedAnchorIds: string[];
  sanitizedClaimCount: number;
  preservedClaimCount: number;
  sanitizedSections: string[];
  visibleNotice?: FactGuardrailVisibleNotice;
  shadowWouldCommitSource?: Exclude<
    FactAnchorOutputCommitSource,
    "model-output"
  >;
  fallbackMode?: FactGuardrailVisibleNotice["kind"];
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
  const enforcement = enforceFactAnchorOutputInEnforcementMode({
    decision,
    parsedAnswer,
    expectedProfile,
  });
  if (!decision || decision.personalEvidence.mode !== "shadow") {
    return enforcement;
  }
  return {
    ...authorizeOriginal(parsedAnswer, "shadow-observed"),
    unsupportedAnchorIds: enforcement.unsupportedAnchorIds,
    sanitizedClaimCount: enforcement.sanitizedClaimCount,
    preservedClaimCount: enforcement.preservedClaimCount,
    sanitizedSections: enforcement.sanitizedSections,
    shadowWouldCommitSource:
      enforcement.commitSource === "model-output"
        ? undefined
        : enforcement.commitSource,
    fallbackMode: enforcement.fallbackMode,
  };
}

function enforceFactAnchorOutputInEnforcementMode({
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
    return {
      ...authorizeOriginal(parsedAnswer, "generation-contract-deferred"),
      unsupportedAnchorIds,
    };
  }

  if (
    parsedAnswer.answerDisposition === "clarification" ||
    parsedAnswer.answerDisposition === "supported-choices"
  ) {
    if (
      isSafeClarifyingDisposition(parsedAnswer, decision) &&
      unsupportedAnchorIds.length === 0
    ) {
      return authorizeOriginal(parsedAnswer, "matching-authority-contract");
    }
  }

  const unsafeClarifyingShape = Boolean(
    (parsedAnswer.answerDisposition === "clarification" ||
      parsedAnswer.answerDisposition === "supported-choices") &&
      !isSafeClarifyingDisposition(parsedAnswer, decision)
  );
  if (
    decision.state === "strong-anchor" &&
    decision.claimSupportDecisions.length === 0 &&
    unsupportedAnchorIds.length === 0 &&
    parsedAnswer.supportingAnchorIds.some((anchorId) =>
      decision.supportedAnchorIds.includes(anchorId)
    ) &&
    !unsafeClarifyingShape
  ) {
    return authorizeOriginal(parsedAnswer, "matching-authority-contract");
  }

  const hasSupportedClaimSpans = decision.claimSupportDecisions.some(
    (support) =>
      support.decision === "allow" && Boolean(support.supportSpan?.trim())
  );
  const sanitized = hasSupportedClaimSpans
    ? sanitizeAnchoredFactOutput(
      parsedAnswer,
      decision,
      expectedProfile
    )
    : sanitizeBoundedFactOutput(parsedAnswer, expectedProfile);
  if (
    sanitized.sanitizedClaimCount === 0 &&
    unsupportedAnchorIds.length === 0 &&
    !unsafeClarifyingShape
  ) {
    return authorizeOriginal(parsedAnswer, "matching-authority-contract");
  }

  const sanitizedWithFilteredAnchors = filterUnsupportedAnchorIds({
    parsedAnswer: sanitized.effectiveAnswer,
    supportedAnchorIds: decision.supportedAnchorIds,
    expectedProfile,
  });
  if (
    !unsafeClarifyingShape &&
    hasUsefulBoundedAnswer(sanitizedWithFilteredAnchors.effectiveAnswer)
  ) {
    return {
      modelOutputAuthorized: false,
      commitSource: "sanitized-model-output",
      reason: "bounded-output-sanitized",
      effectiveContent: sanitizedWithFilteredAnchors.effectiveContent,
      effectiveAnswer: sanitizedWithFilteredAnchors.effectiveAnswer,
      reportedDisposition: parsedAnswer.answerDisposition,
      reportedAnchorIds: parsedAnswer.supportingAnchorIds,
      unsupportedAnchorIds,
      sanitizedClaimCount: sanitized.sanitizedClaimCount,
      preservedClaimCount: sanitized.preservedClaimCount,
      sanitizedSections: sanitized.sanitizedSections,
    };
  }

  return buildNonRefusalFallback({
    decision,
    parsedAnswer,
    expectedProfile,
    unsupportedAnchorIds,
    sanitizedClaimCount: sanitized.sanitizedClaimCount,
    preservedClaimCount: sanitized.preservedClaimCount,
    sanitizedSections: sanitized.sanitizedSections,
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
      false,
    factAnchorShadowWouldCommitSource:
      decision.shadowWouldCommitSource,
    unsupportedFirstPersonHardClaimCount:
      decision.sanitizedClaimCount,
    sanitizedHardClaimCount: decision.sanitizedClaimCount,
    boundedSynthesisCommitCount:
      decision.commitSource === "sanitized-model-output" ? 1 : 0,
    wholeAnswerReplacementCount:
      0,
    factGuardrailNoticeShown: Boolean(decision.visibleNotice),
    factGuardrailCommitMode: decision.fallbackMode,
    factGuardrailFallbackReason: decision.visibleNotice
      ? decision.reason
      : undefined,
    factGuardrailNoticeKind: decision.visibleNotice?.kind,
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

function filterUnsupportedAnchorIds({
  parsedAnswer,
  supportedAnchorIds,
  expectedProfile,
}: {
  parsedAnswer: ParsedMeetingAnswer;
  supportedAnchorIds: string[];
  expectedProfile?: MeetingAnswerProfile;
}) {
  const allowed = new Set(supportedAnchorIds);
  const filtered = parsedAnswer.supportingAnchorIds.filter((anchorId) =>
    allowed.has(anchorId)
  );
  const answerDisposition =
    parsedAnswer.answerDisposition === "factual-with-anchor" &&
    filtered.length === 0
      ? "bounded-with-caveat"
      : parsedAnswer.answerDisposition;
  const effectiveContent = serializeMeetingAnswer({
    ...parsedAnswer,
    answerDisposition,
    supportingAnchorIds: filtered,
  });
  return {
    effectiveContent,
    effectiveAnswer: parseMeetingAnswer(effectiveContent, {
      expectedProfile,
    }),
  };
}

function buildNonRefusalFallback({
  decision,
  parsedAnswer,
  expectedProfile,
  unsupportedAnchorIds,
  sanitizedClaimCount = 0,
  preservedClaimCount = 0,
  sanitizedSections = [],
}: {
  decision: FactAnchorDecision;
  parsedAnswer: ParsedMeetingAnswer;
  expectedProfile?: MeetingAnswerProfile;
  unsupportedAnchorIds: string[];
  sanitizedClaimCount?: number;
  preservedClaimCount?: number;
  sanitizedSections?: string[];
}): FactAnchorOutputDecision {
  const supportText = decision.claimSupportDecisions
    .filter(
      (support) =>
        support.decision === "allow" && Boolean(support.supportSpan?.trim())
    )
    .map((support) => support.supportSpan?.trim())
    .filter((value): value is string => Boolean(value))
    .join(" ");
  const fallbackMode: FactGuardrailVisibleNotice["kind"] = supportText
    ? "rebuilt-from-supported-evidence"
    : "generic-hypothetical-fallback";
  const fallbackAnswer = supportText
    ? buildSupportedAnchorFallback({
        parsedAnswer,
        supportText,
        decision,
      })
    : buildGenericHypotheticalFallback(parsedAnswer, decision);
  const effectiveContent = serializeMeetingAnswer(fallbackAnswer);
  const visibleNotice: FactGuardrailVisibleNotice = {
    kind: fallbackMode,
    message:
      fallbackMode === "rebuilt-from-supported-evidence"
        ? "事实护栏已重建回答：原始回答中的个人或项目事实缺少足够证据。以下内容仅基于已验证事实与明确假设。"
        : "事实证据不足：以下为通用或假设性回答，请勿作为真实个人经历逐字陈述。",
  };

  return {
    modelOutputAuthorized: false,
    commitSource: "sanitized-model-output",
    reason: "bounded-output-sanitized",
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
    visibleNotice,
    fallbackMode,
  };
}

function buildGenericHypotheticalFallback(
  parsedAnswer: ParsedMeetingAnswer,
  decision: FactAnchorDecision
): ParsedMeetingAnswer {
  const closestEvidence = decision.supportedAnchorTitles[0];
  return {
    ...parsedAnswer,
    sections: {
      ...parsedAnswer.sections,
      chineseThinking:
        "当前证据不足以支持原始第一人称细节；保留通用方法，并把未验证内容明确降为假设。",
      answer: closestEvidence
        ? `The closest verified example is ${closestEvidence}. I would use only its confirmed context, actions, and outcomes, and present any additional mechanism as a hypothetical improvement rather than as something already implemented.`
        : "I would answer this as a hypothetical approach: state the relevant constraint, explain the decision and tradeoff, and separate the proposed mechanism from any unverified personal experience or result.",
      approach:
        "Use verified facts where available; otherwise keep recommendations explicitly hypothetical and avoid unsupported ownership, metrics, third-party positions, or implementation claims.",
      clarifyingQuestion: undefined,
      clarifyingOptions: [],
    },
    answerDisposition: "bounded-with-caveat" as AnswerDisposition,
    supportingAnchorIds: [],
  };
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

function sanitizeAnchoredFactOutput(
  parsedAnswer: ParsedMeetingAnswer,
  decision: FactAnchorDecision,
  expectedProfile: MeetingAnswerProfile | undefined
) {
  const supportDecisions = decision.claimSupportDecisions.filter(
    (item) =>
      item.decision === "allow" &&
      item.supportSpan?.trim()
  );
  if (!supportDecisions.length) {
    return {
      effectiveContent: parsedAnswer.rawContent,
      effectiveAnswer: parsedAnswer,
      sanitizedClaimCount: 0,
      preservedClaimCount: 0,
      sanitizedSections: [] as string[],
    };
  }

  const supportText = supportDecisions
    .map((item) => item.supportSpan)
    .filter((value): value is string => Boolean(value))
    .join(" ");
  const sections = {
    ...parsedAnswer.sections,
    clarifyingOptions: [...parsedAnswer.sections.clarifyingOptions],
  };
  let sanitizedClaimCount = 0;
  let preservedClaimCount = 0;
  const sanitizedSections: string[] = [];

  for (const section of ["chineseThinking", "answer", "approach"] as const) {
    const result = sanitizeAnchoredClaimSection(
      sections[section],
      supportText
    );
    sections[section] = result.text || undefined;
    sanitizedClaimCount += result.removed;
    preservedClaimCount += result.preserved;
    if (result.removed > 0) sanitizedSections.push(section);
  }

  const sanitizedAnswer: ParsedMeetingAnswer = {
    ...parsedAnswer,
    sections,
    supportingAnchorIds: parsedAnswer.supportingAnchorIds.filter(
      (anchorId) => decision.supportedAnchorIds.includes(anchorId)
    ),
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

function sanitizeAnchoredClaimSection(
  value: string | undefined,
  supportText: string
) {
  if (!value?.trim()) {
    return { text: "", removed: 0, preserved: 0 };
  }

  let removed = 0;
  let preserved = 0;
  const lines = value
    .split(/\n+/)
    .map((line) => {
      const units = line.match(/[^.!?。！？]+[.!?。！？]?/gu) ?? [line];
      const kept = units.filter((unit) => {
        if (isUnsupportedAnchoredPersonalClaim(unit, supportText)) {
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

function isUnsupportedAnchoredPersonalClaim(
  value: string,
  supportText: string
) {
  const text = value.trim();
  if (!FIRST_PERSON_PATTERN.test(text)) return false;
  if (
    HYPOTHETICAL_FIRST_PERSON_PATTERN.test(text) ||
    HYPOTHETICAL_FIRST_PERSON_CHINESE_PATTERN.test(text)
  ) {
    return false;
  }

  const normalizedClaim = normalizeClaimEvidence(text);
  const normalizedSupport = normalizeClaimEvidence(supportText);
  if (!normalizedClaim || !normalizedSupport) return false;

  const numbers = normalizedClaim.match(/\b\d[\d,.]*\b/g) ?? [];
  if (numbers.some((number) => !normalizedSupport.includes(number))) {
    return true;
  }

  const hasUnsupportedRole =
    HIGH_AUTHORITY_ROLE_PATTERN.test(text) &&
    !HIGH_AUTHORITY_ROLE_PATTERN.test(supportText);
  if (hasUnsupportedRole) return true;

  const highRiskShape =
    THIRD_PARTY_STANCE_PATTERN.test(text) ||
    ABSOLUTE_RESULT_PATTERN.test(text) ||
    SPECIFIC_MECHANISM_PATTERN.test(text);
  if (!highRiskShape) return false;

  const claimTokens = extractDistinctiveClaimTokens(normalizedClaim);
  if (!claimTokens.length) return false;
  const supportedCount = claimTokens.filter((token) =>
    normalizedSupport.includes(token)
  ).length;
  const requiredCoverage = claimTokens.length <= 3 ? 1 : 0.55;
  return supportedCount / claimTokens.length < requiredCoverage;
}

function buildSupportedAnchorFallback({
  parsedAnswer,
  supportText,
  decision,
}: {
  parsedAnswer: ParsedMeetingAnswer;
  supportText: string;
  decision: FactAnchorDecision;
}): ParsedMeetingAnswer {
  const compactSupport = supportText.replace(/\s+/g, " ").trim();
  return {
    ...parsedAnswer,
    sections: {
      ...parsedAnswer.sections,
      chineseThinking: "仅保留当前证据直接支持的事实。",
      answer: compactSupport,
      approach: undefined,
      clarifyingQuestion: undefined,
      clarifyingOptions: [],
    },
    answerDisposition: "factual-with-anchor",
    supportingAnchorIds: parsedAnswer.supportingAnchorIds.filter(
      (anchorId) => decision.supportedAnchorIds.includes(anchorId)
    ),
  };
}

function extractDistinctiveClaimTokens(value: string) {
  return Array.from(
    new Set(
      value
        .split(" ")
        .filter((token) => token.length >= 4)
        .filter((token) => !CLAIM_SUPPORT_STOP_WORDS.has(token))
    )
  );
}

function normalizeClaimEvidence(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.,]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
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
const HIGH_AUTHORITY_ROLE_PATTERN =
  /\b(?:i|we)\s+(?:personally\s+)?(?:led|owned|drove|managed|directed)|\b(?:my|our)\s+(?:ownership|leadership|responsibility)\b/i;
const THIRD_PARTY_STANCE_PATTERN =
  /\b(?:teammate|colleague|manager|stakeholder|partner|team)\b.{0,90}\b(?:wanted|argued|insisted|pushed|refused|opposed|preferred|believed|disagreed)\b/i;
const ABSOLUTE_RESULT_PATTERN =
  /\b(?:zero|none|never|always|all|every|without any|no)\b.{0,50}\b(?:downtime|loss|errors?|failures?|regressions?|incidents?|issues?|impact|gap)\b|\b100\s*%/i;
const SPECIFIC_MECHANISM_PATTERN =
  /\b(?:i|we)\b.{0,50}\b(?:implemented|built|designed|used|chose|deployed|routed|added|introduced|configured)\b.{0,120}\b(?:using|with|via|through|by|into|to)\b/i;
const CLAIM_SUPPORT_STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "because",
  "before",
  "built",
  "chose",
  "could",
  "designed",
  "during",
  "implemented",
  "introduced",
  "personally",
  "project",
  "routed",
  "system",
  "their",
  "there",
  "these",
  "those",
  "through",
  "using",
  "would",
]);

function normalizeChoice(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
