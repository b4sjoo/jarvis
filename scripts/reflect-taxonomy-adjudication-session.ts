import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  buildTaxonomyAdjudicationReflectionReport,
  renderTaxonomyAdjudicationReflectionMarkdown,
  type TaxonomyAdjudicationCompactTrace,
  type TaxonomyAdjudicationRecordedDecision,
} from "../src/lib/meeting/taxonomy-adjudication-reflection.js";
import {
  buildTaskRelationAdjudicationReflectionReport,
  renderTaskRelationAdjudicationReflectionMarkdown,
  type TaskRelationAdjudicationRecordedDecision,
} from "../src/lib/meeting/task-relation-adjudication-reflection.js";
import {
  buildTaskRelationAuthorityConvergenceReportV1,
  renderTaskRelationAuthorityConvergenceMarkdown,
} from "../src/lib/meeting/task-relation-authority-convergence.js";
import {
  buildQuestionTypeAdjudicationOutcomeReport,
  renderQuestionTypeAdjudicationOutcomeMarkdown,
  type QuestionTypeAdjudicationRecordedDecision,
} from "../src/lib/meeting/question-type-adjudication-outcome.js";
import type { QuestionTypeAdjudicationOutcomeEvent } from "../src/lib/meeting/question-type-adjudication.js";
import {
  loadSessionHumanEvaluationConsumerView,
  writeHumanEvaluationCompatibilityReport,
} from "./session-human-evaluation-v2.js";

interface CliOptions {
  sessionDirectories: string[];
  outputDirectory?: string;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const summaries = [];
  for (const sessionDirectory of options.sessionDirectories) {
    const intentDecisions =
      await readOptionalJsonLines<TaxonomyAdjudicationRecordedDecision>(
        path.join(sessionDirectory, "intent", "llm-adjudications.jsonl")
      );
    const decisions = intentDecisions.length
      ? intentDecisions
      : await readOptionalJsonLines<TaxonomyAdjudicationRecordedDecision>(
          path.join(sessionDirectory, "taxonomy", "llm-adjudications.jsonl")
        );
    const tracePayload = await readOptionalJson<{
      traces?: TaxonomyAdjudicationCompactTrace[];
    }>(path.join(sessionDirectory, "metrics", "trace-summaries.latest.json"), {
      traces: [],
    });
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
      evaluations: evaluationView.evaluations,
    });
    const relationReport =
      buildTaskRelationAdjudicationReflectionReport({
        decisions: relationDecisions,
        evaluations: evaluationView.evaluations,
      });
    const relationConvergence =
      buildTaskRelationAuthorityConvergenceReportV1({
        relationReport,
      });
    const questionTypeOutcomeReport =
      buildQuestionTypeAdjudicationOutcomeReport({
        decisions: questionTypeDecisions,
        outcomes: questionTypeOutcomes,
      });
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
      evaluationView.report
    );
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
