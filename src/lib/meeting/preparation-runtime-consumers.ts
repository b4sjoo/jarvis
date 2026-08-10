import type {
  PreparationRuntimeBrief,
  PreparationSpeechBiasTerm,
} from "../preparation/index.js";
import type {
  InterviewBriefType,
  InterviewSessionBrief,
  SpeechBiasTerm,
} from "./types.js";
import type {
  PreparationQuestionTypePrior,
  PreparationRuntimeContext,
  PreparationRuntimeProjection,
} from "./preparation-runtime-context.js";

export interface PreparationRuntimeReinforcement {
  enabled: boolean;
  effectiveInterviewBrief?: InterviewSessionBrief;
  runtimeBrief?: PreparationRuntimeProjection<PreparationRuntimeBrief>;
  questionTypePrior?: PreparationRuntimeProjection<PreparationQuestionTypePrior>;
  programmingLanguage?: PreparationRuntimeProjection<string>;
  speechBiasTerms: Array<
    PreparationRuntimeProjection<PreparationSpeechBiasTerm>
  >;
}

export function resolvePreparationRuntimeReinforcement(
  context: PreparationRuntimeContext,
  fallbackBrief?: InterviewSessionBrief
): PreparationRuntimeReinforcement {
  const lowImpact = context.projections?.lowImpact;
  const enabled = Boolean(
    context.mode === "prepared" &&
      context.loadState === "ready" &&
      context.capabilities.runtimeReinforcement.enabled &&
      lowImpact
  );
  if (!enabled || !lowImpact) {
    return {
      enabled: false,
      effectiveInterviewBrief: fallbackBrief
        ? cloneInterviewBrief(fallbackBrief)
        : undefined,
      speechBiasTerms: [],
    };
  }

  const runtimeBrief = lowImpact.runtimeBrief.value;
  const preparedTypes = toInterviewBriefTypes(
    lowImpact.questionTypePrior.value.expectedInterviewTypes
  );
  const targetCompany = runtimeBrief.company?.trim();
  const fallbackTypes = fallbackBrief?.interviewTypes ?? [];
  const effectiveInterviewBrief: InterviewSessionBrief | undefined =
    targetCompany || preparedTypes.length || fallbackBrief
      ? {
          targetCompany:
            targetCompany ?? fallbackBrief?.targetCompany ?? "",
          targetCompanyNormalized: targetCompany
            ? normalizeCompany(targetCompany)
            : fallbackBrief?.targetCompanyNormalized,
          companyLocked: targetCompany
            ? true
            : (fallbackBrief?.companyLocked ?? true),
          interviewTypes:
            preparedTypes.length > 0
              ? preparedTypes
              : [...fallbackTypes],
          focusAreas: fallbackBrief?.focusAreas ?? "",
          notes: fallbackBrief?.notes ?? "",
          updatedAt: fallbackBrief?.updatedAt,
        }
      : undefined;

  return {
    enabled: true,
    effectiveInterviewBrief,
    runtimeBrief: lowImpact.runtimeBrief,
    questionTypePrior: lowImpact.questionTypePrior,
    programmingLanguage: lowImpact.programmingLanguage,
    speechBiasTerms: [...lowImpact.speechBiasTerms],
  };
}

export function toPreparedSpeechBiasTerms(
  projections: Array<
    PreparationRuntimeProjection<PreparationSpeechBiasTerm>
  >
): SpeechBiasTerm[] {
  const terms = new Map<string, SpeechBiasTerm>();
  const add = (term: string) => {
    const normalized = term.trim();
    if (!normalized) return;
    const key = normalized.toLocaleLowerCase();
    if (!terms.has(key)) {
      terms.set(key, {
        term: normalized,
        source: "preparation",
        weight: "high",
      });
    }
  };
  for (const projection of projections) {
    add(projection.value.canonicalTerm);
    for (const alias of projection.value.aliases) add(alias);
  }
  return Array.from(terms.values());
}

export function preparationProjectionArtifactIds<T>(
  projection: PreparationRuntimeProjection<T>,
  pathPrefixes: string[] = []
): string[] {
  const refs = pathPrefixes.length
    ? projection.artifactRefs.filter((artifact) =>
        pathPrefixes.some(
          (prefix) =>
            artifact.artifactPath === prefix ||
            artifact.artifactPath.startsWith(`${prefix}/`)
        )
      )
    : projection.artifactRefs;
  return refs.map((artifact) => artifact.artifactId);
}

function toInterviewBriefTypes(
  types: PreparationQuestionTypePrior["expectedInterviewTypes"]
): InterviewBriefType[] {
  const mapped = types
    .map((type): InterviewBriefType | undefined => {
      if (type === "general-system-design") return "system-design";
      if (
        type === "behavioral" ||
        type === "coding" ||
        type === "ai-ml-system-design" ||
        type === "project-deep-dive"
      ) {
        return type;
      }
      return undefined;
    })
    .filter((type): type is InterviewBriefType => Boolean(type));
  return Array.from(new Set(mapped));
}

function cloneInterviewBrief(
  brief: InterviewSessionBrief
): InterviewSessionBrief {
  return {
    ...brief,
    interviewTypes: [...brief.interviewTypes],
  };
}

function normalizeCompany(value: string) {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}
