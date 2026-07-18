const DEFAULT_PROMPT_ECHO_SIMILARITY_THRESHOLD = 0.72;
const MIN_PROMPT_ECHO_CHARS = 80;
const MIN_PROMPT_ECHO_TOKENS = 12;
const MIN_PARTIAL_PROMPT_ECHO_RATIO = 0.35;
const SUSPICIOUS_DENSITY_MIN_CHARS = 160;
const SUSPICIOUS_DENSITY_MAX_DURATION_MS = 3_000;
const SUSPICIOUS_DENSITY_CHARS_PER_SECOND = 80;
const PROVIDER_SENTINELS = new Set(["no transcription found"]);
const PROVIDER_WARNINGS = new Set(["audio exceeds 10mb limit"]);

export type TranscriptValidationDisposition =
  | "accepted"
  | "empty"
  | "rejected";

export type TranscriptValidationReason =
  | "valid"
  | "empty"
  | "provider-sentinel"
  | "provider-warning"
  | "prompt-echo-exact"
  | "prompt-echo-similar";

export interface TranscriptValidationDecision {
  disposition: TranscriptValidationDisposition;
  reason: TranscriptValidationReason;
  promptSimilarity: number;
  normalizedTranscriptChars: number;
  normalizedPromptChars: number;
  audioDurationMs?: number;
  transcriptCharsPerSecond?: number;
  densitySuspicious: boolean;
}

export interface ValidateTranscriptCandidateInput {
  text: string;
  speechBiasPrompt?: string;
  startedAt?: number;
  endedAt?: number;
  similarityThreshold?: number;
}

export function validateTranscriptCandidate({
  text,
  speechBiasPrompt,
  startedAt,
  endedAt,
  similarityThreshold = DEFAULT_PROMPT_ECHO_SIMILARITY_THRESHOLD,
}: ValidateTranscriptCandidateInput): TranscriptValidationDecision {
  const normalizedText = normalizeValidationText(text);
  const normalizedPrompt = normalizeValidationText(speechBiasPrompt ?? "");
  const audioDurationMs = readDurationMs(startedAt, endedAt);
  const transcriptCharsPerSecond = readCharsPerSecond(
    normalizedText.length,
    audioDurationMs
  );
  const densitySuspicious = isSuspiciousOutputDensity(
    normalizedText.length,
    audioDurationMs,
    transcriptCharsPerSecond
  );

  if (!normalizedText) {
    return buildDecision({
      disposition: "empty",
      reason: "empty",
      normalizedText,
      normalizedPrompt,
      audioDurationMs,
      transcriptCharsPerSecond,
      densitySuspicious,
    });
  }

  const providerDiagnosticReason = classifyProviderDiagnostic(text);
  if (providerDiagnosticReason) {
    return buildDecision({
      disposition: "rejected",
      reason: providerDiagnosticReason,
      normalizedText,
      normalizedPrompt,
      audioDurationMs,
      transcriptCharsPerSecond,
      densitySuspicious,
    });
  }

  if (!isLongEnoughForPromptEcho(normalizedText)) {
    return buildDecision({
      disposition: "accepted",
      reason: "valid",
      normalizedText,
      normalizedPrompt,
      audioDurationMs,
      transcriptCharsPerSecond,
      densitySuspicious,
    });
  }

  if (normalizedPrompt && normalizedText === normalizedPrompt) {
    return buildDecision({
      disposition: "rejected",
      reason: "prompt-echo-exact",
      promptSimilarity: 1,
      normalizedText,
      normalizedPrompt,
      audioDurationMs,
      transcriptCharsPerSecond,
      densitySuspicious,
    });
  }

  const promptSimilarity = normalizedPrompt
    ? tokenBigramDice(normalizedText, normalizedPrompt)
    : 0;
  const partialEcho = isSubstantialPromptSubstring(
    normalizedText,
    normalizedPrompt
  );

  if (
    normalizedPrompt &&
    (partialEcho || promptSimilarity >= clampThreshold(similarityThreshold))
  ) {
    return buildDecision({
      disposition: "rejected",
      reason: "prompt-echo-similar",
      promptSimilarity,
      normalizedText,
      normalizedPrompt,
      audioDurationMs,
      transcriptCharsPerSecond,
      densitySuspicious,
    });
  }

  return buildDecision({
    disposition: "accepted",
    reason: "valid",
    promptSimilarity,
    normalizedText,
    normalizedPrompt,
    audioDurationMs,
    transcriptCharsPerSecond,
    densitySuspicious,
  });
}

function classifyProviderDiagnostic(
  rawText: string
): Extract<
  TranscriptValidationReason,
  "provider-sentinel" | "provider-warning"
> | null {
  const segments = rawText
    .split(";")
    .map(normalizeProviderDiagnosticSegment)
    .filter(Boolean);
  if (segments.length === 0) return null;

  const hasSentinel = segments.some((segment) =>
    PROVIDER_SENTINELS.has(segment)
  );
  const hasWarning = segments.some((segment) =>
    PROVIDER_WARNINGS.has(segment)
  );
  const onlyProviderDiagnostics = segments.every(
    (segment) =>
      PROVIDER_SENTINELS.has(segment) || PROVIDER_WARNINGS.has(segment)
  );

  if (!onlyProviderDiagnostics) return null;
  if (hasWarning) return "provider-warning";
  return hasSentinel ? "provider-sentinel" : null;
}

function normalizeProviderDiagnosticSegment(value: string) {
  return normalizeValidationText(value).replace(/[.]+$/g, "").trim();
}

function normalizeValidationText(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, '"')
    .replace(/[^\p{L}\p{N}+#.]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLongEnoughForPromptEcho(normalizedText: string) {
  return (
    normalizedText.length >= MIN_PROMPT_ECHO_CHARS &&
    tokenize(normalizedText).length >= MIN_PROMPT_ECHO_TOKENS
  );
}

function isSubstantialPromptSubstring(text: string, prompt: string) {
  if (!text || !prompt) return false;
  const shorterLength = Math.min(text.length, prompt.length);
  const longerLength = Math.max(text.length, prompt.length);
  if (shorterLength / longerLength < MIN_PARTIAL_PROMPT_ECHO_RATIO) {
    return false;
  }
  return text.includes(prompt) || prompt.includes(text);
}

function tokenBigramDice(left: string, right: string) {
  const leftBigrams = buildTokenBigrams(tokenize(left));
  const rightBigrams = buildTokenBigrams(tokenize(right));
  const leftCount = countValues(leftBigrams);
  const rightCount = countValues(rightBigrams);
  if (!leftCount || !rightCount) return left === right ? 1 : 0;

  let intersection = 0;
  for (const [bigram, count] of leftBigrams) {
    intersection += Math.min(count, rightBigrams.get(bigram) ?? 0);
  }

  return roundScore((2 * intersection) / (leftCount + rightCount));
}

function tokenize(value: string) {
  return value.split(" ").filter(Boolean);
}

function buildTokenBigrams(tokens: string[]) {
  const bigrams = new Map<string, number>();
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const bigram = `${tokens[index]}\u0000${tokens[index + 1]}`;
    bigrams.set(bigram, (bigrams.get(bigram) ?? 0) + 1);
  }
  return bigrams;
}

function countValues(values: Map<string, number>) {
  let count = 0;
  for (const value of values.values()) count += value;
  return count;
}

function readDurationMs(startedAt?: number, endedAt?: number) {
  if (
    typeof startedAt !== "number" ||
    typeof endedAt !== "number" ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(endedAt) ||
    endedAt <= startedAt
  ) {
    return undefined;
  }
  return endedAt - startedAt;
}

function readCharsPerSecond(chars: number, durationMs?: number) {
  if (!durationMs) return undefined;
  return roundScore(chars / (durationMs / 1_000));
}

function isSuspiciousOutputDensity(
  chars: number,
  durationMs?: number,
  charsPerSecond?: number
) {
  return Boolean(
    chars >= SUSPICIOUS_DENSITY_MIN_CHARS &&
      durationMs &&
      durationMs <= SUSPICIOUS_DENSITY_MAX_DURATION_MS &&
      charsPerSecond &&
      charsPerSecond >= SUSPICIOUS_DENSITY_CHARS_PER_SECOND
  );
}

function clampThreshold(value: number) {
  if (!Number.isFinite(value)) {
    return DEFAULT_PROMPT_ECHO_SIMILARITY_THRESHOLD;
  }
  return Math.min(1, Math.max(0, value));
}

function roundScore(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function buildDecision({
  disposition,
  reason,
  promptSimilarity = 0,
  normalizedText,
  normalizedPrompt,
  audioDurationMs,
  transcriptCharsPerSecond,
  densitySuspicious,
}: {
  disposition: TranscriptValidationDisposition;
  reason: TranscriptValidationReason;
  promptSimilarity?: number;
  normalizedText: string;
  normalizedPrompt: string;
  audioDurationMs?: number;
  transcriptCharsPerSecond?: number;
  densitySuspicious: boolean;
}): TranscriptValidationDecision {
  return {
    disposition,
    reason,
    promptSimilarity: roundScore(promptSimilarity),
    normalizedTranscriptChars: normalizedText.length,
    normalizedPromptChars: normalizedPrompt.length,
    audioDurationMs,
    transcriptCharsPerSecond,
    densitySuspicious,
  };
}
