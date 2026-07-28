import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  buildAnswerSufficiencyReflectionReport,
  renderAnswerSufficiencyReflectionMarkdown,
  type RecordedAnswerSufficiencyDecision,
} from "../src/lib/meeting/answer-sufficiency-reflection.js";
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
    const decisions = await readOptionalJsonLines<RecordedAnswerSufficiencyDecision>(
      path.join(sessionDirectory, "answer-sufficiency", "decisions.jsonl")
    );
    const evaluationView =
      await loadSessionHumanEvaluationConsumerView(sessionDirectory);
    const report = buildAnswerSufficiencyReflectionReport({
      decisions,
      evaluations: evaluationView.evaluations,
    });
    const outputDirectory = options.outputDirectory
      ? options.sessionDirectories.length === 1
        ? options.outputDirectory
        : path.join(options.outputDirectory, path.basename(sessionDirectory))
      : path.join(sessionDirectory, "evaluation", "answer-sufficiency");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(
      path.join(outputDirectory, "reflection.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(outputDirectory, "reflection.md"),
      renderAnswerSufficiencyReflectionMarkdown(report),
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
      "Usage: npm run answer:sufficiency:reflect -- --session <recording-folder> [--session <folder>] [--output <folder>]"
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
