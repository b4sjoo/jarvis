import {
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";
import type { ActiveInterviewParent } from "./types.js";

export type CrossDomainParentTransitionKind =
  | "independent-new-parent"
  | "linked-parent-extension";

export interface CrossDomainParentTransitionDecision {
  kind: CrossDomainParentTransitionKind;
  reason: string;
  previousQuestionType?: CanonicalQuestionType;
  nextQuestionType: CanonicalQuestionType;
  sharedDomainTokens: string[];
  evidence: string[];
}

export function decideCrossDomainParentTransition(input: {
  previousParent?: ActiveInterviewParent;
  nextQuestionType?: unknown;
  nextQuestionText: string;
}): CrossDomainParentTransitionDecision {
  const previousQuestionType = normalizeCanonicalQuestionType(
    input.previousParent?.stableKind
  );
  const nextQuestionType =
    normalizeCanonicalQuestionType(input.nextQuestionType) ?? "unknown";
  const nextText = normalizeTransitionText(input.nextQuestionText);
  const previousText = normalizeTransitionText(input.previousParent?.topic ?? "");
  const previousTokens = extractTransitionDomainTokens(previousText);
  const evidence: string[] = [];
  const sharedDomainTokens = extractTransitionDomainTokens(nextText).filter(
    (token) => previousTokens.includes(token)
  );

  if (
    previousQuestionType !== "general-system-design" ||
    nextQuestionType !== "ai-ml-system-design"
  ) {
    return {
      kind: "independent-new-parent",
      reason: "cross-domain-transition-is-not-general-sd-to-ai-ml-extension",
      previousQuestionType,
      nextQuestionType,
      sharedDomainTokens,
      evidence,
    };
  }

  const explicitSameProduct =
    /\b(for|within|inside|on top of) (?:this|the same|the existing|the current) (?:app|application|system|platform|product|service)\b/i.test(
      nextText
    ) ||
    /\badd (?:an? )?.{0,45}\bto (?:this|the same|the existing|the current) (?:app|application|system|platform|product|service)\b/i.test(
      nextText
    );
  const explicitIndependentSwitch =
    /\b(next question|move on|another (?:question|system|problem|scenario)|separately|unrelated|different (?:product|system|app|scenario))\b/i.test(
      nextText
    );
  const hasAimlExtensionObject =
    /\b(recommend(?:ation|er)|ranking|retrieval|rag|search relevance|personalization|machine learning|ml|ai|model|agent|feature pipeline|training pipeline|inference|serving)\b/i.test(
      nextText
    );

  if (explicitSameProduct) evidence.push("explicit-same-product-marker");
  if (explicitIndependentSwitch) evidence.push("explicit-independent-switch");
  if (hasAimlExtensionObject) evidence.push("ai-ml-extension-object");
  if (sharedDomainTokens.length) {
    evidence.push(
      `shared-domain-token:${sharedDomainTokens.slice(0, 4).join(",")}`
    );
  }

  const linked =
    !explicitIndependentSwitch &&
    (explicitSameProduct ||
      (hasAimlExtensionObject && sharedDomainTokens.length > 0));

  return {
    kind: linked ? "linked-parent-extension" : "independent-new-parent",
    reason: linked
      ? explicitSameProduct
        ? "explicit-same-product-ai-ml-extension"
        : "shared-product-domain-ai-ml-extension"
      : explicitIndependentSwitch
        ? "explicit-independent-cross-domain-switch"
        : "insufficient-source-backed-product-continuity",
    previousQuestionType,
    nextQuestionType,
    sharedDomainTokens,
    evidence,
  };
}

export function formatCrossDomainParentTransitionForTrace(
  decision: CrossDomainParentTransitionDecision | undefined
): Record<string, unknown> {
  if (!decision) return {};
  return {
    crossDomainTransitionKind: decision.kind,
    crossDomainTransitionReason: decision.reason,
    crossDomainPreviousQuestionType: decision.previousQuestionType,
    crossDomainNextQuestionType: decision.nextQuestionType,
    crossDomainSharedDomainTokens: decision.sharedDomainTokens,
    crossDomainTransitionEvidence: decision.evidence,
    parentContextHandoffKind:
      decision.kind === "linked-parent-extension"
        ? "bounded-source-backed"
        : "none",
  };
}

const TRANSITION_STOP_WORDS = new Set([
  "about",
  "agent",
  "application",
  "architect",
  "build",
  "current",
  "design",
  "existing",
  "implement",
  "platform",
  "product",
  "service",
  "system",
  "using",
  "with",
]);

function extractTransitionDomainTokens(text: string) {
  return Array.from(
    new Set(
      text
        .split(/[^a-z0-9]+/)
        .filter(
          (token) =>
            token.length >= 4 &&
            !TRANSITION_STOP_WORDS.has(token) &&
            !/^\d+$/.test(token)
        )
    )
  );
}

function normalizeTransitionText(text: string) {
  return text.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
}
