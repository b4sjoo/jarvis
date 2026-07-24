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
  CANONICAL_QUESTION_TYPES,
  isCanonicalQuestionType,
  type CanonicalQuestionType,
  type QuestionTypeInferenceDecision,
} from "./task-taxonomy.js";

export const TAXONOMY_ADJUDICATION_SCHEMA_VERSION = 2;
export const TAXONOMY_ADJUDICATION_PROMPT_VERSION =
  "interviewer-intent-adjudication-prompt-v4";
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

export interface TaxonomyAdjudicationSourceTurn {
  turnId: string;
  text: string;
}

export interface TaxonomyAdjudicationProjection {
  text: string;
  sourceTurns: TaxonomyAdjudicationSourceTurn[];
  sourceTurnIds: string[];
  omittedSourceTurnIds: string[];
  originalChars: number;
  projectedChars: number;
  projectionReason: "within-limit" | "anchor-switch-latest-constraint";
  safe: boolean;
}

export interface TaxonomyAdjudicationSourceSpan {
  turnId: string;
  text: string;
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
  normalizedQuestionSource?: "model" | "source-primary-ask-repair";
  normalizedQuestionRepairReason?: "action-object-not-preserved";
  primaryAskSpans: TaxonomyAdjudicationSourceSpan[];
  standalone: boolean;
  evidenceSpans: string[];
  confidence: number;
  ambiguityReason?: string;
}

export type TaxonomyAdjudicationParseErrorKind =
  | "parse"
  | "schema"
  | "evidence"
  | "provider";

export type TaxonomyAdjudicationOutputEnvelope =
  | "direct"
  | "json-code-fence"
  | "result-wrapper"
  | "output-wrapper"
  | "response-wrapper";

export type TaxonomyAdjudicationParseResult =
  | {
      ok: true;
      value: LlmTaxonomyAdjudication;
      evidenceSpansValid: true;
      envelope: TaxonomyAdjudicationOutputEnvelope;
    }
  | {
      ok: false;
      reason: string;
      errorKind: TaxonomyAdjudicationParseErrorKind;
      evidenceSpansValid: boolean;
    };

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
  const sources = normalizeAdjudicationSourceTurns(unit);
  const original = joinAdjudicationSourceTurns(sources);
  if (original.length <= maxChars) {
    const sourceTurnIds = sources.map((source) => source.turnId);
    return {
      text: original,
      sourceTurns: sources,
      sourceTurnIds,
      omittedSourceTurnIds: unit.sourceTurnIds.filter(
        (turnId) => !sourceTurnIds.includes(turnId)
      ),
      originalChars: original.length,
      projectedChars: original.length,
      projectionReason: "within-limit",
      safe: Boolean(original && sourceTurnIds.length),
    };
  }

  const first = sources[0];
  const latest = sources[sources.length - 1];
  const switchSpans = sources.flatMap((source) =>
    splitSentences(source.text)
      .filter((sentence) => TASK_SWITCH_PATTERN.test(sentence))
      .map((text) => ({ turnId: source.turnId, text }))
  );
  const constraintSpans = sources.flatMap((source) =>
    splitSentences(source.text)
      .filter((sentence) => CURRENT_CONSTRAINT_PATTERN.test(sentence))
      .map((text) => ({ turnId: source.turnId, text }))
  );
  const selected = dedupeSourceSegments([
    {
      turnId: first?.turnId ?? "",
      text: clipSourceText(
        first?.text ?? "",
        Math.floor(maxChars * 0.42),
        "start"
      ),
    },
    ...switchSpans,
    ...constraintSpans.slice(-2),
    {
      turnId: latest?.turnId ?? "",
      text: clipSourceText(
        latest?.text ?? "",
        Math.floor(maxChars * 0.42),
        "end"
      ),
    },
  ]);
  const sourceTurns = fitSourceSegments(selected, maxChars);
  const text = joinAdjudicationSourceTurns(sourceTurns);
  const sourceTurnIds = sourceTurns.map((source) => source.turnId);
  const safe = Boolean(
    first?.text &&
      latest?.text &&
      text &&
      sourceTurnIds.includes(first.turnId) &&
      sourceTurnIds.includes(latest.turnId)
  );

  return {
    text,
    sourceTurns,
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
  const canonicalQuestionTypes = CANONICAL_QUESTION_TYPES.join(", ");
  const {
    text: _mergedQuestionText,
    ...sourceAddressableQuestion
  } = request.question;
  const packet = {
    ...request,
    question: sourceAddressableQuestion,
  };
  return {
    systemPrompt: [
      "You independently classify one bounded interviewer utterance for Jarvis.",
      "Return one JSON object only. Do not answer the interview question.",
      "Use only source-owned question text, compact parent context, the latest candidate correction, section hint, and preparation prior.",
      "No keyword or embedding classifier result is supplied; make an independent judgment.",
      "question.sourceTurns is an ordered array of source-owned {turnId,text} records. The source may contain setup, quoted or future example questions, and one current terminal ask. Classify the current primary ask, not quoted examples.",
      "Choose speechAct, questionType, relation, evidenceMode, and action.",
      "Allowed speechAct: question, directive, constraint, correction, acknowledgement, section-transition, logistics, informational.",
      `Allowed questionType: ${canonicalQuestionTypes}. Use unknown for recruiter logistics, scheduling, compensation, sponsorship, procedural guidance, acknowledgements, filler, and any speech outside these interview-task families.`,
      "Allowed relation: new-parent, followup-parent, child-probe, linked-parent-extension, none.",
      "Allowed evidenceMode: personal-experience, hypothetical-design, factual-explanation, unknown.",
      "Allowed action: answer, append-context, buffer, ignore.",
      "For a recruiter self-introduction, resume walkthrough, or project-opening request, use project-deep-dive. For recruiter logistics or filler, use unknown.",
      "normalizedQuestion is the normalized current primary or terminal ask. It must be non-empty when action is answer; otherwise it may be an empty string.",
      "For an action request, normalizedQuestion must preserve both the requested operation and its concrete target object from primaryAskSpans. Never replace a concrete request such as 'Let's do a ride-sharing backend' with a generic label such as 'design question'.",
      "primaryAskSpans is an array of {turnId,text}. Each text must be an exact verbatim substring of the source turn named by turnId. Use the occurrence that is the current primary ask, even when identical text appears in an earlier quoted or future example. It must be non-empty when action is answer and may be empty otherwise.",
      "evidenceSpans must contain exact verbatim substrings from supplied source text or compact parent context.",
      "Example logistics result: {\"schemaVersion\":2,\"speechAct\":\"logistics\",\"questionType\":\"unknown\",\"relation\":\"none\",\"evidenceMode\":\"unknown\",\"action\":\"append-context\",\"normalizedQuestion\":\"\",\"primaryAskSpans\":[],\"standalone\":false,\"evidenceSpans\":[\"The call will take thirty minutes\"],\"confidence\":0.95}.",
      "Example filler result: {\"schemaVersion\":2,\"speechAct\":\"acknowledgement\",\"questionType\":\"unknown\",\"relation\":\"none\",\"evidenceMode\":\"unknown\",\"action\":\"ignore\",\"normalizedQuestion\":\"\",\"primaryAskSpans\":[],\"standalone\":false,\"evidenceSpans\":[\"Sounds good\"],\"confidence\":0.98}.",
      "Example answer primaryAskSpans: [{\"turnId\":\"turn-2\",\"text\":\"How does this role sound relative to what you are looking for?\"}].",
      "Schema: {schemaVersion:2,speechAct,questionType,relation,evidenceMode,action,normalizedQuestion,primaryAskSpans:[{turnId,text}],standalone,evidenceSpans,confidence,ambiguityReason?}.",
    ].join(" "),
    userMessage: JSON.stringify(packet),
  };
}

export function parseTaxonomyAdjudicationOutput(
  rawOutput: string,
  request: TaxonomyAdjudicationRequest
): TaxonomyAdjudicationParseResult {
  if (!rawOutput.trim()) {
    return parseFailure("empty-output", "parse");
  }
  if (rawOutput.length > TAXONOMY_ADJUDICATION_MAX_OUTPUT_CHARS) {
    return parseFailure("output-too-large", "parse");
  }
  const decoded = decodeTaxonomyAdjudicationEnvelope(rawOutput);
  if (!decoded.ok) {
    return parseFailure(decoded.reason, "parse");
  }
  const parsed = decoded.value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return parseFailure("output-is-not-object", "schema");
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.schemaVersion !== TAXONOMY_ADJUDICATION_SCHEMA_VERSION) {
    return parseFailure("unsupported-schema-version", "schema");
  }
  if (!isCanonicalQuestionType(candidate.questionType)) {
    return parseFailure("invalid-question-type", "schema");
  }
  if (!isInterviewerSpeechAct(candidate.speechAct)) {
    return parseFailure("invalid-speech-act", "schema");
  }
  if (!isTaxonomyAdjudicationRelation(candidate.relation)) {
    return parseFailure("invalid-relation", "schema");
  }
  if (!isInterviewerEvidenceMode(candidate.evidenceMode)) {
    return parseFailure("invalid-evidence-mode", "schema");
  }
  if (!isInterviewerIntentAction(candidate.action)) {
    return parseFailure("invalid-action", "schema");
  }
  if (
    typeof candidate.normalizedQuestion !== "string" ||
    candidate.normalizedQuestion.length > TAXONOMY_ADJUDICATION_MAX_INPUT_CHARS
  ) {
    return parseFailure("invalid-normalized-question", "schema");
  }
  if (
    candidate.action === "answer" &&
    !candidate.normalizedQuestion.trim()
  ) {
    return parseFailure("missing-normalized-question", "schema");
  }
  if (
    !Array.isArray(candidate.primaryAskSpans) ||
    candidate.primaryAskSpans.length > 8 ||
    candidate.primaryAskSpans.some(
      (span) => !isTaxonomyAdjudicationSourceSpan(span)
    )
  ) {
    return parseFailure("invalid-primary-ask-spans", "schema");
  }
  const primaryAskSpans = (
    candidate.primaryAskSpans as TaxonomyAdjudicationSourceSpan[]
  ).map((span) => ({ turnId: span.turnId, text: span.text }));
  if (candidate.action === "answer" && primaryAskSpans.length === 0) {
    return parseFailure("missing-primary-ask", "schema");
  }
  const sourceTurnsById = new Map(
    request.question.sourceTurns.map((source) => [source.turnId, source.text])
  );
  const primaryAskSpansValid = primaryAskSpans.every((span) => {
    const sourceText = sourceTurnsById.get(span.turnId);
    return Boolean(sourceText?.includes(span.text));
  });
  if (!primaryAskSpansValid) {
    return parseFailure("invalid-primary-ask-span", "evidence");
  }
  if (typeof candidate.standalone !== "boolean") {
    return parseFailure("invalid-standalone", "schema");
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
    !Array.isArray(candidate.evidenceSpans) ||
    candidate.evidenceSpans.length === 0 ||
    candidate.evidenceSpans.some(
      (span) => typeof span !== "string" || !span.trim()
    )
  ) {
    return parseFailure("missing-evidence", "schema");
  }
  const allowedEvidence = buildAllowedEvidenceText(request).toLocaleLowerCase();
  const evidenceSpans = candidate.evidenceSpans as string[];
  const evidenceSpansValid = evidenceSpans.every((span) =>
    allowedEvidence.includes(normalizeSpace(span).toLocaleLowerCase())
  );
  if (!evidenceSpansValid) {
    return parseFailure("invalid-evidence-span", "evidence", evidenceSpansValid);
  }
  if (
    candidate.ambiguityReason !== undefined &&
    typeof candidate.ambiguityReason !== "string"
  ) {
    return parseFailure("invalid-ambiguity-reason", "schema", true);
  }

  const normalizedQuestion = normalizeSpace(candidate.normalizedQuestion);
  const sourceBackedQuestion = normalizeSpace(
    primaryAskSpans.map((span) => span.text).join(" ")
  );
  const actionObjectPreserved = preservesActionObject(
    sourceBackedQuestion,
    normalizedQuestion
  );
  const repairedNormalizedQuestion =
    candidate.action === "answer" && !actionObjectPreserved
      ? sourceBackedQuestion
      : normalizedQuestion;

  return {
    ok: true,
    evidenceSpansValid: true,
    envelope: decoded.envelope,
    value: {
      schemaVersion: TAXONOMY_ADJUDICATION_SCHEMA_VERSION,
      speechAct: candidate.speechAct,
      questionType: candidate.questionType,
      relation: candidate.relation,
      evidenceMode: candidate.evidenceMode,
      action: candidate.action,
      normalizedQuestion: repairedNormalizedQuestion,
      normalizedQuestionSource:
        repairedNormalizedQuestion !== normalizedQuestion
          ? "source-primary-ask-repair"
          : "model",
      normalizedQuestionRepairReason:
        repairedNormalizedQuestion !== normalizedQuestion
          ? "action-object-not-preserved"
          : undefined,
      primaryAskSpans,
      standalone: candidate.standalone,
      evidenceSpans,
      confidence: candidate.confidence,
      ambiguityReason: candidate.ambiguityReason as string | undefined,
    },
  };
}

function preservesActionObject(source: string, normalizedQuestion: string) {
  const sourceTokens = extractDistinctActionObjectTokens(source);
  if (sourceTokens.length === 0) return true;
  const normalizedTokens = new Set(tokenizeForActionObject(normalizedQuestion));
  return sourceTokens.some((token) => normalizedTokens.has(token));
}

function extractDistinctActionObjectTokens(text: string) {
  const normalized = normalizeSpace(text).toLocaleLowerCase();
  const action =
    /(?:^|\b)(?:(?:maybe\s+)?let(?:'s| us)\s+)?(?:do|design|build|implement|write|code|solve|create|sketch)\s+(?<object>.+)$/iu.exec(
      normalized
    );
  if (!action?.groups?.object) return [];
  return tokenizeForActionObject(action.groups.object).filter(
    (token) => !ACTION_OBJECT_GENERIC_TOKENS.has(token)
  );
}

function tokenizeForActionObject(text: string) {
  return text
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}+#]+/gu)
    ?.filter(Boolean) ?? [];
}

const ACTION_OBJECT_GENERIC_TOKENS = new Set([
  "a",
  "an",
  "and",
  "backend",
  "design",
  "for",
  "of",
  "problem",
  "question",
  "some",
  "system",
  "task",
  "the",
  "this",
  "that",
  "to",
]);

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

function isTaxonomyAdjudicationSourceSpan(
  value: unknown
): value is TaxonomyAdjudicationSourceSpan {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.turnId === "string" &&
    Boolean(candidate.turnId.trim()) &&
    typeof candidate.text === "string" &&
    Boolean(candidate.text.trim())
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
    ...request.question.sourceTurns.map((source) => source.text),
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

function decodeTaxonomyAdjudicationEnvelope(
  rawOutput: string
):
  | {
      ok: true;
      value: unknown;
      envelope: TaxonomyAdjudicationOutputEnvelope;
    }
  | { ok: false; reason: "malformed-json" | "invalid-output-wrapper" } {
  const fenced = stripJsonFence(rawOutput);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced.value);
  } catch {
    return { ok: false, reason: "malformed-json" };
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    "schemaVersion" in parsed
  ) {
    return {
      ok: true,
      value: parsed,
      envelope: fenced.wasFenced ? "json-code-fence" : "direct",
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: true,
      value: parsed,
      envelope: fenced.wasFenced ? "json-code-fence" : "direct",
    };
  }
  const wrapper = parsed as Record<string, unknown>;
  for (const key of ["result", "output", "response"] as const) {
    if (!(key in wrapper)) continue;
    const nested = decodeNestedTaxonomyAdjudicationValue(wrapper[key]);
    if (!nested.ok) return nested;
    return {
      ok: true,
      value: nested.value,
      envelope: `${key}-wrapper`,
    };
  }
  return { ok: false, reason: "invalid-output-wrapper" };
}

function decodeNestedTaxonomyAdjudicationValue(
  value: unknown
): { ok: true; value: unknown } | { ok: false; reason: "invalid-output-wrapper" } {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ok: true, value };
  }
  if (typeof value !== "string") {
    return { ok: false, reason: "invalid-output-wrapper" };
  }
  try {
    const fenced = stripJsonFence(value);
    const parsed = JSON.parse(fenced.value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ok: true, value: parsed }
      : { ok: false, reason: "invalid-output-wrapper" };
  } catch {
    return { ok: false, reason: "invalid-output-wrapper" };
  }
}

function parseFailure(
  reason: string,
  errorKind: TaxonomyAdjudicationParseErrorKind,
  evidenceSpansValid = false
): TaxonomyAdjudicationParseResult {
  return { ok: false, reason, errorKind, evidenceSpansValid };
}

function stripJsonFence(value: string) {
  const trimmed = value.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  return {
    value: match?.[1]?.trim() ?? trimmed,
    wasFenced: Boolean(match),
  };
}

function splitSentences(value: string) {
  return value
    .split(/(?<=[.!?。！？])\s+|\n+/u)
    .map(normalizeSpace)
    .filter(Boolean);
}

function normalizeAdjudicationSourceTurns(
  unit: LogicalQuestionUnit
): TaxonomyAdjudicationSourceTurn[] {
  const sources = unit.sources
    .map((source) => ({
      turnId: source.turnId,
      text: normalizeSpace(source.text),
    }))
    .filter((source) => source.turnId && source.text);
  if (sources.length) return sources;
  const fallbackText = normalizeSpace(unit.normalizedText);
  const fallbackTurnId = unit.currentTurnId || unit.sourceTurnIds[0];
  return fallbackText && fallbackTurnId
    ? [{ turnId: fallbackTurnId, text: fallbackText }]
    : [];
}

function joinAdjudicationSourceTurns(
  sources: TaxonomyAdjudicationSourceTurn[]
) {
  return sources.map((source) => source.text).join("\n");
}

function fitSourceSegments(
  segments: TaxonomyAdjudicationSourceTurn[],
  maxChars: number
) {
  const fitted: TaxonomyAdjudicationSourceTurn[] = [];
  let remaining = maxChars;
  for (const segment of segments) {
    const separatorChars = fitted.length ? 1 : 0;
    if (remaining <= separatorChars) break;
    const text = clipSourceText(
      segment.text,
      remaining - separatorChars,
      "start"
    );
    if (!segment.turnId || !text) continue;
    fitted.push({ turnId: segment.turnId, text });
    remaining -= text.length + separatorChars;
  }

  const grouped = new Map<string, string[]>();
  for (const segment of fitted) {
    const values = grouped.get(segment.turnId) ?? [];
    values.push(segment.text);
    grouped.set(segment.turnId, values);
  }
  return [...grouped].map(([turnId, values]) => ({
    turnId,
    text: values.join("\n"),
  }));
}

function clip(value: string, maxChars: number, side: "start" | "end") {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, maxChars);
  return side === "start"
    ? `${value.slice(0, maxChars - 3).trimEnd()}...`
    : `...${value.slice(-(maxChars - 3)).trimStart()}`;
}

function clipSourceText(
  value: string,
  maxChars: number,
  side: "start" | "end"
) {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  return side === "start"
    ? value.slice(0, maxChars).trimEnd()
    : value.slice(-maxChars).trimStart();
}

function clipOptional(value: string | undefined, maxChars: number) {
  const normalized = value ? normalizeSpace(value) : "";
  return normalized ? clip(normalized, maxChars, "start") : undefined;
}

function dedupeSourceSegments(values: TaxonomyAdjudicationSourceTurn[]) {
  const seen = new Set<string>();
  const result: TaxonomyAdjudicationSourceTurn[] = [];
  for (const value of values) {
    const text = normalizeSpace(value.text);
    const key = `${value.turnId}\u001f${text.toLocaleLowerCase()}`;
    if (!value.turnId || !text || seen.has(key)) continue;
    seen.add(key);
    result.push({ turnId: value.turnId, text });
  }
  return result;
}

function normalizeSpace(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

const TASK_SWITCH_PATTERN =
  /\b(?:instead|now|next|switch|different|new question|separate question|move on|rather than)\b|(?:换一道|下一个|改成|另外一个|新问题)/iu;

const CURRENT_CONSTRAINT_PATTERN =
  /\b(?:use|without|with|in (?:python|java|javascript|typescript|go|rust|c\+\+)|scale|qps|latency|throughput|complexity|requirement|constraint|metric|evaluate|implement|write|code)\b|(?:使用|不用|改用|规模|并发|复杂度|约束|指标|实现|写代码)/iu;
