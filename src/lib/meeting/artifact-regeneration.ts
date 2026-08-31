import type { ActiveMeetingTask } from "./active-meeting-task.js";
import type {
  ArtifactOnlyAnswerSection,
  StableAnswerRevision,
} from "./stable-answer.js";
import {
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";
import type { InterviewPlaybookPhase } from "./types.js";

export type ArtifactRegenerationTargetReason =
  | "authorized"
  | "visible-answer-missing"
  | "visible-answer-session-mismatch"
  | "visible-answer-runtime-epoch-mismatch"
  | "visible-answer-owner-mismatch"
  | "visible-answer-question-identity-missing"
  | "visible-answer-settlement-missing"
  | "no-regenerable-artifact"
  | "artifact-not-owned-by-current-phase";

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
  artifactFamilies: ArtifactOnlyAnswerSection[];
}

export interface ArtifactRegenerationTargetDecision {
  authorized: boolean;
  reason: ArtifactRegenerationTargetReason;
  target?: ArtifactRegenerationTarget;
}

export function resolveArtifactRegenerationTarget(input: {
  stableAnswer?: StableAnswerRevision | null;
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
  let artifactFamilies: ArtifactOnlyAnswerSection[] | undefined;

  if (activeChild) {
    const childType =
      normalizeCanonicalQuestionType(activeChild.questionType) ?? "unknown";
    const visibleAnswerOwnsCodingChild =
      questionType === "coding" &&
      childType === "coding" &&
      settlementSnapshot.relation === "child-probe" &&
      stable.suggestion.codeArtifactMutationAuthorized === true &&
      stable.suggestion.complexityArtifactMutationAuthorized === true;
    if (visibleAnswerOwnsCodingChild) {
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
      playbookPhase: activeTask.parent.playbookPhase,
      artifactFamilies,
    },
  };
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
    artifactRegenerationRequestedArtifacts:
      decision.target?.artifactFamilies,
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
