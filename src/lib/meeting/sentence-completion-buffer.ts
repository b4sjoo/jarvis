export const SENTENCE_COMPLETION_BUFFER_MS = 2_000;

export type SentenceCompletionDisposition = "bypass" | "buffer";

export interface SentenceCompletionDecision {
  disposition: SentenceCompletionDisposition;
  confidence: number;
  reason: string;
  evidence: string[];
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
