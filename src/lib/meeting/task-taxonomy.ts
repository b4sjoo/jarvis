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

export type QuestionTypeInferenceSource = "lightweight-text";

export interface QuestionTypeInferenceDecision {
  type?: CanonicalQuestionType;
  confidence: number;
  margin: number;
  source: QuestionTypeInferenceSource;
  evidence: string[];
  ambiguousTerms: string[];
  scores: Partial<Record<CanonicalQuestionType, number>>;
}

export const QUESTION_TYPE_INFERENCE_MIN_CONFIDENCE = 0.65;
export const QUESTION_TYPE_INFERENCE_MIN_MARGIN = 0.2;
export const QUESTION_TYPE_PARENT_OVERRIDE_CONFIDENCE = 0.8;
export const QUESTION_TYPE_PARENT_OVERRIDE_MARGIN = 0.25;

export function canQuestionTypeDecisionOverrideParent(
  decision: QuestionTypeInferenceDecision | undefined
) {
  return Boolean(
    decision?.type &&
      decision.confidence >= QUESTION_TYPE_PARENT_OVERRIDE_CONFIDENCE &&
      decision.margin >= QUESTION_TYPE_PARENT_OVERRIDE_MARGIN
  );
}

export type LatestTurnTaxonomyBoundaryReason =
  | "opening-route"
  | "latest-turn-classified"
  | "latest-turn-unknown"
  | "missing-latest-turn";

export interface LatestTurnTaxonomyBoundaryDecision {
  questionType: CanonicalQuestionType;
  allowsNewTaskSignal: boolean;
  fallbackSuppressed: boolean;
  unknownTaskMutationBlocked: boolean;
  reason: LatestTurnTaxonomyBoundaryReason;
}

export function decideLatestTurnTaxonomyBoundary({
  latestQuestionType,
  hasLatestUsefulText,
  hasOpeningRoute,
}: {
  latestQuestionType: CanonicalQuestionType;
  hasLatestUsefulText: boolean;
  hasOpeningRoute: boolean;
}): LatestTurnTaxonomyBoundaryDecision {
  if (!hasLatestUsefulText) {
    return {
      questionType: "unknown",
      allowsNewTaskSignal: false,
      fallbackSuppressed: true,
      unknownTaskMutationBlocked: false,
      reason: "missing-latest-turn",
    };
  }

  if (latestQuestionType === "unknown") {
    return {
      questionType: "unknown",
      allowsNewTaskSignal: false,
      fallbackSuppressed: true,
      unknownTaskMutationBlocked: true,
      reason: "latest-turn-unknown",
    };
  }

  return {
    questionType: latestQuestionType,
    allowsNewTaskSignal: true,
    fallbackSuppressed: false,
    unknownTaskMutationBlocked: false,
    reason: hasOpeningRoute ? "opening-route" : "latest-turn-classified",
  };
}

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

export function inferQuestionTypeDecisionFromText(
  text: string
): QuestionTypeInferenceDecision {
  const normalized = text.toLowerCase();
  const scores: Partial<Record<CanonicalQuestionType, number>> = {};
  const evidence: string[] = [];
  const ambiguousTerms = collectQuestionTypeTerms(normalized);

  if (!normalized.trim()) {
    return {
      confidence: 0,
      margin: 0,
      source: "lightweight-text",
      evidence,
      ambiguousTerms,
      scores,
    };
  }

  const addEvidence = (
    type: CanonicalQuestionType,
    score: number,
    label: string
  ) => {
    scores[type] = Math.max(scores[type] ?? 0, score);
    if (!evidence.includes(label)) evidence.push(label);
  };

  const hasBehavioralFrame =
    /\b(tell me about a time|give me an example|describe a time|conflict|disagree|missed a commitment|leadership principle|ownership|failure|mistake)\b/.test(
      normalized
    );

  if (hasBehavioralFrame) {
    addEvidence("behavioral", 1, "behavioral-story-frame");
  }

  const hasStrongPastProjectFrame =
    /\b(have you|did you|when you|how did you|what was your|who were your|walk me through|tell me about|describe)\b.{0,100}\b(shipped|built|implemented|owned|launched|deployed|operated|scaled|tested|validated|project|system|feature|contribution|role|partners|stakeholders)\b/.test(
      normalized
    ) ||
    /\b(your|personal|specific)\s+(contribution|role|ownership|impact|work)\b/.test(
      normalized
    ) ||
    /\b(system you built|tradeoff you made|impact of your project|previous project|past project|your work on|project deep dive|project dive|technical deep dive)\b/.test(
      normalized
    ) ||
    /\bwhat\b.{0,80}\b(api|backend|database|vector|cache|storage|framework|technology|technologies|systems?)\b.{0,40}\bdid you use\b/.test(
      normalized
    ) ||
    /\bhow did you (test|validate|launch|deploy|operate|scale|monitor) (it|this|that|the system|the feature)\b/.test(
      normalized
    ) ||
    /\bwho were your (primary )?(partners|stakeholders|collaborators)\b/.test(
      normalized
    );
  const hasProjectStackContext =
    /\b(your|personal|our|production|backend|frontend|full|technology|technical|tech)\s+(contribution to the )?stack\b/.test(
      normalized
    );
  const hasExplicitProjectStackFrame =
    /\bwhat is your (tech|technology|technical) stack\b/.test(normalized) ||
    /\b(your|personal|specific) contribution to (the )?stack\b/.test(
      normalized
    ) ||
    /\bstack (you|your team) (built|used|owned|shipped)\b/.test(normalized);
  const hasProductionProjectContext =
    /\b(in|into|before|to) production\b/.test(normalized) &&
    /\b(you|your|did|shipped|built|implemented|tested|launched|deployed)\b/.test(
      normalized
    );

  if (!hasBehavioralFrame && hasStrongPastProjectFrame) {
    addEvidence("project-deep-dive", 0.95, "past-project-intent");
  }
  if (!hasBehavioralFrame && hasExplicitProjectStackFrame) {
    addEvidence("project-deep-dive", 0.92, "project-stack-context");
  }
  if (!hasBehavioralFrame && hasProductionProjectContext) {
    addEvidence("project-deep-dive", 0.86, "production-project-context");
  }

  const hasCodingActionObject =
    /\b(write|implement|complete|code)\s+(a |an |the |this |that )?(function|method|class|algorithm|stack|queue|heap|binary tree|linked list|graph|sort|sorting|search|solution)\b/.test(
      normalized
    ) ||
    /\b(solve|code)\s+(this|the|a)\s+(problem|question|algorithm)\b/.test(
      normalized
    );
  const hasCodingArtifact =
    /\b(leetcode|hackerrank|coding problem|class solution|test cases?|input array|output array|return the|function signature)\b/.test(
      normalized
    ) || /\b(def|function|public static|class)\s+[a-z_$][\w$]*\s*\(/.test(normalized);
  const hasComplexityRequest =
    /\b(time|space) complexity\b|\bbig[ -]?o\b/.test(normalized);

  if (hasCodingActionObject) {
    addEvidence("coding", 0.96, "coding-action-object");
  }
  if (hasCodingArtifact) {
    addEvidence("coding", 0.94, "coding-artifact");
  }
  if (hasComplexityRequest) {
    addEvidence("coding", 0.9, "complexity-request");
  }

  const hasHypotheticalDesignFrame =
    /\bsystem design\b/.test(normalized) ||
    /\b(design|architect|build)\s+(a|an|the|this)\b/.test(normalized) ||
    /\b(how would you|can you|please)\s+(design|architect|build|implement)\b/.test(
      normalized
    ) ||
    /\b(implement|build)\s+(a|an|the)\s+(scalable|distributed|highly available|fault tolerant)\b/.test(
      normalized
    );
  const hasSystemDesignObject =
    /\b(system|service|platform|application|app|api|backend|pipeline|architecture|infrastructure|distributed system|ticketing|booking|chat|feed|rate limiter)\b/.test(
      normalized
    );
  const hasScaleOrRequirementContext =
    /\b(qps|throughput|traffic|scale|scalable|availability|reliability|latency|storage|database|microservice|requirements?|consistency|partition|load balancer)\b/.test(
      normalized
    );
  const hasAimlContext =
    /\b(ai|ml|machine learning|llm|rag|retrieval augmented|embedding|vector|model serving|agent|evaluation|eval|fine-tuning|feature store|recommender)\b/.test(
      normalized
    );
  const hasStrongSystemDesignFrame =
    !hasStrongPastProjectFrame &&
    !hasExplicitProjectStackFrame &&
    hasHypotheticalDesignFrame &&
    (hasSystemDesignObject || hasScaleOrRequirementContext);

  if (hasStrongSystemDesignFrame && hasAimlContext) {
    addEvidence("ai-ml-system-design", 0.96, "hypothetical-ai-ml-design");
  } else if (hasStrongSystemDesignFrame) {
    addEvidence("general-system-design", 0.93, "hypothetical-system-design");
  }

  const hasConceptQuestion =
    /\b(what is|what are|explain|compare|why|how does|tradeoff|trade-off|pros and cons|advantages|disadvantages)\b/.test(
      normalized
    );
  if (
    hasConceptQuestion &&
    !hasBehavioralFrame &&
    !hasStrongPastProjectFrame &&
    !hasExplicitProjectStackFrame &&
    !hasStrongSystemDesignFrame &&
    !hasComplexityRequest
  ) {
    addEvidence("field-knowledge", 0.88, "direct-concept-question");
  }

  if (/\b(implement|build|write|solve)\b/.test(normalized)) {
    evidence.push("weak-action-verb");
  }
  if (hasProjectStackContext && !hasExplicitProjectStackFrame) {
    evidence.push("ambiguous-stack-context");
  }

  const ranked = Object.entries(scores)
    .map(([type, score]) => ({
      type: type as CanonicalQuestionType,
      score,
    }))
    .sort((left, right) => right.score - left.score);
  const top = ranked[0];
  const runnerUp = ranked[1];
  const confidence = roundTaxonomyScore(top?.score ?? 0);
  const margin = roundTaxonomyScore(
    Math.max(0, (top?.score ?? 0) - (runnerUp?.score ?? 0))
  );
  const type =
    top &&
    confidence >= QUESTION_TYPE_INFERENCE_MIN_CONFIDENCE &&
    margin >= QUESTION_TYPE_INFERENCE_MIN_MARGIN
      ? top.type
      : undefined;

  return {
    type,
    confidence,
    margin,
    source: "lightweight-text",
    evidence,
    ambiguousTerms,
    scores,
  };
}

export function inferCanonicalQuestionTypeFromText(
  text: string
): CanonicalQuestionType | undefined {
  return inferQuestionTypeDecisionFromText(text).type;
}

function collectQuestionTypeTerms(text: string) {
  const terms = text.match(
    /\b(implement|build|write|solve|typescript|javascript|python|java|rust|go|golang|algorithm|binary tree|linked list|graph|heap|stack|queue|dp|dynamic programming)\b/g
  );
  return terms ? Array.from(new Set(terms)) : [];
}

function roundTaxonomyScore(value: number) {
  return Math.round(value * 100) / 100;
}
