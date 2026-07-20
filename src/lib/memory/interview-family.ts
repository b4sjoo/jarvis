import {
  isQuestionTypeCompatibleWithMemoryFamily,
  normalizeMemoryInterviewTypes,
} from "../meeting/task-taxonomy.js";
import { isDiagramOverlayMemoryEntry } from "./diagram-overlay.js";
import type {
  MemoryEntry,
  MemoryInterviewFamily,
  MemoryInterviewType,
  MemoryQuestionType,
  MemoryRejectReason,
  MemoryRetrievalPolicy,
} from "./types.js";

export type ResolvedMemoryInterviewFamily = MemoryInterviewFamily | "general";

export interface MemoryInterviewFamilyDecision {
  families: ResolvedMemoryInterviewFamily[];
  source: "explicit" | "inferred" | "general";
  evidence: string[];
}

const PROJECT_DEEP_DIVE_ENTRY_TYPES = new Set<MemoryEntry["type"]>([
  "working_summary",
  "project_context",
  "design_doc",
  "implementation_note",
  "decision_record",
  "investigation_note",
  "threat_model",
]);

export function resolveMemoryInterviewFamilies(
  entry: MemoryEntry
): MemoryInterviewFamilyDecision {
  const explicit = uniqueFamilies(entry.interviewFamilies ?? []);
  if (explicit.length) {
    return {
      families: explicit,
      source: "explicit",
      evidence: explicit.map((family) => `explicit:${family}`),
    };
  }

  const searchable = [
    entry.type,
    entry.title,
    entry.tags.join(" "),
    entry.keywords.join(" "),
    entry.useCases.join(" "),
  ]
    .join(" ")
    .toLowerCase();
  const families = new Set<MemoryInterviewFamily>();
  const evidence: string[] = [];
  const add = (family: MemoryInterviewFamily, reason: string) => {
    families.add(family);
    evidence.push(reason);
  };

  if (
    entry.type === "behavioral_question" ||
    entry.useCases.includes("behavioral_interview") ||
    /\b(behavioral|behavioural|leadership principle|lp:|star|company:amazon|rubric)\b/.test(
      searchable
    )
  ) {
    add("behavioral", "behavioral-metadata");
  }
  if (
    entry.type === "coding_question" ||
    entry.useCases.includes("coding_interview") ||
    /\b(coding|algorithm|leetcode|data structure)\b/.test(searchable)
  ) {
    add("coding", "coding-metadata");
  }
  if (
    entry.useCases.includes("aiml_system_design_interview") ||
    /\b(ai\/ml|ml infra|machine learning|rag|retrieval augmented generation|model serving|model routing|vector search|embedding|agentic|agent memory|llm platform|model evaluation|ml evaluation)\b/.test(
      searchable
    )
  ) {
    add("ai-ml-system-design", "ai-ml-metadata");
  }
  if (
    entry.useCases.includes("system_design_interview") ||
    /\b(system design|architecture|distributed system)\b/.test(searchable)
  ) {
    add("system-design", "system-design-metadata");
  }
  if (
    entry.useCases.includes("project_deep_dive") ||
    (entry.scope === "project" && PROJECT_DEEP_DIVE_ENTRY_TYPES.has(entry.type)) ||
    /\b(project deep dive|project dive|deep-dive)\b/.test(searchable)
  ) {
    add("project-deep-dive", "project-metadata");
  }
  if (isDiagramOverlayMemoryEntry(entry) && !families.size) {
    add(
      /\b(ai\/ml|ml|machine learning|rag|llm|agent|embedding|vector|model|evaluation|training|inference|rerank)\b/.test(
        searchable
      )
        ? "ai-ml-system-design"
        : "system-design",
      "diagram-overlay-metadata"
    );
  }

  const resolved = uniqueFamilies(Array.from(families));
  return resolved.length
    ? { families: resolved, source: "inferred", evidence: unique(evidence) }
    : {
        families: ["general"],
        source: "general",
        evidence: ["no-specialized-family"],
      };
}

export function getMemoryInterviewFamilyGateRejectReason({
  entry,
  interviewTypes,
  questionType,
  memoryPolicy,
}: {
  entry: MemoryEntry;
  interviewTypes?: MemoryInterviewType[];
  questionType?: MemoryQuestionType;
  memoryPolicy?: MemoryRetrievalPolicy;
}): MemoryRejectReason | undefined {
  const specializedFamilies = resolveMemoryInterviewFamilies(entry).families.filter(
    (family): family is MemoryInterviewFamily => family !== "general"
  );
  if (!specializedFamilies.length) return undefined;

  let candidates = [...specializedFamilies];
  const allowedBriefTypes = normalizeAllowedInterviewTypes(interviewTypes);
  if (allowedBriefTypes) {
    candidates = candidates.filter((family) => allowedBriefTypes.has(family));
    if (!candidates.length) return "brief-interview-type-blocked";
  }

  if (memoryPolicy?.blockedFamilies?.length) {
    candidates = candidates.filter(
      (family) => !memoryPolicy.blockedFamilies?.includes(family)
    );
    if (!candidates.length) return "playbook-family-blocked";
  }
  if (memoryPolicy?.allowedFamilies?.length) {
    candidates = candidates.filter((family) =>
      memoryPolicy.allowedFamilies?.includes(family)
    );
    if (!candidates.length) return "playbook-family-blocked";
  }

  if (
    questionType &&
    questionType !== "unknown" &&
    questionType !== "field-knowledge"
  ) {
    const compatible = candidates.filter((family) =>
      isQuestionTypeCompatibleWithMemoryFamily(questionType, family)
    );
    if (!compatible.length) {
      return candidates.every((family) => family === "behavioral")
        ? "behavioral-family-blocked"
        : "question-type-family-mismatch";
    }
  }

  return undefined;
}

function normalizeAllowedInterviewTypes(
  interviewTypes: MemoryInterviewType[] | undefined
) {
  const normalized = normalizeMemoryInterviewTypes(interviewTypes);
  if (!normalized?.length || normalized.includes("mixed")) return undefined;
  return new Set(
    normalized.filter(
      (type): type is MemoryInterviewFamily => type !== "mixed"
    )
  );
}

function uniqueFamilies(values: MemoryInterviewFamily[]) {
  return Array.from(new Set(values));
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}
