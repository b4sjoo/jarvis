import type {
  AdvisorTurnIntent,
  AdvisorTurnIntentDecision,
} from "./advisor-turn-intent.js";
import { isExactLowValueAcknowledgement } from "./advisor-turn-intent.js";

export const PRIMARY_ASK_PROJECTION_SCHEMA_VERSION = 2;
export const PRIMARY_ASK_SEMANTIC_EVIDENCE_MAX_CHARS = 1_200;
const MAX_COORDINATED_PRIMARY_ASK_SPANS = 4;

export type PrimaryAskSpeechAct =
  | "question"
  | "directive"
  | "constraint"
  | "informational"
  | "logistics"
  | "acknowledgement";

export type PrimaryAskDisposition =
  | "answer-primary-ask"
  | "append-setup"
  | "revise-existing-lqu"
  | "ignore";

export interface PrimaryAskEvidenceSpan {
  turnId: string;
  text: string;
  start: number;
  end: number;
}

export interface PrimaryAskProjection {
  schemaVersion: typeof PRIMARY_ASK_PROJECTION_SCHEMA_VERSION;
  sourceTurnIds: string[];
  sourceChars: number;
  speechAct: PrimaryAskSpeechAct;
  normalizedPrimaryAsk?: string;
  primaryAskSpans: PrimaryAskEvidenceSpan[];
  setupSpans: PrimaryAskEvidenceSpan[];
  quotedOrFutureExampleSpans: PrimaryAskEvidenceSpan[];
  answerFocusText: string;
  semanticEvidenceText: string;
  answerFocusSpans: PrimaryAskEvidenceSpan[];
  objectSpans: PrimaryAskEvidenceSpan[];
  scenarioSpans: PrimaryAskEvidenceSpan[];
  semanticEvidenceRetentionReasons: string[];
  semanticEvidenceDroppedReasons: string[];
  disposition: PrimaryAskDisposition;
  reason: string;
  confidence: number;
}

export interface ProjectPrimaryAskInput {
  turnId: string;
  text: string;
}

export interface ShortConfirmationAdmissionDecision {
  disposition:
    | "not-short-confirmation"
    | "hold-confirmation"
    | "admit-primary-ask"
    | "admit-constraint-or-correction";
  reason:
    | "not-short-confirmation"
    | "short-confirmation-without-authoritative-ask"
    | "authoritative-primary-ask"
    | "constraint-or-correction-signal";
  primaryAskOverride: boolean;
}

export function projectPrimaryAsk({
  turnId,
  text,
}: ProjectPrimaryAskInput): PrimaryAskProjection {
  const sourceSpans = splitSourceSpans(turnId, text);
  if (!sourceSpans.length) {
    return projection({
      sourceTurnIds: turnId ? [turnId] : [],
      sourceChars: text.length,
      speechAct: "informational",
      setupSpans: [],
      quotedOrFutureExampleSpans: [],
      disposition: "ignore",
      reason: "empty-source",
      confidence: 1,
    });
  }

  const quotedOrFutureExampleSpans: PrimaryAskEvidenceSpan[] = [];
  let latestAskCandidateGroup: PrimaryAskEvidenceSpan[] = [];
  let futureExampleCarry = 0;

  for (const span of sourceSpans) {
    const explicitCurrentTransition = findExplicitCurrentTransition(span.text);
    if (explicitCurrentTransition) {
      futureExampleCarry = 0;
    }

    const transitionSpan = explicitCurrentTransition
      ? trimSpanRange(
          span,
          span.start + explicitCurrentTransition.start,
          span.end
        )
      : undefined;
    const candidate = explicitCurrentTransition
      ? extractDirectAskAfterTransition(span, explicitCurrentTransition.end) ??
        extractActionObjectDirectiveSpan(span)
      : extractDirectAskSpan(span) ?? extractActionObjectDirectiveSpan(span);
    const coordinatedCandidates = extractCoordinatedDirectAskSpans(
      transitionSpan ?? span
    );
    const candidateGroup =
      coordinatedCandidates.length > 1
        ? coordinatedCandidates
        : candidate
          ? [candidate]
          : [];
    const negativeFrame = hasQuotedOrFutureFrame(
      transitionSpan?.text ?? span.text
    );
    const currentRecipient = hasCurrentRecipientSignal(
      candidateGroup.map((item) => item.text).join(" ") || span.text
    );
    const carriedExample =
      futureExampleCarry > 0 &&
      candidateGroup.length > 0 &&
      !currentRecipient &&
      !explicitCurrentTransition;

    if (explicitCurrentTransition && explicitCurrentTransition.start > 0) {
      const transitionPrefix = trimSpanRange(
        span,
        span.start,
        span.start + explicitCurrentTransition.start
      );
      if (
        transitionPrefix &&
        hasQuotedOrFutureFrame(transitionPrefix.text)
      ) {
        quotedOrFutureExampleSpans.push(transitionPrefix);
      }
    }

    if (negativeFrame || carriedExample) {
      quotedOrFutureExampleSpans.push(
        negativeFrame && transitionSpan ? transitionSpan : span
      );
      futureExampleCarry = negativeFrame
        ? Math.max(futureExampleCarry, 3)
        : Math.max(0, futureExampleCarry - 1);
      continue;
    }

    if (candidateGroup.length > 0) {
      latestAskCandidateGroup = candidateGroup;
      futureExampleCarry = 0;
      continue;
    }

    if (futureExampleCarry > 0) {
      futureExampleCarry -= 1;
    }
  }

  const primaryAsk = latestAskCandidateGroup.at(-1);
  if (primaryAsk) {
    const primaryAskSpans = latestAskCandidateGroup;
    const firstPrimaryAsk = primaryAskSpans[0]!;
    const lastPrimaryAsk = primaryAskSpans[primaryAskSpans.length - 1]!;
    const normalizedPrimaryAsk =
      primaryAskSpans.length > 1 &&
      firstPrimaryAsk.turnId === lastPrimaryAsk.turnId
        ? normalizeSpace(text.slice(firstPrimaryAsk.start, lastPrimaryAsk.end))
        : normalizeSpace(primaryAsk.text);
    const setupSpans = collectSetupSpans({
      sourceSpans,
      primaryAskSpans,
      quotedOrFutureExampleSpans,
    });
    return projection({
      sourceTurnIds: [turnId],
      sourceChars: text.length,
      speechAct: primaryAskSpans.some((span) => isDirective(span.text))
        ? "directive"
        : "question",
      normalizedPrimaryAsk,
      primaryAskSpans,
      setupSpans,
      quotedOrFutureExampleSpans,
      disposition: "answer-primary-ask",
      reason:
        primaryAskSpans.length > 1
          ? "coordinated-primary-asks"
          : quotedOrFutureExampleSpans.length > 0
          ? "terminal-ask-after-quoted-or-future-examples"
          : setupSpans.length > 0
            ? "terminal-ask-after-setup"
            : "single-primary-ask",
      confidence:
        quotedOrFutureExampleSpans.length > 0 || /[?？]\s*$/.test(primaryAsk.text)
          ? 0.97
          : 0.92,
    });
  }

  const speechAct = classifyNonAskSpeechAct(text);
  const allExamples =
    quotedOrFutureExampleSpans.length > 0 &&
    quotedOrFutureExampleSpans.length === sourceSpans.length;
  return projection({
    sourceTurnIds: [turnId],
    sourceChars: text.length,
    speechAct,
    setupSpans: sourceSpans.filter(
      (span) => !quotedOrFutureExampleSpans.some((item) => sameSpan(item, span))
    ),
    quotedOrFutureExampleSpans,
    disposition: speechAct === "acknowledgement" ? "ignore" : "append-setup",
    reason: allExamples
      ? "quoted-or-future-examples-without-current-ask"
      : speechAct === "logistics"
        ? "logistics-without-current-ask"
        : speechAct === "acknowledgement"
          ? "acknowledgement-without-current-ask"
          : "setup-without-current-ask",
    confidence:
      allExamples || speechAct === "logistics" || speechAct === "acknowledgement"
        ? 0.96
        : 0.72,
  });
}

function extractCoordinatedDirectAskSpans(
  span: PrimaryAskEvidenceSpan
): PrimaryAskEvidenceSpan[] {
  if (hasQuotedOrFutureFrame(span.text)) return [];

  const connectors = Array.from(
    span.text.matchAll(COORDINATED_ASK_CONNECTOR_PATTERN)
  ).slice(0, MAX_COORDINATED_PRIMARY_ASK_SPANS - 1);
  if (!connectors.length) return [];

  const firstConnector = connectors[0]!;
  const prefix = span.text.slice(0, firstConnector.index!);
  const prefixHeads = Array.from(prefix.matchAll(DIRECT_ASK_HEAD_PATTERN));
  const firstHead = prefixHeads[0];
  if (!firstHead || !isInterrogativeAskHead(firstHead[0])) return [];

  const boundaries = connectors.map((connector) => ({
    connectorStart: connector.index!,
    askStart: connector.index! + connector[0].length,
  }));
  const ranges = [
    {
      start: firstHead.index!,
      end: boundaries[0]!.connectorStart,
    },
    ...boundaries.map((boundary, index) => ({
      start: boundary.askStart,
      end:
        boundaries[index + 1]?.connectorStart ?? span.text.length,
    })),
  ];
  const candidates = ranges
    .map((range) =>
      trimSpanRange(
        span,
        span.start + range.start,
        span.start + range.end
      )
    )
    .filter((candidate): candidate is PrimaryAskEvidenceSpan =>
      Boolean(candidate)
    );

  if (
    candidates.length < 2 ||
    candidates.some(
      (candidate) =>
        !isDirectAskText(candidate.text, span.text) ||
        estimateSpanWordCount(candidate.text) < 2
    )
  ) {
    return [];
  }
  return candidates;
}

export function composePrimaryAskProjection(input: {
  current: PrimaryAskProjection | undefined;
  previous: PrimaryAskProjection | undefined;
  extended: boolean;
}): PrimaryAskProjection | undefined {
  const { current, previous, extended } = input;
  if (!current) return previous;
  if (!extended || !previous) return current;

  const completedSetup =
    !previous.normalizedPrimaryAsk && Boolean(current.normalizedPrimaryAsk);
  return projection({
    sourceTurnIds: unique([
      ...previous.sourceTurnIds,
      ...current.sourceTurnIds,
    ]),
    sourceChars: previous.sourceChars + current.sourceChars,
    speechAct: current.speechAct,
    normalizedPrimaryAsk: current.normalizedPrimaryAsk,
    primaryAskSpans: current.primaryAskSpans,
    setupSpans: dedupeSpans([
      ...previous.setupSpans,
      ...current.setupSpans,
    ]),
    quotedOrFutureExampleSpans: dedupeSpans([
      ...previous.quotedOrFutureExampleSpans,
      ...current.quotedOrFutureExampleSpans,
    ]),
    disposition: completedSetup
      ? "revise-existing-lqu"
      : current.disposition,
    reason: completedSetup
      ? "primary-ask-completed-prior-setup"
      : current.reason,
    confidence: current.confidence,
  });
}

export function isPrimaryAskCompletion(input: {
  current: PrimaryAskProjection | undefined;
  previous: PrimaryAskProjection | undefined;
}) {
  const { current, previous } = input;
  if (
    !current?.normalizedPrimaryAsk ||
    previous?.normalizedPrimaryAsk ||
    previous?.disposition !== "append-setup" ||
    previous.speechAct === "logistics" ||
    previous.quotedOrFutureExampleSpans.length ===
      previous.setupSpans.length + previous.quotedOrFutureExampleSpans.length
  ) {
    return false;
  }
  return hasReferentialCurrentAsk(current.normalizedPrimaryAsk);
}

export function primaryAskClassifierText(
  projection: PrimaryAskProjection,
  fallback: string
) {
  return (
    projection.semanticEvidenceText ||
    projection.answerFocusText ||
    projection.normalizedPrimaryAsk ||
    fallback
  );
}

export function primaryAskAnswerFocusText(
  projection: PrimaryAskProjection,
  fallback = ""
) {
  return (
    projection.answerFocusText ||
    projection.normalizedPrimaryAsk ||
    fallback
  );
}

export function decideShortConfirmationAdmission(input: {
  shortConfirmationDetected: boolean;
  hasConstraintOrCorrectionSignal: boolean;
  primaryAskProjection: PrimaryAskProjection;
}): ShortConfirmationAdmissionDecision {
  if (!input.shortConfirmationDetected) {
    return {
      disposition: "not-short-confirmation",
      reason: "not-short-confirmation",
      primaryAskOverride: false,
    };
  }

  if (input.hasConstraintOrCorrectionSignal) {
    return {
      disposition: "admit-constraint-or-correction",
      reason: "constraint-or-correction-signal",
      primaryAskOverride: false,
    };
  }

  const projection = input.primaryAskProjection;
  const projectedAskWordCount =
    projection.normalizedPrimaryAsk
      ?.match(/[\p{L}\p{N}_+#.-]+/gu)
      ?.filter(Boolean).length ?? 0;
  const hasAuthoritativePrimaryAsk =
    projection.disposition === "answer-primary-ask" &&
    Boolean(projection.normalizedPrimaryAsk) &&
    projectedAskWordCount >= 2 &&
    projection.primaryAskSpans.length > 0 &&
    (projection.speechAct === "question" ||
      projection.speechAct === "directive") &&
    projection.confidence >= 0.9;

  if (hasAuthoritativePrimaryAsk) {
    return {
      disposition: "admit-primary-ask",
      reason: "authoritative-primary-ask",
      primaryAskOverride: true,
    };
  }

  return {
    disposition: "hold-confirmation",
    reason: "short-confirmation-without-authoritative-ask",
    primaryAskOverride: false,
  };
}

export function reconcilePrimaryAskTurnDecision(
  projection: PrimaryAskProjection,
  decision: AdvisorTurnIntentDecision
): AdvisorTurnIntentDecision {
  if (projection.normalizedPrimaryAsk) {
    return {
      ...decision,
      evidence: unique([
        ...decision.evidence,
        "primary-ask-projected",
        ...(projection.quotedOrFutureExampleSpans.length
          ? ["quoted-or-future-example-excluded"]
          : []),
      ]),
      reason:
        projection.disposition === "revise-existing-lqu"
          ? "primary-ask-revised-existing-lqu"
          : decision.reason,
    };
  }

  const hasAuthoritativeNegativeEvidence =
    projection.quotedOrFutureExampleSpans.length > 0 ||
    projection.speechAct === "logistics" ||
    projection.speechAct === "acknowledgement";
  if (!hasAuthoritativeNegativeEvidence) return decision;

  const intent: AdvisorTurnIntent =
    projection.speechAct === "logistics"
      ? "logistics"
      : projection.speechAct === "acknowledgement"
        ? "confirmation"
        : "informational";
  const action = projection.disposition === "ignore" ? "ignore" : "append-only";
  return {
    intent,
    confidence: projection.confidence,
    evidence: unique([
      "primary-ask-projection",
      projection.reason,
      ...(projection.quotedOrFutureExampleSpans.length
        ? ["quoted-or-future-example-excluded"]
        : []),
    ]),
    action,
    recommendedAction: action,
    reason: projection.reason,
    contextPromptEligible: action === "append-only",
    enforcement: "enforce",
    wouldSuppress: true,
    executionAuthorized: false,
    followupScopeSource: decision.followupScopeSource,
  };
}

export function formatPrimaryAskProjectionForTrace(
  value: PrimaryAskProjection | undefined
) {
  if (!value) return {};
  return {
    primaryAskProjectionSchemaVersion: value.schemaVersion,
    primaryAskSpeechAct: value.speechAct,
    primaryAskDisposition: value.disposition,
    primaryAskReason: value.reason,
    primaryAskConfidence: value.confidence,
    primaryAskNormalizedText: value.normalizedPrimaryAsk,
    primaryAskAnswerFocusText: value.answerFocusText,
    primaryAskSemanticEvidenceText: value.semanticEvidenceText,
    primaryAskAnswerFocusChars: value.answerFocusText.length,
    primaryAskSemanticEvidenceChars: value.semanticEvidenceText.length,
    primaryAskSourceTurnIds: value.sourceTurnIds,
    primaryAskSourceChars: value.sourceChars,
    primaryAskSpanCount: value.primaryAskSpans.length,
    primaryAskSetupSpanCount: value.setupSpans.length,
    primaryAskQuotedOrFutureSpanCount:
      value.quotedOrFutureExampleSpans.length,
    primaryAskAnswerFocusSpanCount: value.answerFocusSpans.length,
    primaryAskObjectSpanCount: value.objectSpans.length,
    primaryAskScenarioSpanCount: value.scenarioSpans.length,
    primaryAskSemanticEvidenceRetentionReasons:
      value.semanticEvidenceRetentionReasons,
    primaryAskSemanticEvidenceDroppedReasons:
      value.semanticEvidenceDroppedReasons,
    primaryAskTurnGateView: "answer-focus",
    primaryAskTaxonomyView: "semantic-evidence",
    primaryAskTaskSettlementView: "semantic-evidence",
    primaryAskAdvisorView: "answer-focus-plus-semantic-context",
    primaryAskSpans: value.primaryAskSpans,
    primaryAskSetupSpans: value.setupSpans,
    primaryAskQuotedOrFutureSpans: value.quotedOrFutureExampleSpans,
    primaryAskAnswerFocusSpans: value.answerFocusSpans,
    primaryAskObjectSpans: value.objectSpans,
    primaryAskScenarioSpans: value.scenarioSpans,
  };
}

function splitSourceSpans(turnId: string, text: string) {
  const spans: PrimaryAskEvidenceSpan[] = [];
  const pattern = /[^.!?。！？\n]+(?:[.!?。！？]+|$)/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const raw = match[0];
    const leading = raw.match(/^\s*/u)?.[0].length ?? 0;
    const trailing = raw.match(/\s*$/u)?.[0].length ?? 0;
    const start = match.index + leading;
    const end = match.index + raw.length - trailing;
    if (end <= start) continue;
    spans.push({
      turnId,
      text: text.slice(start, end),
      start,
      end,
    });
  }
  return spans;
}

function extractDirectAskSpan(
  span: PrimaryAskEvidenceSpan
): PrimaryAskEvidenceSpan | undefined {
  const text = span.text;
  const candidates = Array.from(text.matchAll(DIRECT_ASK_PATTERN));
  const match = candidates[candidates.length - 1];
  const candidateText = match?.groups?.ask;
  if (!match || !candidateText) return undefined;

  const localStart = match.index! + match[0].lastIndexOf(candidateText);
  const rawCandidate = text.slice(localStart);
  if (!isDirectAskText(rawCandidate, text)) return undefined;

  const leading = rawCandidate.match(/^\s*/u)?.[0].length ?? 0;
  const start = span.start + localStart + leading;
  return {
    turnId: span.turnId,
    text: text.slice(localStart + leading),
    start,
    end: span.end,
  };
}

function extractDirectAskAfterTransition(
  span: PrimaryAskEvidenceSpan,
  transitionEnd: number
): PrimaryAskEvidenceSpan | undefined {
  const suffix = span.text.slice(transitionEnd);
  const candidates = Array.from(suffix.matchAll(DIRECT_ASK_HEAD_PATTERN));
  let match = candidates[candidates.length - 1];
  const priorMatch = candidates[candidates.length - 2];
  if (
    match &&
    priorMatch &&
    isDirective(priorMatch[0]) &&
    /^(?:\s+(?:(?:me|us)\s+)?(?:through\s+)?)$/iu.test(
      suffix.slice(
        priorMatch.index! + priorMatch[0].length,
        match.index!
      )
    )
  ) {
    match = priorMatch;
  }
  if (!match) return undefined;

  const localStart = transitionEnd + match.index!;
  const rawCandidate = span.text.slice(localStart);
  const transitionText = span.text.slice(transitionEnd);
  if (!isDirectAskText(rawCandidate, transitionText)) return undefined;

  const leading = rawCandidate.match(/^\s*/u)?.[0].length ?? 0;
  const start = span.start + localStart + leading;
  return {
    turnId: span.turnId,
    text: span.text.slice(localStart + leading),
    start,
    end: span.end,
  };
}

function extractActionObjectDirectiveSpan(
  span: PrimaryAskEvidenceSpan
): PrimaryAskEvidenceSpan | undefined {
  const match = ACTION_OBJECT_DIRECTIVE_PATTERN.exec(span.text);
  const candidateText = match?.groups?.ask;
  if (!match || !candidateText || !hasConcreteDirectiveObject(candidateText)) {
    return undefined;
  }

  const localStart = match.index + match[0].lastIndexOf(candidateText);
  const rawCandidate = span.text.slice(localStart);
  const leading = rawCandidate.match(/^\s*/u)?.[0].length ?? 0;
  const start = span.start + localStart + leading;
  return {
    turnId: span.turnId,
    text: span.text.slice(localStart + leading),
    start,
    end: span.end,
  };
}

const DIRECT_ASK_HEAD_PATTERN =
  /(?:(?:can|could|would|will|do|does|did|is|are|was|were|have|has|had|should)\s+(?:you|your|this|that|it|there)\b|(?:how|what|why|when|where|which|who|whether)\b|(?:tell|walk|talk|give|show|explain|describe|outline|propose|design|create|sketch|implement|write|code|solve|compare|estimate|evaluate|discuss|share|redraw)\b|(?:请|怎么|如何|为什么|什么|是否|哪里|哪个|解释|描述|设计|实现|编写|估算|比较|重画))/giu;

const DIRECT_ASK_PATTERN =
  /(?:^|(?:(?:\b(?:but|and|so|now|then|okay|with that|given that|my question is|for you|before we finish)\b[\s,:-]*)|(?:\b(?:thanks|thank you)\b[\s,:-]*and\b[\s,:-]*)))(?<ask>(?:please\s+)?(?:(?:can|could|would|will|do|does|did|is|are|was|were|have|has|had|should)\s+(?:you|your|this|that|it|there)\b|(?:how|what|why|when|where|which|who|whether)\b|(?:tell|walk|talk|give|show|explain|describe|outline|propose|design|create|sketch|implement|write|code|solve|compare|estimate|evaluate|discuss|share|redraw)\b|(?:请|怎么|如何|为什么|什么|是否|哪里|哪个|解释|描述|设计|实现|编写|估算|比较|重画)))/giu;

const ACTION_OBJECT_DIRECTIVE_PATTERN =
  /(?:^|(?:\b(?:but|and|so|now|then|okay|alright|right)\b[\s,:-]*))(?<ask>(?:please\s+)?(?:maybe\s+)?(?:let(?:'s| us)\s+)?(?:do|design|build|implement|write|code|solve|create|sketch|add|change|update|modify|revise|redraw|keep)\s+.+)$/iu;

const COORDINATED_ASK_CONNECTOR_PATTERN =
  /(?:,\s*(?:and|also)\s+|;\s*(?:(?:and|also)\s+)?|\s+(?:and|also)\s+)(?=(?:(?:can|could|would|will|do|does|did|is|are|was|were|have|has|had|should)\s+(?:you|your|this|that|it|there)\b|(?:how|what|why|when|where|which|who|whether)\b))/giu;

function isInterrogativeAskHead(text: string) {
  return /^(?:(?:can|could|would|will|do|does|did|is|are|was|were|have|has|had|should)\s+(?:you|your|this|that|it|there)\b|(?:how|what|why|when|where|which|who|whether)\b)/iu.test(
    text.trim()
  );
}

function estimateSpanWordCount(text: string) {
  return text.match(/[\p{L}\p{N}_+#.-]+/gu)?.length ?? 0;
}

function isDirectAskText(candidate: string, wholeSpan: string) {
  const normalized = normalizeSpace(candidate);
  if (!normalized) return false;
  if (hasQuotedOrFutureFrame(wholeSpan) && !hasCurrentRecipientSignal(candidate)) {
    return false;
  }
  if (/[?？]\s*$/.test(wholeSpan)) return true;
  return /^(?:tell|walk|talk|give|show|explain|describe|outline|propose|design|create|sketch|implement|write|code|solve|compare|estimate|evaluate|discuss|share|redraw|请|解释|描述|设计|实现|编写|估算|比较|重画)\b/iu.test(
    normalized
  );
}

function hasQuotedOrFutureFrame(text: string) {
  const normalized = normalizeSpace(text).toLowerCase();
  return (
    /\b(?:for example|for instance|such as|examples? (?:include|like)|questions? (?:include|like|such as)|sample questions?|practice questions?)\b/i.test(
      normalized
    ) ||
    /\b(?:you (?:can|could|may)(?: also)? ask|they (?:can|could|may|might|will) ask|we (?:can|could|may|might|will) ask|you(?:'ll| will) be asked|the interviewer (?:can|could|may|might|will) ask)\b/i.test(
      normalized
    ) ||
    /\b(?:(?:the|a|your|our)\s+)?(?:hiring manager|manager|recruiter)\s+(?:can|could|may|might|will|would)\s+ask\b/i.test(
      normalized
    ) ||
    /\b(?:in|during|for)\s+(?:the\s+)?(?:next|following|later|future)\s+(?:round|interview|conversation|section)\b/i.test(
      normalized
    ) ||
    /\b(?:the next steps?|the interview process|the interview will|the round will|you should prepare for)\b/i.test(
      normalized
    ) ||
    /(?:例如|比如|示例问题|参考问题|之后会问|下一轮会问|面试官可能会问|你可以问)/u.test(
      text
    )
  );
}

function findExplicitCurrentTransition(text: string) {
  const pattern =
    /\b(?:now|let(?:'s| us)\s+(?:start|begin)|my question is|before we finish)\b/giu;
  for (const match of text.matchAll(pattern)) {
    const start = match.index!;
    const prefix = text.slice(0, start).trimEnd();
    const beginsCurrentClause =
      !prefix ||
      /[;.!?。！？—–-]$/u.test(prefix) ||
      /(?:^|\s)(?:ok(?:ay)?|alright|right|so)[,:]?$/iu.test(prefix);
    if (!beginsCurrentClause) continue;
    return {
      start,
      end: start + match[0].length,
    };
  }
  return undefined;
}

function hasCurrentRecipientSignal(text: string) {
  return /\b(?:does this sound|how does this sound|what do you think|any questions|relative to what you(?:'re| are) looking for|fit with your|match your|your background|your experience|your goals|for you right now)\b/i.test(
    normalizeSpace(text)
  );
}

function hasReferentialCurrentAsk(text: string) {
  return /\b(?:this|that|it|these|those|the role|the position|what i (?:just )?(?:said|described)|based on that|given that|relative to)\b/i.test(
    text
  ) || /(?:这个|那个|它|上述|刚才|基于这些|相对于)/u.test(text);
}

function classifyNonAskSpeechAct(text: string): PrimaryAskSpeechAct {
  const normalized = normalizeSpace(text).toLowerCase();
  if (
    isExactLowValueAcknowledgement(normalized) ||
    /^(?:ah|eh|er|hmm|mm|mhm|uh|um|yeah|yep|yes|no|ok|okay|right|sure|cool|great|nice|perfect|thanks|thank you)[.!]?$/i.test(
      normalized
    ) ||
    /^(?:ok(?:ay)?|right|sure|cool|great|nice|perfect)(?:,\s*|\s+)(?:ok(?:ay)?|right|sure|cool|great|nice|perfect|looks good(?: to me)?|that looks good(?: to me)?|this looks good(?: to me)?)[.!]?$/i.test(
      normalized
    )
  ) {
    return "acknowledgement";
  }
  if (
    /\b(?:next steps?|schedule|availability|calendar|interview process|interview loop|send (?:you )?(?:the )?(?:details|material|invite)|follow up by email|one second|hold on|share my screen)\b/i.test(
      normalized
    ) ||
    /(?:下一步|时间安排|日程|面试流程|发邮件|发材料|稍等|分享屏幕)/u.test(
      text
    )
  ) {
    return "logistics";
  }
  return "informational";
}

function hasConcreteDirectiveObject(text: string) {
  const normalized = normalizeSpace(text)
    .toLocaleLowerCase()
    .replace(/[.!?。！？]+$/u, "");
  const match =
    /^(?:please\s+)?(?:maybe\s+)?(?:let(?:'s| us)\s+)?(?:do|design|build|implement|write|code|solve|create|sketch|add|change|update|modify|revise|redraw|keep)\s+(?<object>.+)$/iu.exec(
      normalized
    );
  const object = match?.groups?.object?.trim();
  if (!object) return false;
  return !/^(?:this|that|it|one|something|the same(?: thing| one)?)$/iu.test(
    object
  );
}

function isDirective(text: string) {
  const normalized = normalizeSpace(text).replace(/^please\s+/iu, "");
  return (
    /^(?:tell|walk|talk|give|show|explain|describe|outline|propose|design|create|sketch|implement|write|code|solve|compare|estimate|evaluate|discuss|share|add|change|update|modify|revise|redraw|keep|请|解释|描述|设计|实现|编写|估算|比较|增加|修改|更新|重画|保留)\b/iu.test(
      normalized
    ) || hasConcreteDirectiveObject(normalized)
  );
}

function projection(
  value: Omit<
    PrimaryAskProjection,
    | "schemaVersion"
    | "primaryAskSpans"
    | "answerFocusText"
    | "semanticEvidenceText"
    | "answerFocusSpans"
    | "objectSpans"
    | "scenarioSpans"
    | "semanticEvidenceRetentionReasons"
    | "semanticEvidenceDroppedReasons"
  > & {
    primaryAskSpans?: PrimaryAskEvidenceSpan[];
  }
): PrimaryAskProjection {
  const primaryAskSpans = dedupeSpans(value.primaryAskSpans ?? []);
  const setupSpans = dedupeSpans(value.setupSpans);
  const quotedOrFutureExampleSpans = dedupeSpans(
    value.quotedOrFutureExampleSpans
  );
  const answerFocusText =
    value.normalizedPrimaryAsk?.trim() ??
    joinSpans(primaryAskSpans, value.sourceTurnIds);
  const semanticProjection = deriveSemanticEvidence({
    sourceTurnIds: value.sourceTurnIds,
    answerFocusText,
    answerFocusSpans: primaryAskSpans,
    setupSpans,
    quotedOrFutureExampleSpans,
  });

  return {
    schemaVersion: PRIMARY_ASK_PROJECTION_SCHEMA_VERSION,
    ...value,
    primaryAskSpans,
    setupSpans,
    quotedOrFutureExampleSpans,
    answerFocusText,
    ...semanticProjection,
  };
}

function deriveSemanticEvidence(input: {
  sourceTurnIds: string[];
  answerFocusText: string;
  answerFocusSpans: PrimaryAskEvidenceSpan[];
  setupSpans: PrimaryAskEvidenceSpan[];
  quotedOrFutureExampleSpans: PrimaryAskEvidenceSpan[];
}) {
  const objectSpans: PrimaryAskEvidenceSpan[] = [];
  const droppedReasons: string[] = [];

  for (const setupSpan of input.setupSpans) {
    const semanticSpan = trimSemanticSetupSpan(setupSpan);
    if (!semanticSpan) {
      droppedReasons.push(
        classifyNonAskSpeechAct(setupSpan.text) === "logistics"
          ? "logistics-setup"
          : "discourse-only-setup"
      );
      continue;
    }
    objectSpans.push(semanticSpan);
  }

  const answerFocusSpans = dedupeSpans(input.answerFocusSpans);
  const semanticAnswerFocusSpans =
    collapseCoordinatedAnswerFocusSpans(
      answerFocusSpans,
      input.answerFocusText
    );
  const retainedObjectSpans = dedupeSpans(objectSpans);
  const scenarioSpans = retainedObjectSpans.filter((span) =>
    hasScenarioEvidenceSignal(span.text)
  );
  const semanticSpans = sortSpansBySourceOrder(
    dedupeSpans([
      ...retainedObjectSpans,
      ...semanticAnswerFocusSpans,
    ]),
    input.sourceTurnIds
  );
  const fullSemanticEvidence = joinSpans(
    semanticSpans,
    input.sourceTurnIds
  );
  const semanticEvidenceText = boundSemanticEvidence({
    fullText: fullSemanticEvidence,
    answerFocusText: input.answerFocusText,
  });
  const retentionReasons = unique([
    ...(answerFocusSpans.length ? ["answer-focus"] : []),
    ...(retainedObjectSpans.length ? ["setup-object"] : []),
    ...(scenarioSpans.length ? ["setup-scenario"] : []),
    ...(semanticEvidenceText.length < fullSemanticEvidence.length
      ? ["bounded-semantic-evidence"]
      : []),
  ]);

  if (input.quotedOrFutureExampleSpans.length) {
    droppedReasons.push("quoted-or-future-example");
  }

  return {
    semanticEvidenceText,
    answerFocusSpans,
    objectSpans: retainedObjectSpans,
    scenarioSpans,
    semanticEvidenceRetentionReasons: retentionReasons,
    semanticEvidenceDroppedReasons: unique(droppedReasons),
  };
}

function collapseCoordinatedAnswerFocusSpans(
  spans: PrimaryAskEvidenceSpan[],
  answerFocusText: string
) {
  if (spans.length < 2) return spans;
  const first = spans[0];
  const last = spans[spans.length - 1];
  if (
    !first ||
    !last ||
    spans.some((span) => span.turnId !== first.turnId)
  ) {
    return spans;
  }
  return [
    {
      turnId: first.turnId,
      text: answerFocusText,
      start: first.start,
      end: last.end,
    },
  ];
}

function trimSemanticSetupSpan(span: PrimaryAskEvidenceSpan) {
  const raw = span.text;
  const leadingMatch = raw.match(
    /^(?:(?:now|so|then|okay|ok|alright|right|with that|given that|my question is|before we finish)\b[\s,:;—–-]*)+/iu
  );
  const trailingMatch = raw.match(
    /(?:[\s,:;—–-]+\b(?:and|but|so|then)\b[\s,:;—–-]*)$/iu
  );
  const start = span.start + (leadingMatch?.[0].length ?? 0);
  const end =
    span.end -
    (trailingMatch && start < span.end - trailingMatch[0].length
      ? trailingMatch[0].length
      : 0);
  const trimmed = trimSpanRange(span, start, end);
  if (!trimmed || isDiscourseOnlySetup(trimmed.text)) return undefined;
  if (classifyNonAskSpeechAct(trimmed.text) === "logistics") return undefined;
  return trimmed;
}

function isDiscourseOnlySetup(text: string) {
  const normalized = normalizeSpace(text)
    .toLowerCase()
    .replace(/[,:;.!?。！？—–-]+$/gu, "");
  return /^(?:now|so|then|okay|ok|alright|right|with that|given that|my question is|before we finish|please|and|but)$/u.test(
    normalized
  );
}

function hasScenarioEvidenceSignal(text: string) {
  return /\b(?:add|change|update|modify|replace|remove|keep|preserve|extend|scale|support|given|when|if|under|with|without|current|existing|instead|rather|constraint|requirement|latency|throughput|qps|traffic|data|user|system|service|component|database|cache|queue|retrieval|rag|model|pricing)\b/iu.test(
    text
  ) || /(?:增加|修改|替换|删除|保留|扩展|支持|给定|如果|约束|需求|延迟|吞吐|流量|数据|系统|服务|组件|数据库|缓存|队列|检索|模型|定价)/u.test(
    text
  );
}

function boundSemanticEvidence(input: {
  fullText: string;
  answerFocusText: string;
}) {
  if (input.fullText.length <= PRIMARY_ASK_SEMANTIC_EVIDENCE_MAX_CHARS) {
    return input.fullText;
  }

  const answerFocusText = input.answerFocusText.slice(
    -PRIMARY_ASK_SEMANTIC_EVIDENCE_MAX_CHARS
  );
  if (answerFocusText.length >= PRIMARY_ASK_SEMANTIC_EVIDENCE_MAX_CHARS) {
    return answerFocusText;
  }
  const separator = answerFocusText ? " " : "";
  const setupBudget =
    PRIMARY_ASK_SEMANTIC_EVIDENCE_MAX_CHARS -
    answerFocusText.length -
    separator.length;
  const setupText = input.fullText
    .slice(0, Math.max(0, input.fullText.length - input.answerFocusText.length))
    .trim()
    .slice(-setupBudget);
  return normalizeSpace(
    `${setupText}${separator}${answerFocusText}`
  ).slice(-PRIMARY_ASK_SEMANTIC_EVIDENCE_MAX_CHARS);
}

function joinSpans(
  spans: PrimaryAskEvidenceSpan[],
  sourceTurnIds: string[]
) {
  return sortSpansBySourceOrder(spans, sourceTurnIds)
    .map((span) => normalizeSpace(span.text))
    .filter(Boolean)
    .join(" ");
}

function sortSpansBySourceOrder(
  spans: PrimaryAskEvidenceSpan[],
  sourceTurnIds: string[]
) {
  const turnOrder = new Map(
    sourceTurnIds.map((turnId, index) => [turnId, index])
  );
  return [...spans].sort((left, right) => {
    const leftTurn = turnOrder.get(left.turnId) ?? Number.MAX_SAFE_INTEGER;
    const rightTurn = turnOrder.get(right.turnId) ?? Number.MAX_SAFE_INTEGER;
    return leftTurn - rightTurn || left.start - right.start;
  });
}

function normalizeSpace(text: string) {
  return text.replace(/\s+/gu, " ").trim();
}

function spanKey(span: PrimaryAskEvidenceSpan) {
  return `${span.turnId}:${span.start}:${span.end}`;
}

function sameSpan(
  left: PrimaryAskEvidenceSpan,
  right: PrimaryAskEvidenceSpan
) {
  return spanKey(left) === spanKey(right);
}

function spansOverlap(
  left: PrimaryAskEvidenceSpan,
  right: PrimaryAskEvidenceSpan
) {
  return (
    left.turnId === right.turnId &&
    left.start < right.end &&
    right.start < left.end
  );
}

function collectSetupSpans({
  sourceSpans,
  primaryAskSpans,
  quotedOrFutureExampleSpans,
}: {
  sourceSpans: PrimaryAskEvidenceSpan[];
  primaryAskSpans: PrimaryAskEvidenceSpan[];
  quotedOrFutureExampleSpans: PrimaryAskEvidenceSpan[];
}) {
  const setupSpans: PrimaryAskEvidenceSpan[] = [];
  for (const sourceSpan of sourceSpans) {
    const excluded = [
      ...quotedOrFutureExampleSpans,
      ...primaryAskSpans,
    ]
      .filter((item) => spansOverlap(item, sourceSpan))
      .map((item) => ({
        start: Math.max(sourceSpan.start, item.start),
        end: Math.min(sourceSpan.end, item.end),
      }))
      .sort((left, right) => left.start - right.start);
    let cursor = sourceSpan.start;

    for (const range of excluded) {
      const setup = trimSpanRange(sourceSpan, cursor, range.start);
      if (setup && !isCoordinationOnlySetup(setup.text)) {
        setupSpans.push(setup);
      }
      cursor = Math.max(cursor, range.end);
    }

    const trailingSetup = trimSpanRange(
      sourceSpan,
      cursor,
      sourceSpan.end
    );
    if (
      trailingSetup &&
      !isCoordinationOnlySetup(trailingSetup.text)
    ) {
      setupSpans.push(trailingSetup);
    }
  }
  return setupSpans;
}

function isCoordinationOnlySetup(text: string) {
  const normalized = normalizeSpace(text)
    .toLowerCase()
    .replace(/[,:;.!?。！？—–-]+/gu, "")
    .trim();
  return normalized === "and" || normalized === "also";
}

function trimSpanRange(
  sourceSpan: PrimaryAskEvidenceSpan,
  start: number,
  end: number
) {
  if (end <= start) return undefined;
  const localStart = start - sourceSpan.start;
  const localEnd = end - sourceSpan.start;
  const raw = sourceSpan.text.slice(localStart, localEnd);
  const leading = raw.match(/^\s*/u)?.[0].length ?? 0;
  const trailing = raw.match(/\s*$/u)?.[0].length ?? 0;
  const trimmedStart = start + leading;
  const trimmedEnd = end - trailing;
  if (trimmedEnd <= trimmedStart) return undefined;
  return {
    turnId: sourceSpan.turnId,
    text: sourceSpan.text.slice(
      trimmedStart - sourceSpan.start,
      trimmedEnd - sourceSpan.start
    ),
    start: trimmedStart,
    end: trimmedEnd,
  };
}

function dedupeSpans(values: PrimaryAskEvidenceSpan[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = spanKey(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
