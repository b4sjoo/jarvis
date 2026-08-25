import type {
  MemoryQuestionType,
  MemoryRetrievalResult,
  RetrievedMemoryEntry,
} from "@/lib/memory";
import { resolveRetrievedMemoryRole } from "../memory/runtime-role.js";
import type {
  InterviewTaskRelation,
  ExplicitProjectSelection,
  ProjectBinding,
  ProjectBindingAuthority,
  ProjectBindingCandidate,
  ProjectBindingDecision,
  ProjectBindingSource,
  ProjectTopicEvidence,
} from "./types";

export interface ResolveProjectBindingInput {
  existingBinding?: ProjectBinding;
  questionType?: MemoryQuestionType;
  relation?: InterviewTaskRelation;
  requiresProjectBinding?: boolean;
  projectAnchor?: string;
  explicitProjectSelection?: string | ExplicitProjectSelection;
  explicitSelectionSource?: Extract<
    ProjectBindingSource,
    "user-selection" | "correction"
  >;
  currentSourceText?: string;
  sourceTurnIds?: string[];
  sourceObservationIds?: string[];
  projectTopicEvidence?: ProjectTopicEvidence;
  memoryContext?: MemoryRetrievalResult | null;
  now?: number;
}

export function resolveProjectBinding({
  existingBinding,
  questionType,
  relation,
  requiresProjectBinding = questionType === "project-deep-dive",
  projectAnchor,
  explicitProjectSelection,
  explicitSelectionSource = "user-selection",
  currentSourceText,
  sourceTurnIds = [],
  sourceObservationIds = [],
  projectTopicEvidence,
  memoryContext,
  now = Date.now(),
}: ResolveProjectBindingInput): ProjectBindingDecision {
  const candidates = collectProjectBindingCandidates(
    memoryContext?.entries ?? []
  );
  const startsNewParent = relation === "new-parent";
  const continuingBinding = startsNewParent ? undefined : existingBinding;
  const topicEvidence =
    projectTopicEvidence ??
    buildProjectTopicEvidence({
      sourceText: currentSourceText,
      projectAnchor,
      candidates,
    });
  const deicticProjectReference =
    topicEvidence.deicticReference === true;
  const interviewerSelection = deicticProjectReference
    ? undefined
    : deriveExplicitProjectSelectionFromSource({
        sourceText: currentSourceText,
        candidates,
        sourceTurnIds,
        sourceObservationIds,
        now,
      });
  const normalizedExplicitSelection = normalizeExplicitProjectSelection({
    selection: explicitProjectSelection,
    explicitSelectionSource,
    sourceTurnIds,
    sourceObservationIds,
    now,
  });
  const authoritativeSelection =
    interviewerSelection ?? normalizedExplicitSelection;
  const decisionSourceTurnIds = authoritativeSelection
    ? [authoritativeSelection.sourceTurnId].filter(Boolean)
    : [...sourceTurnIds];
  const decisionSourceObservationIds = authoritativeSelection
    ?.sourceObservationId
    ? [authoritativeSelection.sourceObservationId]
    : [...sourceObservationIds];

  const selectedCandidate = authoritativeSelection
    ? findMatchingCandidate(
        candidates,
        authoritativeSelection.projectId ||
          authoritativeSelection.projectName
      )
    : undefined;
  if (selectedCandidate) {
    const sameProject = continuingBinding
      ? projectBindingMatchesCandidate(continuingBinding, selectedCandidate)
      : false;
    const action = sameProject
      ? "preserve"
      : continuingBinding
        ? "rebind"
        : "bind";
    return createProjectBindingDecision({
      action,
      binding: sameProject
        ? cloneProjectBinding(continuingBinding)
        : createProjectBinding({
            candidate: selectedCandidate,
            source: projectBindingSourceForAuthority(
              authoritativeSelection!.authority
            ),
            authority: authoritativeSelection!.authority,
            confidence: 1,
            reason: `${authoritativeSelection!.authority}-project-selection`,
            previousBinding: continuingBinding,
            sourceTurnIds: decisionSourceTurnIds,
            sourceObservationIds: decisionSourceObservationIds,
            now,
          }),
      previousBinding: continuingBinding,
      candidates,
      changed: !sameProject,
      sourceAuthority: authoritativeSelection!.authority,
      sourceTurnIds: decisionSourceTurnIds,
      sourceObservationIds: decisionSourceObservationIds,
      topicCompatible: true,
      topicEvidence,
      reason: sameProject
        ? `${authoritativeSelection!.authority}-matches-existing-binding`
        : continuingBinding
          ? `${authoritativeSelection!.authority}-rebound-existing-project`
          : `${authoritativeSelection!.authority}-matched-eligible-evidence`,
    });
  }

  if (authoritativeSelection) {
    if (
      continuingBinding &&
      projectBindingMatchesProjectHint(
        continuingBinding,
        authoritativeSelection.projectId ||
          authoritativeSelection.projectName
      )
    ) {
      return createProjectBindingDecision({
        action: "preserve",
        binding: cloneProjectBinding(continuingBinding),
        previousBinding: continuingBinding,
        candidates,
        changed: false,
        sourceAuthority: authoritativeSelection.authority,
        sourceTurnIds: decisionSourceTurnIds,
        sourceObservationIds: decisionSourceObservationIds,
        topicCompatible: true,
        topicEvidence,
        reason: `${authoritativeSelection.authority}-matches-existing-binding`,
      });
    }

    return createProjectBindingDecision({
      action: continuingBinding ? "invalidate" : "needs-selection",
      previousBinding: continuingBinding,
      candidates,
      changed: Boolean(continuingBinding),
      sourceAuthority: authoritativeSelection.authority,
      sourceTurnIds: decisionSourceTurnIds,
      sourceObservationIds: decisionSourceObservationIds,
      topicCompatible: false,
      topicEvidence,
      reason: `${authoritativeSelection.authority}-has-no-eligible-evidence-match`,
    });
  }

  if (deicticProjectReference && !continuingBinding) {
    return createProjectBindingDecision({
      action: "needs-selection",
      candidates,
      changed: false,
      sourceAuthority: "compatible-existing",
      sourceTurnIds,
      sourceObservationIds,
      topicCompatible: false,
      topicEvidence,
      reason: "deictic-project-reference-has-no-active-binding",
    });
  }

  const existingTopicCompatible = continuingBinding
    ? isProjectBindingTopicCompatible(continuingBinding, topicEvidence)
    : true;
  if (continuingBinding && !existingTopicCompatible) {
    return createProjectBindingDecision({
      action: "invalidate",
      previousBinding: continuingBinding,
      candidates,
      changed: true,
      sourceAuthority: "compatible-existing",
      sourceTurnIds,
      sourceObservationIds,
      topicCompatible: false,
      topicEvidence,
      reason: "existing-binding-conflicts-with-current-topic-evidence",
    });
  }

  if (continuingBinding) {
    return createProjectBindingDecision({
      action: "preserve",
      binding: cloneProjectBinding(continuingBinding),
      previousBinding: continuingBinding,
      candidates,
      changed: false,
      sourceAuthority: "compatible-existing",
      sourceTurnIds,
      sourceObservationIds,
      topicCompatible: true,
      topicEvidence,
      reason: "existing-parent-binding-is-authoritative",
    });
  }

  if (!requiresProjectBinding) {
    return createProjectBindingDecision({
      action: "not-applicable",
      candidates,
      changed: false,
      sourceAuthority: "memory-candidate",
      sourceTurnIds,
      sourceObservationIds,
      topicCompatible: true,
      topicEvidence,
      reason: "task-does-not-require-project-binding",
    });
  }

  const anchorMatches = projectAnchor
    ? candidates.filter((candidate) =>
        projectIdentityMatches(projectAnchor, candidate)
      )
    : [];
  if (anchorMatches.length === 1) {
    return createProjectBindingDecision({
      action: "bind",
      binding: createProjectBinding({
        candidate: anchorMatches[0],
        source: "memory",
        authority: "memory-candidate",
        confidence: 0.96,
        reason: "project-hint-matched-one-evidence-project",
        sourceTurnIds,
        sourceObservationIds,
        now,
      }),
      candidates,
      changed: true,
      sourceAuthority: "memory-candidate",
      sourceTurnIds,
      sourceObservationIds,
      topicCompatible: true,
      topicEvidence,
      reason: "project-hint-matched-one-evidence-project",
    });
  }

  if (projectAnchor?.trim()) {
    return createProjectBindingDecision({
      action: "needs-selection",
      candidates,
      changed: false,
      sourceAuthority: "memory-candidate",
      sourceTurnIds,
      sourceObservationIds,
      topicCompatible: false,
      topicEvidence,
      reason: "project-hint-did-not-resolve-to-one-evidence-project",
    });
  }

  if (candidates.length === 1) {
    return createProjectBindingDecision({
      action: "bind",
      binding: createProjectBinding({
        candidate: candidates[0],
        source: "memory",
        authority: "memory-candidate",
        confidence: 0.9,
        reason: "one-eligible-evidence-project",
        sourceTurnIds,
        sourceObservationIds,
        now,
      }),
      candidates,
      changed: true,
      sourceAuthority: "memory-candidate",
      sourceTurnIds,
      sourceObservationIds,
      topicCompatible: true,
      topicEvidence,
      reason: "one-eligible-evidence-project",
    });
  }

  if (candidates.length > 1) {
    return createProjectBindingDecision({
      action: "needs-selection",
      candidates,
      changed: false,
      sourceAuthority: "memory-candidate",
      sourceTurnIds,
      sourceObservationIds,
      topicCompatible: true,
      topicEvidence,
      reason: "multiple-eligible-evidence-projects",
    });
  }

  return createProjectBindingDecision({
    action: "needs-selection",
    candidates: [],
    changed: false,
    sourceAuthority: "memory-candidate",
    sourceTurnIds,
    sourceObservationIds,
    topicCompatible: true,
    topicEvidence,
    reason: "no-eligible-evidence-project",
  });
}

export function formatProjectBindingDecisionForPrompt(
  decision: ProjectBindingDecision | undefined
) {
  if (!decision) return "No project-binding decision was computed.";

  return [
    `Action: ${decision.action}`,
    `Reason: ${decision.reason}`,
    `Source authority: ${decision.sourceAuthority}`,
    `Topic compatible: ${decision.topicCompatible ? "yes" : "no"}`,
    decision.binding
      ? `Bound project: ${decision.binding.projectName}`
      : "Bound project: none",
    decision.binding?.projectId
      ? `Project id: ${decision.binding.projectId}`
      : undefined,
    decision.binding
      ? `Evidence entry ids: ${decision.binding.evidenceEntryIds.join(", ")}`
      : undefined,
    decision.candidates.length
      ? `Eligible choices: ${decision.candidates
          .map((candidate) => candidate.projectName)
          .join(", ")}`
      : "Eligible choices: none",
    decision.action === "needs-selection"
      ? "Selection rule: do not choose a project silently. Keep first-person project details fact-neutral and ask the user to select one eligible project."
      : undefined,
    decision.action === "invalidate"
      ? "Invalidation rule: do not use the previous project binding or its fact evidence until a compatible project is selected."
      : undefined,
    decision.binding
      ? "Continuity rule: use this project for all first-person facts in the parent task. Other project memory may not replace it; global guidance remains non-evidentiary assistance."
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatProjectBindingDecisionForTrace(
  decision: ProjectBindingDecision | undefined
): Record<string, unknown> {
  if (!decision) return {};

  return {
    projectBindingAction: decision.action,
    projectBindingReason: decision.reason,
    projectBindingChanged: decision.changed,
    projectBindingProjectId: decision.binding?.projectId,
    projectBindingProjectName: decision.binding?.projectName,
    projectBindingPrimaryEntryId: decision.binding?.primaryEntryId,
    projectBindingEvidenceEntryIds: decision.binding?.evidenceEntryIds,
    projectBindingSource: decision.binding?.source,
    projectBindingSourceAuthority: decision.sourceAuthority,
    projectBindingConfidence: decision.binding?.confidence,
    projectBindingRevision: decision.bindingRevision,
    projectBindingTopicCompatible: decision.topicCompatible,
    projectBindingExplicitAliases:
      decision.topicEvidence?.explicitProjectAliases ?? [],
    projectBindingDeicticReference:
      decision.topicEvidence?.deicticReference ?? false,
    projectBindingSourceTurnIds: decision.sourceTurnIds,
    projectBindingSourceObservationIds: decision.sourceObservationIds,
    projectBindingPreviousProjectId: decision.previousBinding?.projectId,
    projectBindingPreviousProjectName: decision.previousBinding?.projectName,
    projectBindingTopicEvidence: decision.topicEvidence,
    projectBindingCandidateCount: decision.candidates.length,
    projectBindingCandidates: decision.candidates.map((candidate) => ({
      projectId: candidate.projectId,
      projectName: candidate.projectName,
      primaryEntryId: candidate.primaryEntryId,
      evidenceEntryIds: candidate.evidenceEntryIds,
      score: candidate.score,
    })),
  };
}

export function cloneProjectBinding(
  binding: ProjectBinding | undefined
): ProjectBinding | undefined {
  return binding
    ? {
        ...binding,
        evidenceEntryIds: [...binding.evidenceEntryIds],
        sourceTurnIds: [...(binding.sourceTurnIds ?? [])],
        sourceObservationIds: [...(binding.sourceObservationIds ?? [])],
      }
    : undefined;
}

export function buildProjectTopicEvidence({
  sourceText,
  projectAnchor,
  candidates,
}: {
  sourceText?: string;
  projectAnchor?: string;
  candidates: ProjectBindingCandidate[];
}): ProjectTopicEvidence {
  const text = [sourceText, projectAnchor].filter(Boolean).join(" ").trim();
  const explicitMatches = candidates
    .map((candidate) => ({
      candidate,
      alias: findExplicitProjectAlias(sourceText, candidate),
    }))
    .filter(
      (
        item
      ): item is {
        candidate: ProjectBindingCandidate;
        alias: string;
      } => Boolean(item.alias)
    );
  const deicticReference =
    explicitMatches.length === 0 &&
    isDeicticProjectReference(sourceText);
  const unmatchedExplicitProject =
    !deicticReference && explicitMatches.length === 0
      ? extractExplicitProjectName(sourceText)
      : undefined;
  const terms = tokenizeProjectEvidence(text);

  return {
    sourceText: (sourceText ?? "").trim().slice(0, 700),
    deicticReference,
    explicitProjectIds: explicitMatches
      .map(({ candidate }) => candidate.projectId)
      .filter((value): value is string => Boolean(value)),
    explicitProjectNames: [
      ...explicitMatches.map(({ candidate }) => candidate.projectName),
      ...(unmatchedExplicitProject ? [unmatchedExplicitProject] : []),
    ],
    explicitProjectAliases: explicitMatches.map(({ alias }) => alias),
    featureTerms: terms.filter((term) =>
      PROJECT_FEATURE_TERMS.has(term)
    ),
    actionTerms: terms.filter((term) => PROJECT_ACTION_TERMS.has(term)),
    resultTerms: terms.filter((term) => PROJECT_RESULT_TERMS.has(term)),
    conflictingProjectNames: unmatchedExplicitProject
      ? candidates.map((candidate) => candidate.projectName)
      : [],
  };
}

function isDeicticProjectReference(sourceText: string | undefined) {
  const text = sourceText
    ?.normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#._-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;
  return /\b(?:this|that|current|the same)(?:\s+[\p{L}\p{N}+#._-]+){0,3}\s+project\b/iu.test(
    text
  );
}

export function deriveExplicitProjectSelectionFromSource({
  sourceText,
  candidates,
  sourceTurnIds = [],
  sourceObservationIds = [],
  now = Date.now(),
}: {
  sourceText?: string;
  candidates: ProjectBindingCandidate[];
  sourceTurnIds?: string[];
  sourceObservationIds?: string[];
  now?: number;
}): ExplicitProjectSelection | undefined {
  const matches = candidates.filter((candidate) =>
    Boolean(findExplicitProjectAlias(sourceText, candidate))
  );
  if (matches.length > 1) return undefined;
  const match = matches[0];
  const unmatchedExplicitProject = match
    ? undefined
    : extractExplicitProjectName(sourceText);
  if (!match && !unmatchedExplicitProject) return undefined;

  return {
    sessionId: "runtime-current-session",
    runtimeEpoch: 0,
    sourceTurnId: sourceTurnIds.at(-1) ?? "current-source",
    sourceObservationId: sourceObservationIds.at(-1),
    projectId: match?.projectId,
    projectName: match?.projectName ?? unmatchedExplicitProject!,
    authority: "interviewer-explicit",
    actionRevision: 0,
    createdAt: now,
  };
}

function extractExplicitProjectName(sourceText: string | undefined) {
  const text = sourceText?.trim();
  if (!text) return undefined;
  const matches = Array.from(
    text.matchAll(
      /\b((?:[A-Z][A-Za-z0-9._-]*)(?:\s+[A-Z][A-Za-z0-9._-]*){0,2})\s+project\b/g
    )
  )
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value))
    .filter(
      (value) =>
        !new Set(["Current", "New", "Previous", "The", "This", "Your"]).has(
          value
        )
    );
  const unique = Array.from(new Set(matches));
  return unique.length === 1 ? unique[0] : undefined;
}

export function projectBindingMatchesProjectHint(
  binding: ProjectBinding,
  projectHint: string | undefined
) {
  if (!projectHint?.trim()) return false;
  return projectIdentityMatches(projectHint, {
    projectId: binding.projectId,
    projectName: binding.projectName,
  });
}

export function collectProjectBindingCandidates(
  entries: RetrievedMemoryEntry[]
) {
  const groups = new Map<
    string,
    {
      projectId?: string;
      projectName: string;
      entries: RetrievedMemoryEntry[];
    }
  >();

  for (const item of entries) {
    if (!resolveRetrievedMemoryRole(item).anchorEligible) continue;
    const projectName = item.entry.projectName?.trim();
    const projectId = item.entry.projectId?.trim();
    if (!projectName && !projectId) continue;
    const displayName = projectName || projectId!;
    const key = normalizeProjectIdentity(projectId || displayName);
    if (!key) continue;
    const existing = groups.get(key);
    if (existing) {
      existing.entries.push(item);
      if (!existing.projectId && projectId) existing.projectId = projectId;
      if (existing.projectName === existing.projectId && projectName) {
        existing.projectName = projectName;
      }
    } else {
      groups.set(key, {
        projectId,
        projectName: displayName,
        entries: [item],
      });
    }
  }

  return Array.from(groups.values())
    .map<ProjectBindingCandidate>((group) => {
      const ordered = [...group.entries].sort(
        (left, right) => right.score - left.score
      );
      return {
        projectId: group.projectId,
        projectName: group.projectName,
        primaryEntryId: ordered[0].entry.id,
        evidenceEntryIds: Array.from(
          new Set(ordered.map((item) => item.entry.id))
        ),
        identityAliases: collectProjectIdentityAliases(
          group.projectName,
          group.projectId,
          ordered
        ),
        score: ordered[0].score,
      };
    })
    .sort((left, right) => right.score - left.score);
}

function createProjectBinding({
  candidate,
  source,
  authority,
  confidence,
  reason,
  previousBinding,
  sourceTurnIds = [],
  sourceObservationIds = [],
  now,
}: {
  candidate: ProjectBindingCandidate;
  source: ProjectBindingSource;
  authority: ProjectBindingAuthority;
  confidence: number;
  reason: string;
  previousBinding?: ProjectBinding;
  sourceTurnIds?: string[];
  sourceObservationIds?: string[];
  now: number;
}): ProjectBinding {
  return {
    projectId: candidate.projectId,
    projectName: candidate.projectName,
    primaryEntryId: candidate.primaryEntryId,
    evidenceEntryIds: [...candidate.evidenceEntryIds],
    source,
    confidence,
    lockedAt: now,
    revision: (previousBinding?.revision ?? 0) + 1,
    reason,
    authority,
    sourceTurnIds: [...sourceTurnIds],
    sourceObservationIds: [...sourceObservationIds],
  };
}

function createProjectBindingDecision(
  input: Omit<ProjectBindingDecision, "bindingRevision">
): ProjectBindingDecision {
  return {
    ...input,
    previousBinding: cloneProjectBinding(input.previousBinding),
    sourceTurnIds: [...input.sourceTurnIds],
    sourceObservationIds: [...input.sourceObservationIds],
    bindingRevision:
      input.binding?.revision ?? input.previousBinding?.revision ?? 0,
  };
}

function normalizeExplicitProjectSelection({
  selection,
  explicitSelectionSource,
  sourceTurnIds,
  sourceObservationIds,
  now,
}: {
  selection: string | ExplicitProjectSelection | undefined;
  explicitSelectionSource: "user-selection" | "correction";
  sourceTurnIds: string[];
  sourceObservationIds: string[];
  now: number;
}): ExplicitProjectSelection | undefined {
  if (!selection) return undefined;
  if (typeof selection !== "string") return selection;
  const projectName = selection.trim();
  if (!projectName) return undefined;

  return {
    sessionId: "runtime-current-session",
    runtimeEpoch: 0,
    sourceTurnId: sourceTurnIds.at(-1) ?? "manual-selection",
    sourceObservationId: sourceObservationIds.at(-1),
    projectName,
    authority:
      explicitSelectionSource === "correction"
        ? "manual-correction"
        : "user-explicit",
    actionRevision: 0,
    createdAt: now,
  };
}

function projectBindingSourceForAuthority(
  authority: ExplicitProjectSelection["authority"]
): ProjectBindingSource {
  if (authority === "interviewer-explicit") return "interviewer-explicit";
  if (authority === "manual-correction") return "manual-correction";
  return "user-explicit";
}

function isProjectBindingTopicCompatible(
  binding: ProjectBinding,
  evidence: ProjectTopicEvidence
) {
  const explicitProjects = [
    ...evidence.explicitProjectIds,
    ...evidence.explicitProjectNames,
  ];
  if (!explicitProjects.length) return true;
  return explicitProjects.some((project) =>
    projectBindingMatchesProjectHint(binding, project)
  );
}

function findExplicitProjectAlias(
  sourceText: string | undefined,
  candidate: Pick<
    ProjectBindingCandidate,
    "projectId" | "projectName" | "identityAliases"
  >
) {
  const sourceTokens = tokenizeProjectEvidence(sourceText);
  if (!sourceTokens.length) return undefined;
  const identities = [candidate.projectName, candidate.projectId].filter(
    (value): value is string => Boolean(value?.trim())
  );

  const identityMatch = identities.find((identity) => {
    const identityTokens = tokenizeProjectEvidence(identity).filter(
      (token) => !GENERIC_PROJECT_IDENTITY_TERMS.has(token)
    );
    if (!identityTokens.length) return false;
    return identityTokens.every((token) => sourceTokens.includes(token));
  });
  if (identityMatch) return normalizeProjectAlias(identityMatch);

  const normalizedSource = ` ${sourceTokens.join(" ")} `;
  return candidate.identityAliases?.find((alias) =>
    normalizedSource.includes(` ${normalizeProjectAlias(alias)} `)
  );
}

function findMatchingCandidate(
  candidates: ProjectBindingCandidate[],
  selection: string
) {
  const matches = candidates.filter((candidate) =>
    projectIdentityMatches(selection, candidate) ||
      Boolean(findExplicitProjectAlias(selection, candidate))
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function collectProjectIdentityAliases(
  projectName: string,
  projectId: string | undefined,
  entries: RetrievedMemoryEntry[]
) {
  const rawAliases = [
    projectName,
    projectId,
    ...entries.flatMap(({ entry }) => [
      entry.title,
      ...entry.tags,
      ...entry.keywords,
    ]),
  ].filter((value): value is string => Boolean(value?.trim()));

  return Array.from(
    new Set(rawAliases.flatMap(buildDiscriminativeProjectAliases))
  );
}

function buildDiscriminativeProjectAliases(value: string) {
  const tokens = tokenizeProjectEvidence(value).filter(
    (token) =>
      !GENERIC_PROJECT_IDENTITY_TERMS.has(token) &&
      !PROJECT_ALIAS_STOP_TERMS.has(token)
  );
  if (tokens.length < 2) return [];
  if (tokens.length <= 4) return [tokens.join(" ")];

  const aliases: string[] = [];
  for (const size of [4, 3]) {
    for (let index = 0; index + size <= tokens.length; index += 1) {
      aliases.push(tokens.slice(index, index + size).join(" "));
    }
  }
  return aliases;
}

function normalizeProjectAlias(value: string) {
  return tokenizeProjectEvidence(value).join(" ");
}

function projectBindingMatchesCandidate(
  binding: ProjectBinding,
  candidate: ProjectBindingCandidate
) {
  return (
    normalizeProjectIdentity(binding.projectId || binding.projectName) ===
    normalizeProjectIdentity(candidate.projectId || candidate.projectName)
  );
}

function projectIdentityMatches(
  value: string,
  candidate: Pick<ProjectBindingCandidate, "projectId" | "projectName">
) {
  const normalizedValue = normalizeProjectIdentity(value);
  const identities = [candidate.projectId, candidate.projectName]
    .map(normalizeProjectIdentity)
    .filter(Boolean);
  return identities.some(
    (identity) =>
      normalizedValue === identity ||
      (identity.length >= 4 && normalizedValue.includes(identity)) ||
      (normalizedValue.length >= 4 && identity.includes(normalizedValue))
  );
}

function normalizeProjectIdentity(value: string | undefined) {
  return (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\b(project|system|feature)\b/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

function tokenizeProjectEvidence(text: string | undefined) {
  return (text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

const GENERIC_PROJECT_IDENTITY_TERMS = new Set([
  "project",
  "system",
  "service",
  "platform",
  "feature",
  "tool",
  "app",
  "application",
]);

const PROJECT_ALIAS_STOP_TERMS = new Set([
  "a",
  "an",
  "and",
  "api",
  "apis",
  "for",
  "in",
  "of",
  "on",
  "the",
  "to",
  "with",
]);

const PROJECT_FEATURE_TERMS = new Set([
  "memory",
  "retrieval",
  "throttling",
  "inference",
  "interface",
  "migration",
  "search",
  "agent",
  "agents",
]);

const PROJECT_ACTION_TERMS = new Set([
  "build",
  "built",
  "design",
  "designed",
  "implement",
  "implemented",
  "debug",
  "debugged",
  "migrate",
  "migrated",
  "optimize",
  "optimized",
]);

const PROJECT_RESULT_TERMS = new Set([
  "impact",
  "latency",
  "throughput",
  "reliability",
  "cost",
  "saved",
  "reduced",
  "improved",
  "failure",
]);
