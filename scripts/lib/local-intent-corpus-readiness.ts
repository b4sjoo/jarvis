import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { detectTaxonomyEvaluationLanguage } from "../../src/lib/meeting/taxonomy-evaluation.js";
import { normalizeCanonicalQuestionType } from "../../src/lib/meeting/task-taxonomy.js";
import {
  assignGroupedCorpusSplits,
  buildCorpusGroupEdges,
} from "./local-intent-corpus-groups.js";
import {
  buildCorpusLabelLedger,
  normalizeLabelCandidateDisposition,
} from "./local-intent-corpus-labels.js";
import type {
  CorpusBuildManifest,
  CorpusHead,
  CorpusLabelCandidate,
  CorpusQualityReport,
  CorpusReviewQueueItem,
  CorpusSourceOverlay,
  CorpusSplit,
  CorpusSplitAssignmentLock,
  LocalIntentNormalizedExample,
} from "./local-intent-corpus-schema.js";
import {
  asObject,
  assertOutputSeparatedFromSources,
  assertSourceTreeUnchanged,
  discoverCorpusContainers,
  readCorpusOverlays,
  readNumber,
  readSessionCorpusEvidence,
  readSttCorpusEvidence,
  readString,
  readStringArray,
  snapshotSourceTree,
  type DiscoveredCorpusContainer,
  type RecordedHumanEvidence,
  type RecordedSettlementEvidence,
  type RecordedTranscriptTurn,
} from "./local-intent-corpus-source-reader.js";
import {
  incrementCount,
  sha256,
  stableJson,
  stableJsonPretty,
} from "./local-intent-corpus-utils.js";

export const LOCAL_INTENT_CORPUS_BUILDER_REVISION =
  "local-intent-corpus-readiness-v2";

export interface BuildLocalIntentCorpusReadinessOptions {
  recordingsRoot: string;
  sttCapturesRoot: string;
  overlaysPath: string;
  outputRoot: string;
  seed: string;
  cutoff: string;
  now?: number;
}

interface MaterializedCorpus {
  examples: LocalIntentNormalizedExample[];
  candidates: CorpusLabelCandidate[];
  reviewQueue: CorpusReviewQueueItem[];
}

export async function buildLocalIntentCorpusReadiness(
  options: BuildLocalIntentCorpusReadinessOptions
) {
  const sourceRoots = [options.recordingsRoot, options.sttCapturesRoot];
  await assertOutputSeparatedFromSources(options.outputRoot, sourceRoots);
  const cutoffAt = Date.parse(options.cutoff);
  if (!Number.isFinite(cutoffAt)) throw new Error(`Invalid cutoff: ${options.cutoff}`);
  if (!options.seed.trim()) throw new Error("Corpus split seed is required.");

  const beforeSnapshots = await Promise.all(sourceRoots.map(snapshotSourceTree));
  const overlays = await readCorpusOverlays(options.overlaysPath);
  const containers = await discoverCorpusContainers({
    recordingsRoot: options.recordingsRoot,
    sttCapturesRoot: options.sttCapturesRoot,
    overlays,
  });
  const materialized: MaterializedCorpus = {
    examples: [],
    candidates: [],
    reviewQueue: [],
  };

  for (const container of containers) {
    if (container.inventory.sourceKind === "canonical-session") {
      mergeMaterialized(materialized, await materializeSession(container));
    } else if (
      container.inventory.sourceKind === "stt-evaluation-capture"
    ) {
      mergeMaterialized(materialized, await materializeSttCapture(container));
    }
  }
  const exactJoins = applyExactSttSessionJoins(
    dedupeExamples(materialized.examples),
    containers
  );
  materialized.examples = applyExampleGroupOverlays(exactJoins.examples, overlays);
  materialized.candidates = dedupeCandidates(materialized.candidates);

  const labels = buildCorpusLabelLedger({
    exampleIds: materialized.examples.map((example) => example.exampleId),
    candidates: materialized.candidates,
  });
  const edges = buildCorpusGroupEdges(materialized.examples);
  const previousLock = await readPreviousSplitLock(options.outputRoot);
  const splits = assignGroupedCorpusSplits({
    examples: materialized.examples,
    edges,
    seed: options.seed,
    cutoff: options.cutoff,
    previousLock,
  });
  const reviewQueue = dedupeReviewQueue([
    ...materialized.reviewQueue,
    ...labels.reviewQueue,
    ...splits.reviewQueue,
  ]);
  const sourceSnapshotHash = sha256(
    beforeSnapshots.map((snapshot) => snapshot.contentHash).sort().join("\0")
  );
  const qualityReport = buildQualityReport({
    containers,
    examples: materialized.examples,
    candidates: materialized.candidates,
    ledger: labels.ledger,
    reviewQueue,
    splitPlan: splits.plan,
  });
  const automaticOverlays = buildAutomaticSourceOverlays(
    containers,
    exactJoins.overlays
  );
  const outputRecords = {
    "source-inventory.jsonl": containers.map((container) => container.inventory),
    "source-overlays.jsonl": [...overlays, ...automaticOverlays],
    "normalized-examples.jsonl": materialized.examples,
    "label-candidates.jsonl": materialized.candidates,
    "label-ledger.jsonl": labels.ledger,
    "review-queue.jsonl": reviewQueue,
    "group-edges.jsonl": edges,
  };
  const outputJson = {
    "split-plan.json": splits.plan,
    "split-assignment-lock.json": splits.lock,
    "quality-report.json": qualityReport,
  };
  const configHash = sha256(
    stableJson({
      builderRevision: LOCAL_INTENT_CORPUS_BUILDER_REVISION,
      seed: options.seed,
      cutoff: options.cutoff,
      overlaysHash: sha256(stableJson(overlays)),
    })
  );
  const buildId = sha256(
    `${LOCAL_INTENT_CORPUS_BUILDER_REVISION}\0${configHash}\0${sourceSnapshotHash}`
  );
  const manifest = await publishCorpusBuild({
    outputRoot: options.outputRoot,
    outputRecords,
    outputJson,
    manifestBase: {
      schemaVersion: 1,
      builderRevision: LOCAL_INTENT_CORPUS_BUILDER_REVISION,
      seed: options.seed,
      cutoff: options.cutoff,
      sourceSnapshotHash,
      configHash,
      buildId,
    },
    runMetadata: {
      schemaVersion: 1,
      generatedAt: options.now ?? Date.now(),
      buildId,
      sourceCount: containers.length,
      exampleCount: materialized.examples.length,
    },
    verifySources: async () => {
      const afterSnapshots = await Promise.all(sourceRoots.map(snapshotSourceTree));
      for (let index = 0; index < beforeSnapshots.length; index += 1) {
        assertSourceTreeUnchanged(beforeSnapshots[index], afterSnapshots[index]);
      }
    },
  });
  return {
    buildId,
    manifest,
    qualityReport,
    sourceCount: containers.length,
    exampleCount: materialized.examples.length,
    reviewItemCount: reviewQueue.length,
  };
}

async function materializeSession(
  container: DiscoveredCorpusContainer
): Promise<MaterializedCorpus> {
  const evidence = await readSessionCorpusEvidence(container);
  const examples: LocalIntentNormalizedExample[] = [];
  const candidates: CorpusLabelCandidate[] = [];
  const reviewQueue: CorpusReviewQueueItem[] = [];
  const sessionHash =
    container.inventory.canonicalSessionIdHash ??
    sha256(`container-session\0${container.inventory.containerId}`);
  const turnsById = new Map(evidence.turns.map((turn) => [turn.id, turn]));
  const usedTurnIds = new Set<string>();
  const settlementsByUnit = new Map<string, RecordedSettlementEvidence[]>();
  for (const settlement of evidence.settlements) {
    const key = `${settlement.currentQuestion.logicalQuestionUnitId}:${settlement.currentQuestion.revision}`;
    const current = settlementsByUnit.get(key) ?? [];
    current.push(settlement);
    settlementsByUnit.set(key, current);
  }

  for (const [unitKey, settlements] of [...settlementsByUnit.entries()].sort()) {
    const ordered = [...settlements].sort(
      (left, right) =>
        left.recordedAt - right.recordedAt || left.traceId.localeCompare(right.traceId)
    );
    const selected = ordered[ordered.length - 1];
    const conflict = ordered.some(
      (candidate) =>
        candidate.currentQuestion.normalizedText !==
          selected.currentQuestion.normalizedText ||
        readString(candidate.settlement, "questionType") !==
          readString(selected.settlement, "questionType")
    );
    const sourceTurns = selected.currentQuestion.sourceTurnIds
      .map((turnId) => turnsById.get(turnId))
      .filter((turn): turn is RecordedTranscriptTurn => Boolean(turn));
    const exactTurns =
      sourceTurns.length === selected.currentQuestion.sourceTurnIds.length;
    for (const turn of sourceTurns) usedTurnIds.add(turn.id);
    const hasScreenEvidence =
      selected.currentQuestion.sourceObservationIds.length > 0;
    const exactSource = exactTurns &&
      (sourceTurns.length > 0 || hasScreenEvidence);
    const createdAt =
      sourceTurns.at(-1)?.endedAt ?? selected.recordedAt ?? 0;
    const exampleId = sha256(`example\0${sessionHash}\0${unitKey}`);
    const lquHash = sha256(
      `lqu\0${sessionHash}\0${selected.currentQuestion.logicalQuestionUnitId}`
    );
    const rootGroupId = sha256(`root\0${lquHash}`);
    const traceHashes = ordered.map((item) => sha256(`trace\0${item.traceId}`));
    const previousTurn = findPreviousInterviewerTurn(
      evidence.turns,
      sourceTurns[0]?.startedAt ?? createdAt
    );
    const example: LocalIntentNormalizedExample = {
      schemaVersion: 1,
      exampleId,
      sourceUnitId: sha256(`unit\0${sessionHash}\0${unitKey}`),
      unitKind: "lqu-revision",
      sourceKind: "session-recording",
      sourceText: selected.currentQuestion.normalizedText,
      semanticText: selected.currentQuestion.normalizedText,
      language: detectTaxonomyEvaluationLanguage(
        selected.currentQuestion.normalizedText
      ),
      modality: inferModality(selected.currentQuestion.sourceKind, hasScreenEvidence),
      createdAt,
      provenance: {
        sessionIdHash: sessionHash,
        logicalQuestionUnitIdHash: lquHash,
        logicalQuestionRevision: selected.currentQuestion.revision,
        runtimeEpoch: selected.currentQuestion.runtimeEpoch,
        currentTurnIdHash: sourceTurns.at(-1)
          ? sha256(`turn\0${sourceTurns.at(-1)?.id}`)
          : undefined,
        orderedSourceTurnIdHashes: selected.currentQuestion.sourceTurnIds.map(
          (turnId) => sha256(`turn\0${turnId}`)
        ),
        sourceObservationIdHashes:
          selected.currentQuestion.sourceObservationIds.map((observationId) =>
            sha256(`observation\0${observationId}`)
          ),
        sourceTraceIdHashes: traceHashes,
        sourceRefs: ordered.map((item) => ({
          containerId: container.inventory.containerId,
          relativePath: item.relativePath,
          pointer: "/currentQuestion",
          recordHash: item.recordHash,
        })),
        materialization: exactSource
          ? "recorded-exact"
          : "replayed-candidate",
      },
      boundedContext: {
        activeParentType: readString(selected.parentBefore, "questionType"),
        previousInterviewerText: previousTurn?.text,
      },
      grouping: defaultGrouping(sessionHash, rootGroupId),
      eligibility:
        conflict || !exactSource
          ? "review-only"
          : container.inventory.integrity === "complete"
            ? "train-candidate"
            : "review-only",
    };
    examples.push(example);
    if (conflict) {
      reviewQueue.push(
        reviewItem(exampleId, "question-type", "weak-conflict", 0, [])
      );
    }
    const settlementType = normalizeCanonicalQuestionType(
      readString(selected.settlement, "questionType")
    );
    if (settlementType) {
      candidates.push(
        normalizeLabelCandidateDisposition({
          schemaVersion: 1,
          candidateId: sha256(`settlement-label\0${exampleId}\0${settlementType}`),
          exampleId,
          head: "question-type",
          value: settlementType,
          applicability: "applicable",
          authority: "runtime-observed",
          confirmation: "none",
          sourceJoin: exactSource ? "exact-lqu" : "partial",
          sourceIntegrity: container.inventory.integrity,
          supportingEventIds: traceHashes,
          conflictIds: [],
        })
      );
    }
  }

  for (const turn of evidence.turns) {
    if (
      usedTurnIds.has(turn.id) ||
      turn.speaker !== "them" ||
      !turn.isFinal ||
      !turn.text.trim()
    ) {
      continue;
    }
    const exampleId = sha256(`turn-example\0${sessionHash}\0${turn.id}`);
    const rootGroupId = sha256(`root-turn\0${sessionHash}\0${turn.id}`);
    examples.push({
      schemaVersion: 1,
      exampleId,
      sourceUnitId: sha256(`turn-unit\0${sessionHash}\0${turn.id}`),
      unitKind: "utterance",
      sourceKind: "session-recording",
      sourceText: turn.text,
      semanticText: turn.text,
      language: detectTaxonomyEvaluationLanguage(turn.text),
      modality: "voice",
      createdAt: turn.endedAt,
      provenance: {
        sessionIdHash: sessionHash,
        currentTurnIdHash: sha256(`turn\0${turn.id}`),
        orderedSourceTurnIdHashes: [sha256(`turn\0${turn.id}`)],
        sourceObservationIdHashes: [],
        sourceTraceIdHashes: turn.traceId
          ? [sha256(`trace\0${turn.traceId}`)]
          : [],
        sourceRefs: [
          {
            containerId: container.inventory.containerId,
            relativePath: "transcripts/turns.jsonl",
            pointer: `line:${turn.lineNumber}`,
            recordHash: turn.recordHash,
          },
        ],
        materialization: "single-turn-exact",
      },
      boundedContext: {
        previousInterviewerText: findPreviousInterviewerTurn(
          evidence.turns,
          turn.startedAt
        )?.text,
      },
      grouping: defaultGrouping(sessionHash, rootGroupId),
      eligibility:
        container.inventory.integrity === "complete"
          ? "train-candidate"
          : "review-only",
    });
  }

  const indexes = buildSessionExampleIndexes(examples, evidence.settlements);
  candidates.push(
    ...materializeHumanCandidates({
      humanEvidence: evidence.humanGroundTruth,
      legacyEvidence: evidence.legacyEvaluations,
      examples,
      indexes,
      integrity: container.inventory.integrity,
    })
  );
  for (const warning of evidence.warnings) {
    const exampleId = examples[0]?.exampleId;
    if (!exampleId) continue;
    reviewQueue.push(
      reviewItem(exampleId, undefined, "missing-source-join", 2, [sha256(warning)])
    );
  }
  return { examples, candidates, reviewQueue };
}

async function materializeSttCapture(
  container: DiscoveredCorpusContainer
): Promise<MaterializedCorpus> {
  const evidence = await readSttCorpusEvidence(container);
  const sessionHash =
    container.inventory.canonicalSessionIdHash ??
    sha256(`stt-session\0${container.inventory.containerId}`);
  const examples: LocalIntentNormalizedExample[] = [];
  const variantByAlias = new Map<string, string>();

  for (const record of evidence.canonicalTurns) {
    const payload = asObject(record.payload.payload) ?? record.payload;
    const turn = asObject(payload.turn);
    const text = readString(payload, "canonicalText") ?? readString(turn, "text");
    const utteranceId =
      readString(payload, "utteranceId") ?? readString(turn, "id");
    if (!text || !utteranceId) continue;
    const aliases = sttVariantAliases(payload, utteranceId);
    const variantGroupId = sha256(
      `stt-variant\0${sessionHash}\0${aliases[0] ?? utteranceId}`
    );
    for (const alias of aliases) variantByAlias.set(alias, variantGroupId);
    examples.push(
      makeSttExample({
        container,
        record,
        sessionHash,
        utteranceId,
        variantGroupId,
        text,
        traceId: readString(payload, "traceId"),
        currentTurnId: readString(turn, "id"),
        createdAt:
          readNumber(payload, "recordedAt") ??
          readNumber(record.payload, "recordedAt") ??
          0,
        variantKind: "canonical",
      })
    );
  }

  for (const record of evidence.providerAttempts) {
    const payload = asObject(record.payload.payload) ?? record.payload;
    const text = readString(payload, "rawText");
    const utteranceId = readString(payload, "utteranceId");
    if (!text || !utteranceId) continue;
    const aliases = sttVariantAliases(payload, utteranceId);
    const variantGroupId =
      aliases.map((alias) => variantByAlias.get(alias)).find(Boolean) ??
      sha256(`stt-variant\0${sessionHash}\0${aliases[0] ?? utteranceId}`);
    for (const alias of aliases) variantByAlias.set(alias, variantGroupId);
    examples.push(
      makeSttExample({
        container,
        record,
        sessionHash,
        utteranceId,
        variantGroupId,
        text,
        traceId: readString(payload, "traceId"),
        currentTurnId: readString(payload, "turnId"),
        createdAt:
          readNumber(payload, "receivedAt") ??
          readNumber(record.payload, "recordedAt") ??
          0,
        variantKind: `provider:${readString(payload, "attemptId") ?? record.lineNumber}`,
      })
    );
  }

  for (const record of evidence.humanReferences) {
    const payload = asObject(record.payload.payload) ?? record.payload;
    const text = readString(payload, "referenceText");
    const utteranceId = readString(payload, "utteranceId");
    if (!text || !utteranceId) continue;
    const variantGroupId =
      variantByAlias.get(`utterance:${utteranceId}`) ??
      sha256(`stt-variant\0${sessionHash}\0${utteranceId}`);
    examples.push(
      makeSttExample({
        container,
        record,
        sessionHash,
        utteranceId,
        variantGroupId,
        text,
        currentTurnId: undefined,
        traceId: undefined,
        createdAt:
          readNumber(payload, "confirmedAt") ??
          readNumber(record.payload, "recordedAt") ??
          0,
        variantKind: "human-reference",
      })
    );
  }

  const reviewQueue = evidence.warnings.length && examples[0]
    ? evidence.warnings.map((warning) =>
        reviewItem(
          examples[0].exampleId,
          undefined,
          "missing-source-join",
          2,
          [sha256(warning)]
        )
      )
    : [];
  return { examples, candidates: [], reviewQueue };
}

function makeSttExample(input: {
  container: DiscoveredCorpusContainer;
  record: RecordedHumanEvidence;
  sessionHash: string;
  utteranceId: string;
  variantGroupId: string;
  text: string;
  currentTurnId?: string;
  traceId?: string;
  createdAt: number;
  variantKind: string;
}): LocalIntentNormalizedExample {
  const rootGroupId = input.variantGroupId;
  return {
    schemaVersion: 1,
    exampleId: sha256(
      `stt-example\0${input.sessionHash}\0${input.utteranceId}\0${input.variantKind}`
    ),
    sourceUnitId: sha256(
      `stt-unit\0${input.sessionHash}\0${input.utteranceId}\0${input.variantKind}`
    ),
    unitKind: "utterance",
    sourceKind: "stt-evaluation-capture",
    sourceText: input.text,
    semanticText: input.text,
    language: detectTaxonomyEvaluationLanguage(input.text),
    modality: "voice",
    createdAt: input.createdAt,
    provenance: {
      sessionIdHash: input.sessionHash,
      currentTurnIdHash: input.currentTurnId
        ? sha256(`turn\0${input.currentTurnId}`)
        : sha256(`stt-utterance\0${input.utteranceId}`),
      orderedSourceTurnIdHashes: [],
      sourceObservationIdHashes: [],
      sourceTraceIdHashes: input.traceId
        ? [sha256(`trace\0${input.traceId}`)]
        : [],
      sourceRefs: [
        {
          containerId: input.container.inventory.containerId,
          relativePath: input.record.relativePath,
          pointer: `line:${input.record.lineNumber}`,
          recordHash: input.record.recordHash,
        },
      ],
      materialization: "stt-canonical",
    },
    grouping: {
      ...defaultGrouping(input.sessionHash, rootGroupId),
      sttVariantGroupId: input.variantGroupId,
    },
    eligibility: "inference-eval-only",
  };
}

function materializeHumanCandidates(input: {
  humanEvidence: RecordedHumanEvidence[];
  legacyEvidence: RecordedHumanEvidence[];
  examples: LocalIntentNormalizedExample[];
  indexes: ReturnType<typeof buildSessionExampleIndexes>;
  integrity: CorpusLabelCandidate["sourceIntegrity"];
}) {
  const candidates: CorpusLabelCandidate[] = [];
  const superseded = new Set(
    input.humanEvidence
      .map((record) => readString(record.payload, "supersedesEventId"))
      .filter((value): value is string => Boolean(value))
  );
  for (const record of input.humanEvidence) {
    const eventId = readString(record.payload, "eventId") ?? record.recordHash;
    if (superseded.has(eventId)) continue;
    const fact = asObject(record.payload.fact);
    const kind = readString(fact, "kind");
    if (kind !== "expected-question-type" && kind !== "expected-task-settlement") {
      continue;
    }
    const questionType = normalizeCanonicalQuestionType(
      readString(fact, "expectedQuestionType")
    );
    if (!questionType) continue;
    const subject = asObject(record.payload.subject);
    const sourceTurnIds = readStringArray(subject?.sourceTurnIds);
    const traceIds = readStringArray(subject?.traceIds);
    const match = resolveHumanEvidenceExample({
      sourceTurnIds,
      traceIds,
      recordedAt: readNumber(asObject(record.payload.provenance), "recordedAt"),
      examples: input.examples,
      indexes: input.indexes,
    });
    if (!match.example) continue;
    const provenance = asObject(record.payload.provenance);
    const source = readString(provenance, "source");
    candidates.push(
      normalizeLabelCandidateDisposition({
        schemaVersion: 1,
        candidateId: sha256(`human-label\0${eventId}\0question-type`),
        exampleId: match.example.exampleId,
        head: "question-type",
        value: questionType,
        applicability: "applicable",
        authority:
          source === "manual-type-correction"
            ? "manual-correction"
            : "human-confirmed",
        confirmation:
          readString(record.payload, "confirmation") === "confirmed"
            ? "confirmed"
            : "suggested",
        sourceJoin: match.join,
        sourceIntegrity: input.integrity,
        supportingEventIds: [sha256(`human-event\0${eventId}`)],
        conflictIds: [],
      })
    );
  }

  for (const record of input.legacyEvidence) {
    const questionType = normalizeCanonicalQuestionType(
      readString(record.payload, "correctedQuestionType") ??
        readString(record.payload, "questionType")
    );
    if (!questionType) continue;
    const traceId = extractTraceId(readString(record.payload, "questionId"));
    const match = resolveHumanEvidenceExample({
      sourceTurnIds: [],
      traceIds: traceId ? [traceId] : [],
      recordedAt: readNumber(record.payload, "createdAt"),
      examples: input.examples,
      indexes: input.indexes,
    });
    if (!match.example) continue;
    candidates.push(
      normalizeLabelCandidateDisposition({
        schemaVersion: 1,
        candidateId: sha256(`legacy-label\0${record.recordHash}`),
        exampleId: match.example.exampleId,
        head: "question-type",
        value: questionType,
        applicability: "applicable",
        authority: "legacy-human",
        confirmation: "suggested",
        sourceJoin: match.join,
        sourceIntegrity: input.integrity,
        supportingEventIds: [record.recordHash],
        conflictIds: [],
      })
    );
  }
  return candidates;
}

function buildSessionExampleIndexes(
  examples: LocalIntentNormalizedExample[],
  settlements: RecordedSettlementEvidence[]
) {
  const byTurnId = new Map<string, LocalIntentNormalizedExample[]>();
  const byTraceId = new Map<string, LocalIntentNormalizedExample[]>();
  for (const example of examples) {
    for (const turnHash of example.provenance.orderedSourceTurnIdHashes) {
      const current = byTurnId.get(turnHash) ?? [];
      current.push(example);
      byTurnId.set(turnHash, current);
    }
  }
  const byLqu = new Map(
    examples
      .filter((example) => example.provenance.logicalQuestionUnitIdHash)
      .map((example) => [
        `${example.provenance.logicalQuestionUnitIdHash}:${example.provenance.logicalQuestionRevision}`,
        example,
      ])
  );
  for (const settlement of settlements) {
    const key = `${sha256(
      `lqu\0${examples[0]?.provenance.sessionIdHash ?? ""}\0${
        settlement.currentQuestion.logicalQuestionUnitId
      }`
    )}:${settlement.currentQuestion.revision}`;
    const example = byLqu.get(key);
    if (!example) continue;
    const current = byTraceId.get(settlement.traceId) ?? [];
    current.push(example);
    byTraceId.set(settlement.traceId, current);
  }
  return { byTurnId, byTraceId };
}

function resolveHumanEvidenceExample(input: {
  sourceTurnIds: string[];
  traceIds: string[];
  recordedAt?: number;
  examples: LocalIntentNormalizedExample[];
  indexes: ReturnType<typeof buildSessionExampleIndexes>;
}): {
  example?: LocalIntentNormalizedExample;
  join: CorpusLabelCandidate["sourceJoin"];
} {
  if (input.sourceTurnIds.length) {
    const matches = intersectExamples(
      input.sourceTurnIds.map(
        (turnId) => input.indexes.byTurnId.get(sha256(`turn\0${turnId}`)) ?? []
      )
    );
    if (matches.length === 1) return { example: matches[0], join: "exact-turn" };
  }
  const traceMatches = [
    ...new Map(
      input.traceIds
        .flatMap((traceId) => input.indexes.byTraceId.get(traceId) ?? [])
        .map((example) => [example.exampleId, example])
    ).values(),
  ];
  if (traceMatches.length === 1) {
    return { example: traceMatches[0], join: "exact-lqu" };
  }
  const recordedAt = input.recordedAt;
  if (recordedAt !== undefined) {
    const prior = input.examples
      .filter(
        (example) =>
          example.createdAt <= recordedAt &&
          recordedAt - example.createdAt <= 120_000
      )
      .sort((left, right) => right.createdAt - left.createdAt)[0];
    if (prior) return { example: prior, join: "timestamp" };
  }
  return { join: "missing" };
}

function intersectExamples(groups: LocalIntentNormalizedExample[][]) {
  if (!groups.length) return [];
  const remaining = new Map(groups[0].map((example) => [example.exampleId, example]));
  for (const group of groups.slice(1)) {
    const ids = new Set(group.map((example) => example.exampleId));
    for (const id of remaining.keys()) if (!ids.has(id)) remaining.delete(id);
  }
  return [...remaining.values()];
}

function defaultGrouping(sessionHash: string, rootGroupId: string) {
  return {
    rootGroupId,
    sessionGroupId: sha256(`session-group\0${sessionHash}`),
    interviewGroupId: sha256(`interview-singleton\0${sessionHash}`),
    problemFamilyId: sha256(`problem-singleton\0${rootGroupId}`),
  };
}

function findPreviousInterviewerTurn(
  turns: RecordedTranscriptTurn[],
  before: number
) {
  return [...turns]
    .filter((turn) => turn.speaker === "them" && turn.endedAt < before)
    .sort((left, right) => right.endedAt - left.endedAt)[0];
}

function inferModality(
  sourceKind: string | undefined,
  hasScreenEvidence: boolean
): LocalIntentNormalizedExample["modality"] {
  if (sourceKind === "screen" && !hasScreenEvidence) return "screen";
  if (hasScreenEvidence && sourceKind && sourceKind !== "screen") return "mixed";
  return hasScreenEvidence ? "screen" : "voice";
}

function extractTraceId(questionId?: string) {
  return questionId?.startsWith("trace:") ? questionId.slice("trace:".length) : undefined;
}

function sttVariantAliases(payload: Record<string, unknown>, utteranceId: string) {
  const aliases = [`utterance:${utteranceId}`];
  const traceId = readString(payload, "traceId");
  const audioSessionId = readString(payload, "audioSessionId");
  const sequence = readNumber(payload, "audioSegmentSequence");
  if (traceId && audioSessionId && sequence !== undefined) {
    aliases.unshift(`segment:${traceId}:${audioSessionId}:${sequence}`);
  }
  const turnId = readString(payload, "turnId") ?? readString(asObject(payload.turn), "id");
  if (turnId) aliases.push(`turn:${turnId}`);
  return aliases;
}

function applyExactSttSessionJoins(
  examples: LocalIntentNormalizedExample[],
  containers: DiscoveredCorpusContainer[]
) {
  const sessionByTurn = new Map<string, LocalIntentNormalizedExample[]>();
  for (const example of examples) {
    if (example.sourceKind !== "session-recording") continue;
    const turnIdHash = example.provenance.currentTurnIdHash;
    if (!turnIdHash) continue;
    const current = sessionByTurn.get(turnIdHash) ?? [];
    current.push(example);
    sessionByTurn.set(turnIdHash, current);
  }
  const aliasByContainer = new Map(
    containers.map((container) => [
      container.inventory.containerId,
      container.inventory.folderAlias,
    ])
  );
  const joinPairs = new Map<
    string,
    { sourceAlias: string; targetAlias: string; sourceId: string; targetId: string }
  >();
  const joined = examples.map((example) => {
    if (example.sourceKind !== "stt-evaluation-capture") return example;
    const turnIdHash = example.provenance.currentTurnIdHash;
    if (!turnIdHash) return example;
    const matches = sessionByTurn.get(turnIdHash) ?? [];
    if (matches.length !== 1) return example;
    const target = matches[0];
    const sourceContainerId = example.provenance.sourceRefs[0]?.containerId;
    const targetContainerId = target.provenance.sourceRefs[0]?.containerId;
    const sourceAlias = sourceContainerId
      ? aliasByContainer.get(sourceContainerId)
      : undefined;
    const targetAlias = targetContainerId
      ? aliasByContainer.get(targetContainerId)
      : undefined;
    if (sourceAlias && targetAlias && sourceContainerId && targetContainerId) {
      joinPairs.set(`${sourceContainerId}:${targetContainerId}`, {
        sourceAlias,
        targetAlias,
        sourceId: sourceContainerId,
        targetId: targetContainerId,
      });
    }
    return {
      ...example,
      grouping: {
        ...example.grouping,
        rootGroupId: target.grouping.rootGroupId,
        sessionGroupId: target.grouping.sessionGroupId,
        interviewGroupId: target.grouping.interviewGroupId,
        problemFamilyId: target.grouping.problemFamilyId,
      },
    };
  });
  const overlays: CorpusSourceOverlay[] = [...joinPairs.values()]
    .map((pair) => ({
      schemaVersion: 1 as const,
      overlayId: sha256(`exact-stt-session-join\0${pair.sourceId}\0${pair.targetId}`),
      kind: "container-join" as const,
      sourceContainerAlias: pair.sourceAlias,
      targetContainerAlias: pair.targetAlias,
      confirmed: true,
      reasons: ["unique-canonical-turn-id-match"],
    }))
    .sort((left, right) => left.overlayId.localeCompare(right.overlayId));
  return { examples: joined, overlays };
}

function applyExampleGroupOverlays(
  examples: LocalIntentNormalizedExample[],
  overlays: CorpusSourceOverlay[]
) {
  const overlaysByExample = new Map(
    overlays
      .filter(
        (overlay) =>
          overlay.kind === "example-group" &&
          overlay.confirmed &&
          Boolean(overlay.exampleId)
      )
      .map((overlay) => [overlay.exampleId as string, overlay])
  );
  return examples.map((example) => {
    const overlay = overlaysByExample.get(example.exampleId);
    if (!overlay) return example;
    return {
      ...example,
      grouping: {
        ...example.grouping,
        rootGroupId: overlay.rootGroupId ?? example.grouping.rootGroupId,
        interviewGroupId:
          overlay.interviewGroupId ?? example.grouping.interviewGroupId,
        problemFamilyId:
          overlay.problemFamilyId ?? example.grouping.problemFamilyId,
      },
    };
  });
}

function dedupeExamples(examples: LocalIntentNormalizedExample[]) {
  const byId = new Map<string, LocalIntentNormalizedExample>();
  for (const example of examples) {
    const existing = byId.get(example.exampleId);
    if (existing && stableJson(existing) !== stableJson(example)) {
      byId.set(example.exampleId, {
        ...existing,
        eligibility: "blocked",
      });
    } else if (!existing) {
      byId.set(example.exampleId, example);
    }
  }
  return [...byId.values()].sort((left, right) =>
    left.exampleId.localeCompare(right.exampleId)
  );
}

function dedupeCandidates(candidates: CorpusLabelCandidate[]) {
  return [...new Map(candidates.map((candidate) => [candidate.candidateId, candidate])).values()].sort(
    (left, right) => left.candidateId.localeCompare(right.candidateId)
  );
}

function dedupeReviewQueue(items: CorpusReviewQueueItem[]) {
  return [...new Map(items.map((item) => [item.itemId, item])).values()].sort(
    (left, right) => left.priority - right.priority || left.itemId.localeCompare(right.itemId)
  );
}

function mergeMaterialized(target: MaterializedCorpus, source: MaterializedCorpus) {
  target.examples.push(...source.examples);
  target.candidates.push(...source.candidates);
  target.reviewQueue.push(...source.reviewQueue);
}

function buildAutomaticSourceOverlays(
  containers: DiscoveredCorpusContainer[],
  exactJoinOverlays: CorpusSourceOverlay[]
): CorpusSourceOverlay[] {
  const integrityOverlays = containers
    .filter((container) => container.inventory.integrity !== "complete")
    .map((container) => ({
      schemaVersion: 1 as const,
      overlayId: sha256(`auto-source-overlay\0${container.inventory.containerId}`),
      kind: "source-integrity" as const,
      sourceContainerAlias: container.inventory.folderAlias,
      integrity: container.inventory.integrity,
      confirmed: false,
      reasons: container.inventory.integrityReasons,
    }))
    .sort((left, right) => left.overlayId.localeCompare(right.overlayId));
  const candidateSidecarJoins: CorpusSourceOverlay[] = [];
  for (const sidecar of containers.filter(
    (container) => container.inventory.sourceKind === "derived-sidecar"
  )) {
    const target = containers.find(
      (container) =>
        container.inventory.sourceKind === "canonical-session" &&
        readString(container.manifest, "sessionId") ===
          sidecar.inventory.folderAlias
    );
    if (!target) continue;
    candidateSidecarJoins.push({
      schemaVersion: 1,
      overlayId: sha256(
        `candidate-sidecar-join\0${sidecar.inventory.containerId}\0${target.inventory.containerId}`
      ),
      kind: "container-join",
      sourceContainerAlias: sidecar.inventory.folderAlias,
      targetContainerAlias: target.inventory.folderAlias,
      confirmed: false,
      reasons: ["sidecar-folder-equals-native-session-id-without-own-manifest"],
    });
  }
  return [...integrityOverlays, ...candidateSidecarJoins, ...exactJoinOverlays].sort(
    (left, right) => left.overlayId.localeCompare(right.overlayId)
  );
}

function buildQualityReport(input: {
  containers: DiscoveredCorpusContainer[];
  examples: LocalIntentNormalizedExample[];
  candidates: CorpusLabelCandidate[];
  ledger: ReturnType<typeof buildCorpusLabelLedger>["ledger"];
  reviewQueue: CorpusReviewQueueItem[];
  splitPlan: ReturnType<typeof assignGroupedCorpusSplits>["plan"];
}): CorpusQualityReport {
  const sourceIntegrityCounts: Record<string, number> = {};
  for (const container of input.containers) {
    incrementCount(sourceIntegrityCounts, container.inventory.integrity);
  }
  const exampleEligibilityCounts: Record<string, number> = {};
  for (const example of input.examples) {
    incrementCount(exampleEligibilityCounts, example.eligibility);
  }
  const heads: CorpusHead[] = ["speech-act", "question-type", "phase-signal"];
  const headStateCounts = Object.fromEntries(
    heads.map((head) => [head, {} as Record<string, number>])
  ) as CorpusQualityReport["headStateCounts"];
  const goldClassCounts = Object.fromEntries(
    heads.map((head) => [head, {} as Record<string, number>])
  ) as CorpusQualityReport["goldClassCounts"];
  const usableSplitCountsByHead = Object.fromEntries(
    heads.map((head) => [head, emptyUsableSplitCounts()])
  ) as CorpusQualityReport["usableSplitCountsByHead"];
  for (const row of input.ledger) {
    for (const head of heads) {
      const resolution = row.heads[head];
      incrementCount(headStateCounts[head], resolution.state);
      if (resolution.state === "gold" && resolution.value) {
        incrementCount(goldClassCounts[head], resolution.value);
      }
      const assignedSplit = input.splitPlan.exampleAssignments[row.exampleId];
      const usableSplit =
        assignedSplit &&
        resolution.lossEligible &&
        resolution.eligibleSplits.includes(assignedSplit)
          ? assignedSplit
          : "excluded";
      usableSplitCountsByHead[head][usableSplit] += 1;
    }
  }
  const goldQuestionCount = Object.values(goldClassCounts["question-type"]).reduce(
    (sum, count) => sum + count,
    0
  );
  const speechActGoldCount = Object.values(goldClassCounts["speech-act"]).reduce(
    (sum, count) => sum + count,
    0
  );
  const phaseGoldCount = Object.values(goldClassCounts["phase-signal"]).reduce(
    (sum, count) => sum + count,
    0
  );
  const infrastructureGo =
    input.splitPlan.overlapViolations.length === 0 &&
    input.splitPlan.blockedComponents.length === 0;
  const reasons = [
    ...(goldQuestionCount < 75
      ? [`question-type gold coverage is ${goldQuestionCount}, below training readiness`]
      : []),
    ...(speechActGoldCount === 0 ? ["speech-act human truth is absent"] : []),
    ...(phaseGoldCount === 0 ? ["phase-signal human truth is absent"] : []),
    ...(input.splitPlan.overlapViolations.length
      ? ["group overlap exists across splits"]
      : []),
    ...(input.splitPlan.blockedComponents.length
      ? ["locked split components conflict"]
      : []),
  ];
  return {
    schemaVersion: 1,
    sourceCount: input.containers.length,
    exampleCount: input.examples.length,
    labelCandidateCount: input.candidates.length,
    reviewItemCount: input.reviewQueue.length,
    sourceIntegrityCounts,
    exampleEligibilityCounts,
    headStateCounts,
    goldClassCounts,
    splitCounts: input.splitPlan.splitCounts,
    usableSplitCountsByHead,
    overlapViolationCount: input.splitPlan.overlapViolations.length,
    sourceMutationDetected: false,
    goNoGo: {
      corpusInfrastructure: infrastructureGo ? "go" : "no-go",
      questionTypeFrozenHead:
        infrastructureGo && goldQuestionCount >= 5 ? "conditional-go" : "no-go",
      threeHeadTraining:
        infrastructureGo &&
        goldQuestionCount >= 75 &&
        speechActGoldCount >= 75 &&
        phaseGoldCount >= 75
          ? "go"
          : "no-go",
      restrictedEnforcement: "no-go",
      reasons,
    },
  };
}

function emptyUsableSplitCounts(): Record<CorpusSplit | "excluded", number> {
  return {
    train: 0,
    dev: 0,
    calibration: 0,
    "sealed-test": 0,
    "rolling-eval": 0,
    excluded: 0,
  };
}

async function publishCorpusBuild(input: {
  outputRoot: string;
  outputRecords: Record<string, unknown[]>;
  outputJson: Record<string, unknown>;
  manifestBase: Omit<CorpusBuildManifest, "outputs">;
  runMetadata: Record<string, unknown>;
  verifySources: () => Promise<void>;
}) {
  const outputRoot = path.resolve(input.outputRoot);
  const parent = path.dirname(outputRoot);
  await mkdir(parent, { recursive: true });
  const staging = path.join(
    parent,
    `.${path.basename(outputRoot)}.staging-${process.pid}-${Date.now()}`
  );
  await mkdir(staging, { recursive: false });
  try {
    const outputMetadata: CorpusBuildManifest["outputs"] = [];
    for (const [relativePath, records] of Object.entries(input.outputRecords).sort()) {
      const sorted = [...records].sort((left, right) =>
        stableJson(left).localeCompare(stableJson(right))
      );
      const payload = sorted.map((record) => stableJson(record)).join("\n") +
        (sorted.length ? "\n" : "");
      await writeFile(path.join(staging, relativePath), payload, "utf8");
      outputMetadata.push({
        relativePath,
        sha256: sha256(payload),
        records: sorted.length,
      });
    }
    for (const [relativePath, value] of Object.entries(input.outputJson).sort()) {
      const payload = stableJsonPretty(value);
      await writeFile(path.join(staging, relativePath), payload, "utf8");
      outputMetadata.push({ relativePath, sha256: sha256(payload) });
    }
    const manifest: CorpusBuildManifest = {
      ...input.manifestBase,
      outputs: outputMetadata.sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath)
      ),
    };
    await writeFile(
      path.join(staging, "build-manifest.json"),
      stableJsonPretty(manifest),
      "utf8"
    );
    await writeFile(
      path.join(staging, "run-metadata.json"),
      stableJsonPretty(input.runMetadata),
      "utf8"
    );
    await input.verifySources();
    await atomicReplaceDirectory(staging, outputRoot);
    return manifest;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function atomicReplaceDirectory(staging: string, outputRoot: string) {
  const backup = `${outputRoot}.backup-${process.pid}-${Date.now()}`;
  let movedExisting = false;
  try {
    await rename(outputRoot, backup);
    movedExisting = true;
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  try {
    await rename(staging, outputRoot);
    if (movedExisting) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (movedExisting) await rename(backup, outputRoot);
    throw error;
  }
}

async function readPreviousSplitLock(outputRoot: string) {
  try {
    return JSON.parse(
      await readFile(path.join(outputRoot, "split-assignment-lock.json"), "utf8")
    ) as CorpusSplitAssignmentLock;
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

function reviewItem(
  exampleId: string,
  head: CorpusHead | undefined,
  reason: CorpusReviewQueueItem["reason"],
  priority: 0 | 1 | 2,
  candidateIds: string[]
): CorpusReviewQueueItem {
  return {
    schemaVersion: 1,
    itemId: sha256(
      `${exampleId}\0${head ?? "all"}\0${reason}\0${candidateIds.sort().join("\0")}`
    ),
    exampleId,
    head,
    reason,
    priority,
    candidateIds,
    status: "open",
  };
}

function isMissingFileError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
