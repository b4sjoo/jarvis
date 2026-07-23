export type InterviewTransitionTurnDisposition =
  | "none"
  | "hint-only"
  | "complete-question";

export interface InterviewTransitionTurnDecision {
  detected: boolean;
  disposition: InterviewTransitionTurnDisposition;
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
    /\b(?:design|implement|write|code|solve|explain|describe|outline|propose|create|sketch|estimate|compare|evaluate)\b/iu.test(
      suffix
    ) && substantiveTokens.length >= 2;

  if (hasQuestionMarker || hasInterrogativeClause || hasTaskPayload) {
    return {
      detected: true,
      disposition: "complete-question",
      reason: hasQuestionMarker
        ? "transition-with-question-marker"
        : hasInterrogativeClause
          ? "transition-with-interrogative-clause"
          : "transition-with-task-payload",
    };
  }

  return {
    detected: true,
    disposition: "hint-only",
    reason: "transition-announcement-only",
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
