export const RESPONSE_OPPORTUNITY_SCHEMA_VERSION = 3;
export const RESPONSE_OPPORTUNITY_PROMPT_VERSION =
  "response-opportunity-v3-compact";
export const RESPONSE_OPPORTUNITY_COMPACT_OUTPUT_WORST_CASE =
  JSON.stringify({
    v: RESPONSE_OPPORTUNITY_SCHEMA_VERSION,
    d: "u",
    c: 1,
    e: [0, 1],
    r: "bounded-source-insufficient",
  });
export const RESPONSE_OPPORTUNITY_MAX_OUTPUT_CHARS =
  RESPONSE_OPPORTUNITY_COMPACT_OUTPUT_WORST_CASE.length + 64;
// Runtime providers tokenize JSON differently. Two characters per token plus
// fixed headroom safely contains the worst legal compact response.
export const RESPONSE_OPPORTUNITY_MAX_OUTPUT_TOKENS = Math.max(
  128,
  Math.ceil(RESPONSE_OPPORTUNITY_MAX_OUTPUT_CHARS / 2) + 16
);
export const RESPONSE_OPPORTUNITY_MAX_SOURCE_CHARS = 1_800;

export interface ResponseOpportunitySourceSpan {
  turnId: string;
  text: string;
}

export interface ResponseOpportunityRequest {
  schemaVersion: 3;
  promptVersion: string;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  currentTurnId: string;
  sourceHash: string;
  sourceSpans: ResponseOpportunitySourceSpan[];
  manualForceAdvise: boolean;
}

interface ResponseOpportunityLogicalQuestionUnitInput {
  id: string;
  revision: number;
  currentTurnId: string;
  sources: Array<{ turnId: string; text: string }>;
}

export function buildResponseOpportunityRequest(input: {
  logicalQuestionUnit: ResponseOpportunityLogicalQuestionUnitInput;
  manualForceAdvise?: boolean;
}): ResponseOpportunityRequest {
  const selectedSources = input.logicalQuestionUnit.sources.slice(-2);
  let remainingChars = RESPONSE_OPPORTUNITY_MAX_SOURCE_CHARS;
  const sourceSpans: ResponseOpportunitySourceSpan[] = [];
  for (const [index, source] of selectedSources.entries()) {
    if (remainingChars <= 0) break;
    const isCurrent =
      source.turnId === input.logicalQuestionUnit.currentTurnId;
    const laterSourceCount = selectedSources.length - index - 1;
    const reserveForLater = Math.min(
      remainingChars,
      laterSourceCount * 600
    );
    const available = Math.max(1, remainingChars - reserveForLater);
    const text = projectBoundedSourceText(
      source.text,
      Math.min(available, isCurrent ? 1_200 : 600)
    );
    if (!text) continue;
    sourceSpans.push({ turnId: source.turnId, text });
    remainingChars -= text.length;
  }
  const sourceHash = hashResponseOpportunityEvidence(sourceSpans);
  return {
    schemaVersion: RESPONSE_OPPORTUNITY_SCHEMA_VERSION,
    promptVersion: RESPONSE_OPPORTUNITY_PROMPT_VERSION,
    logicalQuestionUnitId: input.logicalQuestionUnit.id,
    logicalQuestionUnitRevision: input.logicalQuestionUnit.revision,
    currentTurnId: input.logicalQuestionUnit.currentTurnId,
    sourceHash,
    sourceSpans,
    manualForceAdvise: input.manualForceAdvise ?? false,
  };
}

export function hashResponseOpportunityEvidence(
  sourceSpans: ResponseOpportunitySourceSpan[]
) {
  let hash = 2_166_136_261;
  for (const character of sourceSpans
    .flatMap((span) => [span.turnId, span.text])
    .join("\u001f")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function projectBoundedSourceText(text: string, maxChars: number) {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const marker = "\n...[source omitted]...\n";
  const available = Math.max(2, maxChars - marker.length);
  const headChars = Math.min(300, Math.floor(available / 3));
  const tailChars = available - headChars;
  return `${trimmed.slice(0, headChars)}${marker}${trimmed.slice(-tailChars)}`;
}
