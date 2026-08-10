import type {
  PreparationExpectedInterviewType,
  PreparationExpectedTypePolicy,
  InterviewRoundStage,
} from "./interview-types.js";
import type {
  PreparationNarrativeNodeKind,
  PreparationNarrativeSubjectKind,
  PreparationStatementDomain,
  PreparationStatementOwnership,
  PreparationStatementSourceType,
} from "./statement-types.js";

export const PREPARATION_SNAPSHOT_COMPILER_VERSION = "preparation-snapshot-v1";
export const PREPARATION_PLAYBOOK_REGISTRY_VERSION = "interview-playbook-v1";
export const PREPARATION_RUNTIME_CAPABILITY_VERSION =
  "meeting-preparation-runtime-v1";
export const PREPARATION_SNAPSHOT_RUNTIME_BUDGET_CHARS = 48_000;

export type InterviewPreparationSnapshotStatus =
  | "ready"
  | "active"
  | "superseded"
  | "invalidated";

export interface PreparationRuntimeBrief {
  company?: string;
  role?: string;
  roundId: string;
  roundTitle: string;
  stage: InterviewRoundStage;
  expectedInterviewTypes: PreparationExpectedInterviewType[];
  expectedTypePolicy: PreparationExpectedTypePolicy;
  preferredProgrammingLanguage?: string;
  scheduledAt?: number;
  interviewerName?: string;
  interviewerRole?: string;
  focusAreas: string[];
  compactNotes: string[];
  unresolvedHighImpactAssumptions: string[];
}

export interface PreparationStrategy {
  priorities: string[];
  risks: string[];
  questionsToAsk: string[];
  likelyBranches: string[];
  timeAllocation: string[];
}

export interface PreparationEvidenceItem {
  statementId: string;
  statementRevision: number;
  domain: Extract<PreparationStatementDomain, "candidate-fact" | "project-evidence">;
  content: string;
  ownership: Exclude<PreparationStatementOwnership, "unresolved">;
  allowedWording?: string;
  prohibitedWording: string[];
  allowedInterviewFamilies: string[];
  sourceIds: string[];
}

export interface PreparationEvidencePack {
  items: PreparationEvidenceItem[];
}

export interface PreparationSpeechBiasTerm {
  canonicalTerm: string;
  aliases: string[];
  statementId: string;
  statementRevision: number;
  authority: "user-confirmed" | "curated-kmb" | "material-grounded";
}

export interface PreparationOpeningPackItem {
  graphId: string;
  nodeId: string;
  subjectKind: PreparationNarrativeSubjectKind;
  subjectId: string;
  nodeKind: Extract<
    PreparationNarrativeNodeKind,
    "positioning" | "intro-30s" | "main-story-90s"
  >;
  title: string;
  renderedDraft: string;
  statementIds: string[];
}

export interface PreparationOpeningPack {
  items: PreparationOpeningPackItem[];
}

export interface PreparationNarrativePackNode {
  nodeId: string;
  kind: PreparationNarrativeNodeKind;
  title: string;
  content: string;
  targetSeconds?: number;
  statementIds: string[];
}

export interface PreparationNarrativePackGraph {
  graphId: string;
  graphRevision: number;
  subjectKind: PreparationNarrativeSubjectKind;
  subjectId: string;
  nodes: PreparationNarrativePackNode[];
  edges: Array<{
    fromNodeId: string;
    toNodeId: string;
    relation: "expands" | "supports" | "contrasts" | "answers-follow-up";
  }>;
}

export interface PreparationNarrativePack {
  graphs: PreparationNarrativePackGraph[];
}

export interface PreparationSessionLaunchPlan {
  recommendedRuntimeConfiguration: {
    expectedInterviewTypes: PreparationExpectedInterviewType[];
    expectedTypePolicy: PreparationExpectedTypePolicy;
    preferredProgrammingLanguage?: string;
  };
  smokeTests: string[];
  interviewFlow: string[];
  emergencyActions: string[];
  warnings: string[];
  promptExcluded: true;
}

export interface PreparationPlaybookOverlay {
  canonicalPlaybookId: string;
  expectedInterviewType: PreparationExpectedInterviewType;
  evidenceStatementIds: string[];
  companyCriteria: string[];
  prohibitedOverclaims: string[];
}

export interface PreparationSnapshotEvidenceIndexEntry {
  sourceType: PreparationStatementSourceType;
  sourceId: string;
  title: string;
  contentHash: string;
  materialId?: string;
  materialRevisionId?: string;
  page?: number;
  section?: string;
}

export interface PreparationSnapshotSourceManifest {
  process: { id: string; contentHash: string };
  round: { id: string; contentHash: string };
  profile: {
    id: string;
    revision: number;
    contentHash: string;
    sourceFingerprint: string;
  };
  statements: Array<{
    id: string;
    revision: number;
    contentHash: string;
  }>;
  narrativeNodes: Array<{
    graphId: string;
    graphRevision: number;
    nodeId: string;
    nodeRevision: number;
  }>;
  materials: Array<{
    materialId: string;
    materialRevisionId: string;
    sourceChecksumSha256: string;
  }>;
  kmbEntries: Array<{
    entryId: string;
    contentHash: string;
  }>;
  compilerVersion: string;
  playbookRegistryVersion: string;
  runtimeCapabilityVersion: string;
}

export interface PreparationSnapshotWarning {
  code: string;
  message: string;
  severity: "warning";
}

export interface InterviewPreparationSnapshot {
  id: string;
  processId: string;
  roundId: string;
  version: number;
  profileRevisionId: string;
  profileRevision: number;
  compilerVersion: string;
  playbookRegistryVersion: string;
  runtimeCapabilityVersion: string;
  sourceFingerprint: string;
  contentHash: string;
  runtimeCharCount: number;
  runtimeBrief: PreparationRuntimeBrief;
  strategy: PreparationStrategy;
  evidencePack: PreparationEvidencePack;
  speechBiasTerms: PreparationSpeechBiasTerm[];
  openingPack: PreparationOpeningPack;
  narrativePack: PreparationNarrativePack;
  sessionLaunchPlan: PreparationSessionLaunchPlan;
  playbookOverlays: PreparationPlaybookOverlay[];
  evidenceIndex: PreparationSnapshotEvidenceIndexEntry[];
  sourceManifest: PreparationSnapshotSourceManifest;
  warnings: PreparationSnapshotWarning[];
  status: InterviewPreparationSnapshotStatus;
  createdAt: number;
  activatedAt?: number;
}

export interface PreparationSnapshotActivationEvent {
  id: string;
  processId: string;
  roundId: string;
  snapshotId: string;
  previousSnapshotId?: string;
  action: "activated" | "reactivated" | "deactivated" | "rolled-back";
  createdAt: number;
}

export interface PreparationSnapshotRepository {
  get(
    processId: string,
    snapshotId: string
  ): Promise<InterviewPreparationSnapshot | undefined>;
  getByContentHash(input: {
    processId: string;
    roundId: string;
    contentHash: string;
  }): Promise<InterviewPreparationSnapshot | undefined>;
  getActive(input: {
    processId: string;
    roundId: string;
  }): Promise<InterviewPreparationSnapshot | undefined>;
  list(input: {
    processId: string;
    roundId: string;
  }): Promise<InterviewPreparationSnapshot[]>;
  nextVersion(input: { processId: string; roundId: string }): Promise<number>;
  insert(input: {
    snapshot: InterviewPreparationSnapshot;
    statementRevisions: Array<{ statementId: string; statementRevision: number }>;
    narrativeNodeRevisions: Array<{
      nodeId: string;
      nodeRevision: number;
      ordinal: number;
    }>;
    materialRevisions: Array<{
      materialId: string;
      materialRevisionId: string;
      sourceChecksumSha256: string;
      ordinal: number;
    }>;
    kmbEntries: Array<{ entryId: string; contentHash: string; ordinal: number }>;
  }): Promise<void>;
  activate(input: {
    processId: string;
    roundId: string;
    snapshotId: string;
    expectedContentHash: string;
    activatedAt: number;
  }): Promise<boolean>;
  deactivate(input: {
    processId: string;
    roundId: string;
    snapshotId: string;
    deactivatedAt: number;
  }): Promise<boolean>;
  listActivationEvents(input: {
    processId: string;
    roundId: string;
  }): Promise<PreparationSnapshotActivationEvent[]>;
}

export interface PreparationSnapshotDiffSection {
  id:
    | "runtime-brief"
    | "strategy"
    | "evidence"
    | "speech-bias"
    | "opening"
    | "narratives"
    | "playbooks";
  label: string;
  status: "added" | "unchanged" | "changed";
  previousCount: number;
  nextCount: number;
  changes: string[];
}
