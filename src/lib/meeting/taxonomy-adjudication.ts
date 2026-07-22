import { createMeetingId } from "./context-manager.js";
import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import type {
  HybridQuestionTypeDecision,
  SemanticTaxonomyDecision,
} from "./semantic-taxonomy-resolver.js";
import {
  isCanonicalQuestionType,
  type CanonicalQuestionType,
  type QuestionTypeInferenceDecision,
  type TaxonomyInterviewBriefType,
} from "./task-taxonomy.js";

export const TAXONOMY_ADJUDICATION_SCHEMA_VERSION = 1;
export const TAXONOMY_ADJUDICATION_PROMPT_VERSION =
  "taxonomy-adjudication-prompt-v1";
export const TAXONOMY_ADJUDICATION_MAX_OUTPUT_CHARS = 4_096;
export const TAXONOMY_ADJUDICATION_MAX_INPUT_CHARS = 1_200;

export const TAXONOMY_ADJUDICATION_RELATIONS = [
  "new-parent",
  "linked-parent-extension",
  "followup-parent",
  "child-probe",
  "resume-parent",
  "unknown",
] as const;

export type TaxonomyAdjudicationRelation =
  (typeof TAXONOMY_ADJUDICATION_RELATIONS)[number];

export interface TaxonomyAdjudicationParentDescriptor {
  idHash?: string;
  questionType?: CanonicalQuestionType;
  topic?: string;
  playbookPhase?: string;
  sharedScenarioEntities?: string[];
}

export interface TaxonomyAdjudicationProjection {
  text: string;
  sourceTurnIds: string[];
  omittedSourceTurnIds: string[];
  originalChars: number;
  projectedChars: number;
  projectionReason: "within-limit" | "anchor-switch-latest-constraint";
  safe: boolean;
}

export interface TaxonomyAdjudicationEvidence {
  lexical: Pick<
    QuestionTypeInferenceDecision,
    "type" | "confidence" | "margin" | "evidence" | "ambiguousTerms" | "scores"
  >;
  semantic?: Pick<
    SemanticTaxonomyDecision,
    | "candidateType"
    | "calibratedConfidence"
    | "margin"
    | "accepted"
    | "rejectionReasons"
  >;
  hybrid?: Pick<
    HybridQuestionTypeDecision,
    "outcome" | "reason" | "recommendedType" | "wouldRescue"
  >;
}

export interface TaxonomyAdjudicationRequest {
  schemaVersion: 1;
  promptVersion: string;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  question: TaxonomyAdjudicationProjection;
  sourceLanguage?: string;
  sttUncertaintyMarkers?: string[];
  activeParent?: TaxonomyAdjudicationParentDescriptor;
  evidence: TaxonomyAdjudicationEvidence;
  interviewBriefTypes: TaxonomyInterviewBriefType[];
  taskSwitchEvidence: string[];
}

export interface LlmTaxonomyAdjudication {
  schemaVersion: 1;
  questionType: CanonicalQuestionType;
  relation: TaxonomyAdjudicationRelation;
  normalizedQuestion: string;
  standalone: boolean;
  evidenceSpans: string[];
  confidence: number;
  ambiguityReason?: string;
}

export type TaxonomyAdjudicationParseResult =
  | { ok: true; value: LlmTaxonomyAdjudication; evidenceSpansValid: true }
  | { ok: false; reason: string; evidenceSpansValid: boolean };

export interface TaxonomyAdjudicationEligibilityInput {
  enabled: boolean;
  evaluationActive: boolean;
  speaker: "me" | "them" | "unknown";
  turnGateAction: string;
  projection: TaxonomyAdjudicationProjection;
  lexical: QuestionTypeInferenceDecision;
  semantic?: SemanticTaxonomyDecision;
  hybrid?: HybridQuestionTypeDecision;
  activeParentType?: CanonicalQuestionType;
  manualCorrectionActive: boolean;
}

export interface TaxonomyAdjudicationEligibilityDecision {
  eligible: boolean;
  reason: string;
  triggerReasons: string[];
}

export interface TaxonomyAdjudicationLease {
  operationId: string;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  sourceTurnIdsHash: string;
  taskBoundaryEpoch: number;
  manualCorrectionRevision: number;
  expectedParentId?: string;
  requestedAt: number;
}

export type TaxonomyAdjudicationLeaseRejectionReason =
  | "current-operation-mismatch"
  | "session-mismatch"
  | "runtime-epoch-mismatch"
  | "logical-unit-missing"
  | "logical-unit-id-mismatch"
  | "logical-unit-revision-mismatch"
  | "source-turn-hash-mismatch"
  | "task-boundary-epoch-mismatch"
  | "manual-correction-revision-mismatch"
  | "expected-parent-mismatch"
  | "logical-unit-closed"
  | "self-healing-budget-consumed";

export interface TaxonomyAdjudicationLeaseSnapshot {
  currentOperationId?: string;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnit?: LogicalQuestionUnit;
  taskBoundaryEpoch: number;
  manualCorrectionRevision: number;
  activeParentId?: string;
  logicalUnitClosed: boolean;
  selfHealingBudgetConsumed: boolean;
}

export function projectLogicalQuestionForAdjudication(
  unit: LogicalQuestionUnit,
  maxChars = TAXONOMY_ADJUDICATION_MAX_INPUT_CHARS
): TaxonomyAdjudicationProjection {
  const original = normalizeSpace(unit.normalizedText);
  if (original.length <= maxChars) {
    return {
      text: original,
      sourceTurnIds: [...unit.sourceTurnIds],
      omittedSourceTurnIds: [],
      originalChars: original.length,
      projectedChars: original.length,
      projectionReason: "within-limit",
      safe: Boolean(original),
    };
  }

  const sources = unit.sources
    .map((source) => ({ ...source, text: normalizeSpace(source.text) }))
    .filter((source) => source.text);
  const first = sources[0];
  const latest = sources[sources.length - 1];
  const switchSpans = sources.flatMap((source) =>
    splitSentences(source.text).filter((sentence) =>
      TASK_SWITCH_PATTERN.test(sentence)
    )
  );
  const constraintSpans = sources.flatMap((source) =>
    splitSentences(source.text).filter((sentence) =>
      CURRENT_CONSTRAINT_PATTERN.test(sentence)
    )
  );
  const selected = dedupeStrings([
    clip(first?.text ?? "", Math.floor(maxChars * 0.42), "start"),
    ...switchSpans,
    ...constraintSpans.slice(-2),
    clip(latest?.text ?? "", Math.floor(maxChars * 0.42), "end"),
  ]).filter(Boolean);
  const text = fitSegments(selected, maxChars);
  const retainedIds = sources
    .filter((source) => selected.some((segment) => source.text.includes(segment)))
    .map((source) => source.turnId);
  const sourceTurnIds = Array.from(
    new Set([first?.turnId, ...retainedIds, latest?.turnId].filter(Boolean))
  ) as string[];
  const safe = Boolean(first?.text && latest?.text && text);

  return {
    text,
    sourceTurnIds,
    omittedSourceTurnIds: unit.sourceTurnIds.filter(
      (turnId) => !sourceTurnIds.includes(turnId)
    ),
    originalChars: original.length,
    projectedChars: text.length,
    projectionReason: "anchor-switch-latest-constraint",
    safe,
  };
}

export function decideTaxonomyAdjudicationEligibility(
  input: TaxonomyAdjudicationEligibilityInput
): TaxonomyAdjudicationEligibilityDecision {
  const skip = (reason: string) => ({
    eligible: false,
    reason,
    triggerReasons: [] as string[],
  });
  if (!input.enabled) return skip("taxonomy-adjudication-disabled");
  if (!input.evaluationActive) return skip("evaluation-surface-inactive");
  if (input.speaker !== "them") return skip("speaker-is-not-interviewer");
  if (input.turnGateAction !== "answer-refresh") {
    return skip(`turn-gate-${input.turnGateAction || "unknown"}`);
  }
  if (!input.projection.safe) return skip("unsafe-question-projection");
  if (input.projection.text.split(/\s+/u).filter(Boolean).length < 3) {
    return skip("question-unit-too-short");
  }
  if (input.manualCorrectionActive) {
    return skip("manual-correction-authoritative");
  }

  const lexicalType = input.lexical.type ?? "unknown";
  const triggers: string[] = [];
  if (lexicalType === "unknown") triggers.push("lexical-unknown");
  if (input.hybrid?.outcome === "lexical-semantic-conflict") {
    triggers.push("lexical-semantic-conflict");
  }
  if (input.hybrid?.outcome === "semantic-would-rescue") {
    triggers.push("semantic-would-rescue");
  }
  if (
    input.semantic &&
    (!input.semantic.accepted || input.semantic.rejectionReasons.length > 0)
  ) {
    triggers.push("semantic-ambiguous-or-rejected");
  }
  if (
    input.activeParentType &&
    input.hybrid?.recommendedType &&
    input.hybrid.recommendedType !== input.activeParentType
  ) {
    triggers.push("candidate-parent-type-conflict");
  }
  if (
    lexicalType !== "unknown" &&
    input.lexical.confidence >= 0.85 &&
    input.lexical.margin >= 0.3 &&
    triggers.length === 0
  ) {
    return skip("high-confidence-local-classification");
  }
  if (!triggers.length) return skip("no-residual-taxonomy-ambiguity");

  return {
    eligible: true,
    reason: "residual-taxonomy-ambiguity",
    triggerReasons: Array.from(new Set(triggers)),
  };
}

export function buildTaxonomyAdjudicationRequest(input: {
  logicalQuestionUnit: LogicalQuestionUnit;
  lexical: QuestionTypeInferenceDecision;
  semantic?: SemanticTaxonomyDecision;
  hybrid?: HybridQuestionTypeDecision;
  sourceLanguage?: string;
  sttUncertaintyMarkers?: string[];
  activeParent?: TaxonomyAdjudicationParentDescriptor;
  interviewBriefTypes?: TaxonomyInterviewBriefType[];
  taskSwitchEvidence?: string[];
}): TaxonomyAdjudicationRequest {
  return {
    schemaVersion: TAXONOMY_ADJUDICATION_SCHEMA_VERSION,
    promptVersion: TAXONOMY_ADJUDICATION_PROMPT_VERSION,
    logicalQuestionUnitId: input.logicalQuestionUnit.id,
    logicalQuestionUnitRevision: input.logicalQuestionUnit.revision,
    question: projectLogicalQuestionForAdjudication(input.logicalQuestionUnit),
    sourceLanguage: input.sourceLanguage,
    sttUncertaintyMarkers: input.sttUncertaintyMarkers?.slice(0, 8),
    activeParent: sanitizeParentDescriptor(input.activeParent),
    evidence: {
      lexical: {
        type: input.lexical.type,
        confidence: input.lexical.confidence,
        margin: input.lexical.margin,
        evidence: input.lexical.evidence.slice(0, 12),
        ambiguousTerms: input.lexical.ambiguousTerms.slice(0, 12),
        scores: input.lexical.scores,
      },
      semantic: input.semantic
        ? {
            candidateType: input.semantic.candidateType,
            calibratedConfidence: input.semantic.calibratedConfidence,
            margin: input.semantic.margin,
            accepted: input.semantic.accepted,
            rejectionReasons: input.semantic.rejectionReasons.slice(0, 8),
          }
        : undefined,
      hybrid: input.hybrid
        ? {
            outcome: input.hybrid.outcome,
            reason: input.hybrid.reason,
            recommendedType: input.hybrid.recommendedType,
            wouldRescue: input.hybrid.wouldRescue,
          }
        : undefined,
    },
    interviewBriefTypes: [...(input.interviewBriefTypes ?? [])],
    taskSwitchEvidence: (input.taskSwitchEvidence ?? []).slice(0, 8),
  };
}

export function buildTaxonomyAdjudicationPrompts(
  request: TaxonomyAdjudicationRequest
) {
  return {
    systemPrompt: [
      "You classify one bounded interviewer question for Jarvis.",
      "Return one JSON object only. Do not answer the interview question.",
      "Use only the supplied question, compact parent descriptor, and local classifier evidence.",
      "Choose questionType and its relationship to the active parent. Evidence spans must be verbatim substrings of the supplied evidence.",
      "Schema: {schemaVersion:1,questionType,relation,normalizedQuestion,standalone,evidenceSpans,confidence,ambiguityReason?}.",
    ].join(" "),
    userMessage: JSON.stringify(request),
  };
}

export function parseTaxonomyAdjudicationOutput(
  rawOutput: string,
  request: TaxonomyAdjudicationRequest
): TaxonomyAdjudicationParseResult {
  if (!rawOutput.trim()) {
    return { ok: false, reason: "empty-output", evidenceSpansValid: false };
  }
  if (rawOutput.length > TAXONOMY_ADJUDICATION_MAX_OUTPUT_CHARS) {
    return { ok: false, reason: "output-too-large", evidenceSpansValid: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(rawOutput));
  } catch {
    return { ok: false, reason: "malformed-json", evidenceSpansValid: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "output-is-not-object", evidenceSpansValid: false };
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.schemaVersion !== TAXONOMY_ADJUDICATION_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: "unsupported-schema-version",
      evidenceSpansValid: false,
    };
  }
  if (!isCanonicalQuestionType(candidate.questionType)) {
    return { ok: false, reason: "invalid-question-type", evidenceSpansValid: false };
  }
  if (!isTaxonomyAdjudicationRelation(candidate.relation)) {
    return { ok: false, reason: "invalid-relation", evidenceSpansValid: false };
  }
  if (
    typeof candidate.normalizedQuestion !== "string" ||
    !candidate.normalizedQuestion.trim() ||
    candidate.normalizedQuestion.length > TAXONOMY_ADJUDICATION_MAX_INPUT_CHARS
  ) {
    return {
      ok: false,
      reason: "invalid-normalized-question",
      evidenceSpansValid: false,
    };
  }
  if (typeof candidate.standalone !== "boolean") {
    return { ok: false, reason: "invalid-standalone", evidenceSpansValid: false };
  }
  if (
    typeof candidate.confidence !== "number" ||
    !Number.isFinite(candidate.confidence) ||
    candidate.confidence < 0 ||
    candidate.confidence > 1
  ) {
    return { ok: false, reason: "invalid-confidence", evidenceSpansValid: false };
  }
  if (
    !Array.isArray(candidate.evidenceSpans) ||
    candidate.evidenceSpans.length === 0 ||
    candidate.evidenceSpans.some(
      (span) => typeof span !== "string" || !span.trim()
    )
  ) {
    return { ok: false, reason: "missing-evidence", evidenceSpansValid: false };
  }
  const allowedEvidence = buildAllowedEvidenceText(request).toLocaleLowerCase();
  const evidenceSpans = candidate.evidenceSpans as string[];
  const evidenceSpansValid = evidenceSpans.every((span) =>
    allowedEvidence.includes(normalizeSpace(span).toLocaleLowerCase())
  );
  if (!evidenceSpansValid) {
    return { ok: false, reason: "invalid-evidence-span", evidenceSpansValid };
  }
  if (
    candidate.ambiguityReason !== undefined &&
    typeof candidate.ambiguityReason !== "string"
  ) {
    return {
      ok: false,
      reason: "invalid-ambiguity-reason",
      evidenceSpansValid: true,
    };
  }

  return {
    ok: true,
    evidenceSpansValid: true,
    value: {
      schemaVersion: TAXONOMY_ADJUDICATION_SCHEMA_VERSION,
      questionType: candidate.questionType,
      relation: candidate.relation,
      normalizedQuestion: normalizeSpace(candidate.normalizedQuestion),
      standalone: candidate.standalone,
      evidenceSpans,
      confidence: candidate.confidence,
      ambiguityReason: candidate.ambiguityReason as string | undefined,
    },
  };
}

export function createTaxonomyAdjudicationLease(input: {
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnit: LogicalQuestionUnit;
  taskBoundaryEpoch: number;
  manualCorrectionRevision: number;
  expectedParentId?: string;
  operationId?: string;
  requestedAt?: number;
}): TaxonomyAdjudicationLease {
  return {
    operationId: input.operationId ?? createMeetingId("taxonomy_adjudication"),
    sessionId: input.sessionId,
    runtimeEpoch: input.runtimeEpoch,
    logicalQuestionUnitId: input.logicalQuestionUnit.id,
    logicalQuestionUnitRevision: input.logicalQuestionUnit.revision,
    sourceTurnIdsHash: hashTaxonomySourceTurnIds(
      input.logicalQuestionUnit.sourceTurnIds
    ),
    taskBoundaryEpoch: input.taskBoundaryEpoch,
    manualCorrectionRevision: input.manualCorrectionRevision,
    expectedParentId: input.expectedParentId,
    requestedAt: input.requestedAt ?? Date.now(),
  };
}

export function authorizeTaxonomyAdjudicationLease(
  lease: TaxonomyAdjudicationLease,
  current: TaxonomyAdjudicationLeaseSnapshot
):
  | { authorized: true }
  | { authorized: false; reason: TaxonomyAdjudicationLeaseRejectionReason } {
  const reject = (reason: TaxonomyAdjudicationLeaseRejectionReason) => ({
    authorized: false as const,
    reason,
  });
  if (lease.operationId !== current.currentOperationId) {
    return reject("current-operation-mismatch");
  }
  if (lease.sessionId !== current.sessionId) return reject("session-mismatch");
  if (lease.runtimeEpoch !== current.runtimeEpoch) {
    return reject("runtime-epoch-mismatch");
  }
  const unit = current.logicalQuestionUnit;
  if (!unit) return reject("logical-unit-missing");
  if (lease.logicalQuestionUnitId !== unit.id) {
    return reject("logical-unit-id-mismatch");
  }
  if (lease.logicalQuestionUnitRevision !== unit.revision) {
    return reject("logical-unit-revision-mismatch");
  }
  if (lease.sourceTurnIdsHash !== hashTaxonomySourceTurnIds(unit.sourceTurnIds)) {
    return reject("source-turn-hash-mismatch");
  }
  if (lease.taskBoundaryEpoch !== current.taskBoundaryEpoch) {
    return reject("task-boundary-epoch-mismatch");
  }
  if (lease.manualCorrectionRevision !== current.manualCorrectionRevision) {
    return reject("manual-correction-revision-mismatch");
  }
  if (lease.expectedParentId !== current.activeParentId) {
    return reject("expected-parent-mismatch");
  }
  if (current.logicalUnitClosed) return reject("logical-unit-closed");
  if (current.selfHealingBudgetConsumed) {
    return reject("self-healing-budget-consumed");
  }
  return { authorized: true };
}

export function hashTaxonomySourceTurnIds(sourceTurnIds: string[]) {
  let hash = 2_166_136_261;
  for (const character of sourceTurnIds.join("\u001f")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function hashTaxonomyTaskBoundary(input: {
  parentId?: string;
  questionType?: CanonicalQuestionType;
  relation?: string;
}) {
  return Number.parseInt(
    hashTaxonomySourceTurnIds([
      input.parentId ?? "none",
      input.questionType ?? "unknown",
      input.relation ?? "unknown",
    ]),
    16
  );
}

function isTaxonomyAdjudicationRelation(
  value: unknown
): value is TaxonomyAdjudicationRelation {
  return (
    typeof value === "string" &&
    TAXONOMY_ADJUDICATION_RELATIONS.includes(
      value as TaxonomyAdjudicationRelation
    )
  );
}

function sanitizeParentDescriptor(
  parent: TaxonomyAdjudicationParentDescriptor | undefined
) {
  if (!parent) return undefined;
  return {
    idHash: parent.idHash,
    questionType: parent.questionType,
    topic: parent.topic ? clip(normalizeSpace(parent.topic), 360, "start") : undefined,
    playbookPhase: parent.playbookPhase,
    sharedScenarioEntities: parent.sharedScenarioEntities
      ?.map(normalizeSpace)
      .filter(Boolean)
      .slice(0, 12),
  };
}

function buildAllowedEvidenceText(request: TaxonomyAdjudicationRequest) {
  return [
    request.question.text,
    request.activeParent?.topic,
    request.activeParent?.questionType,
    request.activeParent?.playbookPhase,
    ...(request.activeParent?.sharedScenarioEntities ?? []),
    ...request.taskSwitchEvidence,
    ...request.evidence.lexical.evidence,
  ]
    .filter(Boolean)
    .join("\n");
}

function stripJsonFence(value: string) {
  const trimmed = value.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

function splitSentences(value: string) {
  return value
    .split(/(?<=[.!?。！？])\s+|\n+/u)
    .map(normalizeSpace)
    .filter(Boolean);
}

function fitSegments(segments: string[], maxChars: number) {
  const output: string[] = [];
  let remaining = maxChars;
  for (const segment of segments) {
    const separatorChars = output.length ? 1 : 0;
    if (remaining <= separatorChars) break;
    const fitted = clip(segment, remaining - separatorChars, "start");
    if (!fitted) continue;
    output.push(fitted);
    remaining -= fitted.length + separatorChars;
  }
  return output.join("\n");
}

function clip(value: string, maxChars: number, side: "start" | "end") {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, maxChars);
  return side === "start"
    ? `${value.slice(0, maxChars - 3).trimEnd()}...`
    : `...${value.slice(-(maxChars - 3)).trimStart()}`;
}

function dedupeStrings(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalizeSpace(value).toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeSpace(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

const TASK_SWITCH_PATTERN =
  /\b(?:instead|now|next|switch|different|new question|separate question|move on|rather than)\b|(?:换一道|下一个|改成|另外一个|新问题)/iu;

const CURRENT_CONSTRAINT_PATTERN =
  /\b(?:use|without|with|in (?:python|java|javascript|typescript|go|rust|c\+\+)|scale|qps|latency|throughput|complexity|requirement|constraint|metric|evaluate|implement|write|code)\b|(?:使用|不用|改用|规模|并发|复杂度|约束|指标|实现|写代码)/iu;
