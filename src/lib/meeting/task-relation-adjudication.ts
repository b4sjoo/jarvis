import type { ActiveMeetingTask } from "./active-meeting-task.js";
import {
  createCurrentQuestionSourceSettlementId,
  settleCurrentQuestion,
  type CurrentQuestionSettlementDecision,
  type CurrentQuestionSettlementProposal,
  type ProvisionalCurrentQuestion,
} from "./current-question-settlement.js";
import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import type { RuntimeInferenceRuntimeJob } from "./runtime-inference-runtime.js";
import { projectPrimaryAsk } from "./primary-ask-projection.js";
import {
  hashTaxonomySourceTurnIds,
  projectLogicalQuestionForAdjudication,
  type TaxonomyAdjudicationLease,
  type TaxonomyAdjudicationProjection,
} from "./taxonomy-adjudication.js";
import { hasConstraintOrCorrectionSignal } from "./transcript-fusion.js";
import {
  isParentCanonicalQuestionType,
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";
import type {
  MeetingTaskRelationAdjudicationMode,
  TranscriptTurn,
} from "./types.js";

export const TASK_RELATION_ADJUDICATION_SCHEMA_VERSION = 3;
export const LEGACY_TASK_RELATION_ADJUDICATION_SCHEMA_VERSION = 2;
export const TASK_RELATION_ADJUDICATION_PROMPT_VERSION =
  "task-relation-adjudication-v3-direct";
export const TASK_RELATION_ADJUDICATION_MAX_OUTPUT_CHARS = 4_096;
export const TASK_RELATION_ADJUDICATION_MAX_PARENT_CHARS = 480;
export const TASK_RELATION_ADJUDICATION_MAX_SOURCE_EVIDENCE_CHARS = 720;
export const SCREEN_RELATION_RELEASE_MIN_CONFIDENCE = 0.95;
export const VOICE_RELATION_RELEASE_MIN_CONFIDENCE = 0.95;
export const SCREEN_RELATION_RELEASE_ADMISSION_WAIT_BUDGET_MS = 500;
export const SCREEN_RELATION_RELEASE_WAIT_BUDGET_MS = 1_500;

export const RUNTIME_TASK_RELATIONS = [
  "new-parent",
  "followup-parent",
  "child-probe",
  "resume-parent",
  "unknown",
] as const;

export type RuntimeTaskRelation =
  (typeof RUNTIME_TASK_RELATIONS)[number];

export const TASK_RELATION_DEPENDENCIES = [
  "parent-dependent",
  "parent-independent",
  "unclear",
] as const;

export type TaskRelationDependency =
  (typeof TASK_RELATION_DEPENDENCIES)[number];

export const TASK_RELATION_CONTINUATION_SHAPES = [
  "mainline",
  "bounded-detour",
  "unclear",
] as const;

export type TaskRelationContinuationShape =
  (typeof TASK_RELATION_CONTINUATION_SHAPES)[number];

export const TASK_RELATION_RETURN_INTENTS = [
  "resume-suspended-parent",
  "no-resume",
  "unclear",
] as const;

export type TaskRelationReturnIntent =
  (typeof TASK_RELATION_RETURN_INTENTS)[number];

export const TASK_RELATION_SWITCH_INTENTS = [
  "explicit-switch",
  "no-explicit-switch",
  "unclear",
] as const;

export type TaskRelationSwitchIntent =
  (typeof TASK_RELATION_SWITCH_INTENTS)[number];

export const TASK_RELATION_STANDALONE_SUFFICIENCIES = [
  "sufficient",
  "insufficient",
  "unclear",
] as const;

export type TaskRelationStandaloneSufficiency =
  (typeof TASK_RELATION_STANDALONE_SUFFICIENCIES)[number];

export interface TaskRelationParentCapsule {
  parentId: string;
  revision: number;
  topic: string;
  compactObjective: string;
  sourceTurnIds: string[];
  acceptedConstraints: TaskRelationSourceEvidence[];
  sharedScenarioEntities: string[];
}

export interface TaskRelationChildCapsule {
  childId: string;
  question: string;
  sourceTurnIds: string[];
}

export type TaskRelationSourceEvidenceRole =
  | "question"
  | "constraint"
  | "transition";

export interface TaskRelationSourceEvidence {
  turnId: string;
  text: string;
  role?: TaskRelationSourceEvidenceRole;
  selectionReason: "role-hint" | "raw-recent-turn";
  sourceScope:
    | "parent-scope"
    | "cross-boundary-prior-turn"
    | "current-source-fallback";
}

export interface TaskRelationRecentEvidenceDiagnostics {
  eligiblePriorTurnCount: number;
  selectedTurnCount: number;
  rawFallbackCount: number;
  falseEmpty: boolean;
  emptyReason?: "no-prior-source-turn";
  parentBoundaryFound: boolean;
  parentScopedSelectedCount: number;
  crossBoundarySelectedCount: number;
  currentSourceFallbackCount: number;
}

export interface TaskRelationTransitionEvidence {
  turnId: string;
  text: string;
}

export interface TaskRelationAdjudicationRequest {
  schemaVersion: typeof TASK_RELATION_ADJUDICATION_SCHEMA_VERSION;
  promptVersion: string;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  sourceSettlementId: string;
  sourceHash: string;
  currentQuestion: TaxonomyAdjudicationProjection;
  activeParent: TaskRelationParentCapsule;
  activeChild?: TaskRelationChildCapsule;
  recentSourceEvidence: TaskRelationSourceEvidence[];
  recentTransitions: TaskRelationTransitionEvidence[];
  recentEvidenceDiagnostics: TaskRelationRecentEvidenceDiagnostics;
  suspendedParent?: TaskRelationParentCapsule;
}

export interface TaskRelationAdjudicationJob
  extends RuntimeInferenceRuntimeJob {
  traceId: string;
  lease: TaxonomyAdjudicationLease;
  request: TaskRelationAdjudicationRequest;
  triggerReasons: string[];
}

export interface LlmTaskRelationAdjudication {
  schemaVersion:
    | typeof TASK_RELATION_ADJUDICATION_SCHEMA_VERSION
    | typeof LEGACY_TASK_RELATION_ADJUDICATION_SCHEMA_VERSION;
  relation: RuntimeTaskRelation;
  dependency?: TaskRelationDependency;
  continuationShape?: TaskRelationContinuationShape;
  returnIntent?: TaskRelationReturnIntent;
  switchIntent?: TaskRelationSwitchIntent;
  standaloneSufficiency?: TaskRelationStandaloneSufficiency;
  confidence: number;
  currentQuestionEvidenceSpans: string[];
  parentEvidenceSpans: string[];
  explicitBinding?: boolean;
  standalone?: boolean;
  ambiguityReason?: string;
}

export type TaskRelationAdjudicationParseResult =
  | {
      ok: true;
      value: LlmTaskRelationAdjudication;
      evidenceSpansValid: true;
      schemaAliasApplied: boolean;
      schemaAliasSourceField?: "parentEvidenceSpan";
      schemaAliasCanonicalField?: "parentEvidenceSpans";
    }
  | {
      ok: false;
      reason: string;
      errorKind: "parse" | "schema" | "evidence" | "provider";
      evidenceSpansValid: boolean;
      schemaAliasApplied?: false;
    };

export interface TaskRelationAdjudicationEligibilityDecision {
  eligible: boolean;
  reason: string;
  triggerReasons: string[];
  auditKind?:
    | "unresolved-proposal"
    | "deterministic-comparison"
    | "screen-release-candidate"
    | "voice-release-candidate";
}

export type NarrowScreenRelationReleaseReason =
  | "eligible-awaiting-candidate"
  | "authorized"
  | "source-is-not-manual-screen"
  | "screen-boundary-prior-missing"
  | "active-parent-missing"
  | "current-type-not-parent-eligible"
  | "screen-type-evidence-not-authorized"
  | "screen-type-source-not-authoritative"
  | "screen-type-confidence-below-threshold"
  | "question-incomplete"
  | "manual-correction-active"
  | "active-child-conflict"
  | "candidate-missing"
  | "operation-lease-not-authorized"
  | "release-window-closed"
  | "candidate-confidence-below-threshold"
  | "candidate-relation-not-new-parent"
  | "candidate-followup-parent-evidence-missing";

export interface NarrowScreenRelationReleaseDecision {
  requested: boolean;
  authorized: boolean;
  reason: NarrowScreenRelationReleaseReason;
  currentQuestionType: CanonicalQuestionType;
  activeParentQuestionType: CanonicalQuestionType;
  typeConfidence: number;
  relationConfidence: number;
  minimumConfidence: number;
  releasedRelation?: "new-parent" | "followup-parent";
}

export interface NarrowScreenRelationReleaseInput {
  sourceKind: "voice" | "screen" | "mixed";
  screenBoundaryPrior: boolean;
  currentQuestionType: unknown;
  activeParentQuestionType: unknown;
  typeAuthoritySource?: string;
  typeEvidenceAuthorized: boolean;
  typeConfidence?: number;
  questionComplete: boolean;
  manualCorrectionActive: boolean;
  hasActiveChild: boolean;
  operationLeaseAuthorized?: boolean;
  releaseWindowOpen?: boolean;
  candidate?: LlmTaskRelationAdjudication;
}

export interface TaskRelationAdjudicationRuntimeOutcome {
  disposition: string;
  candidate?: LlmTaskRelationAdjudication;
  settlement?: CurrentQuestionSettlementDecision;
  operationId?: string;
  operationLeaseAuthorized: boolean;
  narrowScreenRelease: NarrowScreenRelationReleaseDecision;
}

export type NarrowVoiceRelationReleaseReason =
  | "authorized"
  | "source-is-not-voice"
  | "active-parent-missing"
  | "type-settlement-missing"
  | "type-settlement-not-authoritative"
  | "current-type-not-parent-eligible"
  | "manual-correction-active"
  | "candidate-missing"
  | "operation-lease-not-authorized"
  | "release-window-closed"
  | "candidate-confidence-below-threshold"
  | "candidate-relation-unknown"
  | "candidate-new-parent-evidence-missing"
  | "candidate-followup-evidence-missing"
  | "candidate-child-evidence-missing"
  | "candidate-resume-evidence-missing";

export interface NarrowVoiceRelationReleaseDecision {
  requested: boolean;
  authorized: boolean;
  reason: NarrowVoiceRelationReleaseReason;
  currentQuestionType: CanonicalQuestionType;
  activeParentQuestionType: CanonicalQuestionType;
  relationConfidence: number;
  minimumConfidence: number;
  releasedRelation?: RuntimeTaskRelation;
}

export interface NarrowVoiceRelationReleaseInput {
  sourceKind: "voice" | "screen" | "mixed";
  activeParentQuestionType?: unknown;
  typeSettlement?: CurrentQuestionSettlementDecision;
  candidate?: LlmTaskRelationAdjudication;
  hasActiveChild?: boolean;
  manualCorrectionActive: boolean;
  manualTypeAuthorityAuthorized?: boolean;
  operationLeaseAuthorized?: boolean;
  releaseWindowOpen?: boolean;
}

export type NarrowVoiceTypeRelationSettlementReason =
  | "settled"
  | "logical-question-unit-mismatch"
  | "logical-question-revision-mismatch"
  | "session-mismatch"
  | "runtime-epoch-mismatch"
  | "source-hash-mismatch";

export interface NarrowVoiceTypeRelationSettlementResult {
  reason: NarrowVoiceTypeRelationSettlementReason;
  settlement?: CurrentQuestionSettlementDecision;
}

export type TaskRelationAdjudicationComparisonOutcome =
  | "agreement"
  | "disagreement"
  | "candidate-unavailable"
  | "not-applicable";

export interface TaskRelationAdjudicationComparison {
  eligible: boolean;
  outcome: TaskRelationAdjudicationComparisonOutcome;
  agreement?: boolean;
  disagreement?: boolean;
}

export function normalizeTaskRelationAdjudicationMode(
  value: unknown,
  legacyEnabled = true
): MeetingTaskRelationAdjudicationMode {
  if (
    value === "off" ||
    value === "shadow" ||
    value === "enforcement"
  ) {
    return value;
  }
  return legacyEnabled ? "shadow" : "off";
}

export function buildTaskRelationAdjudicationRequest(input: {
  logicalQuestionUnit: LogicalQuestionUnit;
  activeMeetingTask: ActiveMeetingTask;
  currentQuestion?: ProvisionalCurrentQuestion;
  recentTurns?: TranscriptTurn[];
}): TaskRelationAdjudicationRequest {
  const parent = input.activeMeetingTask.parent;
  const child = input.activeMeetingTask.child;
  const parentScope = selectActiveParentSourceTurns({
    turns: input.recentTurns ?? [],
    activeMeetingTask: input.activeMeetingTask,
  });
  const excludedTurnIds = new Set(
    input.logicalQuestionUnit.sourceTurnIds
  );
  const parentEvidenceSelection = selectRecentSourceEvidence({
    turns: parentScope.turns,
    excludedTurnIds,
    maxTurns: 5,
    sourceScope: "parent-scope",
  });
  let recentSourceEvidence = parentEvidenceSelection.evidence;
  let crossBoundarySelectedCount = 0;
  let currentSourceFallbackCount = 0;
  const allPriorEvidenceSelection = selectRecentSourceEvidence({
    turns: input.recentTurns ?? [],
    excludedTurnIds,
    maxTurns: 1,
    sourceScope: "cross-boundary-prior-turn",
  });
  if (recentSourceEvidence.length === 0) {
    recentSourceEvidence = allPriorEvidenceSelection.evidence;
    crossBoundarySelectedCount = recentSourceEvidence.length;
  }
  if (recentSourceEvidence.length === 0) {
    const currentSource =
      [...input.logicalQuestionUnit.sources]
        .reverse()
        .find((source) => source.text.trim()) ??
      input.logicalQuestionUnit.sources.at(-1);
    const text = boundText(
      currentSource?.text ?? input.logicalQuestionUnit.normalizedText,
      Math.min(280, TASK_RELATION_ADJUDICATION_MAX_SOURCE_EVIDENCE_CHARS)
    );
    if (text) {
      recentSourceEvidence = [
        {
          turnId:
            currentSource?.turnId ??
            input.logicalQuestionUnit.currentTurnId,
          text,
          selectionReason: "raw-recent-turn",
          sourceScope: "current-source-fallback",
        },
      ];
      currentSourceFallbackCount = 1;
    }
  }
  const recentEvidenceDiagnostics: TaskRelationRecentEvidenceDiagnostics = {
    eligiblePriorTurnCount:
      allPriorEvidenceSelection.diagnostics.eligiblePriorTurnCount,
    selectedTurnCount: recentSourceEvidence.length,
    rawFallbackCount: recentSourceEvidence.filter(
      (item) => item.selectionReason === "raw-recent-turn"
    ).length,
    falseEmpty: recentSourceEvidence.length === 0,
    emptyReason:
      recentSourceEvidence.length === 0
        ? "no-prior-source-turn"
        : undefined,
    parentBoundaryFound: parentScope.boundaryFound,
    parentScopedSelectedCount: parentEvidenceSelection.evidence.length,
    crossBoundarySelectedCount,
    currentSourceFallbackCount,
  };
  const recentTransitions = recentSourceEvidence
    .filter((item) => item.role === "transition")
    .map((item) => ({ turnId: item.turnId, text: item.text }));
  const activeParent = buildParentCapsule(
    input.activeMeetingTask,
    recentSourceEvidence
  );
  const currentQuestion = input.currentQuestion;
  const sourceSettlementId = currentQuestion
    ? createCurrentQuestionSourceSettlementId(currentQuestion)
    : createCurrentQuestionSourceSettlementId({
        sessionId: input.logicalQuestionUnit.sessionId,
        runtimeEpoch: input.logicalQuestionUnit.runtimeEpoch,
        logicalQuestionUnitId: input.logicalQuestionUnit.id,
        revision: input.logicalQuestionUnit.revision,
        sourceTurnIds: input.logicalQuestionUnit.sourceTurnIds,
      });

  return {
    schemaVersion: TASK_RELATION_ADJUDICATION_SCHEMA_VERSION,
    promptVersion: TASK_RELATION_ADJUDICATION_PROMPT_VERSION,
    logicalQuestionUnitId: input.logicalQuestionUnit.id,
    logicalQuestionUnitRevision: input.logicalQuestionUnit.revision,
    sourceSettlementId,
    sourceHash:
      currentQuestion?.sourceHash ??
      `question_source_turns_${hashTaxonomySourceTurnIds(
        input.logicalQuestionUnit.sourceTurnIds
      )}`,
    currentQuestion: projectLogicalQuestionForAdjudication(
      input.logicalQuestionUnit
    ),
    activeParent,
    activeChild: child
        ? {
          childId: child.id,
          question: boundText(child.question, 240),
          sourceTurnIds: [...child.basedOnTurnIds].slice(0, 8),
        }
      : undefined,
    recentSourceEvidence,
    recentTransitions,
    recentEvidenceDiagnostics,
    suspendedParent: child
      ? {
          ...activeParent,
          revision: parent.revisions ?? 0,
        }
      : undefined,
  };
}

export function decideTaskRelationAdjudicationEligibility(input: {
  mode: MeetingTaskRelationAdjudicationMode;
  evaluationActive: boolean;
  runtimeReleaseRequested?: boolean;
  runtimeReleaseSourceKind?: "screen" | "voice";
  speaker: "me" | "them" | "unknown";
  request: TaskRelationAdjudicationRequest;
  manualCorrectionActive: boolean;
  deterministicRelationAuthorized: boolean;
  deterministicRelation?: RuntimeTaskRelation;
  turnGateAction: string;
}): TaskRelationAdjudicationEligibilityDecision {
  const skip = (reason: string) => ({
    eligible: false,
    reason,
    triggerReasons: [] as string[],
  });
  if (input.mode === "off") return skip("task-relation-operation-off");
  if (!input.evaluationActive && !input.runtimeReleaseRequested) {
    return skip("evaluation-inactive");
  }
  if (input.speaker !== "them") return skip("speaker-is-not-interviewer");
  if (!input.request.currentQuestion.safe) {
    return skip("unsafe-question-projection");
  }
  if (input.manualCorrectionActive) {
    return skip("manual-correction-authoritative");
  }
  if (input.turnGateAction !== "answer-refresh") {
    return skip(`turn-gate-not-answer:${input.turnGateAction || "unknown"}`);
  }
  if (
    estimateWordEquivalents(input.request.currentQuestion.text) < 3
  ) {
    return skip("question-unit-too-short");
  }
  if (input.runtimeReleaseRequested) {
    const voiceRelease = input.runtimeReleaseSourceKind === "voice";
    return {
      eligible: true,
      reason: voiceRelease
        ? "voice-relation-release-candidate"
        : "screen-relation-release-candidate",
      triggerReasons: [
        voiceRelease
          ? "type-enforcement-window"
          : "screen-boundary-prior",
        voiceRelease
          ? "voice-type-relation-convergence"
          : "parent-eligible-screen-question",
      ],
      auditKind: voiceRelease
        ? "voice-release-candidate"
        : "screen-release-candidate",
    };
  }
  if (input.deterministicRelationAuthorized) {
    if (
      !input.deterministicRelation ||
      input.deterministicRelation === "unknown"
    ) {
      return skip("deterministic-relation-not-auditable");
    }
    return {
      eligible: true,
      reason: "deterministic-relation-shadow-audit",
      triggerReasons: [
        "deterministic-relation-shadow-audit",
        `local-relation:${input.deterministicRelation}`,
      ],
      auditKind: "deterministic-comparison",
    };
  }

  return {
    eligible: true,
    reason: "task-relation-unresolved",
    triggerReasons: [
      "task-relation-unresolved",
      input.request.activeChild
        ? "active-child-present"
        : "active-parent-present",
    ],
    auditKind: "unresolved-proposal",
  };
}

export function decideNarrowScreenRelationRelease(
  input: NarrowScreenRelationReleaseInput
): NarrowScreenRelationReleaseDecision {
  const currentQuestionType =
    normalizeCanonicalQuestionType(input.currentQuestionType) ?? "unknown";
  const activeParentQuestionType =
    normalizeCanonicalQuestionType(input.activeParentQuestionType) ??
    "unknown";
  const typeConfidence = normalizeConfidence(input.typeConfidence);
  const relationConfidence = normalizeConfidence(
    input.candidate?.confidence
  );
  const reject = (
    reason: NarrowScreenRelationReleaseReason,
    requested = false
  ): NarrowScreenRelationReleaseDecision => ({
    requested,
    authorized: false,
    reason,
    currentQuestionType,
    activeParentQuestionType,
    typeConfidence,
    relationConfidence,
    minimumConfidence: SCREEN_RELATION_RELEASE_MIN_CONFIDENCE,
  });

  if (input.sourceKind !== "screen") {
    return reject("source-is-not-manual-screen");
  }
  if (!input.screenBoundaryPrior) {
    return reject("screen-boundary-prior-missing");
  }
  if (activeParentQuestionType === "unknown") {
    return reject("active-parent-missing");
  }
  if (!isParentCanonicalQuestionType(currentQuestionType)) {
    return reject("current-type-not-parent-eligible");
  }
  if (!input.typeEvidenceAuthorized) {
    return reject("screen-type-evidence-not-authorized");
  }
  if (input.typeAuthoritySource !== "screen-preflight") {
    return reject("screen-type-source-not-authoritative");
  }
  if (typeConfidence < SCREEN_RELATION_RELEASE_MIN_CONFIDENCE) {
    return reject("screen-type-confidence-below-threshold");
  }
  if (!input.questionComplete) {
    return reject("question-incomplete");
  }
  if (input.manualCorrectionActive) {
    return reject("manual-correction-active");
  }
  if (input.hasActiveChild) {
    return reject("active-child-conflict");
  }
  if (!input.candidate) {
    return reject("eligible-awaiting-candidate", true);
  }
  if (!input.operationLeaseAuthorized) {
    return reject("operation-lease-not-authorized", true);
  }
  if (input.releaseWindowOpen === false) {
    return reject("release-window-closed", true);
  }
  if (relationConfidence < SCREEN_RELATION_RELEASE_MIN_CONFIDENCE) {
    return reject("candidate-confidence-below-threshold", true);
  }
  if (input.candidate.relation === "followup-parent") {
    if (
      currentQuestionType !== activeParentQuestionType ||
      input.candidate.parentEvidenceSpans.length === 0
    ) {
      return reject(
        "candidate-followup-parent-evidence-missing",
        true
      );
    }
    return {
      requested: true,
      authorized: true,
      reason: "authorized",
      currentQuestionType,
      activeParentQuestionType,
      typeConfidence,
      relationConfidence,
      minimumConfidence: SCREEN_RELATION_RELEASE_MIN_CONFIDENCE,
      releasedRelation: "followup-parent",
    };
  }
  if (input.candidate.relation !== "new-parent") {
    return reject("candidate-relation-not-new-parent", true);
  }

  return {
    requested: true,
    authorized: true,
    reason: "authorized",
    currentQuestionType,
    activeParentQuestionType,
    typeConfidence,
    relationConfidence,
    minimumConfidence: SCREEN_RELATION_RELEASE_MIN_CONFIDENCE,
    releasedRelation: "new-parent",
  };
}

export function decideNarrowVoiceRelationRelease(
  input: NarrowVoiceRelationReleaseInput
): NarrowVoiceRelationReleaseDecision {
  const currentQuestionType =
    normalizeCanonicalQuestionType(input.typeSettlement?.questionType) ??
    "unknown";
  const activeParentQuestionType =
    normalizeCanonicalQuestionType(input.activeParentQuestionType) ??
    "unknown";
  const relationConfidence = normalizeConfidence(
    input.candidate?.confidence
  );
  const reject = (
    reason: NarrowVoiceRelationReleaseReason,
    requested = false
  ): NarrowVoiceRelationReleaseDecision => ({
    requested,
    authorized: false,
    reason,
    currentQuestionType,
    activeParentQuestionType,
    relationConfidence,
    minimumConfidence: VOICE_RELATION_RELEASE_MIN_CONFIDENCE,
  });

  if (input.sourceKind !== "voice" && input.sourceKind !== "mixed") {
    return reject("source-is-not-voice");
  }
  if (activeParentQuestionType === "unknown") {
    return reject("active-parent-missing");
  }
  if (!input.typeSettlement) {
    return reject("type-settlement-missing", true);
  }
  if (
    (input.typeSettlement.typeAuthoritySource !== "llm-type-repair" &&
      !(
        input.manualTypeAuthorityAuthorized &&
        input.typeSettlement.typeAuthoritySource === "manual-correction"
      )) ||
    !input.typeSettlement.typeMutationAuthorized
  ) {
    return reject("type-settlement-not-authoritative", true);
  }
  if (input.manualCorrectionActive) {
    return reject("manual-correction-active", true);
  }
  if (!input.candidate) {
    return reject("candidate-missing", true);
  }
  if (!input.operationLeaseAuthorized) {
    return reject("operation-lease-not-authorized", true);
  }
  if (input.releaseWindowOpen === false) {
    return reject("release-window-closed", true);
  }
  if (relationConfidence < VOICE_RELATION_RELEASE_MIN_CONFIDENCE) {
    return reject("candidate-confidence-below-threshold", true);
  }
  const candidate = input.candidate;
  if (candidate.relation === "unknown") {
    return reject("candidate-relation-unknown", true);
  }
  if (candidate.relation === "new-parent") {
    if (!isParentCanonicalQuestionType(currentQuestionType)) {
      return reject("current-type-not-parent-eligible", true);
    }
    const sameType = currentQuestionType === activeParentQuestionType;
    if (
      sameType &&
      !(
        candidate.switchIntent === "explicit-switch" &&
        candidate.dependency === "parent-independent" &&
        candidate.standalone === true &&
        candidate.standaloneSufficiency === "sufficient"
      )
    ) {
      return reject("candidate-new-parent-evidence-missing", true);
    }
  } else if (candidate.relation === "followup-parent") {
    if (
      candidate.dependency !== "parent-dependent" ||
      candidate.parentEvidenceSpans.length === 0
    ) {
      return reject("candidate-followup-evidence-missing", true);
    }
  } else if (candidate.relation === "child-probe") {
    if (
      currentQuestionType === "unknown" ||
      candidate.dependency !== "parent-dependent" ||
      candidate.parentEvidenceSpans.length === 0
    ) {
      return reject("candidate-child-evidence-missing", true);
    }
  } else if (candidate.relation === "resume-parent") {
    if (
      !input.hasActiveChild ||
      candidate.returnIntent !== "resume-suspended-parent" ||
      candidate.parentEvidenceSpans.length === 0
    ) {
      return reject("candidate-resume-evidence-missing", true);
    }
  }

  return {
    requested: true,
    authorized: true,
    reason: "authorized",
    currentQuestionType,
    activeParentQuestionType,
    relationConfidence,
    minimumConfidence: VOICE_RELATION_RELEASE_MIN_CONFIDENCE,
    releasedRelation: candidate.relation,
  };
}

export function settleNarrowVoiceTypeRelation(input: {
  operationId: string;
  currentQuestion: ProvisionalCurrentQuestion;
  typeSettlement: CurrentQuestionSettlementDecision;
  relationCandidate: LlmTaskRelationAdjudication;
  activeParentId: string;
  activeParentRevision?: number;
  manualCorrectionRevision: number;
}): NarrowVoiceTypeRelationSettlementResult {
  if (
    input.typeSettlement.logicalQuestionUnitId !==
    input.currentQuestion.logicalQuestionUnitId
  ) {
    return { reason: "logical-question-unit-mismatch" };
  }
  if (input.typeSettlement.revision !== input.currentQuestion.revision) {
    return { reason: "logical-question-revision-mismatch" };
  }
  if (input.typeSettlement.sessionId !== input.currentQuestion.sessionId) {
    return { reason: "session-mismatch" };
  }
  if (input.typeSettlement.runtimeEpoch !== input.currentQuestion.runtimeEpoch) {
    return { reason: "runtime-epoch-mismatch" };
  }
  if (input.typeSettlement.sourceHash !== input.currentQuestion.sourceHash) {
    return { reason: "source-hash-mismatch" };
  }

  const llmProposal: CurrentQuestionSettlementProposal = {
    source: "llm-type-repair",
    sessionId: input.currentQuestion.sessionId,
    runtimeEpoch: input.currentQuestion.runtimeEpoch,
    logicalQuestionUnitId: input.currentQuestion.logicalQuestionUnitId,
    revision: input.currentQuestion.revision,
    sourceHash: input.currentQuestion.sourceHash,
    questionType: input.typeSettlement.questionType,
    relation: input.relationCandidate.relation,
    action: "answer",
    confidence: Math.min(
      input.typeSettlement.confidence,
      normalizeConfidence(input.relationCandidate.confidence)
    ),
    typeEvidenceAuthorized: true,
    relationEvidenceAuthorized: true,
    actionEvidenceAuthorized: true,
    expectedParentId: input.activeParentId,
    expectedParentRevision: input.activeParentRevision,
    reasons: [
      "runtime-type-relation-convergence",
      "type-operation-authoritative",
      "relation-operation-authoritative",
    ],
  };

  return {
    reason: "settled",
    settlement: settleCurrentQuestion({
      operationId: input.operationId,
      currentQuestion: input.currentQuestion,
      llmProposal,
      activeParentId: input.activeParentId,
      activeParentRevision: input.activeParentRevision,
      manualCorrectionRevision: input.manualCorrectionRevision,
      policy: {
        allowLlmTypeRepair: true,
        allowLlmRelationRepair: true,
        allowLlmActionRepair: true,
        llmTypeRepairMinConfidence: VOICE_RELATION_RELEASE_MIN_CONFIDENCE,
        llmRelationRepairMinConfidence: VOICE_RELATION_RELEASE_MIN_CONFIDENCE,
        runtimeMutationAuthorized: true,
        questionComplete: true,
        commitParent: true,
      },
    }),
  };
}

export function formatNarrowScreenRelationReleaseForTrace(
  decision: NarrowScreenRelationReleaseDecision
) {
  return {
    taskRelationScreenReleaseRequested: decision.requested,
    taskRelationScreenReleaseAuthorized: decision.authorized,
    taskRelationScreenReleaseReason: decision.reason,
    taskRelationScreenReleaseCurrentType: decision.currentQuestionType,
    taskRelationScreenReleaseParentType:
      decision.activeParentQuestionType,
    taskRelationScreenReleaseTypeConfidence: decision.typeConfidence,
    taskRelationScreenReleaseRelationConfidence:
      decision.relationConfidence,
    taskRelationScreenReleaseMinConfidence: decision.minimumConfidence,
    taskRelationScreenReleasedRelation: decision.releasedRelation,
  };
}

export function formatNarrowVoiceRelationReleaseForTrace(
  decision: NarrowVoiceRelationReleaseDecision | undefined
) {
  return {
    taskRelationVoiceReleaseRequested: decision?.requested ?? false,
    taskRelationVoiceReleaseAuthorized: decision?.authorized ?? false,
    taskRelationVoiceReleaseReason: decision?.reason,
    taskRelationVoiceReleaseCurrentType: decision?.currentQuestionType,
    taskRelationVoiceReleaseParentType:
      decision?.activeParentQuestionType,
    taskRelationVoiceReleaseRelationConfidence:
      decision?.relationConfidence,
    taskRelationVoiceReleaseMinConfidence:
      decision?.minimumConfidence,
    taskRelationVoiceReleasedRelation:
      decision?.releasedRelation,
  };
}

export function compareTaskRelationAdjudication(input: {
  deterministicRelation?: RuntimeTaskRelation;
  candidateRelation?: RuntimeTaskRelation;
}): TaskRelationAdjudicationComparison {
  if (
    !input.deterministicRelation ||
    input.deterministicRelation === "unknown"
  ) {
    return {
      eligible: false,
      outcome: "not-applicable",
    };
  }
  if (!input.candidateRelation) {
    return {
      eligible: true,
      outcome: "candidate-unavailable",
    };
  }
  const agreement =
    input.candidateRelation === input.deterministicRelation;
  return {
    eligible: true,
    outcome: agreement ? "agreement" : "disagreement",
    agreement,
    disagreement: !agreement,
  };
}

export function buildTaskRelationAdjudicationPrompts(
  request: TaskRelationAdjudicationRequest
) {
  return {
    systemPrompt: [
      "Classify only the relationship between one bounded interviewer question and the supplied active interview parent.",
      "Return one JSON object only. Do not answer the interview question.",
      "Do not classify question type, choose an advisor action, mutate a parent, advance a playbook phase, select memory, or generate an artifact.",
      "Output exactly one canonical relation: new-parent, followup-parent, child-probe, resume-parent, or unknown.",
      "Use new-parent when the current question is a concrete independent task that can be answered without the active parent. A new question may share a broad domain with the parent.",
      "Use followup-parent when the current question directly continues, constrains, explains, or revises the active parent mainline and needs that parent to be answered.",
      "Use child-probe for a bounded local concept or implementation detour that needs the active parent while leaving the parent resumable afterward.",
      "Use resume-parent only when an active child exists and the current wording returns to the suspended parent.",
      "Use unknown when the evidence cannot distinguish these relations. Do not force continuity from timing or topic overlap.",
      "Pronouns and deictic references such as this, that, it, the design, how would it change, or continue normally require parent evidence.",
      "Time proximity, topic overlap, compatible question types, playbook phase, and generated answers are not relationship evidence.",
      "currentQuestionEvidenceSpans must contain one or more exact verbatim substrings from currentQuestion.sourceTurns.",
      "parentEvidenceSpans must contain exact verbatim substrings from source-owned activeParent, activeChild, recentSourceEvidence, recentTransitions, or suspendedParent text fields.",
      "followup-parent, child-probe, and resume-parent require at least one grounded parentEvidenceSpans entry.",
      "Schema: {schemaVersion:3,relation,confidence,currentQuestionEvidenceSpans,parentEvidenceSpans,ambiguityReason?}.",
    ].join(" "),
    userMessage: JSON.stringify({
      schemaVersion: request.schemaVersion,
      promptVersion: request.promptVersion,
      logicalQuestionUnitId: request.logicalQuestionUnitId,
      logicalQuestionUnitRevision:
        request.logicalQuestionUnitRevision,
      currentQuestion: {
        sourceTurns: request.currentQuestion.sourceTurns,
        omittedSourceTurnIds:
          request.currentQuestion.omittedSourceTurnIds,
        projectionReason:
          request.currentQuestion.projectionReason,
      },
      activeParent: request.activeParent,
      activeChild: request.activeChild,
      recentSourceEvidence: request.recentSourceEvidence,
      recentTransitions: request.recentTransitions,
      suspendedParent: request.suspendedParent,
    }),
  };
}

export function parseTaskRelationAdjudicationOutput(
  rawOutput: string,
  request: TaskRelationAdjudicationRequest
): TaskRelationAdjudicationParseResult {
  const trimmed = stripJsonFence(rawOutput.trim());
  if (!trimmed) return parseFailure("empty-output", "parse");
  if (trimmed.length > TASK_RELATION_ADJUDICATION_MAX_OUTPUT_CHARS) {
    return parseFailure("output-too-large", "parse");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(trimmed);
  } catch {
    return parseFailure("invalid-json", "parse");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    return parseFailure("output-is-not-object", "schema");
  }
  const candidate = decoded as Record<string, unknown>;
  if (
    candidate.schemaVersion ===
    TASK_RELATION_ADJUDICATION_SCHEMA_VERSION
  ) {
    return parseDirectTaskRelationAdjudication(candidate, request);
  }
  if (
    candidate.schemaVersion !==
    LEGACY_TASK_RELATION_ADJUDICATION_SCHEMA_VERSION
  ) {
    return parseFailure("unsupported-schema-version", "schema");
  }
  const hasCanonicalParentEvidence = Object.prototype.hasOwnProperty.call(
    candidate,
    "parentEvidenceSpans"
  );
  const hasParentEvidenceAlias = Object.prototype.hasOwnProperty.call(
    candidate,
    "parentEvidenceSpan"
  );
  const allowedKeys = new Set([
    "schemaVersion",
    "dependency",
    "continuationShape",
    "returnIntent",
    "switchIntent",
    "standaloneSufficiency",
    "confidence",
    "currentQuestionEvidenceSpans",
    "parentEvidenceSpans",
    "parentEvidenceSpan",
    "ambiguityReason",
  ]);
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) {
    return parseFailure("non-relation-field-present", "schema");
  }
  if (hasCanonicalParentEvidence && hasParentEvidenceAlias) {
    return parseFailure(
      "conflicting-parent-evidence-fields",
      "schema"
    );
  }
  const normalizedParentEvidence = normalizeParentEvidenceSpans(
    candidate.parentEvidenceSpans,
    candidate.parentEvidenceSpan,
    hasParentEvidenceAlias
  );
  if (!normalizedParentEvidence.ok) {
    return parseFailure(normalizedParentEvidence.reason, "schema");
  }
  if (!isTaskRelationDependency(candidate.dependency)) {
    return parseFailure("invalid-dependency", "schema");
  }
  if (
    !isTaskRelationContinuationShape(candidate.continuationShape)
  ) {
    return parseFailure("invalid-continuation-shape", "schema");
  }
  if (!isTaskRelationReturnIntent(candidate.returnIntent)) {
    return parseFailure("invalid-return-intent", "schema");
  }
  if (!isTaskRelationSwitchIntent(candidate.switchIntent)) {
    return parseFailure("invalid-switch-intent", "schema");
  }
  if (
    !isTaskRelationStandaloneSufficiency(
      candidate.standaloneSufficiency
    )
  ) {
    return parseFailure("invalid-standalone-sufficiency", "schema");
  }
  if (
    typeof candidate.confidence !== "number" ||
    !Number.isFinite(candidate.confidence) ||
    candidate.confidence < 0 ||
    candidate.confidence > 1
  ) {
    return parseFailure("invalid-confidence", "schema");
  }
  if (
    candidate.ambiguityReason !== undefined &&
    typeof candidate.ambiguityReason !== "string"
  ) {
    return parseFailure("invalid-ambiguity-reason", "schema");
  }
  if (!isEvidenceSpanArray(candidate.currentQuestionEvidenceSpans, true)) {
    return parseFailure(
      "invalid-current-question-evidence-spans",
      "schema"
    );
  }
  const dependency = candidate.dependency;
  const continuationShape = candidate.continuationShape;
  const returnIntent = candidate.returnIntent;
  const switchIntent = candidate.switchIntent;
  const standaloneSufficiency =
    candidate.standaloneSufficiency;
  const currentQuestionEvidenceSpans = (
    candidate.currentQuestionEvidenceSpans as string[]
  ).map((span) => span.trim());
  const parentEvidenceSpans = normalizedParentEvidence.value.map((span) =>
    span.trim()
  );
  const currentEvidenceCorpus = request.currentQuestion.sourceTurns
    .map((source) => source.text)
    .join("\n");
  const parentEvidenceCorpus = buildParentEvidenceCorpus(request);
  if (
    !allSpansGrounded(
      currentQuestionEvidenceSpans,
      currentEvidenceCorpus
    )
  ) {
    return parseFailure("invalid-current-question-evidence", "evidence");
  }
  if (!allSpansGrounded(parentEvidenceSpans, parentEvidenceCorpus)) {
    return parseFailure("invalid-parent-evidence", "evidence");
  }
  if (
    (dependency === "parent-dependent" ||
      returnIntent === "resume-suspended-parent") &&
    parentEvidenceSpans.length === 0
  ) {
    return parseFailure("parent-evidence-required", "evidence");
  }
  const relation = deriveSemanticTaskRelationFromAtomicDecision({
    dependency,
    continuationShape,
    returnIntent,
    switchIntent,
    standaloneSufficiency,
    hasParentEvidence: parentEvidenceSpans.length > 0,
  });

  return {
    ok: true,
    evidenceSpansValid: true,
    schemaAliasApplied: normalizedParentEvidence.aliasApplied,
    schemaAliasSourceField: normalizedParentEvidence.aliasApplied
      ? "parentEvidenceSpan"
      : undefined,
    schemaAliasCanonicalField: normalizedParentEvidence.aliasApplied
      ? "parentEvidenceSpans"
      : undefined,
    value: {
      schemaVersion: LEGACY_TASK_RELATION_ADJUDICATION_SCHEMA_VERSION,
      relation,
      dependency,
      continuationShape,
      returnIntent,
      switchIntent,
      standaloneSufficiency,
      confidence: candidate.confidence,
      currentQuestionEvidenceSpans,
      parentEvidenceSpans,
      explicitBinding:
        returnIntent === "resume-suspended-parent",
      standalone: standaloneSufficiency === "sufficient",
      ambiguityReason: candidate.ambiguityReason as
        | string
        | undefined,
    },
  };
}

function parseDirectTaskRelationAdjudication(
  candidate: Record<string, unknown>,
  request: TaskRelationAdjudicationRequest
): TaskRelationAdjudicationParseResult {
  const allowedKeys = new Set([
    "schemaVersion",
    "relation",
    "confidence",
    "currentQuestionEvidenceSpans",
    "parentEvidenceSpans",
    "ambiguityReason",
  ]);
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) {
    return parseFailure("non-relation-field-present", "schema");
  }
  if (!isRuntimeTaskRelation(candidate.relation)) {
    return parseFailure("invalid-relation", "schema");
  }
  if (
    typeof candidate.confidence !== "number" ||
    !Number.isFinite(candidate.confidence) ||
    candidate.confidence < 0 ||
    candidate.confidence > 1
  ) {
    return parseFailure("invalid-confidence", "schema");
  }
  if (
    candidate.ambiguityReason !== undefined &&
    typeof candidate.ambiguityReason !== "string"
  ) {
    return parseFailure("invalid-ambiguity-reason", "schema");
  }
  if (!isEvidenceSpanArray(candidate.currentQuestionEvidenceSpans, true)) {
    return parseFailure(
      "invalid-current-question-evidence-spans",
      "schema"
    );
  }
  if (!isEvidenceSpanArray(candidate.parentEvidenceSpans, false)) {
    return parseFailure("invalid-parent-evidence-spans", "schema");
  }

  const currentQuestionEvidenceSpans = (
    candidate.currentQuestionEvidenceSpans as string[]
  ).map((span) => span.trim());
  const parentEvidenceSpans = (
    candidate.parentEvidenceSpans as string[]
  ).map((span) => span.trim());
  const currentEvidenceCorpus = request.currentQuestion.sourceTurns
    .map((source) => source.text)
    .join("\n");
  if (
    !allSpansGrounded(
      currentQuestionEvidenceSpans,
      currentEvidenceCorpus
    )
  ) {
    return parseFailure("invalid-current-question-evidence", "evidence");
  }
  if (
    !allSpansGrounded(
      parentEvidenceSpans,
      buildParentEvidenceCorpus(request)
    )
  ) {
    return parseFailure("invalid-parent-evidence", "evidence");
  }
  if (
    (candidate.relation === "followup-parent" ||
      candidate.relation === "child-probe" ||
      candidate.relation === "resume-parent") &&
    parentEvidenceSpans.length === 0
  ) {
    return parseFailure("parent-evidence-required", "evidence");
  }

  return {
    ok: true,
    evidenceSpansValid: true,
    schemaAliasApplied: false,
    value: {
      schemaVersion: TASK_RELATION_ADJUDICATION_SCHEMA_VERSION,
      relation: candidate.relation,
      confidence: candidate.confidence,
      currentQuestionEvidenceSpans,
      parentEvidenceSpans,
      ambiguityReason: candidate.ambiguityReason as string | undefined,
    },
  };
}

export function deriveRuntimeTaskRelationFromAtomicDecision(input: {
  dependency: TaskRelationDependency;
  continuationShape: TaskRelationContinuationShape;
  returnIntent: TaskRelationReturnIntent;
  switchIntent: TaskRelationSwitchIntent;
  standaloneSufficiency: TaskRelationStandaloneSufficiency;
  hasActiveChild: boolean;
  hasParentEvidence: boolean;
}): RuntimeTaskRelation {
  if (input.returnIntent === "resume-suspended-parent") {
    return input.hasActiveChild && input.hasParentEvidence
      ? "resume-parent"
      : "unknown";
  }
  if (input.dependency === "parent-dependent") {
    if (!input.hasParentEvidence) return "unknown";
    if (input.continuationShape === "bounded-detour") {
      return "child-probe";
    }
    if (input.continuationShape === "mainline") {
      return "followup-parent";
    }
    return "unknown";
  }
  if (
    input.dependency === "parent-independent" &&
    input.standaloneSufficiency === "sufficient"
  ) {
    return "new-parent";
  }
  return "unknown";
}

export function deriveSemanticTaskRelationFromAtomicDecision(input: {
  dependency: TaskRelationDependency;
  continuationShape: TaskRelationContinuationShape;
  returnIntent: TaskRelationReturnIntent;
  switchIntent: TaskRelationSwitchIntent;
  standaloneSufficiency: TaskRelationStandaloneSufficiency;
  hasParentEvidence: boolean;
}): RuntimeTaskRelation {
  if (input.returnIntent === "resume-suspended-parent") {
    return input.hasParentEvidence ? "resume-parent" : "unknown";
  }
  return deriveRuntimeTaskRelationFromAtomicDecision({
    ...input,
    hasActiveChild: true,
  });
}

export function createTaskRelationSettlementProposal(input: {
  currentQuestion: ProvisionalCurrentQuestion;
  adjudication: LlmTaskRelationAdjudication;
  expectedParentId: string;
  expectedParentRevision?: number;
}): CurrentQuestionSettlementProposal {
  return {
    source: "llm-type-repair",
    sessionId: input.currentQuestion.sessionId,
    runtimeEpoch: input.currentQuestion.runtimeEpoch,
    logicalQuestionUnitId:
      input.currentQuestion.logicalQuestionUnitId,
    revision: input.currentQuestion.revision,
    sourceHash: input.currentQuestion.sourceHash,
    relation: input.adjudication.relation,
    confidence: input.adjudication.confidence,
    typeEvidenceAuthorized: false,
    relationEvidenceAuthorized:
      input.adjudication.relation !== "unknown",
    actionEvidenceAuthorized: false,
    expectedParentId: input.expectedParentId,
    expectedParentRevision: input.expectedParentRevision,
    reasons: [
      "task-relation-runtime-operation",
      "type-authority-withheld",
      "action-authority-withheld",
      "parent-mutation-withheld",
    ],
  };
}

export function formatTaskRelationAdjudicationForTrace(input: {
  mode: MeetingTaskRelationAdjudicationMode;
  eligibility?: TaskRelationAdjudicationEligibilityDecision;
  request?: TaskRelationAdjudicationRequest;
  disposition?: string;
  candidate?: LlmTaskRelationAdjudication;
  parseResult?: TaskRelationAdjudicationParseResult;
}) {
  return {
    taskRelationAdjudicationMode: input.mode,
    taskRelationAdjudicationEligible:
      input.eligibility?.eligible,
    taskRelationAdjudicationEligibilityReason:
      input.eligibility?.reason,
    taskRelationAdjudicationTriggerReasons:
      input.eligibility?.triggerReasons,
    taskRelationAdjudicationAuditKind:
      input.eligibility?.auditKind,
    taskRelationAdjudicationUnitId:
      input.request?.logicalQuestionUnitId,
    taskRelationAdjudicationUnitRevision:
      input.request?.logicalQuestionUnitRevision,
    taskRelationAdjudicationSourceSettlementId:
      input.request?.sourceSettlementId,
    taskRelationAdjudicationSourceHash: input.request?.sourceHash,
    taskRelationAdjudicationInputChars:
      input.request?.currentQuestion.projectedChars,
    taskRelationAdjudicationOriginalChars:
      input.request?.currentQuestion.originalChars,
    taskRelationAdjudicationParentId:
      input.request?.activeParent.parentId,
    taskRelationAdjudicationParentRevision:
      input.request?.activeParent.revision,
    taskRelationAdjudicationActiveChildId:
      input.request?.activeChild?.childId,
    taskRelationAdjudicationRecentSourceEvidenceCount:
      input.request?.recentSourceEvidence.length,
    taskRelationAdjudicationRecentSourceEvidenceChars:
      input.request?.recentSourceEvidence.reduce(
        (total, item) => total + item.text.length,
        0
      ),
    taskRelationAdjudicationRecentSourceEvidenceTurnIds:
      input.request?.recentSourceEvidence.map((item) => item.turnId),
    taskRelationAdjudicationRecentSourceEvidenceRoles:
      input.request?.recentSourceEvidence.map((item) => item.role),
    taskRelationAdjudicationRecentSourceEvidenceSelectionReasons:
      input.request?.recentSourceEvidence.map(
        (item) => item.selectionReason
      ),
    taskRelationAdjudicationRecentSourceEvidenceScopes:
      input.request?.recentSourceEvidence.map((item) => item.sourceScope),
    taskRelationAdjudicationEligiblePriorTurnCount:
      input.request?.recentEvidenceDiagnostics.eligiblePriorTurnCount,
    taskRelationAdjudicationRawRecentFallbackCount:
      input.request?.recentEvidenceDiagnostics.rawFallbackCount,
    taskRelationAdjudicationRecentEvidenceFalseEmpty:
      input.request?.recentEvidenceDiagnostics.falseEmpty,
    taskRelationAdjudicationRecentEvidenceEmptyReason:
      input.request?.recentEvidenceDiagnostics.emptyReason,
    taskRelationAdjudicationParentBoundaryFound:
      input.request?.recentEvidenceDiagnostics.parentBoundaryFound,
    taskRelationAdjudicationParentScopedEvidenceCount:
      input.request?.recentEvidenceDiagnostics.parentScopedSelectedCount,
    taskRelationAdjudicationCrossBoundaryEvidenceCount:
      input.request?.recentEvidenceDiagnostics.crossBoundarySelectedCount,
    taskRelationAdjudicationCurrentSourceFallbackCount:
      input.request?.recentEvidenceDiagnostics.currentSourceFallbackCount,
    taskRelationAdjudicationTransitionCount:
      input.request?.recentTransitions.length,
    taskRelationAdjudicationGeneratedAnswerExcluded: true,
    taskRelationAdjudicationDisposition: input.disposition,
    taskRelationAdjudicationCandidateSchemaVersion:
      input.candidate?.schemaVersion,
    taskRelationAdjudicationDirectRelation:
      input.candidate?.schemaVersion ===
      TASK_RELATION_ADJUDICATION_SCHEMA_VERSION,
    taskRelationAdjudicationCandidateRelation:
      input.candidate?.relation,
    taskRelationAdjudicationDependency:
      input.candidate?.dependency,
    taskRelationAdjudicationContinuationShape:
      input.candidate?.continuationShape,
    taskRelationAdjudicationReturnIntent:
      input.candidate?.returnIntent,
    taskRelationAdjudicationSwitchIntent:
      input.candidate?.switchIntent,
    taskRelationAdjudicationStandaloneSufficiency:
      input.candidate?.standaloneSufficiency,
    taskRelationAdjudicationConfidence:
      input.candidate?.confidence,
    taskRelationAdjudicationCurrentEvidenceSpans:
      input.candidate?.currentQuestionEvidenceSpans,
    taskRelationAdjudicationParentEvidenceSpans:
      input.candidate?.parentEvidenceSpans,
    taskRelationAdjudicationExplicitBinding:
      input.candidate?.explicitBinding,
    taskRelationAdjudicationStandalone:
      input.candidate?.standalone,
    taskRelationAdjudicationAmbiguityReason:
      input.candidate?.ambiguityReason,
    taskRelationAdjudicationSchemaAliasApplied:
      input.parseResult?.schemaAliasApplied ?? false,
    taskRelationAdjudicationSchemaAliasSourceField:
      input.parseResult?.ok
        ? input.parseResult.schemaAliasSourceField
        : undefined,
    taskRelationAdjudicationSchemaAliasCanonicalField:
      input.parseResult?.ok
        ? input.parseResult.schemaAliasCanonicalField
        : undefined,
    taskRelationAdjudicationTypeMutationBlocked: true,
    taskRelationAdjudicationActionMutationBlocked: true,
    taskRelationAdjudicationParentMutationBlocked: true,
    taskRelationAdjudicationPhaseMutationBlocked: true,
    taskRelationAdjudicationArtifactMutationBlocked: true,
  };
}

function buildParentCapsule(
  activeMeetingTask: ActiveMeetingTask,
  recentSourceEvidence: TaskRelationSourceEvidence[]
): TaskRelationParentCapsule {
  const parent = activeMeetingTask.parent;
  const sharedContext =
    parent.parentContextHandoff?.sharedScenarioContext;
  const sharedRequirements =
    sharedContext?.sharedRequirements?.slice(0, 4) ?? [];
  const compactObjective = boundText(
    [parent.topic, ...sharedRequirements].filter(Boolean).join(" | "),
    TASK_RELATION_ADJUDICATION_MAX_PARENT_CHARS
  );

  return {
    parentId: parent.id,
    revision: parent.revisions ?? 0,
    topic: boundText(parent.topic, 280),
    compactObjective,
    sourceTurnIds: uniqueStrings([
      ...(parent.canonicalQuestionSourceTurnIds ?? []),
      parent.startTurnId,
      parent.promptTranscriptStartTurnId,
    ]).slice(0, 12),
    acceptedConstraints: recentSourceEvidence.filter(
      (item) =>
        item.role === "constraint" &&
        item.sourceScope === "parent-scope"
    ),
    sharedScenarioEntities:
      sharedContext?.domainEntities
        ?.slice(0, 8)
        .map((entity) => boundText(entity, 80)) ?? [],
  };
}

function selectActiveParentSourceTurns(input: {
  turns: TranscriptTurn[];
  activeMeetingTask: ActiveMeetingTask;
}) {
  const parent = input.activeMeetingTask.parent;
  const boundaryIds = new Set(
    uniqueStrings([
      parent.promptTranscriptStartTurnId,
      parent.startTurnId,
      ...(parent.canonicalQuestionSourceTurnIds ?? []),
    ])
  );
  const boundaryIndexes = input.turns
    .map((turn, index) => (boundaryIds.has(turn.id) ? index : -1))
    .filter((index) => index >= 0);
  if (boundaryIndexes.length === 0) {
    return { turns: [] as TranscriptTurn[], boundaryFound: false };
  }
  return {
    turns: input.turns.slice(Math.min(...boundaryIndexes)),
    boundaryFound: true,
  };
}

function selectRecentSourceEvidence(input: {
  turns: TranscriptTurn[];
  excludedTurnIds: Set<string>;
  maxTurns: number;
  sourceScope: TaskRelationSourceEvidence["sourceScope"];
}) {
  const eligibleTurns = input.turns.filter(
    (turn) =>
      turn.speaker === "them" &&
      !input.excludedTurnIds.has(turn.id) &&
      turn.contextFusionStatus !== "duplicate-suppressed" &&
      Boolean(turn.text.trim())
  );
  const selected: TaskRelationSourceEvidence[] = [];
  let selectedChars = 0;
  for (const turn of [...eligibleTurns].reverse()) {
    if (
      selected.length >= input.maxTurns ||
      selectedChars >=
        TASK_RELATION_ADJUDICATION_MAX_SOURCE_EVIDENCE_CHARS
    ) {
      break;
    }
    const role = classifySourceEvidenceRole(turn);
    const remaining =
      TASK_RELATION_ADJUDICATION_MAX_SOURCE_EVIDENCE_CHARS -
      selectedChars;
    const text = boundText(turn.text, Math.min(280, remaining));
    if (!text) continue;
    selected.unshift({
      turnId: turn.id,
      text,
      role,
      selectionReason: role ? "role-hint" : "raw-recent-turn",
      sourceScope: input.sourceScope,
    });
    selectedChars += text.length;
  }
  return {
    evidence: selected,
    diagnostics: {
      eligiblePriorTurnCount: eligibleTurns.length,
      selectedTurnCount: selected.length,
      rawFallbackCount: selected.filter(
        (item) => item.selectionReason === "raw-recent-turn"
      ).length,
      falseEmpty: eligibleTurns.length > 0 && selected.length === 0,
      emptyReason:
        eligibleTurns.length === 0
          ? ("no-prior-source-turn" as const)
          : undefined,
    },
  };
}

function classifySourceEvidenceRole(
  turn: TranscriptTurn
): TaskRelationSourceEvidenceRole | undefined {
  if (hasTransitionEvidence(turn.text)) {
    return "transition";
  }
  if (hasConstraintOrCorrectionSignal(turn.text)) {
    return "constraint";
  }
  const primaryAsk = projectPrimaryAsk({
    turnId: turn.id,
    text: turn.text,
  });
  if (
    primaryAsk.disposition === "answer-primary-ask" &&
    primaryAsk.normalizedPrimaryAsk
  ) {
    return "question";
  }
  return undefined;
}

function hasTransitionEvidence(text: string) {
  return TRANSITION_EVIDENCE_PATTERNS.some((pattern) =>
    pattern.test(text)
  );
}

function buildParentEvidenceCorpus(
  request: TaskRelationAdjudicationRequest
) {
  return [
    request.activeParent.topic,
    request.activeParent.compactObjective,
    ...request.activeParent.acceptedConstraints.map((item) => item.text),
    ...request.activeParent.sharedScenarioEntities,
    request.activeChild?.question,
    ...request.recentSourceEvidence.map((item) => item.text),
    ...request.recentTransitions.map((item) => item.text),
    request.suspendedParent?.topic,
    request.suspendedParent?.compactObjective,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

function isTaskRelationDependency(
  value: unknown
): value is TaskRelationDependency {
  return TASK_RELATION_DEPENDENCIES.includes(
    value as TaskRelationDependency
  );
}

export function isRuntimeTaskRelation(
  value: unknown
): value is RuntimeTaskRelation {
  return RUNTIME_TASK_RELATIONS.includes(
    value as RuntimeTaskRelation
  );
}

function isTaskRelationContinuationShape(
  value: unknown
): value is TaskRelationContinuationShape {
  return TASK_RELATION_CONTINUATION_SHAPES.includes(
    value as TaskRelationContinuationShape
  );
}

function isTaskRelationReturnIntent(
  value: unknown
): value is TaskRelationReturnIntent {
  return TASK_RELATION_RETURN_INTENTS.includes(
    value as TaskRelationReturnIntent
  );
}

function isTaskRelationSwitchIntent(
  value: unknown
): value is TaskRelationSwitchIntent {
  return TASK_RELATION_SWITCH_INTENTS.includes(
    value as TaskRelationSwitchIntent
  );
}

function isTaskRelationStandaloneSufficiency(
  value: unknown
): value is TaskRelationStandaloneSufficiency {
  return TASK_RELATION_STANDALONE_SUFFICIENCIES.includes(
    value as TaskRelationStandaloneSufficiency
  );
}

function isEvidenceSpanArray(value: unknown, requireOne: boolean) {
  return (
    Array.isArray(value) &&
    (!requireOne || value.length > 0) &&
    value.length <= 8 &&
    value.every(
      (span) => typeof span === "string" && Boolean(span.trim())
    )
  );
}

function normalizeParentEvidenceSpans(
  canonicalValue: unknown,
  aliasValue: unknown,
  aliasPresent: boolean
):
  | { ok: true; value: string[]; aliasApplied: boolean }
  | { ok: false; reason: string } {
  if (!aliasPresent) {
    return isEvidenceSpanArray(canonicalValue, false)
      ? {
          ok: true,
          value: canonicalValue as string[],
          aliasApplied: false,
        }
      : { ok: false, reason: "invalid-parent-evidence-spans" };
  }
  if (typeof aliasValue === "string") {
    return aliasValue.trim()
      ? { ok: true, value: [aliasValue], aliasApplied: true }
      : { ok: false, reason: "invalid-parent-evidence-alias" };
  }
  return isEvidenceSpanArray(aliasValue, false)
    ? {
        ok: true,
        value: aliasValue as string[],
        aliasApplied: true,
      }
    : { ok: false, reason: "invalid-parent-evidence-alias" };
}

function allSpansGrounded(spans: string[], corpus: string) {
  const normalizedCorpus = corpus.toLocaleLowerCase();
  return spans.every((span) =>
    normalizedCorpus.includes(span.toLocaleLowerCase())
  );
}

function parseFailure(
  reason: string,
  errorKind: "parse" | "schema" | "evidence" | "provider"
): TaskRelationAdjudicationParseResult {
  return {
    ok: false,
    reason,
    errorKind,
    evidenceSpansValid: false,
  };
}

function stripJsonFence(value: string) {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(value);
  return match?.[1]?.trim() ?? value;
}

function boundText(value: string, maxChars: number) {
  return value.replace(/\s+/gu, " ").trim().slice(0, maxChars);
}

function uniqueStrings(values: Array<string | undefined>) {
  return Array.from(
    new Set(values.filter((value): value is string => Boolean(value)))
  );
}

function estimateWordEquivalents(value: string) {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const cjkCharacters =
    normalized.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu
    )?.length ?? 0;
  const words = normalized
    .replace(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
      " "
    )
    .split(/\s+/u)
    .filter(Boolean).length;
  return words + Math.ceil(cjkCharacters / 2);
}

function normalizeConfidence(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0;
}

const TRANSITION_EVIDENCE_PATTERNS = [
  /\b(?:now|next|then)\s+(?:let'?s\s+)?(?:move|switch|turn|go)\s+(?:on\s+)?(?:to|into)\b/iu,
  /\b(?:a|the)\s+(?:new|separate|unrelated)\s+(?:question|problem|task)\b/iu,
  /\b(?:back|return|resume|go back)\s+(?:to|into)\b/iu,
  /\b(?:original|previous)\s+(?:question|task|design|architecture|problem)\b/iu,
];
