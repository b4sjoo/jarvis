import type { RuntimeInferenceRuntimeJob } from "./runtime-inference-runtime.js";
import { buildRuntimeInferenceModelInput } from "./runtime-inference.js";
import { parseRuntimeJsonObject } from "./runtime-json-object.js";
import {
  getInterviewCompanyEvidenceAliases,
  normalizeInterviewBriefCompany,
} from "./interview-company.js";
import type {
  MeetingMetadataInferenceMode,
  InterviewTargetCompany,
  TranscriptTurn,
} from "./types.js";

export const MEETING_METADATA_INFERENCE_SCHEMA_VERSION = 1;
export const MEETING_METADATA_INFERENCE_PROMPT_VERSION =
  "meeting-metadata-inference-v1";
export const MEETING_METADATA_INFERENCE_MAX_OUTPUT_CHARS = 2_048;
export const MEETING_METADATA_MAX_OPENING_TURNS = 6;
export const MEETING_METADATA_MAX_TURN_CHARS = 600;
export const MEETING_METADATA_MAX_EVIDENCE_CHARS = 1_800;
export const MEETING_METADATA_OPENING_WINDOW_MS = 10 * 60 * 1_000;
export const MEETING_METADATA_INFERENCE_COMMIT_MIN_CONFIDENCE = 0.92;

export interface MeetingMetadataEvidenceTurn {
  id: string;
  text: string;
  startedAt: number;
  endedAt: number;
}

export interface MeetingMetadataAuthoritativeCompany {
  value: string;
  normalized: string;
  source: InterviewTargetCompany["source"];
}

export interface MeetingMetadataOpeningEvidence {
  turns: MeetingMetadataEvidenceTurn[];
  sourceHash: string;
  revision: number;
  totalChars: number;
  omittedTurnCount: number;
}

export interface MeetingMetadataInferenceRequest {
  schemaVersion: 1;
  promptVersion: string;
  sessionId: string;
  operationRevision: number;
  openingEvidence: MeetingMetadataOpeningEvidence;
  authoritativeCompany?: MeetingMetadataAuthoritativeCompany;
}

export interface MeetingMetadataInferenceLease {
  operationId: string;
  sessionId: string;
  runtimeEpoch: number;
  operationRevision: number;
  openingEvidenceTurns: MeetingMetadataEvidenceTurn[];
  authoritativeCompany?: MeetingMetadataAuthoritativeCompany;
  mode: MeetingMetadataInferenceMode;
  createdAt: number;
}

export interface MeetingMetadataInferenceJob
  extends RuntimeInferenceRuntimeJob {
  traceId: string;
  lease: MeetingMetadataInferenceLease;
  request: MeetingMetadataInferenceRequest;
}

export interface LlmMeetingMetadataInference {
  schemaVersion: 1;
  company: string | null;
  confidence: number;
  evidenceSpans: string[];
  abstainReason?: string;
}

export type MeetingMetadataInferenceParseResult =
  | {
      ok: true;
      value: LlmMeetingMetadataInference;
      evidenceSpansValid: true;
    }
  | {
      ok: false;
      reason: string;
      errorKind: "parse" | "schema" | "evidence" | "provider";
      evidenceSpansValid: boolean;
    };

export interface MeetingMetadataInferenceEligibilityDecision {
  eligible: boolean;
  reason: string;
}

export type MeetingMetadataInferenceComparisonDisposition =
  | "agreement"
  | "conflict"
  | "unresolved-proposal"
  | "abstained";

export interface MeetingMetadataInferenceComparison {
  disposition: MeetingMetadataInferenceComparisonDisposition;
  authoritativeCompany?: string;
  proposedCompany?: string;
}

export type MeetingMetadataInferenceCommitDecision =
  | {
      authorized: true;
      reason: "grounded-unresolved-company";
      targetCompany: Omit<InterviewTargetCompany, "source" | "updatedAt">;
    }
  | {
      authorized: false;
      reason:
        | "mode-not-enforcement"
        | "lease-not-authorized"
        | "company-already-resolved"
        | "proposal-invalid"
        | "proposal-abstained"
        | "confidence-below-threshold"
        | "proposal-company-invalid";
    };

export function projectMeetingMetadataOpeningEvidence(input: {
  transcriptTurns: TranscriptTurn[];
  sessionStartedAt: number;
}): MeetingMetadataOpeningEvidence {
  const eligible = input.transcriptTurns.filter(
    (turn) =>
      turn.speaker === "them" &&
      turn.text.trim().length > 0 &&
      turn.startedAt <=
        input.sessionStartedAt + MEETING_METADATA_OPENING_WINDOW_MS
  );
  const selected = eligible.slice(0, MEETING_METADATA_MAX_OPENING_TURNS);
  let remainingChars = MEETING_METADATA_MAX_EVIDENCE_CHARS;
  const turns: MeetingMetadataEvidenceTurn[] = [];

  for (const turn of selected) {
    if (remainingChars <= 0) break;
    const text = turn.text
      .trim()
      .slice(
        0,
        Math.min(MEETING_METADATA_MAX_TURN_CHARS, remainingChars)
      );
    if (!text) continue;
    turns.push({
      id: turn.id,
      text,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
    });
    remainingChars -= text.length;
  }

  const sourceHash = hashMeetingMetadataValues(
    turns.flatMap((turn) => [
      turn.id,
      turn.text,
      String(turn.startedAt),
      String(turn.endedAt),
    ])
  );
  return {
    turns,
    sourceHash,
    revision: turns.length,
    totalChars: turns.reduce((total, turn) => total + turn.text.length, 0),
    omittedTurnCount: Math.max(0, eligible.length - turns.length),
  };
}

export function decideMeetingMetadataInferenceEligibility(input: {
  currentTurnId: string;
  evidence: MeetingMetadataOpeningEvidence;
}): MeetingMetadataInferenceEligibilityDecision {
  if (!input.evidence.turns.length) {
    return { eligible: false, reason: "no-interviewer-opening-evidence" };
  }
  if (
    !input.evidence.turns.some((turn) => turn.id === input.currentTurnId)
  ) {
    return { eligible: false, reason: "outside-bounded-opening-window" };
  }
  if (input.evidence.totalChars < 12) {
    return { eligible: false, reason: "opening-evidence-too-short" };
  }
  return { eligible: true, reason: "bounded-opening-evidence" };
}

export function buildMeetingMetadataInferenceRequest(input: {
  sessionId: string;
  evidence: MeetingMetadataOpeningEvidence;
  authoritativeCompany?: InterviewTargetCompany;
}): MeetingMetadataInferenceRequest {
  return {
    schemaVersion: MEETING_METADATA_INFERENCE_SCHEMA_VERSION,
    promptVersion: MEETING_METADATA_INFERENCE_PROMPT_VERSION,
    sessionId: input.sessionId,
    operationRevision: input.evidence.revision,
    openingEvidence: {
      ...input.evidence,
      turns: input.evidence.turns.map((turn) => ({ ...turn })),
    },
    authoritativeCompany: input.authoritativeCompany
      ? {
          value: input.authoritativeCompany.value,
          normalized: input.authoritativeCompany.normalized,
          source: input.authoritativeCompany.source,
        }
      : undefined,
  };
}

export function buildMeetingMetadataInferencePrompts(
  request: MeetingMetadataInferenceRequest
) {
  const semanticPayload = {
    openingEvidence: request.openingEvidence.turns.map((turn, index) => ({
      index,
      text: turn.text,
    })),
    ...(request.authoritativeCompany
      ? { authoritativeCompany: { value: request.authoritativeCompany.value } }
      : {}),
  };
  const systemPrompt = [
      "Infer one meeting metadata field: which organization, if any, is conducting this interview.",
      "Return one JSON object only. Do not answer interview questions and do not classify question type, task relation, response intent, phase, artifacts, or candidate facts.",
      "Use only openingEvidence. Treat each indexed item as interviewer speech.",
      "A candidate's former employer, customer, vendor, product, cloud service, comparison target, city, country, region, or interview topic is not the target company unless the evidence explicitly identifies the interviewer or hiring process with that organization.",
      "HackerRank, LeetCode, CodeSignal, and similar coding or interview platforms are tools, not the hiring company, unless the evidence explicitly says the interview is for that platform company.",
      "If the organization is ambiguous or unsupported, return company:null and explain the abstention briefly.",
      "authoritativeCompany is read-only comparison context. Never replace or reinterpret it.",
      "Every evidenceSpans item must be an exact verbatim substring from openingEvidence text.",
      "Schema: {schemaVersion:1,company:string|null,confidence:number,evidenceSpans:string[],abstainReason:string|null}.",
    ].join(" ");
  return buildRuntimeInferenceModelInput({ systemPrompt, semanticPayload });
}

export function parseMeetingMetadataInferenceOutput(
  rawOutput: string,
  request: MeetingMetadataInferenceRequest
): MeetingMetadataInferenceParseResult {
  const parsed = parseRuntimeJsonObject(rawOutput, {
    maxChars: MEETING_METADATA_INFERENCE_MAX_OUTPUT_CHARS,
  });
  if (!parsed.ok) return parseFailure(parsed.reason, parsed.errorKind);
  const candidate = parsed.value;
  const allowedKeys = new Set([
    "schemaVersion",
    "company",
    "confidence",
    "evidenceSpans",
    "abstainReason",
  ]);
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) {
    return parseFailure("non-metadata-field-present", "schema");
  }
  if (candidate.schemaVersion !== MEETING_METADATA_INFERENCE_SCHEMA_VERSION) {
    return parseFailure("unsupported-schema-version", "schema");
  }
  if (
    candidate.company !== null &&
    (typeof candidate.company !== "string" ||
      !candidate.company.trim() ||
      candidate.company.trim().length > 100 ||
      /[\r\n]/.test(candidate.company))
  ) {
    return parseFailure("invalid-company", "schema");
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
    candidate.evidenceSpans.length > 4 ||
    candidate.evidenceSpans.some(
      (span) => typeof span !== "string" || !span.trim()
    )
  ) {
    return parseFailure("invalid-evidence-spans", "schema");
  }
  if (
    candidate.abstainReason !== null &&
    candidate.abstainReason !== undefined &&
    (typeof candidate.abstainReason !== "string" ||
      !candidate.abstainReason.trim() ||
      candidate.abstainReason.length > 240)
  ) {
    return parseFailure("invalid-abstain-reason", "schema");
  }

  const company =
    typeof candidate.company === "string"
      ? candidate.company.trim()
      : null;
  const evidenceSpans = (candidate.evidenceSpans as string[]).map((span) =>
    span.trim()
  );
  if (company && evidenceSpans.length === 0) {
    return parseFailure("company-requires-evidence", "evidence");
  }
  if (!company && typeof candidate.abstainReason !== "string") {
    return parseFailure("abstention-requires-reason", "schema");
  }

  const allowedEvidence = request.openingEvidence.turns.map(
    (turn) => turn.text
  );
  const evidenceSpansValid = evidenceSpans.every((span) =>
    allowedEvidence.some((text) => text.includes(span))
  );
  if (!evidenceSpansValid) {
    return parseFailure("invalid-evidence-span", "evidence");
  }
  if (
    company &&
    !evidenceSpans.some((span) =>
      evidenceSpanSupportsCompany(span, company)
    )
  ) {
    return parseFailure("company-not-grounded-in-evidence", "evidence");
  }

  return {
    ok: true,
    evidenceSpansValid: true,
    value: {
      schemaVersion: MEETING_METADATA_INFERENCE_SCHEMA_VERSION,
      company,
      confidence: candidate.confidence as number,
      evidenceSpans,
      abstainReason:
        typeof candidate.abstainReason === "string"
          ? candidate.abstainReason.trim()
          : undefined,
    },
  };
}

export function createMeetingMetadataInferenceLease(input: {
  sessionId: string;
  runtimeEpoch: number;
  mode: MeetingMetadataInferenceMode;
  request: MeetingMetadataInferenceRequest;
  createdAt?: number;
}): MeetingMetadataInferenceLease {
  const authoritativeCompanyHash = hashAuthoritativeCompany(
    input.request.authoritativeCompany
  );
  return {
    operationId: [
      "meeting_metadata",
      input.sessionId,
      input.runtimeEpoch,
      input.request.operationRevision,
      input.request.openingEvidence.sourceHash,
      authoritativeCompanyHash,
      input.mode,
    ].join(":"),
    sessionId: input.sessionId,
    runtimeEpoch: input.runtimeEpoch,
    operationRevision: input.request.operationRevision,
    openingEvidenceTurns: input.request.openingEvidence.turns.map((turn) => ({
      id: turn.id,
      text: turn.text,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
    })),
    authoritativeCompany: input.request.authoritativeCompany
      ? {
          value: input.request.authoritativeCompany.value,
          normalized: input.request.authoritativeCompany.normalized,
          source: input.request.authoritativeCompany.source,
        }
      : undefined,
    mode: input.mode,
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function authorizeMeetingMetadataInferenceLease(
  lease: MeetingMetadataInferenceLease,
  current: {
    currentOperationId?: string;
    sessionId: string;
    runtimeEpoch: number;
    evidence: MeetingMetadataOpeningEvidence;
    authoritativeCompany?: InterviewTargetCompany;
    mode: MeetingMetadataInferenceMode;
  }
): { authorized: true } | { authorized: false; reason: string } {
  const reject = (reason: string) => ({
    authorized: false as const,
    reason,
  });
  if (lease.operationId !== current.currentOperationId) {
    return reject("operation-id-mismatch");
  }
  if (lease.sessionId !== current.sessionId) {
    return reject("session-id-mismatch");
  }
  if (lease.runtimeEpoch !== current.runtimeEpoch) {
    return reject("runtime-epoch-mismatch");
  }
  if (lease.operationRevision !== current.evidence.revision) {
    return reject("operation-revision-mismatch");
  }
  if (
    lease.openingEvidenceTurns.length !== current.evidence.turns.length ||
    lease.openingEvidenceTurns.some((turn, index) => {
      const latest = current.evidence.turns[index];
      return (
        turn.id !== latest.id ||
        turn.text !== latest.text ||
        turn.startedAt !== latest.startedAt ||
        turn.endedAt !== latest.endedAt
      );
    })
  ) {
    return reject("source-hash-mismatch");
  }
  if (
    (lease.authoritativeCompany === undefined) !==
      (current.authoritativeCompany === undefined) ||
    (lease.authoritativeCompany !== undefined &&
      current.authoritativeCompany !== undefined &&
      (lease.authoritativeCompany.value !== current.authoritativeCompany.value ||
        lease.authoritativeCompany.normalized !==
          current.authoritativeCompany.normalized ||
        lease.authoritativeCompany.source !== current.authoritativeCompany.source))
  ) {
    return reject("authoritative-company-changed");
  }
  if (lease.mode !== current.mode) {
    return reject("inference-mode-changed");
  }
  return { authorized: true };
}

export function compareMeetingMetadataInference(input: {
  authoritativeCompany?: InterviewTargetCompany;
  proposal?: LlmMeetingMetadataInference;
}): MeetingMetadataInferenceComparison {
  const proposedCompany = input.proposal?.company?.trim() || undefined;
  if (!proposedCompany) {
    return {
      disposition: "abstained",
      authoritativeCompany: input.authoritativeCompany?.value,
    };
  }
  if (!input.authoritativeCompany) {
    return {
      disposition: "unresolved-proposal",
      proposedCompany,
    };
  }
  const authoritative = normalizeCompanyValue(
    input.authoritativeCompany.value
  );
  const proposed = normalizeCompanyValue(proposedCompany);
  return {
    disposition:
      authoritative === proposed ? "agreement" : "conflict",
    authoritativeCompany: input.authoritativeCompany.value,
    proposedCompany,
  };
}

export function decideMeetingMetadataInferenceCommit(input: {
  mode: MeetingMetadataInferenceMode;
  leaseAuthorized: boolean;
  currentCompany?: InterviewTargetCompany;
  parseResult: MeetingMetadataInferenceParseResult | undefined;
}): MeetingMetadataInferenceCommitDecision {
  if (input.mode !== "enforcement") {
    return { authorized: false, reason: "mode-not-enforcement" };
  }
  if (!input.leaseAuthorized) {
    return { authorized: false, reason: "lease-not-authorized" };
  }
  if (input.currentCompany) {
    return { authorized: false, reason: "company-already-resolved" };
  }
  if (!input.parseResult?.ok) {
    return { authorized: false, reason: "proposal-invalid" };
  }
  const proposal = input.parseResult.value;
  if (!proposal.company) {
    return { authorized: false, reason: "proposal-abstained" };
  }
  if (
    proposal.confidence <
    MEETING_METADATA_INFERENCE_COMMIT_MIN_CONFIDENCE
  ) {
    return {
      authorized: false,
      reason: "confidence-below-threshold",
    };
  }
  const company = normalizeInterviewBriefCompany(proposal.company);
  if (!company) {
    return { authorized: false, reason: "proposal-company-invalid" };
  }
  return {
    authorized: true,
    reason: "grounded-unresolved-company",
    targetCompany: {
      value: company.value,
      normalized: company.normalized,
      confidence: proposal.confidence,
      evidence: proposal.evidenceSpans.slice(0, 2).join(" | ").slice(0, 600),
    },
  };
}

export function formatMeetingMetadataInferenceForTrace(input: {
  request: MeetingMetadataInferenceRequest;
  authoritativeCompany?: InterviewTargetCompany;
  disposition: string;
  leaseAuthorized?: boolean;
  staleReason?: string;
  proposal?: LlmMeetingMetadataInference;
  comparison?: MeetingMetadataInferenceComparison;
}) {
  return {
    meetingMetadataInferenceDisposition: input.disposition,
    meetingMetadataInferencePromptVersion: input.request.promptVersion,
    meetingMetadataInferenceSchemaVersion: input.request.schemaVersion,
    meetingMetadataInferenceOperationRevision:
      input.request.operationRevision,
    meetingMetadataInferenceSourceHash:
      input.request.openingEvidence.sourceHash,
    meetingMetadataInferenceEvidenceTurnCount:
      input.request.openingEvidence.turns.length,
    meetingMetadataInferenceEvidenceChars:
      input.request.openingEvidence.totalChars,
    meetingMetadataInferenceOmittedTurnCount:
      input.request.openingEvidence.omittedTurnCount,
    meetingMetadataInferenceAuthoritativeSource:
      input.authoritativeCompany?.source,
    meetingMetadataInferenceAuthoritativeCompany:
      input.authoritativeCompany?.value,
    meetingMetadataInferenceLeaseAuthorized: input.leaseAuthorized,
    meetingMetadataInferenceStaleReason: input.staleReason,
    meetingMetadataInferenceProposalCompany: input.proposal?.company ?? undefined,
    meetingMetadataInferenceConfidence: input.proposal?.confidence,
    meetingMetadataInferenceEvidenceSpans: input.proposal?.evidenceSpans,
    meetingMetadataInferenceAbstainReason: input.proposal?.abstainReason,
    meetingMetadataInferenceComparisonDisposition:
      input.comparison?.disposition,
  };
}

function parseFailure(
  reason: string,
  errorKind: "parse" | "schema" | "evidence" | "provider"
): MeetingMetadataInferenceParseResult {
  return {
    ok: false,
    reason,
    errorKind,
    evidenceSpansValid: false,
  };
}

function hashAuthoritativeCompany(
  company: MeetingMetadataAuthoritativeCompany | undefined
) {
  return hashMeetingMetadataValues(
    company
      ? [company.value, company.normalized, company.source]
      : ["none"]
  );
}

function hashMeetingMetadataValues(values: string[]) {
  let hash = 2_166_136_261;
  for (const character of values.join("\u001f")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeCompanyValue(value: string) {
  const canonical = normalizeInterviewBriefCompany(value);
  if (canonical) return canonical.normalized;
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function evidenceSpanSupportsCompany(span: string, company: string) {
  const normalizedSpan = normalizeCompanyEvidenceText(span);
  return getInterviewCompanyEvidenceAliases(company).some((alias) =>
    containsNormalizedPhrase(normalizedSpan, alias)
  );
}

function normalizeCompanyEvidenceText(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsNormalizedPhrase(text: string, phrase: string) {
  return (` ${text} `).includes(` ${phrase} `);
}
