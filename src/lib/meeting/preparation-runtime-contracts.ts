import type {
  InterviewPreparationSnapshot,
  PreparationCurrentContext,
  PreparationEvidenceItem,
  PreparationNarrativePackGraph,
  PreparationOpeningPackItem,
  PreparationPlaybookOverlay,
  PreparationRuntimeBrief,
  PreparationSnapshotArtifactIdentity,
  PreparationSnapshotArtifactManifest,
  PreparationSpeechBiasTerm,
  PreparationStrategy,
} from "../preparation/snapshot-types.js";

export const PREPARATION_RUNTIME_CONTEXT_VERSION =
  "meeting-preparation-context-v1";

export const PREPARATION_RUNTIME_REINFORCEMENT_VERSION =
  "meeting-preparation-10b-v1";

export const PREPARATION_PERSONALIZED_GUIDANCE_VERSION =
  "meeting-preparation-10c-v1";

export type PreparationRuntimeMode = "neutral" | "prepared";

export type PreparationRuntimeLoadState =
  | "loading"
  | "neutral"
  | "ready"
  | "failed";

export interface PreparationRuntimeCapabilityState {
  runtimeReinforcement: {
    version: typeof PREPARATION_RUNTIME_REINFORCEMENT_VERSION;
    available: boolean;
    enabled: boolean;
  };
  personalizedGuidance: {
    version: typeof PREPARATION_PERSONALIZED_GUIDANCE_VERSION;
    available: boolean;
    enabled: boolean;
    requiresRuntimeReinforcement: true;
  };
}

export interface PreparationRuntimeArtifactRef
  extends PreparationSnapshotArtifactIdentity {}

export interface PreparationRuntimeProjection<T> {
  projectionId: string;
  snapshotId: string;
  preparationContextRevision: number;
  value: T;
  artifactRefs: PreparationRuntimeArtifactRef[];
}

export interface PreparationQuestionTypePrior {
  expectedInterviewTypes: PreparationRuntimeBrief["expectedInterviewTypes"];
  expectedTypePolicy: PreparationRuntimeBrief["expectedTypePolicy"];
}

export interface PreparationKmbEvidenceHint {
  entryId: string;
  title: string;
  contentHash: string;
}

export interface PreparationRuntimeLowImpactProjections {
  runtimeBrief: PreparationRuntimeProjection<PreparationRuntimeBrief>;
  questionTypePrior: PreparationRuntimeProjection<PreparationQuestionTypePrior>;
  programmingLanguage?: PreparationRuntimeProjection<string>;
  speechBiasTerms: Array<
    PreparationRuntimeProjection<PreparationSpeechBiasTerm>
  >;
}

export interface PreparationRuntimePersonalizedProjections {
  strategy: PreparationRuntimeProjection<PreparationStrategy>;
  factEvidence: Array<PreparationRuntimeProjection<PreparationEvidenceItem>>;
  kmbEvidenceHints: Array<
    PreparationRuntimeProjection<PreparationKmbEvidenceHint>
  >;
  openingItems: Array<
    PreparationRuntimeProjection<PreparationOpeningPackItem>
  >;
  narrativeGraphs: Array<
    PreparationRuntimeProjection<PreparationNarrativePackGraph>
  >;
  playbookOverlays: Array<
    PreparationRuntimeProjection<PreparationPlaybookOverlay>
  >;
}

export interface PinnedPreparationSnapshotIdentity {
  snapshotId: string;
  processId: string;
  roundId: string;
  version: number;
  contentHash: string;
  compilerVersion: string;
  playbookRegistryVersion: string;
  runtimeCapabilityVersion: string;
  selectionRevision: number;
  selectedAt: number;
  activatedAt?: number;
  artifactManifest: PreparationSnapshotArtifactManifest;
}

export interface PreparationRuntimeContext {
  version: typeof PREPARATION_RUNTIME_CONTEXT_VERSION;
  meetingSessionId: string;
  preparationContextRevision: number;
  selectionRevision: number;
  mode: PreparationRuntimeMode;
  loadState: PreparationRuntimeLoadState;
  createdAt: number;
  pinnedSnapshot?: PinnedPreparationSnapshotIdentity;
  capabilities: PreparationRuntimeCapabilityState;
  projections?: {
    lowImpact: PreparationRuntimeLowImpactProjections;
    personalized: PreparationRuntimePersonalizedProjections;
  };
  loadFailure?: {
    code: string;
    message: string;
  };
}

export interface PreparationRuntimePresentation {
  version: typeof PREPARATION_RUNTIME_CONTEXT_VERSION;
  meetingSessionId: string;
  preparationContextRevision: number;
  selectionRevision: number;
  mode: PreparationRuntimeMode;
  loadState: PreparationRuntimeLoadState;
  snapshot?: Omit<PinnedPreparationSnapshotIdentity, "artifactManifest"> & {
    artifactCount: number;
    company?: string;
    role?: string;
    roundTitle?: string;
    stage?: PreparationRuntimeBrief["stage"];
  };
  capabilities: PreparationRuntimeCapabilityState;
  projectionCounts: {
    lowImpact: number;
    personalized: number;
  };
  loadFailure?: PreparationRuntimeContext["loadFailure"];
}

export interface PreparationRuntimeContextLoader {
  readSelection(): Promise<PreparationCurrentContext>;
  readSelectedSnapshot(): Promise<InterviewPreparationSnapshot | undefined>;
}

export interface PreparationRuntimeCapabilityUpdate {
  preparationContextRevision: number;
  runtimeReinforcementEnabled?: boolean;
  personalizedGuidanceEnabled?: boolean;
  createdAt?: number;
}
