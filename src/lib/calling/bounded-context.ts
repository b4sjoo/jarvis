import type { CallTranscriptTurn } from "./types.js";

export interface CallingContextSnapshot {
  turns: CallTranscriptTurn[];
  nonAuthoritativeSummary?: string;
  evidence: string[];
  truncated: boolean;
}

export function buildBoundedCallingContext(input: {
  turns: CallTranscriptTurn[];
  evidence?: string[];
  nonAuthoritativeSummary?: string;
  maxChars: number;
}): CallingContextSnapshot {
  const selected: CallTranscriptTurn[] = [];
  let chars = 0;
  for (let index = input.turns.length - 1; index >= 0; index -= 1) {
    const turn = input.turns[index];
    const cost = turn.text.length + 16;
    if (selected.length > 0 && chars + cost > input.maxChars) break;
    selected.unshift({ ...turn });
    chars += cost;
  }
  return {
    turns: selected,
    nonAuthoritativeSummary: input.nonAuthoritativeSummary?.slice(0, 1_200),
    evidence: (input.evidence ?? []).slice(0, 12),
    truncated: selected.length < input.turns.length,
  };
}
