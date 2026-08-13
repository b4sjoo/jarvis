import type { CallTurnSettlement } from "./types.js";

export type AdvisorAuthorityReason =
  | "actionable-disposition"
  | "context-only-disposition"
  | "incomplete-evidence";

export interface AdvisorAuthorityDecision {
  modelRequested: boolean;
  responseAuthorized: boolean;
  normalized: boolean;
  reason: AdvisorAuthorityReason;
}

export function resolveAdvisorAuthority(
  settlement: CallTurnSettlement
): AdvisorAuthorityDecision {
  const modelRequested =
    settlement.modelResponseAuthorized ?? settlement.responseAuthorized;
  const responseAuthorized = settlement.disposition === "actionable";
  const reason: AdvisorAuthorityReason =
    settlement.disposition === "actionable"
      ? "actionable-disposition"
      : settlement.disposition === "context-only"
        ? "context-only-disposition"
        : "incomplete-evidence";

  return {
    modelRequested,
    responseAuthorized,
    normalized: modelRequested !== responseAuthorized,
    reason,
  };
}

export function applyAdvisorAuthority(
  settlement: CallTurnSettlement
): CallTurnSettlement {
  const decision = resolveAdvisorAuthority(settlement);
  return {
    ...settlement,
    modelResponseAuthorized: decision.modelRequested,
    responseAuthorized: decision.responseAuthorized,
    advisorAuthorityNormalized: decision.normalized,
    advisorAuthorityReason: decision.reason,
  };
}
