import type {
  MemoryEntry,
  MemoryQuestionType,
  MemoryRetrievalResult,
  RetrievedMemoryEntry,
} from "@/lib/memory";
import type {
  FactAnchorDecision,
  FactAnchorRequiredFor,
} from "./types";

const FACT_ANCHOR_ENTRY_TYPES = new Set<MemoryEntry["type"]>([
  "resume_fact",
  "personal_story",
  "achievement_metric",
  "answer_evidence",
  "working_summary",
  "project_context",
  "design_doc",
  "implementation_note",
  "decision_record",
  "investigation_note",
  "threat_model",
  "field_note",
  "cached_answer",
]);

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
  memoryContext?: MemoryRetrievalResult | null;
  activeFactAnchors?: string[];
  projectAnchor?: string;
}

export function buildFactAnchorDecision({
  questionType,
  memoryContext,
  activeFactAnchors = [],
  projectAnchor,
}: BuildFactAnchorDecisionInput): FactAnchorDecision {
  const requiredFor = getFactAnchorRequirement(questionType);
  if (requiredFor === "none") {
    return {
      state: "not-required",
      requiredFor,
      supportedAnchorIds: [],
      supportedAnchorTitles: [],
      action: "answer-with-anchor",
    };
  }

  const memoryAnchors = collectFactAnchorEntries(
    memoryContext?.entries ?? [],
    requiredFor
  );
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
    decision.supportedAnchorTitles.length
      ? `Supported anchors: ${decision.supportedAnchorTitles.join(", ")}`
      : "Supported anchors: none",
    decision.selectedAnchorId
      ? `Selected anchor id: ${decision.selectedAnchorId}`
      : undefined,
    decision.missingAnchorReason
      ? `Reason: ${decision.missingAnchorReason}`
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
  };
}

function getFactAnchorRequirement(
  questionType: MemoryQuestionType | undefined
): FactAnchorRequiredFor {
  if (questionType === "behavioral") return "behavioral";
  if (questionType === "project-deep-dive") return "project-deep-dive";
  return "none";
}

function collectFactAnchorEntries(
  entries: RetrievedMemoryEntry[],
  requiredFor: Exclude<FactAnchorRequiredFor, "none">
) {
  return entries.filter((item) =>
    isFactAnchorEntry(item.entry, requiredFor, item.matchReason)
  );
}

function isFactAnchorEntry(
  entry: MemoryEntry,
  requiredFor: Exclude<FactAnchorRequiredFor, "none">,
  matchReason: string[]
) {
  if (FACT_ANCHOR_ENTRY_TYPES.has(entry.type)) return true;
  if (entry.projectId || entry.projectName) return true;
  if (matchReason.includes("behavioral:story-anchor")) return true;
  if (matchReason.includes("project:fact-anchor")) return true;

  if (
    requiredFor === "behavioral" &&
    (entry.type === "answer_template" || entry.type === "cached_answer")
  ) {
    return /\b(situation|action|result|impact|story|deadline|saved|cost|ownership|commitment|tradeoff)\b/i.test(
      [entry.title, entry.summary, entry.content.slice(0, 1200)]
        .filter(Boolean)
        .join(" ")
    );
  }

  return false;
}

function formatMemoryAnchorTitle(item: RetrievedMemoryEntry) {
  const entry = item.entry;
  return entry.projectName || entry.projectId || entry.title || entry.id;
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
