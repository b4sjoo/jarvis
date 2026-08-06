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

export const MEMORY_INTERVIEW_FAMILY_RESOLUTION_VERSION = 2;

export type MemoryInterviewFamilyEvidenceSourceKind =
  | "explicit"
  | "entry-type"
  | "use-case"
  | "scope-type"
  | "title"
  | "tag"
  | "keyword"
  | "diagram-overlay";

export interface MemoryInterviewFamilyEvidence {
  family: MemoryInterviewFamily;
  specificity: number;
  sourceKind: MemoryInterviewFamilyEvidenceSourceKind;
  sourceValueHash: string;
  explicit: boolean;
  suppressedBySpecificFamily?: MemoryInterviewFamily;
}

export interface MemoryInterviewFamilyDecision {
  families: ResolvedMemoryInterviewFamily[];
  source: "explicit" | "inferred" | "general";
  evidence: string[];
  evidenceDetails: MemoryInterviewFamilyEvidence[];
  suppressedEvidence: MemoryInterviewFamilyEvidence[];
  resolutionVersion: number;
  resolutionReason:
    | "explicit-family"
    | "explicit-multi-family"
    | "inferred-family"
    | "independent-inferred-evidence"
    | "specific-family-dominance"
    | "general";
}

export interface MemoryInterviewFamilyGateDecision {
  rejectReason?: MemoryRejectReason;
  resolution: MemoryInterviewFamilyDecision;
  candidateFamilies: MemoryInterviewFamily[];
  matchingFamilies: MemoryInterviewFamily[];
  disposition:
    | "general-allow"
    | "explicit-family-allow"
    | "explicit-multi-family-allow"
    | "independent-inferred-evidence-allow"
    | "inferred-family-allow"
    | "brief-interview-type-reject"
    | "playbook-family-reject"
    | "question-type-family-reject";
}

export interface MemoryInterviewFamilyAuditIssue {
  entryId: string;
  aliases: MemoryInterviewFamily[];
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
    const evidenceDetails = explicit.map((family) =>
      createFamilyEvidence(family, "explicit", family, true)
    );
    return {
      families: explicit,
      source: "explicit",
      evidence: explicit.map((family) => `explicit:${family}`),
      evidenceDetails,
      suppressedEvidence: [],
      resolutionVersion: MEMORY_INTERVIEW_FAMILY_RESOLUTION_VERSION,
      resolutionReason:
        explicit.length > 1 ? "explicit-multi-family" : "explicit-family",
    };
  }

  const directTypeFamily = getDirectEntryTypeFamily(entry);
  const rawEvidence: MemoryInterviewFamilyEvidence[] = [];
  if (directTypeFamily) {
    rawEvidence.push(
      createFamilyEvidence(
        directTypeFamily,
        "entry-type",
        entry.type,
        false
      )
    );
  }
  for (const useCase of entry.useCases) {
    const useCaseFamily = getUseCaseFamily(useCase);
    if (useCaseFamily) {
      rawEvidence.push(
        createFamilyEvidence(useCaseFamily, "use-case", useCase, false)
      );
    }
  }
  if (
    entry.scope === "project" &&
    PROJECT_DEEP_DIVE_ENTRY_TYPES.has(entry.type)
  ) {
    rawEvidence.push(
      createFamilyEvidence(
        "project-deep-dive",
        "scope-type",
        `${entry.scope}:${entry.type}`,
        false
      )
    );
  }
  rawEvidence.push(...inferFamiliesFromEvidence(entry.title, "title"));
  for (const tag of entry.tags) {
    rawEvidence.push(...inferFamiliesFromEvidence(tag, "tag"));
  }
  for (const keyword of entry.keywords) {
    rawEvidence.push(...inferFamiliesFromEvidence(keyword, "keyword"));
  }

  const dedupedEvidence = dedupeFamilyEvidence(rawEvidence);
  const typeDominatedEvidence = directTypeFamily
    ? dedupedEvidence.map((item) =>
        item.family === directTypeFamily
          ? item
          : {
              ...item,
              suppressedBySpecificFamily: directTypeFamily,
            }
      )
    : dedupedEvidence;
  const activeEvidence = typeDominatedEvidence.filter(
    (item) => !item.suppressedBySpecificFamily
  );
  const suppressedEvidence = typeDominatedEvidence.filter(
    (item) => Boolean(item.suppressedBySpecificFamily)
  );

  if (!activeEvidence.length && isDiagramOverlayMemoryEntry(entry)) {
    const overlayFamily = resolveDiagramOverlayInterviewFamily(entry);
    activeEvidence.push(
      createFamilyEvidence(
        overlayFamily,
        "diagram-overlay",
        entry.id,
        false
      )
    );
  }

  const resolved = sortFamilies(
    uniqueFamilies(activeEvidence.map((item) => item.family))
  );
  if (!resolved.length) {
    return {
      families: ["general"],
      source: "general",
      evidence: ["no-specialized-family"],
      evidenceDetails: [],
      suppressedEvidence,
      resolutionVersion: MEMORY_INTERVIEW_FAMILY_RESOLUTION_VERSION,
      resolutionReason: "general",
    };
  }

  const hasIndependentFamilyEvidence =
    resolved.length > 1 &&
    new Set(activeEvidence.map((item) => item.sourceValueHash)).size > 1;
  return {
    families: resolved,
    source: "inferred",
    evidence: unique(
      activeEvidence.map((item) => `${item.sourceKind}:${item.family}`)
    ),
    evidenceDetails: activeEvidence,
    suppressedEvidence,
    resolutionVersion: MEMORY_INTERVIEW_FAMILY_RESOLUTION_VERSION,
    resolutionReason: hasIndependentFamilyEvidence
      ? "independent-inferred-evidence"
      : suppressedEvidence.length
        ? "specific-family-dominance"
        : "inferred-family",
  };
}

export function auditMemoryInterviewFamilyNormalization(
  entries: MemoryEntry[]
): MemoryInterviewFamilyAuditIssue[] {
  return entries.flatMap((entry) => {
    const aliases = inferCanonicalFamilyAliases(entry);
    if (!aliases.length) return [];

    const resolved = resolveMemoryInterviewFamilies(entry).families;
    return resolved.some((family) => family !== "general")
      ? []
      : [{ entryId: entry.id, aliases }];
  });
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
  return resolveMemoryInterviewFamilyGateDecision({
    entry,
    interviewTypes,
    questionType,
    memoryPolicy,
  }).rejectReason;
}

export function resolveMemoryInterviewFamilyGateDecision({
  entry,
  interviewTypes,
  questionType,
  memoryPolicy,
}: {
  entry: MemoryEntry;
  interviewTypes?: MemoryInterviewType[];
  questionType?: MemoryQuestionType;
  memoryPolicy?: MemoryRetrievalPolicy;
}): MemoryInterviewFamilyGateDecision {
  const resolution = resolveMemoryInterviewFamilies(entry);
  const specializedFamilies = resolution.families.filter(
    (family): family is MemoryInterviewFamily => family !== "general"
  );
  if (!specializedFamilies.length) {
    return {
      resolution,
      candidateFamilies: [],
      matchingFamilies: [],
      disposition: "general-allow",
    };
  }

  let candidates = [...specializedFamilies];
  const allowedBriefTypes = normalizeAllowedInterviewTypes(interviewTypes);
  if (allowedBriefTypes) {
    candidates = candidates.filter((family) => allowedBriefTypes.has(family));
    if (!candidates.length) {
      return {
        rejectReason: "brief-interview-type-blocked",
        resolution,
        candidateFamilies: specializedFamilies,
        matchingFamilies: [],
        disposition: "brief-interview-type-reject",
      };
    }
  }

  if (memoryPolicy?.blockedFamilies?.length) {
    candidates = candidates.filter(
      (family) => !memoryPolicy.blockedFamilies?.includes(family)
    );
    if (!candidates.length) {
      return {
        rejectReason: "playbook-family-blocked",
        resolution,
        candidateFamilies: specializedFamilies,
        matchingFamilies: [],
        disposition: "playbook-family-reject",
      };
    }
  }
  if (memoryPolicy?.allowedFamilies?.length) {
    candidates = candidates.filter((family) =>
      memoryPolicy.allowedFamilies?.includes(family)
    );
    if (!candidates.length) {
      return {
        rejectReason: "playbook-family-blocked",
        resolution,
        candidateFamilies: specializedFamilies,
        matchingFamilies: [],
        disposition: "playbook-family-reject",
      };
    }
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
      return {
        rejectReason: candidates.every((family) => family === "behavioral")
          ? "behavioral-family-blocked"
          : "question-type-family-mismatch",
        resolution,
        candidateFamilies: specializedFamilies,
        matchingFamilies: [],
        disposition: "question-type-family-reject",
      };
    }
    candidates = compatible;
  }

  return {
    resolution,
    candidateFamilies: specializedFamilies,
    matchingFamilies: candidates,
    disposition: getFamilyAllowDisposition(resolution),
  };
}

function getFamilyAllowDisposition(
  decision: MemoryInterviewFamilyDecision
): MemoryInterviewFamilyGateDecision["disposition"] {
  if (decision.resolutionReason === "explicit-multi-family") {
    return "explicit-multi-family-allow";
  }
  if (decision.source === "explicit") return "explicit-family-allow";
  if (decision.resolutionReason === "independent-inferred-evidence") {
    return "independent-inferred-evidence-allow";
  }
  return "inferred-family-allow";
}

function getDirectEntryTypeFamily(
  entry: MemoryEntry
): MemoryInterviewFamily | undefined {
  if (entry.type === "behavioral_question") return "behavioral";
  if (entry.type === "coding_question") return "coding";
  return undefined;
}

function getUseCaseFamily(
  useCase: MemoryEntry["useCases"][number]
): MemoryInterviewFamily | undefined {
  switch (useCase) {
    case "behavioral_interview":
      return "behavioral";
    case "coding_interview":
      return "coding";
    case "system_design_interview":
      return "system-design";
    case "aiml_system_design_interview":
      return "ai-ml-system-design";
    case "project_deep_dive":
      return "project-deep-dive";
    default:
      return undefined;
  }
}

function inferFamiliesFromEvidence(
  value: string,
  sourceKind: "title" | "tag" | "keyword"
): MemoryInterviewFamilyEvidence[] {
  const normalized = normalizeFamilyEvidenceValue(value);
  if (!normalized) return [];

  const detected: MemoryInterviewFamily[] = [];
  if (
    /\b(behavioral|behavioural|leadership principle|lp:|star|company:amazon|rubric)\b/.test(
      normalized
    )
  ) {
    detected.push("behavioral");
  }
  if (/\b(coding|algorithm|leetcode|data structure)\b/.test(normalized)) {
    detected.push("coding");
  }
  if (
    /\b(ai\s*\/\s*ml|ai ml|aiml|ai system design|ml system design|ml infra|machine learning|rag|retrieval augmented generation|model serving|model routing|vector search|embedding|agentic|agent system design|agent architecture|agent memory|agent runtime|llm platform|model evaluation|ml evaluation)\b/.test(
      normalized
    )
  ) {
    detected.push("ai-ml-system-design");
  }
  if (
    /\b(general system design|system design|distributed systems?)\b/.test(
      normalized
    )
  ) {
    detected.push("system-design");
  }
  if (/\b(project deep dive|project dive)\b/.test(normalized)) {
    detected.push("project-deep-dive");
  }

  const sourceValueHash = hashFamilyEvidenceValue(normalized);
  const specializedDominatesGeneric =
    detected.includes("ai-ml-system-design") &&
    detected.includes("system-design");
  return uniqueFamilies(detected).map((family) => ({
    family,
    specificity: getFamilySpecificity(family),
    sourceKind,
    sourceValueHash,
    explicit: false,
    suppressedBySpecificFamily:
      specializedDominatesGeneric && family === "system-design"
        ? "ai-ml-system-design"
        : undefined,
  }));
}

function resolveDiagramOverlayInterviewFamily(
  entry: MemoryEntry
): MemoryInterviewFamily {
  const searchable = getNormalizedFamilyMetadata(entry);
  return /\b(ai\s*\/\s*ml|ai ml|aiml|ml|machine learning|rag|llm|agent|embedding|vector|model|evaluation|training|inference|rerank)\b/.test(
    searchable
  )
    ? "ai-ml-system-design"
    : "system-design";
}

function createFamilyEvidence(
  family: MemoryInterviewFamily,
  sourceKind: MemoryInterviewFamilyEvidenceSourceKind,
  sourceValue: string,
  explicit: boolean
): MemoryInterviewFamilyEvidence {
  return {
    family,
    specificity: getFamilySpecificity(family),
    sourceKind,
    sourceValueHash: hashFamilyEvidenceValue(sourceValue),
    explicit,
  };
}

function getFamilySpecificity(family: MemoryInterviewFamily) {
  return family === "system-design" ? 1 : 2;
}

function normalizeFamilyEvidenceValue(value: string) {
  return value
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashFamilyEvidenceValue(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function dedupeFamilyEvidence(values: MemoryInterviewFamilyEvidence[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = [
      value.family,
      value.sourceKind,
      value.sourceValueHash,
      value.explicit,
      value.suppressedBySpecificFamily ?? "",
    ].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const FAMILY_ORDER: MemoryInterviewFamily[] = [
  "behavioral",
  "coding",
  "ai-ml-system-design",
  "system-design",
  "project-deep-dive",
];

function sortFamilies(values: MemoryInterviewFamily[]) {
  return [...values].sort(
    (left, right) => FAMILY_ORDER.indexOf(left) - FAMILY_ORDER.indexOf(right)
  );
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

function getNormalizedFamilyMetadata(entry: MemoryEntry) {
  return [
    entry.type,
    entry.title,
    entry.tags.join(" "),
    entry.keywords.join(" "),
    entry.useCases.join(" "),
  ]
    .join(" ")
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferCanonicalFamilyAliases(entry: MemoryEntry) {
  const searchable = getNormalizedFamilyMetadata(entry);
  const aliases = new Set<MemoryInterviewFamily>();

  if (/\b(behavioral|behavioural)\b/.test(searchable)) {
    aliases.add("behavioral");
  }
  if (/\b(coding|algorithm|data structure)\b/.test(searchable)) {
    aliases.add("coding");
  }
  if (/\b(ai ml system design|aiml system design)\b/.test(searchable)) {
    aliases.add("ai-ml-system-design");
  }
  if (/\b(general system design|system design)\b/.test(searchable)) {
    aliases.add("system-design");
  }
  if (/\b(project deep dive|project dive)\b/.test(searchable)) {
    aliases.add("project-deep-dive");
  }

  return uniqueFamilies(Array.from(aliases));
}

function uniqueFamilies(values: MemoryInterviewFamily[]) {
  return Array.from(new Set(values));
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}
