import { resolveEffectiveBranchPhase } from "./active-branch-phase.js";
import type { EffectiveQuestionSourceOwner } from "./effective-question-source-ledger.js";
import type { GenerationCommitDisposition } from "./meeting-presentation-contracts.js";
import { resolvePlaybookRequiredArtifacts } from "./playbook-phase.js";
import { sameStableAnswerSectionOwner, type StableAnswerRevision } from "./stable-answer.js";
import type { ActiveInterviewParent, InterviewPlaybookPhase } from "./types.js";

export function buildBranchPhaseOutputNotice(input: {
  parent?: ActiveInterviewParent;
  stable?: StableAnswerRevision | null;
  // Supply only the latest generation whose Plan/lease/result identity is known.
  generation?: {
    owner: EffectiveQuestionSourceOwner;
    phase: InterviewPlaybookPhase;
    status: GenerationCommitDisposition;
  };
}): string | undefined {
  const branch = resolveEffectiveBranchPhase(input.parent);
  const stable = input.stable;
  if (branch.status !== "resolved" || !stable) return undefined;
  const { view } = branch;
  const owner: EffectiveQuestionSourceOwner = view.ownerKind === "child"
    ? { kind: "active-child", parentId: view.parentId, childId: view.ownerId }
    : { kind: "parent-mainline", parentId: view.parentId };
  const content = stable.suggestion.meetingAnswer?.sections;
  if (!content) return undefined;
  const sameOwnerContent = (section: keyof StableAnswerRevision["sections"]) =>
    Boolean(content[section]?.trim()) &&
    sameStableAnswerSectionOwner(stable.sections[section].owner, owner);
  const sections = ["answer", "code", "complexity", "whiteboard"] as const;
  if (!sections.some(sameOwnerContent)) {
    return undefined;
  }

  const required = resolvePlaybookRequiredArtifacts({
    questionType: view.questionType,
    playbookId: view.playbook.id,
    phase: view.phase,
    subtaskIntent: view.ownerKind === "child" ? input.parent?.child?.intent : undefined,
  });
  const missing = required.filter((section) =>
    !sameOwnerContent(section) ||
      (stable.sections[section].phase !== undefined && stable.sections[section].phase !== view.phase)
  );
  const unknownPhase = required.filter((section) =>
    sameOwnerContent(section) && stable.sections[section].phase === undefined
  );
  if (missing.length === 0 && unknownPhase.length === 0) return undefined;

  const generation = input.generation;
  const status = generation?.phase === view.phase &&
    sameStableAnswerSectionOwner(generation.owner, owner)
    ? generation.status
    : undefined;
  const label = (value: string) => value[0].toUpperCase() + value.slice(1).split("_").join(" ");
  const readiness = `${label(view.phase)}: ${[
    missing.length ? `${missing.map(label).join(", ")} not ready for this phase.` : undefined,
    unknownPhase.length ? `Source phase is unknown for ${unknownPhase.map(label).join(", ")}.` : undefined,
  ].filter(Boolean).join(" ")}`;
  const retained = "Previously published content remains available.";
  if (status === "started") return `${readiness} Generating. ${retained}`;
  if (status === "pending") return `${readiness} An update is awaiting publication. ${retained}`;
  if (status === "failed" || status === "timed-out") return `${readiness} Generation failed. ${retained}`;
  if (status === "cancelled" || status === "aborted" || status === "superseded") {
    return `${readiness} Generation cancelled. ${retained}`;
  }
  return `${readiness} ${retained}`;
}
