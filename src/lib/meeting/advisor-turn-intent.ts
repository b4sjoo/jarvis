import { calculateWordEquivalent } from "./transcript-fusion.js";

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
}

export interface AdvisorTurnIntentOptions {
  hasActiveTask: boolean;
  hasPendingConfirmation?: boolean;
  hasCompanyContextOnly?: boolean;
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

  if (isLowValueAcknowledgement(normalized)) {
    if (options.hasPendingConfirmation) {
      return allowedDecision({
        intent: "confirmation",
        confidence: 0.98,
        evidence: ["pending-confirmation", "short-confirmation"],
        action: "answer-refresh",
        reason: "contextual-confirmation",
        contextPromptEligible: true,
      });
    }

    return enforcedDecision({
      intent: "confirmation",
      confidence: 0.98,
      evidence: ["short-confirmation", "no-pending-confirmation"],
      action: "ignore",
      reason: "unscoped-confirmation",
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

  if (isObviouslyIncomplete(trimmed, normalized)) {
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
    if (options.hasActiveTask) {
      return allowedDecision({
        intent: "correction",
        confidence: 0.96,
        evidence: correctionEvidence,
        action: "answer-refresh",
        reason: "active-task-correction",
        contextPromptEligible: true,
      });
    }

    return enforcedDecision({
      intent: "correction",
      confidence: 0.9,
      evidence: [...correctionEvidence, "no-active-task"],
      action: "append-only",
      reason: "unscoped-correction",
    });
  }

  if (constraintEvidence.length > 0) {
    if (options.hasActiveTask) {
      return allowedDecision({
        intent: "constraint-or-follow-up",
        confidence: 0.94,
        evidence: constraintEvidence,
        action: "answer-refresh",
        reason: "active-task-constraint",
        contextPromptEligible: true,
      });
    }

    return enforcedDecision({
      intent: "informational",
      confidence: 0.88,
      evidence: [...constraintEvidence, "no-active-task"],
      action: "append-only",
      reason: "unscoped-constraint",
    });
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
    options.hasActiveTask &&
    wordEquivalent <= 6 &&
    declarativeEvidence.length === 0 &&
    (technicalEvidence.length > 0 || followUpEvidence.length > 0)
  ) {
    return allowedDecision({
      intent: "constraint-or-follow-up",
      confidence: 0.88,
      evidence: [
        "active-task-elliptical-probe",
        ...technicalEvidence,
        ...followUpEvidence,
      ],
      action: "answer-refresh",
      reason: "active-task-elliptical-probe",
      contextPromptEligible: true,
    });
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
      contextPromptEligible: options.hasActiveTask,
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

export function formatAdvisorTurnIntentForTrace(
  decision: AdvisorTurnIntentDecision
) {
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
  };
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
  if (/请|怎么|如何|为什么|解释|描述|设计|实现|写一个|比较|估算/.test(text)) {
    evidence.push("cjk-question-or-task-frame");
  }
  return evidence;
}

function collectConstraintEvidence(normalized: string) {
  const evidence: string[] = [];
  if (
    /\b\d+\s*(qps|tps|rps|users|requests|ms|seconds|minutes|kb|mb|gb|tb|k|m|million|billion)\b/i.test(
      normalized
    )
  ) {
    evidence.push("numeric-constraint");
  }
  if (
    /\b(assume|constraint|requirement|under the assumption|given that|must support|needs to support|use (python|java|javascript|typescript|go|golang|rust|c\+\+))\b/i.test(
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
    /\b(i mean|actually|correction|rather than|instead of|not (rec|recommendation|python|java|javascript|typescript|go|golang|rust|c\+\+)|rag not|not rag)\b/i.test(
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
  )
    ? ["declarative-clause"]
    : [];
}

function isObviouslyIncomplete(text: string, normalized: string) {
  return (
    /\.{2,}\s*$/.test(text) ||
    /\b(the next one is|because|and|or|but|so|then|can you|could you|would you|tell me|describe|explain)\s*$/i.test(
      normalized
    )
  );
}

function isLowValueAcknowledgement(normalized: string) {
  return /^(ah|eh|er|hmm|mm|mhm|uh|um|yeah|yep|yes|no|ok|okay|right|sure|cool|great|nice|perfect|all good|sounds good|that sounds good|that is nice|that s nice|i see|got it|make sense|makes sense|thank you|thanks)$/i.test(
    normalized
  );
}

function isMeetingLogistics(normalized: string) {
  return /\b(one second|just a second|hold on|wait a second|take a look|share my screen|sharing my screen|start our interview|start the interview|let s start|let us start|let me search|let me think|let me check)\b/i.test(
    normalized
  ) || /等一下|稍等|我看一下|我想一下|我分享屏幕|开始面试|开始吧/.test(
    normalized
  );
}
