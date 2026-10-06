import assert from "node:assert/strict";
import test from "node:test";
import { buildHistoricalSessionProcedure, renderHistoricalTranscript } from "../scripts/lib/historical-session-procedure.js";
import { readRuntimeRegressionScenario, readRuntimeRegressionScenarioManifest } from "../src/lib/meeting/runtime-regression-scenario.js";

function source() {
  return { recordingSessionId: "old-organic", folderName: "old-folder", sourceDigest: "original-digest", scriptedValidation: true as const,
    originalScriptedValidation: false, originalDirectory: "/original", selection: "historical" as const, forcedScripted: false,
    recordingIntegrityStatus: "complete", generatedAt: 2000, manualActions: [], humanEvaluationProjections: [],
    transcriptTurns: [
      { id: "them", speaker: "them" as const, text: "Explain LUC.", source: "system-audio", startedAt: 100, endedAt: 200 },
      { id: "me", speaker: "me" as const, text: "Do you mean capacity?", source: "microphone", startedAt: 300, endedAt: 15300 },
    ], timelineEvents: [
      { id: "e1", kind: "transcript-turn", createdAt: 1000, metadata: { turnId: "them" } },
      { id: "e2", kind: "transcript-turn", createdAt: 1100, metadata: { turnId: "me" } },
      { id: "e3", kind: "active-question-term-correction", createdAt: 1200, metadata: { manualTermCorrectionId: "OLD_RULE", manualTermCorrectionSourceTerm: "luc", manualTermCorrectionNormalizedTerm: "LRU", manualTermCorrectionRawText: "LRU not LUC" } },
    ] };
}

test("HR187 preserves original organic identity, text and order while sharing the builder", () => {
  const input = source(), before = JSON.stringify(input);
  const result = buildHistoricalSessionProcedure(input);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.source.originalScriptedValidation, false);
  assert.equal(Object.hasOwn(result.source, "scriptedValidation"), false);
  assert.deepEqual(result.steps.map(step => step.kind), ["them-text", "me-text", "term-correction"]);
  assert.equal(result.steps[0].input.text, "Explain LUC.", "a later correction cannot rewrite the earlier input");
  assert.equal(result.steps[1].input.durationMs, 15000);
  assert.equal(result.steps[0].occurredAt, 1000, "common runtime event time, not the speaker's independent capture clock");
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(result, buildHistoricalSessionProcedure(input));
  assert.match(renderHistoricalTranscript(result), /Source identity: organic/);
});

test("HR187 missing time retains event order and never invents zero or physical speech-end truth", () => {
  const input = source();
  input.timelineEvents.forEach(event => { event.createdAt = undefined as any; });
  const result = buildHistoricalSessionProcedure(input);
  assert.deepEqual(result.steps.map(step => step.kind), ["them-text", "me-text", "term-correction"]);
  assert.ok(result.steps.every(step => step.occurredAt === undefined && step.delayAfterPreviousMs === undefined));
  assert.match(renderHistoricalTranscript(result), /unavailable \(order only\)/);
  assert.match(renderHistoricalTranscript(result), /physical speech-stop\/word alignment is not certified/);
});

test("HR187 accepted-text-only archives recover transcript file order without timeline timestamps", () => {
  const input = source(); input.timelineEvents = [];
  const result = buildHistoricalSessionProcedure(input);
  assert.equal(result.source.orderBasis, "accepted-transcript-order");
  assert.deepEqual(result.steps.map(step => step.input.text), input.transcriptTurns.map(turn => turn.text));
  assert.ok(result.steps.every(step => step.occurredAt === undefined));
});

test("HR187 Them-only selection excludes Me, actions and old Expected before compilation", () => {
  const result = buildHistoricalSessionProcedure({ ...source(), selection: "them-only" });
  assert.deepEqual(result.steps.map(step => step.kind), ["them-text"]);
  assert.equal(result.steps[0].expected, undefined);
  assert.deepEqual(result.steps[0].expectedEvidenceRefs, []);
  assert.ok(result.source.warnings.includes("prior-me-actions-and-expectations-excluded"));
  assert.equal(result.source.originalScriptedValidation, false);
});

test("HR187 retained unsealed inputs remain reviewable while source incompleteness stays explicit", () => {
  const result = buildHistoricalSessionProcedure({ ...source(), recordingIntegrityStatus: "incomplete" });
  assert.ok(result.source.warnings.includes("original-recording-integrity-incomplete"));
  assert.equal(result.source.recordingIntegrityStatus, "incomplete");
  const manifest = readRuntimeRegressionScenarioManifest({ schemaVersion: 1, id: "review", revision: 1,
    procedure: { path: "procedure.json", sha256: `sha256:${"a".repeat(64)}` }, assetRoot: ".",
    review: { status: "reviewed", purpose: "practice", reviewedBy: "explicit-review", preconditions: { useMemory: false } } });
  assert.equal(readRuntimeRegressionScenario(manifest, result).inputs.length, 3);
  assert.throws(() => readRuntimeRegressionScenario({ ...manifest, review: { ...manifest.review, purpose: "regression" } }, result), /Expected/);
});

test("HR187 applied speech-rule identity is not copied into a new run or silently applied twice", () => {
  const input = source();
  Object.assign(input.transcriptTurns[0], { text: "Explain LRU.", preNormalizationText: "Explain LUC.", appliedSpeechCorrectionIds: ["OLD_RULE"] });
  const result = buildHistoricalSessionProcedure(input);
  assert.equal(result.steps[0].originalInputText, "Explain LUC.");
  assert.ok(result.steps[0].evidenceGaps.includes("historical-normalized-speech-rule-needs-review"));
  assert.doesNotMatch(JSON.stringify(result.steps[0].input), /OLD_RULE/);
});
