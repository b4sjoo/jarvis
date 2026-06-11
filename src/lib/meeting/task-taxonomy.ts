import type {
  MemoryInterviewFamily,
  MemoryInterviewType,
  MemoryQuestionType,
  MemoryUseCase,
} from "@/lib/memory/types";

export type CanonicalQuestionType =
  | "behavioral"
  | "coding"
  | "general-system-design"
  | "ai-ml-system-design"
  | "project-deep-dive"
  | "field-knowledge"
  | "unknown";

export type TransitionalQuestionType = "ambiguous" | "non-question";

export type LegacyQuestionTypeAlias = "system-design";

export type QuestionTypeInput =
  | CanonicalQuestionType
  | TransitionalQuestionType
  | LegacyQuestionTypeAlias;

export type TaxonomyScreenTaskKind = QuestionTypeInput;

export type TaxonomyHumanEvalQuestionType =
  | CanonicalQuestionType
  | LegacyQuestionTypeAlias;

export type TaxonomyInterviewBriefType =
  | "behavioral"
  | "coding"
  | "system-design"
  | "ai-ml-system-design"
  | "project-deep-dive"
  | "mixed";

export const CANONICAL_QUESTION_TYPES: CanonicalQuestionType[] = [
  "behavioral",
  "coding",
  "general-system-design",
  "ai-ml-system-design",
  "project-deep-dive",
  "field-knowledge",
  "unknown",
];

export const TRANSITIONAL_QUESTION_TYPES: TransitionalQuestionType[] = [
  "ambiguous",
  "non-question",
];

export const CONCRETE_INTERVIEW_TYPES: Exclude<
  TaxonomyInterviewBriefType,
  "mixed"
>[] = [
  "behavioral",
  "coding",
  "system-design",
  "ai-ml-system-design",
  "project-deep-dive",
];

const ALL_INTERVIEW_FAMILIES: MemoryInterviewFamily[] = [
  "behavioral",
  "coding",
  "system-design",
  "ai-ml-system-design",
  "project-deep-dive",
];

export function isCanonicalQuestionType(
  value: unknown
): value is CanonicalQuestionType {
  return (
    typeof value === "string" &&
    CANONICAL_QUESTION_TYPES.includes(value as CanonicalQuestionType)
  );
}

export function isTransitionalQuestionType(
  value: unknown
): value is TransitionalQuestionType {
  return (
    typeof value === "string" &&
    TRANSITIONAL_QUESTION_TYPES.includes(value as TransitionalQuestionType)
  );
}

export function normalizeCanonicalQuestionType(
  value: unknown
): CanonicalQuestionType | undefined {
  if (value === "system-design") return "general-system-design";
  return isCanonicalQuestionType(value) ? value : undefined;
}

export function normalizeQuestionTypeAlias(
  value: unknown
): CanonicalQuestionType | TransitionalQuestionType | undefined {
  return normalizeCanonicalQuestionType(value) ?? normalizeTransitionalQuestionType(value);
}

export function normalizeTransitionalQuestionType(
  value: unknown
): TransitionalQuestionType | undefined {
  return isTransitionalQuestionType(value) ? value : undefined;
}

export function areCompatibleQuestionTypes(left: unknown, right: unknown) {
  const normalizedLeft = normalizeQuestionTypeAlias(left);
  const normalizedRight = normalizeQuestionTypeAlias(right);

  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

export function isParentCanonicalQuestionType(type: CanonicalQuestionType) {
  return (
    type === "behavioral" ||
    type === "coding" ||
    type === "general-system-design" ||
    type === "ai-ml-system-design" ||
    type === "project-deep-dive"
  );
}

export function toScreenTaskKind(
  type: CanonicalQuestionType | TransitionalQuestionType
): TaxonomyScreenTaskKind {
  return type;
}

export function fromScreenTaskKind(
  type: TaxonomyScreenTaskKind | undefined
): CanonicalQuestionType | TransitionalQuestionType | undefined {
  return normalizeQuestionTypeAlias(type);
}

export function toMemoryQuestionType(
  type: CanonicalQuestionType
): MemoryQuestionType {
  return type;
}

export function fromMemoryQuestionType(
  type: MemoryQuestionType | undefined
): CanonicalQuestionType | undefined {
  return normalizeCanonicalQuestionType(type);
}

export function toHumanEvalQuestionType(
  type: CanonicalQuestionType
): TaxonomyHumanEvalQuestionType {
  return type;
}

export function fromHumanEvalQuestionType(
  type: TaxonomyHumanEvalQuestionType | undefined
): CanonicalQuestionType | undefined {
  return normalizeCanonicalQuestionType(type);
}

export function readInterviewBriefType(
  value: unknown
): TaxonomyInterviewBriefType | undefined {
  if (
    value === "behavioral" ||
    value === "coding" ||
    value === "system-design" ||
    value === "ai-ml-system-design" ||
    value === "project-deep-dive" ||
    value === "mixed"
  ) {
    return value;
  }

  if (value === "general-system-design") return "system-design";
  return undefined;
}

export function fromInterviewBriefType(
  type: TaxonomyInterviewBriefType | undefined
): CanonicalQuestionType | undefined {
  if (!type || type === "mixed") return undefined;
  return type === "system-design" ? "general-system-design" : type;
}

export function toInterviewBriefType(
  type: CanonicalQuestionType
): TaxonomyInterviewBriefType | undefined {
  if (type === "general-system-design") return "system-design";
  if (type === "field-knowledge" || type === "unknown") return undefined;
  return type;
}

export function normalizeInterviewBriefTypes(
  interviewTypes: TaxonomyInterviewBriefType[]
): TaxonomyInterviewBriefType[] {
  const uniqueTypes = Array.from(new Set(interviewTypes));
  const hasMixed = uniqueTypes.includes("mixed");
  const concreteTypes = CONCRETE_INTERVIEW_TYPES.filter((type) =>
    uniqueTypes.includes(type)
  );

  if (hasMixed || concreteTypes.length === CONCRETE_INTERVIEW_TYPES.length) {
    return [...CONCRETE_INTERVIEW_TYPES, "mixed"];
  }

  return concreteTypes;
}

export function readSingleConcreteInterviewTypeOverride(
  brief: { interviewTypes: TaxonomyInterviewBriefType[] } | undefined
): CanonicalQuestionType | undefined {
  if (!brief?.interviewTypes.length || brief.interviewTypes.includes("mixed")) {
    return undefined;
  }

  const concreteTypes = brief.interviewTypes.filter(
    (type): type is Exclude<TaxonomyInterviewBriefType, "mixed"> =>
      type !== "mixed"
  );

  if (concreteTypes.length !== 1) return undefined;
  return fromInterviewBriefType(concreteTypes[0]);
}

export function toMemoryUseCaseForQuestionType(
  defaultUseCase: MemoryUseCase,
  questionType: CanonicalQuestionType
): MemoryUseCase {
  if (questionType === "behavioral") return "behavioral_interview";
  if (questionType === "coding") return "coding_interview";
  if (
    questionType === "general-system-design" ||
    questionType === "ai-ml-system-design" ||
    questionType === "project-deep-dive" ||
    questionType === "field-knowledge"
  ) {
    return defaultUseCase === "behavioral_interview"
      ? "meeting_assistant"
      : defaultUseCase;
  }
  return defaultUseCase;
}

export function memoryFamiliesForQuestionType(
  questionType: CanonicalQuestionType
): MemoryInterviewFamily[] | undefined {
  if (questionType === "behavioral") return ["behavioral"];
  if (questionType === "coding") return ["coding"];
  if (questionType === "general-system-design") return ["system-design"];
  if (questionType === "ai-ml-system-design") {
    return ["ai-ml-system-design", "system-design"];
  }
  if (questionType === "project-deep-dive") {
    return ["project-deep-dive", "ai-ml-system-design", "system-design"];
  }
  if (questionType === "field-knowledge") {
    return ["ai-ml-system-design", "system-design"];
  }
  return undefined;
}

export function allMemoryInterviewFamilies() {
  return [...ALL_INTERVIEW_FAMILIES];
}

export function isQuestionTypeCompatibleWithMemoryFamily(
  questionType: CanonicalQuestionType | MemoryQuestionType | undefined,
  family: MemoryInterviewFamily
) {
  const canonical = normalizeCanonicalQuestionType(questionType);
  if (!canonical || canonical === "unknown") return true;
  const families = memoryFamiliesForQuestionType(canonical);
  return !families || families.includes(family);
}

export function normalizeMemoryInterviewTypes(
  types: MemoryInterviewType[] | undefined
) {
  if (!types?.length) return undefined;
  const normalized = types
    .map((type) => (type === "system-design" ? "system-design" : type))
    .filter((type): type is MemoryInterviewType =>
      type === "behavioral" ||
      type === "coding" ||
      type === "system-design" ||
      type === "ai-ml-system-design" ||
      type === "project-deep-dive" ||
      type === "mixed"
    );
  return normalized.length ? Array.from(new Set(normalized)) : undefined;
}

export function inferCanonicalQuestionTypeFromText(
  text: string
): CanonicalQuestionType | undefined {
  const normalized = text.toLowerCase();
  if (!normalized.trim()) return undefined;

  if (
    /\b(leetcode|algorithm|coding|complexity|typescript|javascript|python|java|rust|go|golang|dp|dynamic programming|binary tree|graph|heap|stack|queue)\b/.test(
      normalized
    )
  ) {
    return "coding";
  }

  if (
    /\b(tell me about a time|give me an example|describe a time|conflict|disagree|missed a commitment|leadership principle|ownership|failure|mistake)\b/.test(
      normalized
    )
  ) {
    return "behavioral";
  }

  if (
    /\b(project deep dive|project dive|technical deep dive|walk me through your project|your role|system you built|tradeoff you made|impact of your project|previous project|past project|your work on)\b/.test(
      normalized
    )
  ) {
    return "project-deep-dive";
  }

  const hasDesignSignal =
    /\b(system design|design a|design an|architect|architecture|build a|scalability|serving path|pipeline|distributed system)\b/.test(
      normalized
    );
  const hasAimlSignal =
    /\b(ai|ml|machine learning|llm|rag|retrieval augmented|embedding|vector|model serving|agent|evaluation|eval|fine-tuning|feature store)\b/.test(
      normalized
    );

  if (hasDesignSignal && hasAimlSignal) return "ai-ml-system-design";
  if (hasDesignSignal) return "general-system-design";

  if (
    /\b(what is|what are|explain|compare|why|how does|tradeoff|trade-off|pros and cons|advantages|disadvantages)\b/.test(
      normalized
    )
  ) {
    return "field-knowledge";
  }

  return undefined;
}
