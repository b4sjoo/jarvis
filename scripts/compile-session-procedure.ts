import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import path from "node:path";
import process from "node:process";
import { readRecordedProjectionSnapshot, readRecordedTraceSummaries } from "./lib/session-aggregate-evidence.js";
import type { HumanEvaluationProjectionV2 } from "../src/lib/meeting/human-ground-truth-v2.js";
import type { ManualRuntimeActionEventV1 } from "../src/lib/meeting/manual-runtime-action.js";
import type { RuntimeRegressionStepEventV1 } from "../src/lib/meeting/runtime-regression.js";
import {
  buildSessionProcedureV1,
  type SessionProcedureFileRef,
  type SessionProcedureScreenInput,
  type SessionProcedureTimelineEvent,
  type SessionProcedureTraceSummary,
  type SessionProcedureTranscriptTurn,
} from "../src/lib/meeting/session-procedure.js";
import { readEffectiveSessionEvaluationProvenance } from "./lib/session-evaluation-provenance.js";
import { buildHistoricalSessionProcedure, renderHistoricalTranscript } from "./lib/historical-session-procedure.js";

interface SessionProcedureManifest {
  sessionId?: string;
  folderName?: string;
  endedAt?: number;
  scriptedValidation?: boolean;
  scriptedValidationForced?: boolean;
  recordingIntegrity?: { status?: string };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const sessionDirectory = await realpath(options.sessionDirectory);
  if (options.outputDirectory) await assertIndependentOutput(sessionDirectory, options.outputDirectory);
  const manifestText = await readFile(
    path.join(sessionDirectory, "manifest.json"),
    "utf8"
  );
  const manifest = JSON.parse(manifestText) as SessionProcedureManifest;
  const evaluationProvenance =
    await readEffectiveSessionEvaluationProvenance(sessionDirectory);
  if (!options.historical && !evaluationProvenance.scriptedValidation) {
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
    runtimeSteps: path.join(
      sessionDirectory,
      "runtime-regression",
      "steps.v1.jsonl"
    ),
    projections: path.join(
      sessionDirectory,
      "human-evaluation",
      "projections-v2.json"
    ),
    traceSummaries: path.join(
      sessionDirectory,
      "metrics",
      "trace-summaries.latest.json"
    ),
  };
  const [
    timelineText,
    transcriptText,
    manualActionText,
    runtimeStepText,
    projectionText,
    traceSummaryText,
  ] = await Promise.all([
    readOptionalText(sourcePaths.timeline),
    readOptionalText(sourcePaths.transcripts),
    readOptionalText(sourcePaths.manualActions),
    readOptionalText(sourcePaths.runtimeSteps),
    readRecordedProjectionSnapshot(sessionDirectory).then((view) => JSON.stringify(view)),
    readRecordedTraceSummaries<SessionProcedureTraceSummary>(sessionDirectory).then((view) => {
      for (const warning of view.warnings) console.warn(warning);
      return JSON.stringify({ traces: view.traces });
    }),
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
  const specializedTimelineEvents = enrichSpecializedTimelineEvents(
    parseJsonLines<SessionProcedureTimelineEvent>(timelineText),
    termCorrectionRecords,
    typeCorrectionRecords
  );
  const timelineEvents = await enrichScreenTimelineEvents(
    sessionDirectory,
    specializedTimelineEvents
  );
  const transcriptTurns = parseJsonLines<SessionProcedureTranscriptTurn>(
    transcriptText
  );
  const manualActions = parseJsonLines<ManualRuntimeActionEventV1>(
    manualActionText
  );
  const runtimeRegressionSteps = await enrichRuntimeRegressionStepText(
    sessionDirectory,
    parseJsonLines<RuntimeRegressionStepEventV1>(runtimeStepText)
  );
  const projections = projectionText
    ? ((JSON.parse(projectionText) as {
        projections?: HumanEvaluationProjectionV2[];
      }).projections ?? [])
    : [];
  const traceSummaries = traceSummaryText
    ? ((JSON.parse(traceSummaryText) as {
        traces?: SessionProcedureTraceSummary[];
      }).traces ?? [])
    : undefined;
  const sourceDigest = createHash("sha256")
    .update(manifestText)
    .update(timelineText)
    .update(transcriptText)
    .update(manualActionText)
    .update(runtimeStepText)
    .update(JSON.stringify(runtimeRegressionSteps))
    .update(projectionText)
    .update(traceSummaryText)
    .update(JSON.stringify(termCorrectionRecords))
    .update(JSON.stringify(typeCorrectionRecords))
    .update(
      JSON.stringify(
        timelineEvents.map((event) => ({
          id: event.id,
          screenInput: event.screenInput,
          evidenceGaps: event.evidenceGaps,
        }))
      )
    )
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
    ...runtimeRegressionSteps.map((event) => event.occurredAt),
    ...manualActions.map((event) => event.occurredAt),
    ...projections.map((projection) => projection.computedAt)
  );
  const builderInput = {
    recordingSessionId,
    folderName,
    sourceDigest,
    scriptedValidation: true as const,
    forcedScripted: manifest.scriptedValidationForced === true,
    recordingIntegrityStatus: manifest.recordingIntegrity?.status,
    timelineEvents,
    transcriptTurns,
    runtimeRegressionSteps,
    manualActions,
    humanEvaluationProjections: projections,
    traceSummaries,
    generatedAt: generatedAt || Date.now(),
  };
  const procedure = options.historical ? buildHistoricalSessionProcedure({ ...builderInput,
    originalDirectory: sessionDirectory, originalScriptedValidation: evaluationProvenance.scriptedValidation,
    selection: options.selection,
  }) : buildSessionProcedureV1(builderInput);
  const outputDirectory = options.outputDirectory ?? path.join(
    sessionDirectory,
    "runtime-regression"
  );
  const outputPath = path.join(
    outputDirectory,
    options.historical ? "session-procedure.v2.json" : "session-procedure.v1.json"
  );
  await mkdir(outputDirectory, { recursive: true });
  const payload = `${JSON.stringify(procedure, null, 2)}\n`;
  if (options.historical && procedure.schemaVersion === 2) {
    await assertIndependentOutput(sessionDirectory, outputDirectory);
    await writeDerived(outputPath, payload);
    await writeDerived(path.join(outputDirectory, "transcript.md"), renderHistoricalTranscript(procedure));
    await writeDerived(path.join(outputDirectory, "scenario.draft.json"), `${JSON.stringify({ schemaVersion: 1,
      id: procedure.id, revision: 1, procedure: { path: path.basename(outputPath), sha256: `sha256:${createHash("sha256").update(payload).digest("hex")}`, mediaType: "application/json" },
      assetRoot: sessionDirectory, allowAbsoluteAssets: false,
      review: { status: "needs-review", purpose: "practice", reviewedBy: "", preconditions: {} },
    }, null, 2)}\n`);
  } else await writeFile(
    outputPath,
    payload,
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

async function enrichRuntimeRegressionStepText(
  sessionDirectory: string,
  events: RuntimeRegressionStepEventV1[]
) {
  return Promise.all(
    events.map(async (event) => {
      if (
        event.event !== "injected" ||
        (event.inputKind !== "them-text" && event.inputKind !== "me-text") ||
        event.text?.trim() ||
        !event.traceId
      ) {
        return event;
      }
      const traceText = await readOptionalText(
        path.join(sessionDirectory, "traces", `${event.traceId}.json`)
      );
      if (!traceText) return event;
      const traceFile = JSON.parse(traceText) as {
        trace?: {
          inputs?: Array<{
            label?: string;
            value?: unknown;
            metadata?: Record<string, unknown>;
          }>;
        };
      };
      const input = traceFile.trace?.inputs?.find(
        (candidate) =>
          candidate.label === "runtime regression text input" &&
          candidate.metadata?.scenarioStepId === event.scenarioStepId &&
          candidate.metadata?.ordinal === event.ordinal &&
          typeof candidate.value === "string"
      );
      return input && typeof input.value === "string" && input.value.trim()
        ? { ...event, text: input.value.trim() }
        : event;
    })
  );
}

function parseOptions(args: string[]) {
  const { values } = parseArgs({ args, options: { session: { type: "string" }, "historical-import": { type: "boolean" },
    output: { type: "string" }, selection: { type: "string" } }, strict: true });
  if (!values.session || (values["historical-import"] && !values.output) || (!values["historical-import"] && (values.output || values.selection)) ||
    (values.selection && !["historical", "them-only"].includes(values.selection))) {
    throw new Error("Usage: npm run session:procedure:reflect -- --session <directory> [--historical-import --output <separate-directory> --selection historical|them-only]");
  }
  return { sessionDirectory: path.resolve(values.session), historical: values["historical-import"] === true,
    outputDirectory: values.output ? path.resolve(values.output) : undefined, selection: (values.selection ?? "historical") as "historical" | "them-only" };
}

async function canonicalOutputPath(directory: string): Promise<string> {
  try { return await realpath(directory); }
  catch (error) {
    if (!isMissingFile(error)) throw error;
    const parent = path.dirname(directory);
    if (parent === directory) throw error;
    return path.join(await canonicalOutputPath(parent), path.basename(directory));
  }
}

async function assertIndependentOutput(source: string, output: string) {
  const target = await canonicalOutputPath(output);
  const within = (base: string, candidate: string) => {
    const relative = path.relative(base, candidate);
    return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  };
  if (within(source, target) || within(target, source)) throw new Error("Historical output must be independent of the original recording.");
}

async function writeDerived(file: string, payload: string) {
  try { await writeFile(file, payload, { encoding: "utf8", flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(file, "utf8") !== payload) throw error;
  }
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

async function enrichScreenTimelineEvents(
  sessionDirectory: string,
  events: SessionProcedureTimelineEvent[]
) {
  return Promise.all(
    events.map(async (event) => {
      if (event.kind !== "screen-capture") return event;
      const metadata = event.metadata ?? {};
      const artifactRefs = event.artifactRefs ?? [];
      const imagePath =
        readString(metadata.imageArtifactRef) ??
        artifactRefs.find(
          (candidate) =>
            isImageArtifactPath(candidate) &&
            !isFocusImageArtifactPath(candidate)
        );
      const focusImagePath =
        readString(metadata.focusImageArtifactRef) ??
        artifactRefs.find(isFocusImageArtifactPath);
      const metadataPath =
        readString(metadata.metadataArtifactRef) ??
        artifactRefs.find((candidate) =>
          candidate.endsWith(".metadata.json")
        );
      const [image, focusImage, screenMetadata] = await Promise.all([
        readScreenProcedureFile({
          sessionDirectory,
          relativePath: imagePath,
          mediaType:
            readString(metadata.imageMediaType) ??
            mediaTypeForArtifactPath(imagePath),
          role: "primary-image",
          required: true,
        }),
        readScreenProcedureFile({
          sessionDirectory,
          relativePath: focusImagePath,
          mediaType:
            readString(metadata.focusImageMediaType) ??
            mediaTypeForArtifactPath(focusImagePath),
          role: "focus-image",
          required: false,
        }),
        readScreenProcedureFile({
          sessionDirectory,
          relativePath: metadataPath,
          mediaType: "application/json",
          role: "metadata",
          required: false,
        }),
      ]);
      const screenInput: SessionProcedureScreenInput | undefined = image.file
        ? {
            image: image.file,
            focusImage: focusImage.file,
            metadata: screenMetadata.file,
          }
        : undefined;
      return {
        ...event,
        screenInput,
        evidenceGaps: [
          ...(event.evidenceGaps ?? []),
          ...[image.gap, focusImage.gap, screenMetadata.gap].filter(
            (gap): gap is string => Boolean(gap)
          ),
        ],
      };
    })
  );
}

async function readScreenProcedureFile(input: {
  sessionDirectory: string;
  relativePath?: string;
  mediaType?: string;
  role: "primary-image" | "focus-image" | "metadata";
  required: boolean;
}): Promise<{ file?: SessionProcedureFileRef; gap?: string }> {
  if (!input.relativePath) {
    return input.required
      ? { gap: `screen-${input.role}-reference-missing` }
      : {};
  }
  const normalizedPath = input.relativePath.replace(/\\/g, "/");
  if (
    (input.role === "primary-image" || input.role === "focus-image") &&
    !isImageArtifactPath(normalizedPath)
  ) {
    return { gap: `screen-${input.role}-media-unsupported` };
  }
  if (input.role === "metadata" && !normalizedPath.endsWith(".json")) {
    return { gap: "screen-metadata-media-unsupported" };
  }
  const absolutePath = path.resolve(input.sessionDirectory, normalizedPath);
  const relativeToSession = path.relative(input.sessionDirectory, absolutePath);
  if (
    path.isAbsolute(normalizedPath) ||
    relativeToSession.startsWith("..") ||
    path.isAbsolute(relativeToSession)
  ) {
    return { gap: `screen-${input.role}-outside-session` };
  }
  let bytes: Buffer;
  try {
    const canonical = await realpath(absolutePath);
    const relative = path.relative(await realpath(input.sessionDirectory), canonical);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return { gap: `screen-${input.role}-outside-session` };
    bytes = await readFile(canonical);
  } catch (error) {
    if (isMissingFile(error)) {
      return { gap: `screen-${input.role}-file-missing` };
    }
    throw error;
  }
  return {
    file: {
      path: normalizedPath,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      mediaType: input.mediaType,
    },
  };
}

function isImageArtifactPath(value: string) {
  return /\.(?:jpe?g|png|webp)$/i.test(value);
}

function isFocusImageArtifactPath(value: string) {
  return /\.focus\.(?:jpe?g|png|webp)$/i.test(value);
}

function mediaTypeForArtifactPath(value: string | undefined) {
  if (!value) return undefined;
  if (/\.png$/i.test(value)) return "image/png";
  if (/\.webp$/i.test(value)) return "image/webp";
  if (/\.jpe?g$/i.test(value)) return "image/jpeg";
  return undefined;
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
