import type {
  MemoryQuestionType,
  MemoryRetrievalResult,
  RetrievedMemoryEntry,
} from "@/lib/memory";
import { resolveRetrievedMemoryRole } from "../memory/runtime-role.js";
import type {
  InterviewTaskRelation,
  ProjectBinding,
  ProjectBindingCandidate,
  ProjectBindingDecision,
  ProjectBindingSource,
} from "./types";

export interface ResolveProjectBindingInput {
  existingBinding?: ProjectBinding;
  questionType?: MemoryQuestionType;
  relation?: InterviewTaskRelation;
  requiresProjectBinding?: boolean;
  projectAnchor?: string;
  explicitProjectSelection?: string;
  explicitSelectionSource?: Extract<
    ProjectBindingSource,
    "user-selection" | "correction"
  >;
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
  memoryContext,
  now = Date.now(),
}: ResolveProjectBindingInput): ProjectBindingDecision {
  const candidates = collectProjectBindingCandidates(
    memoryContext?.entries ?? []
  );
  const startsNewParent = relation === "new-parent" || relation === "unknown";
  const continuingBinding = startsNewParent ? undefined : existingBinding;

  const selectedCandidate = explicitProjectSelection
    ? findMatchingCandidate(candidates, explicitProjectSelection)
    : undefined;
  if (selectedCandidate) {
    const sameProject = continuingBinding
      ? projectBindingMatchesCandidate(continuingBinding, selectedCandidate)
      : false;
    return {
      action: sameProject ? "preserve" : "bind",
      binding: sameProject
        ? continuingBinding
        : createProjectBinding({
            candidate: selectedCandidate,
            source: explicitSelectionSource,
            confidence: 1,
            reason: "explicit-project-selection",
            previousBinding: continuingBinding,
            now,
          }),
      candidates,
      changed: !sameProject,
      reason: sameProject
        ? "explicit-selection-matches-existing-binding"
        : "explicit-selection-matched-eligible-evidence",
    };
  }

  if (explicitProjectSelection) {
    if (
      continuingBinding &&
      projectBindingMatchesProjectHint(
        continuingBinding,
        explicitProjectSelection
      )
    ) {
      return {
        action: "preserve",
        binding: cloneProjectBinding(continuingBinding),
        candidates,
        changed: false,
        reason: "explicit-selection-matches-existing-binding",
      };
    }

    return {
      action: "needs-selection",
      candidates,
      changed: false,
      reason: "explicit-selection-has-no-eligible-evidence-match",
    };
  }

  if (continuingBinding) {
    return {
      action: "preserve",
      binding: cloneProjectBinding(continuingBinding),
      candidates,
      changed: false,
      reason: "existing-parent-binding-is-authoritative",
    };
  }

  if (!requiresProjectBinding) {
    return {
      action: "not-applicable",
      candidates,
      changed: false,
      reason: "task-does-not-require-project-binding",
    };
  }

  const anchorMatches = projectAnchor
    ? candidates.filter((candidate) =>
        projectIdentityMatches(projectAnchor, candidate)
      )
    : [];
  if (anchorMatches.length === 1) {
    return {
      action: "bind",
      binding: createProjectBinding({
        candidate: anchorMatches[0],
        source: "memory",
        confidence: 0.96,
        reason: "project-hint-matched-one-evidence-project",
        now,
      }),
      candidates,
      changed: true,
      reason: "project-hint-matched-one-evidence-project",
    };
  }

  if (candidates.length === 1) {
    return {
      action: "bind",
      binding: createProjectBinding({
        candidate: candidates[0],
        source: "memory",
        confidence: 0.9,
        reason: "one-eligible-evidence-project",
        now,
      }),
      candidates,
      changed: true,
      reason: "one-eligible-evidence-project",
    };
  }

  if (candidates.length > 1) {
    return {
      action: "needs-selection",
      candidates,
      changed: false,
      reason: projectAnchor
        ? "project-hint-did-not-resolve-to-one-evidence-project"
        : "multiple-eligible-evidence-projects",
    };
  }

  return {
    action: "needs-selection",
    candidates: [],
    changed: false,
    reason: "no-eligible-evidence-project",
  };
}

export function formatProjectBindingDecisionForPrompt(
  decision: ProjectBindingDecision | undefined
) {
  if (!decision) return "No project-binding decision was computed.";

  return [
    `Action: ${decision.action}`,
    `Reason: ${decision.reason}`,
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
    projectBindingConfidence: decision.binding?.confidence,
    projectBindingRevision: decision.binding?.revision,
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
      }
    : undefined;
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

function collectProjectBindingCandidates(entries: RetrievedMemoryEntry[]) {
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
        score: ordered[0].score,
      };
    })
    .sort((left, right) => right.score - left.score);
}

function createProjectBinding({
  candidate,
  source,
  confidence,
  reason,
  previousBinding,
  now,
}: {
  candidate: ProjectBindingCandidate;
  source: ProjectBindingSource;
  confidence: number;
  reason: string;
  previousBinding?: ProjectBinding;
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
  };
}

function findMatchingCandidate(
  candidates: ProjectBindingCandidate[],
  selection: string
) {
  const matches = candidates.filter((candidate) =>
    projectIdentityMatches(selection, candidate)
  );
  return matches.length === 1 ? matches[0] : undefined;
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
