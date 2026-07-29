import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  projectHumanEvaluationsForLegacyConsumers,
  type HumanEvaluationV2CompatibilityReport,
} from "../src/lib/meeting/human-evaluation-v2-consumers.js";
import type { HumanEvaluationProjectionV2 } from "../src/lib/meeting/human-ground-truth-v2.js";
import type { QuestionHumanEvaluation } from "../src/lib/meeting/types.js";

export async function loadSessionHumanEvaluationConsumerView(
  sessionDirectory: string
) {
  const [v1Payload, v2Payload] = await Promise.all([
    readOptionalJson<{ evaluations?: QuestionHumanEvaluation[] }>(
      path.join(
        sessionDirectory,
        "human-evaluation",
        "question-evaluations.json"
      ),
      { evaluations: [] }
    ),
    readOptionalJson<{ projections?: HumanEvaluationProjectionV2[] }>(
      path.join(
        sessionDirectory,
        "human-evaluation",
        "projections-v2.json"
      ),
      { projections: [] }
    ),
  ]);
  return {
    ...projectHumanEvaluationsForLegacyConsumers({
      evaluations: v1Payload.evaluations ?? [],
      projections: v2Payload.projections ?? [],
    }),
    projections: v2Payload.projections ?? [],
  };
}

export async function writeHumanEvaluationCompatibilityReport(
  sessionDirectory: string,
  report: HumanEvaluationV2CompatibilityReport
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
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8"
    ),
    writeFile(
      path.join(outputDirectory, "compatibility.md"),
      renderCompatibilityMarkdown(report),
      "utf8"
    ),
  ]);
}

function renderCompatibilityMarkdown(
  report: HumanEvaluationV2CompatibilityReport
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
    `- Derivation versions: ${report.derivationVersions.join(", ") || "-"}`,
    `- Interaction samples: ${report.interaction.measuredProjectionCount}`,
    `- Label duration P50/P90: ${formatMetric(report.interaction.durationP50Ms, "ms")} / ${formatMetric(report.interaction.durationP90Ms, "ms")}`,
    `- Label clicks P50/P90: ${formatMetric(report.interaction.clickCountP50)} / ${formatMetric(report.interaction.clickCountP90)}`,
    `- Expert audit expanded: ${report.interaction.expertAuditExpandedCount}`,
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

function isMissingFile(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
  );
}
