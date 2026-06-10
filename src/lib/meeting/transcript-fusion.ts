import { TranscriptTurn } from "./types";

export const PENDING_CONFIRMATION_TTL_MS = 10_000;
export const RECENT_ME_CLARIFICATION_WINDOW_MS = 30_000;

export interface MeTurnClassification {
  tier: NonNullable<TranscriptTurn["contextTier"]>;
  promptEligible: boolean;
  wordEquivalent: number;
  durationMs: number;
  hasClarificationSignal: boolean;
}

export interface ClarificationPairMatch {
  meTurn: TranscriptTurn;
  reason: string;
}

export interface DuplicateTranscriptDecision {
  suppress: boolean;
  confidence: "high" | "medium" | "low";
  matchedTurn?: TranscriptTurn;
  tokenJaccard: number;
  trigramDice: number;
  timeDeltaMs?: number;
  overlapRatio?: number;
  reason: string;
}

const CONFIRMATION_PHRASES = new Set([
  "yes",
  "yeah",
  "yep",
  "right",
  "correct",
  "exactly",
  "that's right",
  "that is right",
  "yes exactly",
  "no",
  "not exactly",
  "not really",
  "the first one",
  "the second one",
  "first one",
  "second one",
  "future design",
  "existing implementation",
  "current implementation",
  "implementation",
  "design",
  "对",
  "是",
  "是的",
  "没错",
  "不对",
  "不是",
  "第一个",
  "第二个",
]);

const FILLER_WORDS = new Set(["uh", "um", "er", "ah", "like"]);

export function classifyMeTurn(
  turn: TranscriptTurn,
  hasActiveTask: boolean
): MeTurnClassification {
  const wordEquivalent = calculateWordEquivalent(turn.text);
  const durationMs = Math.max(0, turn.endedAt - turn.startedAt);
  const hasClarificationSignal =
    hasClarificationOrCorrectionSignal(turn.text) ||
    (hasActiveTask &&
      wordEquivalent <= 8 &&
      hasStrongTechnicalToken(turn.text));

  if (wordEquivalent <= 45 && durationMs <= 12_000 && hasClarificationSignal) {
    return {
      tier: "me_clarification_short",
      promptEligible: true,
      wordEquivalent,
      durationMs,
      hasClarificationSignal,
    };
  }

  if (wordEquivalent <= 80 && durationMs <= 20_000 && hasClarificationSignal) {
    return {
      tier: "me_clarification_medium",
      promptEligible: false,
      wordEquivalent,
      durationMs,
      hasClarificationSignal,
    };
  }

  return {
    tier: "me_attempted_answer_long",
    promptEligible: false,
    wordEquivalent,
    durationMs,
    hasClarificationSignal,
  };
}

export function shouldIncludeTurnInAdvisorPrompt(turn: TranscriptTurn) {
  if (turn.contextFusionStatus === "duplicate-suppressed") return false;
  if (turn.speaker !== "me") return true;
  return turn.contextPromptEligible === true;
}

export function findRecentMeClarificationForTurn(
  themTurn: TranscriptTurn,
  previousTurns: TranscriptTurn[]
): ClarificationPairMatch | null {
  if (themTurn.speaker !== "them") return null;

  const recentMeTurns = previousTurns
    .filter((turn) => {
      if (turn.speaker !== "me") return false;
      if (themTurn.startedAt - turn.endedAt > RECENT_ME_CLARIFICATION_WINDOW_MS) {
        return false;
      }
      return (
        turn.contextTier === "me_clarification_short" ||
        turn.contextTier === "me_clarification_medium" ||
        hasClarificationOrCorrectionSignal(turn.text)
      );
    })
    .sort((left, right) => right.endedAt - left.endedAt);

  const meTurn = recentMeTurns[0];
  if (!meTurn) return null;

  if (isShortConfirmationLike(themTurn.text)) {
    return {
      meTurn,
      reason: "short-confirmation-after-me-clarification",
    };
  }

  if (
    meTurn.contextTier === "me_clarification_medium" &&
    calculateWordEquivalent(themTurn.text) <= 20
  ) {
    return {
      meTurn,
      reason: "short-supplement-after-medium-me-clarification",
    };
  }

  return null;
}

export function isShortConfirmationLike(text: string) {
  const normalized = normalizeSpeechText(text);
  if (!normalized) return false;
  if (CONFIRMATION_PHRASES.has(normalized)) return true;
  return calculateWordEquivalent(text) <= 6 && !/[?？]/.test(text);
}

export function shouldSuppressDuplicateSystemAudioTurn(
  turn: TranscriptTurn,
  previousTurns: TranscriptTurn[]
): DuplicateTranscriptDecision {
  if (turn.speaker !== "them" || turn.source !== "system-audio") {
    return lowDuplicateDecision("source-pair-mismatch");
  }

  const candidates = previousTurns
    .filter(
      (candidate) =>
        candidate.speaker === "me" && candidate.source === "microphone"
    )
    .slice(-8);

  let bestDecision = lowDuplicateDecision("no-microphone-candidate");

  for (const candidate of candidates) {
    const decision = compareTranscriptDuplicate(turn, candidate);
    if (decision.confidence === "high") return decision;
    if (
      decision.confidence === "medium" &&
      bestDecision.confidence === "low"
    ) {
      bestDecision = decision;
    }
  }

  return bestDecision;
}

export function findDuplicateSystemAudioTurnForMeTurn(
  turn: TranscriptTurn,
  previousTurns: TranscriptTurn[]
): DuplicateTranscriptDecision {
  if (turn.speaker !== "me" || turn.source !== "microphone") {
    return lowDuplicateDecision("source-pair-mismatch");
  }

  const candidates = previousTurns
    .filter(
      (candidate) =>
        candidate.speaker === "them" && candidate.source === "system-audio"
    )
    .slice(-8);

  let bestDecision = lowDuplicateDecision("no-system-audio-candidate");

  for (const candidate of candidates) {
    const decision = compareTranscriptDuplicate(candidate, turn);
    if (decision.confidence === "high") return decision;
    if (
      decision.confidence === "medium" &&
      bestDecision.confidence === "low"
    ) {
      bestDecision = decision;
    }
  }

  return bestDecision;
}

export function calculateWordEquivalent(text: string) {
  const englishWordCount = text.match(/[A-Za-z0-9+#.]+/g)?.length ?? 0;
  const cjkCharacterCount =
    text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)
      ?.length ?? 0;

  return englishWordCount + Math.ceil(cjkCharacterCount / 2);
}

function compareTranscriptDuplicate(
  systemTurn: TranscriptTurn,
  micTurn: TranscriptTurn
): DuplicateTranscriptDecision {
  const systemWordEquivalent = calculateWordEquivalent(systemTurn.text);
  const micWordEquivalent = calculateWordEquivalent(micTurn.text);
  const normalizedSystem = normalizeSpeechText(systemTurn.text);
  const normalizedMic = normalizeSpeechText(micTurn.text);

  if (
    systemWordEquivalent < 5 ||
    micWordEquivalent < 5 ||
    normalizedSystem.length < 24 ||
    normalizedMic.length < 24
  ) {
    return lowDuplicateDecision("too-short-to-suppress", micTurn);
  }

  if (
    isShortConfirmationLike(systemTurn.text) ||
    isShortConfirmationLike(micTurn.text)
  ) {
    return lowDuplicateDecision("short-confirmation-not-suppressed", micTurn);
  }

  const timing = compareTurnTiming(systemTurn, micTurn);
  const tokenJaccard = calculateTokenJaccard(normalizedSystem, normalizedMic);
  const trigramDice = calculateTrigramDice(normalizedSystem, normalizedMic);
  const stricter = Math.min(systemWordEquivalent, micWordEquivalent) <= 10;
  const similarityPass =
    normalizedSystem === normalizedMic ||
    (stricter
      ? tokenJaccard >= 0.9 && trigramDice >= 0.9
      : tokenJaccard >= 0.82 && trigramDice >= 0.86);

  if (!similarityPass) {
    return {
      suppress: false,
      confidence: "low",
      matchedTurn: micTurn,
      tokenJaccard,
      trigramDice,
      timeDeltaMs: timing.timeDeltaMs,
      overlapRatio: timing.overlapRatio,
      reason: "similarity-below-threshold",
    };
  }

  if (timing.strong) {
    return {
      suppress: true,
      confidence: "high",
      matchedTurn: micTurn,
      tokenJaccard,
      trigramDice,
      timeDeltaMs: timing.timeDeltaMs,
      overlapRatio: timing.overlapRatio,
      reason: timing.reason,
    };
  }

  if (timing.weak) {
    return {
      suppress: false,
      confidence: "medium",
      matchedTurn: micTurn,
      tokenJaccard,
      trigramDice,
      timeDeltaMs: timing.timeDeltaMs,
      overlapRatio: timing.overlapRatio,
      reason: timing.reason,
    };
  }

  return {
    suppress: false,
    confidence: "low",
    matchedTurn: micTurn,
    tokenJaccard,
    trigramDice,
    timeDeltaMs: timing.timeDeltaMs,
    overlapRatio: timing.overlapRatio,
    reason: timing.reason,
  };
}

function compareTurnTiming(left: TranscriptTurn, right: TranscriptTurn) {
  const startDeltaMs = Math.abs(left.startedAt - right.startedAt);
  const endDeltaMs = Math.abs(left.endedAt - right.endedAt);
  const overlapRatio = calculateOverlapRatio(left, right);

  if (overlapRatio >= 0.4) {
    return {
      strong: true,
      weak: true,
      timeDeltaMs: startDeltaMs,
      overlapRatio,
      reason: "speech-interval-overlap",
    };
  }

  if (startDeltaMs <= 2_500) {
    return {
      strong: true,
      weak: true,
      timeDeltaMs: startDeltaMs,
      overlapRatio,
      reason: "start-time-close",
    };
  }

  if (endDeltaMs <= 5_000) {
    return {
      strong: false,
      weak: true,
      timeDeltaMs: endDeltaMs,
      overlapRatio,
      reason: "fallback-end-time-close",
    };
  }

  return {
    strong: false,
    weak: false,
    timeDeltaMs: Math.min(startDeltaMs, endDeltaMs),
    overlapRatio,
    reason: "time-distance-too-large",
  };
}

function calculateOverlapRatio(left: TranscriptTurn, right: TranscriptTurn) {
  const latestStart = Math.max(left.startedAt, right.startedAt);
  const earliestEnd = Math.min(left.endedAt, right.endedAt);
  const overlapMs = Math.max(0, earliestEnd - latestStart);
  const shorterDurationMs = Math.max(
    1,
    Math.min(left.endedAt - left.startedAt, right.endedAt - right.startedAt)
  );

  return overlapMs / shorterDurationMs;
}

function hasClarificationOrCorrectionSignal(text: string) {
  return (
    /[?？]/.test(text) ||
    /\b(when you say|do you mean|you mean|is it|are you asking|did you mean|not|instead of|rather than|i mean|sorry|correction)\b/i.test(
      text
    ) ||
    /\b\w+\s+or\s+\w+\b/i.test(text) ||
    /你的意思是|你是说|是不是|不是|还是|我意思是/.test(text)
  );
}

function hasStrongTechnicalToken(text: string) {
  return /\b(RAG|Glean|AOS|Kafka|Redis|TypeScript|JavaScript|LLM|SQL|API|RPC|gRPC|HTTP|AWS|OpenAI)\b/.test(
    text
  );
}

function normalizeSpeechText(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token && !FILLER_WORDS.has(token))
    .join(" ")
    .trim();
}

function calculateTokenJaccard(left: string, right: string) {
  const leftTokens = new Set(left.split(/\s+/).filter(Boolean));
  const rightTokens = new Set(right.split(/\s+/).filter(Boolean));
  const union = new Set([...leftTokens, ...rightTokens]);
  if (!union.size) return 0;

  let intersection = 0;
  leftTokens.forEach((token) => {
    if (rightTokens.has(token)) intersection += 1;
  });

  return intersection / union.size;
}

function calculateTrigramDice(left: string, right: string) {
  const leftTrigrams = buildTrigramSet(left);
  const rightTrigrams = buildTrigramSet(right);
  const denominator = leftTrigrams.size + rightTrigrams.size;
  if (!denominator) return 0;

  let intersection = 0;
  leftTrigrams.forEach((trigram) => {
    if (rightTrigrams.has(trigram)) intersection += 1;
  });

  return (2 * intersection) / denominator;
}

function buildTrigramSet(text: string) {
  const padded = `  ${text}  `;
  const trigrams = new Set<string>();

  for (let index = 0; index < padded.length - 2; index += 1) {
    trigrams.add(padded.slice(index, index + 3));
  }

  return trigrams;
}

function lowDuplicateDecision(
  reason: string,
  matchedTurn?: TranscriptTurn
): DuplicateTranscriptDecision {
  return {
    suppress: false,
    confidence: "low",
    matchedTurn,
    tokenJaccard: 0,
    trigramDice: 0,
    reason,
  };
}
