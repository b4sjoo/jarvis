import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector";
import { performance } from "node:perf_hooks";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as logicalQuestion from "../src/lib/meeting/logical-question-unit.js";
import * as termCorrection from "../src/lib/meeting/term-correction-projection.js";
import * as projection from "../src/lib/meeting/logical-question-effective-projection.js";
import { applyActiveQuestionTermCorrection } from "../src/lib/meeting/active-question-term-correction.js";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import { EffectiveQuestionSourceLedger } from "../src/lib/meeting/effective-question-source-ledger.js";
import { compileSettledAdvisorPromptContext } from "../src/lib/meeting/settled-advisor-context.js";
import { buildAdvisorUserMessage } from "../src/lib/meeting/advisor-prompt.js";
import { createEffectiveAdvisorBaseBuilder } from "./helpers/advisor-base-context-hook.js";
import type { TranscriptTurn } from "../src/lib/meeting/types.js";

// Opt-in only: load the fixed pre-batch projector without keeping a second implementation.
function loadProjector(source: string): typeof projection {
  const environment = vm.createContext({
    exports: {},
    require: (id: string) => {
      if (id === "./logical-question-unit.js") return logicalQuestion;
      if (id === "./term-correction-projection.js") return termCorrection;
      throw new Error(`Unexpected baseline dependency: ${id}`);
    },
  });
  new vm.Script(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText).runInContext(environment);
  return environment.exports;
}

function paired(before: () => unknown, after: () => unknown) {
  for (let i = 0; i < 150; i += 1) { before(); after(); }
  const oldTimes: number[] = [];
  const newTimes: number[] = [];
  const measure = (run: () => unknown, times: number[]) => {
    const start = performance.now();
    run();
    times.push(performance.now() - start);
  };
  for (let i = 0; i < 600; i += 1) {
    if (i % 2) { measure(after, newTimes); measure(before, oldTimes); }
    else { measure(before, oldTimes); measure(after, newTimes); }
  }
  const summarize = (values: number[]) => {
    values.sort((a, b) => a - b);
    return { medianMs: values[Math.floor(values.length / 2)], p95Ms: values[Math.floor(values.length * 0.95)] };
  };
  return { before: summarize(oldTimes), after: summarize(newTimes) };
}

async function sampledAllocations(run: () => unknown) {
  const session = new Session();
  session.connect();
  const post = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
    session.post(method, params, (error, result) => error ? reject(error) : resolve(result));
  });
  try {
    await post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    for (let i = 0; i < 400; i += 1) run();
    const result = await post("HeapProfiler.stopSampling");
    const bytes = result.profile.samples.reduce((sum: number, sample: { size: number }) => sum + sample.size, 0);
    return Math.round(bytes / 400);
  } finally {
    session.disconnect();
  }
}

test("C6 opt-in paired effective-context CPU, sampled allocations and final Prompt equivalence", {
  skip: process.env.TASK189_CONTEXT_PERF !== "1",
}, async (t) => {
  const baseline = loadProjector(execFileSync("git", ["show", "33eac61:src/lib/meeting/logical-question-effective-projection.ts"], { encoding: "utf8" }));
  const candidate = loadProjector(readFileSync("src/lib/meeting/logical-question-effective-projection.ts", "utf8"));
  const manager = new MeetingContextManager({ transcriptWindowMs: 600_000 });
  const sessionId = manager.getState().sessionId;
  const turns: TranscriptTurn[] = Array.from({ length: 32 }, (_, index) => ({
    id: `turn-${index}`, text: `Design a car-sharing service ${index}. ${"Preserve tenant isolation and document provenance. ".repeat(8)}`,
    speaker: "them", source: "system-audio", isFinal: true, startedAt: index * 1_000, endedAt: index * 1_000 + 100,
  }));
  turns.forEach((turn) => manager.addTranscriptTurn(turn));
  const units = turns.map((turn) => applyActiveQuestionTermCorrection({
    logicalQuestionUnit: logicalQuestion.composeLogicalQuestionUnit({ currentTurn: turn, sessionId, runtimeEpoch: 1, now: turn.endedAt }),
    correction: { id: `correction-${turn.id}`, input: "RAG not car-sharing", term: "RAG", from: "car-sharing", to: "RAG", createdAt: turn.endedAt + 1, appliedCount: 0 },
    correctionTraceId: "correction-trace", manualCorrectionRevision: 1, now: turn.endedAt + 1,
  }).logicalQuestionUnit);
  const effectiveRecords: projection.EffectiveLogicalQuestionModelRecord[] = units.map((unit) => {
    const effective = projection.projectEffectiveLogicalQuestionSources(unit);
    return { sessionId, runtimeEpoch: 1, logicalQuestionUnitId: unit.id, logicalQuestionRevision: unit.revision,
      sourceTurnIds: unit.sourceTurnIds, text: effective.effectiveText, correctionIds: effective.correctionIds,
      effectiveSourceTexts: effective.effectiveSourceTexts, updatedAt: unit.updatedAt };
  });
  const input = { sources: turns.map((turn) => ({ turnId: turn.id, text: turn.text })), effectiveRecords, logicalQuestionUnit: units.at(-1)!, sessionId, runtimeEpoch: 1 };
  for (const count of [1, 8, 32]) {
    const selected = { ...input, sources: input.sources.slice(0, count) };
    const before = () => baseline.projectEffectiveSourceTurnGroup(selected);
    const after = () => candidate.projectEffectiveSourceTurnGroup(selected);
    assert.equal(JSON.stringify(after()), JSON.stringify(before()));
    t.diagnostic(JSON.stringify({ surface: "group", sources: count, ledgerRecords: effectiveRecords.length, ...paired(before, after),
      sampledAllocatedBytesPerOperation: { before: await sampledAllocations(before), after: await sampledAllocations(after) },
      ledgerSelections: { before: count, after: 1 }, currentLquProjections: { before: count, after: 1 } }));
  }
  const logicalQuestionUnit = { ...input.logicalQuestionUnit, contextSourceTurnIds: turns.map((turn) => turn.id) };
  const ledger = new EffectiveQuestionSourceLedger();
  effectiveRecords.forEach((record, index) => ledger.upsert({
    ...record, recordId: `record-${index}`, sourceHash: `hash-${index}`,
    sourceKind: "voice", currentTurnId: turns[index].id,
    contextSourceTurnIds: [], recentLogicalQuestionSourceTurnIds: [],
    answerFocusText: record.text, startedAt: turns[index].startedAt,
    settledAt: record.updatedAt, speechAct: "question", disposition: "answer-primary-ask",
    relation: "followup-parent", owner: { kind: "parent-mainline", parentId: "parent" },
  }));
  const buildBase = createEffectiveAdvisorBaseBuilder(manager, ledger);
  const compile = (effectiveBase: boolean) => {
    const baseContext = effectiveBase
      ? buildBase(logicalQuestionUnit)
      : manager.buildAdvisorPromptContext();
    return buildAdvisorUserMessage(compileSettledAdvisorPromptContext({
      baseContext, contextReadScope: "current-only", logicalQuestionUnit, transcriptTurns: manager.getState().transcriptTurns,
      effectiveRecords: ledger.list(), sessionId, runtimeEpoch: 1,
    }).context);
  };
  const before = () => compile(false);
  const after = () => compile(true);
  assert.equal(after(), before());
  t.diagnostic(JSON.stringify({ surface: "base-Hook-plus-final-compiler-and-Prompt", turns: turns.length,
    promptChars: after().length, promptUtf8Bytes: Buffer.byteLength(after()), ...paired(before, after),
    sampledAllocatedBytesPerOperation: { before: await sampledAllocations(before), after: await sampledAllocations(after) },
    addedModels: 0, addedWaits: 0,
    limits: "V8 sampled allocation estimate; identical Prompt implies identical tokenization, no provider latency or publication success-rate measurement; includes Hook ledger snapshot, without an extra Hook getState clone" }));
});
