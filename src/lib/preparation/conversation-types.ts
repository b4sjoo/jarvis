import type { PreparationMaterialStatus } from "./types.js";
import type { MemoryRejectSummary, PreparationRetrievalPurpose } from "../memory/types.js";
import type { AIResponseTerminalOutcome, AIResponseTokenUsage } from "../functions/ai-response-events.js";

export type PreparationPurposeQueries = Record<PreparationRetrievalPurpose, string>;

export interface PreparationQueryTrace {
  requestedProviderId?: string;
  requestedModelId?: string;
  originalQuery: string;
  queries: PreparationPurposeQueries;
  historyMessageIds: string[];
  disposition: "rewritten" | "fallback" | "no-history" | "manual" | "inventory";
  failure?: string;
  durationMs: number;
  outputChars: number;
  timeoutMs?: number;
  maxOutputTokens?: number;
  tokenUsage?: AIResponseTokenUsage;
  // Private diagnostics only. Never include rawOutput in history, queries or answer context.
  completion?: {
    requestStartedAt: number;
    firstContentAt?: number;
    lastContentAt?: number;
    providerTerminalReceivedAt?: number;
    finishedAt: number;
    requestId?: string;
    attemptId?: string;
    timedOut: boolean;
    rawOutput: string;
    outputTruncated: boolean;
    jsonValid: boolean;
    queriesValid: boolean;
    parseFailure?: string;
    // The outer timestamps are consumer observations; these are transport observations.
    providerTerminal?: Pick<AIResponseTerminalOutcome,
      | "requestId" | "attemptId" | "providerId" | "modelId"
      | "status" | "disposition" | "final" | "failureClass" | "completionSignal"
      | "startedAt" | "firstContentAt" | "lastContentAt" | "finishedAt"
      | "nativeFinishReason" | "statusCode"
    >;
  };
}

export interface PreparationRetrievalTrace extends PreparationQueryTrace {
  pools: Array<{
    purpose: PreparationRetrievalPurpose;
    materialCandidateCount: number;
    selectedMaterialChunks: number;
    selectedKmbEntries: number;
    kmbUnavailable: boolean;
    kmbRejectSummary: MemoryRejectSummary[];
  }>;
}

export type PreparationConversationScope =
  | { kind: "process" }
  | { kind: "round"; roundId: string };

export type PreparationConversationStatus = "active" | "archived";
export type PreparationConversationTitleSource =
  | "placeholder"
  | "automatic"
  | "manual";
export type PreparationMessageRole = "user" | "assistant" | "system";

export interface PreparationConversation {
  id: string;
  processId: string;
  scope: PreparationConversationScope;
  title: string;
  titleSource: PreparationConversationTitleSource;
  status: PreparationConversationStatus;
  revision: number;
  activeOperationId?: string;
  headMessageId?: string;
  rollingSummary?: string;
  summaryRevision: number;
  summaryThroughMessageId?: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

export interface PreparationContextSourceRef {
  purpose?: PreparationRetrievalPurpose;
  kmbEntryRevision?: number;
  kind: "material" | "kmb";
  id: string;
  title: string;
  materialId?: string;
  materialRevisionId?: string;
  page?: number;
  section?: string;
  sourceMethod?: string;
  confidence?: number;
  pageCount?: number;
  ocrAverageConfidence?: number;
  materialStatus?: PreparationMaterialStatus;
  warningCodes?: string[];
  score?: number;
  selectedChars: number;
  truncated: boolean;
  availableChunks?: number;
  coveredChunks?: number;
}

export interface PreparationContextBudget {
  totalChars: number;
  maxChars: number;
  processMetadataChars: number;
  rollingSummaryChars: number;
  recentMessageChars: number;
  materialChars: number;
  kmbChars: number;
  selectedMaterialChunks: number;
  selectedMaterialInventoryItems?: number;
  selectedKmbEntries: number;
  omittedMaterialChunks: number;
  omittedMaterialInventoryItems?: number;
  omittedKmbEntries: number;
  truncationReasons: string[];
}

export interface PreparationMessageContextSnapshot {
  retrieval?: PreparationRetrievalTrace;
  providerId: string;
  operationId: string;
  conversationRevision: number;
  scope: PreparationConversationScope;
  sourceRefs: PreparationContextSourceRef[];
  budget: PreparationContextBudget;
  createdAt: number;
}

export interface PreparationMessage {
  id: string;
  conversationId: string;
  logicalTurnId: string;
  role: PreparationMessageRole;
  content: string;
  materialRefs: string[];
  sourceRefs: PreparationContextSourceRef[];
  modelExecutionRef?: string;
  contextSnapshot?: PreparationMessageContextSnapshot;
  requestMetadata?: {
    image?: {
      materialId: string;
      operation: "analyze" | "extract-text";
    };
    recovery?: {
      materialIds: string[];
      requestedPages?: number[];
      targets?: Array<{
        materialId: string;
        materialKind: "full" | "pdf-pages";
        baseRevisionId: string;
        pageCount?: number;
        pages?: number[];
      }>;
    };
  };
  operationId?: string;
  parentMessageId?: string;
  supersedesMessageId?: string;
  createdAt: number;
  committedAt?: number;
}

export interface PreparationConversationDetail {
  conversation: PreparationConversation;
  messages: PreparationMessage[];
}

export interface PreparationConversationRequestLease {
  conversation: PreparationConversation;
  userMessage: PreparationMessage;
  operationId: string;
  logicalTurnId: string;
  expectedRevision: number;
}

export interface PreparationConversationRepository {
  getById(conversationId: string): Promise<PreparationConversation | undefined>;
  listForProcess(processId: string): Promise<PreparationConversation[]>;
  insert(conversation: PreparationConversation): Promise<void>;
  updateMetadata(input: {
    conversationId: string;
    processId: string;
    title: string;
    titleSource: PreparationConversationTitleSource;
    scope: PreparationConversationScope;
    updatedAt: number;
  }): Promise<boolean>;
  deleteConversation(processId: string, conversationId: string): Promise<boolean>;
  listMessages(conversationId: string): Promise<PreparationMessage[]>;
  beginRequest(input: {
    conversationId: string;
    operationId: string;
    logicalTurnId: string;
    expectedRevision: number;
    userMessage: PreparationMessage;
    autoTitle?: string;
    resetSummary?: boolean;
    updatedAt: number;
  }): Promise<boolean>;
  commitAssistant(input: {
    conversationId: string;
    operationId: string;
    expectedRevision: number;
    assistantMessage: PreparationMessage;
    updatedAt: number;
  }): Promise<boolean>;
  cancelRequest(input: {
    conversationId: string;
    operationId: string;
    expectedRevision: number;
    updatedAt: number;
  }): Promise<boolean>;
  updateSummary(input: {
    conversationId: string;
    operationId: string;
    expectedRevision: number;
    rollingSummary?: string;
    summaryRevision: number;
    summaryThroughMessageId?: string;
    updatedAt: number;
  }): Promise<boolean>;
  countForRound(processId: string, roundId: string): Promise<number>;
}
