export const SENTENCE_COMPLETION_BUFFER_MS = 3_250;
export const SENTENCE_COMPLETION_EXTENSION_MS = 1_500;
export const SENTENCE_COMPLETION_ABSOLUTE_MAX_MS = 4_000;

export type SentenceCompletionDisposition = "bypass" | "buffer";

export interface SentenceCompletionDecision {
  disposition: SentenceCompletionDisposition;
  confidence: number;
  reason: string;
  evidence: string[];
}

export type SentenceCompletionContinuationRejectionReason =
  | "extension-already-used"
  | "unsupported-source"
  | "missing-native-identity"
  | "capture-session-mismatch"
  | "capture-generation-mismatch"
  | "candidate-sequence-mismatch"
  | "speech-start-before-source-segment"
  | "speech-start-after-initial-deadline"
  | "absolute-deadline-expired";

export type SentenceCompletionContinuationDecision =
  | {
      authorized: true;
      reason: "matching-native-speech-start";
      deadlineAt: number;
      extensionBudgetMs: number;
      absoluteDeadlineAt: number;
    }
  | {
      authorized: false;
      reason: SentenceCompletionContinuationRejectionReason;
      absoluteDeadlineAt: number;
    };

export function decideSentenceCompletionContinuation({
  pending,
  speechStart,
  now,
}: {
  pending: {
    source: string;
    heldAt: number;
    firstHeldAt: number;
    extensionUsed: boolean;
    nativeCaptureSessionId?: string;
    nativeCaptureGeneration?: number;
    nativeSegmentSequence?: number;
    nativeCapturedAtMs?: number;
  };
  speechStart: {
    source: string;
    captureSessionId: string;
    captureGeneration: number;
    candidateSegmentSequence: number;
    occurredAtMs: number;
  };
  now: number;
}): SentenceCompletionContinuationDecision {
  const absoluteDeadlineAt =
    pending.firstHeldAt + SENTENCE_COMPLETION_ABSOLUTE_MAX_MS;
  if (pending.extensionUsed) {
    return {
      authorized: false,
      reason: "extension-already-used",
      absoluteDeadlineAt,
    };
  }
  if (
    pending.source !== "system-audio" ||
    speechStart.source !== pending.source
  ) {
    return {
      authorized: false,
      reason: "unsupported-source",
      absoluteDeadlineAt,
    };
  }
  if (
    !pending.nativeCaptureSessionId ||
    pending.nativeCaptureGeneration == null ||
    pending.nativeSegmentSequence == null
  ) {
    return {
      authorized: false,
      reason: "missing-native-identity",
      absoluteDeadlineAt,
    };
  }
  if (speechStart.captureSessionId !== pending.nativeCaptureSessionId) {
    return {
      authorized: false,
      reason: "capture-session-mismatch",
      absoluteDeadlineAt,
    };
  }
  if (speechStart.captureGeneration !== pending.nativeCaptureGeneration) {
    return {
      authorized: false,
      reason: "capture-generation-mismatch",
      absoluteDeadlineAt,
    };
  }
  if (
    speechStart.candidateSegmentSequence !==
    pending.nativeSegmentSequence + 1
  ) {
    return {
      authorized: false,
      reason: "candidate-sequence-mismatch",
      absoluteDeadlineAt,
    };
  }
  if (
    pending.nativeCapturedAtMs != null &&
    speechStart.occurredAtMs < pending.nativeCapturedAtMs
  ) {
    return {
      authorized: false,
      reason: "speech-start-before-source-segment",
      absoluteDeadlineAt,
    };
  }
  if (
    speechStart.occurredAtMs >
    pending.heldAt + SENTENCE_COMPLETION_BUFFER_MS
  ) {
    return {
      authorized: false,
      reason: "speech-start-after-initial-deadline",
      absoluteDeadlineAt,
    };
  }
  if (now >= absoluteDeadlineAt) {
    return {
      authorized: false,
      reason: "absolute-deadline-expired",
      absoluteDeadlineAt,
    };
  }

  const deadlineAt = Math.min(
    now + SENTENCE_COMPLETION_EXTENSION_MS,
    absoluteDeadlineAt
  );
  return {
    authorized: true,
    reason: "matching-native-speech-start",
    deadlineAt,
    extensionBudgetMs: Math.max(0, deadlineAt - now),
    absoluteDeadlineAt,
  };
}

export function decideSentenceCompletion(
  text: string
): SentenceCompletionDecision {
  const trimmed = text.trim();
  if (!trimmed) {
    return bypassDecision("empty-transcript", ["empty-transcript"]);
  }

  const normalized = normalizeSentenceFragment(trimmed);

  if (hasCompleteQuestionMarker(trimmed)) {
    return bypassDecision("complete-question-marker", ["question-marker"]);
  }

  if (hasImmediateBypassSignal(normalized)) {
    return bypassDecision("explicit-action-or-constraint", [
      "explicit-action-or-constraint",
    ]);
  }

  if (/(?:\.{2,}|…+)\s*$/.test(trimmed)) {
    return bufferDecision("trailing-ellipsis", ["trailing-ellipsis"]);
  }

  if (/[:：]\s*$/.test(trimmed)) {
    return bufferDecision("trailing-introduction", [
      "trailing-introduction",
    ]);
  }

  if (
    /^(?:the next one is|my next question is|the question is|can you (?:describe|explain|tell me|walk me through)|could you (?:describe|explain|tell me|walk me through)|would you (?:describe|explain|tell me|walk me through)|tell me about|walk me through|talk me through|what about|how about)$/i.test(
      normalized
    )
  ) {
    return bufferDecision("unfinished-ask-frame", ["unfinished-ask-frame"]);
  }

  if (
    normalized.split(/\s+/).length >= 3 &&
    /\b(?:because|although|though|unless|until|if|while|and|or|but|so|then)\s*$/i.test(
      normalized
    )
  ) {
    return bufferDecision("trailing-connector", ["trailing-connector"]);
  }

  if (
    /\b(?:from|with|about|for|of|to|regarding)\s+(?:the|a|an|my|your|our|their)\s*$/i.test(
      normalized
    )
  ) {
    return bufferDecision("unfinished-prepositional-phrase", [
      "unfinished-prepositional-phrase",
    ]);
  }

  return bypassDecision("no-incomplete-signal", ["no-incomplete-signal"]);
}

export function mergeSentenceFragments(fragments: string[]) {
  return fragments
    .map((fragment) =>
      fragment
        .trim()
        .replace(/(?:\.{2,}|…+)\s*$/, "")
        .trim()
    )
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasCompleteQuestionMarker(text: string) {
  return /[?？]\s*$/.test(text) && !/(?:\.{2,}|…+)\s*$/.test(text);
}

function hasImmediateBypassSignal(normalized: string) {
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  const explicitTask =
    /^(?:please )?(?:design|implement|write|code|solve|compare|estimate|evaluate|outline|propose|create|sketch)\b/i.test(
      normalized
    ) ||
    /^(?:can|could|would) you (?:design|implement|write|code|solve|compare|estimate|evaluate|outline|propose|create|sketch)\b/i.test(
      normalized
    );
  const completeDirectFrame =
    wordCount >= 4 &&
    /^(?:can|could|would|will|do|does|did|is|are|was|were|have|has|had|how|what|why|when|where|which|who)\b|^(?:tell me|give me|show me|walk me through|talk me through|describe|explain)\b/i.test(
      normalized
    );
  return (
    /\b(?:actually|correction|i mean|instead of|rather than|assume|given that|must support|needs to support|constraint|requirement)\b/i.test(
      normalized
    ) ||
    explicitTask ||
    completeDirectFrame ||
    /其实|更正|我的意思是|假设|约束|要求|设计|实现|编写|解决|比较|估算/.test(
      normalized
    )
  );
}

function normalizeSentenceFragment(text: string) {
  return text
    .toLowerCase()
    .replace(/[’']/g, " ")
    .replace(/[^\p{L}\p{N}+#.?:：？]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bypassDecision(reason: string, evidence: string[]) {
  return {
    disposition: "bypass" as const,
    confidence: 0.99,
    reason,
    evidence,
  };
}

function bufferDecision(reason: string, evidence: string[]) {
  return {
    disposition: "buffer" as const,
    confidence: 0.95,
    reason,
    evidence,
  };
}
