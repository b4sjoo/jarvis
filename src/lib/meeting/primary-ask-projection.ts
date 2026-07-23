import type {
  AdvisorTurnIntent,
  AdvisorTurnIntentDecision,
} from "./advisor-turn-intent.js";

export const PRIMARY_ASK_PROJECTION_SCHEMA_VERSION = 1;

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
  disposition: PrimaryAskDisposition;
  reason: string;
  confidence: number;
}

export interface ProjectPrimaryAskInput {
  turnId: string;
  text: string;
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
  const askCandidates: PrimaryAskEvidenceSpan[] = [];
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
      ? extractDirectAskAfterTransition(span, explicitCurrentTransition.end)
      : extractDirectAskSpan(span);
    const negativeFrame = hasQuotedOrFutureFrame(
      transitionSpan?.text ?? span.text
    );
    const currentRecipient = hasCurrentRecipientSignal(
      candidate?.text ?? span.text
    );
    const carriedExample =
      futureExampleCarry > 0 &&
      Boolean(candidate) &&
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

    if (candidate) {
      askCandidates.push(candidate);
      futureExampleCarry = 0;
      continue;
    }

    if (futureExampleCarry > 0) {
      futureExampleCarry -= 1;
    }
  }

  const primaryAsk = askCandidates[askCandidates.length - 1];
  if (primaryAsk) {
    const primaryAskSpans = [primaryAsk];
    const setupSpans = collectSetupSpans({
      sourceSpans,
      primaryAskSpans,
      quotedOrFutureExampleSpans,
    });
    return projection({
      sourceTurnIds: [turnId],
      sourceChars: text.length,
      speechAct: isDirective(primaryAsk.text) ? "directive" : "question",
      normalizedPrimaryAsk: normalizeSpace(primaryAsk.text),
      primaryAskSpans,
      setupSpans,
      quotedOrFutureExampleSpans,
      disposition: "answer-primary-ask",
      reason:
        quotedOrFutureExampleSpans.length > 0
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
  return {
    ...current,
    sourceTurnIds: unique([
      ...previous.sourceTurnIds,
      ...current.sourceTurnIds,
    ]),
    sourceChars: previous.sourceChars + current.sourceChars,
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
  };
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
  return projection.normalizedPrimaryAsk ?? fallback;
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
    primaryAskSourceTurnIds: value.sourceTurnIds,
    primaryAskSourceChars: value.sourceChars,
    primaryAskSpanCount: value.primaryAskSpans.length,
    primaryAskSetupSpanCount: value.setupSpans.length,
    primaryAskQuotedOrFutureSpanCount:
      value.quotedOrFutureExampleSpans.length,
    primaryAskSpans: value.primaryAskSpans,
    primaryAskSetupSpans: value.setupSpans,
    primaryAskQuotedOrFutureSpans: value.quotedOrFutureExampleSpans,
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

const DIRECT_ASK_HEAD_PATTERN =
  /(?:(?:can|could|would|will|do|does|did|is|are|was|were|have|has|had|should)\s+(?:you|your|this|that|it|there)\b|(?:how|what|why|when|where|which|who|whether)\b|(?:tell|walk|talk|give|show|explain|describe|outline|propose|design|create|sketch|implement|write|code|solve|compare|estimate|evaluate|discuss|share)\b|(?:请|怎么|如何|为什么|什么|是否|哪里|哪个|解释|描述|设计|实现|编写|估算|比较))/giu;

const DIRECT_ASK_PATTERN =
  /(?:^|(?:\b(?:but|so|now|then|okay|with that|given that|my question is|for you|before we finish)\b[\s,:-]*))(?<ask>(?:(?:can|could|would|will|do|does|did|is|are|was|were|have|has|had|should)\s+(?:you|your|this|that|it|there)\b|(?:how|what|why|when|where|which|who|whether)\b|(?:tell|walk|talk|give|show|explain|describe|outline|propose|design|create|sketch|implement|write|code|solve|compare|estimate|evaluate|discuss|share)\b|(?:请|怎么|如何|为什么|什么|是否|哪里|哪个|解释|描述|设计|实现|编写|估算|比较)))/giu;

function isDirectAskText(candidate: string, wholeSpan: string) {
  const normalized = normalizeSpace(candidate);
  if (!normalized) return false;
  if (hasQuotedOrFutureFrame(wholeSpan) && !hasCurrentRecipientSignal(candidate)) {
    return false;
  }
  if (/[?？]\s*$/.test(wholeSpan)) return true;
  return /^(?:tell|walk|talk|give|show|explain|describe|outline|propose|design|create|sketch|implement|write|code|solve|compare|estimate|evaluate|discuss|share|请|解释|描述|设计|实现|编写|估算|比较)\b/iu.test(
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
    /^(?:ah|eh|er|hmm|mm|mhm|uh|um|yeah|yep|yes|no|ok|okay|right|sure|cool|great|nice|perfect|thanks|thank you)[.!]?$/i.test(
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

function isDirective(text: string) {
  return /^(?:tell|walk|talk|give|show|explain|describe|outline|propose|design|create|sketch|implement|write|code|solve|compare|estimate|evaluate|discuss|share|请|解释|描述|设计|实现|编写|估算|比较)\b/iu.test(
    normalizeSpace(text)
  );
}

function projection(
  value: Omit<
    PrimaryAskProjection,
    "schemaVersion" | "primaryAskSpans"
  > & {
    primaryAskSpans?: PrimaryAskEvidenceSpan[];
  }
): PrimaryAskProjection {
  return {
    schemaVersion: PRIMARY_ASK_PROJECTION_SCHEMA_VERSION,
    primaryAskSpans: value.primaryAskSpans ?? [],
    ...value,
  };
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
      if (setup) setupSpans.push(setup);
      cursor = Math.max(cursor, range.end);
    }

    const trailingSetup = trimSpanRange(
      sourceSpan,
      cursor,
      sourceSpan.end
    );
    if (trailingSetup) setupSpans.push(trailingSetup);
  }
  return setupSpans;
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
