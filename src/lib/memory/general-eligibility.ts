import type { MemoryInterviewFamilyDecision } from "./interview-family.js";
import { isMemoryProjectIdentityMatch } from "./project-anchor.js";
import type {
  MemoryEntry,
  MemoryGeneralEligibilitySummary,
  MemoryGeneralScopePath,
  MemoryRejectReason,
  MemoryUseCase,
} from "./types.js";

const EXPLICIT_GLOBAL_REUSABLE_TYPES = new Set<MemoryEntry["type"]>([
  "profile",
  "preference",
  "resume_fact",
  "glossary",
  "correction",
]);

const BROAD_SCOPE_TOKENS = new Set([
  "answer",
  "app",
  "application",
  "architecture",
  "code",
  "coding",
  "data",
  "design",
  "feature",
  "implement",
  "implementation",
  "interview",
  "model",
  "platform",
  "project",
  "question",
  "service",
  "stack",
  "system",
  "technical",
  "technology",
]);

const STOP_TOKENS = new Set([
  "about",
  "after",
  "also",
  "because",
  "could",
  "from",
  "have",
  "into",
  "please",
  "should",
  "tell",
  "that",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
  "your",
]);

const GENERIC_PROJECT_SCOPE_TOKENS = new Set([
  "api",
  "backend",
  "cache",
  "client",
  "concept",
  "database",
  "endpoint",
  "failure",
  "field",
  "frontend",
  "guide",
  "knowledge",
  "note",
  "operation",
  "operations",
  "pattern",
  "request",
  "requirement",
  "response",
  "server",
  "storage",
  "support",
  "workflow",
]);

interface MemoryGeneralProjectScopeEvidence {
  discriminativeAnchorMatchCount: number;
  genericStructuredMatchCount: number;
  genericContentMatchCount: number;
}

export interface MemoryGeneralEligibilityDecision {
  applies: boolean;
  eligible: boolean;
  scopePath?: MemoryGeneralScopePath;
  rejectReason?: Extract<
    MemoryRejectReason,
    "general-without-positive-scope"
  >;
  evidence: string[];
  projectScopeEvidence?: MemoryGeneralProjectScopeEvidence;
}

export function resolveGeneralMemoryEligibility({
  entry,
  familyDecision,
  query,
  useCase,
  projectId,
  projectAnchor,
}: {
  entry: MemoryEntry;
  familyDecision: MemoryInterviewFamilyDecision;
  query: string;
  useCase: MemoryUseCase;
  projectId?: string;
  projectAnchor?: string;
}): MemoryGeneralEligibilityDecision {
  if (
    familyDecision.families.length !== 1 ||
    familyDecision.families[0] !== "general"
  ) {
    return { applies: false, eligible: true, evidence: [] };
  }

  const reusableUseCase = resolveExplicitReusableUseCase(entry, useCase);
  if (reusableUseCase) {
    return {
      applies: true,
      eligible: true,
      scopePath: "explicit-reusable",
      evidence: [`type:${entry.type}`, `entryUseCase:${reusableUseCase}`],
    };
  }

  const projectIdentity = projectId ?? projectAnchor;
  if (
    hasProjectAssociation(entry) &&
    isMemoryProjectIdentityMatch(entry, projectIdentity)
  ) {
    return {
      applies: true,
      eligible: true,
      scopePath: "project-compatible",
      evidence: ["canonical-project-identity-match"],
    };
  }

  const relevance = resolveStrongCurrentQuestionRelevance(
    entry,
    query,
    isProjectScopedEntry(entry)
  );
  if (relevance.strong) {
    return {
      applies: true,
      eligible: true,
      scopePath: "strong-current-question",
      evidence: relevance.evidence,
      projectScopeEvidence: relevance.projectScopeEvidence,
    };
  }

  return {
    applies: true,
    eligible: false,
    rejectReason: "general-without-positive-scope",
    evidence: relevance.evidence,
    projectScopeEvidence: relevance.projectScopeEvidence,
  };
}

export function createGeneralMemoryEligibilityRecorder() {
  const decisions: Array<{
    entryId: string;
    decision: MemoryGeneralEligibilityDecision;
  }> = [];

  return {
    record(entryId: string, decision: MemoryGeneralEligibilityDecision) {
      if (decision.applies) decisions.push({ entryId, decision });
    },
    summary(): MemoryGeneralEligibilitySummary {
      const scopePathCounts: Record<MemoryGeneralScopePath, number> = {
        "explicit-reusable": 0,
        "project-compatible": 0,
        "strong-current-question": 0,
      };
      const allowed = decisions.filter((item) => item.decision.eligible);
      for (const item of allowed) {
        if (item.decision.scopePath) {
          scopePathCounts[item.decision.scopePath] += 1;
        }
      }
      const rejected = decisions.filter((item) => !item.decision.eligible);
      const projectScoped = decisions.filter(
        (item) => item.decision.projectScopeEvidence
      );
      return {
        evaluatedCount: decisions.length,
        allowedCount: allowed.length,
        rejectedCount: rejected.length,
        scopePathCounts,
        allowedSamples: allowed.slice(0, 8).flatMap((item) =>
          item.decision.scopePath
            ? [{ entryId: item.entryId, scopePath: item.decision.scopePath }]
            : []
        ),
        rejectedEntryIds: rejected.slice(0, 8).map((item) => item.entryId),
        projectScopedEvidence: {
          evaluatedCount: projectScoped.length,
          allowedByDiscriminativeAnchorCount: projectScoped.filter(
            (item) =>
              item.decision.eligible &&
              (item.decision.projectScopeEvidence
                ?.discriminativeAnchorMatchCount ?? 0) > 0
          ).length,
          rejectedWithGenericOverlapCount: projectScoped.filter(
            (item) =>
              !item.decision.eligible &&
              ((item.decision.projectScopeEvidence
                ?.genericStructuredMatchCount ?? 0) > 0 ||
                (item.decision.projectScopeEvidence
                  ?.genericContentMatchCount ?? 0) > 0)
          ).length,
          samples: projectScoped.slice(0, 8).map((item) => ({
            entryId: item.entryId,
            eligible: item.decision.eligible,
            discriminativeAnchorMatchCount:
              item.decision.projectScopeEvidence!
                .discriminativeAnchorMatchCount,
            genericStructuredMatchCount:
              item.decision.projectScopeEvidence!
                .genericStructuredMatchCount,
            genericContentMatchCount:
              item.decision.projectScopeEvidence!
                .genericContentMatchCount,
          })),
        },
      };
    },
  };
}

function resolveExplicitReusableUseCase(
  entry: MemoryEntry,
  useCase: MemoryUseCase
) {
  if (
    entry.scope === "global" &&
    !hasProjectAssociation(entry) &&
    EXPLICIT_GLOBAL_REUSABLE_TYPES.has(entry.type)
  ) {
    return entry.useCases.find(
      (candidate) =>
        candidate === useCase ||
        candidate === "meeting_assistant" ||
        candidate === "general_chat"
    );
  }
  return undefined;
}

function hasProjectAssociation(entry: MemoryEntry) {
  return Boolean(entry.projectId?.trim() || entry.projectName?.trim());
}

function isProjectScopedEntry(entry: MemoryEntry) {
  return entry.scope === "project" || hasProjectAssociation(entry);
}

function resolveStrongCurrentQuestionRelevance(
  entry: MemoryEntry,
  query: string,
  projectScoped: boolean
) {
  const queryTokens = meaningfulTokens(query);
  const titleTokens = meaningfulTokens(entry.title);
  const tagAndKeywordTokens = meaningfulTokens(
    [...entry.tags, ...entry.keywords].join(" ")
  );
  const structuredTokens = new Set([...titleTokens, ...tagAndKeywordTokens]);
  const contentTokens = meaningfulTokens(
    [entry.summary, entry.content.slice(0, 1000)].filter(Boolean).join(" ")
  );
  const structuredMatches = intersect(queryTokens, structuredTokens);
  const contentMatches = intersect(queryTokens, contentTokens);
  const genericStructuredMatches = filterGenericProjectScopeTokens(
    structuredMatches
  );
  const genericContentMatches = filterGenericProjectScopeTokens(contentMatches);
  const exactMetadataSignal = [...entry.tags, ...entry.keywords].some((value) =>
    isExactMetadataSignal(queryTokens, value)
  );
  const exactTitleSignal =
    titleTokens.size >= 2 &&
    [...titleTokens].every((token) => queryTokens.has(token));
  const discriminativeAnchorMatchCount = projectScoped
    ? countDiscriminativeProjectAnchorMatches(entry, queryTokens)
    : 0;
  const strong = projectScoped
    ? discriminativeAnchorMatchCount > 0
    : exactMetadataSignal ||
      exactTitleSignal ||
      structuredMatches.size >= 2 ||
      contentMatches.size >= 3;
  const projectScopeEvidence = projectScoped
    ? {
        discriminativeAnchorMatchCount,
        genericStructuredMatchCount: genericStructuredMatches.size,
        genericContentMatchCount: genericContentMatches.size,
      }
    : undefined;

  return {
    strong,
    evidence: [
      `structuredMatches:${structuredMatches.size}`,
      `contentMatches:${contentMatches.size}`,
      `exactMetadata:${exactMetadataSignal}`,
      `exactTitle:${exactTitleSignal}`,
      ...(projectScopeEvidence
        ? [
            "projectScoped:true",
            `discriminativeAnchorMatches:${discriminativeAnchorMatchCount}`,
            `genericStructuredMatches:${genericStructuredMatches.size}`,
            `genericContentMatches:${genericContentMatches.size}`,
          ]
        : []),
    ],
    projectScopeEvidence,
  };
}

function filterGenericProjectScopeTokens(tokens: Set<string>) {
  return new Set(
    [...tokens].filter((token) => GENERIC_PROJECT_SCOPE_TOKENS.has(token))
  );
}

function countDiscriminativeProjectAnchorMatches(
  entry: MemoryEntry,
  queryTokens: Set<string>
) {
  const signals = new Set(
    [
      entry.projectId,
      entry.projectName,
      entry.title,
      ...entry.tags,
      ...entry.keywords,
    ]
      .filter((value): value is string => Boolean(value?.trim()))
      .map((value) => value.trim().toLowerCase())
  );
  let matches = 0;
  for (const signal of signals) {
    const tokens = meaningfulTokens(signal);
    if (
      !tokens.size ||
      ![...tokens].some(
        (token) => !GENERIC_PROJECT_SCOPE_TOKENS.has(token)
      ) ||
      !isExactMetadataSignal(queryTokens, signal)
    ) {
      continue;
    }
    matches += 1;
  }
  return matches;
}

function isExactMetadataSignal(queryTokens: Set<string>, value: string) {
  const tokens = meaningfulTokens(value);
  if (!tokens.size || tokens.size > 4) return false;
  return [...tokens].every((token) => queryTokens.has(token));
}

function meaningfulTokens(value: string) {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}+#.]+/gu, " ")
      .split(/\s+/)
      .filter(
        (token) =>
          token.length >= 3 &&
          !STOP_TOKENS.has(token) &&
          !BROAD_SCOPE_TOKENS.has(token)
      )
  );
}

function intersect(left: Set<string>, right: Set<string>) {
  return new Set([...left].filter((value) => right.has(value)));
}
