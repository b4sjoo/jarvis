export const RESPONSE_OPPORTUNITY_SCHEMA_VERSION = 4;
export const RESPONSE_OPPORTUNITY_PROMPT_VERSION =
  "response-opportunity-v4-decision-target";
export const RESPONSE_OPPORTUNITY_COMPACT_OUTPUT_WORST_CASE =
  JSON.stringify({
    v: RESPONSE_OPPORTUNITY_SCHEMA_VERSION,
    d: "u",
    c: 1,
    t: [0, 1, 2, 3],
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
export const RESPONSE_OPPORTUNITY_MAX_CLARIFICATION_CHARS = 280;
export const RESPONSE_OPPORTUNITY_MAX_DECISION_SPANS = 12;
export const RESPONSE_OPPORTUNITY_MAX_TARGET_SPANS = 4;

export interface ResponseOpportunityDecisionSpan {
  turnId: string;
  text: string;
}

export interface ResponseOpportunityRequest {
  schemaVersion: 4;
  promptVersion: string;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  currentTurnId: string;
  sourceHash: string;
  decisionSpans: ResponseOpportunityDecisionSpan[];
  boundedContext: string;
  contextCapsule?: ResponseOpportunityContextCapsule;
  manualForceAdvise: boolean;
}

export interface ResponseOpportunityContextCapsule {
  pendingClarification: {
    summary: string;
    supportStatus: "final-output-authorized";
    logicalQuestionUnitId?: string;
    logicalQuestionUnitRevision?: number;
    parentId?: string;
    playbookPhase?: string;
    createdAt: number;
    unresolved: true;
  };
}

export interface ResponseOpportunitySemanticPayload {
  decisionSpans: Array<{
    index: number;
    text: string;
  }>;
  boundedContext: string;
  pendingClarification?: {
    summary: string;
  };
}

interface ResponseOpportunityLogicalQuestionUnitInput {
  id: string;
  revision: number;
  currentTurnId: string;
  sources: Array<{ turnId: string; text: string }>;
}

export function buildResponseOpportunityRequest(input: {
  logicalQuestionUnit: ResponseOpportunityLogicalQuestionUnitInput;
  effectiveSources?: Array<{ turnId: string; text: string }>;
  contextCapsule?: ResponseOpportunityContextCapsule;
  manualForceAdvise?: boolean;
}): ResponseOpportunityRequest {
  const selectedSources = (
    input.effectiveSources ?? input.logicalQuestionUnit.sources
  ).slice(-2);
  let remainingChars = RESPONSE_OPPORTUNITY_MAX_SOURCE_CHARS;
  const boundedSources: ResponseOpportunityDecisionSpan[] = [];
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
    boundedSources.push({ turnId: source.turnId, text });
    remainingChars -= text.length;
  }
  const boundedContext = boundedSources
    .map((source) => source.text)
    .join("\n")
    .trim();
  const decisionSpans = boundedSources
    .flatMap(splitResponseOpportunityDecisionSpans)
    .slice(-RESPONSE_OPPORTUNITY_MAX_DECISION_SPANS);
  const contextCapsule = cloneResponseOpportunityContextCapsule(
    input.contextCapsule
  );
  const sourceHash = hashResponseOpportunityEvidence(
    decisionSpans,
    boundedContext,
    contextCapsule
  );
  return {
    schemaVersion: RESPONSE_OPPORTUNITY_SCHEMA_VERSION,
    promptVersion: RESPONSE_OPPORTUNITY_PROMPT_VERSION,
    logicalQuestionUnitId: input.logicalQuestionUnit.id,
    logicalQuestionUnitRevision: input.logicalQuestionUnit.revision,
    currentTurnId: input.logicalQuestionUnit.currentTurnId,
    sourceHash,
    decisionSpans,
    boundedContext,
    ...(contextCapsule ? { contextCapsule } : {}),
    manualForceAdvise: input.manualForceAdvise ?? false,
  };
}

export function createResponseOpportunityContextCapsule(input: {
  clarification: string | null | undefined;
  logicalQuestionUnitId?: string | null;
  logicalQuestionUnitRevision?: number | null;
  parentId?: string | null;
  playbookPhase?: string | null;
  createdAt: number;
  unresolved: boolean;
}): ResponseOpportunityContextCapsule | undefined {
  const summary = projectBoundedSourceText(
    input.clarification ?? "",
    RESPONSE_OPPORTUNITY_MAX_CLARIFICATION_CHARS
  );
  if (!summary || summary === "-" || !input.unresolved) return undefined;
  return {
    pendingClarification: {
      summary,
      supportStatus: "final-output-authorized",
      ...(input.logicalQuestionUnitId
        ? { logicalQuestionUnitId: input.logicalQuestionUnitId }
        : {}),
      ...(input.logicalQuestionUnitRevision !== null &&
      input.logicalQuestionUnitRevision !== undefined
        ? {
            logicalQuestionUnitRevision:
              input.logicalQuestionUnitRevision,
          }
        : {}),
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(input.playbookPhase
        ? { playbookPhase: input.playbookPhase }
        : {}),
      createdAt: input.createdAt,
      unresolved: true,
    },
  };
}

export function projectResponseOpportunitySemanticPayload(
  request: ResponseOpportunityRequest
): ResponseOpportunitySemanticPayload {
  return {
    decisionSpans: request.decisionSpans.map((span, index) => ({
      index,
      text: span.text,
    })),
    boundedContext: request.boundedContext,
    ...(request.contextCapsule
      ? {
          pendingClarification: {
            summary: request.contextCapsule.pendingClarification.summary,
          },
        }
      : {}),
  };
}

export function hashResponseOpportunityEvidence(
  decisionSpans: ResponseOpportunityDecisionSpan[],
  boundedContext: string,
  contextCapsule?: ResponseOpportunityContextCapsule
) {
  let hash = 2_166_136_261;
  const sourceParts = decisionSpans.flatMap((span) => [
    span.turnId,
    span.text,
  ]);
  sourceParts.push(boundedContext);
  if (contextCapsule) {
    sourceParts.push(JSON.stringify(contextCapsule));
  }
  for (const character of sourceParts.join("\u001f")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function splitResponseOpportunityDecisionSpans(
  source: ResponseOpportunityDecisionSpan
) {
  const spans: ResponseOpportunityDecisionSpan[] = [];
  const pattern = /[^.!?。！？\n]+(?:[.!?。！？]+|$)/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source.text))) {
    const text = match[0].trim();
    if (!text || /^\.*\[source omitted\]\.*$/u.test(text)) continue;
    spans.push({ turnId: source.turnId, text });
  }
  return spans.length ? spans : [{ ...source }];
}

function cloneResponseOpportunityContextCapsule(
  capsule: ResponseOpportunityContextCapsule | undefined
) {
  if (!capsule) return undefined;
  const summary = projectBoundedSourceText(
    capsule.pendingClarification.summary,
    RESPONSE_OPPORTUNITY_MAX_CLARIFICATION_CHARS
  );
  if (!summary || summary === "-") return undefined;
  return {
    pendingClarification: {
      ...capsule.pendingClarification,
      summary,
    },
  };
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
