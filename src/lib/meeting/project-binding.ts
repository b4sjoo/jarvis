import type {
  MemoryQuestionType,
  MemoryProjectDirectory,
  MemoryRetrievalResult,
} from "@/lib/memory";
import type {
  EffectiveInterviewTaskRelation,
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
  relation?: InterviewTaskRelation | EffectiveInterviewTaskRelation;
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
  const directory = memoryContext?.projectDirectory;
  const candidates = directory?.status === "ready"
    ? directory.candidates.map((candidate) => ({
        ...candidate,
        evidenceEntryIds: [...candidate.evidenceEntryIds],
        identityAliases: [...candidate.identityAliases],
      }))
    : [];
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

  const selectedCandidate = authoritativeSelection?.projectId
    ? candidates.find((candidate) => candidate.projectId === authoritativeSelection.projectId)
    : authoritativeSelection
      ? findMatchingCandidate(
        candidates,
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
      (authoritativeSelection.projectId
        ? continuingBinding.projectId === authoritativeSelection.projectId
        : [continuingBinding.projectId, continuingBinding.projectName].some(
            (identity) => identity && normalizeProjectAlias(identity) ===
              normalizeProjectAlias(authoritativeSelection.projectName)
          ))
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
        Boolean(findExplicitCanonicalProjectIdentity(projectAnchor, candidate))
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
      action: "needs-selection",
      candidates,
      changed: false,
      sourceAuthority: "memory-candidate",
      sourceTurnIds,
      sourceObservationIds,
      topicCompatible: true,
      topicEvidence,
      reason: "one-eligible-evidence-project-requires-confirmation",
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
    reason: !directory
      ? "project-directory-not-loaded"
      : directory.status === "unavailable"
        ? "project-directory-unavailable"
        : "no-eligible-evidence-project",
  });
}

export interface ProjectSelectionCapability {
  available: boolean;
  reason: string;
  candidates: ProjectBindingCandidate[];
}

export function getProjectSelectionCapability({
  decision,
  directory,
  memoryEnabled,
  questionType,
  isActiveParent,
}: {
  decision?: ProjectBindingDecision;
  directory?: MemoryProjectDirectory;
  memoryEnabled: boolean;
  questionType?: MemoryQuestionType;
  /** Caller validates the current session/parent and binding revision. */
  isActiveParent: boolean;
}): ProjectSelectionCapability {
  const unavailable = (reason: string) => ({ available: false, reason, candidates: [] });
  if (!memoryEnabled) return unavailable("memory-disabled");
  if (!isActiveParent || questionType !== "project-deep-dive") return unavailable("not-active-project-parent");
  if (decision?.binding) return unavailable("project-already-bound");
  if (!directory) return unavailable("project-directory-not-loaded");
  if (directory.status !== "ready") return unavailable("project-directory-unavailable");
  if (!directory.candidates.length) return unavailable("no-eligible-evidence-project");
  if (!decision || decision.action !== "needs-selection") return unavailable(decision?.reason ?? "binding-not-resolved");
  if (
    (decision.sourceAuthority !== "memory-candidate" && decision.sourceAuthority !== "compatible-existing") ||
    (!decision.topicCompatible && !decision.topicEvidence?.deicticReference) ||
    (decision.topicEvidence?.explicitProjectNames.length ?? 0) > 1
  ) return unavailable(decision.reason);
  // A changed directory must be resolved again before exposing its choices.
  const ids = new Set(directory.candidates.map((candidate) => candidate.projectId || candidate.projectName));
  if (!decision.candidates.length || decision.candidates.length !== ids.size ||
    decision.candidates.some((candidate) => !ids.has(candidate.projectId || candidate.projectName))) {
    return unavailable("project-directory-changed");
  }
  return { available: true, reason: decision.reason, candidates: decision.candidates };
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
      ? `Discovery evidence references (not claim support): ${decision.binding.evidenceEntryIds.join(", ")}`
      : undefined,
    decision.candidates.length
      ? `Eligible choices: ${decision.candidates
          .map((candidate) => candidate.projectName)
          .join(", ")}`
      : "Eligible choices: none",
    decision.action === "needs-selection"
      ? "Selection rule: do not choose a project silently for first-person facts. You may still directly answer general analysis, tradeoffs, or explicitly hypothetical examples without selecting a project."
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
  const projectMatches = candidates
    .map((candidate) => ({
      candidate,
      canonicalIdentity: findExplicitCanonicalProjectIdentity(
        sourceText,
        candidate
      ),
      alias: findProjectIdentityAlias(sourceText, candidate),
    }))
    .filter(
      (
        item
      ): item is {
        candidate: ProjectBindingCandidate;
        canonicalIdentity: string | undefined;
        alias: string | undefined;
      } => Boolean(item.canonicalIdentity || item.alias)
    );
  const explicitMatches = projectMatches.filter((item) =>
    Boolean(item.canonicalIdentity)
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
    explicitProjectAliases: projectMatches
      .map(({ alias, canonicalIdentity }) => alias ?? canonicalIdentity)
      .filter((alias): alias is string => Boolean(alias)),
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
    Boolean(findExplicitCanonicalProjectIdentity(sourceText, candidate))
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
        !new Set(["Current", "New", "Previous", "The", "This", "Your", "Which", "What", "Whose"]).has(
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

function findExplicitCanonicalProjectIdentity(
  sourceText: string | undefined,
  candidate: Pick<
    ProjectBindingCandidate,
    "projectId" | "projectName"
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
  return identityMatch
    ? normalizeProjectAlias(identityMatch)
    : undefined;
}

function findProjectIdentityAlias(
  sourceText: string | undefined,
  candidate: Pick<ProjectBindingCandidate, "identityAliases">
) {
  const sourceTokens = tokenizeProjectEvidence(sourceText);
  if (!sourceTokens.length) return undefined;
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
    [candidate.projectId, candidate.projectName].some((identity) =>
      identity && normalizeProjectAlias(selection) === normalizeProjectAlias(identity)
    )
  );
  return matches.length === 1 ? matches[0] : undefined;
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
