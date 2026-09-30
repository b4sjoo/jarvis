import type { CriticalMomentCandidate, CriticalMomentOutcomeEvaluationPatch } from "./critical-moment-evaluation.js";
import type { AdviseDisplayTarget } from "./manual-advise-display.js";
import type { MeetingTrace, TranscriptTurn } from "./types.js";

export interface CriticalMomentTimingCandidates {
  speech: Array<{ turnId: string; text: string; startedAt: number }>;
  answers: Array<{ traceId: string; appliedAt: number; surface: "normal-mode" | "focus-mode"; target: AdviseDisplayTarget }>;
}

export type CriticalMomentTimingSelection =
  | { kind: "speech-start"; turnId: string | null }
  | { kind: "first-useful"; traceId: string | null };

export function readConfirmedDisplayTarget(value: unknown): AdviseDisplayTarget | undefined {
  if (!value || typeof value !== "object") return;
  const target = value as AdviseDisplayTarget;
  if (![target.sessionId, target.traceId, target.logicalQuestionUnitId, target.suggestionId, target.generationId]
      .every(value => typeof value === "string" && value.length > 0) ||
      !Number.isSafeInteger(target.logicalQuestionRevision) ||
      target.logicalQuestionRevision! < 0 || !Number.isSafeInteger(target.stableRevision) || target.stableRevision! < 1) return;
  return { sessionId: target.sessionId, traceId: target.traceId,
    logicalQuestionUnitId: target.logicalQuestionUnitId, logicalQuestionRevision: target.logicalQuestionRevision,
    stableRevision: target.stableRevision, suggestionId: target.suggestionId, generationId: target.generationId };
}

/** A bounded source window proposes candidates; only a human selection supplies truth. */
export function buildCriticalMomentTimingCandidates(input: {
  sessionId: string;
  candidate: CriticalMomentCandidate;
  candidates: CriticalMomentCandidate[];
  turns: TranscriptTurn[];
  traces: MeetingTrace[];
}): CriticalMomentTimingCandidates {
  const { candidate } = input;
  if (candidate.sessionId !== input.sessionId) return { speech: [], answers: [] };
  const sourceIds = new Set(candidate.sourceTurnIds);
  const sources = input.turns.filter(turn => sourceIds.has(turn.id) && turn.speaker === "them");
  const sourceComplete = sources.length > 0 && sources.length === sourceIds.size && sources.every(turn => Number.isFinite(turn.endedAt));
  const end = sourceComplete ? Math.max(...sources.map(turn => turn.endedAt)) : undefined;
  const next = input.candidates.filter(other => other.sessionId === input.sessionId &&
    other.momentId !== candidate.momentId && other.opportunityStartAt !== undefined &&
    end !== undefined && other.opportunityStartAt >= end &&
    !other.sourceTurnIds.some(id => sourceIds.has(id)))
    .reduce((limit, other) => Math.min(limit, other.opportunityStartAt!), Infinity);
  const speech = end === undefined ? [] : input.turns.filter(turn => turn.speaker === "me" &&
    turn.isFinal && typeof turn.speechStartedAt === "number" && Number.isFinite(turn.speechStartedAt) && Number.isFinite(turn.endedAt) &&
    turn.endedAt >= turn.speechStartedAt && turn.speechStartedAt >= end && turn.speechStartedAt < next)
    .map(turn => ({ turnId: turn.id, text: turn.text, startedAt: turn.speechStartedAt! }));
  const answers: CriticalMomentTimingCandidates["answers"] = [];
  for (const trace of input.traces) {
    if (!candidate.proposedTraceIds.includes(trace.id)) continue;
    const metadata = trace.metadata;
    const target = readConfirmedDisplayTarget(metadata?.advisorOutputFirstDisplayTarget);
    const appliedAt = metadata?.advisorOutputFirstDisplayAppliedAt;
    const surface = metadata?.advisorOutputFirstDisplaySurface;
    if (!target || target.sessionId !== input.sessionId || target.traceId !== trace.id ||
        target.logicalQuestionUnitId !== metadata?.logicalQuestionUnitId ||
        target.logicalQuestionRevision !== metadata?.logicalQuestionUnitRevision ||
        metadata?.advisorOutputAppliedToDisplay !== true ||
        typeof appliedAt !== "number" || !Number.isFinite(appliedAt) ||
        (surface !== "normal-mode" && surface !== "focus-mode")) continue;
    answers.push({ traceId: trace.id, appliedAt, surface, target });
  }
  return { speech, answers };
}

export function resolveCriticalMomentTimingSelection(
  candidates: CriticalMomentTimingCandidates,
  selection: CriticalMomentTimingSelection
): CriticalMomentOutcomeEvaluationPatch | undefined {
  if (selection.kind === "speech-start") {
    const speech = candidates.speech.find(item => item.turnId === selection.turnId);
    if (selection.turnId !== null && !speech) return;
    return { userSpeechStartAt: speech?.startedAt, userSpeechStartTurnId: speech?.turnId };
  }
  const answer = candidates.answers.find(item => item.traceId === selection.traceId);
  if (selection.traceId !== null && !answer) return;
  return { selectedUsefulTraceId: answer?.traceId, firstUsefulAt: answer?.appliedAt,
    selectedUsefulDisplayTarget: answer?.target, selectedUsefulDisplaySurface: answer?.surface,
    traceIds: answer ? [answer.traceId] : [] };
}
