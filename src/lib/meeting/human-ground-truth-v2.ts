import { STORAGE_KEYS } from "../../config/constants.js";
import { safeLocalStorage } from "../storage/helper.js";
import {
  fromHumanEvalQuestionType,
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";
import type {
  ExpectedAdvisorAction,
  HumanEvaluationVerdict,
  HumanExpectedParentAction,
  HumanEvaluationTaskRelation,
  FactAnchorState,
  InterviewPlaybookPhase,
  MeetingTrace,
  MeetingTraceStatus,
  ProjectTrajectoryChildContinuity,
  QuestionHumanEvaluation,
  HumanEvaluationCollectionProvenance,
} from "./types.js";
import type { AdvisorContextReadScope } from "./response-only-task-scope.js";
import type { SettledAdvisorArtifactIntent } from "./settled-advisor-execution-plan.js";
import {
  projectQuestionTypeObservation,
  type DurableQuestionOwnerMissingReason,
} from "./question-type-observation.js";
import {
  projectQuestionTypeConsumerObservationFromTrace,
  type QuestionTypeConsumerObservation,
} from "./question-type-consumer-observation.js";
import {
  meetingCompanyLabelsEqual,
  projectMeetingMetadataEvaluationObservation,
  type MeetingMetadataEvaluationErrorKind,
  type MeetingMetadataEvaluationObservation,
  type MeetingMetadataMutationDisposition,
} from "./meeting-metadata-evaluation.js";
import { projectObservedAdvisorAttempt } from "./observed-advisor-outcome.js";
import { resolveCurrentQuestionSourceKind } from "./current-question-source.js";

export type ObservedQuestionSourceKind = "voice" | "screen" | "mixed";

export const HUMAN_GROUND_TRUTH_SCHEMA_VERSION = 2 as const;
export const HUMAN_EVALUATION_DERIVATION_VERSION =
  "human-evaluation-v2.10";

export type HumanGroundTruthConfirmation = "confirmed" | "suggested";

export type HumanGroundTruthSource =
  | "explicit-ui"
  | "manual-type-correction"
  | "manual-force-advise"
  | "manual-term-correction"
  | "manual-context-action"
  | "imported-legacy";

export interface HumanGroundTruthSubjectV2 {
  attemptId?: string;
  questionId?: string;
  momentId?: string;
  taskId?: string;
  traceIds: string[];
  sourceTurnIds: string[];
}

export interface HumanGroundTruthInteractionV2 {
  startedAt: number;
  durationMs: number;
  clickCount: number;
  expandedRegions: string[];
}

export interface HumanGroundTruthEvaluationTargetV2 {
  attemptId?: string;
  questionId?: string;
  taskId?: string;
  logicalQuestionUnitId?: string;
  logicalQuestionUnitRevision?: number;
  currentTurnId?: string;
  sourceTurnIds: string[];
  sourceTraceId?: string;
  repairTraceId?: string;
  frozenAt: number;
}

export interface ExpectedTaskSettlementFactV2 {
  kind: "expected-task-settlement";
  expectedQuestionType: CanonicalQuestionType;
  expectedRelation: HumanEvaluationTaskRelation;
  expectedParentAction: HumanExpectedParentAction;
  expectedParentId?: string;
  expectedBranchId?: string;
  expectedContextOwnerId?: string;
}

export interface TaskSettlementTupleCompatibilityV2 {
  compatible: boolean;
  relation: HumanEvaluationTaskRelation;
  parentAction: HumanExpectedParentAction;
  recommendedParentAction: HumanExpectedParentAction;
  reason?: string;
}

export interface ExpectedQuestionTypeFactV2 {
  kind: "expected-question-type";
  expectedQuestionType: CanonicalQuestionType;
  correctionScope?: string;
}

export interface ExpectedRuntimeActionFactV2 {
  kind: "expected-runtime-action";
  expectedAction: ExpectedAdvisorAction;
}

export interface ExpectedContextReadScopeFactV2 {
  kind: "expected-context-read-scope";
  expectedScope: AdvisorContextReadScope;
}

export interface ExpectedArtifactIntentFactV2 {
  kind: "expected-artifact-intent";
  expectedIntent: SettledAdvisorArtifactIntent;
}

export interface PrimaryAskCorrectionFactV2 {
  kind: "primary-ask-correction";
  correctedPrimaryAsk: string;
}

export interface AnswerQualityFactV2 {
  kind: "answer-quality";
  outcome: "useful" | "partial" | "wrong" | "no-answer";
  failureReasons: string[];
  expectedContextTurnIds: string[];
}

export interface MemoryLabelFactV2 {
  kind: "memory-label";
  verdict: "relevant" | "irrelevant" | "missing" | "forbidden";
  memoryIds: string[];
}

export interface ArtifactQualityFactV2 {
  kind: "artifact-quality";
  artifact: "code" | "complexity" | "whiteboard";
  verdict: "useful" | "partial" | "wrong" | "missing";
}

export interface ExpectedProjectTrajectoryFactV2 {
  kind: "expected-project-trajectory";
  expectedProjectId?: string;
  expectedProjectName?: string;
  expectedPhase?: InterviewPlaybookPhase;
  expectedFactAnchorState?: FactAnchorState;
  expectedChildContinuity?: ProjectTrajectoryChildContinuity;
  unsupportedFirstPersonClaim?: boolean;
}

export interface ExpectedMeetingMetadataFactV2 {
  kind: "expected-meeting-metadata";
  sourceCompany?: string | null;
  expectedEffectiveCompany?: string | null;
  expectedMutationDisposition?: MeetingMetadataMutationDisposition;
  errorKind?: MeetingMetadataEvaluationErrorKind;
}

export type HumanGroundTruthFactV2 =
  | ExpectedTaskSettlementFactV2
  | ExpectedQuestionTypeFactV2
  | ExpectedRuntimeActionFactV2
  | ExpectedContextReadScopeFactV2
  | ExpectedArtifactIntentFactV2
  | PrimaryAskCorrectionFactV2
  | AnswerQualityFactV2
  | MemoryLabelFactV2
  | ArtifactQualityFactV2
  | ExpectedProjectTrajectoryFactV2
  | ExpectedMeetingMetadataFactV2;

export interface HumanGroundTruthEventV2 {
  schemaVersion: typeof HUMAN_GROUND_TRUTH_SCHEMA_VERSION;
  eventId: string;
  sessionId: string;
  subject: HumanGroundTruthSubjectV2;
  fact: HumanGroundTruthFactV2;
  provenance: {
    source: HumanGroundTruthSource;
    actor: "human";
    collection: HumanEvaluationCollectionProvenance;
    sourceTraceId?: string;
    repairTraceId?: string;
    actionId?: string;
    uiSurface?: string;
    recordedAt: number;
    interaction?: HumanGroundTruthInteractionV2;
    evaluationTarget?: HumanGroundTruthEvaluationTargetV2;
  };
  confirmation: HumanGroundTruthConfirmation;
  supersedesEventId?: string;
}

export interface HumanEvaluationObservedSnapshotV2 {
  traceId: string;
  traceHash: string;
  attemptStatus?: MeetingTraceStatus;
  questionType?: CanonicalQuestionType;
  relation?: HumanEvaluationTaskRelation;
  parentAction?: HumanExpectedParentAction;
  questionSourceKind?: ObservedQuestionSourceKind;
  settledParentId?: string;
  settledChildId?: string;
  settledBranchId?: string;
  contextOwnerId?: string;
  runtimeAction?: ExpectedAdvisorAction;
  runtimeOperationId?: string;
  advisorOutcome?:
    | "suppressed"
    | "model-completed"
    | "delivery-pending"
    | "visible-committed"
    | "stale-dropped"
    | "cancelled-by-new-job"
    | "cancelled-by-runtime-boundary"
    | "error";
  contextReadScope?: AdvisorContextReadScope;
  artifactIntent?: SettledAdvisorArtifactIntent;
  primaryAsk?: string;
  answerCommitted?: boolean;
  projectId?: string;
  projectName?: string;
  projectBindingRevision?: number;
  playbookPhase?: InterviewPlaybookPhase;
  factAnchorState?: FactAnchorState;
  childContinuity?: ProjectTrajectoryChildContinuity;
  observedCurrentQuestionType?: CanonicalQuestionType;
  observedCurrentQuestionTypeAuthority?: string;
  observedParentType?: CanonicalQuestionType;
  observedParentId?: string;
  typeAppliedToResponse?: boolean;
  typeAppliedToSettlement?: boolean;
  typeAppliedToParent?: boolean;
  durableOwnerMissing?: boolean;
  durableOwnerMissingReason?: DurableQuestionOwnerMissingReason;
  questionTypeConsumer?: QuestionTypeConsumerObservation;
  meetingMetadata?: MeetingMetadataEvaluationObservation;
}

export interface HumanEvaluationConflictV2 {
  factKind: HumanGroundTruthFactV2["kind"];
  eventIds: string[];
  reason: "same-priority-conflict";
}

export interface HumanEvaluationProjectionV2 {
  schemaVersion: 2;
  projectionId: string;
  sessionId: string;
  subject: HumanGroundTruthSubjectV2;
  derivationVersion: typeof HUMAN_EVALUATION_DERIVATION_VERSION;
  inputEventIds: string[];
  semanticInputEventIds: string[];
  interventionOnlyEventIds: string[];
  inputTraceHashes: string[];
  observed?: HumanEvaluationObservedSnapshotV2;
  interaction?: HumanGroundTruthInteractionV2;
  activeFacts: Partial<
    Record<HumanGroundTruthFactV2["kind"], HumanGroundTruthEventV2>
  >;
  verdicts: {
    runtimeActionCorrect?: boolean;
    questionTypeCorrect?: boolean;
    relationCorrect?: boolean;
    parentActionCorrect?: boolean;
    parentIdentityCorrect?: boolean;
    branchIdentityCorrect?: boolean;
    contextOwnerCorrect?: boolean;
    taskSettlementCorrect?: boolean;
    answerOutcome?: AnswerQualityFactV2["outcome"];
    contextReadScopeCorrect?: boolean;
    artifactIntentCorrect?: boolean;
    projectCorrect?: boolean;
    playbookPhaseCorrect?: boolean;
    factSupportCorrect?: boolean;
    childContinuityCorrect?: boolean;
    unsupportedFirstPersonClaim?: boolean;
    meetingMetadataProposalCorrect?: boolean;
    meetingMetadataTargetCorrect?: boolean;
    meetingMetadataMutationCorrect?: boolean;
  };
  conflicts: HumanEvaluationConflictV2[];
  computedAt: number;
}

export function createHumanGroundTruthEventV2(input: {
  sessionId: string;
  subject: HumanGroundTruthSubjectV2;
  fact: HumanGroundTruthFactV2;
  source: HumanGroundTruthSource;
  collection?: HumanEvaluationCollectionProvenance;
  confirmation?: HumanGroundTruthConfirmation;
  sourceTraceId?: string;
  repairTraceId?: string;
  actionId?: string;
  uiSurface?: string;
  interaction?: HumanGroundTruthInteractionV2;
  evaluationTarget?: HumanGroundTruthEvaluationTargetV2;
  supersedesEventId?: string;
  eventId?: string;
  now?: number;
}): HumanGroundTruthEventV2 {
  const now = input.now ?? Date.now();
  return {
    schemaVersion: HUMAN_GROUND_TRUTH_SCHEMA_VERSION,
    eventId:
      input.eventId ??
      `human_truth_v2_${now}_${Math.random().toString(36).slice(2, 8)}`,
    sessionId: input.sessionId,
    subject: normalizeSubject(input.subject),
    fact: normalizeFact(input.fact),
    provenance: {
      source: input.source,
      actor: "human",
      collection: input.collection ?? "organic",
      sourceTraceId: cleanOptional(input.sourceTraceId),
      repairTraceId: cleanOptional(input.repairTraceId),
      actionId: cleanOptional(input.actionId),
      uiSurface: cleanOptional(input.uiSurface),
      recordedAt: now,
      interaction: normalizeInteraction(input.interaction, now),
      evaluationTarget: normalizeEvaluationTarget(
        input.evaluationTarget,
        now
      ),
    },
    confirmation: input.confirmation ?? "confirmed",
    supersedesEventId: cleanOptional(input.supersedesEventId),
  };
}

export function evaluateTaskSettlementTupleCompatibilityV2(input: {
  relation: HumanEvaluationTaskRelation;
  parentAction: HumanExpectedParentAction;
}): TaskSettlementTupleCompatibilityV2 {
  const recommendedParentAction =
    recommendedParentActionForRelation(input.relation);
  const compatible =
    input.parentAction === recommendedParentAction ||
    (input.relation === "child-probe" && input.parentAction === "preserve");
  return {
    compatible,
    relation: input.relation,
    parentAction: input.parentAction,
    recommendedParentAction,
    reason: compatible
      ? undefined
      : `${input.relation} normally requires ${recommendedParentAction}, not ${input.parentAction}.`,
  };
}

export function freezeObservedTaskOwnerIdentityV2(
  observed: HumanEvaluationObservedSnapshotV2 | undefined
): Pick<
  ExpectedTaskSettlementFactV2,
  "expectedParentId" | "expectedBranchId" | "expectedContextOwnerId"
> {
  return {
    expectedParentId: observed?.settledParentId,
    expectedBranchId: observed?.settledBranchId,
    expectedContextOwnerId: observed?.contextOwnerId,
  };
}

export function appendHumanGroundTruthEventV2(
  events: HumanGroundTruthEventV2[],
  event: HumanGroundTruthEventV2
) {
  const duplicate = events.some(
    (candidate) =>
      candidate.eventId === event.eventId ||
      (event.provenance.actionId &&
        candidate.provenance.actionId === event.provenance.actionId &&
        candidate.fact.kind === event.fact.kind &&
        subjectsMatch(candidate.subject, event.subject))
  );
  return duplicate ? events : [...events, event];
}

export function isHumanGroundTruthSemanticEligibleV2(
  event: HumanGroundTruthEventV2
) {
  return !(
    event.provenance.collection === "scripted-validation" &&
    event.provenance.source !== "explicit-ui"
  );
}

export function projectHumanGroundTruthEventsForSessionPurposeV2(
  events: HumanGroundTruthEventV2[],
  scriptedValidation: boolean
): HumanGroundTruthEventV2[] {
  return events.map((event) => {
    if (event.provenance.source === "imported-legacy") return event;
    const collection: HumanEvaluationCollectionProvenance = scriptedValidation
      ? "scripted-validation"
      : "organic";
    return event.provenance.collection === collection
      ? event
      : {
          ...event,
          provenance: {
            ...event.provenance,
            collection,
          },
        };
  });
}

export function findActiveHumanGroundTruthEventV2(
  events: HumanGroundTruthEventV2[],
  subject: HumanGroundTruthSubjectV2,
  factKind: HumanGroundTruthFactV2["kind"]
) {
  const supersededIds = new Set(
    events
      .map((event) => event.supersedesEventId)
      .filter((value): value is string => Boolean(value))
  );
  return events
    .filter(
      (event) =>
        event.fact.kind === factKind &&
        subjectsMatch(event.subject, subject) &&
        !supersededIds.has(event.eventId)
    )
    .sort(
      (left, right) =>
        eventPriority(right) - eventPriority(left) ||
        right.provenance.recordedAt - left.provenance.recordedAt
    )[0];
}

export function deriveHumanEvaluationProjectionV2(input: {
  sessionId: string;
  subject: HumanGroundTruthSubjectV2;
  events: HumanGroundTruthEventV2[];
  observed?: HumanEvaluationObservedSnapshotV2;
  legacyEvaluation?: QuestionHumanEvaluation;
  now?: number;
}): HumanEvaluationProjectionV2 {
  const imported = input.legacyEvaluation
    ? importLegacyQuestionEvaluationV2(input.legacyEvaluation, input.sessionId)
    : [];
  const candidates = [...input.events, ...imported].filter(
    (event) =>
      event.sessionId === input.sessionId &&
      subjectsMatch(event.subject, input.subject)
  );
  const supersededIds = new Set(
    candidates
      .map((event) => event.supersedesEventId)
      .filter((value): value is string => Boolean(value))
  );
  const activeCandidates = candidates.filter(
    (event) => !supersededIds.has(event.eventId)
  );
  const semanticCandidates = activeCandidates.filter(
    isHumanGroundTruthSemanticEligibleV2
  );
  const activeFacts: HumanEvaluationProjectionV2["activeFacts"] = {};
  const conflicts: HumanEvaluationConflictV2[] = [];

  for (const kind of uniqueFactKinds(semanticCandidates)) {
    const sameKind = semanticCandidates.filter(
      (event) => event.fact.kind === kind
    );
    const highestPriority = Math.max(...sameKind.map(eventPriority));
    const leaders = sameKind.filter(
      (event) => eventPriority(event) === highestPriority
    );
    const distinctFacts = new Set(
      leaders.map((event) => stableStringify(event.fact))
    );
    if (distinctFacts.size > 1) {
      conflicts.push({
        factKind: kind,
        eventIds: leaders.map((event) => event.eventId),
        reason: "same-priority-conflict",
      });
      continue;
    }
    activeFacts[kind] = [...leaders].sort(
      (left, right) =>
        right.provenance.recordedAt - left.provenance.recordedAt
    )[0];
  }

  const settlement = activeFacts["expected-task-settlement"]?.fact;
  const typeOnly = activeFacts["expected-question-type"]?.fact;
  const runtime = activeFacts["expected-runtime-action"]?.fact;
  const answer = activeFacts["answer-quality"]?.fact;
  const contextReadScope =
    activeFacts["expected-context-read-scope"]?.fact;
  const artifactIntent =
    activeFacts["expected-artifact-intent"]?.fact;
  const projectTrajectory =
    activeFacts["expected-project-trajectory"]?.fact;
  const meetingMetadata =
    activeFacts["expected-meeting-metadata"]?.fact;
  const expectedQuestionType =
    settlement?.kind === "expected-task-settlement"
      ? settlement.expectedQuestionType
      : typeOnly?.kind === "expected-question-type"
        ? typeOnly.expectedQuestionType
        : undefined;
  const parentIdentityCorrect =
    settlement?.kind === "expected-task-settlement"
      ? compareExpectedIdentity(
          settlement.expectedParentId,
          input.observed?.settledParentId
        )
      : undefined;
  const branchIdentityCorrect =
    settlement?.kind === "expected-task-settlement"
      ? compareExpectedIdentity(
          settlement.expectedBranchId,
          input.observed?.settledBranchId
        )
      : undefined;
  const contextOwnerCorrect =
    settlement?.kind === "expected-task-settlement"
      ? compareExpectedIdentity(
          settlement.expectedContextOwnerId,
          input.observed?.contextOwnerId
        )
      : undefined;
  const relationCorrect =
    settlement?.kind === "expected-task-settlement" &&
    input.observed?.relation
      ? settlement.expectedRelation === input.observed.relation
      : undefined;
  const parentActionCorrect =
    settlement?.kind === "expected-task-settlement" &&
    input.observed?.parentAction
      ? settlement.expectedParentAction === input.observed.parentAction
      : undefined;
  const identityVerdicts = [
    parentIdentityCorrect,
    branchIdentityCorrect,
    contextOwnerCorrect,
  ].filter((value): value is boolean => value !== undefined);
  const taskSettlementCorrect =
    relationCorrect !== undefined &&
    parentActionCorrect !== undefined &&
    identityVerdicts.length > 0
      ? relationCorrect &&
        parentActionCorrect &&
        identityVerdicts.every(Boolean)
      : undefined;

  return {
    schemaVersion: 2,
    projectionId: `human_projection_v2_${fingerprint(
      `${input.sessionId}:${subjectKey(input.subject)}`
    )}`,
    sessionId: input.sessionId,
    subject: normalizeSubject(input.subject),
    observed: input.observed,
    interaction: summarizeInteraction(activeCandidates),
    derivationVersion: HUMAN_EVALUATION_DERIVATION_VERSION,
    inputEventIds: activeCandidates.map((event) => event.eventId),
    semanticInputEventIds: semanticCandidates.map((event) => event.eventId),
    interventionOnlyEventIds: activeCandidates
      .filter((event) => !isHumanGroundTruthSemanticEligibleV2(event))
      .map((event) => event.eventId),
    inputTraceHashes: input.observed ? [input.observed.traceHash] : [],
    activeFacts,
    verdicts: {
      runtimeActionCorrect:
        runtime?.kind === "expected-runtime-action" &&
        input.observed?.runtimeAction
          ? runtime.expectedAction === input.observed.runtimeAction
          : undefined,
      questionTypeCorrect:
        expectedQuestionType && input.observed?.questionType
          ? expectedQuestionType === input.observed.questionType
          : undefined,
      relationCorrect:
        relationCorrect,
      parentActionCorrect:
        parentActionCorrect,
      parentIdentityCorrect,
      branchIdentityCorrect,
      contextOwnerCorrect,
      taskSettlementCorrect,
      answerOutcome:
        answer?.kind === "answer-quality" ? answer.outcome : undefined,
      contextReadScopeCorrect:
        contextReadScope?.kind === "expected-context-read-scope" &&
        input.observed?.contextReadScope
          ? contextReadScope.expectedScope ===
            input.observed.contextReadScope
          : undefined,
      artifactIntentCorrect:
        artifactIntent?.kind === "expected-artifact-intent" &&
        input.observed?.artifactIntent
          ? normalizeArtifactIntentEvaluationFamily(
              artifactIntent.expectedIntent
            ) ===
            normalizeArtifactIntentEvaluationFamily(
              input.observed.artifactIntent
            )
          : undefined,
      projectCorrect:
        projectTrajectory?.kind === "expected-project-trajectory"
          ? compareExpectedProject(
              projectTrajectory,
              input.observed
            )
          : undefined,
      playbookPhaseCorrect:
        projectTrajectory?.kind === "expected-project-trajectory" &&
        projectTrajectory.expectedPhase &&
        input.observed?.playbookPhase
          ? projectTrajectory.expectedPhase ===
            input.observed.playbookPhase
          : undefined,
      factSupportCorrect:
        projectTrajectory?.kind === "expected-project-trajectory" &&
        projectTrajectory.expectedFactAnchorState &&
        input.observed?.factAnchorState
          ? projectTrajectory.expectedFactAnchorState ===
            input.observed.factAnchorState
          : undefined,
      childContinuityCorrect:
        projectTrajectory?.kind === "expected-project-trajectory" &&
        projectTrajectory.expectedChildContinuity &&
        input.observed?.childContinuity
          ? projectTrajectory.expectedChildContinuity ===
            input.observed.childContinuity
          : undefined,
      unsupportedFirstPersonClaim:
        projectTrajectory?.kind === "expected-project-trajectory"
          ? projectTrajectory.unsupportedFirstPersonClaim
          : undefined,
      meetingMetadataProposalCorrect:
        meetingMetadata?.kind === "expected-meeting-metadata" &&
        meetingMetadata.sourceCompany !== undefined &&
        input.observed?.meetingMetadata?.operationObserved
          ? meetingCompanyLabelsEqual(
              meetingMetadata.sourceCompany,
              input.observed.meetingMetadata.proposalCompany
            )
          : undefined,
      meetingMetadataTargetCorrect:
        meetingMetadata?.kind === "expected-meeting-metadata" &&
        meetingMetadata.expectedEffectiveCompany !== undefined &&
        input.observed?.meetingMetadata?.operationObserved
          ? meetingCompanyLabelsEqual(
              meetingMetadata.expectedEffectiveCompany,
              input.observed.meetingMetadata.effectiveCompany
            )
          : undefined,
      meetingMetadataMutationCorrect:
        meetingMetadata?.kind === "expected-meeting-metadata" &&
        meetingMetadata.expectedMutationDisposition !== undefined &&
        input.observed?.meetingMetadata?.operationObserved
          ? meetingMetadata.expectedMutationDisposition ===
            input.observed.meetingMetadata.mutationOutcome
          : undefined,
    },
    conflicts,
    computedAt: input.now ?? Date.now(),
  };
}

export function buildHumanEvaluationObservedSnapshotV2(
  trace: MeetingTrace
): HumanEvaluationObservedSnapshotV2 {
  const metadata = trace.metadata ?? {};
  const questionTypeObservation = projectQuestionTypeObservation({ metadata });
  const questionType =
    questionTypeObservation.observedCurrentQuestionType;
  const questionSourceKind = resolveObservedQuestionSourceKind(
    trace.kind,
    metadata
  );
  const currentOnly =
    readBoolean(metadata.effectiveAdvisorCurrentOnly) === true ||
    (readString(metadata.settledExecutionPlanContextReadScope) ===
      "current-only" &&
      readBoolean(metadata.settledExecutionPlanRelationApplicable) ===
        false);
  const relation: HumanEvaluationTaskRelation | undefined = currentOnly
    ? "none"
    : normalizeRelation(
        metadata.effectiveCurrentQuestionSettlementRelation ??
          metadata.currentQuestionSettlementRelation ??
          metadata.settledExecutionPlanTaskRelation ??
          metadata.taskRelation ??
          metadata.relationToActiveTask
      );
  const parentAction = resolveObservedParentAction(
    relation,
    readBoolean(
      metadata.effectiveCurrentQuestionSettlementParentMutationAuthorized ??
        metadata.currentQuestionSettlementParentMutationAuthorized
    ),
    readString(metadata.settledExecutionPlanTaskMutationCommand),
    currentOnly
  );
  const advisorAttempt = projectObservedAdvisorAttempt(metadata);
  const runtimeAction = advisorAttempt.runtimeAction;
  const runtimeOperationId = readString(
    metadata.questionTypeAdjudicationOutcomeOperationId ??
      metadata.questionTypeAdjudicationOperationId ??
      metadata.advisorJobId
  );
  const advisorOutcome = advisorAttempt.outcome;
  const primaryAsk = readString(
    metadata.primaryAskNormalizedText ?? metadata.logicalQuestionNormalizedText
  );
  const answerCommitted = advisorAttempt.answerCommitted;
  const contextReadScope = resolveObservedContextReadScope(
    trace.kind,
    metadata,
    answerCommitted
  );
  const artifactIntent = resolveObservedArtifactIntent(
    trace.kind,
    metadata,
    answerCommitted
  );
  const settledParentId = currentOnly
    ? undefined
    : readString(
        metadata.effectiveCurrentQuestionSettlementParentId ??
          metadata.settledExecutionPlanPostMutationParentId ??
          metadata.activeMeetingParentId ??
          metadata.currentQuestionSettlementParentAfterId
      );
  const settledChildId = currentOnly
    ? undefined
    : readString(
        metadata.effectiveCurrentQuestionSettlementChildId ??
          metadata.activeMeetingChildId
      );
  const settledBranchId =
    relation === "child-probe" && settledChildId
      ? settledChildId
      : settledParentId;
  const sourceQuestionOwnerId = readString(
    metadata.effectiveCurrentQuestionSettlementUnitId ??
      metadata.currentQuestionSettlementUnitId ??
      metadata.logicalQuestionUnitId
  );
  const contextOwnerId =
    contextReadScope === "active-child-read"
      ? settledChildId
      : contextReadScope === "active-parent-read"
        ? settledParentId
        : sourceQuestionOwnerId;
  const projectId = readString(
    metadata.activeMeetingProjectBindingId ??
      metadata.projectBindingProjectId
  );
  const projectName = readString(
    metadata.activeMeetingProjectBindingName ??
      metadata.projectBindingProjectName
  );
  const projectBindingRevision = readNumber(
    metadata.activeMeetingProjectBindingRevision ??
      metadata.projectBindingRevision
  );
  const playbookPhase = normalizePlaybookPhase(
    metadata.activeMeetingParentPhase ??
      metadata.playbookPhaseDecisionPhase ??
      metadata.playbookPhase
  );
  const factAnchorState = normalizeFactAnchorState(
    metadata.factAnchorState
  );
  const childContinuity = resolveObservedChildContinuity(metadata);
  const meetingMetadata = projectMeetingMetadataEvaluationObservation(
    metadata
  );
  const questionTypeConsumer =
    projectQuestionTypeConsumerObservationFromTrace(metadata);
  const traceEvidence = {
    traceId: trace.id,
    attemptStatus: trace.status,
    questionType,
    relation,
    parentAction,
    questionSourceKind,
    settledParentId,
    settledChildId,
    settledBranchId,
    contextOwnerId,
    runtimeAction,
    runtimeOperationId,
    advisorOutcome,
    primaryAsk,
    answerCommitted,
    contextReadScope,
    artifactIntent,
    projectId,
    projectName,
    projectBindingRevision,
    playbookPhase,
    factAnchorState,
    childContinuity,
    questionTypeConsumer,
    meetingMetadata: meetingMetadata.operationObserved
      ? meetingMetadata
      : undefined,
    ...questionTypeObservation,
  };
  return {
    ...traceEvidence,
    traceHash: fingerprint(stableStringify(traceEvidence)),
  };
}

export function resolveObservedQuestionSourceKind(
  traceKind: MeetingTrace["kind"],
  metadata: Record<string, unknown>
): ObservedQuestionSourceKind {
  const sourceTurnIds = readStringArray(
    metadata.settledExecutionPlanSourceTurnIds ??
      metadata.currentQuestionSettlementSourceTurnIds ??
      metadata.currentQuestionSourceTurnIds
  );
  const sourceObservationIds = readStringArray(
    metadata.settledExecutionPlanSourceObservationIds ??
      metadata.currentQuestionSettlementSourceObservationIds ??
      metadata.currentQuestionSourceObservationIds
  );
  return resolveCurrentQuestionSourceKind({
    sourceTurnIds,
    sourceObservationIds,
    fallback: traceKind === "screen" ? "screen" : "voice",
  });
}

export function buildHumanGroundTruthSubjectV2(input: {
  trace: MeetingTrace;
  evaluation?: QuestionHumanEvaluation;
}) {
  const metadata = input.trace.metadata ?? {};
  return normalizeSubject({
    attemptId: input.trace.id,
    questionId:
      input.evaluation?.questionId ??
      readString(metadata.questionInstanceId) ??
      `trace:${input.trace.id}`,
    taskId:
      input.evaluation?.taskId ??
      readString(metadata.activeMeetingTaskId ?? metadata.taskId),
    traceIds: uniqueStrings([
      ...(input.evaluation?.traceIds ?? []),
      input.trace.id,
    ]),
    sourceTurnIds: readStringArray(
      metadata.logicalQuestionSourceTurnIds ??
        metadata.currentQuestionSourceTurnIds
    ),
  });
}

export function importLegacyQuestionEvaluationV2(
  evaluation: QuestionHumanEvaluation,
  fallbackSessionId: string
): HumanGroundTruthEventV2[] {
  const sessionId = evaluation.sessionId ?? fallbackSessionId;
  const subject = normalizeSubject({
    questionId: evaluation.questionId,
    taskId: evaluation.taskId,
    traceIds: evaluation.traceIds,
    sourceTurnIds: [],
  });
  const base = {
    sessionId,
    subject,
    source: "imported-legacy" as const,
    collection: "replay" as const,
    confirmation: "confirmed" as const,
    sourceTraceId: evaluation.traceIds[0],
    now: evaluation.updatedAt,
  };
  const events: HumanGroundTruthEventV2[] = [];
  if (evaluation.advisorIntent?.expectedAction) {
    events.push(
      createHumanGroundTruthEventV2({
        ...base,
        eventId: `legacy:${evaluation.id}:runtime-action`,
        actionId: `legacy:${evaluation.id}:runtime-action`,
        fact: {
          kind: "expected-runtime-action",
          expectedAction: evaluation.advisorIntent.expectedAction,
        },
      })
    );
  }
  const expectedQuestionType = evaluation.correctedQuestionType
    ? fromHumanEvalQuestionType(evaluation.correctedQuestionType)
    : undefined;
  if (
    expectedQuestionType &&
    evaluation.expectedRelation &&
    evaluation.expectedParentAction
  ) {
    events.push(
      createHumanGroundTruthEventV2({
        ...base,
        eventId: `legacy:${evaluation.id}:task-settlement`,
        actionId: `legacy:${evaluation.id}:task-settlement`,
        fact: {
          kind: "expected-task-settlement",
          expectedQuestionType,
          expectedRelation: evaluation.expectedRelation,
          expectedParentAction: evaluation.expectedParentAction,
          expectedParentId: evaluation.expectedParentId,
          expectedBranchId: evaluation.expectedBranchId,
          expectedContextOwnerId: evaluation.expectedContextOwnerId,
        },
      })
    );
  } else if (expectedQuestionType) {
    events.push(
      createHumanGroundTruthEventV2({
        ...base,
        eventId: `legacy:${evaluation.id}:question-type`,
        actionId: `legacy:${evaluation.id}:question-type`,
        fact: {
          kind: "expected-question-type",
          expectedQuestionType,
          correctionScope: evaluation.manualQuestionTypeCorrectionScope,
        },
      })
    );
  }
  if (evaluation.answer.verdict !== "not_applicable") {
    events.push(
      createHumanGroundTruthEventV2({
        ...base,
        eventId: `legacy:${evaluation.id}:answer-quality`,
        actionId: `legacy:${evaluation.id}:answer-quality`,
        fact: {
          kind: "answer-quality",
          outcome: mapLegacyAnswerOutcome(evaluation.answer.verdict),
          failureReasons: [...evaluation.answer.reasons],
          expectedContextTurnIds: [
            ...(evaluation.expectedContextTurnIds ?? []),
          ],
        },
      })
    );
  }
  if (evaluation.correctedCompany?.trim()) {
    events.push(
      createHumanGroundTruthEventV2({
        ...base,
        eventId: `legacy:${evaluation.id}:meeting-metadata`,
        actionId: `legacy:${evaluation.id}:meeting-metadata`,
        fact: {
          kind: "expected-meeting-metadata",
          expectedEffectiveCompany: evaluation.correctedCompany,
        },
      })
    );
  }
  const projectTrajectory = evaluation.projectTrajectory;
  if (
    projectTrajectory &&
    (projectTrajectory.expectedProjectId ||
      projectTrajectory.expectedProjectName ||
      projectTrajectory.expectedPhase ||
      projectTrajectory.expectedFactAnchorState ||
      projectTrajectory.expectedChildContinuity ||
      projectTrajectory.unsupportedFirstPersonClaim !== undefined)
  ) {
    events.push(
      createHumanGroundTruthEventV2({
        ...base,
        eventId: `legacy:${evaluation.id}:project-trajectory`,
        actionId: `legacy:${evaluation.id}:project-trajectory`,
        fact: {
          kind: "expected-project-trajectory",
          expectedProjectId: projectTrajectory.expectedProjectId,
          expectedProjectName: projectTrajectory.expectedProjectName,
          expectedPhase: projectTrajectory.expectedPhase,
          expectedFactAnchorState:
            projectTrajectory.expectedFactAnchorState,
          expectedChildContinuity:
            projectTrajectory.expectedChildContinuity,
          unsupportedFirstPersonClaim:
            projectTrajectory.unsupportedFirstPersonClaim,
        },
      })
    );
  }
  return events;
}

export function readHumanGroundTruthEventsV2() {
  return readStoredArray(
    STORAGE_KEYS.MEETING_HUMAN_GROUND_TRUTH_EVENTS_V2,
    normalizeEvent
  );
}

export function persistHumanGroundTruthEventsV2(
  events: HumanGroundTruthEventV2[]
) {
  safeLocalStorage.setItem(
    STORAGE_KEYS.MEETING_HUMAN_GROUND_TRUTH_EVENTS_V2,
    JSON.stringify(events)
  );
}

export function readHumanEvaluationProjectionsV2() {
  return readStoredArray(
    STORAGE_KEYS.MEETING_HUMAN_EVALUATION_PROJECTIONS_V2,
    normalizeProjection
  );
}

export function persistHumanEvaluationProjectionsV2(
  projections: HumanEvaluationProjectionV2[]
) {
  safeLocalStorage.setItem(
    STORAGE_KEYS.MEETING_HUMAN_EVALUATION_PROJECTIONS_V2,
    JSON.stringify(projections)
  );
}

export function upsertHumanEvaluationProjectionV2(
  projections: HumanEvaluationProjectionV2[],
  projection: HumanEvaluationProjectionV2
) {
  const index = projections.findIndex(
    (candidate) => candidate.projectionId === projection.projectionId
  );
  if (index < 0) return [...projections, projection];
  return [
    ...projections.slice(0, index),
    projection,
    ...projections.slice(index + 1),
  ];
}

function eventPriority(event: HumanGroundTruthEventV2) {
  const confirmation = event.confirmation === "confirmed" ? 1_000 : 0;
  const source = {
    "explicit-ui": 60,
    "manual-type-correction": 50,
    "manual-force-advise": 50,
    "manual-term-correction": 40,
    "manual-context-action": 30,
    "imported-legacy": 10,
  }[event.provenance.source];
  return confirmation + source;
}

function subjectsMatch(
  left: HumanGroundTruthSubjectV2,
  right: HumanGroundTruthSubjectV2
) {
  if (left.attemptId || right.attemptId) {
    return Boolean(
      left.attemptId &&
        right.attemptId &&
        left.attemptId === right.attemptId
    );
  }
  if (left.questionId && right.questionId) {
    return left.questionId === right.questionId;
  }
  if (left.momentId && right.momentId) {
    return left.momentId === right.momentId;
  }
  return left.traceIds.some((traceId) => right.traceIds.includes(traceId));
}

function subjectKey(subject: HumanGroundTruthSubjectV2) {
  return fingerprint(
    subject.attemptId ??
      subject.questionId ??
      subject.momentId ??
      subject.taskId ??
      subject.traceIds.join(":") ??
      "unknown"
  );
}

function uniqueFactKinds(events: HumanGroundTruthEventV2[]) {
  return Array.from(new Set(events.map((event) => event.fact.kind)));
}

function compareExpectedIdentity(
  expected: string | undefined,
  observed: string | undefined
) {
  return expected ? observed === expected : undefined;
}

function normalizeSubject(
  subject: HumanGroundTruthSubjectV2
): HumanGroundTruthSubjectV2 {
  const attemptId = cleanOptional(subject.attemptId);
  return {
    ...(attemptId ? { attemptId } : {}),
    questionId: cleanOptional(subject.questionId),
    momentId: cleanOptional(subject.momentId),
    taskId: cleanOptional(subject.taskId),
    traceIds: uniqueStrings(subject.traceIds),
    sourceTurnIds: uniqueStrings(subject.sourceTurnIds),
  };
}

function normalizeFact(fact: HumanGroundTruthFactV2): HumanGroundTruthFactV2 {
  if (fact.kind === "expected-task-settlement") {
    return {
      ...fact,
      expectedParentId: cleanOptional(fact.expectedParentId),
      expectedBranchId: cleanOptional(fact.expectedBranchId),
      expectedContextOwnerId: cleanOptional(fact.expectedContextOwnerId),
    };
  }
  if (fact.kind === "expected-artifact-intent") {
    const expectedIntent = normalizeArtifactIntentEvaluationFamily(
      fact.expectedIntent
    );
    return {
      ...fact,
      expectedIntent: expectedIntent ?? fact.expectedIntent,
    };
  }
  if (fact.kind === "primary-ask-correction") {
    return {
      ...fact,
      correctedPrimaryAsk: fact.correctedPrimaryAsk.trim().slice(0, 2_000),
    };
  }
  if (fact.kind === "answer-quality") {
    return {
      ...fact,
      failureReasons: uniqueStrings(fact.failureReasons),
      expectedContextTurnIds: uniqueStrings(fact.expectedContextTurnIds),
    };
  }
  if (fact.kind === "memory-label") {
    return { ...fact, memoryIds: uniqueStrings(fact.memoryIds) };
  }
  if (fact.kind === "expected-project-trajectory") {
    return {
      ...fact,
      expectedProjectId: cleanOptional(fact.expectedProjectId),
      expectedProjectName: cleanOptional(fact.expectedProjectName),
    };
  }
  if (fact.kind === "expected-meeting-metadata") {
    return {
      ...fact,
      ...(fact.sourceCompany !== undefined
        ? {
            sourceCompany: normalizeOptionalMeetingCompany(
              fact.sourceCompany
            ),
          }
        : {}),
      ...(fact.expectedEffectiveCompany !== undefined
        ? {
            expectedEffectiveCompany: normalizeOptionalMeetingCompany(
              fact.expectedEffectiveCompany
            ),
          }
        : {}),
    };
  }
  return fact;
}

function resolveObservedContextReadScope(
  traceKind: MeetingTrace["kind"],
  metadata: Record<string, unknown>,
  answerCommitted: boolean | undefined
): AdvisorContextReadScope | undefined {
  const settledScope = normalizeContextReadScope(
    metadata.effectiveCurrentQuestionContextReadScope ??
      metadata.settledExecutionPlanContextReadScope
  );
  if (settledScope) return settledScope;

  const responseOnlyScope = normalizeContextReadScope(
    metadata.responseOnlyContextReadScope
  );
  if (responseOnlyScope) return responseOnlyScope;

  if (traceKind !== "screen" || answerCommitted !== true) {
    return undefined;
  }
  return readBoolean(metadata.responseOnlyParentReadContextPresent) === true
    ? "active-parent-read"
    : "current-only";
}

function resolveObservedArtifactIntent(
  traceKind: MeetingTrace["kind"],
  metadata: Record<string, unknown>,
  answerCommitted: boolean | undefined
): SettledAdvisorArtifactIntent | undefined {
  const plannedIntent = normalizeArtifactIntentEvaluationFamily(
    metadata.settledExecutionPlanArtifactIntent
  );
  if (traceKind !== "screen") return plannedIntent;

  const committedArtifacts = readStringArray(
    metadata.committedArtifacts
  );
  const candidateMutatedArtifacts = readStringArray(
    metadata.candidateMutatedArtifacts
  );
  const explicitMutations = committedArtifacts.length
    ? committedArtifacts
    : candidateMutatedArtifacts;
  if (
    explicitMutations.includes("code") ||
    explicitMutations.includes("complexity")
  ) {
    return "revise-code";
  }
  if (explicitMutations.includes("whiteboard")) {
    return "revise-whiteboard";
  }
  if (explicitMutations.includes("answer")) return "preserve";

  const codeChanged = didArtifactRevisionChange(
    metadata.previousCodeRevision,
    metadata.nextCodeRevision
  );
  const complexityChanged = didArtifactRevisionChange(
    metadata.previousComplexityRevision,
    metadata.nextComplexityRevision
  );
  if (codeChanged || complexityChanged) return "revise-code";

  const whiteboardDecision = readString(
    metadata.answerWhiteboardArtifactDecision
  );
  if (
    whiteboardDecision === "produced" ||
    whiteboardDecision === "updated"
  ) {
    return "revise-whiteboard";
  }

  if (answerCommitted === true) return "preserve";
  return plannedIntent;
}

function didArtifactRevisionChange(
  previousValue: unknown,
  nextValue: unknown
) {
  const previousRevision = readNumber(previousValue);
  const nextRevision = readNumber(nextValue);
  if (
    previousRevision === undefined ||
    nextRevision === undefined ||
    previousRevision <= 0 ||
    nextRevision <= 0
  ) {
    return false;
  }
  return previousRevision !== nextRevision;
}

function resolveObservedParentAction(
  relation: HumanEvaluationTaskRelation | undefined,
  mutationAuthorized: boolean | undefined,
  lifecycleCommand: string | undefined,
  currentOnly: boolean
): HumanExpectedParentAction | undefined {
  if (
    lifecycleCommand === "create-parent" ||
    lifecycleCommand === "replace-parent"
  ) {
    return "create";
  }
  if (lifecycleCommand === "attach-child") return "attach-child";
  if (lifecycleCommand === "resume-parent") return "resume";
  if (
    lifecycleCommand === "preserve" ||
    lifecycleCommand === "update-parent-context" ||
    lifecycleCommand === "advance-phase" ||
    currentOnly
  ) {
    return "preserve";
  }
  if (!relation) return undefined;
  if (relation === "new-parent") {
    return mutationAuthorized === false ? "none" : "create";
  }
  if (relation === "child-probe") {
    return mutationAuthorized === false ? "preserve" : "attach-child";
  }
  if (relation === "resume-parent") {
    return mutationAuthorized === false ? "preserve" : "resume";
  }
  if (relation === "none") return "preserve";
  if (
    relation === "followup-parent" ||
    relation === "correction" ||
    relation === "logistics"
  ) {
    return "preserve";
  }
  return mutationAuthorized === false ? "none" : undefined;
}

function normalizeRelation(
  value: unknown
): HumanEvaluationTaskRelation | undefined {
  return value === "new-parent" ||
    value === "followup-parent" ||
    value === "child-probe" ||
    value === "resume-parent" ||
    value === "logistics" ||
    value === "correction" ||
    value === "unknown" ||
    value === "none"
    ? value
    : undefined;
}

function mapLegacyAnswerOutcome(
  verdict: HumanEvaluationVerdict
): AnswerQualityFactV2["outcome"] {
  if (verdict === "ok") return "useful";
  if (verdict === "partial") return "partial";
  if (verdict === "missing") return "no-answer";
  return "wrong";
}

function normalizeEvent(value: unknown) {
  if (!isRecord(value) || value.schemaVersion !== 2) return undefined;
  if (
    typeof value.eventId !== "string" ||
    typeof value.sessionId !== "string" ||
    !isRecord(value.subject) ||
    !isRecord(value.fact) ||
    !isRecord(value.provenance)
  ) {
    return undefined;
  }
  const source = value.provenance.source;
  if (!isGroundTruthSource(source)) return undefined;
  const fact = normalizeStoredFact(value.fact);
  if (!fact) return undefined;
  return createHumanGroundTruthEventV2({
    eventId: value.eventId,
    sessionId: value.sessionId,
    subject: {
      attemptId: readString(value.subject.attemptId),
      questionId: readString(value.subject.questionId),
      momentId: readString(value.subject.momentId),
      taskId: readString(value.subject.taskId),
      traceIds: readStringArray(value.subject.traceIds),
      sourceTurnIds: readStringArray(value.subject.sourceTurnIds),
    },
    fact,
    source,
    collection: normalizeCollectionProvenance(
      value.provenance.collection
    ),
    confirmation:
      value.confirmation === "suggested" ? "suggested" : "confirmed",
    sourceTraceId: readString(value.provenance.sourceTraceId),
    repairTraceId: readString(value.provenance.repairTraceId),
    actionId: readString(value.provenance.actionId),
    uiSurface: readString(value.provenance.uiSurface),
    interaction: normalizeStoredInteraction(
      value.provenance.interaction,
      typeof value.provenance.recordedAt === "number"
        ? value.provenance.recordedAt
        : Date.now()
    ),
    evaluationTarget: normalizeStoredEvaluationTarget(
      value.provenance.evaluationTarget,
      typeof value.provenance.recordedAt === "number"
        ? value.provenance.recordedAt
        : Date.now()
    ),
    supersedesEventId: readString(value.supersedesEventId),
    now:
      typeof value.provenance.recordedAt === "number"
        ? value.provenance.recordedAt
        : Date.now(),
  });
}

function summarizeInteraction(
  events: HumanGroundTruthEventV2[]
): HumanGroundTruthInteractionV2 | undefined {
  const interactions = events
    .map((event) => event.provenance.interaction)
    .filter(
      (value): value is HumanGroundTruthInteractionV2 => value !== undefined
    );
  if (!interactions.length) return undefined;
  const startedAt = Math.min(...interactions.map((value) => value.startedAt));
  return {
    startedAt,
    durationMs: Math.max(
      ...interactions.map((value) => value.startedAt + value.durationMs)
    ) - startedAt,
    clickCount: Math.max(...interactions.map((value) => value.clickCount)),
    expandedRegions: uniqueStrings(
      interactions.flatMap((value) => value.expandedRegions)
    ),
  };
}

function normalizeStoredInteraction(
  value: unknown,
  recordedAt: number
): HumanGroundTruthInteractionV2 | undefined {
  if (!isRecord(value)) return undefined;
  return normalizeInteraction(
    {
      startedAt:
        typeof value.startedAt === "number" ? value.startedAt : recordedAt,
      durationMs:
        typeof value.durationMs === "number" ? value.durationMs : 0,
      clickCount:
        typeof value.clickCount === "number" ? value.clickCount : 0,
      expandedRegions: readStringArray(value.expandedRegions),
    },
    recordedAt
  );
}

function normalizeInteraction(
  value: HumanGroundTruthInteractionV2 | undefined,
  recordedAt: number
): HumanGroundTruthInteractionV2 | undefined {
  if (!value) return undefined;
  const startedAt = Number.isFinite(value.startedAt)
    ? Math.min(Math.max(0, value.startedAt), recordedAt)
    : recordedAt;
  const durationMs = Number.isFinite(value.durationMs)
    ? Math.max(0, Math.min(value.durationMs, recordedAt - startedAt))
    : recordedAt - startedAt;
  const clickCount = Number.isFinite(value.clickCount)
    ? Math.max(0, Math.floor(value.clickCount))
    : 0;
  return {
    startedAt,
    durationMs,
    clickCount,
    expandedRegions: uniqueStrings(value.expandedRegions),
  };
}

function normalizeEvaluationTarget(
  value: HumanGroundTruthEvaluationTargetV2 | undefined,
  recordedAt: number
): HumanGroundTruthEvaluationTargetV2 | undefined {
  if (!value) return undefined;
  const logicalQuestionUnitRevision = Number.isFinite(
    value.logicalQuestionUnitRevision
  )
    ? Math.max(0, Math.floor(value.logicalQuestionUnitRevision!))
    : undefined;
  const attemptId = cleanOptional(value.attemptId);
  return {
    ...(attemptId ? { attemptId } : {}),
    questionId: cleanOptional(value.questionId),
    taskId: cleanOptional(value.taskId),
    logicalQuestionUnitId: cleanOptional(value.logicalQuestionUnitId),
    logicalQuestionUnitRevision,
    currentTurnId: cleanOptional(value.currentTurnId),
    sourceTurnIds: uniqueStrings(value.sourceTurnIds),
    sourceTraceId: cleanOptional(value.sourceTraceId),
    repairTraceId: cleanOptional(value.repairTraceId),
    frozenAt: Number.isFinite(value.frozenAt)
      ? Math.min(Math.max(0, value.frozenAt), recordedAt)
      : recordedAt,
  };
}

function normalizeStoredEvaluationTarget(
  value: unknown,
  recordedAt: number
) {
  if (!isRecord(value)) return undefined;
  return normalizeEvaluationTarget(
    {
      attemptId: readString(value.attemptId),
      questionId: readString(value.questionId),
      taskId: readString(value.taskId),
      logicalQuestionUnitId: readString(value.logicalQuestionUnitId),
      logicalQuestionUnitRevision:
        typeof value.logicalQuestionUnitRevision === "number"
          ? value.logicalQuestionUnitRevision
          : undefined,
      currentTurnId: readString(value.currentTurnId),
      sourceTurnIds: readStringArray(value.sourceTurnIds),
      sourceTraceId: readString(value.sourceTraceId),
      repairTraceId: readString(value.repairTraceId),
      frozenAt:
        typeof value.frozenAt === "number" ? value.frozenAt : recordedAt,
    },
    recordedAt
  );
}

function normalizeProjection(value: unknown) {
  if (!isRecord(value) || value.schemaVersion !== 2) return undefined;
  if (
    typeof value.projectionId !== "string" ||
    typeof value.sessionId !== "string" ||
    !isRecord(value.subject)
  ) {
    return undefined;
  }
  const inputEventIds = readStringArray(value.inputEventIds);
  return {
    ...value,
    subject: normalizeSubject({
      attemptId: readString(value.subject.attemptId),
      questionId: readString(value.subject.questionId),
      momentId: readString(value.subject.momentId),
      taskId: readString(value.subject.taskId),
      traceIds: readStringArray(value.subject.traceIds),
      sourceTurnIds: readStringArray(value.subject.sourceTurnIds),
    }),
    inputEventIds,
    semanticInputEventIds: Array.isArray(value.semanticInputEventIds)
      ? readStringArray(value.semanticInputEventIds)
      : inputEventIds,
    interventionOnlyEventIds: readStringArray(
      value.interventionOnlyEventIds
    ),
  } as unknown as HumanEvaluationProjectionV2;
}

function normalizeStoredFact(
  fact: Record<string, unknown>
): HumanGroundTruthFactV2 | undefined {
  if (fact.kind === "expected-runtime-action") {
    const expectedAction = fact.expectedAction;
    if (
      expectedAction === "advise" ||
      expectedAction === "append-context" ||
      expectedAction === "buffer" ||
      expectedAction === "ignore"
    ) {
      return { kind: fact.kind, expectedAction };
    }
  }
  if (fact.kind === "expected-question-type") {
    const expectedQuestionType = normalizeCanonicalQuestionType(
      fact.expectedQuestionType
    );
    if (expectedQuestionType) {
      return {
        kind: fact.kind,
        expectedQuestionType,
        correctionScope: readString(fact.correctionScope),
      };
    }
  }
  if (fact.kind === "expected-context-read-scope") {
    const expectedScope = normalizeContextReadScope(fact.expectedScope);
    if (expectedScope) {
      return { kind: fact.kind, expectedScope };
    }
  }
  if (fact.kind === "expected-artifact-intent") {
    const expectedIntent = normalizeArtifactIntentEvaluationFamily(
      fact.expectedIntent
    );
    if (expectedIntent) {
      return { kind: fact.kind, expectedIntent };
    }
  }
  if (fact.kind === "expected-task-settlement") {
    const expectedQuestionType = normalizeCanonicalQuestionType(
      fact.expectedQuestionType
    );
    const expectedRelation = normalizeRelation(fact.expectedRelation);
    const expectedParentAction = normalizeParentAction(
      fact.expectedParentAction
    );
    if (expectedQuestionType && expectedRelation && expectedParentAction) {
      return {
        kind: fact.kind,
        expectedQuestionType,
        expectedRelation,
        expectedParentAction,
        expectedParentId: readString(fact.expectedParentId),
        expectedBranchId: readString(fact.expectedBranchId),
        expectedContextOwnerId: readString(
          fact.expectedContextOwnerId
        ),
      };
    }
  }
  if (
    fact.kind === "primary-ask-correction" &&
    typeof fact.correctedPrimaryAsk === "string"
  ) {
    return {
      kind: fact.kind,
      correctedPrimaryAsk: fact.correctedPrimaryAsk,
    };
  }
  if (
    fact.kind === "answer-quality" &&
    (fact.outcome === "useful" ||
      fact.outcome === "partial" ||
      fact.outcome === "wrong" ||
      fact.outcome === "no-answer")
  ) {
    return {
      kind: fact.kind,
      outcome: fact.outcome,
      failureReasons: readStringArray(fact.failureReasons),
      expectedContextTurnIds: readStringArray(
        fact.expectedContextTurnIds
      ),
    };
  }
  if (
    fact.kind === "memory-label" &&
    (fact.verdict === "relevant" ||
      fact.verdict === "irrelevant" ||
      fact.verdict === "missing" ||
      fact.verdict === "forbidden")
  ) {
    return {
      kind: fact.kind,
      verdict: fact.verdict,
      memoryIds: readStringArray(fact.memoryIds),
    };
  }
  if (
    fact.kind === "artifact-quality" &&
    (fact.artifact === "code" ||
      fact.artifact === "complexity" ||
      fact.artifact === "whiteboard") &&
    (fact.verdict === "useful" ||
      fact.verdict === "partial" ||
      fact.verdict === "wrong" ||
      fact.verdict === "missing")
  ) {
    return {
      kind: fact.kind,
      artifact: fact.artifact,
      verdict: fact.verdict,
    };
  }
  if (fact.kind === "expected-project-trajectory") {
    const expectedPhase = normalizePlaybookPhase(fact.expectedPhase);
    const expectedFactAnchorState = normalizeFactAnchorState(
      fact.expectedFactAnchorState
    );
    const expectedChildContinuity = normalizeChildContinuity(
      fact.expectedChildContinuity
    );
    const expectedProjectId = readString(fact.expectedProjectId);
    const expectedProjectName = readString(fact.expectedProjectName);
    const unsupportedFirstPersonClaim = readBoolean(
      fact.unsupportedFirstPersonClaim
    );
    if (
      expectedProjectId ||
      expectedProjectName ||
      expectedPhase ||
      expectedFactAnchorState ||
      expectedChildContinuity ||
      unsupportedFirstPersonClaim !== undefined
    ) {
      return {
        kind: fact.kind,
        expectedProjectId,
        expectedProjectName,
        expectedPhase,
        expectedFactAnchorState,
        expectedChildContinuity,
        unsupportedFirstPersonClaim,
      };
    }
  }
  if (fact.kind === "expected-meeting-metadata") {
    const legacyExpectedCompany =
      (fact as { expectedCompany?: unknown }).expectedCompany;
    const sourceCompany = readNullableString(fact.sourceCompany);
    const expectedEffectiveCompany = readNullableString(
      fact.expectedEffectiveCompany !== undefined
        ? fact.expectedEffectiveCompany
        : legacyExpectedCompany
    );
    const expectedMutationDisposition =
      normalizeMeetingMetadataMutationDisposition(
        fact.expectedMutationDisposition
      );
    const errorKind = normalizeMeetingMetadataErrorKind(fact.errorKind);
    if (
      sourceCompany !== undefined ||
      expectedEffectiveCompany !== undefined ||
      expectedMutationDisposition !== undefined
    ) {
      return {
        kind: fact.kind,
        sourceCompany,
        expectedEffectiveCompany,
        expectedMutationDisposition,
        errorKind,
      };
    }
  }
  return undefined;
}

function normalizeMeetingMetadataMutationDisposition(
  value: unknown
): MeetingMetadataMutationDisposition | undefined {
  return value === "commit" ||
    value === "preserve" ||
    value === "abstain"
    ? value
    : undefined;
}

function normalizeMeetingMetadataErrorKind(
  value: unknown
): MeetingMetadataEvaluationErrorKind | undefined {
  return value === "missed-target-company" ||
    value === "wrong-target-company" ||
    value === "comparison-as-target" ||
    value === "candidate-history-as-target" ||
    value === "location-as-target" ||
    value === "product-as-target" ||
    value === "locked-brief-overridden" ||
    value === "other"
    ? value
    : undefined;
}

function compareExpectedProject(
  fact: ExpectedProjectTrajectoryFactV2,
  observed: HumanEvaluationObservedSnapshotV2 | undefined
) {
  if (fact.expectedProjectId && observed?.projectId) {
    return normalizeProjectLabel(fact.expectedProjectId) ===
      normalizeProjectLabel(observed.projectId);
  }
  if (fact.expectedProjectName && observed?.projectName) {
    return normalizeProjectLabel(fact.expectedProjectName) ===
      normalizeProjectLabel(observed.projectName);
  }
  return undefined;
}

function normalizeProjectLabel(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function resolveObservedChildContinuity(
  metadata: Record<string, unknown>
): ProjectTrajectoryChildContinuity | undefined {
  const transitionKind = readString(metadata.sourceTransitionKind);
  const relation = readString(
    metadata.effectiveCurrentQuestionSettlementRelation ??
      metadata.currentQuestionSettlementRelation ??
      metadata.sourceTransitionRelation ??
      metadata.taskRelation
  );
  if (
    transitionKind === "resume-parent" ||
    relation === "resume-parent"
  ) {
    return "parent-resumed";
  }
  if (
    transitionKind === "child-probe" ||
    (relation === "child-probe" &&
      readString(
        metadata.effectiveCurrentQuestionSettlementChildId ??
          metadata.activeMeetingChildId
      )) ||
    readString(metadata.activeMeetingChildId)
  ) {
    return "child-attached";
  }
  if (readString(metadata.activeMeetingParentId)) return "none";
  return undefined;
}

function normalizeChildContinuity(
  value: unknown
): ProjectTrajectoryChildContinuity | undefined {
  return value === "none" ||
    value === "child-attached" ||
    value === "parent-resumed"
    ? value
    : undefined;
}

function normalizeFactAnchorState(
  value: unknown
): FactAnchorState | undefined {
  return value === "strong-anchor" ||
    value === "weak-anchor" ||
    value === "no-anchor" ||
    value === "not-required"
    ? value
    : undefined;
}

function normalizePlaybookPhase(
  value: unknown
): InterviewPlaybookPhase | undefined {
  return value === "story_selection" ||
    value === "baseline_reasoning" ||
    value === "optimized_pseudocode" ||
    value === "implementation_validation" ||
    value === "solution_planning" ||
    value === "requirement_clarification" ||
    value === "design_framing" ||
    value === "project_narrative" ||
    value === "architecture_decision" ||
    value === "validation_reliability" ||
    value === "impact_lessons" ||
    value === "concept_explanation" ||
    value === "follow_up"
    ? value
    : undefined;
}

function normalizeParentAction(
  value: unknown
): HumanExpectedParentAction | undefined {
  return value === "create" ||
    value === "preserve" ||
    value === "resume" ||
    value === "attach-child" ||
    value === "none"
    ? value
    : undefined;
}

function recommendedParentActionForRelation(
  relation: HumanEvaluationTaskRelation
): HumanExpectedParentAction {
  switch (relation) {
    case "new-parent":
      return "create";
    case "child-probe":
      return "attach-child";
    case "resume-parent":
      return "resume";
    case "followup-parent":
    case "logistics":
    case "correction":
      return "preserve";
    case "unknown":
      return "none";
    case "none":
      return "preserve";
  }
}

function normalizeContextReadScope(
  value: unknown
): AdvisorContextReadScope | undefined {
  return value === "current-only" ||
    value === "active-parent-read" ||
    value === "active-child-read" ||
    value === "bounded-recent-history"
    ? value
    : undefined;
}

export function normalizeArtifactIntentEvaluationFamily(
  value: unknown
): SettledAdvisorArtifactIntent | undefined {
  if (value === "revise-complexity") return "revise-code";
  return value === "none" ||
    value === "preserve" ||
    value === "revise-code" ||
    value === "revise-whiteboard"
    ? value
    : undefined;
}

function isGroundTruthSource(value: unknown): value is HumanGroundTruthSource {
  return (
    value === "explicit-ui" ||
    value === "manual-type-correction" ||
    value === "manual-force-advise" ||
    value === "manual-term-correction" ||
    value === "manual-context-action" ||
    value === "imported-legacy"
  );
}

function normalizeCollectionProvenance(
  value: unknown
): HumanEvaluationCollectionProvenance {
  return value === "scripted-validation" || value === "replay"
    ? value
    : "organic";
}

function readStoredArray<T>(
  key: string,
  normalize: (value: unknown) => T | undefined
) {
  const raw = safeLocalStorage.getItem(key);
  if (!raw) return [] as T[];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map(normalize).filter((value): value is T => Boolean(value))
      : [];
  } catch {
    return [];
  }
}

function cleanOptional(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeOptionalMeetingCompany(
  value: string | null | undefined
) {
  if (value === undefined || value === null) return value;
  return value.trim().slice(0, 240) || null;
}

function uniqueStrings(values: Array<string | undefined>) {
  return Array.from(
    new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value))
    )
  );
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function readNullableString(value: unknown): string | null | undefined {
  return value === null ? null : readString(value);
}

function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? uniqueStrings(value.map((item) => readString(item)))
    : [];
}

function readBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify(value[key])}`
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function fingerprint(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length}:${(hash >>> 0).toString(16)}`;
}
