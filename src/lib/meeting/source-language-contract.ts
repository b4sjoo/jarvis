import type { MeetingInputLanguage, SourceLanguageAdmission } from "./types.js";
export type { SourceLanguageAdmission } from "./types.js";

export function sourceLanguageAdmissionMatches(receipt: SourceLanguageAdmission | undefined, input: {
  sessionId: string; runtimeEpoch: number; turnId: string; text: string;
}): receipt is SourceLanguageAdmission {
  return Boolean(receipt && receipt.sessionId === input.sessionId && receipt.runtimeEpoch === input.runtimeEpoch &&
    receipt.turnId === input.turnId && receipt.sourceText === input.text);
}

export function isLanguageAdmittedTurn(turn: { text: string; languageAdmission?: SourceLanguageAdmission }) {
  const receipt = turn.languageAdmission;
  return !receipt || receipt.sourceText === turn.text &&
    (receipt.disposition !== "excluded" || receipt.manualOverride === "force-advise");
}

export interface SessionLanguageObservation {
  sessionId: string;
  runtimeEpoch: number;
  parentId: string;
  turnId: string;
  language: MeetingInputLanguage;
  allowedLanguages: readonly MeetingInputLanguage[];
  observedAt: number;
}

export function deriveFirstParentLanguage(input: {
  previous?: SessionLanguageObservation;
  sessionId: string; runtimeEpoch: number; previousParentId?: string;
  authorized: boolean; mutationApplied: boolean; transition: string;
  parent?: { id: string; canonicalQuestionSourceTurnIds?: string[] };
  source?: SourceLanguageAdmission;
  now: number;
}): SessionLanguageObservation | undefined {
  if (input.previous?.sessionId === input.sessionId || !input.authorized || !input.mutationApplied ||
    !input.parent || input.parent.id === input.previousParentId ||
    !["create-parent", "replace-parent"].includes(input.transition)) return undefined;
  const sourceIds = input.parent.canonicalQuestionSourceTurnIds ?? [];
  const receipt = input.source;
  if (!receipt || !sourceIds.includes(receipt.turnId) || receipt.sessionId !== input.sessionId ||
    receipt.runtimeEpoch !== input.runtimeEpoch || receipt.disposition !== "admitted" || !receipt.language) return undefined;
  return { sessionId: input.sessionId, runtimeEpoch: input.runtimeEpoch, parentId: input.parent.id,
    turnId: receipt.turnId, language: receipt.language, allowedLanguages: [...receipt.allowedLanguages], observedAt: input.now };
}
