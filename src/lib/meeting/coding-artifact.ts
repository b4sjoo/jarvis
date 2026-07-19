import type { MeetingAnswerDisplayModel } from "./meeting-answer-display.js";
import { stripOuterCodeFence } from "./screen-task-answer.js";

export interface CodingArtifactCache {
  parentTaskId: string;
  code: string;
  complexity: string;
  updatedAt: number;
  sourceSuggestionId?: string;
}

export interface CodingArtifactDisplay {
  code: string;
  complexity: string;
  isCached: boolean;
}

interface CodingArtifactScope {
  activeParentTaskId: string;
  sourceParentTaskId?: string;
}

export function updateCodingArtifactCache({
  activeParentTaskId,
  activeTaskKind,
  cache,
  sections,
  sourceParentTaskId,
  sourceSuggestionId,
  updatedAt,
}: CodingArtifactScope & {
  activeTaskKind?: string;
  cache: CodingArtifactCache | null;
  sections: MeetingAnswerDisplayModel;
  sourceSuggestionId?: string;
  updatedAt: number;
}): CodingArtifactCache | null {
  if (!activeParentTaskId) return null;

  const scopedCache = getScopedCodingArtifactCache(
    cache,
    activeParentTaskId
  );
  if (!doesArtifactSourceBelongToParent({
    activeParentTaskId,
    sourceParentTaskId,
  })) {
    return scopedCache;
  }

  const artifactPatch = readCodingArtifactPatch({
    activeTaskKind,
    hasExistingCache: Boolean(scopedCache),
    sections,
  });
  if (!artifactPatch) return scopedCache;

  const nextCode = artifactPatch.code || scopedCache?.code || "";
  const nextComplexity =
    artifactPatch.complexity || scopedCache?.complexity || "";
  if (!nextCode && !nextComplexity) return null;

  if (
    scopedCache &&
    scopedCache.code === nextCode &&
    scopedCache.complexity === nextComplexity &&
    scopedCache.sourceSuggestionId === sourceSuggestionId
  ) {
    return scopedCache;
  }

  return {
    parentTaskId: activeParentTaskId,
    code: nextCode,
    complexity: nextComplexity,
    updatedAt,
    sourceSuggestionId,
  };
}

export function resolveCodingArtifactDisplay({
  activeParentTaskId,
  activeTaskKind,
  cache,
  sections,
  sourceParentTaskId,
}: CodingArtifactScope & {
  activeTaskKind?: string;
  cache: CodingArtifactCache | null;
  sections: MeetingAnswerDisplayModel;
}): CodingArtifactDisplay {
  if (!activeParentTaskId) return emptyCodingArtifactDisplay();

  const scopedCache = getScopedCodingArtifactCache(
    cache,
    activeParentTaskId
  );
  const sourceMatchesParent = doesArtifactSourceBelongToParent({
    activeParentTaskId,
    sourceParentTaskId,
  });
  const artifactPatch = sourceMatchesParent
    ? readCodingArtifactPatch({
        activeTaskKind,
        hasExistingCache: Boolean(scopedCache),
        sections,
      })
    : undefined;

  if (artifactPatch) {
    return {
      code: artifactPatch.code || scopedCache?.code || "",
      complexity: artifactPatch.complexity || scopedCache?.complexity || "",
      isCached: false,
    };
  }

  if (scopedCache) {
    return {
      code: scopedCache.code,
      complexity: scopedCache.complexity,
      isCached: true,
    };
  }

  return emptyCodingArtifactDisplay();
}

function getScopedCodingArtifactCache(
  cache: CodingArtifactCache | null,
  activeParentTaskId: string
) {
  return cache?.parentTaskId === activeParentTaskId ? cache : null;
}

function doesArtifactSourceBelongToParent({
  activeParentTaskId,
  sourceParentTaskId,
}: CodingArtifactScope) {
  return !sourceParentTaskId || sourceParentTaskId === activeParentTaskId;
}

function readCodingArtifactPatch({
  activeTaskKind,
  hasExistingCache,
  sections,
}: {
  activeTaskKind?: string;
  hasExistingCache: boolean;
  sections: MeetingAnswerDisplayModel;
}) {
  const code = normalizeCodingArtifactText(sections.code);
  const complexity = normalizeCodingArtifactText(sections.complexity);
  if (!code && !complexity) return undefined;

  if (code || activeTaskKind === "coding") {
    return { code, complexity };
  }

  if (hasExistingCache && complexity && isCodingArtifactUpdate(sections)) {
    return { code, complexity };
  }

  return undefined;
}

function normalizeCodingArtifactText(value: string | undefined) {
  const normalized = stripOuterCodeFence(value ?? "").trim();
  return normalized === "-" ? "" : normalized;
}

function isCodingArtifactUpdate(sections: MeetingAnswerDisplayModel) {
  return /\b(time complexity|space complexity|complexity|implementation|implement|algorithm|code|solution|optimi[sz]e)\b|o\s*\(/i.test(
    [
      sections.focusedQuestion,
      sections.primaryAnswer,
      sections.approach,
      sections.complexity,
      sections.parsedAnswer.rawContent,
    ].join("\n")
  );
}

function emptyCodingArtifactDisplay(): CodingArtifactDisplay {
  return { code: "", complexity: "", isCached: false };
}
