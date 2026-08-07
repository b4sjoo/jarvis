import type { AnswerSufficiencyDecision } from "./answer-sufficiency.js";
import type { AnswerArtifactSection } from "./answer-generation-lease.js";
import type { CurrentQuestionRelation } from "./current-question-settlement.js";
import { inferProgrammingLanguageFromCodeFence } from "./programming-language.js";
import type { SettledAdvisorArtifactIntent } from "./settled-advisor-execution-plan.js";
import type { CanonicalQuestionType } from "./task-taxonomy.js";
import type { ParsedMeetingAnswer } from "./types.js";

export const ADVISOR_RESPONSE_FINGERPRINT_SCHEMA_VERSION = 1;
export const ADVISOR_RESPONSE_CONSISTENCY_SHADOW_VERSION =
  "advisor-response-consistency-shadow-v1";
export const ADVISOR_RESPONSE_EXPLORATORY_THRESHOLD_VERSION =
  "advisor-response-exploratory-thresholds-v0";

export type AdvisorArtifactFamily = "code" | "whiteboard";

export interface AdvisorResponseArtifactSignature {
  hasCode: boolean;
  hasComplexity: boolean;
  hasWhiteboard: boolean;
  codeLanguage?: string;
  whiteboardFormat?: "mermaid" | "ascii" | "plain-text";
  mutatedFamilies: AdvisorArtifactFamily[];
  requiredFamilies: AdvisorArtifactFamily[];
  missingRequiredFamilies: AdvisorArtifactFamily[];
  unauthorizedMutationFamilies: AdvisorArtifactFamily[];
}

export interface AdvisorResponseProfile {
  answerChars: number;
  approachChars: number;
  clarificationCount: number;
  refusalLike: boolean;
  contextInsufficientLike: boolean;
}

export interface AdvisorResponseFingerprint {
  schemaVersion: typeof ADVISOR_RESPONSE_FINGERPRINT_SCHEMA_VERSION;
  fingerprintId: string;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string | null;
  logicalQuestionRevision: number | null;
  settlementId?: string;
  executionPlanId?: string;
  answerRevision: number;
  sourceTraceId?: string;
  questionType: CanonicalQuestionType;
  relation?: CurrentQuestionRelation;
  parentTaskId?: string;
  playbookPhase?: string;
  manualCorrectionRevision: number;
  questionHash: string;
  questionChars: number;
  answerHash: string;
  approachHash: string;
  questionEmbeddingRef?: string;
  spokenAnswerEmbeddingRef?: string;
  approachEmbeddingRef?: string;
  artifactSignature: AdvisorResponseArtifactSignature;
  answerProfile: AdvisorResponseProfile;
  commitDisposition: "visible-committed";
  createdAt: number;
}

export interface AdvisorResponseSemanticSource {
  questionText: string;
  answerText: string;
  approachText: string;
}

export interface AdvisorResponseFingerprintRecord {
  fingerprint: AdvisorResponseFingerprint;
  semanticSource: AdvisorResponseSemanticSource;
}

export interface AdvisorResponseFingerprintLease {
  fingerprintId: string;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string | null;
  logicalQuestionRevision: number | null;
  answerRevision: number;
  manualCorrectionRevision: number;
}

export type AdvisorResponseConsistencyQuadrant =
  | "question-high-answer-high"
  | "question-high-answer-low"
  | "question-low-answer-high"
  | "question-low-answer-low"
  | "indeterminate";

export type AdvisorResponseAnomalyReason =
  | "answer-diverged-for-similar-question"
  | "answer-reused-for-different-question"
  | "artifact-contract-mismatch";

export interface AdvisorResponseConsistencyThresholds {
  version: string;
  highQuestionSimilarity: number;
  lowQuestionSimilarity: number;
  highAnswerSimilarity: number;
  lowAnswerSimilarity: number;
}

export interface AdvisorResponseConsistencyObservation {
  schemaVersion: 1;
  operationId: string;
  currentFingerprintId: string;
  previousFingerprintId: string;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string | null;
  logicalQuestionRevision: number | null;
  answerRevision: number;
  questionSimilarity: number;
  answerSimilarity: number;
  approachSimilarity?: number;
  quadrant: AdvisorResponseConsistencyQuadrant;
  anomalyReasons: AdvisorResponseAnomalyReason[];
  artifactMismatchReasons: string[];
  thresholdVersion: string;
  modelVersion?: string;
  embeddingDurationMs?: number;
  disposition: "shadow" | "stale" | "unavailable";
  createdAt: number;
}

export type AdvisorIndependentChallengeEvidence =
  | "keyword-type-disagreement"
  | "semantic-type-disagreement"
  | "llm-type-disagreement"
  | "answer-context-insufficient-resolvable"
  | "artifact-contract-mismatch"
  | "manual-correction"
  | "manual-context-action"
  | "manual-regenerate";

export interface AdvisorHypothesisChallenge {
  schemaVersion: 1;
  operationId: string;
  fingerprintId: string;
  logicalQuestionUnitId: string | null;
  logicalQuestionRevision: number | null;
  answerRevision: number;
  challenged: boolean;
  reason:
    | "response-anomaly-with-independent-evidence"
    | "no-response-anomaly"
    | "independent-evidence-missing";
  anomalyReasons: AdvisorResponseAnomalyReason[];
  independentEvidence: AdvisorIndependentChallengeEvidence[];
  behaviorMutationBlocked: true;
  createdAt: number;
}

export const EXPLORATORY_ADVISOR_RESPONSE_THRESHOLDS:
  AdvisorResponseConsistencyThresholds = {
    version: ADVISOR_RESPONSE_EXPLORATORY_THRESHOLD_VERSION,
    highQuestionSimilarity: 0.86,
    lowQuestionSimilarity: 0.56,
    highAnswerSimilarity: 0.88,
    lowAnswerSimilarity: 0.54,
  };

export function createAdvisorResponseFingerprintRecord(input: {
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string | null;
  logicalQuestionRevision: number | null;
  settlementId?: string;
  executionPlanId?: string;
  answerRevision: number;
  sourceTraceId?: string;
  questionType: CanonicalQuestionType;
  relation?: CurrentQuestionRelation;
  parentTaskId?: string;
  playbookPhase?: string;
  manualCorrectionRevision: number;
  questionText: string;
  parsedAnswer: ParsedMeetingAnswer;
  requiredArtifacts?: AnswerArtifactSection[];
  artifactIntent?: SettledAdvisorArtifactIntent;
  artifactPolicy?: {
    allowCode: boolean;
    allowComplexity: boolean;
    allowWhiteboard: boolean;
  };
  mutatedArtifacts?: AnswerArtifactSection[];
  answerSufficiencyDecision?: AnswerSufficiencyDecision;
  createdAt?: number;
}): AdvisorResponseFingerprintRecord {
  const createdAt = input.createdAt ?? Date.now();
  const questionText = normalizeSemanticText(input.questionText);
  const answerText = normalizeSemanticText(
    input.parsedAnswer.sections.answer ?? ""
  );
  const approachText = normalizeSemanticText(
    input.parsedAnswer.sections.approach ?? ""
  );
  const questionHash = stableHash(questionText);
  const answerHash = stableHash(answerText);
  const approachHash = stableHash(approachText);
  const identity = [
    input.sessionId,
    input.runtimeEpoch,
    input.logicalQuestionUnitId ?? "unbound",
    input.logicalQuestionRevision ?? 0,
    input.answerRevision,
    questionHash,
    answerHash,
  ].join(":");
  const artifactSignature = buildAdvisorResponseArtifactSignature({
    parsedAnswer: input.parsedAnswer,
    requiredArtifacts: input.requiredArtifacts ?? [],
    artifactIntent: input.artifactIntent,
    artifactPolicy: input.artifactPolicy,
    mutatedArtifacts: input.mutatedArtifacts ?? [],
  });
  const contextInsufficientLike =
    input.answerSufficiencyDecision?.answerStatus ===
      "context-insufficient" ||
    CONTEXT_INSUFFICIENT_PATTERN.test(`${answerText} ${approachText}`);

  return {
    fingerprint: {
      schemaVersion: ADVISOR_RESPONSE_FINGERPRINT_SCHEMA_VERSION,
      fingerprintId: `advisor_response_${stableHash(identity)}`,
      sessionId: input.sessionId,
      runtimeEpoch: input.runtimeEpoch,
      logicalQuestionUnitId: input.logicalQuestionUnitId,
      logicalQuestionRevision: input.logicalQuestionRevision,
      settlementId: input.settlementId,
      executionPlanId: input.executionPlanId,
      answerRevision: input.answerRevision,
      sourceTraceId: input.sourceTraceId,
      questionType: input.questionType,
      relation: input.relation,
      parentTaskId: input.parentTaskId,
      playbookPhase: input.playbookPhase,
      manualCorrectionRevision: input.manualCorrectionRevision,
      questionHash,
      questionChars: questionText.length,
      answerHash,
      approachHash,
      questionEmbeddingRef: questionText
        ? `embedding:${questionHash}`
        : undefined,
      spokenAnswerEmbeddingRef: answerText
        ? `embedding:${answerHash}`
        : undefined,
      approachEmbeddingRef: approachText
        ? `embedding:${approachHash}`
        : undefined,
      artifactSignature,
      answerProfile: {
        answerChars: answerText.length,
        approachChars: approachText.length,
        clarificationCount: Math.max(
          input.parsedAnswer.sections.clarifyingOptions.length,
          input.parsedAnswer.sections.clarifyingQuestion?.trim() ? 1 : 0
        ),
        refusalLike: REFUSAL_PATTERN.test(`${answerText} ${approachText}`),
        contextInsufficientLike,
      },
      commitDisposition: "visible-committed",
      createdAt,
    },
    semanticSource: {
      questionText,
      answerText,
      approachText,
    },
  };
}

export function buildAdvisorResponseArtifactSignature(input: {
  parsedAnswer: ParsedMeetingAnswer;
  requiredArtifacts: AnswerArtifactSection[];
  artifactIntent?: SettledAdvisorArtifactIntent;
  artifactPolicy?: {
    allowCode: boolean;
    allowComplexity: boolean;
    allowWhiteboard: boolean;
  };
  mutatedArtifacts: AnswerArtifactSection[];
}): AdvisorResponseArtifactSignature {
  const code = input.parsedAnswer.sections.code?.trim() ?? "";
  const complexity = input.parsedAnswer.sections.complexity?.trim() ?? "";
  const whiteboard = input.parsedAnswer.sections.whiteboard?.trim() ?? "";
  const requiredFamilies = artifactFamilies(input.requiredArtifacts);
  const mutatedFamilies = artifactFamilies(input.mutatedArtifacts);
  const hasCodeFamily = Boolean(code || complexity);
  const missingRequiredFamilies = requiredFamilies.filter((family) =>
    family === "code" ? !hasCodeFamily : !whiteboard
  );
  const unauthorizedMutationFamilies = mutatedFamilies.filter((family) => {
    if (!input.artifactPolicy || !input.artifactIntent) return false;
    if (family === "code") {
      return (
        input.artifactIntent !== "revise-code" ||
        !input.artifactPolicy?.allowCode ||
        (Boolean(complexity) && !input.artifactPolicy?.allowComplexity)
      );
    }
    return (
      input.artifactIntent !== "revise-whiteboard" ||
      !input.artifactPolicy?.allowWhiteboard
    );
  });

  return {
    hasCode: Boolean(code),
    hasComplexity: Boolean(complexity),
    hasWhiteboard: Boolean(whiteboard),
    codeLanguage: inferProgrammingLanguageFromCodeFence(
      input.parsedAnswer.rawContent
    ),
    whiteboardFormat: inferWhiteboardFormat(whiteboard),
    mutatedFamilies,
    requiredFamilies,
    missingRequiredFamilies,
    unauthorizedMutationFamilies,
  };
}

export class AdvisorResponseFingerprintCache {
  private records: AdvisorResponseFingerprintRecord[] = [];

  constructor(private readonly maxEntries = 16) {}

  get size() {
    return this.records.length;
  }

  reset() {
    this.records = [];
  }

  add(record: AdvisorResponseFingerprintRecord) {
    this.records = this.records.filter(
      (candidate) =>
        candidate.fingerprint.fingerprintId !==
        record.fingerprint.fingerprintId
    );
    this.records.push(cloneFingerprintRecord(record));
    if (this.records.length > this.maxEntries) {
      this.records.splice(0, this.records.length - this.maxEntries);
    }
  }

  findPreviousComparable(
    current: AdvisorResponseFingerprint
  ): AdvisorResponseFingerprintRecord | undefined {
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const candidate = this.records[index];
      if (
        candidate.fingerprint.sessionId === current.sessionId &&
        candidate.fingerprint.runtimeEpoch === current.runtimeEpoch &&
        candidate.fingerprint.fingerprintId !== current.fingerprintId
      ) {
        return cloneFingerprintRecord(candidate);
      }
    }
    return undefined;
  }
}

export class AdvisorResponseChallengeCoordinator {
  private activeByQuestion = new Map<
    string,
    AdvisorResponseFingerprintLease
  >();

  begin(lease: AdvisorResponseFingerprintLease) {
    const key = challengeLeaseKey(lease);
    const existing = this.activeByQuestion.get(key);
    if (existing && existing.answerRevision >= lease.answerRevision) {
      return {
        accepted: false,
        reason: "older-or-duplicate-answer-revision" as const,
      };
    }
    this.activeByQuestion.set(key, { ...lease });
    return {
      accepted: true,
      reason: existing ? "superseded-older-revision" : "accepted",
    } as const;
  }

  authorize(lease: AdvisorResponseFingerprintLease) {
    const active = this.activeByQuestion.get(challengeLeaseKey(lease));
    return Boolean(
      active &&
        active.fingerprintId === lease.fingerprintId &&
        active.answerRevision === lease.answerRevision &&
        active.manualCorrectionRevision ===
          lease.manualCorrectionRevision
    );
  }

  settle(lease: AdvisorResponseFingerprintLease) {
    if (!this.authorize(lease)) return false;
    this.activeByQuestion.delete(challengeLeaseKey(lease));
    return true;
  }

  reset() {
    this.activeByQuestion.clear();
  }
}

export function createAdvisorResponseFingerprintLease(
  fingerprint: AdvisorResponseFingerprint
): AdvisorResponseFingerprintLease {
  return {
    fingerprintId: fingerprint.fingerprintId,
    sessionId: fingerprint.sessionId,
    runtimeEpoch: fingerprint.runtimeEpoch,
    logicalQuestionUnitId: fingerprint.logicalQuestionUnitId,
    logicalQuestionRevision: fingerprint.logicalQuestionRevision,
    answerRevision: fingerprint.answerRevision,
    manualCorrectionRevision: fingerprint.manualCorrectionRevision,
  };
}

export function authorizeAdvisorResponseFingerprintLease(input: {
  lease: AdvisorResponseFingerprintLease;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string | null;
  logicalQuestionRevision: number | null;
  visibleAnswerRevision: number;
  manualCorrectionRevision: number;
}) {
  const rejectionReasons: string[] = [];
  if (input.lease.sessionId !== input.sessionId) {
    rejectionReasons.push("session-mismatch");
  }
  if (input.lease.runtimeEpoch !== input.runtimeEpoch) {
    rejectionReasons.push("runtime-epoch-mismatch");
  }
  if (
    input.lease.logicalQuestionUnitId !== input.logicalQuestionUnitId
  ) {
    rejectionReasons.push("logical-question-unit-mismatch");
  }
  if (
    input.lease.logicalQuestionRevision !==
    input.logicalQuestionRevision
  ) {
    rejectionReasons.push("logical-question-revision-mismatch");
  }
  if (input.lease.answerRevision !== input.visibleAnswerRevision) {
    rejectionReasons.push("visible-answer-revision-mismatch");
  }
  if (
    input.lease.manualCorrectionRevision !==
    input.manualCorrectionRevision
  ) {
    rejectionReasons.push("manual-correction-revision-mismatch");
  }
  return {
    authorized: rejectionReasons.length === 0,
    rejectionReasons,
  };
}

export function observeAdvisorResponseConsistency(input: {
  current: AdvisorResponseFingerprint;
  previous: AdvisorResponseFingerprint;
  questionSimilarity: number;
  answerSimilarity: number;
  approachSimilarity?: number;
  thresholds?: AdvisorResponseConsistencyThresholds;
  modelVersion?: string;
  embeddingDurationMs?: number;
  createdAt?: number;
}): AdvisorResponseConsistencyObservation {
  const thresholds =
    input.thresholds ?? EXPLORATORY_ADVISOR_RESPONSE_THRESHOLDS;
  const questionSimilarity = clampSimilarity(input.questionSimilarity);
  const answerSimilarity = clampSimilarity(input.answerSimilarity);
  const approachSimilarity =
    input.approachSimilarity === undefined
      ? undefined
      : clampSimilarity(input.approachSimilarity);
  const quadrant = classifyConsistencyQuadrant({
    questionSimilarity,
    answerSimilarity,
    thresholds,
  });
  const artifactContractMismatchReasons = collectArtifactMismatchReasons(
    input.current.artifactSignature
  );
  const anomalyReasons: AdvisorResponseAnomalyReason[] = [];
  if (quadrant === "question-high-answer-low") {
    anomalyReasons.push("answer-diverged-for-similar-question");
  }
  if (quadrant === "question-low-answer-high") {
    anomalyReasons.push("answer-reused-for-different-question");
  }
  if (artifactContractMismatchReasons.length > 0) {
    anomalyReasons.push("artifact-contract-mismatch");
  }
  const createdAt = input.createdAt ?? Date.now();

  return {
    schemaVersion: 1,
    operationId: `advisor_response_consistency_${stableHash(
      `${input.previous.fingerprintId}:${input.current.fingerprintId}`
    )}`,
    currentFingerprintId: input.current.fingerprintId,
    previousFingerprintId: input.previous.fingerprintId,
    sessionId: input.current.sessionId,
    runtimeEpoch: input.current.runtimeEpoch,
    logicalQuestionUnitId: input.current.logicalQuestionUnitId,
    logicalQuestionRevision: input.current.logicalQuestionRevision,
    answerRevision: input.current.answerRevision,
    questionSimilarity,
    answerSimilarity,
    approachSimilarity,
    quadrant,
    anomalyReasons,
    artifactMismatchReasons: artifactContractMismatchReasons,
    thresholdVersion: thresholds.version,
    modelVersion: input.modelVersion,
    embeddingDurationMs: input.embeddingDurationMs,
    disposition: "shadow",
    createdAt,
  };
}

export function createAdvisorHypothesisChallenge(input: {
  observation: AdvisorResponseConsistencyObservation;
  independentEvidence: AdvisorIndependentChallengeEvidence[];
  createdAt?: number;
}): AdvisorHypothesisChallenge {
  const independentEvidence = Array.from(
    new Set(input.independentEvidence)
  );
  const hasAnomaly = input.observation.anomalyReasons.length > 0;
  const challenged = hasAnomaly && independentEvidence.length > 0;
  const reason = challenged
    ? "response-anomaly-with-independent-evidence"
    : !hasAnomaly
      ? "no-response-anomaly"
      : "independent-evidence-missing";
  return {
    schemaVersion: 1,
    operationId: `advisor_hypothesis_challenge_${stableHash(
      input.observation.operationId
    )}`,
    fingerprintId: input.observation.currentFingerprintId,
    logicalQuestionUnitId:
      input.observation.logicalQuestionUnitId,
    logicalQuestionRevision:
      input.observation.logicalQuestionRevision,
    answerRevision: input.observation.answerRevision,
    challenged,
    reason,
    anomalyReasons: [...input.observation.anomalyReasons],
    independentEvidence,
    behaviorMutationBlocked: true,
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function collectAdvisorIndependentChallengeEvidence(input: {
  questionType: CanonicalQuestionType;
  traceMetadata?: Record<string, unknown>;
  answerSufficiencyDecision?: AnswerSufficiencyDecision;
  artifactMismatch: boolean;
  manualCorrectionApplied?: boolean;
  contextAction?: "narrow-context" | "enhance-context";
  manualRegenerate?: boolean;
}): AdvisorIndependentChallengeEvidence[] {
  const evidence: AdvisorIndependentChallengeEvidence[] = [];
  const metadata = input.traceMetadata ?? {};
  const keywordType = canonicalMetadataType(
    metadata.taxonomyKeywordType ??
      metadata.interviewerIntentKeywordQuestionType
  );
  const semanticType = canonicalMetadataType(
    metadata.taxonomySemanticCandidateType
  );
  const llmType = canonicalMetadataType(
    metadata.questionTypeAdjudicationCandidateType ??
      metadata.questionTypeAdjudicationEnforcementProposedType
  );
  if (isConcreteDisagreement(keywordType, input.questionType)) {
    evidence.push("keyword-type-disagreement");
  }
  if (isConcreteDisagreement(semanticType, input.questionType)) {
    evidence.push("semantic-type-disagreement");
  }
  if (isConcreteDisagreement(llmType, input.questionType)) {
    evidence.push("llm-type-disagreement");
  }
  if (
    input.answerSufficiencyDecision?.answerStatus ===
      "context-insufficient" &&
    input.answerSufficiencyDecision.resolvableByNearbyContext
  ) {
    evidence.push("answer-context-insufficient-resolvable");
  }
  if (input.artifactMismatch) {
    evidence.push("artifact-contract-mismatch");
  }
  if (input.manualCorrectionApplied) {
    evidence.push("manual-correction");
  }
  if (input.contextAction) {
    evidence.push("manual-context-action");
  }
  if (input.manualRegenerate) {
    evidence.push("manual-regenerate");
  }
  return Array.from(new Set(evidence));
}

export function cosineSimilarity(left: number[], right: number[]) {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return clampSimilarity(dot / Math.sqrt(leftNorm * rightNorm));
}

export function formatAdvisorResponseFingerprintForTrace(
  fingerprint: AdvisorResponseFingerprint
) {
  return {
    advisorResponseFingerprintSchemaVersion: fingerprint.schemaVersion,
    advisorResponseFingerprintId: fingerprint.fingerprintId,
    advisorResponseFingerprintSessionId: fingerprint.sessionId,
    advisorResponseFingerprintRuntimeEpoch: fingerprint.runtimeEpoch,
    advisorResponseFingerprintLogicalQuestionUnitId:
      fingerprint.logicalQuestionUnitId,
    advisorResponseFingerprintLogicalQuestionRevision:
      fingerprint.logicalQuestionRevision,
    advisorResponseFingerprintSettlementId: fingerprint.settlementId,
    advisorResponseFingerprintExecutionPlanId:
      fingerprint.executionPlanId,
    advisorResponseFingerprintAnswerRevision: fingerprint.answerRevision,
    advisorResponseFingerprintQuestionType: fingerprint.questionType,
    advisorResponseFingerprintRelation: fingerprint.relation,
    advisorResponseFingerprintParentTaskId: fingerprint.parentTaskId,
    advisorResponseFingerprintPlaybookPhase: fingerprint.playbookPhase,
    advisorResponseFingerprintQuestionHash: fingerprint.questionHash,
    advisorResponseFingerprintQuestionChars: fingerprint.questionChars,
    advisorResponseFingerprintAnswerHash: fingerprint.answerHash,
    advisorResponseFingerprintApproachHash: fingerprint.approachHash,
    advisorResponseFingerprintHasCode:
      fingerprint.artifactSignature.hasCode,
    advisorResponseFingerprintHasComplexity:
      fingerprint.artifactSignature.hasComplexity,
    advisorResponseFingerprintHasWhiteboard:
      fingerprint.artifactSignature.hasWhiteboard,
    advisorResponseFingerprintRequiredArtifactFamilies:
      fingerprint.artifactSignature.requiredFamilies,
    advisorResponseFingerprintMissingRequiredArtifactFamilies:
      fingerprint.artifactSignature.missingRequiredFamilies,
    advisorResponseFingerprintUnauthorizedMutationFamilies:
      fingerprint.artifactSignature.unauthorizedMutationFamilies,
    advisorResponseFingerprintContextInsufficientLike:
      fingerprint.answerProfile.contextInsufficientLike,
    advisorResponseFingerprintRefusalLike:
      fingerprint.answerProfile.refusalLike,
    advisorResponseFingerprintCommitDisposition:
      fingerprint.commitDisposition,
  };
}

export function formatAdvisorResponseConsistencyForTrace(
  observation: AdvisorResponseConsistencyObservation
) {
  return {
    advisorResponseConsistencyShadowVersion:
      ADVISOR_RESPONSE_CONSISTENCY_SHADOW_VERSION,
    advisorResponseConsistencyOperationId: observation.operationId,
    advisorResponseConsistencyCurrentFingerprintId:
      observation.currentFingerprintId,
    advisorResponseConsistencyPreviousFingerprintId:
      observation.previousFingerprintId,
    advisorResponseQuestionSimilarity: observation.questionSimilarity,
    advisorResponseAnswerSimilarity: observation.answerSimilarity,
    advisorResponseApproachSimilarity: observation.approachSimilarity,
    advisorResponseConsistencyQuadrant: observation.quadrant,
    advisorResponseConsistencyAnomalyReasons:
      observation.anomalyReasons,
    advisorResponseArtifactMismatchReasons:
      observation.artifactMismatchReasons,
    advisorResponseConsistencyThresholdVersion:
      observation.thresholdVersion,
    advisorResponseConsistencyModelVersion: observation.modelVersion,
    advisorResponseConsistencyEmbeddingDurationMs:
      observation.embeddingDurationMs,
    advisorResponseConsistencyDisposition: observation.disposition,
    advisorResponseBehaviorMutationBlocked: true,
  };
}

export function formatAdvisorHypothesisChallengeForTrace(
  challenge: AdvisorHypothesisChallenge
) {
  return {
    advisorHypothesisChallengeOperationId: challenge.operationId,
    advisorHypothesisChallenged: challenge.challenged,
    advisorHypothesisChallengeReason: challenge.reason,
    advisorHypothesisChallengeAnomalyReasons:
      challenge.anomalyReasons,
    advisorHypothesisChallengeIndependentEvidence:
      challenge.independentEvidence,
    advisorHypothesisChallengeBehaviorMutationBlocked:
      challenge.behaviorMutationBlocked,
  };
}

function artifactFamilies(
  artifacts: AnswerArtifactSection[]
): AdvisorArtifactFamily[] {
  const families = new Set<AdvisorArtifactFamily>();
  for (const artifact of artifacts) {
    if (artifact === "code" || artifact === "complexity") {
      families.add("code");
    } else if (artifact === "whiteboard") {
      families.add("whiteboard");
    }
  }
  return Array.from(families);
}

function collectArtifactMismatchReasons(
  signature: AdvisorResponseArtifactSignature
) {
  return [
    ...signature.missingRequiredFamilies.map(
      (family) => `missing-required-${family}`
    ),
    ...signature.unauthorizedMutationFamilies.map(
      (family) => `unauthorized-mutation-${family}`
    ),
  ];
}

function classifyConsistencyQuadrant(input: {
  questionSimilarity: number;
  answerSimilarity: number;
  thresholds: AdvisorResponseConsistencyThresholds;
}): AdvisorResponseConsistencyQuadrant {
  const questionHigh =
    input.questionSimilarity >= input.thresholds.highQuestionSimilarity;
  const questionLow =
    input.questionSimilarity <= input.thresholds.lowQuestionSimilarity;
  const answerHigh =
    input.answerSimilarity >= input.thresholds.highAnswerSimilarity;
  const answerLow =
    input.answerSimilarity <= input.thresholds.lowAnswerSimilarity;
  if (questionHigh && answerHigh) return "question-high-answer-high";
  if (questionHigh && answerLow) return "question-high-answer-low";
  if (questionLow && answerHigh) return "question-low-answer-high";
  if (questionLow && answerLow) return "question-low-answer-low";
  return "indeterminate";
}

function inferWhiteboardFormat(value: string) {
  if (!value) return undefined;
  if (/```\s*(?:mermaid|mmd)\b/iu.test(value)) return "mermaid" as const;
  if (/[┌┐└┘├┤┬┴┼│─]|(?:-->|<--|\+[-=]{2,}\+)/u.test(value)) {
    return "ascii" as const;
  }
  return "plain-text" as const;
}

function normalizeSemanticText(value: string) {
  return value.replace(/\s+/gu, " ").trim().slice(0, 8_000);
}

function canonicalMetadataType(value: unknown): CanonicalQuestionType | undefined {
  return typeof value === "string" && CANONICAL_QUESTION_TYPES.has(value)
    ? (value as CanonicalQuestionType)
    : undefined;
}

function isConcreteDisagreement(
  candidate: CanonicalQuestionType | undefined,
  current: CanonicalQuestionType
) {
  return Boolean(
    candidate && candidate !== "unknown" && candidate !== current
  );
}

function challengeLeaseKey(lease: AdvisorResponseFingerprintLease) {
  return [
    lease.sessionId,
    lease.runtimeEpoch,
    lease.logicalQuestionUnitId ?? "unbound",
    lease.logicalQuestionRevision ?? 0,
  ].join(":");
}

function cloneFingerprintRecord(
  record: AdvisorResponseFingerprintRecord
): AdvisorResponseFingerprintRecord {
  return {
    fingerprint: {
      ...record.fingerprint,
      artifactSignature: {
        ...record.fingerprint.artifactSignature,
        mutatedFamilies: [
          ...record.fingerprint.artifactSignature.mutatedFamilies,
        ],
        requiredFamilies: [
          ...record.fingerprint.artifactSignature.requiredFamilies,
        ],
        missingRequiredFamilies: [
          ...record.fingerprint.artifactSignature.missingRequiredFamilies,
        ],
        unauthorizedMutationFamilies: [
          ...record.fingerprint.artifactSignature
            .unauthorizedMutationFamilies,
        ],
      },
      answerProfile: { ...record.fingerprint.answerProfile },
    },
    semanticSource: { ...record.semanticSource },
  };
}

function clampSimilarity(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

const REFUSAL_PATTERN =
  /\b(?:cannot|can't|unable to|won't|do not have enough|not enough (?:information|context)|无法|不能|没有足够(?:信息|上下文))\b/iu;
const CONTEXT_INSUFFICIENT_PATTERN =
  /\b(?:need|require|waiting for|missing|lack(?:ing)?)\b.{0,50}\b(?:context|information|details|question|requirements?)\b|(?:需要|缺少|等待).{0,30}(?:上下文|信息|细节|问题|需求)/iu;
const CANONICAL_QUESTION_TYPES = new Set<string>([
  "unknown",
  "behavioral",
  "coding",
  "general-system-design",
  "ai-ml-system-design",
  "project-deep-dive",
  "field-knowledge",
]);
