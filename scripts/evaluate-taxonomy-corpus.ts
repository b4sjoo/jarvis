import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  evaluateTaxonomyCorpus,
  importPrivateTaxonomySessionCorpus,
  splitTaxonomyEvaluationCorpus,
  type PrivateQuestionEvaluationRecord,
  type PrivateTranscriptTurnRecord,
  type TaxonomyEvaluationExample,
} from "../src/lib/meeting/taxonomy-evaluation.js";
import { inferQuestionTypeDecisionFromText } from "../src/lib/meeting/task-taxonomy.js";
import {
  summarizeHumanEvaluationProjectionMaterializationV2,
  type HumanEvaluationProjectionMaterializationStatsV2,
} from "../src/lib/meeting/human-evaluation-projection-materialization.js";
import {
  deriveHumanEvaluationProjectionV2,
  projectHumanGroundTruthEventsForSessionPurposeV2,
  type HumanEvaluationProjectionV2,
  type HumanGroundTruthEventV2,
} from "../src/lib/meeting/human-ground-truth-v2.js";
import { readEffectiveSessionEvaluationProvenance } from "./lib/session-evaluation-provenance.js";

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
    skipped: ReturnType<
      typeof importPrivateTaxonomySessionCorpus
    >["skipped"];
    warnings: ReturnType<
      typeof importPrivateTaxonomySessionCorpus
    >["warnings"];
    stats: ReturnType<typeof importPrivateTaxonomySessionCorpus>["stats"];
    sources: {
      v1: "snapshot" | "history" | "missing";
      v2: "snapshot" | "history" | "missing";
    };
    projectionMaterialization: ReturnType<
      typeof summarizeHumanEvaluationProjectionMaterializationV2
    >;
  }> = [];

  for (const sessionDirectory of options.sessionDirectories) {
    const evaluationsPayload =
      await readEvaluationSnapshot(sessionDirectory);
    const projectionsPayload =
      await readProjectionSnapshot(sessionDirectory);
    const turns = await readJsonLines<PrivateTranscriptTurnRecord>(
      path.join(sessionDirectory, "transcripts", "turns.jsonl")
    );
    const sessionId =
      projectionsPayload.payload?.sessionId ??
      projectionsPayload.projections[0]?.sessionId ??
      evaluationsPayload.payload?.sessionId ??
      path.basename(sessionDirectory);
    const imported = importPrivateTaxonomySessionCorpus({
      sessionId,
      evaluations: evaluationsPayload.evaluations ?? [],
      projections: projectionsPayload.projections,
      turns,
      projectionHistoryFallback: projectionsPayload.source === "history",
    });
    examples.push(...imported.examples);
    imports.push({
      sessionDirectory,
      imported: imported.examples.length,
      skipped: imported.skipped,
      warnings: imported.warnings,
      stats: imported.stats,
      sources: {
        v1: evaluationsPayload.source,
        v2: projectionsPayload.source,
      },
      projectionMaterialization:
        projectionsPayload.projectionMaterialization,
    });
  }

  const report = evaluateTaxonomyCorpus(examples, (example) =>
    inferQuestionTypeDecisionFromText(example.text)
  );
  const splits = splitTaxonomyEvaluationCorpus(examples);
  await mkdir(options.outputDirectory, { recursive: true });
  await writeJson(
    path.join(options.outputDirectory, "private-taxonomy-corpus.json"),
    { version: 2, generatedAt: Date.now(), imports, examples, splits }
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
        importWarnings: imports.reduce(
          (total, item) => total + item.warnings.length,
          0
        ),
        v1OnlySamples: imports.reduce(
          (total, item) => total + item.stats.v1OnlyCount,
          0
        ),
        v2OnlySamples: imports.reduce(
          (total, item) => total + item.stats.v2OnlyCount,
          0
        ),
        v1V2Disagreements: imports.reduce(
          (total, item) => total + item.stats.disagreementCount,
          0
        ),
        rawGroundTruthEvents: imports.reduce(
          (total, item) =>
            total + item.projectionMaterialization.groundTruthEventCount,
          0
        ),
        uniqueProjections: imports.reduce(
          (total, item) =>
            total + item.projectionMaterialization.uniqueProjectionCount,
          0
        ),
        supersededProjections: imports.reduce(
          (total, item) =>
            total + item.projectionMaterialization.supersededProjectionCount,
          0
        ),
        duplicateProjectionHistoryEvents: imports.reduce(
          (total, item) =>
            total +
            item.projectionMaterialization.duplicateProjectionHistoryCount,
          0
        ),
        duplicateProjectionSuppressions: imports.reduce(
          (total, item) =>
            total +
            item.projectionMaterialization.duplicateSuppressionCount,
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

async function readOptionalJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

async function readOptionalJsonLines<T>(filePath: string): Promise<T[]> {
  try {
    return await readJsonLines<T>(filePath);
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}

async function readEvaluationSnapshot(sessionDirectory: string) {
  const snapshot = await readOptionalJson<{
    sessionId?: string;
    evaluations?: PrivateQuestionEvaluationRecord[];
  }>(
    path.join(
      sessionDirectory,
      "human-evaluation",
      "question-evaluations.json"
    )
  );
  if (snapshot) {
    return {
      payload: snapshot,
      evaluations: snapshot.evaluations ?? [],
      source: "snapshot" as const,
    };
  }

  const history = await readOptionalJsonLines<{
    sessionId?: string;
    evaluations?: PrivateQuestionEvaluationRecord[];
  }>(
    path.join(
      sessionDirectory,
      "human-evaluation",
      "question-evaluations.jsonl"
    )
  );
  const latest = [...history]
    .reverse()
    .find((entry) => Array.isArray(entry.evaluations));
  return {
    payload: latest,
    evaluations: latest?.evaluations ?? [],
    source: latest ? ("history" as const) : ("missing" as const),
  };
}

async function readProjectionSnapshot(sessionDirectory: string) {
  const [snapshot, history, groundTruthEvents, evaluationProvenance] = await Promise.all([
    readOptionalJson<{
      sessionId?: string;
      projections?: HumanEvaluationProjectionV2[];
      materialization?: HumanEvaluationProjectionMaterializationStatsV2;
    }>(
      path.join(
        sessionDirectory,
        "human-evaluation",
        "projections-v2.json"
      )
    ),
    readOptionalJsonLines<HumanEvaluationProjectionV2>(
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
  const effectiveEvents =
    evaluationProvenance.source === "default"
      ? groundTruthEvents
      : projectHumanGroundTruthEventsForSessionPurposeV2(
          groundTruthEvents,
          evaluationProvenance.scriptedValidation
        );
  const rematerialize = (projection: HumanEvaluationProjectionV2) =>
    deriveHumanEvaluationProjectionV2({
      sessionId: projection.sessionId,
      subject: projection.subject,
      events: effectiveEvents,
      observed: projection.observed,
      now: projection.computedAt,
    });
  const projectionMaterialization =
    summarizeHumanEvaluationProjectionMaterializationV2({
      currentProjections: snapshot?.projections ?? [],
      history,
      groundTruthEventCount: groundTruthEvents.length,
      recorded: snapshot?.materialization,
    });
  if (snapshot) {
    return {
      payload: snapshot,
      projections: (snapshot.projections ?? []).map(rematerialize),
      source: "snapshot" as const,
      projectionMaterialization,
    };
  }

  const latestByProjectionId = new Map<string, HumanEvaluationProjectionV2>();
  for (const projection of history) {
    if (!projection?.projectionId) continue;
    const previous = latestByProjectionId.get(projection.projectionId);
    if (
      !previous ||
      (projection.computedAt ?? 0) >= (previous.computedAt ?? 0)
    ) {
      latestByProjectionId.set(projection.projectionId, projection);
    }
  }
  const projections = Array.from(latestByProjectionId.values()).map(
    rematerialize
  );
  return {
    payload: undefined,
    projections,
    source: projections.length ? ("history" as const) : ("missing" as const),
    projectionMaterialization,
  };
}

function isMissingFileError(error: unknown) {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function writeJson(filePath: string, value: unknown) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
