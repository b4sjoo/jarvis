export const RESPONSE_OPPORTUNITY_SCHEMA_VERSION = 4;
export const RESPONSE_OPPORTUNITY_PROMPT_VERSION =
  "response-opportunity-v4-whole-current-input";
export const RESPONSE_OPPORTUNITY_MAX_DECISION_SPANS = 12;
export const RESPONSE_OPPORTUNITY_COMPACT_OUTPUT_WORST_CASE =
  JSON.stringify({
    v: RESPONSE_OPPORTUNITY_SCHEMA_VERSION,
    d: "u",
    c: 1,
    t: Array.from(
      { length: RESPONSE_OPPORTUNITY_MAX_DECISION_SPANS },
      (_, index) => index
    ),
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
export const RESPONSE_OPPORTUNITY_MAX_DECISION_SOURCE_CHARS = 1_200;
export const RESPONSE_OPPORTUNITY_MAX_CONTEXT_SOURCE_CHARS = 600;
export const RESPONSE_OPPORTUNITY_MAX_CLARIFICATION_CHARS = 280;

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
  boundedContextSourceTurnIds: string[];
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
  contextSources?: Array<{ turnId: string; text: string }>;
  contextCapsule?: ResponseOpportunityContextCapsule;
  manualForceAdvise?: boolean;
}): ResponseOpportunityRequest {
  const effectiveSources =
    input.effectiveSources ?? input.logicalQuestionUnit.sources;
  const selectedDecisionSources = selectCurrentResponseOpportunitySources({
    sources: effectiveSources,
    currentTurnId: input.logicalQuestionUnit.currentTurnId,
  });
  const currentSourceIds = new Set(
    selectedDecisionSources.map((source) => source.turnId)
  );
  const priorLogicalQuestionSources = effectiveSources.filter(
    (source) => !currentSourceIds.has(source.turnId)
  );
  const boundedDecisionSources = boundResponseOpportunitySources({
    sources: selectedDecisionSources,
    maxChars: RESPONSE_OPPORTUNITY_MAX_DECISION_SOURCE_CHARS,
    currentTurnId: input.logicalQuestionUnit.currentTurnId,
  });
  const decisionTurnIds = new Set(
    boundedDecisionSources.map((source) => source.turnId)
  );
  const boundedSupplementaryContext = boundResponseOpportunitySources({
    sources: dedupeResponseOpportunitySources(
      [...(input.contextSources ?? []), ...priorLogicalQuestionSources].filter(
        (source) => !decisionTurnIds.has(source.turnId)
      )
    ),
    maxChars: Math.min(
      RESPONSE_OPPORTUNITY_MAX_CONTEXT_SOURCE_CHARS,
      Math.max(
        0,
        RESPONSE_OPPORTUNITY_MAX_SOURCE_CHARS -
          boundedDecisionSources.reduce(
            (total, source) => total + source.text.length,
            0
          )
      )
    ),
  });
  const boundedContextSources = [
    ...boundedSupplementaryContext,
    ...boundedDecisionSources,
  ];
  const boundedContext = boundedContextSources
    .map((source) => source.text)
    .join("\n")
    .trim();
  const decisionSpans = boundedDecisionSources
    .flatMap(splitResponseOpportunityDecisionSpans)
    .slice(-RESPONSE_OPPORTUNITY_MAX_DECISION_SPANS);
  const contextCapsule = cloneResponseOpportunityContextCapsule(
    input.contextCapsule
  );
  const sourceHash = hashResponseOpportunityEvidence(
    decisionSpans,
    boundedContext,
    contextCapsule,
    boundedContextSources.map((source) => source.turnId)
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
    boundedContextSourceTurnIds: boundedContextSources.map(
      (source) => source.turnId
    ),
    ...(contextCapsule ? { contextCapsule } : {}),
    manualForceAdvise: input.manualForceAdvise ?? false,
  };
}

function selectCurrentResponseOpportunitySources(input: {
  sources: Array<{ turnId: string; text: string }>;
  currentTurnId: string;
}) {
  const current = input.sources.filter(
    (source) => source.turnId === input.currentTurnId
  );
  return current.length ? [current.at(-1)!] : input.sources.slice(-1);
}

export function selectResponseOpportunityContextSources(input: {
  logicalQuestionUnit: {
    contextSourceTurnIds?: string[];
    recentLogicalQuestionSourceTurnIds?: string[];
  };
  transcriptTurns: Array<{ id: string; text: string; startedAt: number }>;
}) {
  const requestedTurnIds = new Set([
    ...(input.logicalQuestionUnit.contextSourceTurnIds ?? []),
    ...(input.logicalQuestionUnit.recentLogicalQuestionSourceTurnIds ?? []),
  ]);
  return input.transcriptTurns
    .filter((turn) => requestedTurnIds.has(turn.id))
    .sort((left, right) => left.startedAt - right.startedAt)
    .map((turn) => ({ turnId: turn.id, text: turn.text }));
}

function boundResponseOpportunitySources(input: {
  sources: Array<{ turnId: string; text: string }>;
  maxChars: number;
  currentTurnId?: string;
}) {
  let remainingChars = input.maxChars;
  const reservePerLaterSource = Math.max(
    1,
    Math.floor(input.maxChars / Math.max(1, input.sources.length))
  );
  const bounded: ResponseOpportunityDecisionSpan[] = [];
  for (const [index, source] of input.sources.entries()) {
    if (remainingChars <= 0) break;
    const laterSourceCount = input.sources.length - index - 1;
    const reserveForLater = Math.min(
      remainingChars,
      laterSourceCount * reservePerLaterSource
    );
    const available = Math.max(1, remainingChars - reserveForLater);
    const text = projectBoundedSourceText(
      source.text,
      Math.min(
        available,
        source.turnId === input.currentTurnId
          ? RESPONSE_OPPORTUNITY_MAX_DECISION_SOURCE_CHARS
          : RESPONSE_OPPORTUNITY_MAX_CONTEXT_SOURCE_CHARS
      )
    );
    if (!text) continue;
    bounded.push({ turnId: source.turnId, text });
    remainingChars -= text.length;
  }
  return bounded;
}

function dedupeResponseOpportunitySources(
  sources: Array<{ turnId: string; text: string }>
) {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (!source.turnId || seen.has(source.turnId)) return false;
    seen.add(source.turnId);
    return Boolean(source.text.trim());
  });
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
  contextCapsule?: ResponseOpportunityContextCapsule,
  boundedContextSourceTurnIds: string[] = []
) {
  let hash = 2_166_136_261;
  const sourceParts = decisionSpans.flatMap((span) => [
    span.turnId,
    span.text,
  ]);
  sourceParts.push(boundedContext);
  sourceParts.push(...boundedContextSourceTurnIds);
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
