import type { ScreenPresentationArtifactAuthoritySource } from "./types.js";
import type { ArtifactProjectionDecision, MeetingAnswerDisplayModel } from "./meeting-answer-display.js";
import { stripOuterCodeFence } from "./screen-task-answer.js";
import {
  areCompatibleParentContinuityTypes,
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";


export type CodingArtifactCacheScope =
  | "parent"
  | "child"
  | "session-screen";

export interface CodingArtifactCache {
  scope?: CodingArtifactCacheScope;
  parentTaskId: string;
  parentQuestionType: CanonicalQuestionType;
  childTaskId?: string;
  ownerQuestionType?: CanonicalQuestionType;
  code: string;
  complexity: string;
  revision?: number;
  codeRevision?: number;
  complexityRevision?: number;
  updatedAt: number;
  sourceSuggestionId?: string;
}

export interface CodingArtifactDisplay {
  code: ArtifactProjectionDecision;
  complexity: ArtifactProjectionDecision;
  isCached: boolean;
}

interface CodingArtifactScope {
  activeParentTaskId: string;
  activeParentQuestionType?: string;
  activeChildTaskId?: string;
  activeChildQuestionType?: string;
  sourceParentTaskId?: string;
  sourceChildTaskId?: string;
  sourceQuestionType?: string;
  sourcePresentationArtifactAuthority?: ScreenPresentationArtifactAuthoritySource;
}

export function updateCodingArtifactCache({
  activeParentTaskId,
  activeParentQuestionType,
  activeChildTaskId,
  activeChildQuestionType,
  cache,
  sections,
  sourceParentTaskId,
  sourceChildTaskId,
  sourceQuestionType,
  sourceCodeMutationAuthorized,
  sourceComplexityMutationAuthorized,
  sourcePresentationArtifactAuthority,
  sourceCodeRevision,
  sourceComplexityRevision,
  sourceSuggestionId,
  updatedAt,
}: CodingArtifactScope & {
  cache: CodingArtifactCache | null;
  sections: MeetingAnswerDisplayModel;
  sourceCodeMutationAuthorized?: boolean;
  sourceComplexityMutationAuthorized?: boolean;
  sourcePresentationArtifactAuthority?: ScreenPresentationArtifactAuthoritySource;
  sourceCodeRevision?: number;
  sourceComplexityRevision?: number;
  sourceSuggestionId?: string;
  updatedAt: number;
}): CodingArtifactCache | null {
  const manualScreenAuthority =
    sourcePresentationArtifactAuthority === "manual-screen";
  const canonicalParentQuestionType = normalizeCanonicalQuestionType(
    activeParentQuestionType
  );
  if (
    (!activeParentTaskId || !canonicalParentQuestionType) &&
    !manualScreenAuthority
  ) {
    return cache?.scope === "session-screen" ? cache : null;
  }

  const scopedCache = getScopedCodingArtifactCache(
    cache,
    activeParentTaskId,
    canonicalParentQuestionType,
    activeChildTaskId,
    activeChildQuestionType
  );
  if (
    sourceCodeMutationAuthorized === false &&
    sourceComplexityMutationAuthorized !== true
  ) {
    return scopedCache;
  }

  if (
    !manualScreenAuthority &&
    !doesArtifactSourceBelongToActiveBranch({
      activeParentTaskId,
      activeParentQuestionType: canonicalParentQuestionType,
      activeChildTaskId,
      activeChildQuestionType,
      sourceParentTaskId,
      sourceChildTaskId,
      sourceQuestionType,
    })
  ) {
    return scopedCache;
  }

  const artifactPatch = readCodingArtifactPatch({
    activeTaskKind: manualScreenAuthority
      ? "coding"
      : normalizeCanonicalQuestionType(
          sourceChildTaskId
            ? activeChildQuestionType
            : canonicalParentQuestionType
        ),
    hasExistingCache: Boolean(scopedCache),
    sections,
  });
  if (!artifactPatch) return scopedCache;

  const codeMutationAuthorized =
    sourceCodeMutationAuthorized !== false;
  const complexityMutationAuthorized =
    sourceComplexityMutationAuthorized ??
    (sourceCodeMutationAuthorized !== false);
  const nextCode = codeMutationAuthorized
    ? artifactPatch.code || scopedCache?.code || ""
    : scopedCache?.code || "";
  const nextComplexity =
    complexityMutationAuthorized
      ? artifactPatch.complexity || scopedCache?.complexity || ""
      : scopedCache?.complexity || "";
  if (!nextCode && !nextComplexity) return null;

  if (
    scopedCache &&
    scopedCache.code === nextCode &&
    scopedCache.complexity === nextComplexity &&
    scopedCache.sourceSuggestionId === sourceSuggestionId
  ) {
    return scopedCache;
  }

  const codeChanged = scopedCache?.code !== nextCode;
  const complexityChanged = scopedCache?.complexity !== nextComplexity;
  const artifactChanged = codeChanged || complexityChanged;

  return {
    scope: manualScreenAuthority
      ? "session-screen"
      : sourceChildTaskId
        ? "child"
        : "parent",
    ...(sourceChildTaskId
      ? {
          childTaskId: sourceChildTaskId,
          ownerQuestionType:
            normalizeCanonicalQuestionType(activeChildQuestionType) ??
            normalizeCanonicalQuestionType(sourceQuestionType),
        }
      : {
          ownerQuestionType: canonicalParentQuestionType,
        }),
    parentTaskId:
      activeParentTaskId || sourceParentTaskId || "manual-screen-session",
    parentQuestionType:
      canonicalParentQuestionType ??
      normalizeCanonicalQuestionType(sourceQuestionType) ??
      "coding",
    code: nextCode,
    complexity: nextComplexity,
    revision:
      artifactChanged
        ? (scopedCache?.revision ?? 0) + 1
        : scopedCache?.revision ?? 1,
    codeRevision:
      Math.max(
        sourceCodeRevision ?? 0,
        codeChanged
          ? (scopedCache?.codeRevision ?? 0) + 1
          : scopedCache?.codeRevision ?? 0
      ),
    complexityRevision:
      Math.max(
        sourceComplexityRevision ?? 0,
        complexityChanged
          ? (scopedCache?.complexityRevision ?? 0) + 1
          : scopedCache?.complexityRevision ?? 0
      ),
    updatedAt,
    sourceSuggestionId,
  };
}

export function resolveCodingArtifactDisplay({
  activeParentTaskId,
  activeParentQuestionType,
  activeChildTaskId,
  activeChildQuestionType,
  cache,
  sections,
  sourceParentTaskId,
  sourceChildTaskId,
  sourceQuestionType,
  sourcePresentationArtifactAuthority,
}: CodingArtifactScope & {
  cache: CodingArtifactCache | null;
  sections: MeetingAnswerDisplayModel;
}): CodingArtifactDisplay {
  const canonicalParentQuestionType = normalizeCanonicalQuestionType(
    activeParentQuestionType
  );

  const scopedCache = getScopedCodingArtifactCache(
    cache,
    activeParentTaskId,
    canonicalParentQuestionType,
    activeChildTaskId,
    activeChildQuestionType
  );
  const manualScreenAuthority =
    sourcePresentationArtifactAuthority === "manual-screen";
  const sourceMatchesParent =
    manualScreenAuthority ||
    (Boolean(activeParentTaskId && canonicalParentQuestionType) &&
      doesArtifactSourceBelongToActiveBranch({
        activeParentTaskId,
        activeParentQuestionType: canonicalParentQuestionType,
        activeChildTaskId,
        activeChildQuestionType,
        sourceParentTaskId,
        sourceChildTaskId,
        sourceQuestionType,
      }));
  const artifactPatch = sourceMatchesParent
    ? readCodingArtifactPatch({
        activeTaskKind: manualScreenAuthority
          ? "coding"
          : normalizeCanonicalQuestionType(
              sourceChildTaskId
                ? activeChildQuestionType
                : canonicalParentQuestionType
            ),
        hasExistingCache: Boolean(scopedCache),
        sections,
      })
    : undefined;

  if (artifactPatch) {
    return {
      code: replaceOrPreserveArtifact(
        artifactPatch.code || scopedCache?.code
      ),
      complexity: replaceOrPreserveArtifact(
        artifactPatch.complexity || scopedCache?.complexity
      ),
      isCached: false,
    };
  }

  if (scopedCache) {
    return {
      code: replaceOrClearArtifact(scopedCache.code),
      complexity: replaceOrClearArtifact(scopedCache.complexity),
      isCached: true,
    };
  }

  return sourceMatchesParent
    ? preserveCodingArtifactDisplay()
    : emptyCodingArtifactDisplay();
}

function getScopedCodingArtifactCache(
  cache: CodingArtifactCache | null,
  activeParentTaskId: string,
  activeParentQuestionType: CanonicalQuestionType | undefined,
  activeChildTaskId?: string,
  activeChildQuestionType?: string
) {
  if (cache?.scope === "session-screen") return cache;
  if (!activeParentTaskId || !activeParentQuestionType) return null;
  if (
    cache?.parentTaskId !== activeParentTaskId ||
    !areCompatibleParentContinuityTypes(
      cache.parentQuestionType,
      activeParentQuestionType
    )
  ) {
    return null;
  }
  if (cache.scope !== "child") return cache;
  const canonicalActiveChildType = normalizeCanonicalQuestionType(
    activeChildQuestionType
  );
  return cache.childTaskId === activeChildTaskId &&
    Boolean(cache.ownerQuestionType && canonicalActiveChildType) &&
    cache.ownerQuestionType === canonicalActiveChildType
    ? cache
    : null;
}

function doesArtifactSourceBelongToActiveBranch({
  activeParentTaskId,
  activeParentQuestionType,
  activeChildTaskId,
  activeChildQuestionType,
  sourceParentTaskId,
  sourceChildTaskId,
  sourceQuestionType,
}: CodingArtifactScope) {
  if (sourceParentTaskId && sourceParentTaskId !== activeParentTaskId) {
    return false;
  }

  const canonicalSourceQuestionType = normalizeCanonicalQuestionType(
    sourceQuestionType
  );
  if (sourceChildTaskId) {
    const canonicalActiveChildQuestionType = normalizeCanonicalQuestionType(
      activeChildQuestionType
    );
    return (
      sourceParentTaskId === activeParentTaskId &&
      sourceChildTaskId === activeChildTaskId &&
      Boolean(canonicalSourceQuestionType) &&
      canonicalSourceQuestionType === canonicalActiveChildQuestionType
    );
  }
  return (
    sourceParentTaskId === activeParentTaskId &&
    Boolean(canonicalSourceQuestionType) &&
    areCompatibleParentContinuityTypes(
      canonicalSourceQuestionType,
      activeParentQuestionType
    )
  );
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
  return {
    code: { kind: "clear" },
    complexity: { kind: "clear" },
    isCached: false,
  };
}

function preserveCodingArtifactDisplay(): CodingArtifactDisplay {
  return {
    code: { kind: "preserve" },
    complexity: { kind: "preserve" },
    isCached: false,
  };
}

function replaceOrPreserveArtifact(
  value: string | undefined
): ArtifactProjectionDecision {
  return value?.trim()
    ? { kind: "replace", value }
    : { kind: "preserve" };
}

function replaceOrClearArtifact(
  value: string | undefined
): ArtifactProjectionDecision {
  return value?.trim() ? { kind: "replace", value } : { kind: "clear" };
}
