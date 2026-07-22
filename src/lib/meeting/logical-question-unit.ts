import type { AdvisorTurnIntentDecision } from "./advisor-turn-intent.js";
import { createMeetingId } from "./context-manager.js";
import type { TranscriptTurn } from "./types.js";

export const LOGICAL_QUESTION_MAX_PREVIOUS_TURNS = 3;
export const LOGICAL_QUESTION_MAX_AGE_MS = 30_000;
export const LOGICAL_QUESTION_MAX_CHARS = 1_200;

export interface LogicalQuestionSource {
  turnId: string;
  text: string;
  startedAt: number;
  endedAt: number;
}

export interface LogicalQuestionUnit {
  id: string;
  sessionId: string;
  runtimeEpoch: number;
  currentTurnId: string;
  sourceTurnIds: string[];
  sources: LogicalQuestionSource[];
  normalizedText: string;
  startedAt: number;
  updatedAt: number;
  compositionReasons: string[];
  boundaryReason: string;
  truncated: boolean;
}

export interface ComposeLogicalQuestionUnitInput {
  currentTurn: TranscriptTurn;
  sessionId: string;
  runtimeEpoch: number;
  intentDecision?: AdvisorTurnIntentDecision;
  previousUnit?: LogicalQuestionUnit;
  cancelledAdvisorTurnIds?: ReadonlySet<string>;
  pendingBoundarySourceTurnIds?: string[];
  relatedSourceTurnIds?: string[];
  interveningTurns?: TranscriptTurn[];
  explicitTaskSwitch?: boolean;
  authoritativeCorrection?: boolean;
  committedParentBoundary?: boolean;
  now?: number;
}

export function composeLogicalQuestionUnit(
  input: ComposeLogicalQuestionUnitInput
): LogicalQuestionUnit {
  const now = input.now ?? Date.now();
  const currentSource = toSource(input.currentTurn);
  const previous = input.previousUnit;
  const boundary = resolveCompositionBoundary(input, previous);
  const shouldExtend = Boolean(previous && boundary.extend);
  const sources = shouldExtend
    ? dedupeSources([...previous!.sources, currentSource]).slice(
        -(LOGICAL_QUESTION_MAX_PREVIOUS_TURNS + 1)
      )
    : [currentSource];
  const relatedSourceTurnIds = (input.relatedSourceTurnIds ?? []).filter(
    (turnId) => !sources.some((source) => source.turnId === turnId)
  );
  const sourceTurnIds = Array.from(
    new Set([...sources.map((source) => source.turnId), ...relatedSourceTurnIds])
  );
  const normalized = joinBoundedSources(sources);

  return {
    id: shouldExtend ? previous!.id : createMeetingId("logical_question"),
    sessionId: input.sessionId,
    runtimeEpoch: input.runtimeEpoch,
    currentTurnId: input.currentTurn.id,
    sourceTurnIds,
    sources,
    normalizedText: normalized.text,
    startedAt: sources[0]?.startedAt ?? input.currentTurn.startedAt,
    updatedAt: now,
    compositionReasons: shouldExtend
      ? Array.from(
          new Set([
            ...previous!.compositionReasons,
            ...boundary.reasons,
          ])
        )
      : [boundary.reason],
    boundaryReason: boundary.reason,
    truncated:
      normalized.truncated ||
      (shouldExtend &&
        previous!.sources.length + 1 >
          LOGICAL_QUESTION_MAX_PREVIOUS_TURNS + 1),
  };
}

export function formatLogicalQuestionUnitForTrace(
  unit: LogicalQuestionUnit | undefined
) {
  if (!unit) return {};
  return {
    logicalQuestionUnitId: unit.id,
    logicalQuestionCurrentTurnId: unit.currentTurnId,
    logicalQuestionSourceTurnIds: unit.sourceTurnIds,
    logicalQuestionChars: unit.normalizedText.length,
    logicalQuestionCompositionReasons: unit.compositionReasons,
    logicalQuestionBoundaryReason: unit.boundaryReason,
    logicalQuestionTruncated: unit.truncated,
  };
}

function resolveCompositionBoundary(
  input: ComposeLogicalQuestionUnitInput,
  previous: LogicalQuestionUnit | undefined
) {
  if (!previous) {
    return boundary(false, "no-previous-logical-question");
  }
  if (
    previous.sessionId !== input.sessionId ||
    previous.runtimeEpoch !== input.runtimeEpoch
  ) {
    return boundary(false, "runtime-boundary");
  }
  if (input.explicitTaskSwitch) {
    return boundary(false, "explicit-task-switch");
  }
  if (input.authoritativeCorrection) {
    return boundary(false, "authoritative-correction-boundary");
  }
  if (input.committedParentBoundary) {
    return boundary(false, "committed-parent-boundary");
  }
  if (input.currentTurn.startedAt - previous.startedAt > LOGICAL_QUESTION_MAX_AGE_MS) {
    return boundary(false, "question-window-expired");
  }
  if (hasSubstantiveMeBoundary(input.interveningTurns ?? [])) {
    return boundary(false, "substantive-me-answer-boundary");
  }

  const intent = input.intentDecision;
  const reasons: string[] = [];
  if (intent?.intent === "constraint-or-follow-up") {
    reasons.push("constraint-or-follow-up");
  }
  if (intent?.intent === "correction") reasons.push("correction");
  if (
    intent?.evidence.some((item) =>
      /elliptical|provisional-question|active-task-constraint/.test(item)
    )
  ) {
    reasons.push("elliptical-continuation");
  }
  if (isBoundedContinuationText(input.currentTurn.text)) {
    reasons.push("bounded-followup-language");
  }
  if (
    input.relatedSourceTurnIds?.some((turnId) =>
      previous.sourceTurnIds.includes(turnId)
    )
  ) {
    reasons.push("source-lineage-continuation");
  }
  if (
    previous.sourceTurnIds.some((turnId) =>
      input.cancelledAdvisorTurnIds?.has(turnId)
    ) &&
    intent?.intent !== "direct-question"
  ) {
    reasons.push("replaced-advisor-question");
  }
  if (
    input.pendingBoundarySourceTurnIds?.some((turnId) =>
      previous.sourceTurnIds.includes(turnId)
    )
  ) {
    reasons.push("pending-task-boundary-continuation");
  }

  if (!reasons.length) {
    return boundary(false, "independent-current-turn");
  }
  return {
    extend: true,
    reason: "bounded-continuation",
    reasons,
  };
}

function boundary(extend: boolean, reason: string) {
  return { extend, reason, reasons: [reason] };
}

function hasSubstantiveMeBoundary(turns: TranscriptTurn[]) {
  return turns.some(
    (turn) =>
      turn.speaker === "me" &&
      (turn.contextTier === "me_attempted_answer_long" ||
        turn.text.trim().length >= 160)
  );
}

function isBoundedContinuationText(text: string) {
  return (
    /\b(?:time|space|complexity|optimi[sz]e|another approach|without (?:using )?|in (?:python|java|javascript|typescript|go|golang|rust|c\+\+)|use (?:python|java|javascript|typescript|go|golang|rust|c\+\+)|what metrics|how would you evaluate|what about|how about|for this (?:system|design|solution|algorithm))\b/i.test(
      text
    ) ||
    /复杂度|优化|不用|改用|使用.*(?:Python|Java|Go|Rust)|什么指标|怎么评估|这个系统|这个设计|这个算法/i.test(
      text
    )
  );
}

function toSource(turn: TranscriptTurn): LogicalQuestionSource {
  return {
    turnId: turn.id,
    text: normalizeText(turn.text),
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
  };
}

function dedupeSources(sources: LogicalQuestionSource[]) {
  const byTurnId = new Map<string, LogicalQuestionSource>();
  for (const source of sources) byTurnId.set(source.turnId, source);
  return Array.from(byTurnId.values()).sort(
    (left, right) => left.startedAt - right.startedAt
  );
}

function joinBoundedSources(sources: LogicalQuestionSource[]) {
  const joined = sources.map((source) => source.text).filter(Boolean).join(" ");
  if (joined.length <= LOGICAL_QUESTION_MAX_CHARS) {
    return { text: joined, truncated: false };
  }

  const current = sources[sources.length - 1]?.text ?? "";
  if (current.length >= LOGICAL_QUESTION_MAX_CHARS) {
    return {
      text: current.slice(0, LOGICAL_QUESTION_MAX_CHARS).trim(),
      truncated: true,
    };
  }
  const prefixBudget = LOGICAL_QUESTION_MAX_CHARS - current.length - 1;
  const prefix = sources
    .slice(0, -1)
    .map((source) => source.text)
    .join(" ")
    .slice(0, Math.max(0, prefixBudget))
    .trim();
  return {
    text: [prefix, current].filter(Boolean).join(" "),
    truncated: true,
  };
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}
