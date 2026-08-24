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
  bilingualClaimSetCoherent: boolean;
  hypotheticalOnlyAfterSanitize: boolean;
  boundaryClaimPreservedCount: number;
  visibleNotice?: FactGuardrailVisibleNotice;
  shadowWouldCommitSource?: Exclude<
    FactAnchorOutputCommitSource,
    "model-output"
  >;
  fallbackMode?: FactGuardrailVisibleNotice["kind"];
}

export interface FactAnchorStreamingPartialDecision {
  visibleContent: string;
  bufferingEnabled: boolean;
  heldTrailingChars: number;
  sanitizedClaimCount: number;
  artifactBoundaryHeld: boolean;
}

export function shouldBufferFactAnchorStreaming(
  decision: FactAnchorDecision | undefined
) {
  return Boolean(
    decision &&
      decision.requiredFor !== "none" &&
      decision.personalEvidence.mode === "enforcement"
  );
}

export function projectFactAnchorStreamingPartial(input: {
  decision: FactAnchorDecision | undefined;
  content: string;
}): FactAnchorStreamingPartialDecision {
  if (!shouldBufferFactAnchorStreaming(input.decision)) {
    return {
      visibleContent: input.content,
      bufferingEnabled: false,
      heldTrailingChars: 0,
      sanitizedClaimCount: 0,
      artifactBoundaryHeld: false,
    };
  }

  const artifactBoundary = findArtifactSectionBoundary(input.content);
  const answerOnlyContent =
    artifactBoundary >= 0
      ? input.content.slice(0, artifactBoundary)
      : input.content;
  const completedBoundary = findCompletedSentenceBoundary(answerOnlyContent);
  if (completedBoundary <= 0) {
    return {
      visibleContent: "",
      bufferingEnabled: true,
      heldTrailingChars: input.content.length,
      sanitizedClaimCount: 0,
      artifactBoundaryHeld: artifactBoundary >= 0,
    };
  }

  const completedContent = answerOnlyContent.slice(0, completedBoundary);
  const supportSpans = collectSelectedSupportSpans(input.decision!);
  const sanitized = sanitizeCompletedStreamingText(
    completedContent,
    supportSpans
  );
  return {
    visibleContent: sanitized.text,
    bufferingEnabled: true,
    heldTrailingChars: input.content.length - completedBoundary,
    sanitizedClaimCount: sanitized.removed,
    artifactBoundaryHeld: artifactBoundary >= 0,
  };
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
      isOutputSupportSpan(support)
  );
  const sanitized = hasSupportedClaimSpans
    ? sanitizeAnchoredFactOutput(
      parsedAnswer,
      decision,
      expectedProfile
    )
    : sanitizeBoundedFactOutput(parsedAnswer, expectedProfile);
  const initialBilingualCoherence =
    hasCoherentBilingualBoundaryClaims(sanitized.effectiveAnswer);
  if (
    sanitized.sanitizedClaimCount === 0 &&
    unsupportedAnchorIds.length === 0 &&
    !unsafeClarifyingShape &&
    initialBilingualCoherence
  ) {
    return {
      ...authorizeOriginal(parsedAnswer, "matching-authority-contract"),
      bilingualClaimSetCoherent: true,
      boundaryClaimPreservedCount:
        sanitized.boundaryClaimPreservedCount,
    };
  }

  const hypotheticalOnlyAfterSanitize = Boolean(
    hasSupportedClaimSpans &&
      isHypotheticalOnlyAnswer(sanitized.effectiveAnswer)
  );
  const bilingualCoherentBeforeRebuild = initialBilingualCoherence;
  const effectiveClaimAnswer =
    hasSupportedClaimSpans &&
    (!bilingualCoherentBeforeRebuild || hypotheticalOnlyAfterSanitize)
      ? rebuildCoherentBilingualClaimSet({
          parsedAnswer: sanitized.effectiveAnswer,
          decision,
        })
      : sanitized.effectiveAnswer;
  const sanitizedWithFilteredAnchors = filterUnsupportedAnchorIds({
    parsedAnswer: effectiveClaimAnswer,
    supportedAnchorIds: decision.supportedAnchorIds,
    expectedProfile,
  });
  if (
    !unsafeClarifyingShape &&
    hasUsefulBoundedAnswer(sanitizedWithFilteredAnchors.effectiveAnswer) &&
    !hypotheticalOnlyAfterSanitize
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
      bilingualClaimSetCoherent: hasCoherentBilingualBoundaryClaims(
        sanitizedWithFilteredAnchors.effectiveAnswer
      ),
      hypotheticalOnlyAfterSanitize,
      boundaryClaimPreservedCount:
        sanitized.boundaryClaimPreservedCount,
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
    bilingualClaimSetCoherent: hasCoherentBilingualBoundaryClaims(
      effectiveClaimAnswer
    ),
    hypotheticalOnlyAfterSanitize,
    boundaryClaimPreservedCount:
      sanitized.boundaryClaimPreservedCount,
  });
}

export function formatFactAnchorOutputDecisionForTrace(
  decision: FactAnchorOutputDecision,
  options: {
    partialOutputHeld?: boolean;
    auditDurationMs?: number;
  } = {}
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
    factAnchorBilingualClaimSetCoherent:
      decision.bilingualClaimSetCoherent,
    factAnchorHypotheticalOnlyAfterSanitize:
      decision.hypotheticalOnlyAfterSanitize,
    factAnchorBoundaryClaimPreservedCount:
      decision.boundaryClaimPreservedCount,
    factAnchorClarifyingQuestionSanitized:
      decision.sanitizedSections.includes("clarifyingQuestion"),
    factAnchorClarifyingOptionsSanitized:
      decision.sanitizedSections.includes("clarifyingOptions"),
    factAnchorEffectiveClarifyingOptionCount:
      decision.effectiveAnswer.sections.clarifyingOptions.length,
    factAnchorSafeReplacement:
      false,
    factAnchorShadowWouldCommitSource:
      decision.shadowWouldCommitSource,
    unsupportedFirstPersonHardClaimCount:
      decision.sanitizedClaimCount,
    unsupportedAssertiveFactClaimCount:
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
    factAnchorOutputAuditDurationMs: options.auditDurationMs,
    factAnchorOutputAuditBudgetExceeded: Boolean(
      options.auditDurationMs !== undefined &&
        options.auditDurationMs > 25
    ),
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
    bilingualClaimSetCoherent: true,
    hypotheticalOnlyAfterSanitize: false,
    boundaryClaimPreservedCount: 0,
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
  bilingualClaimSetCoherent = true,
  hypotheticalOnlyAfterSanitize = false,
  boundaryClaimPreservedCount = 0,
}: {
  decision: FactAnchorDecision;
  parsedAnswer: ParsedMeetingAnswer;
  expectedProfile?: MeetingAnswerProfile;
  unsupportedAnchorIds: string[];
  sanitizedClaimCount?: number;
  preservedClaimCount?: number;
  sanitizedSections?: string[];
  bilingualClaimSetCoherent?: boolean;
  hypotheticalOnlyAfterSanitize?: boolean;
  boundaryClaimPreservedCount?: number;
}): FactAnchorOutputDecision {
  const supportText = [
    ...new Set(collectSelectedSupportSpans(decision)),
  ]
    .join(" ")
    .slice(0, 1_200);
  const fallbackMode: FactGuardrailVisibleNotice["kind"] = supportText
    ? "rebuilt-from-supported-evidence"
    : "generic-hypothetical-fallback";
  const fallbackAnswer = supportText
    ? hypotheticalOnlyAfterSanitize
      ? rebuildCoherentBilingualClaimSet({ parsedAnswer, decision })
      : buildSupportedAnchorFallback({
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
    bilingualClaimSetCoherent,
    hypotheticalOnlyAfterSanitize,
    boundaryClaimPreservedCount,
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
  const clarification = sanitizeClarifyingSections({
    question: sections.clarifyingQuestion,
    options: sections.clarifyingOptions,
    supportSpans: [],
  });
  sections.clarifyingQuestion = clarification.question;
  sections.clarifyingOptions = clarification.options;
  sanitizedClaimCount += clarification.removed;
  preservedClaimCount += clarification.preserved;
  sanitizedSections.push(...clarification.sanitizedSections);

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
    boundaryClaimPreservedCount: 0,
  };
}

function sanitizeAnchoredFactOutput(
  parsedAnswer: ParsedMeetingAnswer,
  decision: FactAnchorDecision,
  expectedProfile: MeetingAnswerProfile | undefined
) {
  const eligibleSupportDecisions = decision.claimSupportDecisions.filter(
    isOutputSupportSpan
  );
  const eligibleAnchorIds = new Set(
    eligibleSupportDecisions
      .map((item) => item.anchorId)
      .filter((value): value is string => Boolean(value))
  );
  const reportedSupportedAnchorIds = parsedAnswer.supportingAnchorIds.filter(
    (anchorId) => eligibleAnchorIds.has(anchorId)
  );
  const selectedAnchorIds = new Set(
    reportedSupportedAnchorIds.length
      ? reportedSupportedAnchorIds
      : decision.selectedAnchorId
        ? [decision.selectedAnchorId]
        : [...eligibleAnchorIds]
  );
  const supportDecisions = eligibleSupportDecisions.filter(
    (item) =>
      (!item.anchorId || selectedAnchorIds.has(item.anchorId))
  );
  if (!supportDecisions.length) {
    return {
      effectiveContent: parsedAnswer.rawContent,
      effectiveAnswer: parsedAnswer,
      sanitizedClaimCount: 0,
      preservedClaimCount: 0,
      sanitizedSections: [] as string[],
      boundaryClaimPreservedCount: 0,
    };
  }

  const supportSpans = supportDecisions
    .map((item) => item.supportSpan)
    .filter((value): value is string => Boolean(value));
  const sections = {
    ...parsedAnswer.sections,
    clarifyingOptions: [...parsedAnswer.sections.clarifyingOptions],
  };
  let sanitizedClaimCount = 0;
  let preservedClaimCount = 0;
  let boundaryClaimPreservedCount = 0;
  const sanitizedSections: string[] = [];

  for (const section of ["chineseThinking", "answer", "approach"] as const) {
    const result = sanitizeAnchoredClaimSection(
      sections[section],
      supportSpans
    );
    sections[section] = result.text || undefined;
    sanitizedClaimCount += result.removed;
    preservedClaimCount += result.preserved;
    boundaryClaimPreservedCount += result.boundaryPreserved;
    if (result.removed > 0) sanitizedSections.push(section);
  }
  const clarification = sanitizeClarifyingSections({
    question: sections.clarifyingQuestion,
    options: sections.clarifyingOptions,
    supportSpans,
  });
  sections.clarifyingQuestion = clarification.question;
  sections.clarifyingOptions = clarification.options;
  sanitizedClaimCount += clarification.removed;
  preservedClaimCount += clarification.preserved;
  sanitizedSections.push(...clarification.sanitizedSections);

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
    boundaryClaimPreservedCount,
  };
}

function collectSelectedSupportSpans(decision: FactAnchorDecision) {
  const eligible = decision.claimSupportDecisions.filter(
    isOutputSupportSpan
  );
  const eligibleAnchorIds = new Set(
    eligible
      .map((item) => item.anchorId)
      .filter((value): value is string => Boolean(value))
  );
  const selectedAnchorIds = new Set(
    decision.selectedAnchorId
      ? [decision.selectedAnchorId]
      : decision.supportedAnchorIds.length
        ? decision.supportedAnchorIds
        : [...eligibleAnchorIds]
  );
  return eligible
    .filter(
      (item) =>
        (!item.anchorId || selectedAnchorIds.has(item.anchorId))
    )
    .map((item) => item.supportSpan?.trim())
    .filter((value): value is string => Boolean(value));
}

function isOutputSupportSpan(
  item: FactAnchorDecision["claimSupportDecisions"][number]
) {
  return Boolean(
    item.supportSpan?.trim() &&
      (item.decision === "allow" ||
        (item.supportScope === "anchor-evidence" &&
          item.decision === "needs-clarification"))
  );
}

function findArtifactSectionBoundary(content: string) {
  const match = /(?:^|\n)(?:Code|Complexity|Whiteboard)\s*:/iu.exec(content);
  return match?.index ?? -1;
}

function findCompletedSentenceBoundary(content: string) {
  let boundary = -1;
  const pattern = /[.!?。！？](?=\s|$)|\n/gu;
  for (const match of content.matchAll(pattern)) {
    boundary = (match.index ?? 0) + match[0].length;
  }
  return boundary;
}

function sanitizeCompletedStreamingText(
  content: string,
  supportSpans: string[]
) {
  let removed = 0;
  const lines = content
    .split("\n")
    .map((line) => {
      const section = line.match(
        /^(\s*(?:Chinese thinking|中文思路|Answer|Approach|Clarifying question)\s*:\s*)(.*)$/iu
      );
      const prefix = section?.[1] ?? "";
      const body = section?.[2] ?? line;
      if (!body.trim()) return "";
      const units = splitClaimUnits(body);
      const kept = units.filter((unit) => {
        const unsupported = supportSpans.length
          ? isUnsupportedAnchoredFactClaim(unit, supportSpans)
          : isUnsupportedUnanchoredFactClaim(unit);
        if (unsupported) removed += 1;
        return !unsupported;
      });
      const sanitizedBody = kept.join(" ").trim();
      return sanitizedBody ? `${prefix}${sanitizedBody}` : "";
    })
    .filter(Boolean);
  return { text: lines.join("\n"), removed };
}

function splitClaimUnits(value: string) {
  return (
    value.match(/[^.!?。！？;；]+[.!?。！？;；]?/gu) ?? [value]
  )
    .flatMap((unit) =>
      unit.split(
        /,\s+(?=(?:and|but|while)\s+(?:(?:i|we|my|our|they|the|this|that)\b|(?:failed|successful)?\s*(?:messages?|requests?|systems?|services?|projects?|pipelines?)\b))/iu
      )
    )
    .map((unit) => unit.trim())
    .filter(Boolean);
}

function sanitizeAnchoredClaimSection(
  value: string | undefined,
  supportSpans: string[]
) {
  if (!value?.trim()) {
    return { text: "", removed: 0, preserved: 0, boundaryPreserved: 0 };
  }

  let removed = 0;
  let preserved = 0;
  let boundaryPreserved = 0;
  const lines = value
    .split(/\n+/)
    .map((line) => {
      const units = splitClaimUnits(line);
      const kept = units.filter((unit) => {
        if (isSupportedNegativeBoundaryClaim(unit, supportSpans)) {
          preserved += 1;
          boundaryPreserved += 1;
          return true;
        }
        if (isUnsupportedAnchoredFactClaim(unit, supportSpans)) {
          removed += 1;
          return false;
        }
        if (unit.trim()) preserved += 1;
        return Boolean(unit.trim());
      });
      return kept.join(" ").trim();
    })
    .filter(Boolean);

  return {
    text: lines.join("\n"),
    removed,
    preserved,
    boundaryPreserved,
  };
}

function isUnsupportedAnchoredFactClaim(
  value: string,
  supportSpans: string[]
) {
  const text = value.trim();
  if (!requiresFactSupport(text) || isClearlyHypotheticalClaim(text)) {
    return false;
  }

  return !supportSpans.some((supportSpan) =>
    anchoredFactClaimSupportedBySpan(text, supportSpan)
  );
}

function isSupportedNegativeBoundaryClaim(
  value: string,
  supportSpans: string[]
) {
  return Boolean(
    supportSpans.length > 0 &&
      NEGATIVE_IMPLEMENTATION_BOUNDARY_PATTERN.test(value)
  );
}

function hasCoherentBilingualBoundaryClaims(
  parsedAnswer: ParsedMeetingAnswer
) {
  const chinese = parsedAnswer.sections.chineseThinking?.trim();
  const english = parsedAnswer.sections.answer?.trim();
  if (!chinese || !english) return true;
  return (
    NEGATIVE_IMPLEMENTATION_BOUNDARY_PATTERN.test(chinese) ===
    NEGATIVE_IMPLEMENTATION_BOUNDARY_PATTERN.test(english)
  );
}

function isHypotheticalOnlyAnswer(parsedAnswer: ParsedMeetingAnswer) {
  const claims = [
    parsedAnswer.sections.answer,
    parsedAnswer.sections.approach,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .flatMap(splitClaimUnits);
  return claims.length > 0 && claims.every(isClearlyHypotheticalClaim);
}

function rebuildCoherentBilingualClaimSet(input: {
  parsedAnswer: ParsedMeetingAnswer;
  decision: FactAnchorDecision;
}): ParsedMeetingAnswer {
  const supportText = Array.from(
    new Set(collectSelectedSupportSpans(input.decision))
  )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000);
  if (!supportText) return input.parsedAnswer;
  return {
    ...input.parsedAnswer,
    sections: {
      ...input.parsedAnswer.sections,
      chineseThinking: `已验证的实现范围是：${supportText}。我们没有实现其余缺少证据的机制，只能把它们作为未来方案讨论。`,
      answer: `The verified implementation scope was ${supportText} I did not implement the other unsupported mechanisms as part of that verified scope; I would discuss them only as possible future improvements.`,
      approach: undefined,
      clarifyingQuestion: undefined,
      clarifyingOptions: [],
    },
    answerDisposition: "factual-with-anchor",
    supportingAnchorIds: input.parsedAnswer.supportingAnchorIds.filter(
      (anchorId) => input.decision.supportedAnchorIds.includes(anchorId)
    ),
  };
}

function anchoredFactClaimSupportedBySpan(
  claimText: string,
  supportSpan: string
) {
  const normalizedClaim = normalizeClaimEvidence(claimText);
  const normalizedSupport = normalizeClaimEvidence(supportSpan);
  if (!normalizedClaim || !normalizedSupport) return false;

  const numbers = normalizedClaim.match(/\b\d[\d,.]*\b/g) ?? [];
  if (numbers.some((number) => !normalizedSupport.includes(number))) {
    return false;
  }
  if (
    HIGH_AUTHORITY_ROLE_PATTERN.test(claimText) &&
    !HIGH_AUTHORITY_ROLE_PATTERN.test(supportSpan)
  ) {
    return false;
  }

  const highRiskShape = requiresFactSupport(claimText);
  if (!highRiskShape) return true;

  const claimTokens = extractDistinctiveClaimTokens(normalizedClaim);
  if (!claimTokens.length) return true;
  const supportedCount = claimTokens.filter((token) =>
    normalizedSupport.includes(token)
  ).length;
  const requiredCoverage = claimTokens.length <= 3 ? 1 : 0.55;
  return supportedCount / claimTokens.length >= requiredCoverage;
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
      const units = splitClaimUnits(line);
      const kept = units.filter((unit) => {
        if (isUnsupportedUnanchoredFactClaim(unit)) {
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

function sanitizeClarifyingSections(input: {
  question: string | undefined;
  options: ParsedMeetingAnswer["sections"]["clarifyingOptions"];
  supportSpans: string[];
}) {
  const sanitizedSections: string[] = [];
  let removed = 0;
  let preserved = 0;
  const questionAllowed = clarificationTextSupported(
    input.question,
    input.supportSpans,
    "question"
  );
  let question = questionAllowed ? input.question?.trim() || undefined : undefined;
  if (input.question?.trim()) {
    if (questionAllowed) preserved += 1;
    else {
      removed += 1;
      sanitizedSections.push("clarifyingQuestion");
    }
  }

  const concreteOptions = input.options.filter(
    (option) => !isAggregateClarifyingOption(option.label)
  );
  const allowedConcreteOptions = concreteOptions.filter((option) =>
    clarificationTextSupported(option.label, input.supportSpans, "option")
  );
  const concreteOptionRemoved =
    allowedConcreteOptions.length !== concreteOptions.length;
  let options = input.options.filter((option) => {
    if (isAggregateClarifyingOption(option.label)) {
      return !concreteOptionRemoved;
    }
    return allowedConcreteOptions.includes(option);
  });
  const removedOptions = input.options.length - options.length;
  removed += removedOptions;
  preserved += options.length;
  if (removedOptions > 0) sanitizedSections.push("clarifyingOptions");

  if (!question || (input.options.length > 0 && options.length < 2)) {
    if (question) {
      removed += 1;
      preserved = Math.max(0, preserved - 1);
      sanitizedSections.push("clarifyingQuestion");
    }
    if (options.length) {
      removed += options.length;
      preserved = Math.max(0, preserved - options.length);
      sanitizedSections.push("clarifyingOptions");
    }
    question = undefined;
    options = [];
  }

  return {
    question,
    options,
    removed,
    preserved,
    sanitizedSections: Array.from(new Set(sanitizedSections)),
  };
}

function clarificationTextSupported(
  value: string | undefined,
  supportSpans: string[],
  kind: "question" | "option"
) {
  const text = value?.trim();
  if (!text) return false;
  if (kind === "question" && isGenericClarifyingQuestion(text)) return true;
  if (!CLARIFICATION_FACT_BOUND_PATTERN.test(text)) return true;
  if (!supportSpans.length) return false;
  const tokens = extractClarificationSupportTokens(text);
  if (!tokens.length) return true;
  return supportSpans.some((supportSpan) => {
    const supportTokens = new Set(extractClarificationSupportTokens(supportSpan));
    const matched = tokens.filter((token) => supportTokens.has(token)).length;
    const requiredCoverage = tokens.length <= 3 ? 1 : 0.5;
    return matched / tokens.length >= requiredCoverage;
  });
}

function extractClarificationSupportTokens(value: string) {
  return Array.from(
    new Set(
      normalizeClaimEvidence(value)
        .split(" ")
        .map((token) => token.replace(/(?:ing|ed|es|s)$/u, ""))
        .filter((token) => token.length >= 4)
        .filter((token) => !CLARIFICATION_SUPPORT_STOP_WORDS.has(token))
        .filter((token) => !CLAIM_SUPPORT_STOP_WORDS.has(token))
    )
  );
}

function isGenericClarifyingQuestion(value: string) {
  const text = value.trim();
  return (
    /^(?:which|what)\s+(?:project|story|example|part|direction)\b/iu.test(text) ||
    /^(?:could|can)\s+you\s+clarify\b/iu.test(text) ||
    /^do\s+you\s+mean\b/iu.test(text)
  );
}

function isAggregateClarifyingOption(value: string) {
  return /^(?:both|all|either|both at (?:a )?high level|all of the above)$/iu.test(
    value.trim()
  );
}

function isUnsupportedUnanchoredFactClaim(value: string) {
  const text = value.trim();
  return requiresFactSupport(text) && !isClearlyHypotheticalClaim(text);
}

function requiresFactSupport(text: string) {
  const firstPersonClaim = FIRST_PERSON_PATTERN.test(text);
  const assertiveProjectClaim =
    ASSERTIVE_PROJECT_ACTION_PATTERN.test(text) ||
    PASSIVE_PROJECT_ACTION_PATTERN.test(text) ||
    ASSERTIVE_PROJECT_RESULT_PATTERN.test(text) ||
    ASSERTIVE_PROJECT_CLAIM_CHINESE_PATTERN.test(text);
  const quantitativeClaim =
    /(?:[$%]|\b\d[\d,.]*\b)/.test(text) &&
    (firstPersonClaim || assertiveProjectClaim);

  return (
    HARD_PERSONAL_FACT_PATTERN.test(text) ||
    HARD_PERSONAL_FACT_CHINESE_PATTERN.test(text) ||
    THIRD_PARTY_STANCE_PATTERN.test(text) ||
    ABSOLUTE_RESULT_PATTERN.test(text) ||
    SPECIFIC_MECHANISM_PATTERN.test(text) ||
    assertiveProjectClaim ||
    quantitativeClaim ||
    (firstPersonClaim && !isClearlyHypotheticalClaim(text))
  );
}

function isClearlyHypotheticalClaim(text: string) {
  return (
    HYPOTHETICAL_FIRST_PERSON_PATTERN.test(text) ||
    HYPOTHETICAL_FIRST_PERSON_CHINESE_PATTERN.test(text) ||
    GENERAL_HYPOTHETICAL_PATTERN.test(text) ||
    GENERAL_HYPOTHETICAL_CHINESE_PATTERN.test(text)
  );
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
const GENERAL_HYPOTHETICAL_PATTERN =
  /\b(?:would|could|should|might|may|recommend|suggest|propose|hypothetically|as an improvement|one option|one approach)\b/i;
const GENERAL_HYPOTHETICAL_CHINESE_PATTERN =
  /(?:可以|应该|建议|假设|如果|作为改进|一种方案|后续可)/u;
const NEGATIVE_IMPLEMENTATION_BOUNDARY_PATTERN =
  /\b(?:i|we)\s+(?:did\s+not|didn['’]?t|have\s+not|haven['’]?t|never)\s+(?:implement|build|deploy|use|add|create|ship)\b|(?:我|我们)(?:没有|未|并未|从未)(?:实现|构建|部署|使用|加入|创建|上线)/iu;
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
const ASSERTIVE_PROJECT_ACTION_PATTERN =
  /\b(?:(?:the|this|our|my)\s+)?(?:project|system|service|feature|implementation|pipeline|workflow|request|message|failure|record|item)s?\b.{0,80}\b(?:uses?|used|implements?|implemented|builds?|built|deploys?|deployed|routes?|routed|retries|retried|stores?|stored|writes?|wrote|parses?|parsed|handles?|handled|rebatches?|rebatched|sends?|sent|adds?|added|introduces?|introduced|configures?|configured)\b/i;
const PASSIVE_PROJECT_ACTION_PATTERN =
  /\b(?:was|were|is|are|has been|have been)\s+(?:automatically\s+)?(?:implemented|built|deployed|routed|retried|stored|written|parsed|handled|rebatched|sent|added|introduced|configured|moved)\b/i;
const ASSERTIVE_PROJECT_RESULT_PATTERN =
  /\b(?:throughput|latency|drop rate|error rate|failure rate|availability|reliability|cost|costs|performance|accuracy|precision|recall)\b.{0,60}\b(?:improved|increased|decreased|reduced|dropped|rose|reached|achieved|was|were)\b|\b(?:improved|increased|decreased|reduced|eliminated|achieved)\b.{0,60}\b(?:throughput|latency|drop rate|error rate|failure rate|availability|reliability|cost|costs|performance|accuracy|precision|recall)\b/i;
const ASSERTIVE_PROJECT_CLAIM_CHINESE_PATTERN =
  /(?:项目|系统|服务|功能|实现|流水线|消息|请求|失败|记录).{0,60}(?:已经|已|被).{0,40}(?:实现|构建|部署|路由|重试|写入|解析|处理|重新批处理|移入)|(?:吞吐量|延迟|丢弃率|错误率|失败率|可用性|成本|性能|准确率).{0,40}(?:提升了|降低了|改善了|减少了|达到了)/u;
const CLARIFICATION_FACT_BOUND_PATTERN =
  /\b(?:i|we|my|our|project|system|service|feature|implementation|implemented|built|designed|handled|deployed|measured|pipeline|architecture|mechanism|parsing|routing|retry|failure)\b/iu;
const CLARIFICATION_SUPPORT_STOP_WORDS = new Set([
  "about",
  "both",
  "could",
  "either",
  "focus",
  "high",
  "level",
  "option",
  "part",
  "please",
  "should",
  "which",
  "would",
]);
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
