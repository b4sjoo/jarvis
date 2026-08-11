import type { CallTurnSettlement, CaseUpdateKind, CounterpartyMove, GuidanceFrame, PhaseSignal } from "./types.js";

const stripFence = (value: string) => value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

export function parseRuntimeSettlement(input: {
  raw: string;
  callSessionId: string;
  momentUnitId: string;
  evidenceRevision: number;
  settledAt: number;
}): CallTurnSettlement {
  const parsed = JSON.parse(stripFence(input.raw)) as Record<string, unknown>;
  const dispositions = ["actionable", "context-only", "incomplete"] as const;
  const moves: CounterpartyMove[] = ["question", "request", "refusal", "condition", "commitment", "correction", "informational", "unknown"];
  const phases: PhaseSignal[] = ["advance", "hold", "revisit", "close", "none"];
  if (!dispositions.includes(parsed.disposition as (typeof dispositions)[number])) throw new Error("Runtime model returned an unknown disposition.");
  if (!moves.includes(parsed.counterpartyMove as CounterpartyMove)) throw new Error("Runtime model returned an unknown counterparty move.");
  if (!phases.includes(parsed.phaseSignal as PhaseSignal)) throw new Error("Runtime model returned an unknown phase signal.");
  if (typeof parsed.responseAuthorized !== "boolean") throw new Error("Runtime model omitted response authority.");
  const updates = Array.isArray(parsed.candidateUpdates) ? parsed.candidateUpdates : [];
  const kinds: CaseUpdateKind[] = ["claim", "commitment", "deadline", "reference-number", "action"];
  return {
    callSessionId: input.callSessionId,
    momentUnitId: input.momentUnitId,
    evidenceRevision: input.evidenceRevision,
    disposition: parsed.disposition as CallTurnSettlement["disposition"],
    counterpartyMove: parsed.counterpartyMove as CounterpartyMove,
    phaseSignal: parsed.phaseSignal as PhaseSignal,
    responseAuthorized: parsed.responseAuthorized,
    candidateUpdates: updates.flatMap((entry, index) => {
      if (!entry || typeof entry !== "object") return [];
      const value = entry as { kind?: unknown; value?: unknown };
      if (!kinds.includes(value.kind as CaseUpdateKind) || typeof value.value !== "string") return [];
      return [{ id: `${input.momentUnitId}:update:${index}`, kind: value.kind as CaseUpdateKind, value: value.value.trim(), sourceMomentUnitId: input.momentUnitId }];
    }),
    settledAt: input.settledAt,
  };
}

export function parseGuidanceFrame(raw: string): GuidanceFrame {
  const parsed = JSON.parse(stripFence(raw)) as Partial<GuidanceFrame>;
  const arrays = [parsed.say, parsed.ask, parsed.avoid, parsed.evidence];
  if (arrays.some((value) => !Array.isArray(value) || value.some((entry) => typeof entry !== "string"))) {
    throw new Error("Advisor returned an invalid guidance list.");
  }
  if (typeof parsed.callState !== "string" || typeof parsed.nextMove !== "string" || !parsed.say?.some((entry) => entry.trim())) {
    throw new Error("Advisor returned an incomplete guidance frame.");
  }
  return {
    say: parsed.say.map((entry) => entry.trim()).filter(Boolean),
    ask: parsed.ask!.map((entry) => entry.trim()).filter(Boolean),
    avoid: parsed.avoid!.map((entry) => entry.trim()).filter(Boolean),
    evidence: parsed.evidence!.map((entry) => entry.trim()).filter(Boolean),
    callState: parsed.callState.trim(),
    nextMove: parsed.nextMove.trim(),
  };
}
