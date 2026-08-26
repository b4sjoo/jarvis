import { STORAGE_KEYS } from "../../config/constants.js";
import { safeLocalStorage } from "../storage/helper.js";
import {
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";
import type {
  HumanEvaluationTaskRelation,
  InterviewTaskRelation,
  MeetingTrace,
  TranscriptTurn,
} from "./types.js";

const MAX_CRITICAL_MOMENT_CANDIDATES = 1_000;
const MAX_CRITICAL_MOMENT_EVALUATIONS = 1_000;
const ADJACENT_COMPOSITION_WINDOW_MS = 5_000;

export type CriticalMomentCandidateSource =
  | "transcript-rule"
  | "offline-semantic"
  | "offline-llm"
  | "runtime-lqu"
  | "manual";

export type CriticalMomentTraceJoinStatus =
  | "none"
  | "exact"
  | "proposed"
  | "ambiguous";

export type CriticalMomentEligibility =
  | "critical"
  | "not-critical"
  | "uncertain";

export type CriticalMomentAdvisorAction =
  | "advise"
  | "clarify"
  | "append-context"
  | "ignore";

export type CriticalMomentFailureReason =
  | "no-advice"
  | "late-advice"
  | "wrong-question"
  | "wrong-type"
  | "wrong-relation"
  | "wrong-context"
  | "unsupported-fact"
  | "irrelevant-memory"
  | "insufficient-answer"
  | "provider-or-parser-failure"
  | "stale-or-cancelled"
  | "ui-or-interaction-friction"
  | "user-did-not-need-help"
  | "other";

export interface CriticalMomentCandidate {
  momentId: string;
  sessionId: string;
  sourceTurnIds: string[];
  sourceText: string;
  opportunityStartAt?: number;
  opportunityEndAt?: number;
  candidateSource: CriticalMomentCandidateSource;
  candidateReasons: string[];
  proposedTraceIds: string[];
  proposedQuestionType?: CanonicalQuestionType;
  traceJoinStatus: CriticalMomentTraceJoinStatus;
  createdAt: number;
  updatedAt: number;
}

export interface CriticalMomentEvaluation {
  momentId: string;
  sessionId: string;
  sourceTurnIds: string[];
  traceIds: string[];
  eligibility?: CriticalMomentEligibility;
  /** @deprecated Read-only compatibility. New truth is stored in V2 projections. */
  expectedQuestionType?: CanonicalQuestionType;
  /** @deprecated Read-only compatibility. New truth is stored in V2 projections. */
  expectedAdvisorAction?: CriticalMomentAdvisorAction;
  /** @deprecated Read-only compatibility. New truth is stored in V2 projections. */
  expectedRelation?: HumanEvaluationTaskRelation;
  /** @deprecated Read-only compatibility. New truth is stored in V2 projections. */
  expectedContextTurnIds?: string[];
  opportunityEndAt?: number;
  selectedUsefulTraceId?: string;
  firstUsefulAt?: number;
  userSpeechStartAt?: number;
  useful?: boolean;
  trustworthy?: boolean;
  naturalStart?: boolean;
  waitedForJarvis?: boolean;
  readFromJarvis?: boolean;
  interactionRequired?: boolean;
  failureReasons: CriticalMomentFailureReason[];
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export type CriticalMomentOutcomeEvaluationPatch = Omit<
  Partial<CriticalMomentEvaluation>,
  | "expectedQuestionType"
  | "expectedAdvisorAction"
  | "expectedRelation"
  | "expectedContextTurnIds"
>;

export interface CriticalMomentTraceEvidence {
  traceId: string;
  startedAt?: number;
  endedAt?: number;
  logicalQuestionUnitId?: string;
  sourceTurnIds: string[];
  questionType?: string;
}

export interface BuildCriticalMomentCandidatesInput {
  sessionId: string;
  transcriptTurns: TranscriptTurn[];
  traces: CriticalMomentTraceEvidence[];
  now?: number;
}

export function projectCriticalMomentTraceEvidence(
  trace: Pick<MeetingTrace, "id" | "startedAt" | "endedAt" | "metadata">
): CriticalMomentTraceEvidence {
  return {
    traceId: trace.id,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    logicalQuestionUnitId: readMetadataString(
      trace.metadata,
      "logicalQuestionUnitId"
    ),
    sourceTurnIds: readMetadataStringList(
      trace.metadata,
      "logicalQuestionSourceTurnIds"
    ),
    questionType:
      readMetadataString(trace.metadata, "canonicalQuestionType") ??
      readMetadataString(trace.metadata, "questionType"),
  };
}

export function createCriticalMomentId(
  sessionId: string,
  sourceTurnIds: string[]
) {
  const canonicalTurnIds = uniqueStrings(sourceTurnIds).sort();
  return `critical_moment_${stableHash(
    `${sessionId}\u0000${canonicalTurnIds.join("\u0000")}`
  )}`;
}

export function buildCriticalMomentCandidates(
  input: BuildCriticalMomentCandidatesInput
): CriticalMomentCandidate[] {
  const now = input.now ?? Date.now();
  const interviewerTurns = input.transcriptTurns
    .filter(
      (turn) =>
        turn.speaker === "them" &&
        turn.isFinal !== false &&
        Boolean(turn.text.trim())
    )
    .sort(compareTurns);
  if (!interviewerTurns.length) return [];

  const turnById = new Map(interviewerTurns.map((turn) => [turn.id, turn]));
  const parentByTurnId = new Map(
    interviewerTurns.map((turn) => [turn.id, turn.id])
  );
  const find = (turnId: string): string => {
    const parent = parentByTurnId.get(turnId) ?? turnId;
    if (parent === turnId) return parent;
    const root = find(parent);
    parentByTurnId.set(turnId, root);
    return root;
  };
  const union = (leftId: string, rightId: string) => {
    const leftRoot = find(leftId);
    const rightRoot = find(rightId);
    if (leftRoot !== rightRoot) parentByTurnId.set(rightRoot, leftRoot);
  };

  for (const trace of input.traces) {
    const traceTurnIds = uniqueStrings(trace.sourceTurnIds).filter((turnId) =>
      turnById.has(turnId)
    );
    const [firstTurnId, ...remainingTurnIds] = traceTurnIds;
    if (!firstTurnId) continue;
    for (const turnId of remainingTurnIds) union(firstTurnId, turnId);
  }

  for (let index = 1; index < interviewerTurns.length; index += 1) {
    const previous = interviewerTurns[index - 1];
    const current = interviewerTurns[index];
    if (shouldComposeAdjacentTurns(previous, current)) {
      union(previous.id, current.id);
    }
  }

  const groups = new Map<string, TranscriptTurn[]>();
  for (const turn of interviewerTurns) {
    const root = find(turn.id);
    groups.set(root, [...(groups.get(root) ?? []), turn]);
  }

  return Array.from(groups.values())
    .map((turns) => {
      const orderedTurns = [...turns].sort(compareTurns);
      const sourceTurnIds = orderedTurns.map((turn) => turn.id);
      const sourceTurnIdSet = new Set(sourceTurnIds);
      const overlappingTraces = input.traces.filter((trace) =>
        trace.sourceTurnIds.some((turnId) => sourceTurnIdSet.has(turnId))
      );
      const exactTraces = overlappingTraces.filter(
        (trace) =>
          trace.sourceTurnIds.length > 0 &&
          trace.sourceTurnIds.every((turnId) => sourceTurnIdSet.has(turnId))
      );
      const questionTypes = Array.from(
        new Set(
        overlappingTraces
          .map((trace) =>
            normalizeCanonicalQuestionType(trace.questionType)
          )
          .filter((value): value is CanonicalQuestionType => Boolean(value))
        )
      );
      const candidateReasons = [
        "them-transcript-turn",
        ...signalReasons(orderedTurns.map((turn) => turn.text).join(" ")),
      ];
      if (orderedTurns.length > 1) {
        candidateReasons.push("bounded-adjacent-composition");
      }
      if (
        overlappingTraces.some(
          (trace) =>
            Boolean(trace.logicalQuestionUnitId) &&
            trace.sourceTurnIds.length > 1
        )
      ) {
        candidateReasons.push("runtime-lqu-source-span");
      }
      if (!overlappingTraces.length) {
        candidateReasons.push("zero-trace-opportunity");
      }

      return {
        momentId: createCriticalMomentId(input.sessionId, sourceTurnIds),
        sessionId: input.sessionId,
        sourceTurnIds,
        sourceText: orderedTurns.map((turn) => turn.text.trim()).join(" "),
        opportunityStartAt: orderedTurns[0]?.startedAt,
        opportunityEndAt: orderedTurns[orderedTurns.length - 1]?.endedAt,
        candidateSource: overlappingTraces.some((trace) =>
          Boolean(trace.logicalQuestionUnitId)
        )
          ? "runtime-lqu"
          : "transcript-rule",
        candidateReasons: uniqueStrings(candidateReasons),
        proposedTraceIds: uniqueStrings(
          overlappingTraces.map((trace) => trace.traceId)
        ),
        proposedQuestionType:
          questionTypes.length === 1 ? questionTypes[0] : undefined,
        traceJoinStatus: resolveTraceJoinStatus(
          overlappingTraces.length,
          exactTraces.length
        ),
        createdAt: now,
        updatedAt: now,
      } satisfies CriticalMomentCandidate;
    })
    .sort((left, right) => {
      const leftAt = left.opportunityStartAt ?? 0;
      const rightAt = right.opportunityStartAt ?? 0;
      return leftAt - rightAt || left.momentId.localeCompare(right.momentId);
    });
}

export function mergeCriticalMomentCandidates(
  existing: CriticalMomentCandidate[],
  currentWindow: CriticalMomentCandidate[],
  sessionId: string
) {
  const currentTurnIds = new Set(
    currentWindow.flatMap((candidate) => candidate.sourceTurnIds)
  );
  const retained = existing.filter(
    (candidate) =>
      candidate.sessionId !== sessionId ||
      !candidate.sourceTurnIds.some((turnId) => currentTurnIds.has(turnId))
  );
  const existingById = new Map(
    existing.map((candidate) => [candidate.momentId, candidate])
  );
  const mergedCurrent = currentWindow.map((candidate) => {
    const previous = existingById.get(candidate.momentId);
    return previous
      ? {
          ...candidate,
          createdAt: previous.createdAt,
          updatedAt:
            candidateFingerprint(previous) === candidateFingerprint(candidate)
              ? previous.updatedAt
              : candidate.updatedAt,
        }
      : candidate;
  });
  return [...retained, ...mergedCurrent]
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(-MAX_CRITICAL_MOMENT_CANDIDATES);
}

export function upsertCriticalMomentEvaluation(
  evaluations: CriticalMomentEvaluation[],
  candidate: CriticalMomentCandidate,
  patch: CriticalMomentOutcomeEvaluationPatch
) {
  const now = Date.now();
  const existingIndex = evaluations.findIndex(
    (evaluation) => evaluation.momentId === candidate.momentId
  );
  const existing =
    existingIndex >= 0 ? evaluations[existingIndex] : undefined;
  const next: CriticalMomentEvaluation = {
    momentId: candidate.momentId,
    sessionId: candidate.sessionId,
    sourceTurnIds: uniqueStrings([
      ...(existing?.sourceTurnIds ?? []),
      ...candidate.sourceTurnIds,
      ...(patch.sourceTurnIds ?? []),
    ]),
    traceIds: uniqueStrings([
      ...(existing?.traceIds ?? []),
      ...(patch.traceIds ?? []),
    ]),
    eligibility: patch.eligibility ?? existing?.eligibility,
    expectedQuestionType: existing?.expectedQuestionType,
    expectedAdvisorAction: existing?.expectedAdvisorAction,
    expectedRelation: existing?.expectedRelation,
    expectedContextTurnIds: existing?.expectedContextTurnIds,
    opportunityEndAt:
      patch.opportunityEndAt ??
      existing?.opportunityEndAt ??
      candidate.opportunityEndAt,
    selectedUsefulTraceId:
      patch.selectedUsefulTraceId ?? existing?.selectedUsefulTraceId,
    firstUsefulAt: patch.firstUsefulAt ?? existing?.firstUsefulAt,
    userSpeechStartAt:
      patch.userSpeechStartAt ?? existing?.userSpeechStartAt,
    useful: patch.useful ?? existing?.useful,
    trustworthy: patch.trustworthy ?? existing?.trustworthy,
    naturalStart: patch.naturalStart ?? existing?.naturalStart,
    waitedForJarvis: patch.waitedForJarvis ?? existing?.waitedForJarvis,
    readFromJarvis: patch.readFromJarvis ?? existing?.readFromJarvis,
    interactionRequired:
      patch.interactionRequired ?? existing?.interactionRequired,
    failureReasons: (
      patch.failureReasons === undefined
        ? existing?.failureReasons ?? []
        : uniqueStrings(patch.failureReasons)
    ) as CriticalMomentFailureReason[],
    notes: patch.notes ?? existing?.notes,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const nextEvaluations =
    existingIndex >= 0
      ? [
          ...evaluations.slice(0, existingIndex),
          next,
          ...evaluations.slice(existingIndex + 1),
        ]
      : [...evaluations, next];
  return nextEvaluations.slice(-MAX_CRITICAL_MOMENT_EVALUATIONS);
}

export function readCriticalMomentCandidates(): CriticalMomentCandidate[] {
  return readStoredArray(
    STORAGE_KEYS.MEETING_CRITICAL_MOMENT_CANDIDATES,
    normalizeCriticalMomentCandidate,
    MAX_CRITICAL_MOMENT_CANDIDATES
  );
}

export function persistCriticalMomentCandidates(
  candidates: CriticalMomentCandidate[]
) {
  safeLocalStorage.setItem(
    STORAGE_KEYS.MEETING_CRITICAL_MOMENT_CANDIDATES,
    JSON.stringify(candidates.slice(-MAX_CRITICAL_MOMENT_CANDIDATES))
  );
}

export function readCriticalMomentEvaluations(): CriticalMomentEvaluation[] {
  return readStoredArray(
    STORAGE_KEYS.MEETING_CRITICAL_MOMENT_EVALUATIONS,
    normalizeCriticalMomentEvaluation,
    MAX_CRITICAL_MOMENT_EVALUATIONS
  );
}

export function persistCriticalMomentEvaluations(
  evaluations: CriticalMomentEvaluation[]
) {
  safeLocalStorage.setItem(
    STORAGE_KEYS.MEETING_CRITICAL_MOMENT_EVALUATIONS,
    JSON.stringify(evaluations.slice(-MAX_CRITICAL_MOMENT_EVALUATIONS))
  );
}

function normalizeCriticalMomentCandidate(
  value: unknown
): CriticalMomentCandidate | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<CriticalMomentCandidate>;
  if (
    typeof candidate.momentId !== "string" ||
    typeof candidate.sessionId !== "string" ||
    !Array.isArray(candidate.sourceTurnIds) ||
    typeof candidate.sourceText !== "string"
  ) {
    return undefined;
  }
  return {
    momentId: candidate.momentId,
    sessionId: candidate.sessionId,
    sourceTurnIds: uniqueStrings(candidate.sourceTurnIds),
    sourceText: candidate.sourceText,
    opportunityStartAt: finiteNumber(candidate.opportunityStartAt),
    opportunityEndAt: finiteNumber(candidate.opportunityEndAt),
    candidateSource: isCandidateSource(candidate.candidateSource)
      ? candidate.candidateSource
      : "transcript-rule",
    candidateReasons: uniqueStrings(candidate.candidateReasons ?? []),
    proposedTraceIds: uniqueStrings(candidate.proposedTraceIds ?? []),
    proposedQuestionType: normalizeCanonicalQuestionType(
      candidate.proposedQuestionType
    ),
    traceJoinStatus: isTraceJoinStatus(candidate.traceJoinStatus)
      ? candidate.traceJoinStatus
      : candidate.proposedTraceIds?.length
        ? "proposed"
        : "none",
    createdAt: finiteNumber(candidate.createdAt) ?? Date.now(),
    updatedAt: finiteNumber(candidate.updatedAt) ?? Date.now(),
  };
}

function normalizeCriticalMomentEvaluation(
  value: unknown
): CriticalMomentEvaluation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const evaluation = value as Partial<CriticalMomentEvaluation>;
  if (
    typeof evaluation.momentId !== "string" ||
    typeof evaluation.sessionId !== "string" ||
    !Array.isArray(evaluation.sourceTurnIds)
  ) {
    return undefined;
  }
  return {
    momentId: evaluation.momentId,
    sessionId: evaluation.sessionId,
    sourceTurnIds: uniqueStrings(evaluation.sourceTurnIds),
    traceIds: uniqueStrings(evaluation.traceIds ?? []),
    eligibility: isEligibility(evaluation.eligibility)
      ? evaluation.eligibility
      : undefined,
    expectedQuestionType: normalizeCanonicalQuestionType(
      evaluation.expectedQuestionType
    ),
    expectedAdvisorAction: isAdvisorAction(
      evaluation.expectedAdvisorAction
    )
      ? evaluation.expectedAdvisorAction
      : undefined,
    expectedRelation: isInterviewTaskRelation(evaluation.expectedRelation)
      ? evaluation.expectedRelation
      : undefined,
    expectedContextTurnIds: uniqueStrings(
      evaluation.expectedContextTurnIds ?? []
    ),
    opportunityEndAt: finiteNumber(evaluation.opportunityEndAt),
    selectedUsefulTraceId:
      typeof evaluation.selectedUsefulTraceId === "string"
        ? evaluation.selectedUsefulTraceId
        : undefined,
    firstUsefulAt: finiteNumber(evaluation.firstUsefulAt),
    userSpeechStartAt: finiteNumber(evaluation.userSpeechStartAt),
    useful: booleanValue(evaluation.useful),
    trustworthy: booleanValue(evaluation.trustworthy),
    naturalStart: booleanValue(evaluation.naturalStart),
    waitedForJarvis: booleanValue(evaluation.waitedForJarvis),
    readFromJarvis: booleanValue(evaluation.readFromJarvis),
    interactionRequired: booleanValue(evaluation.interactionRequired),
    failureReasons: uniqueStrings(
      (evaluation.failureReasons ?? []).filter(isFailureReason)
    ) as CriticalMomentFailureReason[],
    notes:
      typeof evaluation.notes === "string" ? evaluation.notes : undefined,
    createdAt: finiteNumber(evaluation.createdAt) ?? Date.now(),
    updatedAt: finiteNumber(evaluation.updatedAt) ?? Date.now(),
  };
}

function readStoredArray<T>(
  key: string,
  normalize: (value: unknown) => T | undefined,
  limit: number
) {
  const stored = safeLocalStorage.getItem(key);
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalize).filter((value): value is T => Boolean(value)).slice(-limit);
  } catch {
    return [];
  }
}

function shouldComposeAdjacentTurns(
  previous: TranscriptTurn,
  current: TranscriptTurn
) {
  const gapMs = current.startedAt - previous.endedAt;
  if (gapMs < 0 || gapMs > ADJACENT_COMPOSITION_WINDOW_MS) return false;
  const previousText = previous.text.trim();
  const currentText = current.text.trim();
  if (!previousText || !currentText) return false;
  if (/[?？.!。！]$/.test(previousText)) return false;
  return (
    /[,，:：;；\-—]$/.test(previousText) ||
    /\b(?:and|or|but|because|so|then|with|without|about|for|to|of)$/i.test(
      previousText
    ) ||
    /^(?:and|or|but|because|so|then|also|which|that|where|when|how|what|why|who|can|could|would|should|do|does|did|is|are|was|were)\b/i.test(
      currentText
    ) ||
    /^[a-z]/.test(currentText)
  );
}

function signalReasons(text: string) {
  const reasons: string[] = [];
  if (/[?？]/.test(text)) reasons.push("question-mark");
  if (
    /\b(?:design|implement|write|build|explain|describe|compare|estimate|calculate|tell me|walk me through|give me an example)\b/i.test(
      text
    )
  ) {
    reasons.push("directive-signal");
  }
  if (
    /\b(?:what|why|how|when|where|who|which|can|could|would|should|do|does|did|is|are|was|were)\b/i.test(
      text
    )
  ) {
    reasons.push("question-signal");
  }
  if (!reasons.length) reasons.push("review-required");
  return reasons;
}

function resolveTraceJoinStatus(
  overlappingTraceCount: number,
  exactTraceCount: number
): CriticalMomentTraceJoinStatus {
  if (!overlappingTraceCount) return "none";
  if (exactTraceCount === 1 && overlappingTraceCount === 1) return "exact";
  if (exactTraceCount > 1 || overlappingTraceCount > 1) return "ambiguous";
  return "proposed";
}

function candidateFingerprint(candidate: CriticalMomentCandidate) {
  return JSON.stringify({
    sourceTurnIds: candidate.sourceTurnIds,
    sourceText: candidate.sourceText,
    proposedTraceIds: candidate.proposedTraceIds,
    proposedQuestionType: candidate.proposedQuestionType,
    traceJoinStatus: candidate.traceJoinStatus,
    candidateReasons: candidate.candidateReasons,
  });
}

function stableHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function compareTurns(left: TranscriptTurn, right: TranscriptTurn) {
  return left.startedAt - right.startedAt || left.id.localeCompare(right.id);
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string
) {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readMetadataStringList(
  metadata: Record<string, unknown> | undefined,
  key: string
) {
  const value = metadata?.[key];
  return Array.isArray(value) ? uniqueStrings(value) : [];
}

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function uniqueStrings(values: unknown[]) {
  return Array.from(
    new Set(
      values.filter(
        (value): value is string =>
          typeof value === "string" && Boolean(value.trim())
      )
    )
  );
}

function isCandidateSource(
  value: unknown
): value is CriticalMomentCandidateSource {
  return [
    "transcript-rule",
    "offline-semantic",
    "offline-llm",
    "runtime-lqu",
    "manual",
  ].includes(String(value));
}

function isTraceJoinStatus(
  value: unknown
): value is CriticalMomentTraceJoinStatus {
  return ["none", "exact", "proposed", "ambiguous"].includes(String(value));
}

function isEligibility(value: unknown): value is CriticalMomentEligibility {
  return ["critical", "not-critical", "uncertain"].includes(String(value));
}

function isAdvisorAction(
  value: unknown
): value is CriticalMomentAdvisorAction {
  return ["advise", "clarify", "append-context", "ignore"].includes(
    String(value)
  );
}

function isInterviewTaskRelation(
  value: unknown
): value is InterviewTaskRelation {
  return [
    "new-parent",
    "followup-parent",
    "child-probe",
    "resume-parent",
    "logistics",
    "correction",
    "unknown",
  ].includes(String(value));
}

function isFailureReason(
  value: unknown
): value is CriticalMomentFailureReason {
  return [
    "no-advice",
    "late-advice",
    "wrong-question",
    "wrong-type",
    "wrong-relation",
    "wrong-context",
    "unsupported-fact",
    "irrelevant-memory",
    "insufficient-answer",
    "provider-or-parser-failure",
    "stale-or-cancelled",
    "ui-or-interaction-friction",
    "user-did-not-need-help",
    "other",
  ].includes(String(value));
}
