import { createMeetingId } from "./context-manager.js";
import {
  createProvisionalCurrentQuestion,
  decideCurrentQuestionMutationAuthority,
  formatCurrentQuestionMutationAuthorityForTrace,
  formatCurrentQuestionSettlementForTrace,
  formatProvisionalCurrentQuestionForTrace,
  type CurrentQuestionMutationAuthorityDecision,
  type CurrentQuestionSettlementDecision,
  type CurrentQuestionSourceKind,
  type ProvisionalCurrentQuestion,
} from "./current-question-settlement.js";
import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import {
  applyPlaybookPhaseDecisionToProgress,
  type PlaybookPhaseDecision,
} from "./playbook-phase.js";
import {
  isParentCanonicalQuestionType,
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";
import type {
  ActiveInterviewParent,
  InterviewTaskRelation,
  ParentContextHandoff,
  SelectedInterviewPlaybook,
} from "./types.js";

export const TASK_BOUNDARY_PENDING_TTL_MS = 15_000;

export type TaskBoundaryCandidateState =
  | "pending"
  | "committed"
  | "superseded"
  | "expired";

export type TaskBoundaryCommitPolicy =
  | "immediate"
  | "await-adjacent-completion";

export type TaskBoundaryAuthoritySource =
  | "manual-correction"
  | "opening-route"
  | "accepted-transcript"
  | "semantic-unknown-rescue";

export type TaskBoundaryMutationDisposition =
  | "commit-before-advisor"
  | "pending-incomplete-question"
  | "pending-low-authority"
  | "abstained-non-parent-type"
  | "abstained-non-boundary-relation"
  | "abstained-mutation-unauthorized";

export interface TaskBoundaryCandidate {
  id: string;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  currentQuestion: ProvisionalCurrentQuestion;
  settlement?: CurrentQuestionSettlementDecision;
  mutationAuthority: CurrentQuestionMutationAuthorityDecision;
  proposedQuestionType: CanonicalQuestionType;
  proposedRelation: InterviewTaskRelation;
  authoritySource: TaskBoundaryAuthoritySource;
  confidence: number;
  sourceTurnIds: string[];
  state: TaskBoundaryCandidateState;
  commitPolicy: TaskBoundaryCommitPolicy;
  mutationDisposition: TaskBoundaryMutationDisposition;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  committedAt?: number;
  committedParentId?: string;
}

export interface CreateTaskBoundaryCandidateInput {
  logicalQuestionUnit?: LogicalQuestionUnit;
  currentQuestion?: ProvisionalCurrentQuestion;
  settlement?: CurrentQuestionSettlementDecision;
  proposedQuestionType?: unknown;
  proposedRelation: InterviewTaskRelation;
  authoritySource: TaskBoundaryAuthoritySource;
  sourceKind?: CurrentQuestionSourceKind;
  sourceObservationIds?: string[];
  typeEvidenceAuthorized?: boolean;
  relationEvidenceAuthorized?: boolean;
  confidence?: number;
  questionComplete: boolean;
  mutationAuthorized: boolean;
  commitParent: boolean;
  now?: number;
}

export function createTaskBoundaryCandidate(
  input: CreateTaskBoundaryCandidateInput
): TaskBoundaryCandidate | undefined {
  const logicalQuestionUnit = input.logicalQuestionUnit;
  if (!logicalQuestionUnit) return undefined;
  if (
    input.settlement &&
    (!input.currentQuestion ||
      input.settlement.logicalQuestionUnitId !==
        input.currentQuestion.logicalQuestionUnitId ||
      input.settlement.revision !== input.currentQuestion.revision ||
      input.settlement.sessionId !== input.currentQuestion.sessionId ||
      input.settlement.runtimeEpoch !==
        input.currentQuestion.runtimeEpoch ||
      input.settlement.sourceHash !== input.currentQuestion.sourceHash)
  ) {
    return undefined;
  }

  const now = input.now ?? Date.now();
  const proposedQuestionType =
    normalizeCanonicalQuestionType(
      input.settlement?.questionType ?? input.proposedQuestionType
    ) ?? "unknown";
  const proposedRelation = normalizeBoundaryRelation(
    input.settlement?.relation ?? input.proposedRelation
  );
  const currentQuestion =
    input.currentQuestion ??
    createProvisionalCurrentQuestion({
      logicalQuestionUnit,
      sourceKind: input.sourceKind ?? "voice",
      sourceObservationIds: input.sourceObservationIds,
      now,
      expiresAt:
        input.questionComplete
          ? undefined
          : now + TASK_BOUNDARY_PENDING_TTL_MS,
    });
  const mutationAuthority = input.settlement
    ? mutationAuthorityFromSettlement(input.settlement)
    : decideCurrentQuestionMutationAuthority({
        currentQuestion,
        proposedQuestionType,
        proposedRelation,
        authoritySource: input.authoritySource,
        typeEvidenceAuthorized:
          input.typeEvidenceAuthorized ?? proposedQuestionType !== "unknown",
        relationEvidenceAuthorized:
          input.relationEvidenceAuthorized ?? proposedRelation !== "unknown",
        runtimeMutationAuthorized: input.mutationAuthorized,
        questionComplete: input.questionComplete,
        commitParent: input.commitParent,
      });
  const parentEligible = isParentCanonicalQuestionType(proposedQuestionType);
  const isBoundaryRelation = proposedRelation === "new-parent";
  const immediate =
    parentEligible &&
    isBoundaryRelation &&
    input.questionComplete &&
    mutationAuthority.parentMutationAuthorized;

  let mutationDisposition: TaskBoundaryMutationDisposition;
  if (
    proposedQuestionType === "unknown" &&
    !input.questionComplete
  ) {
    mutationDisposition = "pending-incomplete-question";
  } else if (!parentEligible) {
    mutationDisposition = "abstained-non-parent-type";
  } else if (
    proposedRelation === "unknown" &&
    !input.questionComplete
  ) {
    mutationDisposition = "pending-incomplete-question";
  } else if (!isBoundaryRelation) {
    mutationDisposition = "abstained-non-boundary-relation";
  } else if (!mutationAuthority.parentMutationAuthorized) {
    mutationDisposition = "abstained-mutation-unauthorized";
  } else if (!input.questionComplete) {
    mutationDisposition = "pending-incomplete-question";
  } else if (!immediate) {
    mutationDisposition = "pending-low-authority";
  } else {
    mutationDisposition = "commit-before-advisor";
  }

  const commitPolicy: TaskBoundaryCommitPolicy = immediate
    ? "immediate"
    : "await-adjacent-completion";

  return {
    id: createMeetingId("task_boundary"),
    sessionId: logicalQuestionUnit.sessionId,
    runtimeEpoch: logicalQuestionUnit.runtimeEpoch,
    logicalQuestionUnitId: logicalQuestionUnit.id,
    logicalQuestionUnitRevision: logicalQuestionUnit.revision,
    currentQuestion,
    settlement: input.settlement,
    mutationAuthority,
    proposedQuestionType,
    proposedRelation,
    authoritySource: input.authoritySource,
    confidence: clampConfidence(
      input.settlement?.confidence ?? input.confidence
    ),
    sourceTurnIds: [...logicalQuestionUnit.sourceTurnIds],
    state: "pending",
    commitPolicy,
    mutationDisposition,
    createdAt: now,
    updatedAt: now,
    expiresAt:
      commitPolicy === "await-adjacent-completion"
        ? now + TASK_BOUNDARY_PENDING_TTL_MS
        : undefined,
  };
}

export function commitTaskBoundaryCandidate(
  candidate: TaskBoundaryCandidate,
  parentId: string,
  now = Date.now()
): TaskBoundaryCandidate {
  return {
    ...candidate,
    state: "committed",
    mutationDisposition: "commit-before-advisor",
    updatedAt: now,
    expiresAt: undefined,
    committedAt: now,
    committedParentId: parentId,
  };
}

export function supersedeTaskBoundaryCandidate(
  candidate: TaskBoundaryCandidate,
  now = Date.now()
): TaskBoundaryCandidate {
  return {
    ...candidate,
    state: "superseded",
    updatedAt: now,
    expiresAt: undefined,
  };
}

export function expireTaskBoundaryCandidate(
  candidate: TaskBoundaryCandidate | undefined,
  now = Date.now()
): TaskBoundaryCandidate | undefined {
  if (
    !candidate ||
    candidate.state !== "pending" ||
    !candidate.expiresAt ||
    candidate.expiresAt > now
  ) {
    return candidate;
  }
  return {
    ...candidate,
    state: "expired",
    updatedAt: now,
    expiresAt: undefined,
  };
}

export function taskBoundarySurvivesAdvisorOutcome(
  candidate: TaskBoundaryCandidate | undefined,
  outcome: "cancelled" | "error" | "empty-output" | "success"
) {
  return Boolean(
    candidate &&
      candidate.state === "committed" &&
      outcome !== "success"
  );
}

export function formatTaskBoundaryCandidateForTrace(
  candidate: TaskBoundaryCandidate | undefined,
  extra: {
    committedBeforeAdvisor?: boolean;
    parentBeforeId?: string;
    parentBeforeType?: string;
    parentAfterId?: string;
    parentAfterType?: string;
    survivedAdvisorCancellation?: boolean;
  } = {}
): Record<string, unknown> {
  if (!candidate) return {};
  return {
    taskBoundaryCandidateId: candidate.id,
    taskBoundaryLogicalQuestionUnitId: candidate.logicalQuestionUnitId,
    taskBoundaryLogicalQuestionUnitRevision:
      candidate.logicalQuestionUnitRevision,
    taskBoundaryCandidateState: candidate.state,
    taskBoundaryCommitPolicy: candidate.commitPolicy,
    taskBoundaryMutationDisposition: candidate.mutationDisposition,
    taskBoundaryAuthoritySource: candidate.authoritySource,
    taskBoundaryConfidence: candidate.confidence,
    taskBoundarySourceTurnIds: candidate.sourceTurnIds,
    taskBoundaryCommittedBeforeAdvisor:
      extra.committedBeforeAdvisor ?? candidate.state === "committed",
    taskBoundaryCommittedParentId: candidate.committedParentId,
    taskBoundarySurvivedAdvisorCancellation:
      extra.survivedAdvisorCancellation ?? false,
    parentBeforeId: extra.parentBeforeId,
    parentBeforeType: extra.parentBeforeType,
    parentAfterId: extra.parentAfterId ?? candidate.committedParentId,
    parentAfterType: extra.parentAfterType,
    ...formatProvisionalCurrentQuestionForTrace(candidate.currentQuestion),
    ...formatCurrentQuestionMutationAuthorityForTrace(
      candidate.mutationAuthority
    ),
    ...formatCurrentQuestionSettlementForTrace(candidate.settlement),
  };
}

export function buildCommittedTaskBoundaryParent(input: {
  candidate: TaskBoundaryCandidate;
  logicalQuestionUnit: LogicalQuestionUnit;
  source: "screen" | "voice";
  questionInstanceId?: string;
  playbook?: SelectedInterviewPlaybook;
  phaseDecision?: PlaybookPhaseDecision;
  expiresAt?: number;
  parentContextHandoff?: ParentContextHandoff;
  now?: number;
}): ActiveInterviewParent | undefined {
  const stableKind = normalizeCanonicalQuestionType(
    input.candidate.proposedQuestionType
  );
  if (!stableKind || !isParentCanonicalQuestionType(stableKind)) {
    return undefined;
  }

  const now = input.now ?? Date.now();
  const parentId = createMeetingId("interview_parent");
  const phase =
    input.phaseDecision?.phase ?? input.playbook?.phase ?? "follow_up";
  const playbook = input.playbook
    ? { ...input.playbook, phase }
    : undefined;

  return {
    id: parentId,
    source: input.source,
    stableKind,
    topic:
      input.logicalQuestionUnit.normalizedText.trim() ||
      "Unknown interview task",
    playbook,
    playbookPhase: phase,
    phaseProgress: applyPlaybookPhaseDecisionToProgress(
      playbook?.phase ? { [playbook.phase]: true } : {},
      input.phaseDecision,
      playbook?.phase
    ),
    supportedFactAnchors: [],
    createdAt: now,
    updatedAt: now,
    expiresAt: input.expiresAt,
    originQuestionId: input.questionInstanceId,
    startTurnId: input.logicalQuestionUnit.sourceTurnIds[0],
    promptTranscriptStartTurnId: input.logicalQuestionUnit.sourceTurnIds[0],
    canonicalQuestionSourceTurnIds: [
      ...input.logicalQuestionUnit.sourceTurnIds,
    ],
    sourceQuestionUnitId: input.logicalQuestionUnit.id,
    sourceQuestionRevision: input.logicalQuestionUnit.revision,
    settlementId: input.candidate.settlement?.settlementId,
    parentContextHandoff: input.parentContextHandoff,
    revisions: 1,
  };
}

function normalizeBoundaryRelation(
  relation: CurrentQuestionSettlementDecision["relation"]
): InterviewTaskRelation {
  if (relation === "linked-parent-extension") return "new-parent";
  if (relation === "none") return "unknown";
  return relation;
}

function mutationAuthorityFromSettlement(
  settlement: CurrentQuestionSettlementDecision
): CurrentQuestionMutationAuthorityDecision {
  return {
    authority: settlement.authority,
    authoritySource: settlement.authoritySource,
    questionType: settlement.questionType,
    relation: settlement.relation,
    typeMutationAuthorized: settlement.typeMutationAuthorized,
    relationMutationAuthorized: settlement.relationMutationAuthorized,
    parentMutationAuthorized: settlement.parentMutationAuthorized,
    responseAuthorized: settlement.responseAuthorized,
    reasons: [...settlement.reasons],
  };
}

function clampConfidence(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
