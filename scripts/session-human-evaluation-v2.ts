import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  partitionHumanEvaluationProjectionsForPrecisionV2,
  projectHumanEvaluationsForLegacyConsumers,
  type HumanEvaluationV2CompatibilityReport,
} from "../src/lib/meeting/human-evaluation-v2-consumers.js";
import {
  summarizeHumanEvaluationProjectionMaterializationV2,
  type HumanEvaluationProjectionMaterializationDiagnosticsV2,
  type HumanEvaluationProjectionMaterializationRecordV2,
  type HumanEvaluationProjectionMaterializationStatsV2,
} from "../src/lib/meeting/human-evaluation-projection-materialization.js";
import {
  deriveHumanEvaluationProjectionV2,
  projectHumanGroundTruthEventsForSessionPurposeV2,
  type HumanEvaluationProjectionV2,
  type HumanGroundTruthEventV2,
} from "../src/lib/meeting/human-ground-truth-v2.js";
import type { QuestionHumanEvaluation } from "../src/lib/meeting/types.js";
import { readEffectiveSessionEvaluationProvenance } from "./lib/session-evaluation-provenance.js";

export async function loadSessionHumanEvaluationConsumerView(
  sessionDirectory: string
) {
  const [
    v1Payload,
    v2Payload,
    projectionHistory,
    groundTruthEvents,
    evaluationProvenance,
  ] =
    await Promise.all([
      readOptionalJson<{ evaluations?: QuestionHumanEvaluation[] }>(
        path.join(
          sessionDirectory,
          "human-evaluation",
          "question-evaluations.json"
        ),
        { evaluations: [] }
      ),
      readOptionalJson<{
        projections?: HumanEvaluationProjectionV2[];
        materialization?: HumanEvaluationProjectionMaterializationStatsV2;
      }>(
        path.join(
          sessionDirectory,
          "human-evaluation",
          "projections-v2.json"
        ),
        { projections: [] }
      ),
      readOptionalJsonLines<
        HumanEvaluationProjectionMaterializationRecordV2<HumanEvaluationProjectionV2>
      >(
        path.join(
          sessionDirectory,
          "human-evaluation",
          "projections-v2.jsonl"
        )
      ),
      readOptionalJsonLines<HumanGroundTruthEventV2>(
        path.join(
          sessionDirectory,
          "human-evaluation",
          "ground-truth-v2.jsonl"
        )
      ),
      readEffectiveSessionEvaluationProvenance(sessionDirectory),
    ]);
  const recordedProjections = v2Payload.projections ?? [];
  const effectiveEvents =
    evaluationProvenance.source === "default"
      ? groundTruthEvents
      : projectHumanGroundTruthEventsForSessionPurposeV2(
          groundTruthEvents,
          evaluationProvenance.scriptedValidation
        );
  const projections = recordedProjections.map((projection) =>
    deriveHumanEvaluationProjectionV2({
      sessionId: projection.sessionId,
      subject: projection.subject,
      events: effectiveEvents,
      observed: projection.observed,
      now: projection.computedAt,
    })
  );
  const materialization =
    summarizeHumanEvaluationProjectionMaterializationV2({
      currentProjections: projections,
      history: projectionHistory,
      groundTruthEventCount: groundTruthEvents.length,
      recorded: v2Payload.materialization,
    });
  const precisionPartition =
    partitionHumanEvaluationProjectionsForPrecisionV2(
      projections
    );
  const consumerView = projectHumanEvaluationsForLegacyConsumers({
    evaluations: v1Payload.evaluations ?? [],
    projections: precisionPartition.eligible,
  });
  for (const projection of precisionPartition.excluded) {
    consumerView.report.warnings.push({
      code: "attempt-subject-missing",
      subjectId: projection.projectionId,
      detail:
        "Excluded from V2 precision evidence because the question projection has no stable attempt identity.",
    });
  }
  return {
    ...consumerView,
    legacyEvaluations: v1Payload.evaluations ?? [],
    projections: precisionPartition.eligible,
    materialization,
    evaluationProvenance,
  };
}

export async function writeHumanEvaluationCompatibilityReport(
  sessionDirectory: string,
  report: HumanEvaluationV2CompatibilityReport,
  materialization?: HumanEvaluationProjectionMaterializationDiagnosticsV2
) {
  const outputDirectory = path.join(
    sessionDirectory,
    "evaluation",
    "human-evaluation-v2"
  );
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(outputDirectory, "compatibility.json"),
      `${JSON.stringify({ ...report, materialization }, null, 2)}\n`,
      "utf8"
    ),
    writeFile(
      path.join(outputDirectory, "compatibility.md"),
      renderCompatibilityMarkdown(report, materialization),
      "utf8"
    ),
  ]);
}

function renderCompatibilityMarkdown(
  report: HumanEvaluationV2CompatibilityReport,
  materialization?: HumanEvaluationProjectionMaterializationDiagnosticsV2
) {
  const lines = [
    "# Human Evaluation V1/V2 Compatibility",
    "",
    `- V1 evaluations: ${report.v1EvaluationCount}`,
    `- V2 projections: ${report.v2ProjectionCount}`,
    `- Matched projections: ${report.matchedProjectionCount}`,
    `- V1-only evaluations: ${report.v1OnlyEvaluationCount}`,
    `- V2-only projections: ${report.v2OnlyProjectionCount}`,
    `- Conflict projections: ${report.conflictProjectionCount}`,
    `- Projections with trace hashes: ${report.projectionsWithTraceHashes}`,
    `- Semantic input events: ${report.semanticInputEventCount}`,
    `- Intervention-only events: ${report.interventionOnlyEventCount}`,
    `- Derivation versions: ${report.derivationVersions.join(", ") || "-"}`,
    `- Interaction samples: ${report.interaction.measuredProjectionCount}`,
    `- Label duration P50/P90: ${formatMetric(report.interaction.durationP50Ms, "ms")} / ${formatMetric(report.interaction.durationP90Ms, "ms")}`,
    `- Label clicks P50/P90: ${formatMetric(report.interaction.clickCountP50)} / ${formatMetric(report.interaction.clickCountP90)}`,
    `- Expert audit expanded: ${report.interaction.expertAuditExpandedCount}`,
    "",
    "## Projection Materialization",
    "",
    `- Raw ground-truth events: ${materialization?.groundTruthEventCount ?? "-"}`,
    `- Projection attempts: ${materialization?.projectionAttemptCount ?? "-"}`,
    `- Materialized deltas: ${materialization?.projectionDeltaCount ?? "-"}`,
    `- Unique projections: ${materialization?.uniqueProjectionCount ?? "-"}`,
    `- Superseded projections: ${materialization?.supersededProjectionCount ?? "-"}`,
    `- Runtime duplicate suppressions: ${materialization?.duplicateSuppressionCount ?? "-"}`,
    `- Raw projection history rows: ${materialization?.rawProjectionHistoryCount ?? "-"}`,
    `- Duplicate projection history rows: ${materialization?.duplicateProjectionHistoryCount ?? "-"}`,
    "",
    "## Dimension Parity",
    "",
    "| Dimension | V1 | V2 | Overlap | Agree | Disagree | V1 only | V2 only |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const [dimension, metric] of Object.entries(report.dimensions)) {
    lines.push(
      `| ${dimension} | ${metric.v1Labeled} | ${metric.v2Labeled} | ${metric.overlap} | ${metric.agreement} | ${metric.disagreement} | ${metric.v1Only} | ${metric.v2Only} |`
    );
  }
  lines.push("", "## Warnings", "");
  if (!report.warnings.length) {
    lines.push("- None.");
  } else {
    for (const warning of report.warnings) {
      lines.push(
        `- \`${warning.code}\` ${warning.subjectId}: ${warning.detail}`
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatMetric(value: number | undefined, suffix = "") {
  return value === undefined ? "-" : `${Math.round(value)}${suffix}`;
}

async function readOptionalJson<T>(filePath: string, fallback: T) {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (isMissingFile(error)) return fallback;
    throw error;
  }
}

async function readOptionalJsonLines<T>(filePath: string): Promise<T[]> {
  try {
    return (await readFile(filePath, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}

function isMissingFile(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
  );
}
