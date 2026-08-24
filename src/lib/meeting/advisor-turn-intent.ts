import { calculateWordEquivalent } from "./transcript-fusion.js";
import { decideSentenceCompletion } from "./sentence-completion-buffer.js";
import { inferExplicitProgrammingLanguageFromText } from "./programming-language.js";
import { classifyAdjacentConstraintKinds } from "./adjacent-question-constraint.js";
import { isExplicitMeetingLogisticsTranscript } from "./meeting-logistics.js";
import type { PlaybookPhaseControlEvidence } from "./playbook-phase.js";

export type AdvisorTurnIntent =
  | "direct-question"
  | "constraint-or-follow-up"
  | "correction"
  | "confirmation"
  | "informational"
  | "logistics"
  | "incomplete"
  | "unknown";

export type AdvisorTurnGateAction =
  | "ignore"
  | "append-only"
  | "state-update"
  | "answer-refresh";

export type AdvisorTurnIntentEnforcement = "allow" | "shadow" | "enforce";

export interface AdvisorTurnIntentDecision {
  intent: AdvisorTurnIntent;
  confidence: number;
  evidence: string[];
  action: AdvisorTurnGateAction;
  recommendedAction: AdvisorTurnGateAction;
  reason: string;
  contextPromptEligible: boolean;
  enforcement: AdvisorTurnIntentEnforcement;
  wouldSuppress: boolean;
  executionAuthorized: boolean;
  followupScopeSource?: "active-task" | "provisional-question" | "none";
  authoritySource?: "local" | "runtime-intent-gate";
  phaseControl?: PlaybookPhaseControlEvidence;
}

export interface AdvisorTurnIntentOptions {
  hasActiveTask: boolean;
  hasRecentQuestionContext?: boolean;
  hasPendingConfirmation?: boolean;
  hasCompanyContextOnly?: boolean;
  enforceBufferedIncomplete?: boolean;
}

export interface AdvisorExecutionAuthorization {
  authorized: boolean;
  reason: string;
  bypassed: boolean;
}

export const ADVISOR_INTENT_ENFORCEMENT_CONFIDENCE = 0.85;
export const ADVISOR_INTENT_SHADOW_CONFIDENCE = 0.6;

export function decideAdvisorTurnIntent(
  text: string,
  options: AdvisorTurnIntentOptions
): AdvisorTurnIntentDecision {
  const trimmed = text.trim();
  if (!trimmed) {
    return enforcedDecision({
      intent: "unknown",
      confidence: 1,
      evidence: ["empty-transcript"],
      action: "ignore",
      reason: "empty-transcript",
    });
  }

  const normalized = normalizeAdvisorTurnText(trimmed);
  const wordEquivalent = calculateWordEquivalent(trimmed);
  const directAskEvidence = collectDirectAskEvidence(trimmed, normalized);
  const constraintEvidence = collectConstraintEvidence(normalized);
  const correctionEvidence = collectCorrectionEvidence(normalized);
  const followupScopeSource = options.hasActiveTask
    ? "active-task"
    : options.hasRecentQuestionContext
      ? "provisional-question"
      : "none";
  const hasQuestionScope = followupScopeSource !== "none";

  if (isExactLowValueAcknowledgement(normalized)) {
    if (options.hasPendingConfirmation) {
      return allowedDecision({
        intent: "confirmation",
        confidence: 0.98,
        evidence: [
          "pending-confirmation",
          "short-confirmation",
          "exact-acknowledgement",
        ],
        action: "answer-refresh",
        reason: "contextual-confirmation",
        contextPromptEligible: true,
      });
    }

    return enforcedDecision({
      intent: "confirmation",
      confidence: 0.98,
      evidence: [
        "short-confirmation",
        "exact-acknowledgement",
        "no-pending-confirmation",
      ],
      action: "ignore",
      reason: "exact-acknowledgement",
    });
  }

  if (directAskEvidence.length === 0 && isMeetingLogistics(normalized)) {
    return enforcedDecision({
      intent: "logistics",
      confidence: 0.96,
      evidence: ["meeting-logistics"],
      action: "append-only",
      reason: "meeting-logistics",
    });
  }

  if (options.hasCompanyContextOnly && directAskEvidence.length === 0) {
    return enforcedDecision({
      intent: "informational",
      confidence: 0.95,
      evidence: ["company-context-only"],
      action: "state-update",
      reason: "company-context-only",
    });
  }

  if (decideSentenceCompletion(trimmed).disposition === "buffer") {
    if (options.enforceBufferedIncomplete) {
      return enforcedDecision({
        intent: "incomplete",
        confidence: 0.95,
        evidence: ["buffered-incomplete-clause"],
        action: "append-only",
        reason: "incomplete-buffer-flushed",
        contextPromptEligible: true,
      });
    }

    return shadowDecision({
      intent: "incomplete",
      confidence: 0.8,
      evidence: ["incomplete-clause"],
      recommendedAction: "append-only",
      reason: "incomplete-awaiting-buffer",
      contextPromptEligible: true,
    });
  }

  if (correctionEvidence.length > 0) {
    if (directAskEvidence.length > 0) {
      return withFollowupScope(allowedDecision({
        intent: "correction",
        confidence: 0.98,
        evidence: [...correctionEvidence, ...directAskEvidence],
        action: "answer-refresh",
        reason: hasQuestionScope
          ? "scoped-correction-direct-ask"
          : "self-contained-correction-direct-ask",
        contextPromptEligible: true,
      }), followupScopeSource);
    }

    if (hasQuestionScope) {
      return withFollowupScope(allowedDecision({
        intent: "correction",
        confidence: 0.96,
        evidence: correctionEvidence,
        action: "answer-refresh",
        reason: options.hasActiveTask
          ? "active-task-correction"
          : "recent-question-correction",
        contextPromptEligible: true,
      }), followupScopeSource);
    }

    return withFollowupScope(enforcedDecision({
      intent: "correction",
      confidence: 0.9,
      evidence: [...correctionEvidence, "no-question-scope"],
      action: "append-only",
      reason: "unscoped-correction",
    }), followupScopeSource);
  }

  if (constraintEvidence.length > 0) {
    if (hasQuestionScope) {
      return withFollowupScope(allowedDecision({
        intent: "constraint-or-follow-up",
        confidence: 0.94,
        evidence: constraintEvidence,
        action: "answer-refresh",
        reason: options.hasActiveTask
          ? "active-task-constraint"
          : "recent-question-constraint",
        contextPromptEligible: true,
      }), followupScopeSource);
    }

    return withFollowupScope(enforcedDecision({
      intent: "informational",
      confidence: 0.88,
      evidence: [...constraintEvidence, "no-question-scope"],
      action: "append-only",
      reason: "unscoped-constraint",
    }), followupScopeSource);
  }

  if (directAskEvidence.length > 0) {
    return allowedDecision({
      intent: "direct-question",
      confidence: 0.97,
      evidence: directAskEvidence,
      action: "answer-refresh",
      reason: "direct-question-or-task",
      contextPromptEligible: true,
    });
  }

  const technicalEvidence = collectTechnicalEvidence(normalized);
  const followUpEvidence = collectFollowUpEvidence(normalized);
  const declarativeEvidence = collectDeclarativeEvidence(normalized);

  if (
    hasQuestionScope &&
    wordEquivalent <= 6 &&
    declarativeEvidence.length === 0 &&
    (technicalEvidence.length > 0 || followUpEvidence.length > 0)
  ) {
    return withFollowupScope(allowedDecision({
      intent: "constraint-or-follow-up",
      confidence: 0.88,
      evidence: [
        `${followupScopeSource}-elliptical-probe`,
        ...technicalEvidence,
        ...followUpEvidence,
      ],
      action: "answer-refresh",
      reason: `${followupScopeSource}-elliptical-probe`,
      contextPromptEligible: true,
    }), followupScopeSource);
  }

  if (
    !options.hasActiveTask &&
    wordEquivalent <= 12 &&
    /\b(your|you)\b/i.test(normalized) &&
    declarativeEvidence.length === 0
  ) {
    return allowedDecision({
      intent: "direct-question",
      confidence: 0.86,
      evidence: ["interview-elliptical-prompt"],
      action: "answer-refresh",
      reason: "interview-elliptical-prompt",
      contextPromptEligible: true,
    });
  }

  if (declarativeEvidence.length > 0) {
    return enforcedDecision({
      intent: "informational",
      confidence: technicalEvidence.length > 0 ? 0.93 : 0.88,
      evidence: [...declarativeEvidence, ...technicalEvidence],
      action: "append-only",
      reason: technicalEvidence.length > 0
        ? "technical-declarative-statement"
        : "declarative-statement",
      contextPromptEligible: hasQuestionScope,
    });
  }

  if (wordEquivalent < 3) {
    return shadowDecision({
      intent: "unknown",
      confidence: 0.65,
      evidence: ["short-ambiguous-turn"],
      recommendedAction: "ignore",
      reason: "short-ambiguous-turn",
      contextPromptEligible: true,
    });
  }

  return shadowDecision({
    intent: technicalEvidence.length > 0 ? "informational" : "unknown",
    confidence: technicalEvidence.length > 0 ? 0.72 : 0.64,
    evidence: technicalEvidence.length > 0
      ? ["ambiguous-technical-content", ...technicalEvidence]
      : ["ambiguous-substantive-turn"],
    recommendedAction: "append-only",
    reason: technicalEvidence.length > 0
      ? "ambiguous-technical-content"
      : "ambiguous-substantive-turn",
    contextPromptEligible: true,
  });
}

export function authorizeAdvisorExecution({
  force,
  hasExplicitAction,
  decision,
}: {
  force: boolean;
  hasExplicitAction: boolean;
  decision?: AdvisorTurnIntentDecision;
}): AdvisorExecutionAuthorization {
  if (force || hasExplicitAction) {
    return {
      authorized: true,
      reason: force ? "force-bypass" : "explicit-action-bypass",
      bypassed: true,
    };
  }

  if (!decision) {
    return {
      authorized: false,
      reason: "missing-turn-intent-decision",
      bypassed: false,
    };
  }

  return {
    authorized: decision.executionAuthorized,
    reason: decision.executionAuthorized
      ? decision.enforcement === "shadow"
        ? `shadow-fail-open:${decision.reason}`
        : `intent-authorized:${decision.reason}`
      : `intent-abstained:${decision.reason}`,
    bypassed: false,
  };
}

export function applySourceOwnedPhaseControlToTurnIntent(
  decision: AdvisorTurnIntentDecision,
  phaseControl: PlaybookPhaseControlEvidence | undefined
): AdvisorTurnIntentDecision {
  if (!phaseControl) return decision;
  return {
    ...decision,
    intent: "constraint-or-follow-up",
    confidence: Math.max(decision.confidence, 0.99),
    evidence: Array.from(
      new Set([
        ...decision.evidence,
        "source-owned-phase-control",
        phaseControl.signal,
        ...phaseControl.evidence,
      ])
    ),
    action: "answer-refresh",
    recommendedAction: "answer-refresh",
    reason: `source-owned-phase-control:${phaseControl.signal}`,
    contextPromptEligible: true,
    enforcement: "allow",
    wouldSuppress: false,
    executionAuthorized: true,
    followupScopeSource: "active-task",
    authoritySource: "local",
    phaseControl: {
      ...phaseControl,
      evidence: [...phaseControl.evidence],
    },
  };
}

export function formatAdvisorTurnIntentForTrace(
  decision: AdvisorTurnIntentDecision
) {
  const exactAcknowledgementSuppressed =
    decision.reason === "exact-acknowledgement" &&
    !decision.executionAuthorized;
  return {
    advisorTurnIntent: decision.intent,
    advisorTurnAction: decision.action,
    advisorTurnReason: decision.reason,
    advisorTurnConfidence: decision.confidence,
    advisorTurnEvidence: decision.evidence,
    advisorTurnEnforcement: decision.enforcement,
    advisorTurnRecommendedAction: decision.recommendedAction,
    advisorWouldSuppress: decision.wouldSuppress,
    advisorExecutionAuthorized: decision.executionAuthorized,
    advisorIntentAuthoritySource: decision.authoritySource ?? "local",
    followupScopeSource: decision.followupScopeSource ?? "none",
    advisorSuppressionOperation: exactAcknowledgementSuppressed
      ? "exact-acknowledgement"
      : undefined,
    advisorProviderCallAvoided: exactAcknowledgementSuppressed,
    advisorAvoidedCallOpportunity: exactAcknowledgementSuppressed,
    phaseSignal: decision.phaseControl?.signal,
    phaseSignalSource: decision.phaseControl?.source,
    phaseSignalSourceTurnId: decision.phaseControl?.sourceTurnId,
  };
}

function withFollowupScope(
  decision: AdvisorTurnIntentDecision,
  followupScopeSource: "active-task" | "provisional-question" | "none"
): AdvisorTurnIntentDecision {
  return { ...decision, followupScopeSource };
}

function allowedDecision({
  intent,
  confidence,
  evidence,
  action,
  reason,
  contextPromptEligible = false,
}: {
  intent: AdvisorTurnIntent;
  confidence: number;
  evidence: string[];
  action: AdvisorTurnGateAction;
  reason: string;
  contextPromptEligible?: boolean;
}): AdvisorTurnIntentDecision {
  return {
    intent,
    confidence,
    evidence,
    action,
    recommendedAction: action,
    reason,
    contextPromptEligible,
    enforcement: "allow",
    wouldSuppress: false,
    executionAuthorized: action === "answer-refresh",
    authoritySource: "local",
  };
}

function enforcedDecision({
  intent,
  confidence,
  evidence,
  action,
  reason,
  contextPromptEligible = false,
}: {
  intent: AdvisorTurnIntent;
  confidence: number;
  evidence: string[];
  action: Exclude<AdvisorTurnGateAction, "answer-refresh">;
  reason: string;
  contextPromptEligible?: boolean;
}): AdvisorTurnIntentDecision {
  return {
    intent,
    confidence,
    evidence,
    action,
    recommendedAction: action,
    reason,
    contextPromptEligible,
    enforcement: "enforce",
    wouldSuppress: true,
    executionAuthorized: false,
    authoritySource: "local",
  };
}

function shadowDecision({
  intent,
  confidence,
  evidence,
  recommendedAction,
  reason,
  contextPromptEligible,
}: {
  intent: AdvisorTurnIntent;
  confidence: number;
  evidence: string[];
  recommendedAction: Exclude<AdvisorTurnGateAction, "answer-refresh">;
  reason: string;
  contextPromptEligible: boolean;
}): AdvisorTurnIntentDecision {
  return {
    intent,
    confidence,
    evidence,
    action: "answer-refresh",
    recommendedAction,
    reason,
    contextPromptEligible,
    enforcement: "shadow",
    wouldSuppress: true,
    executionAuthorized: true,
    authoritySource: "local",
  };
}

function normalizeAdvisorTurnText(text: string) {
  return text
    .toLowerCase()
    .replace(/[’']/g, " ")
    .replace(/[^\p{L}\p{N}+#.()]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectDirectAskEvidence(text: string, normalized: string) {
  const evidence: string[] = [];
  if (/[?？]/.test(text)) evidence.push("question-mark");
  if (
    /^(can|could|would|will|do|does|did|is|are|was|were|have|has|had|how|what|why|when|where|which|who)\b/i.test(
      normalized
    )
  ) {
    evidence.push("interrogative-frame");
  }
  if (
    /\b(can you|could you|would you|let me ask you|tell me|give me|show me|walk me through|talk me through|share (?:an?|one) example|introduce yourself|explain|describe|outline|propose|design|create|sketch|implement|write|code|solve|compare|estimate|evaluate|talk about|discuss)\b/i.test(
      normalized
    )
  ) {
    evidence.push("explicit-task-frame");
  }
  if (
    /请|怎么|如何|为什么|解释|描述|设计|实现|写一个|比较|估算/.test(text) &&
    !isCjkIndirectQuestionClause(text)
  ) {
    evidence.push("cjk-question-or-task-frame");
  }
  evidence.push(...collectEmbeddedInterrogativeEvidence(text, normalized));
  return evidence;
}

function collectEmbeddedInterrogativeEvidence(
  text: string,
  normalized: string
) {
  const evidence: string[] = [];
  const invertedFrame =
    /\b(?:how|what|why|when|where|which|who)\s+(?:do|does|did|is|are|was|were|would|will|should|can|could|have|has|had)\b/iu;
  const match = invertedFrame.exec(normalized);
  if (match && match.index > 0) {
    evidence.push("embedded-interrogative-frame");
    const prefix = normalized.slice(0, match.index);
    if (
      /\b(?:yeah|okay|ok|right|so|then|and|but|if|assuming|suppose|given)\b/iu.test(
        prefix
      )
    ) {
      evidence.push("discourse-prefixed-question");
    }
  }

  const cjkEmbeddedQuestion =
    /(?:那么|那|所以|如果|假设|请问).*(?:哪里|哪儿|如何|怎么|为什么|是否|什么)(?:[呢吗]?[？?。]?)$/u.test(
      text.trim()
    );
  if (cjkEmbeddedQuestion && !isCjkIndirectQuestionClause(text)) {
    evidence.push("cjk-embedded-interrogative-frame");
    evidence.push("discourse-prefixed-question");
  }

  return evidence;
}

function isCjkIndirectQuestionClause(text: string) {
  return /(?:我们|文档|文章|材料|刚才).*(?:讨论|说明|解释|提到).*(?:哪里|哪儿|如何|怎么|为什么|是否)/u.test(
    text
  );
}

function collectConstraintEvidence(normalized: string) {
  const evidence: string[] = [];
  const explicitProgrammingLanguage =
    inferExplicitProgrammingLanguageFromText(normalized);
  if (explicitProgrammingLanguage) {
    evidence.push(`programming-language:${explicitProgrammingLanguage}`);
  }
  for (const kind of classifyAdjacentConstraintKinds(normalized)) {
    if (kind !== "programming-language") {
      evidence.push(`explicit-${kind}`);
    }
  }
  if (
    /\b\d+\s*(qps|tps|rps|users|requests|ms|seconds|minutes|kb|mb|gb|tb|k|m|million|billion)\b/i.test(
      normalized
    )
  ) {
    evidence.push("numeric-constraint");
  }
  if (
    /\b(assume|constraint|requirement|under the assumption|given that|must support|needs to support)\b/i.test(
      normalized
    )
  ) {
    evidence.push("explicit-constraint");
  }
  return evidence;
}

function collectCorrectionEvidence(normalized: string) {
  const evidence: string[] = [];
  if (
    /\b(i mean|actually|correction|rather than|instead of|over[ -]?design(?:ing|ed)?|too much design|not (?:a )?(rec|recommendation|python|java|javascript|typescript|go|golang|rust|c\+\+)|rag not|not rag)\b/i.test(
      normalized
    )
  ) {
    evidence.push("explicit-correction");
  }
  return evidence;
}

function collectTechnicalEvidence(normalized: string) {
  return /\b(api|async|binary|cache|client|complexity|control plane|data plane|database|dp|embedding|graph|grpc|hash|heap|http|java|javascript|latency|leetcode|memory|python|queue|rag|rate limiter|recursion|rust|scale|search|server|space|sql|stack|thread|tree|typescript|vector)\b/i.test(
    normalized
  ) || /算法|复杂度|缓存|数据库|队列|栈|堆|树|图|递归|并发|异步|接口|系统设计|限流|负载均衡|向量|嵌入/.test(
    normalized
  )
    ? ["technical-content"]
    : [];
}

function collectFollowUpEvidence(normalized: string) {
  return /\b(what about|how about|and the|tradeoff|edge case|follow up|optimi[sz]e|improve|change|update|same|different|another)\b/i.test(
    normalized
  )
    ? ["follow-up-cue"]
    : [];
}

function collectDeclarativeEvidence(normalized: string) {
  return /\b(is|are|was|were|has|have|had|sends|stores|uses|contains|provides|means|works|runs|handles|supports|allows|includes|consists|connects|writes|reads)\b/i.test(
    normalized
  ) || /(?:讨论了?|说明了?|解释了?|提到了?|存储|使用|包含|支持)/u.test(
    normalized
  )
    ? ["declarative-clause"]
    : [];
}

export function isExactLowValueAcknowledgement(text: string) {
  const normalized = normalizeAdvisorTurnText(text);
  const normalizedAcknowledgement = canonicalizeAcknowledgement(
    normalized.replace(/[.]+$/u, "")
  );
  const repeatedTokens = normalizedAcknowledgement
    .split(" ")
    .filter(Boolean);
  if (
    repeatedTokens.length >= 1 &&
    repeatedTokens.length <= 5 &&
    repeatedTokens.every((token) =>
      ACKNOWLEDGEMENT_ONLY_TOKENS.has(token)
    )
  ) {
    return true;
  }
  if (
    repeatedTokens.length >= 2 &&
    repeatedTokens.length <= 4 &&
    repeatedTokens.every((token) => token === repeatedTokens[0]) &&
    /^(ah|hmm|mm|mhm|uh|um|yeah|yep|yes|no|ok|okay|right|sure)$/i.test(
      repeatedTokens[0]
    )
  ) {
    return true;
  }
  if (
    /^(ah|eh|er|hmm|mm|mhm|uh|um|yeah|yep|yes|no|ok|okay|right|sure|cool|great|nice|perfect|all good|of course|sounds good|that sounds good|that is nice|that s nice|i see|got it|make sense|makes sense|thank you|thanks|hello|hi|good morning|good afternoon|good evening|good monday)$/i.test(
      normalizedAcknowledgement
    )
  ) {
    return true;
  }
  return /^(looks good|looks good to me|that looks good|that looks good to me|this looks good|this looks good to me|sounds good|sounds good to me|that sounds good|that sounds good to me|this sounds good|this sounds good to me)$/i.test(
    normalizedAcknowledgement
  );
}

const ACKNOWLEDGEMENT_ONLY_TOKENS = new Set([
  "ah",
  "eh",
  "er",
  "good",
  "great",
  "hmm",
  "mm",
  "mhm",
  "nice",
  "no",
  "ok",
  "okay",
  "perfect",
  "right",
  "sure",
  "thanks",
  "uh",
  "um",
  "yeah",
  "yep",
  "yes",
]);

function canonicalizeAcknowledgement(text: string) {
  const acousticFamily = text
    .replace(/\bmm\s*hmm\b/giu, "mhm")
    .replace(/\bmmhmm\b/giu, "mhm")
    .replace(/\bm\s*hm\b/giu, "mhm")
    .replace(/\buh\s*huh\b/giu, "uh")
    .replace(/\buhhuh\b/giu, "uh")
    .trim();
  const words = acousticFamily.split(" ").filter(Boolean);
  if (
    words.length >= 4 &&
    words.length % 2 === 0 &&
    words.slice(0, words.length / 2).join(" ") ===
      words.slice(words.length / 2).join(" ")
  ) {
    return words.slice(0, words.length / 2).join(" ");
  }
  return acousticFamily;
}

function isMeetingLogistics(normalized: string) {
  return isExplicitMeetingLogisticsTranscript(normalized);
}
