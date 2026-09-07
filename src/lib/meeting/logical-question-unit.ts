import type { AdvisorTurnIntentDecision } from "./advisor-turn-intent.js";
import { createMeetingId } from "./context-manager.js";
import type {
  ActiveQuestionTermCorrection,
  TranscriptTurn,
} from "./types.js";
import type {
  PendingInterviewSectionHint,
  PendingInterviewTaskBoundary,
} from "./interview-section-transition.js";
import {
  composePrimaryAskProjection,
  formatPrimaryAskProjectionForTrace,
  isPrimaryAskCompletion,
  projectPrimaryAsk,
  type PrimaryAskProjection,
} from "./primary-ask-projection.js";
import {
  applyTermCorrectionOverlaysToText,
  TERM_CORRECTION_PROJECTION_MAX_CHARS,
} from "./term-correction-projection.js";

export const LOGICAL_QUESTION_MAX_PREVIOUS_TURNS = 3;
export const LOGICAL_QUESTION_MAX_AGE_MS = 30_000;
export const LOGICAL_QUESTION_MAX_CHARS =
  TERM_CORRECTION_PROJECTION_MAX_CHARS;
export const REFERENTIAL_COMPLETION_MAX_PREVIOUS_TURNS = 2;
export const REFERENTIAL_COMPLETION_MAX_AGE_MS = 45_000;
export const REFERENTIAL_COMPLETION_MAX_WORD_EQUIVALENTS = 16;

export interface LogicalQuestionSource {
  turnId: string;
  text: string;
  startedAt: number;
  endedAt: number;
  preNormalizationText?: string;
  appliedSpeechCorrectionIds?: string[];
}

export interface LogicalQuestionUnit {
  id: string;
  revision: number;
  sessionId: string;
  runtimeEpoch: number;
  currentTurnId: string;
  sourceTurnIds: string[];
  contextSourceTurnIds?: string[];
  recentLogicalQuestionSourceTurnIds?: string[];
  sources: LogicalQuestionSource[];
  normalizedText: string;
  startedAt: number;
  updatedAt: number;
  compositionReasons: string[];
  boundaryReason: string;
  truncated: boolean;
  sectionHint?: PendingInterviewSectionHint;
  taskBoundaryEvidence?: PendingInterviewTaskBoundary;
  primaryAskProjection?: PrimaryAskProjection;
  responseOpportunityTarget?: {
    text: string;
    sourceHash: string;
    source: "runtime-llm";
    decision: "output-request" | "no-output-request";
    sourceTurnIds: string[];
  };
  // A visible-answer action restores this from the committed effective source
  // record. It is already-settled evidence, not a second primary-ask inference.
  restoredAnswerFocusText?: string;
  termCorrectionOverlays?: ActiveQuestionTermCorrection[];
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
  recentThemTurns?: TranscriptTurn[];
  explicitTaskSwitch?: boolean;
  authoritativeCorrection?: boolean;
  committedParentBoundary?: boolean;
  now?: number;
  sectionHint?: PendingInterviewSectionHint;
  taskBoundaryEvidence?: PendingInterviewTaskBoundary;
  primaryAskProjection?: PrimaryAskProjection;
  terminalNoAnswerBoundary?: {
    logicalQuestionUnitId: string;
    settledRevision: number;
    settledSourceTurnIds: string[];
    currentSourceOwnedSubstantive: boolean;
  };
}

export interface LogicalQuestionUnitTraceMetadata {
  [key: string]: unknown;
  logicalQuestionUnitId?: string;
  logicalQuestionUnitRevision?: number;
  logicalQuestionCurrentTurnId?: string;
  logicalQuestionSourceTurnIds?: string[];
  logicalQuestionContextSourceTurnIds?: string[];
  logicalQuestionRecentLogicalQuestionSourceTurnIds?: string[];
  logicalQuestionChars?: number;
  logicalQuestionCompositionReasons?: string[];
  logicalQuestionBoundaryReason?: string;
  logicalQuestionTruncated?: boolean;
  logicalQuestionTerminalNoAnswerBoundaryApplied?: boolean;
}

export type ComposeCanonicalTurnCandidateInput = Omit<
  ComposeLogicalQuestionUnitInput,
  | "previousUnit"
  | "authoritativeCorrection"
  | "committedParentBoundary"
  | "terminalNoAnswerBoundary"
>;

interface LogicalQuestionCompositionBoundary {
  extend: boolean;
  reason: string;
  reasons: string[];
  carryPostTerminalSetup?: boolean;
}

export function composeLogicalQuestionUnit(
  input: ComposeLogicalQuestionUnitInput
): LogicalQuestionUnit {
  const now = input.now ?? Date.now();
  const currentSource = toSource(input.currentTurn);
  const previous = input.previousUnit;
  const boundary = resolveCompositionBoundary(input, previous);
  const shouldExtend = Boolean(previous && boundary.extend);
  const referentialSources = boundary.reasons.includes("referential-completion")
    ? collectReferentialSources(input, previous)
    : [];
  const postTerminalSetupSources =
    boundary.carryPostTerminalSetup && previous
      ? collectPostTerminalSetupSources(
          previous,
          input.terminalNoAnswerBoundary?.settledSourceTurnIds ?? []
        )
      : [];
  const sources = shouldExtend
    ? dedupeSources([
        ...previous!.sources,
        ...referentialSources,
        currentSource,
      ]).slice(
        -(LOGICAL_QUESTION_MAX_PREVIOUS_TURNS + 1)
      )
    : dedupeSources([
        ...postTerminalSetupSources,
        currentSource,
      ]).slice(-(LOGICAL_QUESTION_MAX_PREVIOUS_TURNS + 1));
  const relatedSourceTurnIds = (input.relatedSourceTurnIds ?? []).filter(
    (turnId) => !sources.some((source) => source.turnId === turnId)
  );
  const sourceTurnIds = Array.from(
    new Set([...sources.map((source) => source.turnId), ...relatedSourceTurnIds])
  );
  const primaryAskProjection = composePrimaryAskProjection({
    current: input.primaryAskProjection,
    previous: previous?.primaryAskProjection,
    extended: shouldExtend,
  });
  const normalized = primaryAskProjection?.normalizedPrimaryAsk
    ? boundPrimaryAsk(primaryAskProjection.normalizedPrimaryAsk)
    : joinBoundedSources(sources);
  const termCorrectionOverlays = shouldExtend
    ? previous?.termCorrectionOverlays?.map((overlay) => ({ ...overlay }))
    : undefined;
  const effectiveNormalizedText = termCorrectionOverlays?.length
    ? applyTermCorrectionOverlaysToText(
        normalized.text,
        termCorrectionOverlays
      )
    : normalized.text;
  const effectivePrimaryAskProjection = primaryAskProjection
    ? termCorrectionOverlays?.length
      ? {
          ...primaryAskProjection,
          normalizedPrimaryAsk: effectiveNormalizedText,
          answerFocusText: effectiveNormalizedText,
          semanticEvidenceText: applyTermCorrectionOverlaysToText(
            primaryAskProjection.semanticEvidenceText,
            termCorrectionOverlays
          ),
          semanticEvidenceRetentionReasons: Array.from(
            new Set([
              ...primaryAskProjection.semanticEvidenceRetentionReasons,
              "manual-correction-overlay" as const,
            ])
          ),
        }
      : primaryAskProjection
    : undefined;

  return {
    id: shouldExtend ? previous!.id : createMeetingId("logical_question"),
    revision: shouldExtend ? previous!.revision + 1 : 1,
    sessionId: input.sessionId,
    runtimeEpoch: input.runtimeEpoch,
    currentTurnId: input.currentTurn.id,
    sourceTurnIds,
    sources,
    normalizedText: effectiveNormalizedText,
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
    sectionHint: input.sectionHint,
    taskBoundaryEvidence: input.taskBoundaryEvidence,
    primaryAskProjection: effectivePrimaryAskProjection,
    termCorrectionOverlays,
  };
}

export function composeCanonicalTurnCandidate(
  input: ComposeCanonicalTurnCandidateInput
): LogicalQuestionUnit {
  return composeLogicalQuestionUnit(input);
}

export function formatLogicalQuestionUnitForTrace(
  unit: LogicalQuestionUnit | undefined
): LogicalQuestionUnitTraceMetadata {
  if (!unit) return {};
  const answerFocusText = getLogicalQuestionAnswerFocusText(unit);
  const semanticEvidenceText =
    getLogicalQuestionSemanticEvidenceText(unit);
  return {
    logicalQuestionUnitId: unit.id,
    logicalQuestionUnitRevision: unit.revision,
    logicalQuestionCurrentTurnId: unit.currentTurnId,
    logicalQuestionSourceTurnIds: unit.sourceTurnIds,
    logicalQuestionContextSourceTurnIds:
      unit.contextSourceTurnIds ?? [],
    logicalQuestionRecentLogicalQuestionSourceTurnIds:
      unit.recentLogicalQuestionSourceTurnIds ?? [],
    logicalQuestionChars: unit.normalizedText.length,
    logicalQuestionCompositionReasons: unit.compositionReasons,
    logicalQuestionBoundaryReason: unit.boundaryReason,
    logicalQuestionTruncated: unit.truncated,
    logicalQuestionTerminalNoAnswerBoundaryApplied:
      unit.boundaryReason ===
        "terminal-no-answer-substantive-boundary" ||
      unit.boundaryReason ===
        "terminal-no-answer-ambient-continuation",
    sectionHintId: unit.sectionHint?.id,
    sectionHintType: unit.sectionHint?.questionType,
    sectionHintDisposition: unit.sectionHint?.disposition,
    sectionHintSourceTurnId: unit.sectionHint?.sourceTurnId,
    explicitTaskBoundaryId: unit.taskBoundaryEvidence?.id,
    explicitTaskBoundarySourceTurnId:
      unit.taskBoundaryEvidence?.sourceTurnId,
    explicitTaskBoundaryDisposition:
      unit.taskBoundaryEvidence?.disposition,
    ...formatPrimaryAskProjectionForTrace(unit.primaryAskProjection),
    responseOpportunityDecisionTarget:
      unit.responseOpportunityTarget?.text,
    responseOpportunityDecisionTargetSource:
      unit.responseOpportunityTarget?.source,
    responseOpportunityDecisionTargetDecision:
      unit.responseOpportunityTarget?.decision,
    responseOpportunityDecisionTargetSourceHash:
      unit.responseOpportunityTarget?.sourceHash,
    responseOpportunityDecisionTargetSourceTurnIds:
      unit.responseOpportunityTarget?.sourceTurnIds,
    primaryAskAnswerFocusText: answerFocusText,
    primaryAskSemanticEvidenceText: semanticEvidenceText,
    primaryAskAnswerFocusChars: answerFocusText.length,
    primaryAskSemanticEvidenceChars: semanticEvidenceText.length,
  };
}

export function getLogicalQuestionAnswerFocusText(
  unit: LogicalQuestionUnit | undefined
) {
  if (!unit) return "";
  if (unit.restoredAnswerFocusText?.trim()) {
    return unit.restoredAnswerFocusText.trim();
  }
  if (unit.responseOpportunityTarget?.text.trim()) {
    return unit.responseOpportunityTarget.text.trim();
  }
  if (unit.termCorrectionOverlays?.length) {
    return unit.normalizedText.trim();
  }
  return (
    unit.primaryAskProjection?.answerFocusText.trim() ||
    unit.primaryAskProjection?.normalizedPrimaryAsk?.trim() ||
    unit.normalizedText.trim()
  );
}

export function getLogicalQuestionSemanticEvidenceText(
  unit: LogicalQuestionUnit | undefined
) {
  if (!unit) return "";
  const projectedSemanticEvidence =
    unit.primaryAskProjection?.semanticEvidenceText.trim() ||
    unit.normalizedText.trim() ||
    joinBoundedSources(unit.sources).text.trim();
  if (!unit.termCorrectionOverlays?.length) {
    return projectedSemanticEvidence;
  }
  if (
    unit.primaryAskProjection?.semanticEvidenceRetentionReasons.includes(
      "manual-correction-overlay"
    )
  ) {
    return projectedSemanticEvidence;
  }
  if (!unit.primaryAskProjection) return projectedSemanticEvidence;

  const projectedAnswerFocus =
    unit.primaryAskProjection?.answerFocusText.trim() ||
    unit.primaryAskProjection?.normalizedPrimaryAsk?.trim() ||
    "";
  const correctedAnswerFocus = unit.normalizedText.trim();
  if (!projectedAnswerFocus) {
    return joinBoundedText(
      projectedSemanticEvidence,
      correctedAnswerFocus
    );
  }
  if (projectedSemanticEvidence.includes(projectedAnswerFocus)) {
    return projectedSemanticEvidence.replace(
      projectedAnswerFocus,
      correctedAnswerFocus
    );
  }
  return joinBoundedText(
    projectedSemanticEvidence,
    correctedAnswerFocus
  );
}

function joinBoundedText(left: string, right: string) {
  return [left.trim(), right.trim()]
    .filter(Boolean)
    .join(" ")
    .slice(-LOGICAL_QUESTION_MAX_CHARS);
}

function resolveCompositionBoundary(
  input: ComposeLogicalQuestionUnitInput,
  previous: LogicalQuestionUnit | undefined
): LogicalQuestionCompositionBoundary {
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
  const referentialCompletion = isReferentialCompletion(input, previous);
  const maxQuestionAgeMs = referentialCompletion
    ? REFERENTIAL_COMPLETION_MAX_AGE_MS
    : LOGICAL_QUESTION_MAX_AGE_MS;
  if (input.currentTurn.startedAt - previous.startedAt > maxQuestionAgeMs) {
    return boundary(false, "question-window-expired");
  }
  if (hasSubstantiveMeBoundary(input.interveningTurns ?? [])) {
    return boundary(false, "substantive-me-answer-boundary");
  }
  if (
    input.terminalNoAnswerBoundary?.logicalQuestionUnitId ===
      previous.id &&
    input.terminalNoAnswerBoundary.settledRevision <=
      previous.revision
  ) {
    if (
      input.terminalNoAnswerBoundary.currentSourceOwnedSubstantive &&
      hasSourceOwnedSubstantivePrimaryAsk(input.primaryAskProjection)
    ) {
      return {
        ...boundary(
          false,
          "terminal-no-answer-substantive-boundary"
        ),
        carryPostTerminalSetup: true,
      };
    }
    return boundary(
      true,
      "terminal-no-answer-ambient-continuation"
    );
  }

  const intent = input.intentDecision;
  const reasons: string[] = [];
  if (
    isPrimaryAskCompletion({
      current: input.primaryAskProjection,
      previous: previous.primaryAskProjection,
    })
  ) {
    reasons.push("primary-ask-completion");
  }
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
  if (referentialCompletion) {
    reasons.push("referential-completion");
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

function boundary(
  extend: boolean,
  reason: string
): LogicalQuestionCompositionBoundary {
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

function hasSourceOwnedSubstantivePrimaryAsk(
  projection: PrimaryAskProjection | undefined
) {
  return Boolean(
    projection?.normalizedPrimaryAsk?.trim() &&
      (projection.disposition === "answer-primary-ask" ||
        projection.disposition === "revise-existing-lqu")
  );
}

function collectPostTerminalSetupSources(
  previous: LogicalQuestionUnit,
  settledSourceTurnIds: string[]
) {
  const settled = new Set(settledSourceTurnIds);
  return previous.sources.filter((source) => {
    if (settled.has(source.turnId)) return false;
    const projection = projectPrimaryAsk({
      turnId: source.turnId,
      text: source.text,
    });
    return (
      projection.disposition === "append-setup" &&
      projection.speechAct !== "logistics" &&
      projection.speechAct !== "acknowledgement"
    );
  });
}

function isReferentialCompletion(
  input: ComposeLogicalQuestionUnitInput,
  previous: LogicalQuestionUnit
) {
  if (!isShortReferentialActionRequest(input.currentTurn.text)) return false;
  return collectReferentialSources(input, previous).some((source) =>
    isSubstantiveTechnicalContext(source.text)
  );
}

function collectReferentialSources(
  input: ComposeLogicalQuestionUnitInput,
  previous: LogicalQuestionUnit | undefined
) {
  const earliestStartedAt =
    input.currentTurn.startedAt - REFERENTIAL_COMPLETION_MAX_AGE_MS;
  const recent = (input.recentThemTurns ?? [])
    .filter(
      (turn) =>
        turn.speaker === "them" &&
        turn.id !== input.currentTurn.id &&
        turn.startedAt >= earliestStartedAt &&
        turn.endedAt <= input.currentTurn.startedAt
    )
    .sort((left, right) => left.startedAt - right.startedAt)
    .slice(-REFERENTIAL_COMPLETION_MAX_PREVIOUS_TURNS)
    .map(toSource);
  const previousSources = (previous?.sources ?? []).filter(
    (source) =>
      source.startedAt >= earliestStartedAt &&
      source.endedAt <= input.currentTurn.startedAt
  );
  return dedupeSources([...previousSources, ...recent])
    .filter((source) => isSubstantiveTechnicalContext(source.text))
    .slice(-REFERENTIAL_COMPLETION_MAX_PREVIOUS_TURNS);
}

function isShortReferentialActionRequest(text: string) {
  const normalized = normalizeText(text);
  if (
    !normalized ||
    calculateWordEquivalent(normalized) >
      REFERENTIAL_COMPLETION_MAX_WORD_EQUIVALENTS
  ) {
    return false;
  }
  const hasReferent =
    /\b(?:that|this|it|those|these|the above|same one|same approach)\b/i.test(
      normalized
    ) || /(?:这个|那个|它|上述|上面|同一个|同样的)/.test(normalized);
  if (!hasReferent) return false;
  return (
    /\b(?:write|implement|code|script|show|give|provide|build|create|solve|explain|compare|optimi[sz]e|analy[sz]e|walk)\b/i.test(
      normalized
    ) ||
    /(?:写|实现|编码|代码|脚本|给出|展示|创建|解决|解释|比较|优化|分析)/.test(
      normalized
    )
  );
}

function isSubstantiveTechnicalContext(text: string) {
  const normalized = normalizeText(text);
  if (calculateWordEquivalent(normalized) < 8) return false;
  return (
    /\b(?:algorithm|array|cache|class|code|database|directory|endpoint|file|function|graph|index|latency|list|model|queue|request|service|stack|storage|system|throughput|tree|api|qps|rag)\b/i.test(
      normalized
    ) ||
    /(?:算法|数组|缓存|代码|数据库|目录|文件|函数|图|索引|延迟|模型|队列|请求|服务|栈|存储|系统|吞吐|树|接口|检索)/.test(
      normalized
    )
  );
}

function calculateWordEquivalent(text: string) {
  const latinWords = text.match(/[A-Za-z0-9_+#.-]+/g)?.length ?? 0;
  const cjkChars = text.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  return latinWords + Math.ceil(cjkChars / 2);
}

function toSource(turn: TranscriptTurn): LogicalQuestionSource {
  return {
    turnId: turn.id,
    text: normalizeText(turn.text),
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    preNormalizationText: turn.preNormalizationText,
    appliedSpeechCorrectionIds: turn.appliedSpeechCorrectionIds
      ? [...turn.appliedSpeechCorrectionIds]
      : undefined,
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

function boundPrimaryAsk(text: string) {
  const normalized = normalizeText(text);
  return {
    text: normalized.slice(0, LOGICAL_QUESTION_MAX_CHARS).trim(),
    truncated: normalized.length > LOGICAL_QUESTION_MAX_CHARS,
  };
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}
