import type { ActiveMeetingTask } from "./active-meeting-task.js";
import { isExplicitMeetingLogisticsTranscript } from "./meeting-logistics.js";
import {
  createCurrentQuestionSourceSettlementId,
  type CurrentQuestionSettlementProposal,
  type ProvisionalCurrentQuestion,
} from "./current-question-settlement.js";
import {
  getLogicalQuestionSemanticEvidenceText,
  type LogicalQuestionUnit,
} from "./logical-question-unit.js";
import { projectPrimaryAsk } from "./primary-ask-projection.js";
import {
  hashTaxonomySourceTurnIds,
  projectLogicalQuestionForAdjudication,
  type TaxonomyAdjudicationProjection,
} from "./taxonomy-adjudication.js";
import { hasConstraintOrCorrectionSignal } from "./transcript-fusion.js";
import type {
  AdvisorSourceOwnedSemanticContext,
  TranscriptTurn,
} from "./types.js";

export const TASK_RELATION_ADJUDICATION_SCHEMA_VERSION = 3;
export const LEGACY_TASK_RELATION_ADJUDICATION_SCHEMA_VERSION = 2;
export const TASK_RELATION_ADJUDICATION_PROMPT_VERSION =
  "task-relation-adjudication-v3-direct";

export const TASK_RELATION_ADJUDICATION_MAX_PARENT_CHARS = 480;
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
  role?: TaskRelationSourceEvidenceRole;
  selectionReason: "lqu-projection" | "role-hint" | "raw-recent-turn";
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
  lquSelectedCount: number;
  rawSupplementCount: number;
  acknowledgementExcludedCount: number;
  logisticsExcludedCount: number;
  coveredTurnCount: number;
  branchEvidenceCount: number;
  parentEvidenceCount: number;
}

export interface TaskRelationOwnerEvidenceInput {
  sourceId: string;
  text: string;
  role?: TaskRelationSourceEvidenceRole;
  selectionReason: "lqu-projection" | "raw-recent-turn";
}

export interface TaskRelationOwnerEvidenceSelectionInput {
  recentBranchEvidence: TaskRelationOwnerEvidenceInput[];
  recentParentEvidence: TaskRelationOwnerEvidenceInput[];
  diagnostics: {
    lquSelectedCount: number;
    rawSupplementCount: number;
    acknowledgementExcludedCount: number;
    logisticsExcludedCount: number;
    coveredTurnCount: number;
  };
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
  currentQuestionEvidenceTexts?: string[];
  activeParent: TaskRelationParentCapsule;
  activeChild?: TaskRelationChildCapsule;
  recentSourceEvidence: TaskRelationSourceEvidence[];
  recentBranchEvidence: TaskRelationSourceEvidence[];
  recentParentEvidence: TaskRelationSourceEvidence[];
  recentTransitions: TaskRelationTransitionEvidence[];
  recentEvidenceDiagnostics: TaskRelationRecentEvidenceDiagnostics;
  suspendedParent?: TaskRelationParentCapsule;
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

export function buildTaskRelationAdjudicationRequest(input: {
  logicalQuestionUnit: LogicalQuestionUnit;
  activeMeetingTask: ActiveMeetingTask;
  currentQuestion?: ProvisionalCurrentQuestion;
  recentTurns?: TranscriptTurn[];
  ownerEvidenceSelection?: TaskRelationOwnerEvidenceSelectionInput;
  recentSourceContext?: AdvisorSourceOwnedSemanticContext;
  currentQuestionEvidenceTexts?: string[];
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
  const ownerEvidenceSelection = input.ownerEvidenceSelection;
  const recentBranchEvidence = ownerEvidenceSelection
    ? ownerEvidenceSelection.recentBranchEvidence.map((item) =>
        toTaskRelationSourceEvidence(item)
      )
    : [];
  const parentEvidenceSelection = ownerEvidenceSelection
    ? {
        evidence: ownerEvidenceSelection.recentParentEvidence.map((item) =>
          toTaskRelationSourceEvidence(item)
        ),
        diagnostics: {
          eligiblePriorTurnCount:
            ownerEvidenceSelection.recentParentEvidence.length,
          selectedTurnCount:
            ownerEvidenceSelection.recentParentEvidence.length,
          rawFallbackCount:
            ownerEvidenceSelection.diagnostics.rawSupplementCount,
          acknowledgementExcludedCount:
            ownerEvidenceSelection.diagnostics.acknowledgementExcludedCount,
          logisticsExcludedCount:
            ownerEvidenceSelection.diagnostics.logisticsExcludedCount,
          falseEmpty: false,
          emptyReason: undefined,
        },
      }
    : selectRecentSourceEvidence({
        turns: parentScope.turns,
        excludedTurnIds,
        maxTurns: 5,
        sourceScope: "parent-scope",
      });
  const recentContextEvidence = input.recentSourceContext
    ? {
        turnId:
          input.recentSourceContext.sourceTurnIds.at(-1) ??
          input.logicalQuestionUnit.currentTurnId,
        text: input.recentSourceContext.text,
        role: "constraint" as const,
        selectionReason: "raw-recent-turn" as const,
        sourceScope: "cross-boundary-prior-turn" as const,
      }
    : undefined;
  let recentParentEvidence = dedupeTaskRelationEvidence([
    ...parentEvidenceSelection.evidence,
    ...(recentContextEvidence ? [recentContextEvidence] : []),
  ]);
  let recentSourceEvidence = dedupeTaskRelationEvidence([
    ...recentParentEvidence,
    ...recentBranchEvidence,
  ]);
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
    recentParentEvidence = recentSourceEvidence;
    crossBoundarySelectedCount = recentSourceEvidence.length;
  }
  if (recentSourceEvidence.length === 0) {
    const currentSource =
      [...input.logicalQuestionUnit.sources]
        .reverse()
        .find((source) => source.text.trim()) ??
      input.logicalQuestionUnit.sources.at(-1);
    const text = boundText(
      getLogicalQuestionSemanticEvidenceText(input.logicalQuestionUnit) ||
        currentSource?.text ||
        input.logicalQuestionUnit.normalizedText,
      Math.min(280, TASK_RELATION_ADJUDICATION_MAX_SOURCE_EVIDENCE_CHARS)
    );
    if (text && !isExcludedRecentRelationEvidenceText(text)) {
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
      recentParentEvidence = recentSourceEvidence;
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
    lquSelectedCount:
      ownerEvidenceSelection?.diagnostics.lquSelectedCount ?? 0,
    rawSupplementCount:
      ownerEvidenceSelection?.diagnostics.rawSupplementCount ??
      parentEvidenceSelection.diagnostics.rawFallbackCount,
    acknowledgementExcludedCount:
      ownerEvidenceSelection?.diagnostics.acknowledgementExcludedCount ??
      parentEvidenceSelection.diagnostics.acknowledgementExcludedCount,
    logisticsExcludedCount:
      ownerEvidenceSelection?.diagnostics.logisticsExcludedCount ??
      parentEvidenceSelection.diagnostics.logisticsExcludedCount,
    coveredTurnCount:
      ownerEvidenceSelection?.diagnostics.coveredTurnCount ?? 0,
    branchEvidenceCount: recentBranchEvidence.length,
    parentEvidenceCount: recentParentEvidence.length,
  };
  const recentTransitions = recentSourceEvidence
    .filter((item) => item.role === "transition")
    .map((item) => ({ turnId: item.turnId, text: item.text }));
  const activeParent = buildParentCapsule(
    input.activeMeetingTask,
    recentParentEvidence
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
    currentQuestionEvidenceTexts: uniqueStrings(
      (input.currentQuestionEvidenceTexts ?? []).map((text) =>
        boundText(text, TASK_RELATION_ADJUDICATION_MAX_SOURCE_EVIDENCE_CHARS)
      )
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
    recentBranchEvidence,
    recentParentEvidence,
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

export function getTaskRelationCurrentQuestionSourceTexts(
  request: Pick<
    TaskRelationAdjudicationRequest,
    "currentQuestion" | "currentQuestionEvidenceTexts"
  >
) {
  return uniqueStrings([
    ...request.currentQuestion.sourceTurns.map((source) => source.text),
    ...(request.currentQuestionEvidenceTexts ?? []),
  ]);
}

export function createTaskRelationSettlementProposal(input: {
  currentQuestion: ProvisionalCurrentQuestion;
  adjudication: LlmTaskRelationAdjudication;
  expectedParentId: string;
  expectedParentRevision?: number;
}): CurrentQuestionSettlementProposal {
  return {
    source: "runtime-adjudication",
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

function toTaskRelationSourceEvidence(
  item: TaskRelationOwnerEvidenceInput
): TaskRelationSourceEvidence {
  return {
    turnId: item.sourceId,
    text: item.text,
    role: item.role,
    selectionReason: item.selectionReason,
    sourceScope: "parent-scope",
  };
}

function dedupeTaskRelationEvidence(
  evidence: TaskRelationSourceEvidence[]
) {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = `${item.turnId}:${item.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  let acknowledgementExcludedCount = 0;
  let logisticsExcludedCount = 0;
  const eligibleTurns = input.turns.filter((turn) => {
    if (
      turn.speaker !== "them" ||
      input.excludedTurnIds.has(turn.id) ||
      turn.contextFusionStatus === "duplicate-suppressed" ||
      !turn.text.trim()
    ) {
      return false;
    }
    const speechAct = projectPrimaryAsk({
      turnId: turn.id,
      text: turn.text,
    }).speechAct;
    if (speechAct === "acknowledgement") {
      acknowledgementExcludedCount += 1;
      return false;
    }
    if (
      speechAct === "logistics" ||
      isExplicitMeetingLogisticsTranscript(turn.text)
    ) {
      logisticsExcludedCount += 1;
      return false;
    }
    return true;
  });
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
      acknowledgementExcludedCount,
      logisticsExcludedCount,
      falseEmpty: eligibleTurns.length > 0 && selected.length === 0,
      emptyReason:
        eligibleTurns.length === 0
          ? ("no-prior-source-turn" as const)
          : undefined,
    },
  };
}

function isExcludedRecentRelationEvidenceText(text: string) {
  const speechAct = projectPrimaryAsk({
    turnId: "relation-evidence-filter",
    text,
  }).speechAct;
  return (
    speechAct === "acknowledgement" ||
    speechAct === "logistics" ||
    isExplicitMeetingLogisticsTranscript(text)
  );
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

export function isRuntimeTaskRelation(
  value: unknown
): value is RuntimeTaskRelation {
  return RUNTIME_TASK_RELATIONS.includes(
    value as RuntimeTaskRelation
  );
}

function boundText(value: string, maxChars: number) {
  return value.replace(/\s+/gu, " ").trim().slice(0, maxChars);
}

function uniqueStrings(values: Array<string | undefined>) {
  return Array.from(
    new Set(values.filter((value): value is string => Boolean(value)))
  );
}

const TRANSITION_EVIDENCE_PATTERNS = [
  /\b(?:now|next|then)\s+(?:let'?s\s+)?(?:move|switch|turn|go)\s+(?:on\s+)?(?:to|into)\b/iu,
  /\b(?:a|the)\s+(?:new|separate|unrelated)\s+(?:question|problem|task)\b/iu,
  /\b(?:back|return|resume|go back)\s+(?:to|into)\b/iu,
  /\b(?:original|previous)\s+(?:question|task|design|architecture|problem)\b/iu,
];
