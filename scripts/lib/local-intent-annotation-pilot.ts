import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  LocalIntentAnnotationPilotCard,
  LocalIntentAnnotationPilotManifest,
  LocalIntentAnnotationPilotSelectionAudit,
  AnnotationPilotStratum,
} from "./local-intent-annotation-schema.js";
import type {
  CorpusBuildManifest,
  CorpusLabelCandidate,
  CorpusReviewQueueItem,
  CorpusSourceIntegrity,
  CorpusSourceInventoryRecord,
  LocalIntentNormalizedExample,
} from "./local-intent-corpus-schema.js";
import {
  assertOutputSeparatedFromSources,
  streamJsonLines,
} from "./local-intent-corpus-source-reader.js";
import { sha256, stableJson, stableJsonPretty } from "./local-intent-corpus-utils.js";

const STRATA: AnnotationPilotStratum[] = [
  "phase-correction-constraint",
  "discourse-boundary",
  "transition-boundary",
  "clear-technical",
];

export interface BuildLocalIntentAnnotationPilotOptions {
  corpusRoot: string;
  outputRoot: string;
  seed: string;
  size?: number;
  now?: number;
}

interface SelectionCandidate {
  example: LocalIntentNormalizedExample;
  integrity: CorpusSourceIntegrity;
  candidateIds: string[];
  candidateValues: string[];
  reviewReasons: string[];
  scores: Record<AnnotationPilotStratum, { score: number; reasons: string[] }>;
}

export async function buildLocalIntentAnnotationPilot(
  options: BuildLocalIntentAnnotationPilotOptions
) {
  const requestedCards = options.size ?? 80;
  if (!Number.isInteger(requestedCards) || requestedCards < 4) {
    throw new Error("Annotation pilot size must be an integer of at least four.");
  }
  if (!options.seed.trim()) throw new Error("Annotation pilot seed is required.");
  await assertOutputSeparatedFromSources(options.outputRoot, [options.corpusRoot]);

  const corpusFiles = {
    buildManifest: path.join(options.corpusRoot, "build-manifest.json"),
    normalizedExamples: path.join(options.corpusRoot, "normalized-examples.jsonl"),
    labelCandidates: path.join(options.corpusRoot, "label-candidates.jsonl"),
    reviewQueue: path.join(options.corpusRoot, "review-queue.jsonl"),
    sourceInventory: path.join(options.corpusRoot, "source-inventory.jsonl"),
  };
  const manifest = JSON.parse(
    await readFile(corpusFiles.buildManifest, "utf8")
  ) as CorpusBuildManifest;
  const [examples, candidates, reviewQueue, inventory] = await Promise.all([
    readJsonLines<LocalIntentNormalizedExample>(corpusFiles.normalizedExamples),
    readJsonLines<CorpusLabelCandidate>(corpusFiles.labelCandidates),
    readJsonLines<CorpusReviewQueueItem>(corpusFiles.reviewQueue),
    readJsonLines<CorpusSourceInventoryRecord>(corpusFiles.sourceInventory),
  ]);
  const sourceHashes = {
    buildManifest: sha256(await readFile(corpusFiles.buildManifest)),
    normalizedExamples: sha256(await readFile(corpusFiles.normalizedExamples)),
    labelCandidates: sha256(await readFile(corpusFiles.labelCandidates)),
    reviewQueue: sha256(await readFile(corpusFiles.reviewQueue)),
    sourceInventory: sha256(await readFile(corpusFiles.sourceInventory)),
  };
  const pilotId = sha256(
    [
      "local-intent-annotation-pilot-v1",
      manifest.buildId,
      options.seed,
      requestedCards,
    ].join("\0")
  );
  const selectionCandidates = buildSelectionCandidates({
    examples,
    candidates,
    reviewQueue,
    inventory,
  });
  const uniqueRootCount = new Set(
    selectionCandidates.map((candidate) => candidate.example.grouping.rootGroupId)
  ).size;
  if (uniqueRootCount < requestedCards) {
    throw new Error(
      `Annotation pilot needs ${requestedCards} unique session roots but found ${uniqueRootCount}.`
    );
  }
  const stratumTargets = distributeTargets(requestedCards);
  const selected = selectCandidates({
    candidates: selectionCandidates,
    seed: options.seed,
    targets: stratumTargets,
  });
  const shuffled = [...selected].sort((left, right) =>
    deterministicRank(options.seed, left.candidate.example.exampleId).localeCompare(
      deterministicRank(options.seed, right.candidate.example.exampleId)
    )
  );
  const cards: LocalIntentAnnotationPilotCard[] = [];
  const selectionAudit: LocalIntentAnnotationPilotSelectionAudit[] = [];
  for (let index = 0; index < shuffled.length; index += 1) {
    const row = shuffled[index];
    const example = row.candidate.example;
    const context = {
      previousInterviewerText: example.boundedContext?.previousInterviewerText,
      interveningMeText: example.boundedContext?.interveningMeText ?? [],
      activeParentType: example.boundedContext?.activeParentType,
      activePhase: example.boundedContext?.activePhase,
    };
    const sourceHash = sha256(example.sourceText);
    const contextHash = sha256(stableJson(context));
    const cardId = sha256(`pilot-card\0${pilotId}\0${example.exampleId}`);
    cards.push({
      schemaVersion: 1,
      pilotId,
      cardId,
      ordinal: index + 1,
      exampleId: example.exampleId,
      sourceUnitId: example.sourceUnitId,
      sourceHash,
      contextHash,
      sourceText: example.sourceText,
      context,
      source: {
        unitKind: example.unitKind,
        modality: example.modality,
        language: example.language,
        materialization: example.provenance.materialization,
        integrity: row.candidate.integrity,
        eligibility: example.eligibility,
        exactSource:
          example.provenance.materialization === "recorded-exact" ||
          example.provenance.materialization === "single-turn-exact",
      },
    });
    selectionAudit.push({
      schemaVersion: 1,
      pilotId,
      cardId,
      exampleId: example.exampleId,
      rootGroupId: example.grouping.rootGroupId,
      sessionGroupId: example.grouping.sessionGroupId,
      stratum: row.stratum,
      score: row.score,
      reasons: row.reasons,
      hiddenCandidateIds: row.candidate.candidateIds,
      hiddenCandidateValues: row.candidate.candidateValues,
    });
  }
  const cardsPayload = asJsonLines(cards);
  const selectionPayload = asJsonLines(selectionAudit);
  const stratumCounts = emptyStratumCounts();
  for (const row of selectionAudit) stratumCounts[row.stratum] += 1;
  const pilotManifest: LocalIntentAnnotationPilotManifest = {
    schemaVersion: 1,
    pilotId,
    corpusBuildId: manifest.buildId,
    corpusBuilderRevision: manifest.builderRevision,
    seed: options.seed,
    requestedCards,
    selectedCards: cards.length,
    generatedAt: options.now ?? Date.now(),
    blinded: true,
    contextPolicy: {
      currentSourceOwnedUnit: true,
      previousInterviewerTurn: true,
      boundedInterveningMeTurns: true,
      activeParentAndPhaseAreNonAuthoritative: true,
      modelAndRuntimePredictionsHidden: true,
    },
    stratumTargets,
    stratumCounts,
    sourceHashes,
    cardsHash: sha256(cardsPayload),
    selectionAuditHash: sha256(selectionPayload),
  };
  await publishPilot({
    outputRoot: options.outputRoot,
    manifest: pilotManifest,
    cardsPayload,
    selectionPayload,
  });
  return { manifest: pilotManifest, cards, selectionAudit };
}

function buildSelectionCandidates(input: {
  examples: LocalIntentNormalizedExample[];
  candidates: CorpusLabelCandidate[];
  reviewQueue: CorpusReviewQueueItem[];
  inventory: CorpusSourceInventoryRecord[];
}) {
  const candidatesByExample = groupBy(input.candidates, (row) => row.exampleId);
  const reviewByExample = groupBy(input.reviewQueue, (row) => row.exampleId);
  const integrityByContainer = new Map(
    input.inventory.map((row) => [row.containerId, row.integrity])
  );
  return input.examples
    .filter((example) => example.sourceKind === "session-recording")
    .map((example): SelectionCandidate => {
    const labelCandidates = candidatesByExample.get(example.exampleId) ?? [];
    const reviewItems = reviewByExample.get(example.exampleId) ?? [];
    const integrity =
      example.provenance.sourceRefs
        .map((ref) => integrityByContainer.get(ref.containerId))
        .find(Boolean) ?? "legacy-unverified";
    const candidateValues = labelCandidates
      .map((row) => `${row.head}:${row.value ?? row.applicability}:${row.disposition}`)
      .sort();
    const reviewReasons = [...new Set(reviewItems.map((row) => row.reason))].sort();
    return {
      example,
      integrity,
      candidateIds: labelCandidates.map((row) => row.candidateId).sort(),
      candidateValues,
      reviewReasons,
      scores: Object.fromEntries(
        STRATA.map((stratum) => [
          stratum,
          scoreForStratum({ example, candidateValues, reviewReasons, stratum }),
        ])
      ) as SelectionCandidate["scores"],
    };
    });
}

function selectCandidates(input: {
  candidates: SelectionCandidate[];
  seed: string;
  targets: Record<AnnotationPilotStratum, number>;
}) {
  const selected: Array<{
    candidate: SelectionCandidate;
    stratum: AnnotationPilotStratum;
    score: number;
    reasons: string[];
  }> = [];
  const usedRoots = new Set<string>();
  const sessionCounts = new Map<string, number>();
  for (const stratum of STRATA) {
    selectForStratum({
      ...input,
      stratum,
      target: input.targets[stratum],
      selected,
      usedRoots,
      sessionCounts,
      sessionCap: 4,
      minimumIntegrityPriority: 3,
    });
    if (selected.filter((row) => row.stratum === stratum).length < input.targets[stratum]) {
      selectForStratum({
        ...input,
        stratum,
        target: input.targets[stratum],
        selected,
        usedRoots,
        sessionCounts,
        sessionCap: Number.POSITIVE_INFINITY,
        minimumIntegrityPriority: 3,
      });
    }
    if (selected.filter((row) => row.stratum === stratum).length < input.targets[stratum]) {
      selectForStratum({
        ...input,
        stratum,
        target: input.targets[stratum],
        selected,
        usedRoots,
        sessionCounts,
        sessionCap: Number.POSITIVE_INFINITY,
        minimumIntegrityPriority: 0,
      });
    }
  }
  const expected = Object.values(input.targets).reduce((sum, count) => sum + count, 0);
  if (selected.length !== expected) {
    throw new Error(`Could not fill annotation pilot: selected ${selected.length}/${expected}.`);
  }
  return selected;
}

function selectForStratum(input: {
  candidates: SelectionCandidate[];
  seed: string;
  stratum: AnnotationPilotStratum;
  target: number;
  selected: Array<{
    candidate: SelectionCandidate;
    stratum: AnnotationPilotStratum;
    score: number;
    reasons: string[];
  }>;
  usedRoots: Set<string>;
  sessionCounts: Map<string, number>;
  sessionCap: number;
  minimumIntegrityPriority: number;
}) {
  const alreadySelected = () =>
    input.selected.filter((row) => row.stratum === input.stratum).length;
  const ordered = [...input.candidates].sort((left, right) => {
    const score = right.scores[input.stratum].score - left.scores[input.stratum].score;
    if (score) return score;
    const integrity = integrityPriority(right.integrity) - integrityPriority(left.integrity);
    if (integrity) return integrity;
    const priority = examplePriority(right.example) - examplePriority(left.example);
    if (priority) return priority;
    return deterministicRank(input.seed, left.example.exampleId).localeCompare(
      deterministicRank(input.seed, right.example.exampleId)
    );
  });
  for (const candidate of ordered) {
    if (alreadySelected() >= input.target) break;
    const rootId = candidate.example.grouping.rootGroupId;
    const sessionId = candidate.example.grouping.sessionGroupId;
    if (input.usedRoots.has(rootId)) continue;
    if (integrityPriority(candidate.integrity) < input.minimumIntegrityPriority) continue;
    if ((input.sessionCounts.get(sessionId) ?? 0) >= input.sessionCap) continue;
    const scored = candidate.scores[input.stratum];
    input.selected.push({
      candidate,
      stratum: input.stratum,
      score: scored.score,
      reasons: [
        ...scored.reasons,
        ...(hasStratumSignal(scored.reasons)
          ? []
          : ["deterministic-fallback-fill"]),
        ...(input.minimumIntegrityPriority < 3
          ? ["integrity-relaxation-fill"]
          : []),
      ],
    });
    input.usedRoots.add(rootId);
    input.sessionCounts.set(sessionId, (input.sessionCounts.get(sessionId) ?? 0) + 1);
  }
}

function hasStratumSignal(reasons: string[]) {
  return reasons.some(
    (reason) =>
      reason !== "complete-train-candidate" &&
      reason !== "exact-lqu"
  );
}

function scoreForStratum(input: {
  example: LocalIntentNormalizedExample;
  candidateValues: string[];
  reviewReasons: string[];
  stratum: AnnotationPilotStratum;
}) {
  const text = input.example.sourceText.toLowerCase().replace(/\s+/g, " ").trim();
  const reasons: string[] = [];
  let score = 0;
  const add = (points: number, reason: string) => {
    score += points;
    reasons.push(reason);
  };
  if (input.example.eligibility === "train-candidate") add(8, "complete-train-candidate");
  if (input.example.provenance.materialization === "recorded-exact") add(5, "exact-lqu");
  if (input.stratum === "phase-correction-constraint") {
    if (/\b(move on|go ahead|next (?:step|phase)|go back|revisit|stay on|hold on)\b/.test(text)) {
      add(20, "phase-direction-language");
    }
    if (/\b(make (?:a |the )?assumptions?|assume|enough requirements?|requirements? (?:are|is) complete)\b/.test(text)) {
      add(18, "phase-evidence-language");
    }
    if (/\b(actually|instead|not .{0,24} but|use .{1,24} instead|i (?:said|meant))\b/.test(text)) {
      add(14, "correction-or-constraint-language");
    }
  } else if (input.stratum === "discourse-boundary") {
    const words = text.split(/\s+/).filter(Boolean).length;
    if (/^(?:m+|h+m+|uh+|okay|ok|sure|right|great|looks good|sounds good)[,.! ]*$/.test(text)) {
      add(24, "closed-family-acknowledgement");
    }
    if (/^(?:okay|ok|right|great|looks good|sounds good).*(?:\?|\bwhat\b|\bhow\b|\bwhy\b|\bcan\b|\bshould\b)/.test(text)) {
      add(18, "acknowledgement-prefixed-ask");
    }
    if (words <= 8) add(8, "short-turn-boundary");
    if (/\b(start date|compensation|salary|relocat|work authorization|visa|schedule|availability)\b/.test(text)) {
      add(12, "logistics-or-personal-status");
    }
  } else if (input.stratum === "transition-boundary") {
    if (input.reviewReasons.some((reason) => reason.includes("conflict") || reason.includes("disagreement"))) {
      add(20, "recorded-classification-conflict");
    }
    if (new Set(input.candidateValues.map((value) => value.split(":")[1])).size > 1) {
      add(14, "multiple-hidden-type-candidates");
    }
    if (/\b(now|next|let'?s (?:move|switch)|another question|different question|follow[- ]?up)\b/.test(text)) {
      add(14, "transition-language");
    }
    if (input.example.provenance.orderedSourceTurnIdHashes.length > 1) {
      add(8, "multi-turn-lqu");
    }
    if (input.example.boundedContext?.activeParentType) add(4, "active-parent-context");
  } else {
    if (input.candidateValues.some((value) => /question-type:(?!unknown)/.test(value))) {
      add(18, "concrete-hidden-question-type-candidate");
    }
    if (/\b(design|implement|write (?:code|a function)|algorithm|architecture|tell me about|explain|compare|debug)\b/.test(text)) {
      add(16, "explicit-technical-action");
    }
    if (text.length >= 40) add(5, "substantive-length");
  }
  return { score, reasons };
}

function distributeTargets(size: number) {
  const base = Math.floor(size / STRATA.length);
  const remainder = size % STRATA.length;
  return Object.fromEntries(
    STRATA.map((stratum, index) => [stratum, base + (index < remainder ? 1 : 0)])
  ) as Record<AnnotationPilotStratum, number>;
}

function emptyStratumCounts(): Record<AnnotationPilotStratum, number> {
  return {
    "clear-technical": 0,
    "transition-boundary": 0,
    "discourse-boundary": 0,
    "phase-correction-constraint": 0,
  };
}

function examplePriority(example: LocalIntentNormalizedExample) {
  const eligibility =
    example.eligibility === "train-candidate"
      ? 30
      : example.eligibility === "inference-eval-only"
        ? 20
        : example.eligibility === "review-only"
          ? 10
          : 0;
  const exact =
    example.provenance.materialization === "recorded-exact" ||
    example.provenance.materialization === "single-turn-exact"
      ? 5
      : 0;
  return eligibility + exact + Math.min(example.sourceText.length, 1_000) / 10_000;
}

function integrityPriority(integrity: CorpusSourceIntegrity) {
  if (integrity === "complete") return 4;
  if (integrity === "legacy-unverified") return 3;
  if (integrity === "unsealed") return 2;
  if (integrity === "sidecar") return 1;
  return 0;
}

function deterministicRank(seed: string, value: string) {
  return sha256(`${seed}\0${value}`);
}

function groupBy<T>(rows: T[], key: (row: T) => string) {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const current = result.get(id) ?? [];
    current.push(row);
    result.set(id, current);
  }
  return result;
}

async function readJsonLines<T>(filePath: string) {
  const rows: T[] = [];
  for await (const row of streamJsonLines<T>(filePath)) {
    if (!row.value) {
      throw new Error(`Malformed corpus JSONL at ${filePath}:${row.lineNumber}.`);
    }
    rows.push(row.value);
  }
  return rows;
}

function asJsonLines(rows: unknown[]) {
  return rows.map((row) => stableJson(row)).join("\n") + (rows.length ? "\n" : "");
}

async function publishPilot(input: {
  outputRoot: string;
  manifest: LocalIntentAnnotationPilotManifest;
  cardsPayload: string;
  selectionPayload: string;
}) {
  const outputRoot = path.resolve(input.outputRoot);
  const parent = path.dirname(outputRoot);
  await mkdir(parent, { recursive: true });
  const staging = path.join(
    parent,
    `.${path.basename(outputRoot)}.staging-${process.pid}-${Date.now()}`
  );
  await mkdir(staging, { recursive: false, mode: 0o700 });
  try {
    await Promise.all([
      writeFile(path.join(staging, "pilot-manifest.json"), stableJsonPretty(input.manifest), {
        encoding: "utf8",
        mode: 0o600,
      }),
      writeFile(path.join(staging, "pilot-cards.jsonl"), input.cardsPayload, {
        encoding: "utf8",
        mode: 0o600,
      }),
      writeFile(
        path.join(staging, "pilot-selection-audit.jsonl"),
        input.selectionPayload,
        { encoding: "utf8", mode: 0o600 }
      ),
    ]);
    await atomicReplaceDirectory(staging, outputRoot);
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
    if (!isMissing(error)) throw error;
  }
  try {
    await rename(staging, outputRoot);
    if (movedExisting) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (movedExisting) await rename(backup, outputRoot);
    throw error;
  }
}

function isMissing(error: unknown) {
  return Boolean(
    error && typeof error === "object" && "code" in error && error.code === "ENOENT"
  );
}
