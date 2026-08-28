import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import { projectPrimaryAsk } from "./primary-ask-projection.js";
import {
  applySpeechCorrectionReplacement,
  applyTermCorrectionOverlaysToText,
  TERM_CORRECTION_PROJECTION_MAX_CHARS,
} from "./term-correction-projection.js";
import type { SpeechCorrection } from "./types.js";

export type ReverseActiveQuestionTermCorrectionResult =
  | {
      reversed: true;
      reason: "current-lqu-correction-provenance";
      logicalQuestionUnit: LogicalQuestionUnit;
      previousRevision: number;
      nextRevision: number;
    }
  | {
      reversed: false;
      reason:
        | "correction-not-applied-to-current-lqu"
        | "source-pre-normalization-text-missing";
    };

export function reverseActiveQuestionTermCorrection(input: {
  correction: SpeechCorrection;
  logicalQuestionUnit: LogicalQuestionUnit;
  corrections: SpeechCorrection[];
  now?: number;
}): ReverseActiveQuestionTermCorrectionResult {
  const correctionId = input.correction.id;
  const overlayApplied = (
    input.logicalQuestionUnit.termCorrectionOverlays ?? []
  ).some((overlay) => overlay.correctionId === correctionId);
  const sourceApplied = input.logicalQuestionUnit.sources.some((source) =>
    source.appliedSpeechCorrectionIds?.includes(correctionId)
  );
  if (!overlayApplied && !sourceApplied) {
    return {
      reversed: false,
      reason: "correction-not-applied-to-current-lqu",
    };
  }
  if (
    input.logicalQuestionUnit.sources.some(
      (source) =>
        source.appliedSpeechCorrectionIds?.includes(correctionId) &&
        !source.preNormalizationText?.trim()
    )
  ) {
    return {
      reversed: false,
      reason: "source-pre-normalization-text-missing",
    };
  }

  const activeCorrectionsById = new Map(
    input.corrections
      .filter(
        (correction) =>
          correction.id !== correctionId && !correction.deactivatedAt
      )
      .map((correction) => [correction.id, correction])
  );
  const sources = input.logicalQuestionUnit.sources.map((source) => {
    const appliedIds = source.appliedSpeechCorrectionIds ?? [];
    if (!appliedIds.includes(correctionId)) {
      return {
        ...source,
        appliedSpeechCorrectionIds: source.appliedSpeechCorrectionIds
          ? [...source.appliedSpeechCorrectionIds]
          : undefined,
      };
    }
    const remainingIds = appliedIds.filter(
      (candidateId) =>
        candidateId !== correctionId && activeCorrectionsById.has(candidateId)
    );
    const text = remainingIds.reduce((current, candidateId) => {
      const correction = activeCorrectionsById.get(candidateId);
      return correction
        ? applySpeechCorrectionReplacement({
            text: current,
            from: correction.from,
            to: correction.to ?? correction.term,
          })
        : current;
    }, source.preNormalizationText?.trim() ?? source.text);
    return {
      ...source,
      text,
      appliedSpeechCorrectionIds: remainingIds.length
        ? remainingIds
        : undefined,
    };
  });
  const remainingOverlays = (
    input.logicalQuestionUnit.termCorrectionOverlays ?? []
  ).filter((overlay) => overlay.correctionId !== correctionId);
  const sourceText = sources
    .map((source) => source.text.trim())
    .filter(Boolean)
    .join(" ")
    .slice(-TERM_CORRECTION_PROJECTION_MAX_CHARS);
  const projected = projectPrimaryAsk({
    turnId: input.logicalQuestionUnit.currentTurnId,
    text: sourceText,
  });
  const normalizedBase = projected.normalizedPrimaryAsk ?? sourceText;
  const normalizedText = remainingOverlays.length
    ? applyTermCorrectionOverlaysToText(normalizedBase, remainingOverlays)
    : normalizedBase;
  const primaryAskProjection = remainingOverlays.length
    ? {
        ...projected,
        normalizedPrimaryAsk: normalizedText,
        answerFocusText: normalizedText,
        semanticEvidenceText: applyTermCorrectionOverlaysToText(
          projected.semanticEvidenceText,
          remainingOverlays
        ),
        semanticEvidenceRetentionReasons: Array.from(
          new Set([
            ...projected.semanticEvidenceRetentionReasons,
            "manual-correction-overlay" as const,
          ])
        ),
      }
    : projected;
  const previousRevision = input.logicalQuestionUnit.revision;
  const nextRevision = previousRevision + 1;

  return {
    reversed: true,
    reason: "current-lqu-correction-provenance",
    previousRevision,
    nextRevision,
    logicalQuestionUnit: {
      ...input.logicalQuestionUnit,
      revision: nextRevision,
      sources,
      normalizedText,
      updatedAt: input.now ?? Date.now(),
      compositionReasons: Array.from(
        new Set([
          ...input.logicalQuestionUnit.compositionReasons,
          "manual-term-correction-reversal",
        ])
      ),
      boundaryReason: "manual-term-correction-reversal",
      primaryAskProjection,
      termCorrectionOverlays: remainingOverlays.length
        ? remainingOverlays.map((overlay) => ({ ...overlay }))
        : undefined,
    },
  };
}
