import type { PreparationRuntimeArtifactRef, PreparationRuntimeContext, PreparationRuntimeProjection } from "./preparation-runtime-contracts.js";

import { createMeetingId } from "./meeting-id.js";



export const PREPARATION_RUNTIME_PROVENANCE_VERSION =
  "meeting-preparation-provenance-v1";

export type PreparationArtifactConsumer =
  | "runtime-brief"
  | "question-type-prior"
  | "programming-language"
  | "speech-bias"
  | "strategy"
  | "kmb-hint"
  | "fact-anchor"
  | "opening"
  | "narrative"
  | "playbook-overlay";

export type PreparationArtifactTargetKind =
  | "stt-segment"
  | "question-settlement"
  | "retrieval"
  | "advisor-prompt"
  | "artifact-generation";

export type PreparationArtifactEvaluationLabel =
  | "helpful"
  | "irrelevant"
  | "polluting"
  | "over-constraining";

export interface PreparationRuntimeProjectionDescriptor {
  projectionId: string;
  group: "runtime-reinforcement" | "personalized-guidance";
  consumer: PreparationArtifactConsumer;
  snapshotId: string;
  preparationContextRevision: number;
  artifactIds: string[];
  artifactLineageKeys: string[];
  artifactPaths: string[];
}

export interface PreparationRuntimeProvenanceSnapshot {
  version: typeof PREPARATION_RUNTIME_PROVENANCE_VERSION;
  meetingSessionId: string;
  preparationContextRevision: number;
  selectionRevision: number;
  mode: PreparationRuntimeContext["mode"];
  loadState: PreparationRuntimeContext["loadState"];
  capabilities: PreparationRuntimeContext["capabilities"];
  pinnedSnapshot?: PreparationRuntimeContext["pinnedSnapshot"];
  projectionCatalog: PreparationRuntimeProjectionDescriptor[];
  capturedAt: number;
}

export interface PreparationArtifactUseReceipt {
  version: typeof PREPARATION_RUNTIME_PROVENANCE_VERSION;
  receiptId: string;
  meetingSessionId: string;
  preparationContextRevision: number;
  selectionRevision: number;
  snapshotId: string;
  snapshotVersion: number;
  snapshotContentHash: string;
  projectionId: string;
  artifactId: string;
  lineageKey: string;
  artifactPath: string;
  section: PreparationRuntimeArtifactRef["section"];
  artifactContentHash: string;
  sourceRefs: PreparationRuntimeArtifactRef["sourceRefs"];
  consumer: PreparationArtifactConsumer;
  targetKind: PreparationArtifactTargetKind;
  targetId: string;
  traceId: string;
  questionId?: string;
  answerRevision: number | null;
  artifactRevision?: number;
  generationLeaseId?: string;
  sttSegmentLineage?: {
    audioSessionId: string;
    sequence: number;
    turnId?: string;
  };
  createdAt: number;
}

export interface PreparationArtifactEvaluation {
  version: typeof PREPARATION_RUNTIME_PROVENANCE_VERSION;
  evaluationId: string;
  receiptId: string;
  meetingSessionId: string;
  traceId: string;
  questionId?: string;
  answerRevision: number | null;
  snapshotId: string;
  artifactId: string;
  lineageKey: string;
  consumer: PreparationArtifactConsumer;
  label: PreparationArtifactEvaluationLabel;
  note?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PreparationAnswerAttribution {
  meetingSessionId: string;
  questionId: string;
  answerRevision: number;
  traceIds: string[];
  receiptIds: string[];
  artifactIds: string[];
  lineageKeys: string[];
  consumers: PreparationArtifactConsumer[];
}

export interface RecordPreparationArtifactUseInput<T> {
  projection: PreparationRuntimeProjection<T>;
  usedArtifactIds: string[];
  consumer: PreparationArtifactConsumer;
  targetKind: PreparationArtifactTargetKind;
  targetId: string;
  traceId: string;
  questionId?: string;
  answerRevision?: number | null;
  artifactRevision?: number;
  generationLeaseId?: string;
  sttSegmentLineage?: PreparationArtifactUseReceipt["sttSegmentLineage"];
  createdAt?: number;
}

export class PreparationRuntimeProvenanceLedger {
  private context: PreparationRuntimeContext;
  private readonly receipts = new Map<string, PreparationArtifactUseReceipt>();
  private readonly evaluations = new Map<string, PreparationArtifactEvaluation>();

  constructor(context: PreparationRuntimeContext) {
    this.context = context;
  }

  getContextRevision() {
    return this.context.preparationContextRevision;
  }

  updateContext(context: PreparationRuntimeContext) {
    if (context.meetingSessionId !== this.context.meetingSessionId) {
      throw new PreparationRuntimeProvenanceError(
        "meeting-session-mismatch",
        "Preparation provenance cannot cross Meeting Session boundaries."
      );
    }
    if (
      context.preparationContextRevision <=
      this.context.preparationContextRevision
    ) {
      throw new PreparationRuntimeProvenanceError(
        "non-monotonic-context-revision",
        "Preparation provenance requires a newer context revision."
      );
    }
    this.context = context;
  }

  getSnapshot(): PreparationRuntimeProvenanceSnapshot {
    return buildPreparationRuntimeProvenanceSnapshot(this.context);
  }

  recordUse<T>(
    input: RecordPreparationArtifactUseInput<T>
  ): PreparationArtifactUseReceipt[] {
    const receipts = createPreparationArtifactUseReceipts({
      context: this.context,
      ...input,
    });
    for (const receipt of receipts) {
      this.receipts.set(receipt.receiptId, receipt);
    }
    return receipts.map(clone);
  }

  recordEvaluation(input: {
    receiptId: string;
    label: PreparationArtifactEvaluationLabel;
    note?: string;
    createdAt?: number;
  }): PreparationArtifactEvaluation {
    const receipt = this.receipts.get(input.receiptId);
    if (!receipt) {
      throw new PreparationRuntimeProvenanceError(
        "receipt-not-found",
        "Preparation artifact feedback requires an actual use receipt."
      );
    }
    const existing = this.evaluations.get(input.receiptId);
    const now = input.createdAt ?? Date.now();
    const evaluation: PreparationArtifactEvaluation = {
      version: PREPARATION_RUNTIME_PROVENANCE_VERSION,
      evaluationId:
        existing?.evaluationId ?? createMeetingId("preparation_artifact_eval"),
      receiptId: receipt.receiptId,
      meetingSessionId: receipt.meetingSessionId,
      traceId: receipt.traceId,
      questionId: receipt.questionId,
      answerRevision: receipt.answerRevision,
      snapshotId: receipt.snapshotId,
      artifactId: receipt.artifactId,
      lineageKey: receipt.lineageKey,
      consumer: receipt.consumer,
      label: input.label,
      note: input.note?.trim() || undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.evaluations.set(input.receiptId, evaluation);
    return clone(evaluation);
  }

  listReceipts() {
    return Array.from(this.receipts.values(), clone);
  }

  listEvaluations() {
    return Array.from(this.evaluations.values(), clone);
  }

  getAnswerAttributions(): PreparationAnswerAttribution[] {
    return buildPreparationAnswerAttributionIndex(this.listReceipts());
  }
}

export function buildPreparationRuntimeProvenanceSnapshot(
  context: PreparationRuntimeContext
): PreparationRuntimeProvenanceSnapshot {
  return clone({
    version: PREPARATION_RUNTIME_PROVENANCE_VERSION,
    meetingSessionId: context.meetingSessionId,
    preparationContextRevision: context.preparationContextRevision,
    selectionRevision: context.selectionRevision,
    mode: context.mode,
    loadState: context.loadState,
    capabilities: context.capabilities,
    pinnedSnapshot: context.pinnedSnapshot,
    projectionCatalog: collectProjectionCatalog(context),
    capturedAt: Date.now(),
  });
}

export function createPreparationArtifactUseReceipts<T>(input: {
  context: PreparationRuntimeContext;
} & RecordPreparationArtifactUseInput<T>): PreparationArtifactUseReceipt[] {
  const snapshot = input.context.pinnedSnapshot;
  if (
    input.context.mode !== "prepared" ||
    input.context.loadState !== "ready" ||
    !snapshot
  ) {
    throw new PreparationRuntimeProvenanceError(
      "prepared-context-required",
      "Preparation artifacts cannot be used without a pinned prepared context."
    );
  }
  if (
    input.projection.snapshotId !== snapshot.snapshotId ||
    input.projection.preparationContextRevision !==
      input.context.preparationContextRevision
  ) {
    throw new PreparationRuntimeProvenanceError(
      "stale-projection",
      "The preparation projection does not belong to the current context revision."
    );
  }
  const personalizedConsumer = PERSONALIZED_GUIDANCE_CONSUMERS.has(
    input.consumer
  );
  const capabilityEnabled = personalizedConsumer
    ? input.context.capabilities.personalizedGuidance.enabled
    : input.context.capabilities.runtimeReinforcement.enabled;
  if (!capabilityEnabled) {
    throw new PreparationRuntimeProvenanceError(
      "consumer-capability-disabled",
      `Preparation consumer ${input.consumer} is disabled for the current context revision.`
    );
  }
  const usedArtifactIds = [...new Set(input.usedArtifactIds.filter(Boolean))];
  if (usedArtifactIds.length === 0) {
    throw new PreparationRuntimeProvenanceError(
      "used-artifact-required",
      "A preparation use receipt must name the artifacts actually consumed."
    );
  }
  if (!input.traceId.trim() || !input.targetId.trim()) {
    throw new PreparationRuntimeProvenanceError(
      "target-lineage-required",
      "Preparation use receipts require trace and target lineage."
    );
  }
  if (input.consumer === "speech-bias") {
    if (input.targetKind !== "stt-segment" || !input.sttSegmentLineage) {
      throw new PreparationRuntimeProvenanceError(
        "speech-bias-stt-lineage-required",
        "Speech Bias must be attributed to an STT segment, not an advisor prompt."
      );
    }
  } else if (input.targetKind === "stt-segment") {
    throw new PreparationRuntimeProvenanceError(
      "invalid-stt-consumer",
      "Only Speech Bias may target an STT segment."
    );
  }

  const projectionArtifacts = new Map(
    input.projection.artifactRefs.map((artifact) => [artifact.artifactId, artifact])
  );
  const manifestArtifacts = new Map(
    snapshot.artifactManifest.artifacts.map((artifact) => [
      artifact.artifactId,
      artifact,
    ])
  );
  const createdAt = input.createdAt ?? Date.now();
  return usedArtifactIds.map((artifactId) => {
    const artifact = projectionArtifacts.get(artifactId);
    const manifestArtifact = manifestArtifacts.get(artifactId);
    if (
      !artifact ||
      !manifestArtifact ||
      artifact.lineageKey !== manifestArtifact.lineageKey ||
      artifact.contentHash !== manifestArtifact.contentHash
    ) {
      throw new PreparationRuntimeProvenanceError(
        "untraceable-artifact-use",
        `Artifact ${artifactId} is not authorized by the pinned projection manifest.`
      );
    }
    return {
      version: PREPARATION_RUNTIME_PROVENANCE_VERSION,
      receiptId: createMeetingId("preparation_artifact_use"),
      meetingSessionId: input.context.meetingSessionId,
      preparationContextRevision:
        input.context.preparationContextRevision,
      selectionRevision: input.context.selectionRevision,
      snapshotId: snapshot.snapshotId,
      snapshotVersion: snapshot.version,
      snapshotContentHash: snapshot.contentHash,
      projectionId: input.projection.projectionId,
      artifactId: artifact.artifactId,
      lineageKey: artifact.lineageKey,
      artifactPath: artifact.artifactPath,
      section: artifact.section,
      artifactContentHash: artifact.contentHash,
      sourceRefs: artifact.sourceRefs.map((source) => ({ ...source })),
      consumer: input.consumer,
      targetKind: input.targetKind,
      targetId: input.targetId,
      traceId: input.traceId,
      questionId: input.questionId,
      answerRevision: input.answerRevision ?? null,
      artifactRevision: input.artifactRevision,
      generationLeaseId: input.generationLeaseId,
      sttSegmentLineage: input.sttSegmentLineage
        ? { ...input.sttSegmentLineage }
        : undefined,
      createdAt,
    };
  });
}

const PERSONALIZED_GUIDANCE_CONSUMERS = new Set<PreparationArtifactConsumer>([
  "strategy",
  "kmb-hint",
  "fact-anchor",
  "opening",
  "narrative",
  "playbook-overlay",
]);

export function buildPreparationAnswerAttributionIndex(
  receipts: PreparationArtifactUseReceipt[]
): PreparationAnswerAttribution[] {
  const byAnswer = new Map<string, PreparationAnswerAttribution>();
  for (const receipt of receipts) {
    if (!receipt.questionId || receipt.answerRevision == null) continue;
    const key = `${receipt.meetingSessionId}\u0000${receipt.questionId}\u0000${receipt.answerRevision}`;
    const current = byAnswer.get(key) ?? {
      meetingSessionId: receipt.meetingSessionId,
      questionId: receipt.questionId,
      answerRevision: receipt.answerRevision,
      traceIds: [],
      receiptIds: [],
      artifactIds: [],
      lineageKeys: [],
      consumers: [],
    };
    current.traceIds = unique([...current.traceIds, receipt.traceId]);
    current.receiptIds = unique([...current.receiptIds, receipt.receiptId]);
    current.artifactIds = unique([...current.artifactIds, receipt.artifactId]);
    current.lineageKeys = unique([...current.lineageKeys, receipt.lineageKey]);
    current.consumers = unique([
      ...current.consumers,
      receipt.consumer,
    ]);
    byAnswer.set(key, current);
  }
  return Array.from(byAnswer.values(), clone).sort(
    (left, right) =>
      left.questionId.localeCompare(right.questionId) ||
      left.answerRevision - right.answerRevision
  );
}

export function selectPreparationArtifactUseReceiptsForEvaluation({
  receipts,
  traceId,
  questionId,
  answerRevision,
}: {
  receipts: PreparationArtifactUseReceipt[];
  traceId: string;
  questionId?: string;
  answerRevision?: number;
}): PreparationArtifactUseReceipt[] {
  const selected = receipts.filter(
    (receipt) =>
      receipt.traceId === traceId ||
      (Boolean(questionId) &&
        receipt.questionId === questionId &&
        (answerRevision == null || receipt.answerRevision === answerRevision))
  );
  return Array.from(
    new Map(selected.map((receipt) => [receipt.receiptId, receipt])).values(),
    clone
  );
}

function collectProjectionCatalog(
  context: PreparationRuntimeContext
): PreparationRuntimeProjectionDescriptor[] {
  const low = context.projections?.lowImpact;
  const personalized = context.projections?.personalized;
  if (!low || !personalized) return [];
  return [
    descriptor("runtime-reinforcement", "runtime-brief", low.runtimeBrief),
    descriptor(
      "runtime-reinforcement",
      "question-type-prior",
      low.questionTypePrior
    ),
    ...(low.programmingLanguage
      ? [
          descriptor(
            "runtime-reinforcement" as const,
            "programming-language" as const,
            low.programmingLanguage
          ),
        ]
      : []),
    ...low.speechBiasTerms.map((projection) =>
      descriptor("runtime-reinforcement", "speech-bias", projection)
    ),
    descriptor("personalized-guidance", "strategy", personalized.strategy),
    ...personalized.factEvidence.map((projection) =>
      descriptor("personalized-guidance", "fact-anchor", projection)
    ),
    ...personalized.kmbEvidenceHints.map((projection) =>
      descriptor("personalized-guidance", "kmb-hint", projection)
    ),
    ...personalized.openingItems.map((projection) =>
      descriptor("personalized-guidance", "opening", projection)
    ),
    ...personalized.narrativeGraphs.map((projection) =>
      descriptor("personalized-guidance", "narrative", projection)
    ),
    ...personalized.playbookOverlays.map((projection) =>
      descriptor("personalized-guidance", "playbook-overlay", projection)
    ),
  ];
}

function descriptor<T>(
  group: PreparationRuntimeProjectionDescriptor["group"],
  consumer: PreparationArtifactConsumer,
  projection: PreparationRuntimeProjection<T>
): PreparationRuntimeProjectionDescriptor {
  return {
    projectionId: projection.projectionId,
    group,
    consumer,
    snapshotId: projection.snapshotId,
    preparationContextRevision: projection.preparationContextRevision,
    artifactIds: projection.artifactRefs.map((artifact) => artifact.artifactId),
    artifactLineageKeys: projection.artifactRefs.map(
      (artifact) => artifact.lineageKey
    ),
    artifactPaths: projection.artifactRefs.map(
      (artifact) => artifact.artifactPath
    ),
  };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class PreparationRuntimeProvenanceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PreparationRuntimeProvenanceError";
  }
}
