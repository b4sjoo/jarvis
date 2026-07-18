import type { MemoryRetrievalResult } from "../memory";
import type {
  MeetingTrace,
  MemoryEvaluationEntrySnapshot,
  MemoryRetrievalEvaluationSnapshot,
  MemoryRetrievalEvaluationSnapshotResolution,
} from "./types";

const MEMORY_OUTPUT_LABEL = "injected memory context";
const MEMORY_EVALUATION_SNAPSHOT_VERSION = 1;

export function buildMemoryEvaluationTraceMetadata(
  result: MemoryRetrievalResult
) {
  return {
    memoryEvaluationSnapshot: {
      version: MEMORY_EVALUATION_SNAPSHOT_VERSION,
      entries: result.entries.map((item) => ({
        id: item.entry.id,
        title: item.entry.title,
        score: item.score,
        matchReason: [...item.matchReason],
      })),
    },
  };
}

export function resolveTraceMemoryEvaluationSnapshot(
  trace: MeetingTrace | undefined
): MemoryRetrievalEvaluationSnapshotResolution {
  if (!trace) return { status: "unavailable" };

  const output = [...trace.outputs]
    .reverse()
    .find((item) => item.label === MEMORY_OUTPUT_LABEL);
  const snapshotValue = output?.metadata?.memoryEvaluationSnapshot;
  const entries = readSnapshotEntries(snapshotValue);
  if (entries) {
    const status = entries.length ? "available" : "empty";
    return {
      status,
      snapshot: {
        traceId: trace.id,
        status,
        entries,
      },
    };
  }

  if (trace.metadata?.memoryRetrievalEnabled === false) {
    return {
      status: "empty",
      snapshot: {
        traceId: trace.id,
        status: "empty",
        entries: [],
      },
    };
  }

  return { status: "unavailable" };
}

export function normalizeMemoryRetrievalEvaluationSnapshot(
  value: unknown
): MemoryRetrievalEvaluationSnapshot | undefined {
  if (!isRecord(value) || typeof value.traceId !== "string") {
    return undefined;
  }
  if (value.status !== "available" && value.status !== "empty") {
    return undefined;
  }
  if (!Array.isArray(value.entries)) return undefined;

  const entries = value.entries
    .map(normalizeMemoryEvaluationEntry)
    .filter(Boolean) as MemoryEvaluationEntrySnapshot[];
  const status = entries.length ? "available" : "empty";

  return {
    traceId: value.traceId,
    status,
    entries,
  };
}

function readSnapshotEntries(
  value: unknown
): MemoryEvaluationEntrySnapshot[] | undefined {
  if (
    !isRecord(value) ||
    value.version !== MEMORY_EVALUATION_SNAPSHOT_VERSION ||
    !Array.isArray(value.entries)
  ) {
    return undefined;
  }

  const entries = value.entries
    .map(normalizeMemoryEvaluationEntry)
    .filter(Boolean) as MemoryEvaluationEntrySnapshot[];
  return entries.length === value.entries.length ? entries : undefined;
}

function normalizeMemoryEvaluationEntry(
  value: unknown
): MemoryEvaluationEntrySnapshot | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.score !== "number" ||
    !Number.isFinite(value.score) ||
    !Array.isArray(value.matchReason)
  ) {
    return undefined;
  }

  return {
    id: value.id,
    title: value.title,
    score: value.score,
    matchReason: value.matchReason.filter(
      (reason): reason is string => typeof reason === "string"
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
