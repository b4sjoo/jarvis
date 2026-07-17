import type {
  MemoryQuestionType,
  MemoryRetrievalResult,
  RetrievedMemoryEntry,
} from "@/lib/memory";
import {
  getRuntimeFactAnchorLabel,
  resolveRetrievedMemoryRole,
} from "../memory/runtime-role.js";
import type {
  FactAnchorDecision,
  FactAnchorRequiredFor,
  PersonalEvidenceGuardrailMode,
} from "./types";
import { detectPersonalEvidenceRequirement } from "./personal-evidence-guardrail.js";

const GENERIC_ANCHOR_TITLES = new Set([
  "behavioral story",
  "behavioral interview story selector",
  "project deep dive",
  "general system design",
  "ai/ml system design",
  "coding algorithm",
  "field knowledge",
]);

export interface BuildFactAnchorDecisionInput {
  questionType?: MemoryQuestionType;
  questionText?: string;
  personalEvidenceGuardrailMode?: PersonalEvidenceGuardrailMode;
  memoryContext?: MemoryRetrievalResult | null;
  activeFactAnchors?: string[];
  projectAnchor?: string;
}

export function buildFactAnchorDecision({
  questionType,
  questionText,
  personalEvidenceGuardrailMode = "enforcement",
  memoryContext,
  activeFactAnchors = [],
  projectAnchor,
}: BuildFactAnchorDecisionInput): FactAnchorDecision {
  const personalEvidence = detectPersonalEvidenceRequirement({
    questionText,
    questionType,
    mode: personalEvidenceGuardrailMode,
  });
  const requiredFor = getFactAnchorRequirement(questionType, personalEvidence);
  if (requiredFor === "none") {
    return {
      state: "not-required",
      requiredFor,
      supportedAnchorIds: [],
      supportedAnchorTitles: [],
      action: "answer-with-anchor",
      personalEvidence,
      unsupportedClaimRisk:
        personalEvidence.mode === "shadow" &&
        personalEvidence.confidenceTier === "high" &&
        personalEvidence.requirement !== "not-required"
          ? "shadow-observed"
          : "none",
    };
  }

  const memoryAnchors = collectFactAnchorEntries(memoryContext?.entries ?? []);
  const activeAnchors = normalizeActiveFactAnchors(activeFactAnchors);
  const supportedAnchorIds = uniqueStrings([
    ...memoryAnchors.map((item) => item.entry.id),
    ...activeAnchors,
  ]);
  const supportedAnchorTitles = uniqueStrings([
    ...memoryAnchors.map(formatMemoryAnchorTitle),
    ...activeAnchors,
  ]);

  if (memoryAnchors.length || activeAnchors.length) {
    return {
      state: "strong-anchor",
      requiredFor,
      supportedAnchorIds,
      supportedAnchorTitles,
      selectedAnchorId: memoryAnchors[0]?.entry.id ?? activeAnchors[0],
      action: "answer-with-anchor",
      personalEvidence,
      unsupportedClaimRisk: "guarded",
    };
  }

  const selectedNonAnchorEntries = memoryContext?.entries.length ?? 0;
  if (selectedNonAnchorEntries > 0) {
    return {
      state: "weak-anchor",
      requiredFor,
      supportedAnchorIds: [],
      supportedAnchorTitles: [],
      action: "answer-with-caveats",
      missingAnchorReason:
        "Memory retrieval found guidance or rubrics, but no concrete project/story fact anchor.",
      personalEvidence,
      unsupportedClaimRisk: "high",
    };
  }

  const projectHint = projectAnchor?.trim();
  return {
    state: "no-anchor",
    requiredFor,
    supportedAnchorIds: [],
    supportedAnchorTitles: projectHint ? [projectHint] : [],
    action: projectHint ? "offer-supported-choices" : "ask-clarification",
    missingAnchorReason: projectHint
      ? `The task mentions "${projectHint}", but no curated memory fact anchor was retrieved for it.`
      : "No curated memory fact anchor was retrieved for this behavioral or project deep-dive answer.",
    personalEvidence,
    unsupportedClaimRisk: "high",
  };
}

export function formatFactAnchorDecisionForPrompt(
  decision: FactAnchorDecision | undefined
) {
  if (!decision) return "No fact-anchor decision was computed.";

  return [
    `State: ${decision.state}`,
    `Required for: ${decision.requiredFor}`,
    `Action: ${decision.action}`,
    `Personal evidence requirement: ${decision.personalEvidence.requirement}`,
    `Personal evidence confidence: ${decision.personalEvidence.confidenceTier} (${decision.personalEvidence.confidence.toFixed(2)})`,
    `Personal evidence mode: ${decision.personalEvidence.mode}`,
    `Personal evidence enforced: ${decision.personalEvidence.enforced}`,
    decision.personalEvidence.signals.length
      ? `Personal evidence signals: ${decision.personalEvidence.signals.join(", ")}`
      : undefined,
    decision.personalEvidence.counterSignals.length
      ? `Hypothetical counter-signals: ${decision.personalEvidence.counterSignals.join(", ")}`
      : undefined,
    `Unsupported claim risk: ${decision.unsupportedClaimRisk}`,
    decision.supportedAnchorTitles.length
      ? `Supported anchors: ${decision.supportedAnchorTitles.join(", ")}`
      : "Supported anchors: none",
    decision.selectedAnchorId
      ? `Selected anchor id: ${decision.selectedAnchorId}`
      : undefined,
    decision.missingAnchorReason
      ? `Reason: ${decision.missingAnchorReason}`
      : undefined,
    decision.personalEvidence.requirement === "personal-logistics"
      ? "Personal logistics rule: use only Interview Brief/profile facts. Do not borrow project-memory facts; if the needed fact is absent, answer safely or ask for it."
      : undefined,
    decision.personalEvidence.enforced
      ? "Classifier-independent rule: enforce Action even if the question type is coding, field knowledge, system design, or unknown. Question wording and suggested alternatives are not evidence."
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatFactAnchorDecisionForTrace(
  decision: FactAnchorDecision | undefined
): Record<string, unknown> {
  if (!decision) return {};

  return {
    factAnchorState: decision.state,
    factAnchorRequiredFor: decision.requiredFor,
    factAnchorAction: decision.action,
    factAnchorSupportedIds: decision.supportedAnchorIds,
    factAnchorSupportedTitles: decision.supportedAnchorTitles,
    factAnchorSelectedId: decision.selectedAnchorId,
    factAnchorMissingReason: decision.missingAnchorReason,
    personalEvidenceRequirement: decision.personalEvidence.requirement,
    personalEvidenceConfidence: decision.personalEvidence.confidence,
    personalEvidenceConfidenceTier: decision.personalEvidence.confidenceTier,
    personalEvidenceSignals: decision.personalEvidence.signals,
    personalEvidenceCounterSignals: decision.personalEvidence.counterSignals,
    personalEvidenceGuardrailMode: decision.personalEvidence.mode,
    personalEvidenceEnforced: decision.personalEvidence.enforced,
    unsupportedClaimRisk: decision.unsupportedClaimRisk,
  };
}

function getFactAnchorRequirement(
  questionType: MemoryQuestionType | undefined,
  personalEvidence: FactAnchorDecision["personalEvidence"]
): FactAnchorRequiredFor {
  if (personalEvidence.enforced) {
    return personalEvidence.requirement === "autobiographical-behavioral"
      ? "behavioral"
      : "project-deep-dive";
  }
  if (questionType === "behavioral") return "behavioral";
  if (questionType === "project-deep-dive") return "project-deep-dive";
  return "none";
}

function collectFactAnchorEntries(
  entries: RetrievedMemoryEntry[]
) {
  return entries.filter(
    (item) => resolveRetrievedMemoryRole(item).anchorEligible
  );
}

function formatMemoryAnchorTitle(item: RetrievedMemoryEntry) {
  return getRuntimeFactAnchorLabel(item.entry);
}

function normalizeActiveFactAnchors(anchors: string[]) {
  return uniqueStrings(
    anchors
      .map((anchor) => anchor.trim())
      .filter(Boolean)
      .filter((anchor) => !GENERIC_ANCHOR_TITLES.has(anchor.toLowerCase()))
  ).slice(0, 8);
}

function uniqueStrings(values: Array<string | undefined>) {
  return Array.from(new Set(values.filter(Boolean) as string[]));
}
