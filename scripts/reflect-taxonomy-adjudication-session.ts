import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { readRecordedTraceSummaries } from "./lib/session-aggregate-evidence.js";
import {
  buildTaxonomyAdjudicationReflectionReport,
  renderTaxonomyAdjudicationReflectionMarkdown,
  type TaxonomyAdjudicationCompactTrace,
  type TaxonomyAdjudicationRecordedDecision,
} from "./lib/taxonomy-adjudication-reflection.js";
import {
  buildTaskRelationAdjudicationReflectionReport,
  renderTaskRelationAdjudicationReflectionMarkdown,
  type TaskRelationAdjudicationRecordedDecision,
} from "./lib/task-relation-adjudication-reflection.js";
import {
  buildTaskRelationAuthorityConvergenceReportV1,
  renderTaskRelationAuthorityConvergenceMarkdown,
} from "./lib/task-relation-authority-convergence.js";
import {
  renderQuestionTypeAdjudicationOutcomeMarkdown,
  type QuestionTypeAdjudicationRecordedDecision,
} from "./lib/question-type-adjudication-outcome.js";
import type { QuestionTypeAdjudicationOutcomeEvent } from "../src/lib/meeting/question-type-adjudication.js";
import {
  loadSessionHumanEvaluationConsumerView,
  writeHumanEvaluationCompatibilityReport,
} from "./session-human-evaluation-v2.js";
import { writeDerivedEvaluationProvenance } from "./lib/derived-evaluation-provenance.js";
import { readRuntimeTraceEvidence, missingAdjudicationEvidenceFiles } from "./lib/recorded-trace-evidence.js";

interface CliOptions {
  sessionDirectories: string[];
  outputDirectory?: string;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const summaries = [];
  for (const sessionDirectory of options.sessionDirectories) {
    const missingInputs = await missingAdjudicationEvidenceFiles(sessionDirectory);
    const manifest = await readOptionalJson<{ sessionId?: string }>(path.join(sessionDirectory, "manifest.json"), {});
    const traceDecisions = (await readRuntimeTraceEvidence(path.join(sessionDirectory, "traces"))).map(trace => ({ ...trace, recordedAt: trace.exportedAt ?? 0, sessionId: manifest.sessionId }));
    const intentDecisions =
      await readOptionalJsonLines<TaxonomyAdjudicationRecordedDecision>(
        path.join(sessionDirectory, "intent", "llm-adjudications.jsonl")
      );
    const decisions = intentDecisions.length
      ? intentDecisions
      : await readOptionalJsonLines<TaxonomyAdjudicationRecordedDecision>(
          path.join(sessionDirectory, "taxonomy", "llm-adjudications.jsonl")
        );
    const tracePayload = await readRecordedTraceSummaries<TaxonomyAdjudicationCompactTrace>(sessionDirectory);
    for (const warning of tracePayload.warnings) console.warn(warning);
    const evaluationView =
      await loadSessionHumanEvaluationConsumerView(sessionDirectory);
    const relationDecisions =
      await readOptionalJsonLines<TaskRelationAdjudicationRecordedDecision>(
        path.join(
          sessionDirectory,
          "runtime-inference",
          "task-relation-decisions.jsonl"
        )
      );
    const questionTypeDecisions =
      await readOptionalJsonLines<QuestionTypeAdjudicationRecordedDecision>(
        path.join(
          sessionDirectory,
          "taxonomy",
          "question-type-adjudications.jsonl"
        )
      );
    const questionTypeOutcomes =
      await readOptionalJsonLines<QuestionTypeAdjudicationOutcomeEvent>(
        path.join(
          sessionDirectory,
          "taxonomy",
          "question-type-adjudication-outcomes.jsonl"
        )
      );
    const report = buildTaxonomyAdjudicationReflectionReport({
      decisions,
      traces: tracePayload.traces ?? [],
      evaluations: evaluationView.legacyEvaluations,
      projections: evaluationView.projections,
      questionTypeDecisions,
      questionTypeOutcomes,
      settlements: [...relationDecisions, ...traceDecisions],
      missingInputs,
    });
    const relationReport =
      buildTaskRelationAdjudicationReflectionReport({
        decisions: relationDecisions,
        evaluations: evaluationView.legacyEvaluations,
        projections: evaluationView.projections,
        settlements: traceDecisions,
        missingInputs,
      });
    const relationConvergence =
      buildTaskRelationAuthorityConvergenceReportV1({
        relationReport,
      });
    const questionTypeOutcomeReport = report.currentType;
    const outputDirectory = options.outputDirectory
      ? options.sessionDirectories.length === 1
        ? options.outputDirectory
        : path.join(options.outputDirectory, path.basename(sessionDirectory))
      : path.join(sessionDirectory, "evaluation", "taxonomy-adjudication");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(
      path.join(outputDirectory, "reflection.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(outputDirectory, "reflection.md"),
      renderTaxonomyAdjudicationReflectionMarkdown(report),
      "utf8"
    );
    await writeFile(
      path.join(outputDirectory, "relation-reflection.json"),
      `${JSON.stringify(relationReport, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(outputDirectory, "relation-reflection.md"),
      renderTaskRelationAdjudicationReflectionMarkdown(relationReport),
      "utf8"
    );
    await writeFile(
      path.join(outputDirectory, "relation-convergence.json"),
      `${JSON.stringify(relationConvergence, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(outputDirectory, "relation-convergence.md"),
      renderTaskRelationAuthorityConvergenceMarkdown(
        relationConvergence
      ),
      "utf8"
    );
    await writeFile(
      path.join(outputDirectory, "question-type-outcomes.json"),
      `${JSON.stringify(questionTypeOutcomeReport, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(outputDirectory, "question-type-outcomes.md"),
      renderQuestionTypeAdjudicationOutcomeMarkdown(
        questionTypeOutcomeReport
      ),
      "utf8"
    );
    await writeHumanEvaluationCompatibilityReport(
      sessionDirectory,
      evaluationView.report,
      evaluationView.materialization
    );
    await writeDerivedEvaluationProvenance({
      producer: "reflect-taxonomy-adjudication-session",
      command: "taxonomy:adjudication:reflect",
      sessionDirectories: [sessionDirectory],
      outputDirectory,
      outputPaths: [
        "reflection.json",
        "reflection.md",
        "relation-reflection.json",
        "relation-reflection.md",
        "relation-convergence.json",
        "relation-convergence.md",
        "question-type-outcomes.json",
        "question-type-outcomes.md",
      ],
    });
    summaries.push({
      sessionDirectory,
      outputDirectory,
      ...report.metrics,
      relation: relationReport.metrics,
      relationConvergence: {
        metrics: relationConvergence.metrics,
        graduation: relationConvergence.graduation,
      },
      questionTypeOutcomes: questionTypeOutcomeReport.metrics,
    });
  }
  process.stdout.write(`${JSON.stringify({ sessions: summaries }, null, 2)}\n`);
}

function parseOptions(args: string[]): CliOptions {
  const sessionDirectories: string[] = [];
  let outputDirectory: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--session" && args[index + 1]) {
      sessionDirectories.push(path.resolve(args[index + 1]));
      index += 1;
      continue;
    }
    if (args[index] === "--output" && args[index + 1]) {
      outputDirectory = path.resolve(args[index + 1]);
      index += 1;
    }
  }
  if (!sessionDirectories.length) {
    throw new Error(
      "Usage: npm run taxonomy:adjudication:reflect -- --session <recording-folder> [--session <folder>] [--output <folder>]"
    );
  }
  return { sessionDirectories, outputDirectory };
}

async function readOptionalJsonLines<T>(filePath: string) {
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

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
