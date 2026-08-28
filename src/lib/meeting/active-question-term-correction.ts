import type {
  ActiveQuestionTermCorrection,
  SpeechCorrection,
} from "./types.js";
import {
  getLogicalQuestionSemanticEvidenceText,
  type LogicalQuestionUnit,
} from "./logical-question-unit.js";
import {
  applyTermCorrectionOverlayToText,
} from "./term-correction-projection.js";

const MAX_CANDIDATE_TOKENS = 4;
const FUZZY_MATCH_THRESHOLD = 0.72;
const FUZZY_MATCH_MARGIN = 0.08;

export interface ApplyActiveQuestionTermCorrectionInput {
  correction: SpeechCorrection;
  logicalQuestionUnit: LogicalQuestionUnit;
  correctionTraceId: string;
  manualCorrectionRevision: number;
  now?: number;
}

export interface ApplyActiveQuestionTermCorrectionResult {
  transaction: ActiveQuestionTermCorrection;
  logicalQuestionUnit: LogicalQuestionUnit;
}

export interface ActiveQuestionTermCorrectionAuthorization {
  authorized: boolean;
  reason:
    | "current-question-correction"
    | "logical-question-missing"
    | "logical-question-id-mismatch"
    | "logical-question-revision-mismatch"
    | "logical-question-session-mismatch"
    | "logical-question-runtime-mismatch"
    | "manual-correction-revision-mismatch";
}

export function applyActiveQuestionTermCorrection(
  input: ApplyActiveQuestionTermCorrectionInput
): ApplyActiveQuestionTermCorrectionResult {
  const now = input.now ?? Date.now();
  const normalizedTerm = normalizeCorrectionTerm(input.correction);
  if (!normalizedTerm) {
    throw new Error("A current-question correction requires a target term.");
  }

  const replacement = resolveTermReplacement({
    text: input.logicalQuestionUnit.normalizedText,
    from: input.correction.from,
    to: normalizedTerm,
  });
  const semanticReplacement = resolveTermReplacement({
    text: getLogicalQuestionSemanticEvidenceText(
      input.logicalQuestionUnit
    ),
    from: input.correction.from,
    to: normalizedTerm,
  });
  const correctedRevision = input.logicalQuestionUnit.revision + 1;
  const transaction: ActiveQuestionTermCorrection = {
    correctionId: input.correction.id,
    rawText: input.correction.input,
    normalizedTerm,
    sourceTerm: input.correction.from,
    replacedText:
      replacement.replacedText ?? semanticReplacement.replacedText,
    logicalQuestionUnitId: input.logicalQuestionUnit.id,
    logicalQuestionUnitRevision: input.logicalQuestionUnit.revision,
    correctedLogicalQuestionUnitRevision: correctedRevision,
    sourceTurnIds: [...input.logicalQuestionUnit.sourceTurnIds],
    manualCorrectionRevision: input.manualCorrectionRevision,
    disposition: "current-question-overlay",
    correctionTraceId: input.correctionTraceId,
    regenerationStatus: "idle",
    requestedAt: now,
  };
  const normalizedText = applyTermCorrectionOverlayToText(replacement.text, {
    normalizedTerm,
  });
  const correctedSemanticEvidenceText = applyTermCorrectionOverlayToText(
    semanticReplacement.text,
    { normalizedTerm }
  );
  const primaryAskProjection =
    input.logicalQuestionUnit.primaryAskProjection
      ? {
          ...input.logicalQuestionUnit.primaryAskProjection,
          normalizedPrimaryAsk: normalizedText,
          answerFocusText: normalizedText,
          semanticEvidenceText: correctedSemanticEvidenceText,
          semanticEvidenceRetentionReasons: Array.from(
            new Set([
              ...input.logicalQuestionUnit.primaryAskProjection
                .semanticEvidenceRetentionReasons,
              "manual-correction-overlay",
            ])
          ),
        }
      : undefined;

  return {
    transaction,
    logicalQuestionUnit: {
      ...input.logicalQuestionUnit,
      revision: correctedRevision,
      normalizedText,
      primaryAskProjection,
      updatedAt: now,
      compositionReasons: Array.from(
        new Set([
          ...input.logicalQuestionUnit.compositionReasons,
          "manual-term-correction-overlay",
        ])
      ),
      termCorrectionOverlays: [
        ...(input.logicalQuestionUnit.termCorrectionOverlays ?? []),
        transaction,
      ],
    },
  };
}

export function authorizeActiveQuestionTermCorrection(input: {
  transaction: ActiveQuestionTermCorrection;
  currentLogicalQuestionUnit: LogicalQuestionUnit | undefined;
  currentSessionId: string;
  currentRuntimeEpoch: number;
  currentManualCorrectionRevision: number;
}): ActiveQuestionTermCorrectionAuthorization {
  const current = input.currentLogicalQuestionUnit;
  if (!current) {
    return { authorized: false, reason: "logical-question-missing" };
  }
  if (current.sessionId !== input.currentSessionId) {
    return { authorized: false, reason: "logical-question-session-mismatch" };
  }
  if (current.runtimeEpoch !== input.currentRuntimeEpoch) {
    return { authorized: false, reason: "logical-question-runtime-mismatch" };
  }
  if (current.id !== input.transaction.logicalQuestionUnitId) {
    return { authorized: false, reason: "logical-question-id-mismatch" };
  }
  if (
    current.revision !==
    input.transaction.correctedLogicalQuestionUnitRevision
  ) {
    return { authorized: false, reason: "logical-question-revision-mismatch" };
  }
  if (
    input.currentManualCorrectionRevision !==
    input.transaction.manualCorrectionRevision
  ) {
    return {
      authorized: false,
      reason: "manual-correction-revision-mismatch",
    };
  }
  return { authorized: true, reason: "current-question-correction" };
}

export function hasAppliedTermCorrection(
  logicalQuestionUnit: LogicalQuestionUnit,
  correction: SpeechCorrection
) {
  const normalizedTerm = normalizeCorrectionTerm(correction);
  if (!normalizedTerm) return false;
  return (logicalQuestionUnit.termCorrectionOverlays ?? []).some(
    (overlay) =>
      overlay.normalizedTerm.toLowerCase() === normalizedTerm.toLowerCase()
  );
}

export function formatActiveQuestionTermCorrectionForTrace(
  transaction: ActiveQuestionTermCorrection,
  authorization?: ActiveQuestionTermCorrectionAuthorization
): Record<string, unknown> {
  return {
    manualTermCorrectionId: transaction.correctionId,
    manualTermCorrectionDisposition: transaction.disposition,
    manualTermCorrectionNormalizedTerm: transaction.normalizedTerm,
    manualTermCorrectionSourceTerm: transaction.sourceTerm,
    manualTermCorrectionReplacedText: transaction.replacedText,
    manualTermCorrectionLogicalQuestionUnitId:
      transaction.logicalQuestionUnitId,
    manualTermCorrectionLogicalQuestionUnitRevision:
      transaction.logicalQuestionUnitRevision,
    manualTermCorrectionCorrectedLogicalQuestionUnitRevision:
      transaction.correctedLogicalQuestionUnitRevision,
    manualTermCorrectionSourceTurnIds: transaction.sourceTurnIds,
    manualTermCorrectionRevision: transaction.manualCorrectionRevision,
    manualTermCorrectionTraceId: transaction.correctionTraceId,
    manualTermCorrectionRegenerationTraceId:
      transaction.regenerationTraceId,
    manualTermCorrectionSettlementId: transaction.settlementId,
    correctionOwnedAdjudicationOperationId:
      transaction.semanticAdjudicationOperationId,
    correctionOwnedAdjudicationStatus:
      transaction.semanticAdjudicationStatus,
    correctionOwnedAdjudicationTriggerReason:
      transaction.semanticAdjudicationTriggerReason,
    correctionOwnedAdjudicationCandidateType:
      transaction.semanticAdjudicationCandidateType,
    correctionOwnedAdjudicationRelation:
      transaction.semanticAdjudicationRelation,
    correctionOwnedAdjudicationConfidence:
      transaction.semanticAdjudicationConfidence,
    correctionOwnedAdjudicationDurationMs:
      transaction.semanticAdjudicationDurationMs,
    correctionOwnedResettlementDisposition:
      transaction.semanticResettlementDisposition,
    correctionOwnedPreviousParentType:
      transaction.previousParentType,
    correctionOwnedResettledParentType:
      transaction.resettledParentType,
    manualTermCorrectionRegenerationStatus:
      transaction.regenerationStatus,
    manualTermCorrectionLatencyMs:
      transaction.correctionToAnswerLatencyMs,
    manualTermCorrectionAuthorized: authorization?.authorized,
    manualTermCorrectionAuthorizationReason: authorization?.reason,
  };
}

function normalizeCorrectionTerm(correction: SpeechCorrection) {
  return (correction.to ?? correction.term ?? "").trim();
}

function resolveTermReplacement(input: {
  text: string;
  from?: string;
  to: string;
}) {
  const explicitSource = input.from?.trim();
  if (explicitSource) {
    const replaced = replacePhrase(input.text, explicitSource, input.to);
    if (replaced.changed) {
      return {
        text: replaced.text,
        replacedText: explicitSource,
      };
    }
  }

  const candidate = findUniqueCorrectionCandidate(input.text, input.to);
  if (!candidate) return { text: input.text };
  const replaced = replacePhrase(input.text, candidate, input.to);
  return {
    text: replaced.text,
    replacedText: replaced.changed ? candidate : undefined,
  };
}

function findUniqueCorrectionCandidate(text: string, target: string) {
  const targetKey = normalizeSpokenTechnicalTerm(target);
  if (!targetKey || targetKey.length < 2) return undefined;
  const tokens = Array.from(
    text.matchAll(/[A-Za-z0-9+#.-]+/g),
    (match) => ({
      value: match[0],
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    })
  );
  const candidates: Array<{ phrase: string; score: number }> = [];

  for (let start = 0; start < tokens.length; start += 1) {
    for (
      let size = 1;
      size <= MAX_CANDIDATE_TOKENS && start + size <= tokens.length;
      size += 1
    ) {
      const first = tokens[start];
      const last = tokens[start + size - 1];
      const phrase = text.slice(first.start, last.end);
      const candidateKey = normalizeSpokenTechnicalTerm(phrase);
      if (!candidateKey) continue;
      const score =
        candidateKey === targetKey
          ? 1
          : normalizedSimilarity(candidateKey, targetKey);
      if (score >= FUZZY_MATCH_THRESHOLD) {
        candidates.push({ phrase, score });
      }
    }
  }

  candidates.sort((left, right) => right.score - left.score);
  const best = candidates[0];
  if (!best) return undefined;
  const runnerUp = candidates.find(
    (candidate) => candidate.phrase.toLowerCase() !== best.phrase.toLowerCase()
  );
  if (
    runnerUp &&
    best.score < 1 &&
    best.score - runnerUp.score < FUZZY_MATCH_MARGIN
  ) {
    return undefined;
  }
  return best.phrase;
}

function normalizeSpokenTechnicalTerm(value: string) {
  return value
    .toLowerCase()
    .replace(/\b(?:and|n)\b/g, "n")
    .replace(/[^a-z0-9+#]+/g, "");
}

function normalizedSimilarity(left: string, right: string) {
  const longest = Math.max(left.length, right.length);
  if (!longest) return 1;
  return 1 - levenshteinDistance(left, right) / longest;
}

function levenshteinDistance(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function replacePhrase(text: string, from: string, to: string) {
  const pattern = new RegExp(escapeRegExp(from), "gi");
  let changed = false;
  const next = text.replace(pattern, () => {
    changed = true;
    return to;
  });
  return { text: next, changed };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
