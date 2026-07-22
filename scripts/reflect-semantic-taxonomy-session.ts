import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  buildSemanticTaxonomyReflectionReport,
  renderSemanticTaxonomyReflectionMarkdown,
  type SemanticTaxonomyEvaluationLabel,
  type SemanticTaxonomyRecordedDecision,
  type SemanticTaxonomyRuntimeTrace,
} from "../src/lib/meeting/semantic-taxonomy-reflection.js";

interface CliOptions {
  sessionDirectories: string[];
  outputDirectory?: string;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const summaries = [];
  for (const sessionDirectory of options.sessionDirectories) {
    const decisions = await readJsonLines<SemanticTaxonomyRecordedDecision>(
      path.join(sessionDirectory, "taxonomy", "semantic-decisions.jsonl")
    );
    const evaluationsPayload = await readOptionalJson<{
      evaluations?: SemanticTaxonomyEvaluationLabel[];
    }>(
      path.join(
        sessionDirectory,
        "human-evaluation",
        "question-evaluations.json"
      ),
      { evaluations: [] }
    );
    const runtimeTraces = await readRuntimeTraces(
      path.join(sessionDirectory, "traces")
    );
    const report = buildSemanticTaxonomyReflectionReport({
      decisions,
      evaluations: evaluationsPayload.evaluations ?? [],
      runtimeTraces,
    });
    const outputDirectory = options.outputDirectory
      ? options.sessionDirectories.length === 1
        ? options.outputDirectory
        : path.join(options.outputDirectory, path.basename(sessionDirectory))
      : path.join(sessionDirectory, "evaluation", "semantic-taxonomy");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(
      path.join(outputDirectory, "reflection.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(outputDirectory, "reflection.md"),
      renderSemanticTaxonomyReflectionMarkdown(report),
      "utf8"
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
      "Usage: npm run taxonomy:semantic:reflect -- --session <recording-folder> [--session <folder>] [--output <folder>]"
    );
  }
  return { sessionDirectories, outputDirectory };
}

async function readJsonLines<T>(filePath: string) {
  return (await readFile(filePath, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function readOptionalJson<T>(filePath: string, fallback: T) {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return fallback;
    }
    throw error;
  }
}

async function readRuntimeTraces(directory: string) {
  let filenames: string[];
  try {
    filenames = await readdir(directory);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
  const traces = await Promise.all(
    filenames
      .filter((filename) => filename.endsWith(".json"))
      .map(async (filename) => {
        const payload = JSON.parse(
          await readFile(path.join(directory, filename), "utf8")
        ) as { trace?: SemanticTaxonomyRuntimeTrace } &
          Partial<SemanticTaxonomyRuntimeTrace>;
        const trace = payload.trace ?? payload;
        if (!trace.id || !trace.metadata || !trace.status) return undefined;
        return trace as SemanticTaxonomyRuntimeTrace;
      })
  );
  return traces.filter(
    (trace): trace is SemanticTaxonomyRuntimeTrace => Boolean(trace)
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
