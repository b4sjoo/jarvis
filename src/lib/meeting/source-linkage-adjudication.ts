import type { RuntimeInferenceRuntimeJob } from "./runtime-inference-runtime.js";
import { buildRuntimeInferenceModelInput } from "./runtime-inference.js";
import { parseRuntimeJsonObject } from "./runtime-json-object.js";
import {
  formatRuntimeInferenceValidationForTrace,
  getRuntimeInferenceValidationDefinition,
  validateCrossSourceTransitionLease,
  type CrossSourceTransitionLease,
  type RuntimeInferenceValidationFacet,
} from "./runtime-inference-validation.js";

export const SOURCE_LINKAGE_ADJUDICATION_SCHEMA_VERSION = 1;
export const SOURCE_LINKAGE_ADJUDICATION_PROMPT_VERSION =
  "source-linkage-adjudication-v3";
export const SOURCE_LINKAGE_MAX_OUTPUT_CHARS = 2_048;
export const SOURCE_LINKAGE_MAX_TEXT_CHARS = 1_200;

export type SourceLinkageDecision =
  | "bind-voice"
  | "use-screen"
  | "unclear";

export interface SourceLinkageAdjudicationRequest {
  schemaVersion: 1;
  promptVersion: string;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  screenObservationId: string;
  sourceHash: string;
  voiceSourceHash: string;
  sourceSettlementId?: string;
  screenEvidenceHash: string;
  voiceQuestion: string;
  screenQuestion: string;
  screenEvidenceSummary?: string;
  activeParentObjective?: string;
}

export interface SourceLinkageSemanticPayload {
  voiceQuestion: string;
  screenQuestion: string;
  screenEvidenceSummary?: string;
}

export interface LlmSourceLinkageAdjudication {
  schemaVersion: 1;
  decision: SourceLinkageDecision;
  voiceEvidenceSpans: string[];
  screenEvidenceSpans: string[];
  ambiguityReason?: string;
}

export type SourceLinkageAdjudicationParseResult =
  | {
      ok: true;
      value: LlmSourceLinkageAdjudication;
      evidenceSpansValid: true;
    }
  | {
      ok: false;
      reason: string;
      errorKind: "parse" | "schema" | "evidence" | "provider";
      evidenceSpansValid: false;
    };

export interface SourceLinkageAdjudicationLease
  extends CrossSourceTransitionLease {
  operationId: string;
  requestSourceHash: string;
  createdAt: number;
}

export interface SourceLinkageAdjudicationJob
  extends RuntimeInferenceRuntimeJob {
  traceId: string;
  lease: SourceLinkageAdjudicationLease;
  request: SourceLinkageAdjudicationRequest;
}

export function buildSourceLinkageAdjudicationRequest(input: {
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  screenObservationId: string;
  voiceSourceHash: string;
  sourceSettlementId?: string;
  voiceQuestion: string;
  screenQuestion: string;
  screenEvidenceSummary?: string;
  activeParentObjective?: string;
}): SourceLinkageAdjudicationRequest | undefined {
  const voiceQuestion = boundText(input.voiceQuestion);
  const screenQuestion = boundText(input.screenQuestion);
  const voiceSourceHash = input.voiceSourceHash.trim();
  if (
    !voiceQuestion ||
    !screenQuestion ||
    !input.screenObservationId.trim() ||
    !voiceSourceHash
  ) {
    return undefined;
  }
  const screenEvidenceSummary = boundText(input.screenEvidenceSummary ?? "");
  const activeParentObjective = boundText(input.activeParentObjective ?? "");
  const screenObservationId = input.screenObservationId.trim();
  const screenEvidenceHash = hashValues([
    screenObservationId,
    screenQuestion,
    screenEvidenceSummary,
  ]);
  return {
    schemaVersion: SOURCE_LINKAGE_ADJUDICATION_SCHEMA_VERSION,
    promptVersion: SOURCE_LINKAGE_ADJUDICATION_PROMPT_VERSION,
    logicalQuestionUnitId: input.logicalQuestionUnitId,
    logicalQuestionUnitRevision: input.logicalQuestionUnitRevision,
    screenObservationId,
    sourceHash: hashValues([
      voiceQuestion,
      screenQuestion,
      screenEvidenceSummary,
      activeParentObjective,
    ]),
    voiceSourceHash,
    sourceSettlementId: input.sourceSettlementId?.trim() || undefined,
    screenEvidenceHash,
    voiceQuestion,
    screenQuestion,
    screenEvidenceSummary: screenEvidenceSummary || undefined,
    activeParentObjective: activeParentObjective || undefined,
  };
}

export function buildSourceLinkageAdjudicationPrompts(
  request: SourceLinkageAdjudicationRequest
) {
  const semanticPayload: SourceLinkageSemanticPayload = {
    voiceQuestion: request.voiceQuestion,
    screenQuestion: request.screenQuestion,
    ...(request.screenEvidenceSummary
      ? { screenEvidenceSummary: request.screenEvidenceSummary }
      : {}),
  };
  const systemPrompt = [
      "Decide one thing only: whether the deliberate screen capture reasonably points to the object referenced by the unresolved voice question and warrants an image-evidence recovery attempt, or positively indicates an unrelated object or different current request.",
      "Return one JSON object only. Do not answer either question.",
      "Output only the declared schema fields; do not echo input fields or add instructions for downstream operations.",
      "Use bind-voice when voice and screen evidence reasonably connect the focused object to the pending request, so the Advisor can attempt recovery using the image.",
      "A cursor or selection pointing inside part of the requested region is affirmative relevance evidence, even when the summary contains only one line or a method signature. Complete method-body or requested-range coverage is not required.",
      "Binding authorizes an attempt, not proof that all requested evidence is visible or that the question is resolved. The Advisor must limit claims to visible evidence and acknowledge unseen or uncertain portions.",
      "Use use-screen only with positive evidence of an unrelated object or a different current request, including an explicitly incompatible task even if line numbers or question types coincide.",
      "A standing problem title, its independent answerability, different wording, or an incomplete summary alone cannot justify use-screen. Compare the focused evidence with the voice request, not just the question titles.",
      "Use unclear when bounded evidence cannot establish reasonable relevance or positive unrelatedness. Partial visibility without enough identifying evidence is uncertainty, not rejection; partial visibility with a relevant focus can still support bind-voice.",
      "Time proximity, topic overlap, compatible question types, and the active parent alone are not linkage evidence.",
      "Every evidence span must be an exact verbatim substring from the matching input field.",
      "Do not classify question type, task relation, parent action, playbook phase, memory, or artifact intent.",
      "Schema: {schemaVersion:1,decision:'bind-voice'|'use-screen'|'unclear',voiceEvidenceSpans:string[],screenEvidenceSpans:string[],ambiguityReason?:string}.",
    ].join(" ");
  return buildRuntimeInferenceModelInput({
    systemPrompt,
    semanticPayload,
  });
}

export function parseSourceLinkageAdjudicationOutput(
  rawOutput: string,
  request: SourceLinkageAdjudicationRequest
): SourceLinkageAdjudicationParseResult {
  const parsed = parseRuntimeJsonObject(rawOutput, {
    maxChars: SOURCE_LINKAGE_MAX_OUTPUT_CHARS,
  });
  if (!parsed.ok) return parseFailure(parsed.reason, parsed.errorKind);
  const decoded = parsed.value;
  // Only validated contract fields enter the returned candidate; extras remain raw.
  if (decoded.schemaVersion !== SOURCE_LINKAGE_ADJUDICATION_SCHEMA_VERSION) {
    return parseFailure("unsupported-schema-version", "schema");
  }
  if (
    decoded.decision !== "bind-voice" &&
    decoded.decision !== "use-screen" &&
    decoded.decision !== "unclear"
  ) {
    return parseFailure("invalid-decision", "schema");
  }
  if (
    !isEvidenceSpanArray(decoded.voiceEvidenceSpans) ||
    !isEvidenceSpanArray(decoded.screenEvidenceSpans)
  ) {
    return parseFailure("invalid-evidence-spans", "schema");
  }
  if (
    decoded.ambiguityReason !== undefined &&
    typeof decoded.ambiguityReason !== "string"
  ) {
    return parseFailure("invalid-ambiguity-reason", "schema");
  }
  const voiceEvidenceSpans = decoded.voiceEvidenceSpans.map((span) =>
    span.trim()
  );
  const screenEvidenceSpans = decoded.screenEvidenceSpans.map((span) =>
    span.trim()
  );
  const screenCorpus = [request.screenQuestion, request.screenEvidenceSummary]
    .filter(Boolean)
    .join("\n");
  if (
    !allSpansGrounded(voiceEvidenceSpans, request.voiceQuestion) ||
    !allSpansGrounded(screenEvidenceSpans, screenCorpus)
  ) {
    return parseFailure("ungrounded-evidence-span", "evidence");
  }
  if (
    decoded.decision === "bind-voice" &&
    (voiceEvidenceSpans.length === 0 || screenEvidenceSpans.length === 0)
  ) {
    return parseFailure("bind-voice-requires-bilateral-evidence", "evidence");
  }
  if (
    decoded.decision === "use-screen" &&
    screenEvidenceSpans.length === 0
  ) {
    return parseFailure("use-screen-requires-screen-evidence", "evidence");
  }
  return {
    ok: true,
    evidenceSpansValid: true,
    value: {
      schemaVersion: SOURCE_LINKAGE_ADJUDICATION_SCHEMA_VERSION,
      decision: decoded.decision,
      voiceEvidenceSpans,
      screenEvidenceSpans,
      ambiguityReason:
        typeof decoded.ambiguityReason === "string"
          ? decoded.ambiguityReason.trim()
          : undefined,
    },
  };
}

export function createSourceLinkageAdjudicationLease(input: {
  sessionId: string;
  runtimeEpoch: number;
  request: SourceLinkageAdjudicationRequest;
  manualCorrectionRevision: number;
  createdAt?: number;
}): SourceLinkageAdjudicationLease {
  const transition: CrossSourceTransitionLease = {
    operationKind: "source-linkage-adjudication",
    sessionId: input.sessionId,
    runtimeEpoch: input.runtimeEpoch,
    operationRevision: input.request.logicalQuestionUnitRevision,
    from: {
      logicalQuestionUnitId: input.request.logicalQuestionUnitId,
      logicalQuestionRevision:
        input.request.logicalQuestionUnitRevision,
      sourceHash: input.request.voiceSourceHash,
      correctionRevision: input.manualCorrectionRevision,
    },
    to: {
      evidenceId: input.request.screenObservationId,
      evidenceHash: input.request.screenEvidenceHash,
      correctionRevision: input.manualCorrectionRevision,
    },
    sourceSettlementId: input.request.sourceSettlementId,
  };
  return {
    operationId: [
      "source_linkage",
      input.sessionId,
      input.runtimeEpoch,
      transition.from.logicalQuestionUnitId,
      transition.from.logicalQuestionRevision,
      transition.from.sourceHash,
      transition.to.evidenceId,
      transition.to.evidenceHash,
      input.manualCorrectionRevision,
    ].join(":"),
    ...transition,
    requestSourceHash: input.request.sourceHash,
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function authorizeSourceLinkageAdjudicationLease(
  lease: SourceLinkageAdjudicationLease,
  current: {
    currentOperationId?: string;
    transition: CrossSourceTransitionLease;
  }
):
  | { authorized: true; mismatchedFacets: [] }
  | {
      authorized: false;
      reason: string;
      mismatchedFacets: RuntimeInferenceValidationFacet[];
    } {
  const reject = (
    reason: string,
    mismatchedFacets: RuntimeInferenceValidationFacet[] = []
  ) => ({
    authorized: false as const,
    reason,
    mismatchedFacets,
  });
  if (lease.operationId !== current.currentOperationId) {
    return reject("operation-id-mismatch");
  }
  const validation = validateCrossSourceTransitionLease({
    lease,
    current: current.transition,
  });
  return validation.authorized
    ? { authorized: true, mismatchedFacets: [] }
    : reject("cross-source-transition-mismatch", validation.mismatchedFacets);
}

export function formatSourceLinkageAdjudicationForTrace(input: {
  request: SourceLinkageAdjudicationRequest;
  disposition: string;
  candidate?: LlmSourceLinkageAdjudication;
  leaseAuthorized?: boolean;
  staleReason?: string;
  validationMismatchedFacets?: RuntimeInferenceValidationFacet[];
  mode?: "shadow" | "enforcement";
  appliedToRuntime?: boolean;
  durationMs?: number;
  queueWaitMs?: number;
}) {
  return {
    sourceLinkagePromptVersion: input.request.promptVersion,
    sourceLinkageSchemaVersion: input.request.schemaVersion,
    sourceLinkageLogicalQuestionUnitId:
      input.request.logicalQuestionUnitId,
    sourceLinkageLogicalQuestionRevision:
      input.request.logicalQuestionUnitRevision,
    sourceLinkageScreenObservationId: input.request.screenObservationId,
    sourceLinkageSourceHash: input.request.sourceHash,
    sourceLinkageVoiceSourceHash: input.request.voiceSourceHash,
    sourceLinkageScreenEvidenceHash: input.request.screenEvidenceHash,
    sourceLinkageSourceSettlementId: input.request.sourceSettlementId,
    sourceLinkageDisposition: input.disposition,
    sourceLinkageDecision: input.candidate?.decision,
    sourceLinkageVoiceEvidenceSpans:
      input.candidate?.voiceEvidenceSpans,
    sourceLinkageScreenEvidenceSpans:
      input.candidate?.screenEvidenceSpans,
    sourceLinkageAmbiguityReason: input.candidate?.ambiguityReason,
    sourceLinkageLeaseAuthorized: input.leaseAuthorized,
    sourceLinkageStaleReason: input.staleReason,
    sourceLinkageValidationMismatchedFacets:
      input.validationMismatchedFacets ?? [],
    sourceLinkageDurationMs: input.durationMs,
    sourceLinkageQueueWaitMs: input.queueWaitMs,
    sourceLinkageAppliedToRuntime: input.appliedToRuntime ?? false,
    sourceLinkageMode: input.mode ?? "shadow",
    ...formatRuntimeInferenceValidationForTrace({
      definition: getRuntimeInferenceValidationDefinition(
        "source-linkage-adjudication"
      ),
      result:
        input.leaseAuthorized === undefined
          ? undefined
          : {
              authorized: input.leaseAuthorized,
              reason: input.leaseAuthorized
                ? "authorized"
                : "identity-mismatch",
              mismatchedFacets: input.validationMismatchedFacets ?? [],
            },
    }),
  };
}

function parseFailure(
  reason: string,
  errorKind: "parse" | "schema" | "evidence" | "provider"
): SourceLinkageAdjudicationParseResult {
  return { ok: false, reason, errorKind, evidenceSpansValid: false };
}

function isEvidenceSpanArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 8 &&
    value.every((span) => typeof span === "string" && Boolean(span.trim()))
  );
}

function allSpansGrounded(spans: string[], corpus: string) {
  return spans.every((span) => corpus.includes(span));
}

function boundText(value: string) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.slice(0, SOURCE_LINKAGE_MAX_TEXT_CHARS);
}

function hashValues(values: Array<string | undefined>) {
  let hash = 2_166_136_261;
  for (const character of values.filter(Boolean).join("\u001f")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
