import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  evaluateTaxonomyCorpus,
  importPrivateTaxonomyCorpus,
  splitTaxonomyEvaluationCorpus,
  type PrivateQuestionEvaluationRecord,
  type PrivateTranscriptTurnRecord,
  type TaxonomyEvaluationExample,
} from "../src/lib/meeting/taxonomy-evaluation.js";
import { inferQuestionTypeDecisionFromText } from "../src/lib/meeting/task-taxonomy.js";

interface CliOptions {
  sessionDirectories: string[];
  outputDirectory: string;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const examples: TaxonomyEvaluationExample[] = [];
  const imports: Array<{
    sessionDirectory: string;
    imported: number;
    skipped: ReturnType<typeof importPrivateTaxonomyCorpus>["skipped"];
  }> = [];

  for (const sessionDirectory of options.sessionDirectories) {
    const evaluationsPayload = JSON.parse(
      await readFile(
        path.join(
          sessionDirectory,
          "human-evaluation",
          "question-evaluations.json"
        ),
        "utf8"
      )
    ) as {
      sessionId?: string;
      evaluations?: PrivateQuestionEvaluationRecord[];
    };
    const turns = await readJsonLines<PrivateTranscriptTurnRecord>(
      path.join(sessionDirectory, "transcripts", "turns.jsonl")
    );
    const imported = importPrivateTaxonomyCorpus({
      sessionId: evaluationsPayload.sessionId ?? path.basename(sessionDirectory),
      evaluations: evaluationsPayload.evaluations ?? [],
      turns,
    });
    examples.push(...imported.examples);
    imports.push({
      sessionDirectory,
      imported: imported.examples.length,
      skipped: imported.skipped,
    });
  }

  const report = evaluateTaxonomyCorpus(examples, (example) =>
    inferQuestionTypeDecisionFromText(example.text)
  );
  const splits = splitTaxonomyEvaluationCorpus(examples);
  await mkdir(options.outputDirectory, { recursive: true });
  await writeJson(
    path.join(options.outputDirectory, "private-taxonomy-corpus.json"),
    { version: 1, generatedAt: Date.now(), imports, examples, splits }
  );
  await writeJson(
    path.join(options.outputDirectory, "lexical-baseline.json"),
    { version: 1, generatedAt: Date.now(), imports, report }
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        outputDirectory: options.outputDirectory,
        corpusSize: examples.length,
        importedSessions: imports.length,
        skippedEvaluations: imports.reduce(
          (total, item) => total + item.skipped.length,
          0
        ),
        accuracy: report.metrics.accuracy,
        answerableTechnicalUnknownRate:
          report.metrics.answerableTechnicalUnknownRate,
        falseActivationRate: report.metrics.falseActivationRate,
      },
      null,
      2
    )}\n`
  );
}

function parseOptions(args: string[]): CliOptions {
  const sessionDirectories: string[] = [];
  let outputDirectory = "";

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

  if (!sessionDirectories.length || !outputDirectory) {
    throw new Error(
      "Usage: npm run taxonomy:evaluate -- --session <recording-folder> [--session <folder>] --output <private-output-folder>"
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

async function writeJson(filePath: string, value: unknown) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
