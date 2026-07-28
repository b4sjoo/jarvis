import { createMeetingId } from "./context-manager.js";
import type { CanonicalQuestionType } from "./task-taxonomy.js";

export type InterviewTransitionTurnDisposition =
  | "none"
  | "hint-only"
  | "complete-question";

export interface InterviewTransitionTurnDecision {
  detected: boolean;
  disposition: InterviewTransitionTurnDisposition;
  reason: string;
}

export const INTERVIEW_SECTION_HINT_TTL_MS = 90_000;

export type InterviewSectionQuestionType = Exclude<
  CanonicalQuestionType,
  "unknown"
>;

export type InterviewSectionHintDisposition =
  | "pending"
  | "applied"
  | "conflicted"
  | "expired"
  | "cleared";

export interface PendingInterviewSectionHint {
  schemaVersion: 1;
  id: string;
  questionType: InterviewSectionQuestionType;
  sourceTurnId: string;
  sourceText: string;
  source: "interviewer-explicit";
  confidence: number;
  observedAt: number;
  expiresAt: number;
  runtimeEpoch: number;
  sessionId: string;
  disposition: InterviewSectionHintDisposition;
  consumedByQuestionId?: string;
}

export interface InterviewSectionTransitionDetection {
  detected: boolean;
  questionType?: InterviewSectionQuestionType;
  confidence: number;
  reason: string;
}

export interface InterviewSectionHintConsumption {
  disposition:
    | "no-hint"
    | "retained"
    | "applied"
    | "conflicted"
    | "expired"
    | "cleared";
  hint?: PendingInterviewSectionHint;
  nextHint?: PendingInterviewSectionHint;
  effectiveQuestionType: CanonicalQuestionType;
  changedTaskBoundary: boolean;
  reason: string;
}

const TRANSITION_FRAME =
  /\b(?:move|moving) on(?: to)?|\bgo(?:ing)? to|\b(?:begin|start)(?:ing)? with|\bnext (?:question|task|section|topic)|\bnew (?:question|task)|\blet(?:'s| us) (?:look at|move to|start with)|接下来|进入(?:下一|新的)?(?:题|部分|环节)|下一(?:题|部分|环节)|先看/iu;

const ACKNOWLEDGEMENT_PREFIX =
  /^(?:(?:okay|ok|right|great|good|looks good|sounds good|all right|yeah)[,.! ]+)+/iu;

const TRANSITION_ONLY_TOKENS = new Set([
  "a",
  "about",
  "and",
  "behavior",
  "behavioral",
  "coding",
  "design",
  "discussion",
  "field",
  "first",
  "general",
  "interview",
  "knowledge",
  "machine",
  "maybe",
  "ml",
  "next",
  "of",
  "part",
  "project",
  "question",
  "questions",
  "section",
  "some",
  "system",
  "systems",
  "task",
  "the",
  "to",
  "topic",
]);

const DEFERRED_OR_RETROSPECTIVE_FRAME =
  /\b(?:later|after(?:ward|wards)?|eventually|at the end|in a later round|we will (?:later )?(?:cover|discuss|ask)|we (?:covered|discussed|asked)|were difficult|was difficult)\b|稍后|之后再|最后会|刚才(?:讨论|问)|之前(?:讨论|问)/iu;

const SOURCE_OWNED_TASK_FRAME =
  /(?:^|[.!?。！？]\s*)(?:now\s+)?(?:please\s+)?(?:design|build|implement|write|code|solve|explain|describe|outline|propose|create|sketch|estimate|compare|evaluate|provide)\b|(?:\b(?:you (?:need|have|will|should) to|we (?:need|want) you to|can you|could you|would you)\s+)(?:design|build|implement|write|code|solve|explain|describe|outline|propose|create|sketch|estimate|compare|evaluate|provide)\b|(?:请|设计|实现|编写|解释|描述|概述|提出|创建|估算|比较|评估|提供)/iu;

const SECTION_PATTERNS: Array<{
  questionType: InterviewSectionQuestionType;
  pattern: RegExp;
}> = [
  {
    questionType: "ai-ml-system-design",
    pattern:
      /\b(?:ai|ml|machine learning|artificial intelligence)[ /-]*(?:ml )?system design\b|\b(?:recommendation|rag|ranking|retrieval) system design\b|AI[ /-]*ML系统设计|机器学习系统设计|人工智能系统设计/iu,
  },
  {
    questionType: "general-system-design",
    pattern:
      /\b(?:general )?(?:systems? design|system-design|architecture design)\b|通用系统设计|系统设计/iu,
  },
  {
    questionType: "project-deep-dive",
    pattern:
      /\b(?:project|resume) (?:deep dive|discussion|questions?)\b|\bdeep dive (?:on|into) (?:a |your )?project\b|项目深挖|项目介绍|简历项目/iu,
  },
  {
    questionType: "behavioral",
    pattern:
      /\b(?:behavioral|behavioural|leadership principle|leadership) questions?\b|行为题|行为面试|领导力准则/iu,
  },
  {
    questionType: "coding",
    pattern:
      /\b(?:coding|algorithm|data structure|leetcode) questions?\b|\bcoding section\b|编程题|算法题|代码题/iu,
  },
  {
    questionType: "field-knowledge",
    pattern:
      /\b(?:field knowledge|technical knowledge|fundamentals|conceptual) questions?\b|知识题|基础知识|技术知识/iu,
  },
];

/**
 * Separates a pure interview-section announcement from a transition that also
 * contains an answerable question. The structured section parser extends this
 * decision later; this guard exists so transition language cannot suppress a
 * complete source-owned turn.
 */
export function classifyInterviewTransitionTurn(
  text: string
): InterviewTransitionTurnDecision {
  const normalized = normalize(text);
  const transitionMatch = normalized.match(TRANSITION_FRAME);
  if (!transitionMatch || transitionMatch.index === undefined) {
    return {
      detected: false,
      disposition: "none",
      reason: "no-transition-frame",
    };
  }

  const suffix = normalized
    .slice(transitionMatch.index + transitionMatch[0].length)
    .replace(/\b(?:to|with|some|the|a|our|maybe)\b/giu, " ")
    .replace(/[^\p{L}\p{N}+#]+/gu, " ")
    .trim();
  const prefix = normalized.slice(0, transitionMatch.index).trim();
  const suffixTokens = suffix.split(/\s+/u).filter(Boolean);
  const substantiveTokens = suffixTokens.filter(
    (token) => !TRANSITION_ONLY_TOKENS.has(token)
  );
  const hasQuestionMarker = /[?？]/u.test(text);
  const hasInterrogativeClause =
    /\b(?:how|what|why|when|where|which|who)\s+(?:do|does|did|is|are|was|were|would|will|should|can|could|have|has)\b/iu.test(
      normalized
    ) || /(?:怎么|如何|为什么|哪里|什么|哪种|是否)/u.test(text);
  const hasTaskPayload =
    /\b(?:design|build|implement|write|code|solve|explain|describe|outline|propose|create|sketch|estimate|compare|evaluate|provide)\b/iu.test(
      suffix
    ) && substantiveTokens.length >= 2;
  const hasLeadingTaskPayload = SOURCE_OWNED_TASK_FRAME.test(prefix);

  if (
    hasQuestionMarker ||
    hasInterrogativeClause ||
    hasTaskPayload ||
    hasLeadingTaskPayload
  ) {
    return {
      detected: true,
      disposition: "complete-question",
      reason: hasQuestionMarker
        ? "transition-with-question-marker"
        : hasInterrogativeClause
          ? "transition-with-interrogative-clause"
          : hasLeadingTaskPayload
            ? "transition-with-leading-task-payload"
            : "transition-with-task-payload",
    };
  }

  return {
    detected: true,
    disposition: "hint-only",
    reason: "transition-announcement-only",
  };
}

export function reconcileInterviewTransitionTurnWithPrimaryAsk(
  decision: InterviewTransitionTurnDecision,
  normalizedPrimaryAsk: string | undefined
): InterviewTransitionTurnDecision {
  if (
    decision.disposition !== "hint-only" ||
    !normalizedPrimaryAsk?.trim()
  ) {
    return decision;
  }

  return {
    detected: true,
    disposition: "complete-question",
    reason: "transition-with-primary-ask-projection",
  };
}

export function detectInterviewSectionTransition(
  text: string
): InterviewSectionTransitionDetection {
  const normalized = normalize(text);
  if (!TRANSITION_FRAME.test(normalized)) {
    return {
      detected: false,
      confidence: 0,
      reason: "no-immediate-transition-frame",
    };
  }
  if (DEFERRED_OR_RETROSPECTIVE_FRAME.test(normalized)) {
    return {
      detected: false,
      confidence: 0,
      reason: "deferred-or-retrospective-section-reference",
    };
  }

  const matched = SECTION_PATTERNS.find(({ pattern }) => pattern.test(normalized));
  if (!matched) {
    return {
      detected: false,
      confidence: 0,
      reason: "transition-without-canonical-section",
    };
  }

  return {
    detected: true,
    questionType: matched.questionType,
    confidence: 0.98,
    reason: "explicit-immediate-section-transition",
  };
}

export function createPendingInterviewSectionHint(input: {
  detection: InterviewSectionTransitionDetection;
  sourceTurnId: string;
  sourceText: string;
  sessionId: string;
  runtimeEpoch: number;
  observedAt?: number;
  id?: string;
}): PendingInterviewSectionHint | undefined {
  if (!input.detection.detected || !input.detection.questionType) {
    return undefined;
  }
  const observedAt = input.observedAt ?? Date.now();
  return {
    schemaVersion: 1,
    id: input.id ?? createMeetingId("section_hint"),
    questionType: input.detection.questionType,
    sourceTurnId: input.sourceTurnId,
    sourceText: input.sourceText.trim().slice(0, 600),
    source: "interviewer-explicit",
    confidence: input.detection.confidence,
    observedAt,
    expiresAt: observedAt + INTERVIEW_SECTION_HINT_TTL_MS,
    runtimeEpoch: input.runtimeEpoch,
    sessionId: input.sessionId,
    disposition: "pending",
  };
}

export function consumeInterviewSectionHint(input: {
  hint?: PendingInterviewSectionHint;
  questionId: string;
  currentQuestionType: CanonicalQuestionType;
  substantive: boolean;
  sessionId: string;
  runtimeEpoch: number;
  now?: number;
}): InterviewSectionHintConsumption {
  const hint = input.hint;
  if (!hint) {
    return noHint(input.currentQuestionType);
  }
  if (
    hint.sessionId !== input.sessionId ||
    hint.runtimeEpoch !== input.runtimeEpoch
  ) {
    return terminalConsumption(
      hint,
      "cleared",
      input.currentQuestionType,
      "runtime-or-session-mismatch"
    );
  }
  if ((input.now ?? Date.now()) > hint.expiresAt) {
    return terminalConsumption(
      hint,
      "expired",
      input.currentQuestionType,
      "section-hint-expired"
    );
  }
  if (!input.substantive) {
    return {
      disposition: "retained",
      hint,
      nextHint: hint,
      effectiveQuestionType: input.currentQuestionType,
      changedTaskBoundary: false,
      reason: "non-substantive-question-source",
    };
  }

  const concreteType = input.currentQuestionType;
  if (concreteType !== "unknown" && concreteType !== hint.questionType) {
    return terminalConsumption(
      { ...hint, consumedByQuestionId: input.questionId },
      "conflicted",
      concreteType,
      "concrete-question-conflicts-with-section-hint"
    );
  }

  return terminalConsumption(
    { ...hint, consumedByQuestionId: input.questionId },
    "applied",
    hint.questionType,
    concreteType === "unknown"
      ? "section-hint-rescued-unknown"
      : "section-hint-confirmed-question-type",
    true
  );
}

export function formatInterviewSectionHintForTrace(
  consumption: InterviewSectionHintConsumption | undefined
) {
  const hint = consumption?.hint;
  if (!consumption) return {};
  return {
    sectionHintDetected: Boolean(hint),
    sectionHintId: hint?.id,
    sectionHintType: hint?.questionType,
    sectionHintSourceTurnId: hint?.sourceTurnId,
    sectionHintObservedAt: hint?.observedAt,
    sectionHintExpiresAt: hint?.expiresAt,
    sectionHintDisposition: consumption.disposition,
    sectionHintConsumedByQuestionId: hint?.consumedByQuestionId,
    sectionHintClassificationAfter: consumption.effectiveQuestionType,
    sectionHintChangedTaskBoundary: consumption.changedTaskBoundary,
    sectionHintConflictReason:
      consumption.disposition === "conflicted"
        ? consumption.reason
        : undefined,
  };
}

function normalize(text: string) {
  return text
    .trim()
    .replace(ACKNOWLEDGEMENT_PREFIX, "")
    .replace(/[’]/gu, "'")
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

function noHint(
  currentQuestionType: CanonicalQuestionType
): InterviewSectionHintConsumption {
  return {
    disposition: "no-hint",
    effectiveQuestionType: currentQuestionType,
    changedTaskBoundary: false,
    reason: "no-pending-section-hint",
  };
}

function terminalConsumption(
  hint: PendingInterviewSectionHint,
  disposition: "applied" | "conflicted" | "expired" | "cleared",
  effectiveQuestionType: CanonicalQuestionType,
  reason: string,
  changedTaskBoundary = false
): InterviewSectionHintConsumption {
  const terminalHint = { ...hint, disposition };
  return {
    disposition,
    hint: terminalHint,
    effectiveQuestionType,
    changedTaskBoundary,
    reason,
  };
}
