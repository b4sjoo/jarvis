import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const DERIVED_EVALUATION_PROVENANCE_SCHEMA_VERSION = 1;
export const DERIVED_EVALUATION_HISTORY_PATH = path.join(
  "evaluation",
  "derived-evaluation-history.jsonl"
);

interface SessionManifestIdentity {
  sessionId?: string;
  status?: string;
  endedAt?: number;
  closedAt?: number;
}

export interface DerivedEvaluationSourceSession {
  sessionId: string;
  folderName: string;
  recordingStatus?: string;
  recordingSealedAt?: number;
}

export interface DerivedEvaluationProvenance {
  schemaVersion: 1;
  runId: string;
  producer: string;
  command: string;
  producerVersion: string;
  generatedAt: number;
  sourceSessions: DerivedEvaluationSourceSession[];
  outputDirectory: string;
  outputPaths: string[];
}

export async function writeDerivedEvaluationProvenance(input: {
  producer: string;
  command: string;
  sessionDirectories: string[];
  outputDirectory: string;
  outputPaths: string[];
  generatedAt?: number;
  producerVersion?: string;
}): Promise<DerivedEvaluationProvenance> {
  const generatedAt = input.generatedAt ?? Date.now();
  const sourceSessions = await Promise.all(
    input.sessionDirectories.map(readSourceSessionIdentity)
  );
  const provenance: DerivedEvaluationProvenance = {
    schemaVersion: DERIVED_EVALUATION_PROVENANCE_SCHEMA_VERSION,
    runId: `${normalizeRunIdPart(input.producer)}-${generatedAt}`,
    producer: input.producer,
    command: input.command,
    producerVersion:
      input.producerVersion ?? process.env.npm_package_version ?? "unknown",
    generatedAt,
    sourceSessions,
    outputDirectory: path.resolve(input.outputDirectory),
    outputPaths: input.outputPaths.map((outputPath) =>
      path.resolve(input.outputDirectory, outputPath)
    ),
  };

  await mkdir(input.outputDirectory, { recursive: true });
  await writeFile(
    path.join(input.outputDirectory, "provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
    "utf8"
  );

  await Promise.all(
    input.sessionDirectories.map(async (sessionDirectory) => {
      const historyPath = path.join(
        sessionDirectory,
        DERIVED_EVALUATION_HISTORY_PATH
      );
      await mkdir(path.dirname(historyPath), { recursive: true });
      await appendFile(historyPath, `${JSON.stringify(provenance)}\n`, "utf8");
    })
  );
  return provenance;
}

async function readSourceSessionIdentity(
  sessionDirectory: string
): Promise<DerivedEvaluationSourceSession> {
  const manifest = await readOptionalManifest(
    path.join(sessionDirectory, "manifest.json")
  );
  return {
    sessionId: manifest?.sessionId ?? path.basename(sessionDirectory),
    folderName: path.basename(sessionDirectory),
    recordingStatus: manifest?.status,
    recordingSealedAt: manifest?.closedAt ?? manifest?.endedAt,
  };
}

async function readOptionalManifest(filePath: string) {
  try {
    return JSON.parse(
      await readFile(filePath, "utf8")
    ) as SessionManifestIdentity;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

function normalizeRunIdPart(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
