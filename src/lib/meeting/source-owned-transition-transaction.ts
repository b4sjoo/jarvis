import { createMeetingId } from "./context-manager.js";
import {
  createInitialPlaybookPhaseProgress,
  applyPlaybookPhaseDecisionToProgress,
  type PlaybookPhaseDecision,
} from "./playbook-phase.js";
import {
  createParentAdmissionRecord,
  decideParentAdmission,
  type ParentAdmissionDecision,
} from "./parent-admission.js";
import {
  isParentCanonicalQuestionType,
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";
import type {
  ActiveInterviewParent,
  InterviewSubtaskIntent,
  InterviewTaskRelation,
  ParentReturnCapsule,
  SelectedInterviewPlaybook,
} from "./types.js";

export type SourceOwnedTransitionKind =
  | "new-parent"
  | "reseed-parent"
  | "child-probe"
  | "resume-parent"
  | "phase-progress";

export type SourceOwnedTransitionState =
  | "pending"
  | "committed"
  | "rejected";

export interface SourceOwnedTransitionCandidate {
  id: string;
  sessionId: string;
  runtimeEpoch: number;
  source: "voice" | "screen";
  sourceTurnIds: string[];
  sourceObservationIds: string[];
  logicalQuestionUnitId?: string;
  logicalQuestionRevision?: number;
  kind: SourceOwnedTransitionKind;
  relation: InterviewTaskRelation;
  authoritySource: string;
  questionType: CanonicalQuestionType;
  question: string;
  subtaskIntent: InterviewSubtaskIntent;
  expectedParentId?: string;
  expectedParentRevision?: number;
  preserveChildId?: string;
  questionInstanceId?: string;
  playbook?: SelectedInterviewPlaybook;
  phaseDecision?: PlaybookPhaseDecision;
  parentAdmission?: ParentAdmissionDecision;
  expiresAt?: number;
  state: SourceOwnedTransitionState;
  rejectionReason?: string;
  createdAt: number;
  committedAt?: number;
}

export interface CreateSourceOwnedTransitionCandidateInput {
  sessionId: string;
  runtimeEpoch: number;
  source: "voice" | "screen";
  sourceTurnIds?: string[];
  sourceObservationIds?: string[];
  logicalQuestionUnitId?: string;
  logicalQuestionRevision?: number;
  existingTask?: ActiveInterviewParent;
  preserveChildId?: string;
  relation: InterviewTaskRelation;
  authoritySource: string;
  mutationAuthorized: boolean;
  questionType?: unknown;
  question?: string;
  subtaskIntent?: InterviewSubtaskIntent;
  questionInstanceId?: string;
  playbook?: SelectedInterviewPlaybook;
  phaseDecision?: PlaybookPhaseDecision;
  expiresAt?: number;
  now?: number;
}

export interface CommitSourceOwnedTransitionInput {
  candidate: SourceOwnedTransitionCandidate;
  currentTask?: ActiveInterviewParent;
  currentSessionId: string;
  currentRuntimeEpoch: number;
  now?: number;
}

export interface SourceOwnedTransitionPreparationResult {
  candidate: SourceOwnedTransitionCandidate;
  task?: ActiveInterviewParent;
  mutationApplied: boolean;
  reason: string;
  parentBeforeId?: string;
  parentBeforeType?: string;
  parentBeforeRevision?: number;
  parentAfterId?: string;
  parentAfterType?: string;
  parentAfterRevision?: number;
  childBeforeId?: string;
  childAfterId?: string;
  phaseBefore?: string;
  phaseAfter?: string;
  progressBefore: Record<string, boolean>;
  progressAfter: Record<string, boolean>;
}

export function createSourceOwnedTransitionCandidate(
  input: CreateSourceOwnedTransitionCandidateInput
): SourceOwnedTransitionCandidate | undefined {
  const sourceTurnIds = uniqueStrings(input.sourceTurnIds ?? []);
  const sourceObservationIds = uniqueStrings(
    input.sourceObservationIds ?? []
  );
  if (sourceTurnIds.length === 0 && sourceObservationIds.length === 0) {
    return undefined;
  }

  const questionType =
    normalizeCanonicalQuestionType(input.questionType) ?? "unknown";
  const kind = chooseTransitionKind({
    relation: input.relation,
    existingTask: input.existingTask,
    phaseDecision: input.phaseDecision,
    playbook: input.playbook,
    questionType,
    mutationAuthorized: input.mutationAuthorized,
  });
  if (!kind) return undefined;

  const now = input.now ?? Date.now();
  const base: SourceOwnedTransitionCandidate = {
    id: createStableTransitionId({
      sessionId: input.sessionId,
      runtimeEpoch: input.runtimeEpoch,
      source: input.source,
      sourceTurnIds,
      sourceObservationIds,
      logicalQuestionUnitId: input.logicalQuestionUnitId,
      logicalQuestionRevision: input.logicalQuestionRevision,
      kind,
      parentId: input.existingTask?.id,
      parentRevision: input.existingTask?.revisions,
    }),
    sessionId: input.sessionId,
    runtimeEpoch: input.runtimeEpoch,
    source: input.source,
    sourceTurnIds,
    sourceObservationIds,
    logicalQuestionUnitId: input.logicalQuestionUnitId,
    logicalQuestionRevision: input.logicalQuestionRevision,
    kind,
    relation: input.relation,
    authoritySource: input.authoritySource,
    questionType,
    question: input.question?.trim() ?? "",
    subtaskIntent: input.subtaskIntent ?? "unknown",
    expectedParentId: input.existingTask?.id,
    expectedParentRevision: input.existingTask?.revisions,
    preserveChildId: input.preserveChildId,
    questionInstanceId: input.questionInstanceId,
    playbook: input.playbook ? { ...input.playbook } : undefined,
    phaseDecision: input.phaseDecision
      ? clonePhaseDecision(input.phaseDecision)
      : undefined,
    parentAdmission:
      kind === "new-parent" || kind === "reseed-parent"
        ? decideParentAdmission({
            existingParent: input.existingTask,
            relation: input.relation,
            questionType,
            mutationAuthorized: input.mutationAuthorized,
          })
        : undefined,
    expiresAt: input.expiresAt,
    state: "pending",
    createdAt: now,
  };

  const rejectionReason = authorizeCandidate(base, input.mutationAuthorized);
  return rejectionReason
    ? {
        ...base,
        state: "rejected",
        rejectionReason,
      }
    : base;
}

export function prepareSourceOwnedTransition(
  input: CommitSourceOwnedTransitionInput
): SourceOwnedTransitionPreparationResult {
  const { candidate, currentTask } = input;
  const before = snapshotTask(currentTask);
  const rejected = (
    rejectionReason: string
  ): SourceOwnedTransitionPreparationResult => ({
    candidate: {
      ...candidate,
      state: "rejected",
      rejectionReason,
    },
    task: currentTask,
    mutationApplied: false,
    reason: rejectionReason,
    ...formatBeforeAfter(before, before),
  });

  if (candidate.state === "rejected") {
    return rejected(candidate.rejectionReason ?? "candidate-rejected");
  }
  if (candidate.sessionId !== input.currentSessionId) {
    return rejected("session-mismatch");
  }
  if (candidate.runtimeEpoch !== input.currentRuntimeEpoch) {
    return rejected("runtime-epoch-mismatch");
  }
  if (candidate.expectedParentId !== currentTask?.id) {
    return rejected("parent-id-mismatch");
  }
  if (
    candidate.expectedParentRevision !== undefined &&
    candidate.expectedParentRevision !== currentTask?.revisions
  ) {
    return rejected("parent-revision-mismatch");
  }

  const now = input.now ?? Date.now();
  const transition = applyTransition(candidate, currentTask, now);
  if (transition.reason === "child-owner-mismatch") {
    return rejected(transition.reason);
  }
  const after = snapshotTask(transition.task);

  return {
    candidate: {
      ...candidate,
      state: "committed",
      rejectionReason: undefined,
      committedAt: now,
    },
    task: transition.task,
    mutationApplied: transition.mutationApplied,
    reason: transition.reason,
    ...formatBeforeAfter(before, after),
  };
}

export function sourceOwnedTransitionSurvivesModelOutcome(
  result: SourceOwnedTransitionPreparationResult | undefined,
  outcome: "cancelled" | "error" | "empty-output" | "stale-result" | "success"
) {
  return Boolean(
    result?.candidate.state === "committed" &&
      outcome !== "success"
  );
}

export function formatSourceOwnedTransitionForTrace(
  result:
    | SourceOwnedTransitionPreparationResult
    | SourceOwnedTransitionCandidate
    | undefined,
  extra: {
    committedBeforeModel?: boolean;
    modelRequestStartedAt?: number;
    modelOutcome?: string;
    survivedModelOutcome?: boolean;
  } = {}
): Record<string, unknown> {
  if (!result) return {};
  const candidate =
    "candidate" in result ? result.candidate : result;
  const commitResult = "candidate" in result ? result : undefined;
  const committedBeforeModel =
    extra.committedBeforeModel ??
    candidate.state === "committed";

  return {
    sourceTransitionId: candidate.id,
    sourceTransitionKind: candidate.kind,
    sourceTransitionState: candidate.state,
    sourceTransitionSource: candidate.source,
    sourceTransitionSourceTurnIds: candidate.sourceTurnIds,
    sourceTransitionSourceObservationIds:
      candidate.sourceObservationIds,
    sourceTransitionLogicalQuestionUnitId:
      candidate.logicalQuestionUnitId,
    sourceTransitionLogicalQuestionRevision:
      candidate.logicalQuestionRevision,
    sourceTransitionRuntimeEpoch: candidate.runtimeEpoch,
    sourceTransitionAuthoritySource: candidate.authoritySource,
    sourceTransitionRelation: candidate.relation,
    sourceTransitionQuestionType: candidate.questionType,
    sourceTransitionAuthorizationResult:
      candidate.state === "rejected" ? "rejected" : "authorized",
    sourceTransitionRejectionReason: candidate.rejectionReason,
    sourceTransitionCommittedAt: candidate.committedAt,
    sourceTransitionCommittedBeforeModel: committedBeforeModel,
    sourceTransitionMutationApplied: commitResult?.mutationApplied,
    sourceTransitionCommitReason: commitResult?.reason,
    sourceTransitionParentBeforeId: commitResult?.parentBeforeId,
    sourceTransitionParentBeforeType: commitResult?.parentBeforeType,
    sourceTransitionParentBeforeRevision:
      commitResult?.parentBeforeRevision,
    sourceTransitionParentAfterId: commitResult?.parentAfterId,
    sourceTransitionParentAfterType: commitResult?.parentAfterType,
    sourceTransitionParentAfterRevision:
      commitResult?.parentAfterRevision,
    sourceTransitionChildBeforeId: commitResult?.childBeforeId,
    sourceTransitionChildAfterId: commitResult?.childAfterId,
    sourceTransitionReturnCapsuleParentId:
      commitResult?.task?.child?.returnCapsule?.parentId,
    sourceTransitionReturnCapsulePhase:
      commitResult?.task?.child?.returnCapsule?.parentPhase,
    sourceTransitionReturnCapsuleProjectBindingRevision:
      commitResult?.task?.child?.returnCapsule?.projectBindingRevision,
    sourceTransitionPhaseBefore: commitResult?.phaseBefore,
    sourceTransitionPhaseAfter: commitResult?.phaseAfter,
    phaseBefore: commitResult?.phaseBefore,
    phaseAfter: commitResult?.phaseAfter,
    sourceTransitionProgressBefore: commitResult?.progressBefore,
    sourceTransitionProgressAfter: commitResult?.progressAfter,
    sourceTransitionParentAdmissionAction:
      candidate.parentAdmission?.action,
    sourceTransitionParentAdmissionReason:
      candidate.parentAdmission?.reason,
    sourceTransitionParentAdmissionInvalidatedState:
      candidate.parentAdmission?.invalidatedState,
    sourceTransitionModelRequestStartedAt: extra.modelRequestStartedAt,
    sourceTransitionModelOutcome: extra.modelOutcome,
    sourceTransitionSurvivedModelOutcome:
      extra.survivedModelOutcome ?? false,
  };
}

function chooseTransitionKind(input: {
  relation: InterviewTaskRelation;
  existingTask?: ActiveInterviewParent;
  phaseDecision?: PlaybookPhaseDecision;
  playbook?: SelectedInterviewPlaybook;
  questionType: CanonicalQuestionType;
  mutationAuthorized: boolean;
}): SourceOwnedTransitionKind | undefined {
  if (input.relation === "new-parent") {
    const admission = decideParentAdmission({
      existingParent: input.existingTask,
      relation: input.relation,
      questionType: input.questionType,
      mutationAuthorized: input.mutationAuthorized,
    });
    return admission.action === "reseed-parent"
      ? "reseed-parent"
      : "new-parent";
  }
  if (input.relation === "child-probe") return "child-probe";
  if (input.relation === "resume-parent") return "resume-parent";
  if (input.relation !== "followup-parent") return undefined;
  if (!input.existingTask || !input.phaseDecision) return undefined;

  const nextPhase =
    input.phaseDecision.phase ??
    input.playbook?.phase ??
    input.existingTask.playbookPhase;
  const nextProgress = applyPlaybookPhaseDecisionToProgress(
    input.existingTask.phaseProgress,
    input.phaseDecision,
    input.existingTask.playbookPhase
  );
  return nextPhase !== input.existingTask.playbookPhase ||
    !sameProgress(nextProgress, input.existingTask.phaseProgress)
    ? "phase-progress"
    : undefined;
}

function authorizeCandidate(
  candidate: SourceOwnedTransitionCandidate,
  mutationAuthorized: boolean
) {
  if (!mutationAuthorized) return "mutation-unauthorized";
  if (
    (candidate.kind === "new-parent" ||
      candidate.kind === "reseed-parent") &&
    !isParentCanonicalQuestionType(candidate.questionType)
  ) {
    return "new-parent-type-not-eligible";
  }
  if (
    candidate.kind !== "new-parent" &&
    candidate.kind !== "reseed-parent" &&
    !candidate.expectedParentId
  ) {
    return "active-parent-required";
  }
  if (
    candidate.kind === "child-probe" &&
    candidate.questionType === "unknown"
  ) {
    return "child-type-unknown";
  }
  if (
    (candidate.kind === "new-parent" ||
      candidate.kind === "reseed-parent" ||
      candidate.kind === "child-probe") &&
    !candidate.question
  ) {
    return "source-question-empty";
  }
  return undefined;
}

function applyTransition(
  candidate: SourceOwnedTransitionCandidate,
  currentTask: ActiveInterviewParent | undefined,
  now: number
): {
  task?: ActiveInterviewParent;
  mutationApplied: boolean;
  reason: string;
} {
  if (candidate.kind === "new-parent") {
    if (
      currentTask?.startObservationId &&
      candidate.sourceObservationIds.includes(currentTask.startObservationId)
    ) {
      return {
        task: currentTask,
        mutationApplied: false,
        reason: "already-applied",
      };
    }
    const stableKind = candidate.questionType;
    if (!isParentCanonicalQuestionType(stableKind)) {
      return {
        task: currentTask,
        mutationApplied: false,
        reason: "new-parent-type-not-eligible",
      };
    }
    const phase =
      candidate.phaseDecision?.phase ??
      candidate.playbook?.phase ??
      "follow_up";
    const playbook = withPlaybookPhase(candidate.playbook, phase);
    return {
      task: {
        id: createMeetingId("interview_parent"),
        source: candidate.source,
        stableKind,
        topic: candidate.question || "Unknown interview task",
        playbook,
        playbookPhase: phase,
        phaseProgress: applyPlaybookPhaseDecisionToProgress(
          createInitialPlaybookPhaseProgress(stableKind, playbook?.phase),
          candidate.phaseDecision,
          playbook?.phase
        ),
        supportedFactAnchors: [],
        createdAt: now,
        updatedAt: now,
        expiresAt: candidate.expiresAt,
        originQuestionId: candidate.questionInstanceId,
        startTurnId: candidate.sourceTurnIds[0],
        startObservationId: candidate.sourceObservationIds[0],
        promptTranscriptStartTurnId: candidate.sourceTurnIds[0],
        canonicalQuestionSourceTurnIds: [...candidate.sourceTurnIds],
        admission: createParentAdmissionRecord({
          action: "create-parent",
          authoritySource: candidate.authoritySource,
          sourceTurnIds: candidate.sourceTurnIds,
          sourceObservationIds: candidate.sourceObservationIds,
          reason:
            candidate.parentAdmission?.reason ??
            "source-owned-new-parent",
          admittedAt: now,
        }),
        revisions: 1,
      },
      mutationApplied: true,
      reason: "new-parent-committed",
    };
  }

  if (candidate.kind === "reseed-parent") {
    if (!currentTask) {
      return {
        task: currentTask,
        mutationApplied: false,
        reason: "active-parent-required",
      };
    }
    const stableKind = candidate.questionType;
    if (!isParentCanonicalQuestionType(stableKind)) {
      return {
        task: currentTask,
        mutationApplied: false,
        reason: "reseed-parent-type-not-eligible",
      };
    }
    const phase =
      candidate.phaseDecision?.phase ??
      candidate.playbook?.phase ??
      "follow_up";
    const playbook = withPlaybookPhase(candidate.playbook, phase);
    return {
      task: {
        id: currentTask.id,
        source: candidate.source,
        stableKind,
        topic: candidate.question || "Unknown interview task",
        playbook,
        playbookPhase: phase,
        phaseProgress: applyPlaybookPhaseDecisionToProgress(
          createInitialPlaybookPhaseProgress(stableKind, playbook?.phase),
          candidate.phaseDecision,
          playbook?.phase
        ),
        projectBinding: undefined,
        supportedFactAnchors: [],
        latestUsefulAnswer: undefined,
        previousUsefulAnswer: undefined,
        whiteboardArtifact: undefined,
        createdAt: currentTask.createdAt,
        updatedAt: now,
        expiresAt: candidate.expiresAt,
        originQuestionId: candidate.questionInstanceId,
        startTurnId: candidate.sourceTurnIds[0],
        startObservationId: candidate.sourceObservationIds[0],
        promptTranscriptStartTurnId: candidate.sourceTurnIds[0],
        canonicalQuestionSourceTurnIds: [...candidate.sourceTurnIds],
        parentContextHandoff: undefined,
        admission: createParentAdmissionRecord({
          action: "reseed-parent",
          authoritySource: candidate.authoritySource,
          sourceTurnIds: candidate.sourceTurnIds,
          sourceObservationIds: candidate.sourceObservationIds,
          reason:
            candidate.parentAdmission?.reason ??
            "source-owned-parent-reseed",
          admittedAt: now,
        }),
        child: undefined,
        revisions: currentTask.revisions + 1,
      },
      mutationApplied: true,
      reason: "parent-reseed-committed",
    };
  }

  if (!currentTask) {
    return {
      task: currentTask,
      mutationApplied: false,
      reason: "active-parent-required",
    };
  }

  if (candidate.kind === "child-probe") {
    if (candidate.preserveChildId) {
      if (currentTask.child?.id !== candidate.preserveChildId) {
        return {
          task: currentTask,
          mutationApplied: false,
          reason: "child-owner-mismatch",
        };
      }
      return {
        task: {
          ...currentTask,
          child: {
            ...currentTask.child,
            updatedAt: now,
            questionType: candidate.questionType,
            relation: "child-probe",
            intent: candidate.subtaskIntent,
            question: candidate.question,
            basedOnTurnIds: [...candidate.sourceTurnIds],
            basedOnObservationIds: [
              ...candidate.sourceObservationIds,
            ],
          },
          updatedAt: now,
          expiresAt: candidate.expiresAt,
          revisions: currentTask.revisions + 1,
        },
        mutationApplied: true,
        reason: "child-probe-preserved",
      };
    }
    const alreadyApplied =
      currentTask.child?.question === candidate.question &&
      sameStrings(
        currentTask.child.basedOnTurnIds,
        candidate.sourceTurnIds
      ) &&
      sameStrings(
        currentTask.child.basedOnObservationIds,
        candidate.sourceObservationIds
      );
    if (alreadyApplied) {
      return {
        task: currentTask,
        mutationApplied: false,
        reason: "already-applied",
      };
    }
    return {
      task: {
        ...currentTask,
        child: {
          id: createMeetingId("interview_child"),
          createdAt: now,
          updatedAt: now,
          questionType: candidate.questionType,
          relation: "child-probe",
          intent: candidate.subtaskIntent,
          question: candidate.question,
          basedOnTurnIds: [...candidate.sourceTurnIds],
          basedOnObservationIds: [
            ...candidate.sourceObservationIds,
          ],
          returnCapsule: createParentReturnCapsule(currentTask, now),
        },
        updatedAt: now,
        expiresAt: candidate.expiresAt,
        revisions: currentTask.revisions + 1,
      },
      mutationApplied: true,
      reason: "child-probe-committed",
    };
  }

  if (candidate.kind === "resume-parent") {
    if (!currentTask.child) {
      return {
        task: currentTask,
        mutationApplied: false,
        reason: "already-applied",
      };
    }
    const capsule = currentTask.child.returnCapsule;
    if (capsule) {
      const incompatibility = validateParentReturnCapsule(
        currentTask,
        capsule
      );
      if (incompatibility) {
        return {
          task: currentTask,
          mutationApplied: false,
          reason: incompatibility,
        };
      }
    }
    return {
      task: {
        ...currentTask,
        playbook: capsule
          ? withPlaybookPhase(currentTask.playbook, capsule.parentPhase)
          : currentTask.playbook,
        playbookPhase: capsule?.parentPhase ?? currentTask.playbookPhase,
        supportedFactAnchors: capsule
          ? [...capsule.allowedFactAnchorIds]
          : currentTask.supportedFactAnchors,
        child: undefined,
        updatedAt: now,
        expiresAt: candidate.expiresAt,
        revisions: currentTask.revisions + 1,
      },
      mutationApplied: true,
      reason: "parent-resume-committed",
    };
  }

  const nextPhase =
    candidate.phaseDecision?.phase ??
    candidate.playbook?.phase ??
    currentTask.playbookPhase;
  const nextProgress = applyPlaybookPhaseDecisionToProgress(
    currentTask.phaseProgress,
    candidate.phaseDecision,
    currentTask.playbookPhase
  );
  if (
    nextPhase === currentTask.playbookPhase &&
    sameProgress(nextProgress, currentTask.phaseProgress)
  ) {
    return {
      task: currentTask,
      mutationApplied: false,
      reason: "already-applied",
    };
  }

  return {
    task: {
      ...currentTask,
      playbook: withPlaybookPhase(
        candidate.playbook ?? currentTask.playbook,
        nextPhase
      ),
      playbookPhase: nextPhase,
      phaseProgress: nextProgress,
      updatedAt: now,
      expiresAt: candidate.expiresAt,
      revisions: currentTask.revisions + 1,
    },
    mutationApplied: true,
    reason: "phase-progress-committed",
  };
}

function createParentReturnCapsule(
  task: ActiveInterviewParent,
  createdAt: number
): ParentReturnCapsule {
  return {
    parentId: task.id,
    parentRevisionAtAttach: task.revisions,
    projectBindingRevision: task.projectBinding?.revision,
    parentPhase: task.playbookPhase,
    topicCapsule: task.topic.trim().slice(0, 700),
    allowedFactAnchorIds: [...task.supportedFactAnchors],
    artifactCompatibility: {
      policy: "preserve-parent-artifacts",
      whiteboardArtifactId: task.whiteboardArtifact?.id,
    },
    createdAt,
  };
}

function validateParentReturnCapsule(
  task: ActiveInterviewParent,
  capsule: ParentReturnCapsule
) {
  if (capsule.parentId !== task.id) {
    return "parent-return-capsule-id-mismatch";
  }
  if (task.revisions < capsule.parentRevisionAtAttach) {
    return "parent-return-capsule-revision-regressed";
  }
  if (
    capsule.projectBindingRevision !== task.projectBinding?.revision
  ) {
    return "parent-return-capsule-binding-mismatch";
  }
  if (
    capsule.artifactCompatibility.whiteboardArtifactId !==
    task.whiteboardArtifact?.id
  ) {
    return "parent-return-capsule-artifact-mismatch";
  }
  return undefined;
}

function clonePhaseDecision(
  decision: PlaybookPhaseDecision
): PlaybookPhaseDecision {
  return {
    ...decision,
    flags: [...decision.flags],
    requiredArtifacts: [...decision.requiredArtifacts],
    completedFlags: decision.completedFlags
      ? [...decision.completedFlags]
      : undefined,
    observedRequirementCategories:
      decision.observedRequirementCategories
        ? [...decision.observedRequirementCategories]
        : undefined,
    missingRequirementCategories:
      decision.missingRequirementCategories
        ? [...decision.missingRequirementCategories]
        : undefined,
    whiteboardOpenConstraintCategories:
      decision.whiteboardOpenConstraintCategories
        ? [...decision.whiteboardOpenConstraintCategories]
        : undefined,
    phaseControl: decision.phaseControl
      ? {
          ...decision.phaseControl,
          evidence: [...decision.phaseControl.evidence],
        }
      : undefined,
  };
}

function withPlaybookPhase(
  playbook: SelectedInterviewPlaybook | undefined,
  phase: SelectedInterviewPlaybook["phase"]
) {
  return playbook ? { ...playbook, phase } : undefined;
}

function createStableTransitionId(input: {
  sessionId: string;
  runtimeEpoch: number;
  source: "voice" | "screen";
  sourceTurnIds: string[];
  sourceObservationIds: string[];
  logicalQuestionUnitId?: string;
  logicalQuestionRevision?: number;
  kind: SourceOwnedTransitionKind;
  parentId?: string;
  parentRevision?: number;
}) {
  const raw = [
    input.sessionId,
    input.runtimeEpoch,
    input.source,
    input.sourceTurnIds.join(","),
    input.sourceObservationIds.join(","),
    input.logicalQuestionUnitId ?? "",
    input.logicalQuestionRevision ?? "",
    input.kind,
    input.parentId ?? "",
    input.parentRevision ?? "",
  ].join("|");
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `source_transition_${(hash >>> 0).toString(36)}`;
}

function snapshotTask(task: ActiveInterviewParent | undefined) {
  return {
    parentId: task?.id,
    parentType: task?.stableKind,
    parentRevision: task?.revisions,
    childId: task?.child?.id,
    phase: task?.playbookPhase,
    progress: { ...(task?.phaseProgress ?? {}) },
  };
}

function formatBeforeAfter(
  before: ReturnType<typeof snapshotTask>,
  after: ReturnType<typeof snapshotTask>
) {
  return {
    parentBeforeId: before.parentId,
    parentBeforeType: before.parentType,
    parentBeforeRevision: before.parentRevision,
    parentAfterId: after.parentId,
    parentAfterType: after.parentType,
    parentAfterRevision: after.parentRevision,
    childBeforeId: before.childId,
    childAfterId: after.childId,
    phaseBefore: before.phase,
    phaseAfter: after.phase,
    progressBefore: before.progress,
    progressAfter: after.progress,
  };
}

function uniqueStrings(values: string[]) {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean))
  );
}

function sameProgress(
  left: Record<string, boolean>,
  right: Record<string, boolean>
) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return Array.from(keys).every(
    (key) => Boolean(left[key]) === Boolean(right[key])
  );
}

function sameStrings(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
