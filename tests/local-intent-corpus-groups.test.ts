import assert from "node:assert/strict";
import test from "node:test";
import {
  assignGroupedCorpusSplits,
  buildCorpusGroupEdges,
} from "../scripts/lib/local-intent-corpus-groups.js";
import type { LocalIntentNormalizedExample } from "../scripts/lib/local-intent-corpus-schema.js";

test("keeps every grouping dimension in one deterministic split", () => {
  const examples = [
    example("one", "root-a", "session-a", 100),
    example("two", "root-b", "session-a", 200),
    example("three", "root-c", "session-b", 300),
  ];
  const edges = buildCorpusGroupEdges(examples);
  const first = assignGroupedCorpusSplits({
    examples,
    edges,
    seed: "seed-v1",
    cutoff: "2026-08-08T00:00:00.000Z",
  });
  const second = assignGroupedCorpusSplits({
    examples: [...examples].reverse(),
    edges: [...edges].reverse(),
    seed: "seed-v1",
    cutoff: "2026-08-08T00:00:00.000Z",
  });

  assert.deepEqual(first.plan, second.plan);
  assert.equal(
    first.plan.exampleAssignments.one,
    first.plan.exampleAssignments.two
  );
  assert.deepEqual(first.plan.overlapViolations, []);
});

test("preserves existing assignments and fails closed on a locked merge", () => {
  const examples = [
    example("one", "root-a", "session-a", 100),
    example("two", "root-b", "session-a", 200),
  ];
  const edges = buildCorpusGroupEdges(examples);
  const result = assignGroupedCorpusSplits({
    examples,
    edges,
    seed: "seed-v1",
    cutoff: "2026-08-08T00:00:00.000Z",
    previousLock: {
      schemaVersion: 1,
      algorithmVersion: "grouped-sha256-v1",
      seed: "seed-v1",
      cutoff: "2026-08-08T00:00:00.000Z",
      groupAssignments: {
        "root-a": "train",
        "root-b": "sealed-test",
      },
      assignmentHash: "ignored-by-reader",
    },
  });

  assert.equal(result.plan.blockedComponents.length, 1);
  assert.ok(
    result.reviewQueue.some((item) => item.reason === "locked-split-merge")
  );
});

test("places post-cutoff connected components in rolling eval", () => {
  const createdAt = Date.parse("2026-08-09T00:00:00.000Z");
  const examples = [example("one", "root-a", "session-a", createdAt)];
  const result = assignGroupedCorpusSplits({
    examples,
    edges: buildCorpusGroupEdges(examples),
    seed: "seed-v1",
    cutoff: "2026-08-08T00:00:00.000Z",
  });
  assert.equal(result.plan.exampleAssignments.one, "rolling-eval");
});

test("distributes independent components across every static split", () => {
  const examples = Array.from({ length: 400 }, (_, index) =>
    example(
      `example-${index}`,
      `root-${index}`,
      `session-${index}`,
      100 + index
    )
  );
  const result = assignGroupedCorpusSplits({
    examples,
    edges: buildCorpusGroupEdges(examples),
    seed: "distribution-seed",
    cutoff: "2026-08-08T00:00:00.000Z",
  });
  assert.ok(result.plan.splitCounts.train > 200);
  assert.ok(result.plan.splitCounts.dev > 10);
  assert.ok(result.plan.splitCounts.calibration > 10);
  assert.ok(result.plan.splitCounts["sealed-test"] > 20);
});

test("rejects split locks created by a different assignment algorithm", () => {
  const examples = [example("one", "root-a", "session-a", 100)];
  assert.throws(
    () =>
      assignGroupedCorpusSplits({
        examples,
        edges: buildCorpusGroupEdges(examples),
        seed: "seed-v1",
        cutoff: "2026-08-08T00:00:00.000Z",
        previousLock: {
          schemaVersion: 1,
          algorithmVersion: "obsolete-algorithm",
          seed: "seed-v1",
          cutoff: "2026-08-08T00:00:00.000Z",
          groupAssignments: {},
          assignmentHash: "obsolete",
        },
      }),
    /algorithm\/seed\/cutoff/
  );
});

function example(
  exampleId: string,
  rootGroupId: string,
  sessionGroupId: string,
  createdAt: number
): LocalIntentNormalizedExample {
  return {
    schemaVersion: 1,
    exampleId,
    sourceUnitId: `unit-${exampleId}`,
    unitKind: "utterance",
    sourceKind: "session-recording",
    sourceText: "private source",
    semanticText: "private source",
    language: "en",
    modality: "voice",
    createdAt,
    provenance: {
      sessionIdHash: sessionGroupId,
      orderedSourceTurnIdHashes: [],
      sourceObservationIdHashes: [],
      sourceTraceIdHashes: [],
      sourceRefs: [],
      materialization: "single-turn-exact",
    },
    grouping: {
      rootGroupId,
      sessionGroupId,
      interviewGroupId: sessionGroupId,
      problemFamilyId: rootGroupId,
    },
    eligibility: "train-candidate",
  };
}
