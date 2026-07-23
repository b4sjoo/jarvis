import { createMeetingId } from "./context-manager.js";
import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import type {
  HybridQuestionTypeDecision,
  SemanticTaxonomyDecision,
} from "./semantic-taxonomy-resolver.js";
import type {
  InterviewerEvidenceMode,
  InterviewerIntentAction,
  InterviewerIntentRelation,
  InterviewerSpeechAct,
} from "./interviewer-intent.js";
import {
  isCanonicalQuestionType,
  type CanonicalQuestionType,
  type QuestionTypeInferenceDecision,
} from "./task-taxonomy.js";

export const TAXONOMY_ADJUDICATION_SCHEMA_VERSION = 2;
export const TAXONOMY_ADJUDICATION_PROMPT_VERSION =
  "interviewer-intent-adjudication-prompt-v2";
export const TAXONOMY_ADJUDICATION_MAX_OUTPUT_CHARS = 4_096;
export const TAXONOMY_ADJUDICATION_MAX_INPUT_CHARS = 1_200;
export const TAXONOMY_ADJUDICATION_MAX_PARENT_CHARS = 400;
export const TAXONOMY_ADJUDICATION_MAX_ME_CONTEXT_CHARS = 300;
export const TAXONOMY_ADJUDICATION_MAX_PREPARATION_CHARS = 200;

export const TAXONOMY_ADJUDICATION_RELATIONS = [
  "new-parent",
  "linked-parent-extension",
  "followup-parent",
  "child-probe",
  "none",
] as const;

export type TaxonomyAdjudicationRelation =
  (typeof TAXONOMY_ADJUDICATION_RELATIONS)[number];

export interface TaxonomyAdjudicationParentDescriptor {
  idHash?: string;
  revision?: number;
  questionType?: CanonicalQuestionType;
  topic?: string;
  playbookPhase?: string;
  sharedScenarioEntities?: string[];
}

export interface TaxonomyAdjudicationSourceContext {
  latestMeCorrection?: string;
  sectionHint?: string;
  preparationPrior?: string;
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
  schemaVersion: 2;
  promptVersion: string;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  question: TaxonomyAdjudicationProjection;
  sourceLanguage?: string;
  sttUncertaintyMarkers?: string[];
  activeParent?: TaxonomyAdjudicationParentDescriptor;
  sourceContext?: TaxonomyAdjudicationSourceContext;
  taskSwitchEvidence: string[];
}

export interface LlmTaxonomyAdjudication {
  schemaVersion: 2;
  speechAct: InterviewerSpeechAct;
  questionType: CanonicalQuestionType;
  relation: InterviewerIntentRelation;
  evidenceMode: InterviewerEvidenceMode;
  action: InterviewerIntentAction;
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
  expectedParentRevision?: number;
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
  | "expected-parent-revision-mismatch"
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
  activeParentRevision?: number;
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
  if (!input.projection.safe) return skip("unsafe-question-projection");
  if (estimateQuestionWordEquivalents(input.projection.text) < 3) {
    return skip("question-unit-too-short");
  }
  if (input.manualCorrectionActive) {
    return skip("manual-correction-authoritative");
  }

  const lexicalType = input.lexical.type ?? "unknown";
  const triggers: string[] = [];
  if (input.turnGateAction !== "answer-refresh") {
    triggers.push(`substantive-${input.turnGateAction || "suppressed"}-turn`);
  }
  if (lexicalType === "unknown") triggers.push("lexical-unknown");
  if (input.hybrid?.outcome === "lexical-semantic-conflict") {
    triggers.push("lexical-semantic-conflict");
  }
  if (input.hybrid?.outcome === "semantic-would-rescue") {
    triggers.push("semantic-would-rescue");
  }
  if (
    input.semantic &&
    (!input.semantic.accepted || input.semantic.rejectionReasons.length > 0) &&
    (lexicalType === "unknown" ||
      input.lexical.confidence < 0.8 ||
      input.lexical.margin < 0.2)
  ) {
    triggers.push("semantic-ambiguous-or-rejected");
  }
  if (
    lexicalType !== "unknown" &&
    (input.lexical.confidence < 0.75 || input.lexical.margin < 0.15)
  ) {
    triggers.push("low-confidence-lexical");
  }
  if (
    input.activeParentType &&
    input.hybrid?.recommendedType &&
    input.hybrid.recommendedType !== input.activeParentType
  ) {
    triggers.push("candidate-parent-type-conflict");
  }
  if (
    input.turnGateAction === "answer-refresh" &&
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

function estimateQuestionWordEquivalents(value: string) {
  const normalized = normalizeSpace(value);
  const cjkCharacters = normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  const nonCjkWords = normalized
    .replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, " ")
    .split(/\s+/u)
    .filter(Boolean).length;
  return nonCjkWords + Math.ceil(cjkCharacters / 2);
}

export function buildTaxonomyAdjudicationRequest(input: {
  logicalQuestionUnit: LogicalQuestionUnit;
  sourceLanguage?: string;
  sttUncertaintyMarkers?: string[];
  activeParent?: TaxonomyAdjudicationParentDescriptor;
  latestMeCorrection?: string;
  sectionHint?: string;
  preparationPrior?: string;
  taskSwitchEvidence?: string[];
}): TaxonomyAdjudicationRequest {
  const sourceContext = {
    latestMeCorrection: clipOptional(
      input.latestMeCorrection,
      TAXONOMY_ADJUDICATION_MAX_ME_CONTEXT_CHARS
    ),
    sectionHint: clipOptional(input.sectionHint, 160),
    preparationPrior: clipOptional(
      input.preparationPrior,
      TAXONOMY_ADJUDICATION_MAX_PREPARATION_CHARS
    ),
  };
  return {
    schemaVersion: TAXONOMY_ADJUDICATION_SCHEMA_VERSION,
    promptVersion: TAXONOMY_ADJUDICATION_PROMPT_VERSION,
    logicalQuestionUnitId: input.logicalQuestionUnit.id,
    logicalQuestionUnitRevision: input.logicalQuestionUnit.revision,
    question: projectLogicalQuestionForAdjudication(input.logicalQuestionUnit),
    sourceLanguage: input.sourceLanguage,
    sttUncertaintyMarkers: input.sttUncertaintyMarkers?.slice(0, 8),
    activeParent: sanitizeParentDescriptor(input.activeParent),
    sourceContext: Object.values(sourceContext).some(Boolean)
      ? sourceContext
      : undefined,
    taskSwitchEvidence: (input.taskSwitchEvidence ?? []).slice(0, 8),
  };
}

export function buildTaxonomyAdjudicationPrompts(
  request: TaxonomyAdjudicationRequest
) {
  return {
    systemPrompt: [
      "You independently classify one bounded interviewer utterance for Jarvis.",
      "Return one JSON object only. Do not answer the interview question.",
      "Use only source-owned question text, compact parent context, the latest candidate correction, section hint, and preparation prior.",
      "No keyword or embedding classifier result is supplied; make an independent judgment.",
      "Choose speechAct, questionType, relation, evidenceMode, and action. Evidence spans must be verbatim substrings of supplied source text.",
      "Allowed speechAct: question, directive, constraint, correction, acknowledgement, section-transition, logistics, informational.",
      "Allowed relation: new-parent, followup-parent, child-probe, linked-parent-extension, none.",
      "Allowed evidenceMode: personal-experience, hypothetical-design, factual-explanation, unknown.",
      "Allowed action: answer, append-context, buffer, ignore.",
      "Schema: {schemaVersion:2,speechAct,questionType,relation,evidenceMode,action,normalizedQuestion,standalone,evidenceSpans,confidence,ambiguityReason?}.",
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
  if (!isInterviewerSpeechAct(candidate.speechAct)) {
    return { ok: false, reason: "invalid-speech-act", evidenceSpansValid: false };
  }
  if (!isTaxonomyAdjudicationRelation(candidate.relation)) {
    return { ok: false, reason: "invalid-relation", evidenceSpansValid: false };
  }
  if (!isInterviewerEvidenceMode(candidate.evidenceMode)) {
    return { ok: false, reason: "invalid-evidence-mode", evidenceSpansValid: false };
  }
  if (!isInterviewerIntentAction(candidate.action)) {
    return { ok: false, reason: "invalid-action", evidenceSpansValid: false };
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
      speechAct: candidate.speechAct,
      questionType: candidate.questionType,
      relation: candidate.relation,
      evidenceMode: candidate.evidenceMode,
      action: candidate.action,
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
  expectedParentRevision?: number;
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
    expectedParentRevision: input.expectedParentRevision,
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
  if (lease.expectedParentRevision !== current.activeParentRevision) {
    return reject("expected-parent-revision-mismatch");
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

const INTERVIEWER_SPEECH_ACTS: InterviewerSpeechAct[] = [
  "question",
  "directive",
  "constraint",
  "correction",
  "acknowledgement",
  "section-transition",
  "logistics",
  "informational",
];

const INTERVIEWER_EVIDENCE_MODES: InterviewerEvidenceMode[] = [
  "personal-experience",
  "hypothetical-design",
  "factual-explanation",
  "unknown",
];

const INTERVIEWER_INTENT_ACTIONS: InterviewerIntentAction[] = [
  "answer",
  "append-context",
  "buffer",
  "ignore",
];

function isInterviewerSpeechAct(value: unknown): value is InterviewerSpeechAct {
  return (
    typeof value === "string" &&
    INTERVIEWER_SPEECH_ACTS.includes(value as InterviewerSpeechAct)
  );
}

function isInterviewerEvidenceMode(
  value: unknown
): value is InterviewerEvidenceMode {
  return (
    typeof value === "string" &&
    INTERVIEWER_EVIDENCE_MODES.includes(value as InterviewerEvidenceMode)
  );
}

function isInterviewerIntentAction(
  value: unknown
): value is InterviewerIntentAction {
  return (
    typeof value === "string" &&
    INTERVIEWER_INTENT_ACTIONS.includes(value as InterviewerIntentAction)
  );
}

function sanitizeParentDescriptor(
  parent: TaxonomyAdjudicationParentDescriptor | undefined
) {
  if (!parent) return undefined;
  return {
    idHash: parent.idHash,
    revision: parent.revision,
    questionType: parent.questionType,
    topic: parent.topic
      ? clip(
          normalizeSpace(parent.topic),
          TAXONOMY_ADJUDICATION_MAX_PARENT_CHARS,
          "start"
        )
      : undefined,
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
    request.sourceContext?.latestMeCorrection,
    request.sourceContext?.sectionHint,
    request.sourceContext?.preparationPrior,
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

function clipOptional(value: string | undefined, maxChars: number) {
  const normalized = value ? normalizeSpace(value) : "";
  return normalized ? clip(normalized, maxChars, "start") : undefined;
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
