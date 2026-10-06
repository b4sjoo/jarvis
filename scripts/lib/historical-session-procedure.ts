import { buildSessionProcedureV1, type HistoricalSessionProcedureV2, type SessionProcedureStepV1 } from "../../src/lib/meeting/session-procedure.js";

export function buildHistoricalSessionProcedure(input: Parameters<typeof buildSessionProcedureV1>[0] & {
  originalScriptedValidation: boolean;
  originalDirectory: string;
  selection: "historical" | "them-only";
}): HistoricalSessionProcedureV2 {
  const themOnly = input.selection === "them-only";
  const turns = input.transcriptTurns.filter(turn => !themOnly || turn.speaker === "them");
  const selectedTurns = new Set(turns.map(turn => turn.id));
  const timeline = themOnly ? input.timelineEvents.filter(event =>
    event.kind === "transcript-turn" ? selectedTurns.has(String(event.metadata?.turnId)) : event.kind === "capture-lifecycle") : input.timelineEvents;
  const base = buildSessionProcedureV1({ ...input, timelineEvents: timeline, transcriptTurns: turns,
    manualActions: themOnly ? [] : input.manualActions,
    runtimeRegressionSteps: themOnly ? input.runtimeRegressionSteps?.filter(step => step.inputKind === "them-text") : input.runtimeRegressionSteps,
    humanEvaluationProjections: themOnly ? [] : input.humanEvaluationProjections,
  });
  const eventOrder = new Map(input.timelineEvents.map((event, index) => [event.id, { index, at: event.createdAt }]));
  for (const [index, event] of input.timelineEvents.entries()) {
    if (event.kind === "runtime-regression-step" && event.metadata?.event === "injected") {
      eventOrder.set(`runtime-regression-step:${event.metadata.scenarioRunId}:${event.metadata.scenarioStepId}`, { index, at: event.createdAt });
    }
  }
  const textOrder = new Map(turns.map((turn, index) => [turn.id, index]));
  const originalTurns = new Map(input.transcriptTurns.map(turn => [turn.id, turn]));
  const eventPosition = (step: SessionProcedureStepV1) => eventOrder.get(step.provenance.timelineEventId);
  const transcriptPosition = (step: SessionProcedureStepV1) => textOrder.get(step.provenance.sourceTurnIds[0]);
  const selected = base.steps.filter(step => !themOnly || step.kind === "them-text");
  const allEvents = selected.every(step => eventPosition(step) !== undefined);
  const allText = selected.every(step => ["them-text", "me-text"].includes(step.kind) && transcriptPosition(step) !== undefined);
  const orderBasis = allEvents ? "recorded-events" : allText ? "accepted-transcript-order" : "unavailable";
  if (allEvents) selected.sort((a, b) => eventPosition(a)!.index - eventPosition(b)!.index);
  else if (allText) selected.sort((a, b) => transcriptPosition(a)! - transcriptPosition(b)!);
  let previousAt: number | undefined;
  const steps: HistoricalSessionProcedureV2["steps"] = selected.map((step, index) => {
    const rawAt = eventPosition(step)?.at;
    const occurredAt = typeof rawAt === "number" && Number.isFinite(rawAt) ? rawAt : undefined;
    const delayAfterPreviousMs = occurredAt !== undefined && previousAt !== undefined && occurredAt >= previousAt ? occurredAt - previousAt : undefined;
    previousAt = occurredAt;
    const original = originalTurns.get(step.provenance.sourceTurnIds[0]) as { preNormalizationText?: string; appliedSpeechCorrectionIds?: string[] } | undefined;
    // Existing current-LQU corrections remain ordered actions. Historical applied
    // speech-rule IDs cannot be installed in a new run or silently reapplied.
    const gap = !themOnly && original?.appliedSpeechCorrectionIds?.length ? "historical-normalized-speech-rule-needs-review" : undefined;
    const evidenceGaps = [...step.evidenceGaps, ...(gap ? [gap] : [])];
    return { ...step, id: `step-${index + 1}`, ordinal: index + 1,
      occurredAt, delayAfterPreviousMs, originalStepId: step.id, originalOrdinal: step.ordinal,
      originalInputText: original?.preNormalizationText,
      evidenceGaps, reviewStatus: evidenceGaps.length ? "needs-review" : step.reviewStatus,
    };
  });
  const warnings = input.recordingIntegrityStatus === "complete" ? [] : ["original-recording-integrity-incomplete"];
  if (themOnly) warnings.push("prior-me-actions-and-expectations-excluded");
  if (steps.some(step => step.occurredAt === undefined)) warnings.push("source-timestamps-unavailable-order-only");
  if (steps.some(step => step.kind === "me-text" && step.input.durationMs === undefined)) warnings.push("me-duration-equivalence-unavailable");
  warnings.push("accepted-transcript-replay-does-not-reconstruct-audio-or-stt-fragments");
  const evidenceGaps = [...new Set([
    ...steps.flatMap(step => step.evidenceGaps),
    ...(orderBasis === "unavailable" ? ["historical-input-order-unavailable"] : []),
    ...(!steps.length ? ["procedure-has-no-input-steps"] : []),
  ])];
  const { scriptedValidation: _scripted, forcedScripted, ...source } = base.source;
  return { ...base, id: `${base.id}:historical:${input.selection}`, schemaVersion: 2, source: { ...source,
    originalScriptedValidation: input.originalScriptedValidation, originalForcedScripted: forcedScripted,
    originalDirectory: input.originalDirectory, inputSelection: input.selection, orderBasis,
    timestampBasis: "runtime-recorded-event-time", warnings,
  }, steps, evidenceGaps,
    reviewStatus: evidenceGaps.length ? "needs-review" : steps.some(step => step.reviewStatus === "needs-human-labels") ? "needs-human-labels" : "ready",
  };
}

export function renderHistoricalTranscript(procedure: HistoricalSessionProcedureV2) {
  const lines = ["# Recovered Session Procedure", "", `Source: ${procedure.source.originalDirectory}`,
    `Source identity: ${procedure.source.originalScriptedValidation ? "scripted" : "organic"}. New replay runs are forced-scripted.`,
    `Selection: ${procedure.source.inputSelection}. Order: ${procedure.source.orderBasis}.`,
    "Time basis: recorded runtime events; physical speech-stop/word alignment is not certified.",
    "This is a reading view of the Procedure, not a second executable input list.", "",
    ...procedure.source.warnings.map(warning => `- ${warning}`), "",
  ];
  for (const step of procedure.steps) {
    lines.push(`## ${step.ordinal}. ${step.kind}`, "",
      `Recorded time: ${step.occurredAt === undefined ? "unavailable (order only)" : new Date(step.occurredAt).toISOString()}`,
      `Source event: ${step.provenance.timelineEventId}`, "");
    if (step.input.text || step.input.correctionText) lines.push(step.input.text ?? step.input.correctionText!, "");
    if (step.originalInputText) lines.push("Recorded pre-normalization text:", "", step.originalInputText, "");
    if (step.kind === "screen-input") lines.push(`Image: ${step.input.screen?.image.path ?? "unavailable"}`, "");
    if (step.evidenceGaps.length) lines.push(`Evidence gaps: ${step.evidenceGaps.join(", ")}`, "");
  }
  return lines.join("\n");
}
