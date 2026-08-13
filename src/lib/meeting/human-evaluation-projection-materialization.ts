export const HUMAN_EVALUATION_PROJECTION_MATERIALIZATION_SCHEMA_VERSION =
  1 as const;

export interface HumanEvaluationProjectionMaterializationStatsV2 {
  schemaVersion: typeof HUMAN_EVALUATION_PROJECTION_MATERIALIZATION_SCHEMA_VERSION;
  groundTruthEventCount: number;
  projectionAttemptCount: number;
  projectionDeltaCount: number;
  duplicateSuppressionCount: number;
  uniqueProjectionCount: number;
  supersededProjectionCount: number;
}

export interface HumanEvaluationProjectionMaterializationDiagnosticsV2
  extends HumanEvaluationProjectionMaterializationStatsV2 {
  rawProjectionHistoryCount: number;
  duplicateProjectionHistoryCount: number;
}

export type HumanEvaluationProjectionMaterializationRecordV2<T> = T & {
  projectionId: string;
  materializationRevision?: string;
};

export function buildHumanEvaluationProjectionMaterializationRevisionV2<
  T extends { projectionId: string },
>(projection: T) {
  const record = projection as unknown as Record<string, unknown>;
  const {
    computedAt: _computedAt,
    inputTraceHashes: _inputTraceHashes,
    observed,
    materializationRevision: _materializationRevision,
    ...stableProjection
  } = record;
  const { traceHash: _traceHash, ...observedFacts } = isRecord(observed)
    ? observed
    : {};
  return `human-evaluation-projection-v2:${fingerprint(
    stableStringify({
      ...stableProjection,
      observed: isRecord(observed) ? observedFacts : undefined,
    })
  )}`;
}

export function canRefreshHumanEvaluationProjectionFromTraceV2(
  projection: { observed?: { traceId: string } },
  traceId: string
) {
  return projection.observed?.traceId === traceId;
}

export function summarizeHumanEvaluationProjectionMaterializationV2<
  T extends { projectionId: string; materializationRevision?: string },
>(input: {
  currentProjections: T[];
  history: T[];
  groundTruthEventCount: number;
  recorded?: HumanEvaluationProjectionMaterializationStatsV2;
}): HumanEvaluationProjectionMaterializationDiagnosticsV2 {
  const revisionsByProjection = new Map<string, Set<string>>();
  for (const projection of input.history) {
    const revisions =
      revisionsByProjection.get(projection.projectionId) ?? new Set<string>();
    revisions.add(
      projection.materializationRevision ??
        buildHumanEvaluationProjectionMaterializationRevisionV2(projection)
    );
    revisionsByProjection.set(projection.projectionId, revisions);
  }
  const materializedRevisionCount = Array.from(
    revisionsByProjection.values()
  ).reduce((total, revisions) => total + revisions.size, 0);
  const fallbackUniqueProjectionCount = new Set(
    (input.currentProjections.length
      ? input.currentProjections
      : input.history
    ).map((projection) => projection.projectionId)
  ).size;

  return {
    schemaVersion:
      HUMAN_EVALUATION_PROJECTION_MATERIALIZATION_SCHEMA_VERSION,
    groundTruthEventCount:
      input.recorded?.groundTruthEventCount ?? input.groundTruthEventCount,
    projectionAttemptCount:
      input.recorded?.projectionAttemptCount ?? input.history.length,
    projectionDeltaCount:
      input.recorded?.projectionDeltaCount ?? materializedRevisionCount,
    duplicateSuppressionCount:
      input.recorded?.duplicateSuppressionCount ?? 0,
    uniqueProjectionCount:
      input.recorded?.uniqueProjectionCount ?? fallbackUniqueProjectionCount,
    supersededProjectionCount:
      input.recorded?.supersededProjectionCount ??
      Math.max(0, materializedRevisionCount - fallbackUniqueProjectionCount),
    rawProjectionHistoryCount: input.history.length,
    duplicateProjectionHistoryCount: Math.max(
      0,
      input.history.length - materializedRevisionCount
    ),
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify(value[key])}`
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function fingerprint(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length}:${(hash >>> 0).toString(16)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
