import { invoke } from "@tauri-apps/api/core";
import { getDatabase } from "../database/config.js";
import { STORAGE_KEYS } from "../../config/constants.js";
import { safeLocalStorage } from "../storage/helper.js";
import { fromHumanEvalQuestionType } from "./task-taxonomy.js";
import {
  createHumanGroundTruthEventV2,
  deriveHumanEvaluationProjectionV2,
  importLegacyQuestionEvaluationV2,
  type HumanEvaluationObservedSnapshotV2,
  type HumanEvaluationProjectionV2,
  type HumanGroundTruthEventV2,
  type HumanGroundTruthFactV2,
} from "./human-ground-truth-v2.js";
import type { QuestionHumanEvaluation, TraceHumanEvaluation } from "./types.js";

export interface StoredHumanEvaluationSession {
  events: HumanGroundTruthEventV2[];
  projections: HumanEvaluationProjectionV2[];
}

export interface HumanEvaluationImport {
  sourceId: string;
  events: HumanGroundTruthEventV2[];
  projections: HumanEvaluationProjectionV2[];
  report: Record<string, unknown>;
}

const IMPORT_SOURCE = "local-storage-human-evaluation-v2-retirement-1";

// Only the importer reads legacy storage. It never edits or deletes the source.
export function buildHumanEvaluationImport(read: (key: string) => string | null | undefined): HumanEvaluationImport {
  const array = (key: string): unknown[] => {
    const raw = read(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error(`Invalid evaluation import array: ${key}`);
    return parsed;
  };
  const rawEvents = array(STORAGE_KEYS.MEETING_HUMAN_GROUND_TRUTH_EVENTS_V2);
  const rawProjections = array(STORAGE_KEYS.MEETING_HUMAN_EVALUATION_PROJECTIONS_V2);
  const rawQuestions = array(STORAGE_KEYS.MEETING_QUESTION_HUMAN_EVALUATIONS);
  const rawTraces = array(STORAGE_KEYS.MEETING_TRACE_HUMAN_EVALUATIONS);
  const events = rawEvents.filter((item): item is HumanGroundTruthEventV2 => {
    const value = item as HumanGroundTruthEventV2 | null;
    return Boolean(value?.schemaVersion === 2 && value.eventId && value.sessionId && value.fact?.kind
      && value.provenance && value.subject && Array.isArray(value.subject.traceIds));
  });
  const retainedV2Events = events.length;
  const projections = rawProjections.filter((item): item is HumanEvaluationProjectionV2 => {
    const value = item as HumanEvaluationProjectionV2 | null;
    return Boolean(value?.projectionId && value.sessionId && value.subject && value.schemaVersion === 2);
  });
  let skippedQuestions = 0;
  let importedLegacyFacts = 0;
  let skippedTraces = 0;
  for (const item of rawQuestions) {
    const question = item as QuestionHumanEvaluation | null;
    if (!question?.id || !question.sessionId || !question.questionId
      || !Array.isArray(question.traceIds) || !question.traceIds.length
      || !Number.isFinite(question.updatedAt) || !question.answer) {
      skippedQuestions++;
      continue;
    }
    const imported = importLegacyQuestionEvaluationV2(question, question.sessionId);
    const extra: HumanGroundTruthFactV2[] = [];
    for (const label of question.memoryEntryLabels ?? []) {
      if (label.memoryId) extra.push({ kind: "memory-label", memoryIds: [label.memoryId], verdict: label.label });
    }
    for (const missing of question.missingExpectedMemory ?? []) {
      if (missing.id) extra.push({ kind: "memory-label", memoryIds: [missing.id], verdict: "missing" });
    }
    if (["ok", "partial", "wrong", "missing"].includes(question.whiteboard?.verdict)) {
      extra.push({ kind: "artifact-quality", artifact: "whiteboard", verdict: question.whiteboard.verdict === "ok" ? "useful" : question.whiteboard.verdict as "partial" | "wrong" | "missing" });
    }
    extra.forEach((fact, index) => imported.push(createHumanGroundTruthEventV2({
      eventId: `legacy:${question.id}:specialist:${index}`,
      sessionId: question.sessionId!, subject: { questionId: question.questionId, taskId: question.taskId, traceIds: question.traceIds, sourceTurnIds: [] },
      fact, source: "imported-legacy", collection: "replay", confirmation: "confirmed",
      sourceTraceId: question.traceIds[0], now: question.updatedAt,
    })));
    // Existing explicit V2 facts keep their own provenance and higher priority.
    events.push(...imported);
    importedLegacyFacts += imported.length;
  }
  for (const item of rawTraces) {
    const trace = item as TraceHumanEvaluation | null;
    const owners = rawQuestions.filter((item): item is QuestionHumanEvaluation => {
      const q = item as QuestionHumanEvaluation | null;
      return Boolean(q?.sessionId && q.questionId && Array.isArray(q.traceIds) && q.traceIds.includes(trace?.traceId ?? ""));
    });
    if (!trace?.id || !trace.traceId || !Number.isFinite(trace.updatedAt) || owners.length !== 1) { skippedTraces++; continue; }
    const q = owners[0]!;
    const facts: HumanGroundTruthFactV2[] = [];
    if (trace.taskQuality) facts.push({ kind: "answer-quality", outcome: trace.taskQuality === "success" ? "useful" : trace.taskQuality === "partial" ? "partial" : "wrong", failureReasons: trace.failureReasons ?? [], expectedContextTurnIds: [] });
    if (trace.advisorGateShouldAdvise === true) facts.push({ kind: "expected-runtime-action", expectedAction: "advise" });
    // A "correctly skipped" boolean cannot distinguish append-context/buffer/ignore.
    const correctedType = trace.correctedQuestionType ? fromHumanEvalQuestionType(trace.correctedQuestionType) : undefined;
    if (correctedType) facts.push({ kind: "expected-question-type", expectedQuestionType: correctedType });
    if (trace.correctedCompany?.trim()) facts.push({ kind: "expected-meeting-metadata", expectedEffectiveCompany: trace.correctedCompany });
    for (const fact of facts) {
      events.push(createHumanGroundTruthEventV2({ eventId: `legacy-trace:${trace.id}:${fact.kind}`, sessionId: q.sessionId!,
        subject: { questionId: q.questionId, taskId: q.taskId, traceIds: q.traceIds, sourceTurnIds: [] },
        fact, source: "imported-legacy", collection: "replay", confirmation: "confirmed", sourceTraceId: trace.traceId, now: trace.updatedAt }));
      importedLegacyFacts++;
    }
  }
  return {
    sourceId: IMPORT_SOURCE, events, projections,
    report: {
      originalV2Events: rawEvents.length, retainedV2Events,
      invalidV2Events: rawEvents.length - retainedV2Events,
      originalProjections: rawProjections.length, retainedProjections: projections.length,
      originalQuestions: rawQuestions.length, skippedQuestions, importedLegacyFacts,
      originalTraces: rawTraces.length, skippedTraces,
      v1OnlyLabels: "not imported; original localStorage and recordings retained",
    },
  };
}

interface EvaluationBackend {
  initialize(): Promise<void>;
  invoke<T>(command: string, args: Record<string, unknown>): Promise<T>;
  readLegacy(key: string): string | null | undefined;
}

export function createHumanEvaluationStore(backend: EvaluationBackend) {
  let ready: Promise<void> | undefined;
  let writes: Promise<unknown> = Promise.resolve();
  const initialize = () => {
    if (!ready) ready = (async () => {
      await backend.initialize();
      const receipt = await backend.invoke("evaluation_store_import_status", { sourceId: IMPORT_SOURCE });
      if (!receipt) {
        const input = buildHumanEvaluationImport(backend.readLegacy);
        await backend.invoke("evaluation_store_import", { input });
      }
    })().catch(error => { ready = undefined; throw error; });
    return ready;
  };
  const readSession = async (sessionId: string) => {
    await initialize();
    return backend.invoke<StoredHumanEvaluationSession>("evaluation_store_read", { sessionId });
  };
  const enqueue = <T>(write: () => Promise<T>) => {
    const result = writes.then(write);
    writes = result.catch(() => undefined);
    return result;
  };
  return {
    initialize, readSession,
    commit(event: HumanGroundTruthEventV2, observed?: HumanEvaluationObservedSnapshotV2) {
      const frozen = structuredClone({ event, observed });
      return enqueue(async () => {
        const stored = await readSession(frozen.event.sessionId);
        // SQL owns conflict/idempotency checks; do not silently drop a conflicting action here.
        const events = [...stored.events.filter(event => event.eventId !== frozen.event.eventId), frozen.event];
        const projection = deriveHumanEvaluationProjectionV2({
          sessionId: frozen.event.sessionId, subject: frozen.event.subject, events, observed: frozen.observed,
        });
        return backend.invoke<{ event: HumanGroundTruthEventV2; projection: HumanEvaluationProjectionV2 }>("evaluation_store_append", { input: { event: frozen.event, projection } });
      });
    },
    saveObservation(projection: HumanEvaluationProjectionV2) {
      const frozen = structuredClone(projection);
      return enqueue(async () => {
        const stored = await readSession(frozen.sessionId);
        const derived = deriveHumanEvaluationProjectionV2({
          sessionId: frozen.sessionId, subject: frozen.subject, events: stored.events, observed: frozen.observed,
        });
        return backend.invoke<HumanEvaluationProjectionV2>("evaluation_store_project", { projection: derived });
      });
    },
  };
}

export const humanEvaluationStore = createHumanEvaluationStore({
  initialize: async () => { await getDatabase(); },
  invoke,
  readLegacy: key => safeLocalStorage.getItem(key),
});
