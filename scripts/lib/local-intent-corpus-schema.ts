export const LOCAL_INTENT_CORPUS_SCHEMA_VERSION = 1 as const;

export type CorpusHead = "speech-act" | "question-type" | "phase-signal";

export type CorpusSplit =
  | "train"
  | "dev"
  | "calibration"
  | "sealed-test"
  | "rolling-eval";

export type CorpusSourceKind =
  | "canonical-session"
  | "derived-sidecar"
  | "stt-evaluation-capture"
  | "orphan";

export type CorpusSourceIntegrity =
  | "complete"
  | "legacy-unverified"
  | "unsealed"
  | "malformed"
  | "sidecar";

export type CorpusJoinQuality =
  | "exact-turn"
  | "exact-lqu"
  | "partial"
  | "timestamp"
  | "missing";

export interface CorpusSourceFile {
  relativePath: string;
  role:
    | "native-source"
    | "runtime-observation"
    | "human-evidence"
    | "derived-view"
    | "private-binary";
  format: "json" | "jsonl" | "text" | "audio" | "image" | "binary";
  bytes: number;
  sha256: string;
  parseStatus: "supported" | "legacy" | "unknown-schema" | "malformed";
  recordCount?: number;
}

export interface CorpusSourceInventoryRecord {
  schemaVersion: typeof LOCAL_INTENT_CORPUS_SCHEMA_VERSION;
  containerId: string;
  sourceKind: CorpusSourceKind;
  folderAlias: string;
  canonicalSessionIdHash?: string;
  startedAt?: number;
  endedAt?: number;
  integrity: CorpusSourceIntegrity;
  integrityReasons: string[];
  admission: "normalize" | "review-only" | "blocked";
  sourceTreeHash: string;
  files: CorpusSourceFile[];
  overlayIds: string[];
}

export interface CorpusSourceOverlay {
  schemaVersion: typeof LOCAL_INTENT_CORPUS_SCHEMA_VERSION;
  overlayId: string;
  kind: "source-integrity" | "container-join" | "example-group";
  sourceContainerAlias?: string;
  targetContainerAlias?: string;
  integrity?: CorpusSourceIntegrity;
  exampleId?: string;
  rootGroupId?: string;
  interviewGroupId?: string;
  problemFamilyId?: string;
  confirmed: boolean;
  reasons: string[];
}

export interface CorpusSourceRef {
  containerId: string;
  relativePath: string;
  pointer: string;
  recordHash: string;
}

export interface LocalIntentNormalizedExample {
  schemaVersion: typeof LOCAL_INTENT_CORPUS_SCHEMA_VERSION;
  exampleId: string;
  sourceUnitId: string;
  unitKind: "utterance" | "lqu-revision";
  sourceKind: "session-recording" | "stt-evaluation-capture";
  sourceText: string;
  semanticText: string;
  normalizedCommandText?: string;
  language: "en" | "zh" | "mixed";
  modality: "voice" | "screen" | "mixed";
  createdAt: number;
  provenance: {
    sessionIdHash: string;
    logicalQuestionUnitIdHash?: string;
    logicalQuestionRevision?: number;
    runtimeEpoch?: number;
    currentTurnIdHash?: string;
    orderedSourceTurnIdHashes: string[];
    sourceObservationIdHashes: string[];
    sourceTraceIdHashes: string[];
    sourceRefs: CorpusSourceRef[];
    materialization:
      | "recorded-exact"
      | "single-turn-exact"
      | "stt-canonical"
      | "replayed-candidate";
  };
  boundedContext?: {
    activeParentType?: string;
    activePhase?: string;
    previousInterviewerText?: string;
  };
  grouping: {
    rootGroupId: string;
    sessionGroupId: string;
    interviewGroupId: string;
    problemFamilyId: string;
    sttVariantGroupId?: string;
  };
  eligibility:
    | "train-candidate"
    | "inference-eval-only"
    | "review-only"
    | "blocked";
}

export interface CorpusLabelCandidate {
  schemaVersion: typeof LOCAL_INTENT_CORPUS_SCHEMA_VERSION;
  candidateId: string;
  exampleId: string;
  head: CorpusHead;
  value?: string;
  applicability: "applicable" | "not-applicable";
  authority:
    | "human-confirmed"
    | "manual-correction"
    | "legacy-human"
    | "runtime-observed"
    | "model-proposal"
    | "generated-output";
  confirmation: "confirmed" | "suggested" | "none";
  sourceJoin: CorpusJoinQuality;
  sourceIntegrity: CorpusSourceIntegrity;
  disposition: "gold-candidate" | "weak" | "review" | "blocked";
  supportingEventIds: string[];
  conflictIds: string[];
}

export interface CorpusHeadResolution {
  head: CorpusHead;
  state: "gold" | "weak" | "blocked" | "unresolved";
  value?: string;
  applicability: "applicable" | "not-applicable" | "unresolved";
  activeCandidateIds: string[];
  blockerCodes: string[];
  eligibleSplits: CorpusSplit[];
  lossEligible: boolean;
}

export interface CorpusLabelLedgerRow {
  schemaVersion: typeof LOCAL_INTENT_CORPUS_SCHEMA_VERSION;
  exampleId: string;
  heads: Record<CorpusHead, CorpusHeadResolution>;
}

export interface CorpusReviewQueueItem {
  schemaVersion: typeof LOCAL_INTENT_CORPUS_SCHEMA_VERSION;
  itemId: string;
  exampleId: string;
  head?: CorpusHead;
  reason:
    | "missing-label"
    | "gold-conflict"
    | "weak-conflict"
    | "gold-weak-disagreement"
    | "timestamp-only-join"
    | "missing-source-join"
    | "unsealed-source"
    | "legacy-taxonomy"
    | "legacy-speech-act-alias"
    | "unknown-vs-not-applicable"
    | "candidate-container-join"
    | "locked-split-merge"
    | "rare-class"
    | "hard-negative";
  priority: 0 | 1 | 2;
  candidateIds: string[];
  status: "open";
}

export interface CorpusGroupEdge {
  schemaVersion: typeof LOCAL_INTENT_CORPUS_SCHEMA_VERSION;
  exampleId: string;
  groupId: string;
  kind:
    | "root"
    | "session"
    | "interview"
    | "problem-family"
    | "stt-variant";
  authority: "confirmed" | "inherited" | "candidate";
  splitEffect: "union" | "review-only";
}

export interface CorpusSplitAssignmentLock {
  schemaVersion: typeof LOCAL_INTENT_CORPUS_SCHEMA_VERSION;
  algorithmVersion: string;
  seed: string;
  cutoff: string;
  groupAssignments: Record<string, CorpusSplit>;
  assignmentHash: string;
}

export interface CorpusSplitPlan {
  schemaVersion: typeof LOCAL_INTENT_CORPUS_SCHEMA_VERSION;
  seed: string;
  cutoff: string;
  componentAssignments: Record<string, CorpusSplit>;
  exampleAssignments: Record<string, CorpusSplit>;
  splitCounts: Record<CorpusSplit, number>;
  overlapViolations: string[];
  blockedComponents: string[];
  planHash: string;
}

export interface CorpusQualityReport {
  schemaVersion: typeof LOCAL_INTENT_CORPUS_SCHEMA_VERSION;
  sourceCount: number;
  exampleCount: number;
  labelCandidateCount: number;
  reviewItemCount: number;
  sourceIntegrityCounts: Record<string, number>;
  exampleEligibilityCounts: Record<string, number>;
  headStateCounts: Record<CorpusHead, Record<string, number>>;
  goldClassCounts: Record<CorpusHead, Record<string, number>>;
  splitCounts: Record<CorpusSplit, number>;
  usableSplitCountsByHead: Record<
    CorpusHead,
    Record<CorpusSplit | "excluded", number>
  >;
  overlapViolationCount: number;
  sourceMutationDetected: boolean;
  goNoGo: {
    corpusInfrastructure: "go" | "no-go";
    questionTypeFrozenHead: "conditional-go" | "no-go";
    threeHeadTraining: "go" | "no-go";
    restrictedEnforcement: "go" | "no-go";
    reasons: string[];
  };
}

export interface CorpusBuildManifest {
  schemaVersion: typeof LOCAL_INTENT_CORPUS_SCHEMA_VERSION;
  builderRevision: string;
  seed: string;
  cutoff: string;
  sourceSnapshotHash: string;
  configHash: string;
  buildId: string;
  outputs: Array<{
    relativePath: string;
    sha256: string;
    records?: number;
  }>;
}
