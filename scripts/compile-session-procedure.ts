import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { HumanEvaluationProjectionV2 } from "../src/lib/meeting/human-ground-truth-v2.js";
import type { ManualRuntimeActionEventV1 } from "../src/lib/meeting/manual-runtime-action.js";
import {
  buildSessionProcedureV1,
  type SessionProcedureTimelineEvent,
  type SessionProcedureTranscriptTurn,
} from "../src/lib/meeting/session-procedure.js";
import { readEffectiveSessionEvaluationProvenance } from "./lib/session-evaluation-provenance.js";

interface SessionProcedureManifest {
  sessionId?: string;
  folderName?: string;
  endedAt?: number;
  scriptedValidation?: boolean;
  scriptedValidationForced?: boolean;
  recordingIntegrity?: { status?: string };
}

async function main() {
  const sessionDirectory = parseSessionDirectory(process.argv.slice(2));
  const manifestText = await readFile(
    path.join(sessionDirectory, "manifest.json"),
    "utf8"
  );
  const manifest = JSON.parse(manifestText) as SessionProcedureManifest;
  const evaluationProvenance =
    await readEffectiveSessionEvaluationProvenance(sessionDirectory);
  if (!evaluationProvenance.scriptedValidation) {
    process.stdout.write(
      `${JSON.stringify({ skipped: true, reason: "session-is-not-scripted", sessionDirectory }, null, 2)}\n`
    );
    return;
  }

  const sourcePaths = {
    timeline: path.join(sessionDirectory, "timeline.jsonl"),
    transcripts: path.join(
      sessionDirectory,
      "transcripts",
      "turns.jsonl"
    ),
    manualActions: path.join(
      sessionDirectory,
      "runtime-regression",
      "manual-actions.v1.jsonl"
    ),
    projections: path.join(
      sessionDirectory,
      "human-evaluation",
      "projections-v2.json"
    ),
  };
  const [timelineText, transcriptText, manualActionText, projectionText] =
    await Promise.all([
      readOptionalText(sourcePaths.timeline),
      readOptionalText(sourcePaths.transcripts),
      readOptionalText(sourcePaths.manualActions),
      readOptionalText(sourcePaths.projections),
    ]);
  const [termCorrectionRecords, typeCorrectionRecords] = await Promise.all([
    readSpecializedRecords(
      sessionDirectory,
      "active-question-term-corrections.jsonl"
    ),
    readSpecializedRecords(
      sessionDirectory,
      "manual-question-type-corrections.jsonl"
    ),
  ]);
  const timelineEvents = enrichSpecializedTimelineEvents(
    parseJsonLines<SessionProcedureTimelineEvent>(timelineText),
    termCorrectionRecords,
    typeCorrectionRecords
  );
  const transcriptTurns = parseJsonLines<SessionProcedureTranscriptTurn>(
    transcriptText
  );
  const manualActions = parseJsonLines<ManualRuntimeActionEventV1>(
    manualActionText
  );
  const projections = projectionText
    ? ((JSON.parse(projectionText) as {
        projections?: HumanEvaluationProjectionV2[];
      }).projections ?? [])
    : [];
  const sourceDigest = createHash("sha256")
    .update(manifestText)
    .update(timelineText)
    .update(transcriptText)
    .update(manualActionText)
    .update(projectionText)
    .update(JSON.stringify(termCorrectionRecords))
    .update(JSON.stringify(typeCorrectionRecords))
    .digest("hex");
  const recordingSessionId = manifest.sessionId?.trim();
  if (!recordingSessionId) {
    throw new Error("Session manifest is missing sessionId.");
  }
  const folderName =
    manifest.folderName?.trim() || path.basename(sessionDirectory);
  const generatedAt = Math.max(
    manifest.endedAt ?? 0,
    ...timelineEvents.map((event) => event.createdAt),
    ...manualActions.map((event) => event.occurredAt),
    ...projections.map((projection) => projection.computedAt)
  );
  const procedure = buildSessionProcedureV1({
    recordingSessionId,
    folderName,
    sourceDigest,
    scriptedValidation: true,
    forcedScripted: manifest.scriptedValidationForced === true,
    recordingIntegrityStatus: manifest.recordingIntegrity?.status,
    timelineEvents,
    transcriptTurns,
    manualActions,
    humanEvaluationProjections: projections,
    generatedAt: generatedAt || Date.now(),
  });
  const outputDirectory = path.join(
    sessionDirectory,
    "runtime-regression"
  );
  const outputPath = path.join(
    outputDirectory,
    "session-procedure.v1.json"
  );
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify(procedure, null, 2)}\n`,
    "utf8"
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        skipped: false,
        steps: procedure.steps.length,
        reviewStatus: procedure.reviewStatus,
        outputPath,
      },
      null,
      2
    )}\n`
  );
}

function parseSessionDirectory(args: string[]) {
  if (args.length !== 2 || args[0] !== "--session" || !args[1]) {
    throw new Error(
      "Usage: npm run session:procedure:reflect -- --session <session-directory>"
    );
  }
  return path.resolve(args[1]);
}

async function readOptionalText(filePath: string) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return "";
    throw error;
  }
}

function parseJsonLines<T>(text: string): T[] {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function readSpecializedRecords(
  sessionDirectory: string,
  filename: string
) {
  const records: Record<string, unknown>[] = [];
  const runtimeText = await readOptionalText(
    path.join(sessionDirectory, "runtime", filename)
  );
  records.push(...parseJsonLines<Record<string, unknown>>(runtimeText));
  const tasksDirectory = path.join(sessionDirectory, "tasks");
  let taskDirectoryNames: string[] = [];
  try {
    taskDirectoryNames = (
      await readdir(tasksDirectory, { withFileTypes: true })
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  for (const taskDirectoryName of taskDirectoryNames) {
    const text = await readOptionalText(
      path.join(tasksDirectory, taskDirectoryName, filename)
    );
    records.push(...parseJsonLines<Record<string, unknown>>(text));
  }
  return records;
}

function enrichSpecializedTimelineEvents(
  events: SessionProcedureTimelineEvent[],
  termCorrectionRecords: Record<string, unknown>[],
  typeCorrectionRecords: Record<string, unknown>[]
) {
  const latestTermCorrections = latestRecordsById(
    termCorrectionRecords,
    "correctionId"
  );
  const latestTypeCorrections = latestRecordsById(
    typeCorrectionRecords,
    "eventId"
  );
  return events.map((event) => {
    const metadata = event.metadata ?? {};
    if (event.kind === "active-question-term-correction") {
      const id = readString(metadata.manualTermCorrectionId);
      const record = id ? latestTermCorrections.get(id) : undefined;
      return record
        ? {
            ...event,
            metadata: {
              ...metadata,
              manualTermCorrectionRawText: record.rawText,
              manualTermCorrectionSourceTerm: record.sourceTerm,
              manualTermCorrectionNormalizedTerm: record.normalizedTerm,
              correctionTraceId: record.correctionTraceId,
              regenerationTraceId: record.regenerationTraceId,
              sourceTurnIds: record.sourceTurnIds,
            },
          }
        : event;
    }
    if (event.kind === "manual-question-type-correction") {
      const id = readString(metadata.manualQuestionTypeCorrectionId);
      const record = id ? latestTypeCorrections.get(id) : undefined;
      return record
        ? {
            ...event,
            metadata: {
              ...metadata,
              correctedQuestionType: record.correctedType,
              correctionTraceId: record.correctionTraceId,
              regenerationTraceId: record.regenerationTraceId,
              questionOriginTraceId: record.questionOriginTraceId,
              sourceTurnIds: record.sourceTurnIds,
            },
          }
        : event;
    }
    return event;
  });
}

function latestRecordsById(
  records: Record<string, unknown>[],
  idField: string
) {
  const result = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    const id = readString(record[idField]);
    if (id) result.set(id, record);
  }
  return result;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isMissingFile(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
