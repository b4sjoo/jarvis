import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PHASE_EVIDENCE_VALUES,
  PHASE_TRANSITION_INTENTS,
  QUESTION_TYPE_LABELS,
  SHOULD_ADVISE_VALUES,
  SPEECH_ACT_LABELS,
  type LocalIntentAnnotationPilotCard,
  type LocalIntentAnnotationPilotManifest,
  type LocalIntentAnnotationProgressReport,
  type LocalIntentAnnotationRecord,
  type LocalIntentAnnotationSubmission,
} from "./local-intent-annotation-schema.js";
import { streamJsonLines } from "./local-intent-corpus-source-reader.js";
import { incrementCount, sha256, stableJson, stableJsonPretty } from "./local-intent-corpus-utils.js";

export interface LocalIntentAnnotationStoreOptions {
  pilotRoot: string;
  annotationRoot: string;
  annotator: string;
  now?: () => number;
}

export class LocalIntentAnnotationStore {
  readonly manifest: LocalIntentAnnotationPilotManifest;
  readonly cards: LocalIntentAnnotationPilotCard[];
  private readonly cardById: Map<string, LocalIntentAnnotationPilotCard>;
  private readonly annotationFile: string;
  private readonly reportFile: string;
  private readonly annotator: string;
  private readonly now: () => number;
  private records: LocalIntentAnnotationRecord[];
  private writeTail: Promise<unknown> = Promise.resolve();

  private constructor(input: {
    manifest: LocalIntentAnnotationPilotManifest;
    cards: LocalIntentAnnotationPilotCard[];
    annotationFile: string;
    reportFile: string;
    annotator: string;
    now: () => number;
    records: LocalIntentAnnotationRecord[];
  }) {
    this.manifest = input.manifest;
    this.cards = input.cards;
    this.cardById = new Map(input.cards.map((card) => [card.cardId, card]));
    this.annotationFile = input.annotationFile;
    this.reportFile = input.reportFile;
    this.annotator = input.annotator;
    this.now = input.now;
    this.records = input.records;
  }

  static async open(options: LocalIntentAnnotationStoreOptions) {
    if (!options.annotator.trim()) throw new Error("Annotation annotator is required.");
    const manifest = JSON.parse(
      await readFile(path.join(options.pilotRoot, "pilot-manifest.json"), "utf8")
    ) as LocalIntentAnnotationPilotManifest;
    const cards = await readJsonLines<LocalIntentAnnotationPilotCard>(
      path.join(options.pilotRoot, "pilot-cards.jsonl")
    );
    const cardsPayload = cards.map((card) => stableJson(card)).join("\n") +
      (cards.length ? "\n" : "");
    if (sha256(cardsPayload) !== manifest.cardsHash) {
      throw new Error("Annotation pilot cards do not match the pilot manifest.");
    }
    await mkdir(options.annotationRoot, { recursive: true, mode: 0o700 });
    const annotationFile = path.join(options.annotationRoot, "annotations.jsonl");
    const reportFile = path.join(options.annotationRoot, "pilot-progress-report.json");
    const records = await readOptionalJsonLines<LocalIntentAnnotationRecord>(annotationFile);
    const cardById = new Map(cards.map((card) => [card.cardId, card]));
    validateStoredRecords(records, manifest, cardById);
    const store = new LocalIntentAnnotationStore({
      manifest,
      cards,
      annotationFile,
      reportFile,
      annotator: options.annotator.trim(),
      now: options.now ?? Date.now,
      records,
    });
    await store.writeProgressReport();
    return store;
  }

  latestRecords(pass?: LocalIntentAnnotationRecord["pass"]) {
    return [...latestRecordMap(this.records, pass).values()].sort(
      (left, right) => left.cardId.localeCompare(right.cardId)
    );
  }

  progress() {
    return buildAnnotationProgressReport({
      manifest: this.manifest,
      cards: this.cards,
      records: this.records,
      now: this.now(),
    });
  }

  async submit(submission: LocalIntentAnnotationSubmission) {
    const operation = this.writeTail.then(async () => {
      const card = this.cardById.get(submission.cardId);
      if (!card) throw new Error("Unknown annotation card.");
      validateSubmission(submission, this.manifest, card);
      const latest = latestRecordMap(this.records).get(
        recordIdentity(submission.cardId, submission.pass)
      );
      const revision = (latest?.revision ?? 0) + 1;
      const submittedAt = submission.interaction.submittedAt || this.now();
      const durationMs = Math.max(
        0,
        submittedAt - submission.interaction.startedAt
      );
      const recordWithoutId: Omit<LocalIntentAnnotationRecord, "annotationId"> = {
        schemaVersion: 1,
        pilotId: submission.pilotId,
        cardId: submission.cardId,
        exampleId: submission.exampleId,
        sourceHash: submission.sourceHash,
        contextHash: submission.contextHash,
        annotator: this.annotator,
        pass: submission.pass,
        revision,
        supersedesAnnotationId: latest?.annotationId,
        status: submission.status,
        labels: submission.status === "confirmed" ? submission.labels : undefined,
        evaluationFacts:
          submission.status === "confirmed" ? submission.evaluationFacts : undefined,
        interaction: {
          startedAt: submission.interaction.startedAt,
          submittedAt,
          durationMs,
        },
      };
      const record: LocalIntentAnnotationRecord = {
        ...recordWithoutId,
        annotationId: sha256(stableJson(recordWithoutId)),
      };
      await appendDurably(this.annotationFile, `${stableJson(record)}\n`);
      this.records.push(record);
      await this.writeProgressReport();
      return record;
    });
    this.writeTail = operation.catch(() => undefined);
    return operation;
  }

  private async writeProgressReport() {
    const temporary = `${this.reportFile}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, stableJsonPretty(this.progress()), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.reportFile);
  }
}

export function validateSubmission(
  submission: LocalIntentAnnotationSubmission,
  manifest: LocalIntentAnnotationPilotManifest,
  card: LocalIntentAnnotationPilotCard
) {
  if (submission.pilotId !== manifest.pilotId || card.pilotId !== manifest.pilotId) {
    throw new Error("Annotation pilot identity mismatch.");
  }
  if (
    submission.exampleId !== card.exampleId ||
    submission.sourceHash !== card.sourceHash ||
    submission.contextHash !== card.contextHash
  ) {
    throw new Error("Annotation source/context identity mismatch.");
  }
  if (!(["initial", "blind-repeat", "adjudication"] as const).includes(submission.pass)) {
    throw new Error("Invalid annotation pass.");
  }
  if (!(["confirmed", "skipped"] as const).includes(submission.status)) {
    throw new Error("Invalid annotation status.");
  }
  if (
    !Number.isFinite(submission.interaction.startedAt) ||
    !Number.isFinite(submission.interaction.submittedAt) ||
    submission.interaction.startedAt < 0 ||
    submission.interaction.submittedAt < submission.interaction.startedAt
  ) {
    throw new Error("Invalid annotation interaction timestamps.");
  }
  if (submission.status === "skipped") {
    if (submission.labels || submission.evaluationFacts) {
      throw new Error("Skipped annotation cannot include labels.");
    }
    return;
  }
  const labels = submission.labels;
  const shouldAdvise = submission.evaluationFacts?.shouldAdvise;
  if (!labels || !shouldAdvise) {
    throw new Error("Confirmed annotation requires all semantic blocks and Should Advise.");
  }
  if (
    labels.speechAct.primary !== "unresolved" &&
    !SPEECH_ACT_LABELS.includes(labels.speechAct.primary)
  ) {
    throw new Error("Invalid primary Speech Act.");
  }
  const secondary = [...new Set(labels.speechAct.secondary)];
  if (
    secondary.length !== labels.speechAct.secondary.length ||
    secondary.some((value) => !SPEECH_ACT_LABELS.includes(value)) ||
    secondary.includes(labels.speechAct.primary as (typeof SPEECH_ACT_LABELS)[number])
  ) {
    throw new Error("Invalid secondary Speech Acts.");
  }
  if (
    labels.questionType !== "unresolved" &&
    !QUESTION_TYPE_LABELS.includes(labels.questionType)
  ) {
    throw new Error("Invalid Question Type.");
  }
  if (
    labels.phaseControl.transitionIntent !== "unresolved" &&
    !PHASE_TRANSITION_INTENTS.includes(labels.phaseControl.transitionIntent)
  ) {
    throw new Error("Invalid Phase Transition Intent.");
  }
  if (
    !PHASE_EVIDENCE_VALUES.includes(labels.phaseControl.assumptionAuthorized) ||
    !PHASE_EVIDENCE_VALUES.includes(labels.phaseControl.requirementsComplete)
  ) {
    throw new Error("Invalid Phase Evidence.");
  }
  if (!SHOULD_ADVISE_VALUES.includes(shouldAdvise)) {
    throw new Error("Invalid Should Advise evaluation fact.");
  }
}

export function buildAnnotationProgressReport(input: {
  manifest: LocalIntentAnnotationPilotManifest;
  cards: LocalIntentAnnotationPilotCard[];
  records: LocalIntentAnnotationRecord[];
  now: number;
}): LocalIntentAnnotationProgressReport {
  const latestInitial = [...latestRecordMap(input.records, "initial").values()];
  const completedCards = latestInitial.filter((record) => record.status === "confirmed");
  const skippedCards = latestInitial.filter((record) => record.status === "skipped");
  const unresolvedCards = completedCards.filter((record) => hasUnresolved(record));
  const counts = {
    speechActCounts: {} as Record<string, number>,
    questionTypeCounts: {} as Record<string, number>,
    transitionIntentCounts: {} as Record<string, number>,
    assumptionAuthorizedCounts: {} as Record<string, number>,
    requirementsCompleteCounts: {} as Record<string, number>,
    shouldAdviseCounts: {} as Record<string, number>,
  };
  for (const record of completedCards) {
    if (!record.labels || !record.evaluationFacts) continue;
    incrementCount(counts.speechActCounts, record.labels.speechAct.primary);
    incrementCount(counts.questionTypeCounts, record.labels.questionType);
    incrementCount(
      counts.transitionIntentCounts,
      record.labels.phaseControl.transitionIntent
    );
    incrementCount(
      counts.assumptionAuthorizedCounts,
      record.labels.phaseControl.assumptionAuthorized
    );
    incrementCount(
      counts.requirementsCompleteCounts,
      record.labels.phaseControl.requirementsComplete
    );
    incrementCount(counts.shouldAdviseCounts, record.evaluationFacts.shouldAdvise);
  }
  const repeatCount = Math.max(1, Math.round(input.cards.length * 0.1));
  const blindRepeatCandidateCardIds = completedCards
    .map((record) => record.cardId)
    .sort((left, right) =>
      sha256(`${input.manifest.pilotId}\0${left}`).localeCompare(
        sha256(`${input.manifest.pilotId}\0${right}`)
      )
    )
    .slice(0, repeatCount);
  return {
    schemaVersion: 1,
    pilotId: input.manifest.pilotId,
    totalCards: input.cards.length,
    completedCards: completedCards.length,
    skippedCards: skippedCards.length,
    unresolvedCards: unresolvedCards.length,
    remainingCards: Math.max(
      0,
      input.cards.length - completedCards.length - skippedCards.length
    ),
    latestRevisionCount: latestRecordMap(input.records).size,
    ...counts,
    blindRepeatCandidateCardIds,
    updatedAt: input.now,
  };
}

function validateStoredRecords(
  records: LocalIntentAnnotationRecord[],
  manifest: LocalIntentAnnotationPilotManifest,
  cardById: Map<string, LocalIntentAnnotationPilotCard>
) {
  const latestByIdentity = new Map<string, LocalIntentAnnotationRecord>();
  const annotationIds = new Set<string>();
  for (const record of records) {
    const card = cardById.get(record.cardId);
    if (!card) {
      throw new Error(`Stored annotation references unknown card ${record.cardId}.`);
    }
    validateSubmission(
      {
        pilotId: record.pilotId,
        cardId: record.cardId,
        exampleId: record.exampleId,
        sourceHash: record.sourceHash,
        contextHash: record.contextHash,
        pass: record.pass,
        status: record.status,
        labels: record.labels,
        evaluationFacts: record.evaluationFacts,
        interaction: {
          startedAt: record.interaction.startedAt,
          submittedAt: record.interaction.submittedAt,
        },
      },
      manifest,
      card
    );
    const { annotationId, ...recordWithoutId } = record;
    if (annotationId !== sha256(stableJson(recordWithoutId))) {
      throw new Error(`Stored annotation hash mismatch for ${record.cardId}.`);
    }
    if (annotationIds.has(annotationId)) {
      throw new Error(`Duplicate stored annotation ${annotationId}.`);
    }
    annotationIds.add(annotationId);
    const identity = recordIdentity(record.cardId, record.pass);
    const previous = latestByIdentity.get(identity);
    const expectedRevision = (previous?.revision ?? 0) + 1;
    if (
      record.revision !== expectedRevision ||
      record.supersedesAnnotationId !== previous?.annotationId
    ) {
      throw new Error(`Broken annotation revision chain for ${identity}.`);
    }
    latestByIdentity.set(identity, record);
  }
}

function latestRecordMap(
  records: LocalIntentAnnotationRecord[],
  pass?: LocalIntentAnnotationRecord["pass"]
) {
  const result = new Map<string, LocalIntentAnnotationRecord>();
  for (const record of records) {
    if (pass && record.pass !== pass) continue;
    const id = recordIdentity(record.cardId, record.pass);
    const current = result.get(id);
    if (!current || record.revision > current.revision) result.set(id, record);
  }
  return result;
}

function recordIdentity(cardId: string, pass: LocalIntentAnnotationRecord["pass"]) {
  return `${cardId}:${pass}`;
}

function hasUnresolved(record: LocalIntentAnnotationRecord) {
  return Boolean(
    record.labels?.speechAct.primary === "unresolved" ||
      record.labels?.questionType === "unresolved" ||
      record.labels?.phaseControl.transitionIntent === "unresolved" ||
      record.labels?.phaseControl.assumptionAuthorized === "unresolved" ||
      record.labels?.phaseControl.requirementsComplete === "unresolved" ||
      record.evaluationFacts?.shouldAdvise === "unresolved"
  );
}

async function appendDurably(filePath: string, payload: string) {
  const handle = await open(filePath, "a", 0o600);
  try {
    await handle.write(payload);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readJsonLines<T>(filePath: string) {
  const rows: T[] = [];
  for await (const row of streamJsonLines<T>(filePath)) {
    if (!row.value) throw new Error(`Malformed JSONL at ${filePath}:${row.lineNumber}.`);
    rows.push(row.value);
  }
  return rows;
}

async function readOptionalJsonLines<T>(filePath: string) {
  try {
    return await readJsonLines<T>(filePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
