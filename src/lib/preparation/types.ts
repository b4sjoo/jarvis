export type CaseState = "open" | "waiting" | "resolved" | "archived";
export type CallPlanState = "draft" | "ready" | "used" | "superseded";
export type SnapshotState = "draft" | "ready" | "superseded" | "invalidated";
export type StatementReviewState =
  | "proposed"
  | "confirmed"
  | "rejected"
  | "superseded";
export type ClaimState =
  | "asserted"
  | "supported"
  | "disputed"
  | "unknown"
  | "stale";

export type CaseStatementKind =
  | "objective"
  | "fact"
  | "claim"
  | "unknown"
  | "risk"
  | "commitment"
  | "deadline"
  | "reference-number"
  | "action";

export type CaseSourceKind =
  | "material"
  | "conversation"
  | "call-turn"
  | "user"
  | "kmb";

export interface CaseSourceRef {
  id: string;
  sourceKind: CaseSourceKind;
  sourceId: string;
  sourceRevision?: number;
  contentHash: string;
  pageNumber?: number;
  quotedText?: string;
}

export interface CaseRecord {
  id: string;
  title: string;
  status: CaseState;
  caseType?: string;
  currentRevisionId?: string;
  rowRevision: number;
  createdAt: number;
  updatedAt: number;
}

export interface CaseRevision {
  id: string;
  caseId: string;
  revision: number;
  parentRevisionId?: string;
  primaryObjective: string;
  acceptableFallbacks: string[];
  partyIds: string[];
  statementIds: string[];
  nextActionIds: string[];
  sourceCommandId: string;
  createdAt: number;
}

export interface CaseParty {
  id: string;
  caseId: string;
  displayName: string;
  role: "user" | "counterparty" | "representative" | "third-party" | "unknown";
  organization?: string;
  reviewState: StatementReviewState;
  sourceRefs: CaseSourceRef[];
  rowRevision: number;
  createdAt: number;
  updatedAt: number;
}

export interface CallPlan {
  id: string;
  caseId: string;
  title: string;
  state: CallPlanState;
  objective: string;
  counterpartyIds: string[];
  acceptableOutcomes: string[];
  questionsToAsk: string[];
  knownRisks: string[];
  scheduledAt?: number;
  rowRevision: number;
  createdAt: number;
  updatedAt: number;
}

export type ExtractionMethod =
  | "native-text"
  | "ocr"
  | "multimodal"
  | "manual";
export type ExtractionRunState =
  | "processing"
  | "ready"
  | "needs-review"
  | "failed";

export interface ExtractionQualitySignal {
  code:
    | "empty"
    | "low-text-density"
    | "broken-words"
    | "replacement-characters"
    | "page-gap"
    | "image-only"
    | "manual-review"
    | "model-recovered";
  severity: "info" | "warning" | "error";
  detail: string;
  pageNumber?: number;
}

export interface CaseMaterial {
  id: string;
  caseId: string;
  callPlanId?: string;
  displayName: string;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  contentHash: string;
  storageRelativePath: string;
  sourceKind: "upload" | "screenshot" | "pasted-image" | "manual";
  selectedExtractionRunId?: string;
  reviewStatus: "pending" | "approved" | "rejected";
  rowRevision: number;
  createdAt: number;
  updatedAt: number;
}

export interface ExtractionRun {
  id: string;
  materialId: string;
  method: ExtractionMethod;
  engine: string;
  engineVersion: string;
  optionsHash: string;
  outputHash: string;
  status: ExtractionRunState;
  qualitySignals: ExtractionQualitySignal[];
  error?: string;
  createdAt: number;
  completedAt?: number;
}

export interface ExtractionChunk {
  id: string;
  extractionRunId: string;
  ordinal: number;
  pageNumber?: number;
  content: string;
  contentHash: string;
  charStart: number;
  charEnd: number;
  confidence?: number;
  createdAt: number;
}

export interface CaseStatement {
  id: string;
  caseId: string;
  revision: number;
  kind: CaseStatementKind;
  content: string;
  subjectPartyId?: string;
  speakerPartyId?: string;
  sourceRefs: CaseSourceRef[];
  reviewState: StatementReviewState;
  claimState: ClaimState;
  jurisdiction?: string;
  validFrom?: number;
  validUntil?: number;
  allowedUses: string[];
  allowedWording?: string;
  supersedesId?: string;
  createdBy: "user" | "runtime-proposal" | "complex-model-proposal";
  createdAt: number;
  updatedAt: number;
}

export interface PreparationConversation {
  id: string;
  caseId: string;
  callPlanId?: string;
  title: string;
  status: "active" | "archived";
  headRevision: number;
  generatedSummary?: string;
  generatedSummaryHash?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PreparationContextManifest {
  caseId: string;
  callPlanId?: string;
  caseRevisionId?: string;
  statementIds: string[];
  extractionChunkIds: string[];
  materialRevisionHashes: string[];
  kmbContentHashes: string[];
  truncated: boolean;
  contextHash: string;
}

export interface PreparationMessage {
  id: string;
  conversationId: string;
  revision: number;
  parentMessageId?: string;
  role: "user" | "assistant";
  content: string;
  materialRefs: string[];
  proposedArtifactRefs: string[];
  contextManifest?: PreparationContextManifest;
  status: "committed" | "superseded";
  operationId?: string;
  createdAt: number;
}

export interface PendingCaseUpdate {
  id: string;
  caseId: string;
  callSessionId: string;
  kind: "claim" | "commitment" | "deadline" | "reference-number" | "action";
  proposedStatement: Omit<
    CaseStatement,
    "id" | "revision" | "reviewState" | "createdAt" | "updatedAt"
  >;
  sourceTurnIds: string[];
  reviewState: "pending" | "accepted" | "edited" | "rejected";
  rowRevision: number;
  createdAt: number;
  updatedAt: number;
}

export interface SnapshotArtifactRef {
  artifactId: string;
  lineageKey: string;
  artifactPath: string;
  section: string;
  contentHash: string;
  sourceRefs: CaseSourceRef[];
}

export interface SnapshotSourceManifest {
  caseRevisionId: string;
  caseRevisionNumber: number;
  callPlanId: string;
  callPlanRevision: number;
  extractionRuns: Array<{
    materialId: string;
    extractionRunId: string;
    outputHash: string;
  }>;
  statements: Array<{ statementId: string; revision: number; contentHash: string }>;
  kmbEntries: Array<{ id: string; contentHash: string }>;
  modelRoute: string;
  compilerVersion: string;
}

export interface CaseSnapshot {
  objective: string;
  acceptableFallbacks: string[];
  supportedStatements: Array<{
    statementId: string;
    kind: CaseStatementKind;
    content: string;
    allowedWording?: string;
  }>;
  disputedClaims: Array<{ statementId: string; content: string }>;
  unknowns: Array<{ statementId: string; content: string }>;
  commitments: Array<{ statementId: string; content: string }>;
  deadlines: Array<{ statementId: string; content: string }>;
  nextActions: Array<{ statementId: string; content: string }>;
}

export interface CallBrief {
  objective: string;
  counterpartyNames: string[];
  acceptableOutcomes: string[];
  questionsToAsk: string[];
  knownRisks: string[];
  scheduledAt?: number;
}

export interface CallPlaybookSnapshot {
  stages: Array<{
    id: "orient" | "establish" | "request" | "resolve" | "confirm-close";
    goal: string;
    prompts: string[];
    exitSignals: string[];
  }>;
  fallbackMoves: string[];
}

export interface SpeechBiasTerm {
  term: string;
  aliases: string[];
  sourceRefs: CaseSourceRef[];
}

export interface EvidenceIndexEntry {
  evidenceId: string;
  label: string;
  excerpt: string;
  allowedUses: string[];
  sourceRefs: CaseSourceRef[];
}

export interface SafetyPolicyConstraints {
  prohibitedClaims: string[];
  uncertainClaims: string[];
  missingJurisdictions: string[];
  requiredAttribution: string[];
}

export interface SnapshotWarning {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  sourceRefs: CaseSourceRef[];
}

export interface CallPreparationSnapshotBundle {
  id: string;
  compileId: string;
  caseId: string;
  caseRevisionId: string;
  callPlanId: string;
  version: number;
  state: SnapshotState;
  caseSnapshot: CaseSnapshot;
  callBrief: CallBrief;
  playbookSnapshot: CallPlaybookSnapshot;
  speechBiasTerms: SpeechBiasTerm[];
  evidenceIndex: EvidenceIndexEntry[];
  safetyConstraints: SafetyPolicyConstraints;
  artifactManifest: SnapshotArtifactRef[];
  sourceManifest: SnapshotSourceManifest;
  warnings: SnapshotWarning[];
  contentHash: string;
  compilerVersion: string;
  compiledAt: number;
}

export type CallPreparationBinding =
  | {
      mode: "neutral";
      callSessionId: string;
      boundAt: number;
    }
  | {
      mode: "prepared";
      callSessionId: string;
      caseId: string;
      caseRevisionId: string;
      callPlanId: string;
      snapshotId: string;
      snapshotContentHash: string;
      boundAt: number;
    };

export type PreparationHumanEvaluationLabel =
  | "helpful"
  | "irrelevant"
  | "polluting"
  | "over-constraining"
  | "incorrect"
  | "missing";
