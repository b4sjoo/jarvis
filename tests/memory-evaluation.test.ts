import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMemoryEvaluationTraceMetadata,
  resolveTraceMemoryEvaluationSnapshot,
} from "../src/lib/meeting/memory-evaluation.js";
import type { MeetingTrace } from "../src/lib/meeting/types.js";
import type { MemoryRetrievalResult } from "../src/lib/memory/types.js";

test("resolves the compact memory snapshot stored on the evaluated trace", () => {
  const metadata = buildMemoryEvaluationTraceMetadata({
    entries: [
      {
        entry: { id: "mem_1", title: "Agentic Memory facts" },
        score: 42,
        matchReason: ["project:fact-anchor"],
      },
    ],
  } as MemoryRetrievalResult);
  const trace = makeTrace("trace_1", metadata);

  assert.deepEqual(resolveTraceMemoryEvaluationSnapshot(trace), {
    status: "available",
    snapshot: {
      traceId: "trace_1",
      status: "available",
      entries: [
        {
          id: "mem_1",
          title: "Agentic Memory facts",
          score: 42,
          matchReason: ["project:fact-anchor"],
        },
      ],
    },
  });
});

test("keeps each trace bound to its own retrieval snapshot", () => {
  const first = makeTrace("trace_1", {
    memoryEvaluationSnapshot: {
      version: 1,
      entries: [
        { id: "mem_old", title: "Old retrieval", score: 9, matchReason: [] },
      ],
    },
  });
  const newer = makeTrace("trace_2", {
    memoryEvaluationSnapshot: {
      version: 1,
      entries: [
        { id: "mem_new", title: "New retrieval", score: 11, matchReason: [] },
      ],
    },
  });

  assert.equal(
    resolveTraceMemoryEvaluationSnapshot(first).snapshot?.entries[0].id,
    "mem_old"
  );
  assert.equal(
    resolveTraceMemoryEvaluationSnapshot(newer).snapshot?.entries[0].id,
    "mem_new"
  );
});

test("distinguishes an empty trace snapshot from unavailable legacy evidence", () => {
  const empty = makeTrace("trace_empty", {
    memoryEvaluationSnapshot: { version: 1, entries: [] },
  });
  const unavailable = makeTrace("trace_legacy");

  assert.deepEqual(resolveTraceMemoryEvaluationSnapshot(empty), {
    status: "empty",
    snapshot: {
      traceId: "trace_empty",
      status: "empty",
      entries: [],
    },
  });
  assert.deepEqual(resolveTraceMemoryEvaluationSnapshot(unavailable), {
    status: "unavailable",
  });
});

function makeTrace(
  id: string,
  memoryMetadata?: Record<string, unknown>
): MeetingTrace {
  return {
    id,
    kind: "screen",
    status: "success",
    startedAt: 1,
    steps: [],
    inputs: [],
    outputs: memoryMetadata
      ? [
          {
            label: "injected memory context",
            value: "trace-safe summary",
            metadata: memoryMetadata,
            recordedAt: 2,
          },
        ]
      : [],
  };
}
