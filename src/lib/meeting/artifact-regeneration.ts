import type { ActiveMeetingTask } from "./meeting-task-contracts.js";

import type { ArtifactOnlyAnswerSection, StableAnswerRevision } from "./stable-answer.js";
import type { EffectiveQuestionSourceOwner } from "./effective-question-source-ledger.js";
import type { VisibleAnswerResponseActionTargetDecision } from "./response-action-target.js";
import { normalizeCanonicalQuestionType, type CanonicalQuestionType } from "./task-taxonomy.js";
import type { ActiveInterviewParent, InterviewPlaybookPhase } from "./types.js";

export type ArtifactRegenerationTargetReason =
  | "authorized"
  | "visible-answer-missing"
  | "visible-answer-session-mismatch"
  | "visible-answer-runtime-epoch-mismatch"
  | "visible-answer-owner-mismatch"
  | "visible-answer-question-identity-missing"
  | "visible-answer-settlement-missing"
  | "visible-answer-source-mismatch"
  | "no-regenerable-artifact"
  | "artifact-not-owned-by-current-phase"
  | "artifact-section-owner-mismatch";

export interface ArtifactRegenerationTarget {
  sessionId: string;
  runtimeEpoch: number;
  visibleAnswerRevision: number;
  logicalQuestionUnitId: string;
  logicalQuestionRevision: number;
  settlementId: string;
  sourceHash?: string;
  parentId: string;
  parentRevision: number;
  childId?: string;
  questionType: CanonicalQuestionType;
  playbookPhase: InterviewPlaybookPhase;
  phaseOwnerKind: "parent" | "child";
  phaseOwnerId: string;
  phaseOwnerRevision: number;
  sectionOwner: EffectiveQuestionSourceOwner;
  artifactFamilies: ArtifactOnlyAnswerSection[];
}

export interface ArtifactRegenerationTargetDecision {
  authorized: boolean;
  reason: ArtifactRegenerationTargetReason;
  target?: ArtifactRegenerationTarget;
}

export type CanonicalWhiteboardRegenerationReason =
  | "authorized"
  | "not-required"
  | "canonical-parent-missing"
  | "canonical-parent-id-mismatch"
  | "canonical-parent-revision-mismatch"
  | "canonical-parent-phase-mismatch"
  | "canonical-parent-child-mismatch"
  | "canonical-whiteboard-candidate-missing"
  | "canonical-whiteboard-parent-mismatch"
  | "canonical-whiteboard-id-mismatch"
  | "canonical-whiteboard-revision-mismatch";

export interface CanonicalWhiteboardRegenerationDecision {
  required: boolean;
  authorized: boolean;
  reason: CanonicalWhiteboardRegenerationReason;
  parent?: ActiveInterviewParent;
  parentRevisionBefore?: number;
  parentRevisionAfter?: number;
  whiteboardRevisionBefore?: number;
  whiteboardRevisionCandidate?: number;
}

export function resolveArtifactRegenerationTarget(input: {
  stableAnswer?: StableAnswerRevision | null;
  visibleSource?: Pick<
    VisibleAnswerResponseActionTargetDecision,
    | "authorized"
    | "resolvedLogicalQuestionUnitId"
    | "resolvedLogicalQuestionRevision"
    | "sourceOwner"
  >;
  activeMeetingTask?: ActiveMeetingTask;
  sessionId: string;
  runtimeEpoch: number;
}): ArtifactRegenerationTargetDecision {
  const stable = input.stableAnswer;
  if (!stable) return reject("visible-answer-missing");
  if (stable.sessionId && stable.sessionId !== input.sessionId) {
    return reject("visible-answer-session-mismatch");
  }
  if (
    stable.runtimeEpoch !== undefined &&
    stable.runtimeEpoch !== input.runtimeEpoch
  ) {
    return reject("visible-answer-runtime-epoch-mismatch");
  }
  const activeTask = input.activeMeetingTask;
  if (!activeTask || stable.taskId !== activeTask.parent.id) {
    return reject("visible-answer-owner-mismatch");
  }
  if (
    !stable.logicalQuestionUnitId ||
    stable.logicalQuestionRevision === null
  ) {
    return reject("visible-answer-question-identity-missing");
  }
  if (!stable.settlementId || !stable.settlementSnapshot) {
    return reject("visible-answer-settlement-missing");
  }
  if (
    input.visibleSource &&
    (!input.visibleSource.authorized ||
      input.visibleSource.resolvedLogicalQuestionUnitId !==
        stable.logicalQuestionUnitId ||
      input.visibleSource.resolvedLogicalQuestionRevision !==
        stable.logicalQuestionRevision)
  ) {
    return reject("visible-answer-source-mismatch");
  }

  const settlementSnapshot = stable.settlementSnapshot as {
    questionType?: unknown;
    relation?: unknown;
  };
  const questionType =
    normalizeCanonicalQuestionType(
      settlementSnapshot.questionType
    ) ?? "unknown";
  const parentType =
    normalizeCanonicalQuestionType(activeTask.parent.questionType) ??
    "unknown";
  const activeChild = activeTask.child;
  const sectionOwner: EffectiveQuestionSourceOwner = activeChild
    ? {
        kind: "active-child",
        parentId: activeTask.parent.id,
        childId: activeChild.id,
      }
    : { kind: "parent-mainline", parentId: activeTask.parent.id };
  let artifactFamilies: ArtifactOnlyAnswerSection[] | undefined;

  if (activeChild) {
    const childType =
      normalizeCanonicalQuestionType(activeChild.questionType) ?? "unknown";
    const visibleSourceOwnsActiveChild =
      input.visibleSource?.sourceOwner?.kind === "active-child" &&
      input.visibleSource.sourceOwner.parentId === activeTask.parent.id &&
      input.visibleSource.sourceOwner.childId === activeChild.id;
    const visibleAnswerOwnsCodingChild =
      questionType === "coding" &&
      childType === "coding" &&
      settlementSnapshot.relation === "child-probe" &&
      visibleSourceOwnsActiveChild;
    if (
      visibleAnswerOwnsCodingChild &&
      activeChild.phaseState?.phase === "implementation_validation"
    ) {
      artifactFamilies = ["code", "complexity"];
    } else {
      return reject("no-regenerable-artifact");
    }
  } else if (
    isDesignQuestionType(questionType) &&
    isDesignQuestionType(parentType)
  ) {
    artifactFamilies = ["whiteboard"];
  } else if (questionType === "coding" && parentType === "coding") {
    if (activeTask.parent.playbookPhase !== "implementation_validation") {
      return reject("artifact-not-owned-by-current-phase");
    }
    artifactFamilies = ["code", "complexity"];
  } else {
    return reject("no-regenerable-artifact");
  }

  if (
    artifactFamilies &&
    !retainedArtifactSectionsBelongToOwner({
      stable,
      artifactFamilies,
      owner: sectionOwner,
    })
  ) {
    return reject("artifact-section-owner-mismatch");
  }

  return {
    authorized: true,
    reason: "authorized",
    target: {
      sessionId: input.sessionId,
      runtimeEpoch: input.runtimeEpoch,
      visibleAnswerRevision: stable.revision,
      logicalQuestionUnitId: stable.logicalQuestionUnitId,
      logicalQuestionRevision: stable.logicalQuestionRevision,
      settlementId: stable.settlementId,
      sourceHash: stable.questionSourceHash,
      parentId: activeTask.parent.id,
      parentRevision: activeTask.parent.revisions ?? 0,
      childId: activeChild?.id,
      questionType,
      playbookPhase:
        activeChild?.phaseState?.phase ?? activeTask.parent.playbookPhase,
      phaseOwnerKind: activeChild?.phaseState ? "child" : "parent",
      phaseOwnerId: activeChild?.phaseState
        ? activeChild.id
        : activeTask.parent.id,
      phaseOwnerRevision:
        activeChild?.phaseState?.revision ??
        activeTask.parent.revisions ??
        0,
      sectionOwner,
      artifactFamilies,
    },
  };
}

function retainedArtifactSectionsBelongToOwner(input: {
  stable: StableAnswerRevision;
  artifactFamilies: ArtifactOnlyAnswerSection[];
  owner: EffectiveQuestionSourceOwner;
}) {
  return input.artifactFamilies.every((family) => {
    const content = input.stable.suggestion.meetingAnswer?.sections[family];
    if (!content?.trim()) return true;
    const sectionOwner = input.stable.sections[family]?.owner;
    return Boolean(
      sectionOwner &&
        sectionOwner.kind === input.owner.kind &&
        sectionOwner.parentId === input.owner.parentId &&
        (sectionOwner.kind === "parent-mainline" ||
          (input.owner.kind === "active-child" &&
            sectionOwner.childId === input.owner.childId))
    );
  });
}

export function formatArtifactRegenerationTargetForTrace(
  decision: ArtifactRegenerationTargetDecision
) {
  return {
    artifactRegenerationTargetAuthorized: decision.authorized,
    artifactRegenerationTargetReason: decision.reason,
    artifactRegenerationVisibleAnswerRevision:
      decision.target?.visibleAnswerRevision,
    artifactRegenerationLogicalQuestionUnitId:
      decision.target?.logicalQuestionUnitId,
    artifactRegenerationLogicalQuestionRevision:
      decision.target?.logicalQuestionRevision,
    artifactRegenerationSettlementId: decision.target?.settlementId,
    artifactRegenerationSourceHash: decision.target?.sourceHash,
    artifactRegenerationParentId: decision.target?.parentId,
    artifactRegenerationParentRevision: decision.target?.parentRevision,
    artifactRegenerationChildId: decision.target?.childId,
    artifactRegenerationQuestionType: decision.target?.questionType,
    artifactRegenerationPlaybookPhase: decision.target?.playbookPhase,
    artifactRegenerationPhaseOwnerKind: decision.target?.phaseOwnerKind,
    artifactRegenerationPhaseOwnerId: decision.target?.phaseOwnerId,
    artifactRegenerationPhaseOwnerRevision:
      decision.target?.phaseOwnerRevision,
    artifactRegenerationSectionOwnerKind: decision.target?.sectionOwner.kind,
    artifactRegenerationSectionOwnerParentId:
      decision.target?.sectionOwner.parentId,
    artifactRegenerationSectionOwnerChildId:
      decision.target?.sectionOwner.kind === "active-child"
        ? decision.target.sectionOwner.childId
        : undefined,
    artifactRegenerationRequestedArtifacts:
      decision.target?.artifactFamilies,
  };
}

export function prepareCanonicalWhiteboardRegeneration(input: {
  target: ArtifactRegenerationTarget;
  currentParent?: ActiveInterviewParent;
  candidateWhiteboard?: ActiveInterviewParent["whiteboardArtifact"];
}): CanonicalWhiteboardRegenerationDecision {
  if (!input.target.artifactFamilies.includes("whiteboard")) {
    return {
      required: false,
      authorized: true,
      reason: "not-required",
    };
  }
  if (
    input.target.phaseOwnerKind !== "parent" ||
    input.target.phaseOwnerId !== input.target.parentId
  ) {
    return {
      required: true,
      authorized: false,
      reason: "canonical-parent-phase-mismatch",
    };
  }

  const currentParent = input.currentParent;
  const candidate = input.candidateWhiteboard;
  const reject = (
    reason: Exclude<
      CanonicalWhiteboardRegenerationReason,
      "authorized" | "not-required"
    >
  ): CanonicalWhiteboardRegenerationDecision => ({
    required: true,
    authorized: false,
    reason,
    parentRevisionBefore: currentParent?.revisions,
    whiteboardRevisionBefore: currentParent?.whiteboardArtifact?.revision,
    whiteboardRevisionCandidate: candidate?.revision,
  });

  if (!currentParent) return reject("canonical-parent-missing");
  if (currentParent.id !== input.target.parentId) {
    return reject("canonical-parent-id-mismatch");
  }
  if (currentParent.revisions !== input.target.parentRevision) {
    return reject("canonical-parent-revision-mismatch");
  }
  if (currentParent.playbookPhase !== input.target.playbookPhase) {
    return reject("canonical-parent-phase-mismatch");
  }
  if (currentParent.child?.id !== input.target.childId) {
    return reject("canonical-parent-child-mismatch");
  }
  if (!candidate?.content.trim()) {
    return reject("canonical-whiteboard-candidate-missing");
  }
  if (
    candidate.parentTaskId !== currentParent.id ||
    candidate.currentPhase !== currentParent.playbookPhase
  ) {
    return reject("canonical-whiteboard-parent-mismatch");
  }
  const currentWhiteboard = currentParent.whiteboardArtifact;
  if (currentWhiteboard && candidate.id !== currentWhiteboard.id) {
    return reject("canonical-whiteboard-id-mismatch");
  }
  if (
    candidate.revision !== (currentWhiteboard?.revision ?? 0) + 1
  ) {
    return reject("canonical-whiteboard-revision-mismatch");
  }

  const parent: ActiveInterviewParent = {
    ...currentParent,
    whiteboardArtifact: structuredClone(candidate),
    updatedAt: candidate.updatedAt,
    revisions: currentParent.revisions + 1,
  };
  return {
    required: true,
    authorized: true,
    reason: "authorized",
    parent,
    parentRevisionBefore: currentParent.revisions,
    parentRevisionAfter: parent.revisions,
    whiteboardRevisionBefore: currentWhiteboard?.revision,
    whiteboardRevisionCandidate: candidate.revision,
  };
}

export function formatCanonicalWhiteboardRegenerationForTrace(
  decision: CanonicalWhiteboardRegenerationDecision | undefined
) {
  return {
    artifactOnlyCanonicalParentCommitRequired: decision?.required,
    artifactOnlyCanonicalParentCommitAuthorized: decision?.authorized,
    artifactOnlyCanonicalParentCommitReason: decision?.reason,
    artifactOnlyCanonicalParentRevisionBefore:
      decision?.parentRevisionBefore,
    artifactOnlyCanonicalParentRevisionCandidate:
      decision?.parentRevisionAfter,
    artifactOnlyCanonicalWhiteboardRevisionBefore:
      decision?.whiteboardRevisionBefore,
    artifactOnlyCanonicalWhiteboardRevisionCandidate:
      decision?.whiteboardRevisionCandidate,
  };
}

function reject(
  reason: Exclude<ArtifactRegenerationTargetReason, "authorized">
): ArtifactRegenerationTargetDecision {
  return { authorized: false, reason };
}

function isDesignQuestionType(questionType: CanonicalQuestionType) {
  return (
    questionType === "general-system-design" ||
    questionType === "ai-ml-system-design"
  );
}
