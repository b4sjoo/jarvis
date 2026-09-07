import {
  toAnswerArtifactFamily,
  type AnswerArtifactSection,
  type AnswerGenerationLease,
  type RefreshAuthorityDecision,
  type RuntimeTypeAdjudicationOutputAuthority,
} from "./answer-generation-lease.js";
import type { EffectiveQuestionSourceOwner } from "./effective-question-source-ledger.js";
import {
  parseMeetingAnswer,
  serializeMeetingAnswer,
} from "./meeting-answer.js";
import type { ResponseArtifactMutationAuthorization } from "./response-artifact-authorization.js";
import type { SettledAdvisorArtifactIntent } from "./settled-advisor-execution-plan.js";
import { calculateWordEquivalent } from "./transcript-fusion.js";
import type {
  AdvisorSuggestion,
  ParsedMeetingAnswer,
  TranscriptTurn,
} from "./types.js";

export interface StableAnswerSectionRevision {
  revision: number;
  owner: EffectiveQuestionSourceOwner | null;
  sourceSuggestionId: string;
  updatedAt: number;
}

export type StableAnswerSectionOwner = EffectiveQuestionSourceOwner | null;

export type StableAnswerSettlementSnapshot = object;

export interface StableAnswerRevision {
  revision: number;
  sessionId?: string;
  runtimeEpoch?: number;
  taskId: string | null;
  logicalQuestionUnitId: string | null;
  logicalQuestionRevision: number | null;
  questionSourceHash?: string;
  settlementId?: string;
  settlementSnapshot?: StableAnswerSettlementSnapshot;
  suggestion: AdvisorSuggestion;
  sections: Record<AnswerArtifactSection, StableAnswerSectionRevision>;
  committedAt: number;
}

export interface AnswerDeliveryProgress {
  visibleAnswerRevision: number;
  taskId: string | null;
  wordEquivalent: number;
  continuousSpeechMs: number;
  answerTokenOverlap: number;
  lastMeTurnEndedAt: number;
  lockedAt?: number;
}

export type PendingAnswerDisposition =
  | "waiting-delivery"
  | "ready"
  | "stale"
  | "dropped"
  | "committed";

export interface PendingAnswerRevision {
  operationId: string;
  lease: AnswerGenerationLease;
  suggestion: AdvisorSuggestion;
  authorizedArtifacts: AnswerArtifactSection[];
  baseVisibleAnswerRevision: number;
  taskId: string | null;
  taskRevision: number | null;
  logicalQuestionUnitId: string | null;
  logicalQuestionRevision: number | null;
  sessionId?: string;
  runtimeEpoch?: number;
  questionSourceHash?: string;
  settlementId?: string;
  settlementSnapshot?: StableAnswerSettlementSnapshot;
  manualCorrectionRevision: number;
  responseActionRevision: number;
  queuedAt: number;
  expiresAt: number;
  disposition: PendingAnswerDisposition;
  reason: string;
  resetSections: boolean;
  latestUsefulAnswerMutationAuthorized: boolean;
  sectionOwner?: StableAnswerSectionOwner;
  advisorJobId?: string;
  advisorJobSource?: string;
  runtimeTypeAdjudicationOutputAuthority?: RuntimeTypeAdjudicationOutputAuthority;
}

export interface AnswerDeliveryPresentation {
  state: "idle" | "delivery-active" | "update-ready";
  visibleAnswerRevision: number;
  meSpokenWordEquivalent: number;
  meAnswerTokenOverlap: number;
  pendingOperationId?: string;
}

export interface StableAnswerCommitDecision {
  disposition: "committed" | "pending" | "rejected";
  reason:
    | "authorized"
    | "delivery-lock-active"
    | "empty-candidate"
    | "partial-candidate"
    | "candidate-not-published";
}

export interface StableAnswerMutationDelta {
  candidateMutatedArtifacts: AnswerArtifactSection[];
  lifecycleResetArtifacts: AnswerArtifactSection[];
}

export type ArtifactOnlyAnswerSection = Exclude<
  AnswerArtifactSection,
  "answer"
>;

export type StableArtifactOnlyCommitReason =
  | "authorized"
  | "visible-answer-missing"
  | "visible-answer-revision-mismatch"
  | "task-owner-mismatch"
  | "logical-question-mismatch"
  | "logical-question-revision-mismatch"
  | "settlement-mismatch"
  | "unsupported-artifact-family"
  | "artifact-section-owner-mismatch"
  | "artifact-candidate-missing"
  | "artifact-candidate-invalid"
  | "artifact-candidate-no-change"
  | "canonical-parent-commit-rejected";

export interface StableArtifactOnlyCommitDecision {
  disposition: "committed" | "rejected";
  reason: StableArtifactOnlyCommitReason;
  stable?: StableAnswerRevision;
  authorizedArtifacts: ArtifactOnlyAnswerSection[];
  mutatedArtifacts: ArtifactOnlyAnswerSection[];
}

export function formatStableArtifactOnlyCommitForTrace(
  decision: StableArtifactOnlyCommitDecision | undefined
) {
  return {
    artifactOnlyCommitDisposition: decision?.disposition,
    artifactOnlyCommitReason: decision?.reason,
    artifactOnlyAuthorizedArtifacts: decision?.authorizedArtifacts,
    artifactOnlyMutatedArtifacts: decision?.mutatedArtifacts,
    artifactOnlyAnswerSectionRevision:
      decision?.stable?.sections.answer.revision,
    artifactOnlyCodeSectionRevision:
      decision?.stable?.sections.code.revision,
    artifactOnlyComplexitySectionRevision:
      decision?.stable?.sections.complexity.revision,
    artifactOnlyWhiteboardSectionRevision:
      decision?.stable?.sections.whiteboard.revision,
  };
}

const ANSWER_DELIVERY_MIN_WORD_EQUIVALENT = 18;
const ANSWER_DELIVERY_MIN_DURATION_MS = 6_000;
const ANSWER_DELIVERY_MIN_TOKEN_OVERLAP = 8;
export const ANSWER_DELIVERY_IDLE_RELEASE_MS = 1_800;
export const PENDING_ANSWER_TTL_MS = 30_000;

const ANSWER_GROUP_KEYS = [
  "chineseThinking",
  "question",
  "answer",
  "approach",
  "clarifyingQuestion",
] as const;

export function resolveAuthorizedAnswerArtifacts(input: {
  artifactPolicy: ResponseArtifactMutationAuthorization;
  artifactIntent: SettledAdvisorArtifactIntent;
}): AnswerArtifactSection[] {
  const authorized: AnswerArtifactSection[] = ["answer"];
  const codeFamilyRevision =
    input.artifactIntent === "revise-code" ||
    input.artifactIntent === "revise-complexity";
  if (codeFamilyRevision && input.artifactPolicy.allowCode) {
    authorized.push("code");
  }
  if (codeFamilyRevision && input.artifactPolicy.allowComplexity) {
    authorized.push("complexity");
  }
  if (
    input.artifactIntent === "revise-whiteboard" &&
    input.artifactPolicy.allowWhiteboard
  ) {
    authorized.push("whiteboard");
  }
  return authorized;
}

export function commitStableAnswerRevision(input: {
  current?: StableAnswerRevision | null;
  candidate: AdvisorSuggestion;
  authorizedArtifacts: AnswerArtifactSection[];
  taskId: string | null;
  logicalQuestionUnitId: string | null;
  logicalQuestionRevision: number | null;
  sessionId?: string;
  runtimeEpoch?: number;
  questionSourceHash?: string;
  settlementId?: string;
  settlementSnapshot?: StableAnswerSettlementSnapshot;
  sectionOwner?: StableAnswerSectionOwner;
  resetSections?: boolean;
  revision?: number;
  committedAt?: number;
}): StableAnswerRevision | null {
  const candidateAnswer = input.candidate.meetingAnswer;
  if (
    !candidateAnswer ||
    candidateAnswer.parseStatus === "empty" ||
    !input.candidate.content.trim()
  ) {
    return null;
  }
  if (candidateAnswer.parseStatus === "partial") return null;

  const now = input.committedAt ?? Date.now();
  const current =
    input.resetSections || input.current?.taskId !== input.taskId
      ? undefined
      : input.current ?? undefined;
  const authorized = new Set(input.authorizedArtifacts);
  const sectionOwner = normalizeStableAnswerSectionOwner(
    input.sectionOwner,
    input.taskId
  );
  const mergedAnswer = mergeParsedAnswer({
    current: current?.suggestion.meetingAnswer,
    candidate: candidateAnswer,
    authorized,
  });
  const content = serializeMeetingAnswer(mergedAnswer);
  const parsed = parseMeetingAnswer(content, {
    expectedProfile: candidateAnswer.profile ?? current?.suggestion.answerProfile,
    now,
  });
  const revision = input.revision ?? (input.current?.revision ?? 0) + 1;
  const settlementSnapshot = input.settlementSnapshot
    ? cloneSettlementSnapshot(input.settlementSnapshot)
    : current?.logicalQuestionUnitId === input.logicalQuestionUnitId &&
        current.logicalQuestionRevision === input.logicalQuestionRevision
      ? current.settlementSnapshot
      : undefined;
  const sectionRevisions = {} as Record<
    AnswerArtifactSection,
    StableAnswerSectionRevision
  >;
  for (const section of [
    "answer",
    "code",
    "complexity",
    "whiteboard",
  ] as const) {
    const previous = current?.sections[section];
    const mutated = sectionWasMutated({
      section,
      current: current?.suggestion.meetingAnswer,
      candidate: candidateAnswer,
      merged: parsed,
      authorized,
    });
    sectionRevisions[section] = mutated
      ? {
          revision: (previous?.revision ?? 0) + 1,
          owner: hasStableAnswerSectionContent(parsed, section)
            ? cloneStableAnswerSectionOwner(sectionOwner)
            : null,
          sourceSuggestionId: input.candidate.id,
          updatedAt: now,
        }
      : previous ?? {
          revision: 0,
          owner: null,
          sourceSuggestionId: input.candidate.id,
          updatedAt: now,
        };
  }

  return {
    revision,
    sessionId: input.sessionId ?? current?.sessionId,
    runtimeEpoch: input.runtimeEpoch ?? current?.runtimeEpoch,
    taskId: input.taskId,
    logicalQuestionUnitId: input.logicalQuestionUnitId,
    logicalQuestionRevision: input.logicalQuestionRevision,
    questionSourceHash:
      input.questionSourceHash ?? current?.questionSourceHash,
    settlementId: input.settlementId ?? current?.settlementId,
    settlementSnapshot,
    suggestion: {
      ...input.candidate,
      content,
      meetingAnswer: parsed,
      answerProfile: parsed.profile,
      codeArtifactMutationAuthorized: authorized.has("code"),
      complexityArtifactMutationAuthorized: authorized.has("complexity"),
      whiteboardArtifactMutationAuthorized: authorized.has("whiteboard"),
      codeArtifactRevision: sectionRevisions.code.revision,
      complexityArtifactRevision:
        sectionRevisions.complexity.revision,
    },
    sections: sectionRevisions,
    committedAt: now,
  };
}

export function commitStableArtifactOnlyRevision(input: {
  current?: StableAnswerRevision | null;
  candidate: AdvisorSuggestion;
  authorizedArtifacts: ArtifactOnlyAnswerSection[];
  expectedVisibleAnswerRevision: number;
  expectedTaskId: string | null;
  expectedLogicalQuestionUnitId: string | null;
  expectedLogicalQuestionRevision: number | null;
  expectedSettlementId?: string;
  sectionOwner?: StableAnswerSectionOwner;
  committedAt?: number;
}): StableArtifactOnlyCommitDecision {
  const authorizedArtifacts = Array.from(
    new Set(input.authorizedArtifacts)
  );
  const reject = (
    reason: StableArtifactOnlyCommitReason
  ): StableArtifactOnlyCommitDecision => ({
    disposition: "rejected",
    reason,
    authorizedArtifacts,
    mutatedArtifacts: [],
  });
  const current = input.current;
  if (!current) return reject("visible-answer-missing");
  if (current.revision !== input.expectedVisibleAnswerRevision) {
    return reject("visible-answer-revision-mismatch");
  }
  if (current.taskId !== input.expectedTaskId) {
    return reject("task-owner-mismatch");
  }
  if (current.logicalQuestionUnitId !== input.expectedLogicalQuestionUnitId) {
    return reject("logical-question-mismatch");
  }
  if (
    current.logicalQuestionRevision !==
    input.expectedLogicalQuestionRevision
  ) {
    return reject("logical-question-revision-mismatch");
  }
  if (
    input.expectedSettlementId &&
    current.settlementId !== input.expectedSettlementId
  ) {
    return reject("settlement-mismatch");
  }

  const requested = new Set(authorizedArtifacts);
  const codeFamily = requested.has("code") || requested.has("complexity");
  const whiteboardFamily = requested.has("whiteboard");
  if (
    authorizedArtifacts.length === 0 ||
    (codeFamily && whiteboardFamily) ||
    (codeFamily &&
      (!requested.has("code") || !requested.has("complexity")))
  ) {
    return reject("unsupported-artifact-family");
  }
  if (
    input.sectionOwner &&
    !stableArtifactSectionsBelongToOwner({
      stable: current,
      sections: authorizedArtifacts,
      owner: input.sectionOwner,
    })
  ) {
    return reject("artifact-section-owner-mismatch");
  }
  const candidateAnswer = input.candidate.meetingAnswer;
  if (
    !candidateAnswer ||
    candidateAnswer.parseStatus === "empty" ||
    candidateAnswer.parseStatus === "partial" ||
    !input.candidate.content.trim()
  ) {
    return reject("artifact-candidate-invalid");
  }
  if (
    (whiteboardFamily && !candidateAnswer.sections.whiteboard?.trim()) ||
    (codeFamily &&
      (!candidateAnswer.sections.code?.trim() ||
        !candidateAnswer.sections.complexity?.trim()))
  ) {
    return reject("artifact-candidate-missing");
  }

  const stable = commitStableAnswerRevision({
    current,
    candidate: input.candidate,
    authorizedArtifacts,
    taskId: current.taskId,
    logicalQuestionUnitId: current.logicalQuestionUnitId,
    logicalQuestionRevision: current.logicalQuestionRevision,
    sessionId: current.sessionId,
    runtimeEpoch: current.runtimeEpoch,
    questionSourceHash: current.questionSourceHash,
    settlementId: current.settlementId,
    settlementSnapshot: current.settlementSnapshot,
    sectionOwner: input.sectionOwner,
    revision: current.revision + 1,
    committedAt: input.committedAt,
  });
  if (!stable) return reject("artifact-candidate-invalid");
  const mutatedArtifacts = collectStableAnswerMutatedArtifacts(
    current,
    stable
  ).filter(
    (artifact): artifact is ArtifactOnlyAnswerSection =>
      artifact !== "answer"
  );
  if (mutatedArtifacts.length === 0) {
    return reject("artifact-candidate-no-change");
  }
  return {
    disposition: "committed",
    reason: "authorized",
    stable,
    authorizedArtifacts,
    mutatedArtifacts,
  };
}

function normalizeStableAnswerSectionOwner(
  owner: StableAnswerSectionOwner | undefined,
  taskId: string | null
): StableAnswerSectionOwner {
  if (owner) return cloneStableAnswerSectionOwner(owner);
  return taskId
    ? { kind: "parent-mainline", parentId: taskId }
    : null;
}

function cloneStableAnswerSectionOwner(
  owner: StableAnswerSectionOwner
): StableAnswerSectionOwner {
  return owner ? { ...owner } : null;
}

function hasStableAnswerSectionContent(
  answer: ParsedMeetingAnswer,
  section: AnswerArtifactSection
) {
  return Boolean(answer.sections[section]?.trim());
}

function stableArtifactSectionsBelongToOwner(input: {
  stable: StableAnswerRevision;
  sections: ArtifactOnlyAnswerSection[];
  owner: EffectiveQuestionSourceOwner;
}) {
  return input.sections.every((section) => {
    const content = input.stable.suggestion.meetingAnswer?.sections[section];
    if (!content?.trim()) return true;
    return sameStableAnswerSectionOwner(
      input.stable.sections[section]?.owner,
      input.owner
    );
  });
}

export function sameStableAnswerSectionOwner(
  left: StableAnswerSectionOwner | undefined,
  right: StableAnswerSectionOwner | undefined
) {
  if (!left || !right) return left === right;
  return left.kind === right.kind && left.parentId === right.parentId &&
    (left.kind === "parent-mainline" ||
      (right.kind === "active-child" && left.childId === right.childId));
}

function cloneSettlementSnapshot(
  settlement: StableAnswerSettlementSnapshot
): StableAnswerSettlementSnapshot {
  return structuredClone(settlement);
}

export function collectStableAnswerMutatedArtifacts(
  current: StableAnswerRevision | null | undefined,
  candidate: StableAnswerRevision | null | undefined,
  options: { resetSections?: boolean } = {}
): AnswerArtifactSection[] {
  return collectStableAnswerMutationDelta(
    current,
    candidate,
    options
  ).candidateMutatedArtifacts;
}

export function collectStableAnswerMutationDelta(
  current: StableAnswerRevision | null | undefined,
  candidate: StableAnswerRevision | null | undefined,
  options: { resetSections?: boolean } = {}
): StableAnswerMutationDelta {
  if (!candidate) {
    return {
      candidateMutatedArtifacts: [],
      lifecycleResetArtifacts: [],
    };
  }

  const artifacts = [
    "answer",
    "code",
    "complexity",
    "whiteboard",
  ] as const;
  const ownerChanged = current?.taskId !== candidate.taskId;
  if (!current || ownerChanged || options.resetSections) {
    return {
      candidateMutatedArtifacts: artifacts.filter(
        (artifact) => candidate.sections[artifact].revision > 0
      ),
      lifecycleResetArtifacts: current
        ? artifacts.filter(
            (artifact) =>
              current.sections[artifact].revision > 0 &&
              candidate.sections[artifact].revision === 0
          )
        : [],
    };
  }

  return {
    candidateMutatedArtifacts: artifacts.filter(
      (artifact) =>
        candidate.sections[artifact].revision !==
        current.sections[artifact].revision
    ),
    lifecycleResetArtifacts: [],
  };
}

export function updateAnswerDeliveryProgress(input: {
  current?: AnswerDeliveryProgress | null;
  stable: StableAnswerRevision;
  turn: TranscriptTurn;
  now?: number;
}): AnswerDeliveryProgress {
  const now = input.now ?? Date.now();
  const current =
    input.current?.visibleAnswerRevision === input.stable.revision &&
    input.current.taskId === input.stable.taskId
      ? input.current
      : undefined;
  const gapMs = current
    ? Math.max(0, input.turn.startedAt - current.lastMeTurnEndedAt)
    : Number.POSITIVE_INFINITY;
  const continuesDelivery = gapMs <= 4_000;
  const wordEquivalent =
    (continuesDelivery ? current?.wordEquivalent ?? 0 : 0) +
    calculateWordEquivalent(input.turn.text);
  const continuousSpeechMs =
    (continuesDelivery ? current?.continuousSpeechMs ?? 0 : 0) +
    Math.max(0, input.turn.endedAt - input.turn.startedAt);
  const answerTokenOverlap = countTokenOverlap(
    input.turn.text,
    input.stable.suggestion.meetingAnswer?.sections.answer ?? ""
  );
  const cumulativeOverlap =
    (continuesDelivery ? current?.answerTokenOverlap ?? 0 : 0) +
    answerTokenOverlap;
  const locked =
    cumulativeOverlap >= ANSWER_DELIVERY_MIN_TOKEN_OVERLAP &&
    (wordEquivalent >= ANSWER_DELIVERY_MIN_WORD_EQUIVALENT ||
      continuousSpeechMs >= ANSWER_DELIVERY_MIN_DURATION_MS);

  return {
    visibleAnswerRevision: input.stable.revision,
    taskId: input.stable.taskId,
    wordEquivalent,
    continuousSpeechMs,
    answerTokenOverlap: cumulativeOverlap,
    lastMeTurnEndedAt: input.turn.endedAt,
    lockedAt: locked ? current?.lockedAt ?? now : undefined,
  };
}

export function isAnswerDeliveryLockActive(
  progress: AnswerDeliveryProgress | null | undefined,
  input: {
    visibleAnswerRevision: number;
    taskId: string | null;
    now?: number;
    microphoneSpeaking?: boolean;
  }
) {
  if (!progress?.lockedAt) return false;
  if (progress.visibleAnswerRevision !== input.visibleAnswerRevision) {
    return false;
  }
  if (progress.taskId !== input.taskId) return false;
  if (input.microphoneSpeaking) return true;
  return (
    (input.now ?? Date.now()) - progress.lastMeTurnEndedAt <
    ANSWER_DELIVERY_IDLE_RELEASE_MS
  );
}

export interface AnswerDeliverySwitchDecision {
  allowed: boolean;
  reason:
    | "delivery-unlocked"
    | "delivery-hard-override"
    | "delivery-same-generation-continuity"
    | "delivery-lock-active";
}

export function decideAnswerDeliverySwitch(input: {
  deliveryLockActive: boolean;
  hardOverride: boolean;
  sameGenerationVisible?: boolean;
}): AnswerDeliverySwitchDecision {
  if (!input.deliveryLockActive) {
    return { allowed: true, reason: "delivery-unlocked" };
  }
  if (input.hardOverride) {
    return { allowed: true, reason: "delivery-hard-override" };
  }
  if (input.sameGenerationVisible) {
    return {
      allowed: true,
      reason: "delivery-same-generation-continuity",
    };
  }
  return { allowed: false, reason: "delivery-lock-active" };
}

export function decideStableAnswerCommit(input: {
  candidate: AdvisorSuggestion;
  refreshAuthority: RefreshAuthorityDecision;
  deliveryLockActive: boolean;
  sameGenerationVisible?: boolean;
}): StableAnswerCommitDecision {
  if (!input.candidate.content.trim() || input.candidate.kind === "silent") {
    return { disposition: "rejected", reason: "empty-candidate" };
  }
  if (input.candidate.meetingAnswer?.parseStatus === "partial") {
    return { disposition: "rejected", reason: "partial-candidate" };
  }
  const deliverySwitch = decideAnswerDeliverySwitch({
    deliveryLockActive: input.deliveryLockActive,
    hardOverride: input.refreshAuthority.hardOverride,
    sameGenerationVisible: input.sameGenerationVisible,
  });
  if (!deliverySwitch.allowed) {
    return { disposition: "pending", reason: "delivery-lock-active" };
  }
  return { disposition: "committed", reason: "authorized" };
}

export function formatStableAnswerCommitForTrace(input: {
  stable?: StableAnswerRevision | null;
  pending?: PendingAnswerRevision | null;
  progress?: AnswerDeliveryProgress | null;
  decision: StableAnswerCommitDecision;
  authorizedArtifacts: AnswerArtifactSection[];
  requestedArtifacts?: AnswerArtifactSection[];
  candidateMutatedArtifacts?: AnswerArtifactSection[];
  lifecycleResetArtifacts?: AnswerArtifactSection[];
  previousCommittedAt?: number;
  now?: number;
}) {
  const now = input.now ?? Date.now();
  const requested = input.requestedArtifacts ?? [];
  const publicationProduced = Boolean(input.stable || input.pending);
  const effectiveDecision: StableAnswerCommitDecision =
    input.decision.disposition === "committed" && !publicationProduced
      ? {
          disposition: "rejected",
          reason: "candidate-not-published",
        }
      : input.decision;
  const candidateMutations =
    input.candidateMutatedArtifacts ?? requested;
  const authorizedFamilies = new Set(
    input.authorizedArtifacts.map(toAnswerArtifactFamily)
  );
  return {
    stableAnswerCommitDisposition: effectiveDecision.disposition,
    stableAnswerCommitReason: effectiveDecision.reason,
    answerDeliveryLockState: input.progress?.lockedAt
      ? input.pending
        ? "update-ready"
        : "delivery-active"
      : "idle",
    meSpokenWordEquivalent: input.progress?.wordEquivalent ?? 0,
    meAnswerTokenOverlap: input.progress?.answerTokenOverlap ?? 0,
    pendingAnswerDisposition: input.pending?.disposition,
    pendingAnswerOperationId: input.pending?.operationId,
    requestedArtifacts: requested,
    authorizedArtifacts: input.authorizedArtifacts,
    candidateMutatedArtifacts: candidateMutations,
    committedArtifacts: input.stable ? candidateMutations : [],
    lifecycleResetArtifacts: input.lifecycleResetArtifacts ?? [],
    artifactMutationRejectedReasons: candidateMutations
      .filter(
        (artifact) =>
          !authorizedFamilies.has(toAnswerArtifactFamily(artifact))
      )
      .map((artifact) => `${artifact}:not-authorized`),
    stableAnswerRevision: input.stable?.revision,
    answerSectionRevision: input.stable?.sections.answer.revision,
    answerSectionOwnerKind: input.stable?.sections.answer.owner?.kind,
    answerSectionOwnerParentId:
      input.stable?.sections.answer.owner?.parentId,
    answerSectionOwnerChildId:
      input.stable?.sections.answer.owner?.kind === "active-child"
        ? input.stable.sections.answer.owner.childId
        : undefined,
    codeSectionRevision: input.stable?.sections.code.revision,
    codeSectionOwnerKind: input.stable?.sections.code.owner?.kind,
    codeSectionOwnerParentId: input.stable?.sections.code.owner?.parentId,
    codeSectionOwnerChildId:
      input.stable?.sections.code.owner?.kind === "active-child"
        ? input.stable.sections.code.owner.childId
        : undefined,
    complexitySectionRevision: input.stable?.sections.complexity.revision,
    complexitySectionOwnerKind: input.stable?.sections.complexity.owner?.kind,
    complexitySectionOwnerParentId:
      input.stable?.sections.complexity.owner?.parentId,
    complexitySectionOwnerChildId:
      input.stable?.sections.complexity.owner?.kind === "active-child"
        ? input.stable.sections.complexity.owner.childId
        : undefined,
    whiteboardSectionRevision: input.stable?.sections.whiteboard.revision,
    whiteboardSectionOwnerKind: input.stable?.sections.whiteboard.owner?.kind,
    whiteboardSectionOwnerParentId:
      input.stable?.sections.whiteboard.owner?.parentId,
    whiteboardSectionOwnerChildId:
      input.stable?.sections.whiteboard.owner?.kind === "active-child"
        ? input.stable.sections.whiteboard.owner.childId
        : undefined,
    answerDwellMs: input.previousCommittedAt
      ? Math.max(0, now - input.previousCommittedAt)
      : undefined,
  };
}

export function toAnswerDeliveryPresentation(input: {
  progress?: AnswerDeliveryProgress | null;
  pending?: PendingAnswerRevision | null;
  visibleAnswerRevision: number;
}): AnswerDeliveryPresentation {
  return {
    state: input.pending
      ? "update-ready"
      : input.progress?.lockedAt
        ? "delivery-active"
        : "idle",
    visibleAnswerRevision: input.visibleAnswerRevision,
    meSpokenWordEquivalent: input.progress?.wordEquivalent ?? 0,
    meAnswerTokenOverlap: input.progress?.answerTokenOverlap ?? 0,
    pendingOperationId: input.pending?.operationId,
  };
}

function sectionWasMutated(input: {
  section: AnswerArtifactSection;
  current?: ParsedMeetingAnswer;
  candidate: ParsedMeetingAnswer;
  merged: ParsedMeetingAnswer;
  authorized: Set<AnswerArtifactSection>;
}) {
  if (!input.authorized.has(input.section)) return false;

  if (input.section === "answer") {
    return ANSWER_GROUP_KEYS.some(
      (key) =>
        (input.current?.sections[key] ?? "") !==
        (input.merged.sections[key] ?? "")
    ) ||
      JSON.stringify(input.current?.sections.clarifyingOptions ?? []) !==
        JSON.stringify(input.merged.sections.clarifyingOptions ?? []) ||
      input.current?.answerDisposition !== input.merged.answerDisposition ||
      JSON.stringify(input.current?.supportingAnchorIds ?? []) !==
        JSON.stringify(input.merged.supportingAnchorIds ?? []);
  }

  const candidateValue = input.candidate.sections[input.section]?.trim();
  if (!candidateValue) return false;
  return (
    (input.current?.sections[input.section]?.trim() ?? "") !==
    (input.merged.sections[input.section]?.trim() ?? "")
  );
}

function mergeParsedAnswer(input: {
  current?: ParsedMeetingAnswer;
  candidate: ParsedMeetingAnswer;
  authorized: Set<AnswerArtifactSection>;
}): ParsedMeetingAnswer {
  const baseSections = input.current?.sections ?? { clarifyingOptions: [] };
  const candidateSections = input.candidate.sections;
  const sections = {
    ...baseSections,
    clarifyingOptions: [...(baseSections.clarifyingOptions ?? [])],
  };

  if (input.authorized.has("answer")) {
    for (const key of ANSWER_GROUP_KEYS) {
      sections[key] = candidateSections[key];
    }
    sections.clarifyingOptions = [
      ...(candidateSections.clarifyingOptions ?? []),
    ];
  }
  if (input.authorized.has("code") && candidateSections.code?.trim()) {
    sections.code = candidateSections.code;
  }
  if (
    input.authorized.has("complexity") &&
    candidateSections.complexity?.trim()
  ) {
    sections.complexity = candidateSections.complexity;
  }
  if (
    input.authorized.has("whiteboard") &&
    candidateSections.whiteboard?.trim()
  ) {
    sections.whiteboard = candidateSections.whiteboard;
  }

  return {
    ...(input.current ?? input.candidate),
    ...input.candidate,
    sections,
    answerDisposition: input.authorized.has("answer")
      ? input.candidate.answerDisposition
      : input.current?.answerDisposition,
    supportingAnchorIds: input.authorized.has("answer")
      ? [...input.candidate.supportingAnchorIds]
      : [...(input.current?.supportingAnchorIds ?? [])],
  };
}

function countTokenOverlap(left: string, right: string) {
  const rightTokens = new Set(tokenize(right));
  return tokenize(left).filter((token) => rightTokens.has(token)).length;
}

function tokenize(value: string) {
  return value
    .toLowerCase()
    .match(/[a-z0-9]+|[\u4e00-\u9fff]/g) ?? [];
}
