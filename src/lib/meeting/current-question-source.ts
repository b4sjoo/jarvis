export type CurrentQuestionSourceKind = "voice" | "screen" | "mixed";

export type SettlementOwnedQuestionContextReason =
  | "authorized"
  | "logical-question-empty"
  | "source-observation-id-missing"
  | "source-observation-not-found"
  | "source-observation-image-unavailable";

export interface SettlementOwnedQuestionContextDecision {
  authorized: boolean;
  reason: SettlementOwnedQuestionContextReason;
  sourceKind: CurrentQuestionSourceKind;
  sourceObservationIds: string[];
  preferredObservationId?: string;
}

export function resolveSettlementOwnedQuestionSource(input: {
  settlement?: {
    sourceKind: CurrentQuestionSourceKind;
    sourceObservationIds: readonly string[];
  };
  fallbackSourceKind: CurrentQuestionSourceKind;
  fallbackSourceObservationIds?: readonly string[];
}) {
  if (input.settlement) {
    return {
      sourceKind: input.settlement.sourceKind,
      sourceObservationIds: [...input.settlement.sourceObservationIds],
    };
  }
  return {
    sourceKind: input.fallbackSourceKind,
    sourceObservationIds: [...(input.fallbackSourceObservationIds ?? [])],
  };
}

export function resolveCurrentQuestionSourceKind(input: {
  sourceTurnIds?: readonly string[];
  sourceObservationIds?: readonly string[];
  fallback: CurrentQuestionSourceKind;
}): CurrentQuestionSourceKind {
  const hasVoice = (input.sourceTurnIds?.length ?? 0) > 0;
  const hasScreen = (input.sourceObservationIds?.length ?? 0) > 0;
  if (hasVoice && hasScreen) return "mixed";
  if (hasScreen) return "screen";
  if (hasVoice) return "voice";
  return input.fallback;
}

export function authorizeSettlementOwnedQuestionContext(input: {
  sourceKind: CurrentQuestionSourceKind;
  sourceObservationIds?: readonly string[];
  logicalQuestionText?: string;
  screenObservations?: readonly {
    id: string;
    imageBase64?: string;
  }[];
}): SettlementOwnedQuestionContextDecision {
  const sourceObservationIds = [...(input.sourceObservationIds ?? [])];
  const base = {
    sourceKind: input.sourceKind,
    sourceObservationIds,
  };
  if (!input.logicalQuestionText?.trim()) {
    return { ...base, authorized: false, reason: "logical-question-empty" };
  }
  if (input.sourceKind === "voice") {
    return { ...base, authorized: true, reason: "authorized" };
  }

  const preferredObservationId = sourceObservationIds.at(-1);
  if (!preferredObservationId) {
    return {
      ...base,
      authorized: false,
      reason: "source-observation-id-missing",
    };
  }
  const observation = input.screenObservations?.find(
    (candidate) => candidate.id === preferredObservationId
  );
  if (!observation) {
    return {
      ...base,
      preferredObservationId,
      authorized: false,
      reason: "source-observation-not-found",
    };
  }
  if (!observation.imageBase64?.trim()) {
    return {
      ...base,
      preferredObservationId,
      authorized: false,
      reason: "source-observation-image-unavailable",
    };
  }
  return {
    ...base,
    preferredObservationId,
    authorized: true,
    reason: "authorized",
  };
}

export function formatSettlementOwnedQuestionContextForTrace(
  decision: SettlementOwnedQuestionContextDecision
): Record<string, unknown> {
  return {
    settlementOwnedQuestionContextAuthorized: decision.authorized,
    settlementOwnedQuestionContextReason: decision.reason,
    settlementOwnedQuestionContextSourceKind: decision.sourceKind,
    settlementOwnedQuestionContextSourceObservationIds:
      decision.sourceObservationIds,
    settlementOwnedQuestionContextPreferredObservationId:
      decision.preferredObservationId,
  };
}
