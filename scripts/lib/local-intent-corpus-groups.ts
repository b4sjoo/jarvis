import type {
  CorpusGroupEdge,
  CorpusReviewQueueItem,
  CorpusSplit,
  CorpusSplitAssignmentLock,
  CorpusSplitPlan,
  LocalIntentNormalizedExample,
} from "./local-intent-corpus-schema.js";
import { sha256, stableJson } from "./local-intent-corpus-utils.js";

const STATIC_SPLITS: CorpusSplit[] = [
  "train",
  "dev",
  "calibration",
  "sealed-test",
];

export const LOCAL_INTENT_SPLIT_ALGORITHM_VERSION = "grouped-sha256-v1";

export function buildCorpusGroupEdges(
  examples: LocalIntentNormalizedExample[]
): CorpusGroupEdge[] {
  const edges: CorpusGroupEdge[] = [];
  for (const example of examples) {
    edges.push(
      edge(example.exampleId, example.grouping.rootGroupId, "root"),
      edge(example.exampleId, example.grouping.sessionGroupId, "session"),
      edge(example.exampleId, example.grouping.interviewGroupId, "interview"),
      edge(
        example.exampleId,
        example.grouping.problemFamilyId,
        "problem-family"
      )
    );
    if (example.grouping.sttVariantGroupId) {
      edges.push(
        edge(
          example.exampleId,
          example.grouping.sttVariantGroupId,
          "stt-variant"
        )
      );
    }
  }
  return edges.sort(
    (left, right) =>
      left.exampleId.localeCompare(right.exampleId) ||
      left.groupId.localeCompare(right.groupId)
  );
}

export function assignGroupedCorpusSplits(input: {
  examples: LocalIntentNormalizedExample[];
  edges: CorpusGroupEdge[];
  seed: string;
  cutoff: string;
  previousLock?: CorpusSplitAssignmentLock;
}) {
  if (
    input.previousLock &&
    (input.previousLock.algorithmVersion !==
      LOCAL_INTENT_SPLIT_ALGORITHM_VERSION ||
      input.previousLock.seed !== input.seed ||
      input.previousLock.cutoff !== input.cutoff)
  ) {
    throw new Error(
      "Existing split lock algorithm/seed/cutoff does not match this build."
    );
  }
  const cutoffAt = Date.parse(input.cutoff);
  if (!Number.isFinite(cutoffAt)) throw new Error(`Invalid cutoff: ${input.cutoff}`);

  const unionFind = new UnionFind();
  for (const example of input.examples) unionFind.add(`example:${example.exampleId}`);
  for (const edge of input.edges) {
    if (edge.splitEffect !== "union") continue;
    const exampleVertex = `example:${edge.exampleId}`;
    const groupVertex = `group:${edge.groupId}`;
    unionFind.add(exampleVertex);
    unionFind.add(groupVertex);
    unionFind.union(exampleVertex, groupVertex);
  }

  const components = new Map<
    string,
    { exampleIds: string[]; groupIds: string[]; latestAt: number }
  >();
  const examplesById = new Map(
    input.examples.map((example) => [example.exampleId, example])
  );
  for (const example of input.examples) {
    const root = unionFind.find(`example:${example.exampleId}`);
    const current = components.get(root) ?? {
      exampleIds: [],
      groupIds: [],
      latestAt: 0,
    };
    current.exampleIds.push(example.exampleId);
    current.latestAt = Math.max(current.latestAt, example.createdAt);
    components.set(root, current);
  }
  for (const edge of input.edges) {
    if (edge.splitEffect !== "union") continue;
    const root = unionFind.find(`example:${edge.exampleId}`);
    const current = components.get(root);
    if (current) current.groupIds.push(edge.groupId);
  }

  const componentAssignments: Record<string, CorpusSplit> = {};
  const exampleAssignments: Record<string, CorpusSplit> = {};
  const groupAssignments: Record<string, CorpusSplit> = {
    ...(input.previousLock?.groupAssignments ?? {}),
  };
  const blockedComponents: string[] = [];
  const reviewQueue: CorpusReviewQueueItem[] = [];
  const componentRows = [...components.values()]
    .map((component) => ({
      ...component,
      exampleIds: [...new Set(component.exampleIds)].sort(),
      groupIds: [...new Set(component.groupIds)].sort(),
    }))
    .map((component) => ({
      ...component,
      componentId: sha256(component.groupIds.join("\0")),
    }))
    .sort((left, right) => left.componentId.localeCompare(right.componentId));

  for (const component of componentRows) {
    const locked = [
      ...new Set(
        component.groupIds
          .map((groupId) => groupAssignments[groupId])
          .filter((split): split is CorpusSplit => Boolean(split))
      ),
    ];
    if (locked.length > 1) {
      blockedComponents.push(component.componentId);
      reviewQueue.push({
        schemaVersion: 1,
        itemId: sha256(`locked-split-merge\0${component.componentId}`),
        exampleId: component.exampleIds[0] ?? component.componentId,
        reason: "locked-split-merge",
        priority: 0,
        candidateIds: [],
        status: "open",
      });
      continue;
    }
    const split =
      locked[0] ??
      (component.latestAt > cutoffAt
        ? "rolling-eval"
        : deterministicStaticSplit(input.seed, component.componentId));
    componentAssignments[component.componentId] = split;
    for (const exampleId of component.exampleIds) exampleAssignments[exampleId] = split;
    for (const groupId of component.groupIds) groupAssignments[groupId] = split;
  }

  const overlapViolations = findGroupOverlapViolations(
    input.edges,
    exampleAssignments
  );
  const splitCounts = emptySplitCounts();
  for (const split of Object.values(exampleAssignments)) splitCounts[split] += 1;

  const lockWithoutHash = {
    schemaVersion: 1 as const,
    algorithmVersion: LOCAL_INTENT_SPLIT_ALGORITHM_VERSION,
    seed: input.seed,
    cutoff: input.cutoff,
    groupAssignments: Object.fromEntries(
      Object.entries(groupAssignments).sort(([left], [right]) =>
        left.localeCompare(right)
      )
    ),
  };
  const lock: CorpusSplitAssignmentLock = {
    ...lockWithoutHash,
    assignmentHash: sha256(stableJson(lockWithoutHash)),
  };
  const planWithoutHash = {
    schemaVersion: 1 as const,
    seed: input.seed,
    cutoff: input.cutoff,
    componentAssignments,
    exampleAssignments,
    splitCounts,
    overlapViolations,
    blockedComponents,
  };
  const plan: CorpusSplitPlan = {
    ...planWithoutHash,
    planHash: sha256(stableJson(planWithoutHash)),
  };
  return { plan, lock, reviewQueue };
}

function edge(
  exampleId: string,
  groupId: string,
  kind: CorpusGroupEdge["kind"]
): CorpusGroupEdge {
  return {
    schemaVersion: 1,
    exampleId,
    groupId,
    kind,
    authority: "inherited",
    splitEffect: "union",
  };
}

function deterministicStaticSplit(seed: string, componentId: string): CorpusSplit {
  const digest = sha256(`${seed}\0${componentId}`);
  const hex = digest.slice("sha256:".length, "sha256:".length + 8);
  const bucket = Number.parseInt(hex, 16) / 0xffffffff;
  if (bucket < 0.65) return "train";
  if (bucket < 0.75) return "dev";
  if (bucket < 0.85) return "calibration";
  return "sealed-test";
}

function findGroupOverlapViolations(
  edges: CorpusGroupEdge[],
  exampleAssignments: Record<string, CorpusSplit>
) {
  const splitsByGroup = new Map<string, Set<CorpusSplit>>();
  for (const edge of edges) {
    if (edge.splitEffect !== "union") continue;
    const split = exampleAssignments[edge.exampleId];
    if (!split) continue;
    const splits = splitsByGroup.get(edge.groupId) ?? new Set<CorpusSplit>();
    splits.add(split);
    splitsByGroup.set(edge.groupId, splits);
  }
  return [...splitsByGroup.entries()]
    .filter(([, splits]) => splits.size > 1)
    .map(([groupId]) => groupId)
    .sort();
}

function emptySplitCounts(): Record<CorpusSplit, number> {
  return {
    train: 0,
    dev: 0,
    calibration: 0,
    "sealed-test": 0,
    "rolling-eval": 0,
  };
}

class UnionFind {
  private readonly parents = new Map<string, string>();

  add(value: string) {
    if (!this.parents.has(value)) this.parents.set(value, value);
  }

  find(value: string): string {
    const parent = this.parents.get(value);
    if (!parent) throw new Error(`Unknown union-find vertex: ${value}`);
    if (parent === value) return value;
    const root = this.find(parent);
    this.parents.set(value, root);
    return root;
  }

  union(left: string, right: string) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    if (leftRoot < rightRoot) this.parents.set(rightRoot, leftRoot);
    else this.parents.set(leftRoot, rightRoot);
  }
}

export function staticCorpusSplits() {
  return [...STATIC_SPLITS];
}
