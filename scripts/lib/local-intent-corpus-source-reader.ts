import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  readdir,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type {
  CorpusSourceFile,
  CorpusSourceInventoryRecord,
  CorpusSourceOverlay,
} from "./local-intent-corpus-schema.js";
import { sha256, stableJson } from "./local-intent-corpus-utils.js";

export interface SourceTreeFileSnapshot {
  relativePath: string;
  bytes: number;
  mtimeNs: string;
  sha256: string;
}

export interface SourceTreeSnapshot {
  root: string;
  files: SourceTreeFileSnapshot[];
  contentHash: string;
  immutableStateHash: string;
}

export interface ParsedJsonLine<T> {
  lineNumber: number;
  rawHash: string;
  value?: T;
  error?: string;
}

export interface DiscoveredCorpusContainer {
  absolutePath: string;
  inventory: CorpusSourceInventoryRecord;
  manifest?: Record<string, unknown>;
}

export interface RecordedTranscriptTurn {
  id: string;
  speaker: string;
  text: string;
  startedAt: number;
  endedAt: number;
  isFinal: boolean;
  source?: string;
  traceId?: string;
  lineNumber: number;
  recordHash: string;
}

export interface RecordedSettlementEvidence {
  relativePath: string;
  recordHash: string;
  traceId: string;
  taskId?: string;
  recordedAt: number;
  currentQuestion: {
    logicalQuestionUnitId: string;
    revision: number;
    runtimeEpoch?: number;
    normalizedText: string;
    sourceTurnIds: string[];
    sourceObservationIds: string[];
    sourceKind?: string;
    sourceHash?: string;
  };
  settlement?: Record<string, unknown>;
  parentBefore?: Record<string, unknown>;
  parentAfter?: Record<string, unknown>;
}

export interface RecordedHumanEvidence {
  relativePath: string;
  lineNumber: number;
  recordHash: string;
  payload: Record<string, unknown>;
}

export interface SessionCorpusEvidence {
  turns: RecordedTranscriptTurn[];
  settlements: RecordedSettlementEvidence[];
  humanGroundTruth: RecordedHumanEvidence[];
  legacyEvaluations: RecordedHumanEvidence[];
  warnings: string[];
}

export interface SttCorpusEvidence {
  canonicalTurns: RecordedHumanEvidence[];
  providerAttempts: RecordedHumanEvidence[];
  humanReferences: RecordedHumanEvidence[];
  warnings: string[];
}

export async function* streamJsonLines<T>(
  filePath: string
): AsyncIterable<ParsedJsonLine<T>> {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      yield {
        lineNumber,
        rawHash: sha256(line),
        value: JSON.parse(line) as T,
      };
    } catch (error) {
      yield {
        lineNumber,
        rawHash: sha256(line),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function selectLatestByIdentity<T>(
  records: T[],
  identity: (record: T) => string,
  revision: (record: T) => number
) {
  const latest = new Map<string, T>();
  const conflicts: string[] = [];
  for (const record of records) {
    const id = identity(record);
    const existing = latest.get(id);
    if (!existing || revision(record) > revision(existing)) {
      latest.set(id, record);
      continue;
    }
    if (
      revision(record) === revision(existing) &&
      stableJson(record) !== stableJson(existing)
    ) {
      conflicts.push(id);
    }
  }
  return {
    records: [...latest.values()],
    conflicts: [...new Set(conflicts)].sort(),
  };
}

export async function snapshotSourceTree(root: string): Promise<SourceTreeSnapshot> {
  const resolvedRoot = await realpath(root);
  const relativeFiles = await walkRegularFiles(resolvedRoot);
  const files: SourceTreeFileSnapshot[] = [];
  for (const relativePath of relativeFiles) {
    const absolutePath = path.join(resolvedRoot, relativePath);
    const metadata = await stat(absolutePath, { bigint: true });
    files.push({
      relativePath,
      bytes: Number(metadata.size),
      mtimeNs: metadata.mtimeNs.toString(),
      sha256: await hashFile(absolutePath),
    });
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const contentHash = sha256(
    files
      .map((file) => `${file.relativePath}\0${file.bytes}\0${file.sha256}\n`)
      .join("")
  );
  return {
    root: resolvedRoot,
    files,
    contentHash,
    immutableStateHash: sha256(stableJson(files)),
  };
}

export function assertSourceTreeUnchanged(
  before: SourceTreeSnapshot,
  after: SourceTreeSnapshot
) {
  if (
    before.root !== after.root ||
    before.immutableStateHash !== after.immutableStateHash
  ) {
    throw new Error(`Immutable source changed during build: ${before.root}`);
  }
}

export async function assertOutputSeparatedFromSources(
  outputPath: string,
  sourceRoots: string[]
) {
  const output = await resolveProspectiveRealPath(outputPath);
  for (const sourceRoot of sourceRoots) {
    const source = await realpath(sourceRoot);
    if (isSameOrDescendant(output, source) || isSameOrDescendant(source, output)) {
      throw new Error(`Output path must be separate from source root: ${source}`);
    }
  }
}

async function resolveProspectiveRealPath(candidatePath: string) {
  let cursor = path.resolve(candidatePath);
  const suffix: string[] = [];
  while (!(await exists(cursor))) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  const resolvedBase = await realpath(cursor);
  return path.join(resolvedBase, ...suffix);
}

export async function discoverCorpusContainers(input: {
  recordingsRoot: string;
  sttCapturesRoot: string;
  overlays: CorpusSourceOverlay[];
}) {
  const containers: DiscoveredCorpusContainer[] = [];
  containers.push(
    ...(await discoverRootContainers(
      input.recordingsRoot,
      "recording",
      input.overlays
    ))
  );
  containers.push(
    ...(await discoverRootContainers(
      input.sttCapturesRoot,
      "stt",
      input.overlays
    ))
  );
  return containers.sort((left, right) =>
    left.inventory.containerId.localeCompare(right.inventory.containerId)
  );
}

export async function readSessionCorpusEvidence(
  container: DiscoveredCorpusContainer
): Promise<SessionCorpusEvidence> {
  const warnings: string[] = [];
  const turns: RecordedTranscriptTurn[] = [];
  const turnsPath = path.join(container.absolutePath, "transcripts", "turns.jsonl");
  if (await exists(turnsPath)) {
    for await (const line of streamJsonLines<Record<string, unknown>>(turnsPath)) {
      if (!line.value) {
        warnings.push(`malformed-jsonl:transcripts/turns.jsonl:${line.lineNumber}`);
        continue;
      }
      const parsed = parseTranscriptTurn(line.value, line);
      if (parsed) turns.push(parsed);
      else warnings.push(`invalid-turn:transcripts/turns.jsonl:${line.lineNumber}`);
    }
  }

  const settlements: RecordedSettlementEvidence[] = [];
  for (const file of container.inventory.files) {
    if (!file.relativePath.endsWith("/current-question-settlement.json")) continue;
    const payload = await readJsonObject(
      path.join(container.absolutePath, file.relativePath)
    );
    const parsed = parseSettlement(payload, file.relativePath, file.sha256);
    if (parsed) settlements.push(parsed);
    else warnings.push(`invalid-settlement:${file.relativePath}`);
  }

  const humanGroundTruth = await readEvidenceJsonLines(
    container,
    "human-evaluation/ground-truth-v2.jsonl",
    warnings
  );
  const legacyEvaluations = await readLegacyEvaluations(container, warnings);
  return {
    turns: turns.sort((left, right) => left.startedAt - right.startedAt),
    settlements: settlements.sort(
      (left, right) =>
        left.recordedAt - right.recordedAt ||
        left.traceId.localeCompare(right.traceId)
    ),
    humanGroundTruth,
    legacyEvaluations,
    warnings,
  };
}

export async function readSttCorpusEvidence(
  container: DiscoveredCorpusContainer
): Promise<SttCorpusEvidence> {
  const warnings: string[] = [];
  return {
    canonicalTurns: await readEvidenceJsonLines(
      container,
      "canonical/transcript-turns.jsonl",
      warnings
    ),
    providerAttempts: await readEvidenceJsonLines(
      container,
      "provider-events/raw-transcript-revisions.jsonl",
      warnings
    ),
    humanReferences: await readEvidenceJsonLines(
      container,
      "references/human-corrections.jsonl",
      warnings
    ),
    warnings,
  };
}

export async function readCorpusOverlays(overlayPath: string) {
  const metadata = await lstat(overlayPath);
  const files = metadata.isDirectory()
    ? (await walkRegularFiles(overlayPath))
        .filter((file) => file.endsWith(".json") || file.endsWith(".jsonl"))
        .map((file) => path.join(overlayPath, file))
    : [overlayPath];
  const overlays: CorpusSourceOverlay[] = [];
  for (const file of files.sort()) {
    if (file.endsWith(".jsonl")) {
      for await (const line of streamJsonLines<CorpusSourceOverlay>(file)) {
        if (!line.value) throw new Error(`Malformed overlay ${file}:${line.lineNumber}`);
        overlays.push(line.value);
      }
      continue;
    }
    const value = JSON.parse(await readFile(file, "utf8")) as unknown;
    const records = Array.isArray(value) ? value : [value];
    overlays.push(...(records as CorpusSourceOverlay[]));
  }
  return overlays.sort((left, right) => left.overlayId.localeCompare(right.overlayId));
}

async function discoverRootContainers(
  root: string,
  lane: "recording" | "stt",
  overlays: CorpusSourceOverlay[]
) {
  const resolvedRoot = await realpath(root);
  const entries = await readdir(resolvedRoot, { withFileTypes: true });
  const containers: DiscoveredCorpusContainer[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) throw new Error(`Symlink source is not allowed: ${entry.name}`);
    if (!entry.isDirectory()) continue;
    const absolutePath = path.join(resolvedRoot, entry.name);
    containers.push(await inspectContainer(absolutePath, entry.name, lane, overlays));
  }
  return containers;
}

async function inspectContainer(
  absolutePath: string,
  folderAlias: string,
  lane: "recording" | "stt",
  overlays: CorpusSourceOverlay[]
): Promise<DiscoveredCorpusContainer> {
  const snapshot = await snapshotSourceTree(absolutePath);
  const manifestPath = path.join(absolutePath, "manifest.json");
  let manifest: Record<string, unknown> | undefined;
  let manifestMalformed = false;
  if (await exists(manifestPath)) {
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      manifestMalformed = true;
    }
  }
  const relevantOverlays = overlays.filter(
    (overlay) => overlay.sourceContainerAlias === folderAlias
  );
  const sourceKind = classifyContainerKind(lane, folderAlias, manifest);
  const integrity = classifyIntegrity({
    lane,
    sourceKind,
    manifest,
    manifestMalformed,
    overlay: relevantOverlays.find(
      (candidate) => candidate.kind === "source-integrity" && candidate.confirmed
    ),
  });
  const nativeSessionId = readString(manifest, "sessionId");
  const files = snapshot.files.map(toSourceFile);
  const inventory: CorpusSourceInventoryRecord = {
    schemaVersion: 1,
    containerId: sha256(
      `${sourceKind}\0${nativeSessionId ?? folderAlias}\0${snapshot.contentHash}`
    ),
    sourceKind,
    folderAlias,
    canonicalSessionIdHash: nativeSessionId
      ? sha256(`session\0${nativeSessionId}`)
      : undefined,
    startedAt: readNumber(manifest, "startedAt"),
    endedAt:
      readNumber(manifest, "stoppedAt") ?? readNumber(manifest, "endedAt"),
    integrity: integrity.value,
    integrityReasons: integrity.reasons,
    admission:
      integrity.value === "complete"
        ? "normalize"
        : integrity.value === "malformed"
          ? "blocked"
          : "review-only",
    sourceTreeHash: snapshot.contentHash,
    files,
    overlayIds: relevantOverlays.map((overlay) => overlay.overlayId).sort(),
  };
  return { absolutePath, inventory, manifest };
}

function classifyContainerKind(
  lane: "recording" | "stt",
  folderAlias: string,
  manifest?: Record<string, unknown>
): CorpusSourceInventoryRecord["sourceKind"] {
  if (lane === "stt" && manifest) return "stt-evaluation-capture";
  if (lane === "recording" && manifest) return "canonical-session";
  if (lane === "recording" && folderAlias.startsWith("session_recording_")) {
    return "derived-sidecar";
  }
  return "orphan";
}

function classifyIntegrity(input: {
  lane: "recording" | "stt";
  sourceKind: CorpusSourceInventoryRecord["sourceKind"];
  manifest?: Record<string, unknown>;
  manifestMalformed: boolean;
  overlay?: CorpusSourceOverlay;
}) {
  if (input.overlay?.integrity) {
    return { value: input.overlay.integrity, reasons: input.overlay.reasons };
  }
  if (input.manifestMalformed) {
    return { value: "malformed" as const, reasons: ["manifest-malformed"] };
  }
  if (input.sourceKind === "derived-sidecar") {
    return { value: "sidecar" as const, reasons: ["derived-sidecar"] };
  }
  if (!input.manifest) {
    return { value: "malformed" as const, reasons: ["manifest-missing"] };
  }
  if (input.lane === "stt") {
    const finalization = asObject(input.manifest.finalization);
    const complete =
      input.manifest.status === "stopped" &&
      finalization?.manifestFinalized === true &&
      finalization?.rawWriterDrained === true;
    return complete
      ? { value: "complete" as const, reasons: [] }
      : { value: "unsealed" as const, reasons: ["stt-capture-not-finalized"] };
  }
  const recordingIntegrity = asObject(input.manifest.recordingIntegrity);
  if (
    input.manifest.status === "stopped" &&
    recordingIntegrity?.status === "complete"
  ) {
    return { value: "complete" as const, reasons: [] };
  }
  if (input.manifest.status === "stopped") {
    return {
      value: "legacy-unverified" as const,
      reasons: ["recording-integrity-field-missing-or-incomplete"],
    };
  }
  return { value: "unsealed" as const, reasons: ["session-not-stopped"] };
}

function toSourceFile(file: SourceTreeFileSnapshot): CorpusSourceFile {
  const format = fileFormat(file.relativePath);
  return {
    relativePath: file.relativePath,
    role: fileRole(file.relativePath, format),
    format,
    bytes: file.bytes,
    sha256: file.sha256,
    parseStatus:
      format === "json" || format === "jsonl" ? "supported" : "unknown-schema",
  };
}

async function readEvidenceJsonLines(
  container: DiscoveredCorpusContainer,
  relativePath: string,
  warnings: string[]
) {
  const absolutePath = path.join(container.absolutePath, relativePath);
  const records: RecordedHumanEvidence[] = [];
  if (!(await exists(absolutePath))) return records;
  for await (const line of streamJsonLines<Record<string, unknown>>(absolutePath)) {
    if (!line.value) {
      warnings.push(`malformed-jsonl:${relativePath}:${line.lineNumber}`);
      continue;
    }
    records.push({
      relativePath,
      lineNumber: line.lineNumber,
      recordHash: line.rawHash,
      payload: line.value,
    });
  }
  return records;
}

async function readLegacyEvaluations(
  container: DiscoveredCorpusContainer,
  warnings: string[]
) {
  const snapshotPath = path.join(
    container.absolutePath,
    "human-evaluation",
    "question-evaluations.json"
  );
  if (!(await exists(snapshotPath))) return [];
  try {
    const payload = JSON.parse(await readFile(snapshotPath, "utf8")) as Record<
      string,
      unknown
    >;
    const evaluations = Array.isArray(payload.evaluations) ? payload.evaluations : [];
    return evaluations
      .filter((value): value is Record<string, unknown> => Boolean(asObject(value)))
      .map((value, index) => ({
        relativePath: "human-evaluation/question-evaluations.json",
        lineNumber: index + 1,
        recordHash: sha256(stableJson(value)),
        payload: value,
      }));
  } catch {
    warnings.push("malformed-json:human-evaluation/question-evaluations.json");
    return [];
  }
}

function parseTranscriptTurn(
  value: Record<string, unknown>,
  line: ParsedJsonLine<Record<string, unknown>>
): RecordedTranscriptTurn | undefined {
  const id = readString(value, "id");
  const speaker = readString(value, "speaker");
  const text = readString(value, "text");
  const startedAt = readNumber(value, "startedAt");
  const endedAt = readNumber(value, "endedAt") ?? startedAt;
  if (!id || !speaker || !text || startedAt === undefined || endedAt === undefined) {
    return undefined;
  }
  return {
    id,
    speaker,
    text,
    startedAt,
    endedAt,
    isFinal: value.isFinal !== false,
    source: readString(value, "source"),
    traceId: readString(value, "traceId"),
    lineNumber: line.lineNumber,
    recordHash: line.rawHash,
  };
}

function parseSettlement(
  payload: Record<string, unknown> | undefined,
  relativePath: string,
  recordHash: string
): RecordedSettlementEvidence | undefined {
  if (!payload) return undefined;
  const question = asObject(payload.currentQuestion);
  if (!question) return undefined;
  const logicalQuestionUnitId = readString(question, "logicalQuestionUnitId");
  const revision = readNumber(question, "revision");
  const normalizedText = readString(question, "normalizedText");
  const traceId = readString(payload, "traceId");
  if (!logicalQuestionUnitId || revision === undefined || !normalizedText || !traceId) {
    return undefined;
  }
  return {
    relativePath,
    recordHash,
    traceId,
    taskId: readString(payload, "taskId"),
    recordedAt: readNumber(payload, "recordedAt") ?? 0,
    currentQuestion: {
      logicalQuestionUnitId,
      revision,
      runtimeEpoch: readNumber(question, "runtimeEpoch"),
      normalizedText,
      sourceTurnIds: readStringArray(question.sourceTurnIds),
      sourceObservationIds: readStringArray(question.sourceObservationIds),
      sourceKind: readString(question, "sourceKind"),
      sourceHash: readString(question, "sourceHash"),
    },
    settlement: asObject(payload.settlement),
    parentBefore: asObject(payload.parentBefore),
    parentAfter: asObject(payload.parentAfter),
  };
}

async function readJsonObject(filePath: string) {
  try {
    return asObject(JSON.parse(await readFile(filePath, "utf8")));
  } catch {
    return undefined;
  }
}

async function walkRegularFiles(root: string, prefix = ""): Promise<string[]> {
  const directory = path.join(root, prefix);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = path.posix.join(prefix.split(path.sep).join(path.posix.sep), entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Symlink source is not allowed: ${path.join(root, relativePath)}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await walkRegularFiles(root, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

async function hashFile(filePath: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

function fileFormat(relativePath: string): CorpusSourceFile["format"] {
  const extension = path.extname(relativePath).toLowerCase();
  if (extension === ".json") return "json";
  if (extension === ".jsonl") return "jsonl";
  if (extension === ".md" || extension === ".txt") return "text";
  if ([".wav", ".mp3", ".m4a", ".flac"].includes(extension)) return "audio";
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(extension)) return "image";
  return "binary";
}

function fileRole(
  relativePath: string,
  format: CorpusSourceFile["format"]
): CorpusSourceFile["role"] {
  if (format === "audio" || format === "image") return "private-binary";
  if (relativePath.startsWith("human-evaluation/") || relativePath.startsWith("references/")) {
    return "human-evidence";
  }
  if (
    relativePath.startsWith("evaluation/") ||
    relativePath.includes("reflection") ||
    relativePath.includes("latest")
  ) {
    return "derived-view";
  }
  if (
    relativePath.startsWith("traces/") ||
    relativePath.startsWith("runtime-inference/") ||
    relativePath.startsWith("semantic/")
  ) {
    return "runtime-observation";
  }
  return "native-source";
}

function isSameOrDescendant(candidate: string, ancestor: string) {
  const relative = path.relative(ancestor, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function exists(filePath: string) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    return isMissingFileError(error) ? false : Promise.reject(error);
  }
}

function isMissingFileError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readString(
  value: Record<string, unknown> | undefined,
  key: string
) {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim()
    : undefined;
}

export function readNumber(
  value: Record<string, unknown> | undefined,
  key: string
) {
  const candidate = value?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : undefined;
}

export function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item))
    : [];
}
