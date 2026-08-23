import type { RuntimeInferenceRuntimeJob } from "./runtime-inference-runtime.js";

export const SOURCE_LINKAGE_ADJUDICATION_SCHEMA_VERSION = 1;
export const SOURCE_LINKAGE_ADJUDICATION_PROMPT_VERSION =
  "source-linkage-adjudication-v1";
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
  voiceQuestion: string;
  screenQuestion: string;
  screenEvidenceSummary?: string;
  activeParentObjective?: string;
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

export interface SourceLinkageAdjudicationLease {
  operationId: string;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  screenObservationId: string;
  sourceHash: string;
  manualCorrectionRevision: number;
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
  voiceQuestion: string;
  screenQuestion: string;
  screenEvidenceSummary?: string;
  activeParentObjective?: string;
}): SourceLinkageAdjudicationRequest | undefined {
  const voiceQuestion = boundText(input.voiceQuestion);
  const screenQuestion = boundText(input.screenQuestion);
  if (!voiceQuestion || !screenQuestion || !input.screenObservationId.trim()) {
    return undefined;
  }
  const screenEvidenceSummary = boundText(input.screenEvidenceSummary ?? "");
  const activeParentObjective = boundText(input.activeParentObjective ?? "");
  return {
    schemaVersion: SOURCE_LINKAGE_ADJUDICATION_SCHEMA_VERSION,
    promptVersion: SOURCE_LINKAGE_ADJUDICATION_PROMPT_VERSION,
    logicalQuestionUnitId: input.logicalQuestionUnitId,
    logicalQuestionUnitRevision: input.logicalQuestionUnitRevision,
    screenObservationId: input.screenObservationId.trim(),
    sourceHash: hashValues([
      voiceQuestion,
      screenQuestion,
      screenEvidenceSummary,
      activeParentObjective,
    ]),
    voiceQuestion,
    screenQuestion,
    screenEvidenceSummary: screenEvidenceSummary || undefined,
    activeParentObjective: activeParentObjective || undefined,
  };
}

export function buildSourceLinkageAdjudicationPrompts(
  request: SourceLinkageAdjudicationRequest
) {
  return {
    systemPrompt: [
      "Decide one thing only: whether the deliberate screen capture primarily supplies evidence requested by the unresolved voice question or presents an independent current screen question.",
      "Return one JSON object only. Do not answer either question.",
      "Use bind-voice only when both voice and screen evidence show that the screen directly supplies what the voice question requested.",
      "Use use-screen when the screen presents an independently answerable current task or the evidence does not connect it to the voice request.",
      "Use unclear when bounded evidence cannot support either conclusion.",
      "Time proximity, topic overlap, compatible question types, and the active parent alone are not linkage evidence.",
      "Every evidence span must be an exact verbatim substring from the matching input field.",
      "Do not classify question type, task relation, parent action, playbook phase, memory, or artifact intent.",
      "Schema: {schemaVersion:1,decision:'bind-voice'|'use-screen'|'unclear',voiceEvidenceSpans:string[],screenEvidenceSpans:string[],ambiguityReason?:string}.",
    ].join(" "),
    userMessage: JSON.stringify(request),
  };
}

export function parseSourceLinkageAdjudicationOutput(
  rawOutput: string,
  request: SourceLinkageAdjudicationRequest
): SourceLinkageAdjudicationParseResult {
  const trimmed = stripJsonFence(rawOutput.trim());
  if (!trimmed) return parseFailure("empty-output", "parse");
  if (trimmed.length > SOURCE_LINKAGE_MAX_OUTPUT_CHARS) {
    return parseFailure("output-too-large", "parse");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(trimmed);
  } catch {
    return parseFailure("invalid-json", "parse");
  }
  if (!isRecord(decoded)) {
    return parseFailure("output-is-not-object", "schema");
  }
  const allowedKeys = new Set([
    "schemaVersion",
    "decision",
    "voiceEvidenceSpans",
    "screenEvidenceSpans",
    "ambiguityReason",
  ]);
  if (Object.keys(decoded).some((key) => !allowedKeys.has(key))) {
    return parseFailure("unexpected-field", "schema");
  }
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
  return {
    operationId: [
      "source_linkage",
      input.sessionId,
      input.runtimeEpoch,
      input.request.logicalQuestionUnitId,
      input.request.logicalQuestionUnitRevision,
      input.request.screenObservationId,
      input.request.sourceHash,
      input.manualCorrectionRevision,
    ].join(":"),
    sessionId: input.sessionId,
    runtimeEpoch: input.runtimeEpoch,
    logicalQuestionUnitId: input.request.logicalQuestionUnitId,
    logicalQuestionUnitRevision: input.request.logicalQuestionUnitRevision,
    screenObservationId: input.request.screenObservationId,
    sourceHash: input.request.sourceHash,
    manualCorrectionRevision: input.manualCorrectionRevision,
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function authorizeSourceLinkageAdjudicationLease(
  lease: SourceLinkageAdjudicationLease,
  current: {
    currentOperationId?: string;
    sessionId: string;
    runtimeEpoch: number;
    logicalQuestionUnitId: string;
    logicalQuestionUnitRevision: number;
    screenObservationId: string;
    sourceHash: string;
    manualCorrectionRevision: number;
  }
): { authorized: true } | { authorized: false; reason: string } {
  const reject = (reason: string) => ({ authorized: false as const, reason });
  if (lease.operationId !== current.currentOperationId) {
    return reject("operation-id-mismatch");
  }
  if (lease.sessionId !== current.sessionId) return reject("session-mismatch");
  if (lease.runtimeEpoch !== current.runtimeEpoch) {
    return reject("runtime-epoch-mismatch");
  }
  if (lease.logicalQuestionUnitId !== current.logicalQuestionUnitId) {
    return reject("logical-question-mismatch");
  }
  if (
    lease.logicalQuestionUnitRevision !== current.logicalQuestionUnitRevision
  ) {
    return reject("logical-question-revision-mismatch");
  }
  if (lease.screenObservationId !== current.screenObservationId) {
    return reject("screen-observation-mismatch");
  }
  if (lease.sourceHash !== current.sourceHash) return reject("source-mismatch");
  if (lease.manualCorrectionRevision !== current.manualCorrectionRevision) {
    return reject("manual-correction-revision-mismatch");
  }
  return { authorized: true };
}

export function formatSourceLinkageAdjudicationForTrace(input: {
  request: SourceLinkageAdjudicationRequest;
  disposition: string;
  candidate?: LlmSourceLinkageAdjudication;
  leaseAuthorized?: boolean;
  staleReason?: string;
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
    sourceLinkageDisposition: input.disposition,
    sourceLinkageDecision: input.candidate?.decision,
    sourceLinkageVoiceEvidenceSpans:
      input.candidate?.voiceEvidenceSpans,
    sourceLinkageScreenEvidenceSpans:
      input.candidate?.screenEvidenceSpans,
    sourceLinkageAmbiguityReason: input.candidate?.ambiguityReason,
    sourceLinkageLeaseAuthorized: input.leaseAuthorized,
    sourceLinkageStaleReason: input.staleReason,
    sourceLinkageDurationMs: input.durationMs,
    sourceLinkageQueueWaitMs: input.queueWaitMs,
    sourceLinkageAppliedToRuntime: false,
    sourceLinkageMode: "shadow",
  };
}

function parseFailure(
  reason: string,
  errorKind: "parse" | "schema" | "evidence" | "provider"
): SourceLinkageAdjudicationParseResult {
  return { ok: false, reason, errorKind, evidenceSpansValid: false };
}

function stripJsonFence(value: string) {
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
