import type { ActiveMeetingTask } from "./active-meeting-task.js";
import type {
  CurrentQuestionSettlementProposal,
  ProvisionalCurrentQuestion,
} from "./current-question-settlement.js";
import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import type { RuntimeInferenceRuntimeJob } from "./runtime-inference-runtime.js";
import {
  projectLogicalQuestionForAdjudication,
  type TaxonomyAdjudicationLease,
  type TaxonomyAdjudicationProjection,
} from "./taxonomy-adjudication.js";
import type {
  MeetingTaskRelationAdjudicationMode,
  TranscriptTurn,
} from "./types.js";

export const TASK_RELATION_ADJUDICATION_SCHEMA_VERSION = 1;
export const TASK_RELATION_ADJUDICATION_PROMPT_VERSION =
  "task-relation-adjudication-v1";
export const TASK_RELATION_ADJUDICATION_MAX_OUTPUT_CHARS = 4_096;
export const TASK_RELATION_ADJUDICATION_MAX_PARENT_CHARS = 480;
export const TASK_RELATION_ADJUDICATION_MAX_TRANSITION_CHARS = 600;

export const RUNTIME_TASK_RELATIONS = [
  "new-parent",
  "followup-parent",
  "child-probe",
  "resume-parent",
  "unknown",
] as const;

export type RuntimeTaskRelation =
  (typeof RUNTIME_TASK_RELATIONS)[number];

export interface TaskRelationParentCapsule {
  parentId: string;
  revision: number;
  canonicalType: string;
  topic: string;
  compactObjective: string;
  currentPhase?: string;
  sharedScenarioEntities: string[];
}

export interface TaskRelationChildCapsule {
  childId: string;
  canonicalType: string;
  question: string;
  compactSummary?: string;
}

export interface TaskRelationTransitionEvidence {
  turnId: string;
  text: string;
}

export interface TaskRelationAdjudicationRequest {
  schemaVersion: 1;
  promptVersion: string;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  currentQuestion: TaxonomyAdjudicationProjection;
  activeParent: TaskRelationParentCapsule;
  activeChild?: TaskRelationChildCapsule;
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
  schemaVersion: 1;
  relation: RuntimeTaskRelation;
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
  const activeParent = buildParentCapsule(input.activeMeetingTask);
  const child = input.activeMeetingTask.child;

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
          canonicalType: child.questionType,
          question: boundText(child.question, 240),
          compactSummary: child.compactSummary
            ? boundText(child.compactSummary, 200)
            : undefined,
        }
      : undefined,
    recentTransitions: selectRecentTransitionEvidence({
      turns: input.recentTurns ?? [],
      excludedTurnIds: new Set(input.logicalQuestionUnit.sourceTurnIds),
    }),
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
      "Classify only the relationship between one bounded interviewer question and the supplied active interview parent.",
      "Return one JSON object only. Do not answer the interview question.",
      "Do not classify question type, choose an advisor action, mutate a parent, advance a playbook phase, select memory, or generate an artifact.",
      "Allowed relation values: new-parent, followup-parent, child-probe, resume-parent, unknown.",
      "new-parent means a standalone new primary interview task, including a new task in the same domain or of the same type.",
      "followup-parent means the question directly continues or constrains the active parent's main task.",
      "child-probe means a bounded detour subordinate to the parent, such as a local concept or implementation probe, after which the parent should remain resumable.",
      "resume-parent is valid only when activeChild is present and the question explicitly returns from that child to the suspended parent.",
      "Use unknown when the relationship cannot be grounded. Time proximity, topic overlap, or compatible question types alone are not relation evidence.",
      "currentQuestionEvidenceSpans must contain one or more exact verbatim substrings from currentQuestion.sourceTurns.",
      "parentEvidenceSpans must contain exact verbatim substrings from activeParent, activeChild, or suspendedParent text fields.",
      "followup-parent, child-probe, and resume-parent require at least one grounded parentEvidenceSpan.",
      "new-parent requires standalone=true. resume-parent requires explicitBinding=true.",
      "Schema: {schemaVersion:1,relation,confidence,currentQuestionEvidenceSpans,parentEvidenceSpans,explicitBinding,standalone,ambiguityReason?}.",
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
    "relation",
    "confidence",
    "currentQuestionEvidenceSpans",
    "parentEvidenceSpans",
    "explicitBinding",
    "standalone",
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
    typeof candidate.explicitBinding !== "boolean" ||
    typeof candidate.standalone !== "boolean"
  ) {
    return parseFailure("invalid-relation-flags", "schema");
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

  const relation = candidate.relation;
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
    (relation === "followup-parent" ||
      relation === "child-probe" ||
      relation === "resume-parent") &&
    parentEvidenceSpans.length === 0
  ) {
    return parseFailure("parent-evidence-required", "evidence");
  }
  if (relation === "new-parent" && candidate.standalone !== true) {
    return parseFailure("new-parent-must-be-standalone", "schema");
  }
  if (
    relation === "resume-parent" &&
    (!request.activeChild || candidate.explicitBinding !== true)
  ) {
    return parseFailure("resume-requires-active-child-binding", "schema");
  }

  return {
    ok: true,
    evidenceSpansValid: true,
    value: {
      schemaVersion: TASK_RELATION_ADJUDICATION_SCHEMA_VERSION,
      relation,
      confidence: candidate.confidence,
      currentQuestionEvidenceSpans,
      parentEvidenceSpans,
      explicitBinding: candidate.explicitBinding,
      standalone: candidate.standalone,
      ambiguityReason: candidate.ambiguityReason as
        | string
        | undefined,
    },
  };
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
    taskRelationAdjudicationTransitionCount:
      input.request?.recentTransitions.length,
    taskRelationAdjudicationDisposition: input.disposition,
    taskRelationAdjudicationCandidateRelation:
      input.candidate?.relation,
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
  activeMeetingTask: ActiveMeetingTask
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
    canonicalType: parent.questionType,
    topic: boundText(parent.topic, 280),
    compactObjective,
    currentPhase: parent.playbookPhase,
    sharedScenarioEntities:
      sharedContext?.domainEntities
        ?.slice(0, 8)
        .map((entity) => boundText(entity, 80)) ?? [],
  };
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
    request.activeParent.currentPhase,
    ...request.activeParent.sharedScenarioEntities,
    request.activeChild?.question,
    request.activeChild?.compactSummary,
    request.suspendedParent?.topic,
    request.suspendedParent?.compactObjective,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

function isRuntimeTaskRelation(
  value: unknown
): value is RuntimeTaskRelation {
  return RUNTIME_TASK_RELATIONS.includes(
    value as RuntimeTaskRelation
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
