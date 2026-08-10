import type { PreparationConversationScope } from "./conversation-types.js";

export const PREPARATION_STATEMENT_DOMAINS = [
  "candidate-fact",
  "project-evidence",
  "interview-logistics",
  "interview-policy",
  "company-guidance",
  "strategy",
  "terminology",
  "question-to-ask",
  "risk",
  "unknown",
] as const;

export type PreparationStatementDomain =
  (typeof PREPARATION_STATEMENT_DOMAINS)[number];
export type PreparationStatementStatus =
  | "proposed"
  | "confirmed"
  | "rejected"
  | "superseded"
  | "unresolved";
export type PreparationStatementAuthority =
  | "user-confirmed"
  | "curated-kmb"
  | "material-grounded"
  | "user-message"
  | "model-generated"
  | "model-inferred";
export type PreparationStatementOwnership =
  | "candidate-owned"
  | "team-owned"
  | "upstream-existing"
  | "future-design"
  | "unresolved";
export type PreparationStatementReviewAction =
  | "proposed"
  | "confirmed"
  | "rejected"
  | "unresolved"
  | "edited"
  | "superseded";
export type PreparationStatementSourceType =
  | "material-chunk"
  | "preparation-message"
  | "curated-kmb"
  | "user-confirmation";

export interface PreparationStatementSource {
  id: string;
  statementId: string;
  sourceType: PreparationStatementSourceType;
  sourceId: string;
  title: string;
  materialId?: string;
  materialRevisionId?: string;
  page?: number;
  section?: string;
  contentHash?: string;
  preview?: string;
  createdAt: number;
}

export interface PreparationStatement {
  id: string;
  processId: string;
  scope: PreparationConversationScope;
  domain: PreparationStatementDomain;
  content: string;
  normalizedContent: string;
  status: PreparationStatementStatus;
  authority: PreparationStatementAuthority;
  ownership: PreparationStatementOwnership;
  allowedWording?: string;
  prohibitedWording: string[];
  allowedInterviewFamilies: string[];
  proposalOperationId: string;
  sourceMessageId?: string;
  supersedesId?: string;
  confidence?: number;
  revision: number;
  lastReviewAction: PreparationStatementReviewAction;
  lastReviewActor: "model" | "user" | "runtime";
  createdAt: number;
  updatedAt: number;
  reviewedAt?: number;
}

export interface PreparationStatementWithSources extends PreparationStatement {
  sources: PreparationStatementSource[];
}

export interface PreparationStatementReviewEvent {
  id: string;
  processId: string;
  statementId: string;
  statementRevision: number;
  action: PreparationStatementReviewAction;
  actor: "model" | "user" | "runtime";
  previousStatus?: PreparationStatementStatus;
  nextStatus: PreparationStatementStatus;
  createdAt: number;
}

export interface PreparationProposalSourceManifestItem {
  label: string;
  sourceType: Exclude<PreparationStatementSourceType, "user-confirmation">;
  sourceId: string;
  title: string;
  content: string;
  materialId?: string;
  materialRevisionId?: string;
  page?: number;
  section?: string;
  contentHash?: string;
}

export interface PreparationStatementProposal {
  domain: PreparationStatementDomain;
  content: string;
  scope: PreparationConversationScope;
  sourceLabels: string[];
  ownership: PreparationStatementOwnership;
  confidence?: number;
  allowedWording?: string;
  prohibitedWording: string[];
  allowedInterviewFamilies: string[];
}

export interface PreparationStatementProposalOperation {
  id: string;
  processId: string;
  scope: PreparationConversationScope;
  conversationId: string;
  expectedConversationRevision: number;
  providerId?: string;
  sourceManifestJson: string;
  sourceManifestHash: string;
  status: "staging" | "committed" | "stale" | "failed" | "cancelled";
  createdAt: number;
  settledAt?: number;
  error?: string;
}

export interface PreparationStatementRepository {
  beginProposalOperation(
    operation: PreparationStatementProposalOperation
  ): Promise<void>;
  stageProposalBatch(input: {
    operationId: string;
    statements: Array<{
      statement: PreparationStatement;
      sources: PreparationStatementSource[];
    }>;
  }): Promise<void>;
  commitProposalOperation(input: {
    operationId: string;
    settledAt: number;
  }): Promise<boolean>;
  settleProposalOperation(input: {
    operationId: string;
    status: "stale" | "failed" | "cancelled";
    settledAt: number;
    error?: string;
  }): Promise<void>;
  list(input: {
    processId: string;
    roundId?: string;
    statuses?: PreparationStatementStatus[];
  }): Promise<PreparationStatementWithSources[]>;
  get(
    processId: string,
    statementId: string
  ): Promise<PreparationStatementWithSources | undefined>;
  listEvents(
    processId: string,
    statementId: string
  ): Promise<PreparationStatementReviewEvent[]>;
  review(input: {
    processId: string;
    statementId: string;
    expectedRevision: number;
    domain: PreparationStatementDomain;
    status: PreparationStatementStatus;
    content: string;
    normalizedContent: string;
    ownership: PreparationStatementOwnership;
    allowedWording?: string;
    prohibitedWording: string[];
    allowedInterviewFamilies: string[];
    authority: PreparationStatementAuthority;
    action: PreparationStatementReviewAction;
    revisionIncrement: 1 | 2;
    updatedAt: number;
  }): Promise<boolean>;
}

export interface PreparationProfileContent {
  logistics: string[];
  evidence: string[];
  terminology: string[];
  strategy: string[];
  companyGuidance: string[];
  interviewPolicy: string[];
  questions: string[];
  risks: string[];
  other: string[];
}

export interface InterviewPreparationProfileRevision {
  id: string;
  processId: string;
  scope: PreparationConversationScope;
  revision: number;
  sourceFingerprint: string;
  contentHash: string;
  content: PreparationProfileContent;
  confirmedStatementIds: string[];
  unresolvedStatementIds: string[];
  createdAt: number;
}

export const PREPARATION_NARRATIVE_SUBJECT_KINDS = [
  "self-introduction",
  "project",
  "role-fit",
] as const;
export type PreparationNarrativeSubjectKind =
  (typeof PREPARATION_NARRATIVE_SUBJECT_KINDS)[number];

export const PREPARATION_NARRATIVE_NODE_KINDS = [
  "positioning",
  "intro-30s",
  "main-story-90s",
  "architecture",
  "tradeoff",
  "failure-recovery",
  "retrospective",
  "role-mapping",
  "follow-up",
] as const;
export type PreparationNarrativeNodeKind =
  (typeof PREPARATION_NARRATIVE_NODE_KINDS)[number];
export type PreparationNarrativeReviewStatus =
  | "proposed"
  | "confirmed"
  | "rejected"
  | "unresolved";
export const PREPARATION_NARRATIVE_EDGE_RELATIONS = [
  "expands",
  "supports",
  "contrasts",
  "answers-follow-up",
] as const;
export type PreparationNarrativeEdgeRelation =
  (typeof PREPARATION_NARRATIVE_EDGE_RELATIONS)[number];

export interface PreparationNarrativeNode {
  id: string;
  graphId: string;
  ordinal: number;
  kind: PreparationNarrativeNodeKind;
  title: string;
  contentDraft: string;
  targetSeconds?: number;
  statementIds: string[];
  reviewStatus: PreparationNarrativeReviewStatus;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface PreparationNarrativeEdge {
  id: string;
  graphId: string;
  fromNodeId: string;
  toNodeId: string;
  relation: PreparationNarrativeEdgeRelation;
  createdAt: number;
}

export interface PreparationNarrativeGraph {
  id: string;
  processId: string;
  scope: PreparationConversationScope;
  profileRevisionId: string;
  subjectKind: PreparationNarrativeSubjectKind;
  subjectId: string;
  revision: number;
  sourceFingerprint: string;
  status: "current" | "stale" | "superseded";
  createdAt: number;
  updatedAt: number;
  nodes: PreparationNarrativeNode[];
  edges: PreparationNarrativeEdge[];
}

export interface PreparationCompositionRepository {
  getProfileByFingerprint(input: {
    processId: string;
    scope: PreparationConversationScope;
    sourceFingerprint: string;
  }): Promise<InterviewPreparationProfileRevision | undefined>;
  insertProfile(input: {
    profile: InterviewPreparationProfileRevision;
    statementRevisions: Array<{
      statementId: string;
      statementRevision: number;
    }>;
  }): Promise<void>;
  getLatestProfile(input: {
    processId: string;
    scope: PreparationConversationScope;
  }): Promise<InterviewPreparationProfileRevision | undefined>;
  listProfiles(input: {
    processId: string;
    scope: PreparationConversationScope;
  }): Promise<InterviewPreparationProfileRevision[]>;
  nextNarrativeRevision(input: {
    processId: string;
    scope: PreparationConversationScope;
    subjectKind: PreparationNarrativeSubjectKind;
    subjectId: string;
  }): Promise<number>;
  insertNarrativeGraph(input: {
    graph: PreparationNarrativeGraph;
    statementRevisions: Map<string, number>;
  }): Promise<void>;
  listNarrativeGraphs(input: {
    processId: string;
    roundId?: string;
  }): Promise<PreparationNarrativeGraph[]>;
  getNarrativeGraph(
    processId: string,
    graphId: string
  ): Promise<PreparationNarrativeGraph | undefined>;
  reviewNarrativeNode(input: {
    processId: string;
    nodeId: string;
    expectedRevision: number;
    contentDraft: string;
    reviewStatus: PreparationNarrativeReviewStatus;
    updatedAt: number;
  }): Promise<boolean>;
}
