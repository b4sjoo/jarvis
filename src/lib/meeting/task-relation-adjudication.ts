import type { ActiveMeetingTask } from "./active-meeting-task.js";
import type {
  CurrentQuestionSettlementProposal,
  ProvisionalCurrentQuestion,
} from "./current-question-settlement.js";
import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import type { RuntimeInferenceRuntimeJob } from "./runtime-inference-runtime.js";
import { projectPrimaryAsk } from "./primary-ask-projection.js";
import {
  projectLogicalQuestionForAdjudication,
  type TaxonomyAdjudicationLease,
  type TaxonomyAdjudicationProjection,
} from "./taxonomy-adjudication.js";
import { hasConstraintOrCorrectionSignal } from "./transcript-fusion.js";
import type {
  MeetingTaskRelationAdjudicationMode,
  TranscriptTurn,
} from "./types.js";

export const TASK_RELATION_ADJUDICATION_SCHEMA_VERSION = 2;
export const TASK_RELATION_ADJUDICATION_PROMPT_VERSION =
  "task-relation-adjudication-v2";
export const TASK_RELATION_ADJUDICATION_MAX_OUTPUT_CHARS = 4_096;
export const TASK_RELATION_ADJUDICATION_MAX_PARENT_CHARS = 480;
export const TASK_RELATION_ADJUDICATION_MAX_TRANSITION_CHARS = 600;
export const TASK_RELATION_ADJUDICATION_MAX_SOURCE_EVIDENCE_CHARS = 720;

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
  role: TaskRelationSourceEvidenceRole;
}

export interface TaskRelationTransitionEvidence {
  turnId: string;
  text: string;
}

export interface TaskRelationAdjudicationRequest {
  schemaVersion: 2;
  promptVersion: string;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  currentQuestion: TaxonomyAdjudicationProjection;
  activeParent: TaskRelationParentCapsule;
  activeChild?: TaskRelationChildCapsule;
  recentSourceEvidence: TaskRelationSourceEvidence[];
  recentTransitions: TaskRelationTransitionEvidence[];
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
  schemaVersion: 2;
  relation: RuntimeTaskRelation;
  dependency: TaskRelationDependency;
  continuationShape: TaskRelationContinuationShape;
  returnIntent: TaskRelationReturnIntent;
  switchIntent: TaskRelationSwitchIntent;
  standaloneSufficiency: TaskRelationStandaloneSufficiency;
  confidence: number;
  currentQuestionEvidenceSpans: string[];
  parentEvidenceSpans: string[];
  explicitBinding: boolean;
  standalone: boolean;
  ambiguityReason?: string;
}

export type TaskRelationAdjudicationParseResult =
  | {
      ok: true;
      value: LlmTaskRelationAdjudication;
      evidenceSpansValid: true;
    }
  | {
      ok: false;
      reason: string;
      errorKind: "parse" | "schema" | "evidence" | "provider";
      evidenceSpansValid: boolean;
    };

export interface TaskRelationAdjudicationEligibilityDecision {
  eligible: boolean;
  reason: string;
  triggerReasons: string[];
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
  recentTurns?: TranscriptTurn[];
}): TaskRelationAdjudicationRequest {
  const parent = input.activeMeetingTask.parent;
  const child = input.activeMeetingTask.child;
  const scopedTurns = selectActiveParentSourceTurns({
    turns: input.recentTurns ?? [],
    activeMeetingTask: input.activeMeetingTask,
  });
  const excludedTurnIds = new Set(
    input.logicalQuestionUnit.sourceTurnIds
  );
  const recentSourceEvidence = selectRecentSourceEvidence({
    turns: scopedTurns,
    excludedTurnIds,
  });
  const recentTransitions = selectRecentTransitionEvidence({
    turns: scopedTurns,
    excludedTurnIds,
  });
  const activeParent = buildParentCapsule(
    input.activeMeetingTask,
    recentSourceEvidence
  );

  return {
    schemaVersion: TASK_RELATION_ADJUDICATION_SCHEMA_VERSION,
    promptVersion: TASK_RELATION_ADJUDICATION_PROMPT_VERSION,
    logicalQuestionUnitId: input.logicalQuestionUnit.id,
    logicalQuestionUnitRevision: input.logicalQuestionUnit.revision,
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
  speaker: "me" | "them" | "unknown";
  request: TaskRelationAdjudicationRequest;
  manualCorrectionActive: boolean;
  deterministicRelationAuthorized: boolean;
  turnGateAction: string;
}): TaskRelationAdjudicationEligibilityDecision {
  const skip = (reason: string) => ({
    eligible: false,
    reason,
    triggerReasons: [] as string[],
  });
  if (input.mode === "off") return skip("task-relation-operation-off");
  if (!input.evaluationActive) return skip("evaluation-inactive");
  if (input.speaker !== "them") return skip("speaker-is-not-interviewer");
  if (!input.request.currentQuestion.safe) {
    return skip("unsafe-question-projection");
  }
  if (input.manualCorrectionActive) {
    return skip("manual-correction-authoritative");
  }
  if (input.deterministicRelationAuthorized) {
    return skip("deterministic-relation-authoritative");
  }
  if (input.turnGateAction !== "answer-refresh") {
    return skip(`turn-gate-not-answer:${input.turnGateAction || "unknown"}`);
  }
  if (
    estimateWordEquivalents(input.request.currentQuestion.text) < 3
  ) {
    return skip("question-unit-too-short");
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
  };
}

export function buildTaskRelationAdjudicationPrompts(
  request: TaskRelationAdjudicationRequest
) {
  return {
    systemPrompt: [
      "Evaluate only five independent relationship facts about one bounded interviewer question and the supplied active interview parent.",
      "Return one JSON object only. Do not answer the interview question.",
      "Do not classify question type, choose an advisor action, mutate a parent, advance a playbook phase, select memory, or generate an artifact.",
      "Do not output a final relation. Runtime code derives it from your five atomic decisions.",
      "dependency: parent-dependent only when the current question needs or directly modifies the supplied parent; parent-independent only when it can be handled without that parent; otherwise unclear.",
      "continuationShape: mainline for a direct continuation of the parent; bounded-detour for a local concept or implementation probe after which the parent remains resumable; otherwise unclear.",
      "returnIntent: resume-suspended-parent only when activeChild exists and the wording explicitly returns to the suspended parent; no-resume when it clearly does not; otherwise unclear.",
      "switchIntent: explicit-switch only when the wording explicitly changes to a different task; no-explicit-switch when it clearly does not; otherwise unclear. This signal alone never authorizes a new parent.",
      "standaloneSufficiency is a counterfactual: imagine all prior conversation is unavailable and only currentQuestion is sent to Advisor.",
      "Use sufficient only when the current question itself identifies a concrete system, object, or subject and the requested goal or operation without guessing the parent.",
      "Pronouns and deictic references such as this, that, it, the design, how would it change, or continue are insufficient unless the same current question resolves them.",
      "Time proximity, topic overlap, compatible question types, playbook phase, and generated answers are not relationship evidence.",
      "currentQuestionEvidenceSpans must contain one or more exact verbatim substrings from currentQuestion.sourceTurns.",
      "parentEvidenceSpans must contain exact verbatim substrings from source-owned activeParent, activeChild, recentSourceEvidence, recentTransitions, or suspendedParent text fields.",
      "parent-dependent and resume-suspended-parent require at least one grounded parentEvidenceSpan.",
      "Schema: {schemaVersion:2,dependency,continuationShape,returnIntent,switchIntent,standaloneSufficiency,confidence,currentQuestionEvidenceSpans,parentEvidenceSpans,ambiguityReason?}.",
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
    "ambiguityReason",
  ]);
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) {
    return parseFailure("non-relation-field-present", "schema");
  }
  if (
    candidate.schemaVersion !==
    TASK_RELATION_ADJUDICATION_SCHEMA_VERSION
  ) {
    return parseFailure("unsupported-schema-version", "schema");
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
  if (!isEvidenceSpanArray(candidate.parentEvidenceSpans, false)) {
    return parseFailure("invalid-parent-evidence-spans", "schema");
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
  const parentEvidenceSpans = (
    candidate.parentEvidenceSpans as string[]
  ).map((span) => span.trim());
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
  if (
    returnIntent === "resume-suspended-parent" &&
    !request.activeChild
  ) {
    return parseFailure("resume-requires-active-child-binding", "schema");
  }
  const relation = deriveRuntimeTaskRelationFromAtomicDecision({
    dependency,
    continuationShape,
    returnIntent,
    switchIntent,
    standaloneSufficiency,
    hasActiveChild: Boolean(request.activeChild),
    hasParentEvidence: parentEvidenceSpans.length > 0,
  });

  return {
    ok: true,
    evidenceSpansValid: true,
    value: {
      schemaVersion: TASK_RELATION_ADJUDICATION_SCHEMA_VERSION,
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
}) {
  return {
    taskRelationAdjudicationMode: input.mode,
    taskRelationAdjudicationEligible:
      input.eligibility?.eligible,
    taskRelationAdjudicationEligibilityReason:
      input.eligibility?.reason,
    taskRelationAdjudicationTriggerReasons:
      input.eligibility?.triggerReasons,
    taskRelationAdjudicationUnitId:
      input.request?.logicalQuestionUnitId,
    taskRelationAdjudicationUnitRevision:
      input.request?.logicalQuestionUnitRevision,
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
    taskRelationAdjudicationTransitionCount:
      input.request?.recentTransitions.length,
    taskRelationAdjudicationGeneratedAnswerExcluded: true,
    taskRelationAdjudicationDisposition: input.disposition,
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
      (item) => item.role === "constraint"
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
  const boundaryIndex =
    boundaryIndexes.length > 0 ? Math.min(...boundaryIndexes) : 0;
  return input.turns.slice(boundaryIndex);
}

function selectRecentSourceEvidence(input: {
  turns: TranscriptTurn[];
  excludedTurnIds: Set<string>;
}) {
  const selected: TaskRelationSourceEvidence[] = [];
  let selectedChars = 0;
  for (const turn of [...input.turns].reverse()) {
    if (
      selected.length >= 3 ||
      selectedChars >=
        TASK_RELATION_ADJUDICATION_MAX_SOURCE_EVIDENCE_CHARS
    ) {
      break;
    }
    if (
      turn.speaker !== "them" ||
      input.excludedTurnIds.has(turn.id) ||
      turn.contextFusionStatus === "duplicate-suppressed" ||
      turn.contextPromptEligible === false
    ) {
      continue;
    }
    const role = classifySourceEvidenceRole(turn);
    if (!role) continue;
    const remaining =
      TASK_RELATION_ADJUDICATION_MAX_SOURCE_EVIDENCE_CHARS -
      selectedChars;
    const text = boundText(turn.text, Math.min(280, remaining));
    if (!text) continue;
    selected.unshift({ turnId: turn.id, text, role });
    selectedChars += text.length;
  }
  return selected;
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

function selectRecentTransitionEvidence(input: {
  turns: TranscriptTurn[];
  excludedTurnIds: Set<string>;
}) {
  const selected: TaskRelationTransitionEvidence[] = [];
  let selectedChars = 0;
  for (const turn of [...input.turns].reverse()) {
    if (
      selected.length >= 3 ||
      selectedChars >= TASK_RELATION_ADJUDICATION_MAX_TRANSITION_CHARS
    ) {
      break;
    }
    if (
      turn.speaker !== "them" ||
      input.excludedTurnIds.has(turn.id) ||
      !hasTransitionEvidence(turn.text)
    ) {
      continue;
    }
    const remaining =
      TASK_RELATION_ADJUDICATION_MAX_TRANSITION_CHARS - selectedChars;
    const text = boundText(turn.text, Math.min(240, remaining));
    if (!text) continue;
    selected.unshift({ turnId: turn.id, text });
    selectedChars += text.length;
  }
  return selected;
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

const TRANSITION_EVIDENCE_PATTERNS = [
  /\b(?:now|next|then)\s+(?:let'?s\s+)?(?:move|switch|turn|go)\s+(?:on\s+)?(?:to|into)\b/iu,
  /\b(?:a|the)\s+(?:new|separate|unrelated)\s+(?:question|problem|task)\b/iu,
  /\b(?:back|return|resume|go back)\s+(?:to|into)\b/iu,
  /\b(?:original|previous)\s+(?:question|task|design|architecture|problem)\b/iu,
];
