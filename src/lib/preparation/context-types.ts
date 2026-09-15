import type { Message } from "../../types/completion.js";
import type { SelectedAiProviderConfig, TYPE_PROVIDER } from "../../types/provider.type.js";
import type { AIResponseEvent } from "../functions/ai-response-events.js";
import type {
  PreparationContextBudget,
  PreparationContextSourceRef,
  PreparationConversationRequestLease,
  PreparationMessage,
  PreparationQueryTrace,
  PreparationRetrievalTrace,
} from "./conversation-types.js";
import type { InterviewProcess, InterviewRound } from "./interview-types.js";
import type {
  PreparationMaterial,
  PreparationMaterialRepository,
  PreparationRetrievalPurpose,
} from "./types.js";

export interface PreparationMaterialContextCandidate {
  purpose?: PreparationRetrievalPurpose;
  chunkId: string;
  processId: string;
  materialId: string;
  materialRevisionId: string;
  materialName: string;
  materialStatus: "ready" | "needs-review";
  scopeKind: "workspace" | "round";
  scopeId?: string;
  content: string;
  searchText: string;
  page?: number;
  section?: string;
  sourceMethod: string;
  confidence?: number;
  pageCount?: number;
  ocrAverageConfidence?: number;
  warningCodes: string[];
}

export interface PreparationMaterialContextRepository {
  searchCandidates(input: {
    processId: string;
    roundId?: string;
    queryTokens: string[];
    preferredMaterialIds: string[];
    limit: number;
    purpose?: PreparationRetrievalPurpose;
    purposeMaterialIds?: string[];
  }): Promise<PreparationMaterialContextCandidate[]>;
}

export type PreparationMaterialInventoryRepository = Pick<
  PreparationMaterialRepository,
  "list"
>;

export interface PreparationMaterialInventorySelection {
  text: string;
  sourceRefs: PreparationContextSourceRef[];
  selectedItems: PreparationMaterial[];
  omittedCount: number;
  selectedChars: number;
}

export interface PreparationSelectedContext {
  text: string;
  sourceRefs: PreparationContextSourceRef[];
  selectedCount: number;
  omittedCount: number;
  selectedChars: number;
}

export interface PreparationContextComposition {
  retrieval?: PreparationRetrievalTrace;
  systemContext: string;
  recentHistory: Message[];
  rollingSummary?: string;
  summaryThroughMessageId?: string;
  sourceRefs: PreparationContextSourceRef[];
  budget: PreparationContextBudget;
}

export interface PreparationContextComposerInput {
  process: InterviewProcess;
  round?: InterviewRound;
  lease: PreparationConversationRequestLease;
  messages: PreparationMessage[];
  preferredMaterialIds?: string[];
  rewriteQueries?: PreparationQueryRewriter;
  assertCurrent?: () => Promise<void>;
}

export type PreparationQueryRewriter = (input: {
  query: string;
  history: Message[];
  historyMessageIds: string[];
  sourceRefs: PreparationContextSourceRef[];
}) => Promise<PreparationQueryTrace>;

export interface PreparationFetchRequest {
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedAiProviderConfig;
  systemPrompt?: string;
  history?: Message[];
  userMessage: string;
  imagesBase64?: Array<{ base64: string; mediaType: string }>;
  signal?: AbortSignal;
  applyResponseSettings?: boolean;
  requestOptions?: {
    timeoutMs?: number;
    maxOutputTokens?: number;
    retryPolicy?: { maxAttempts: number };
  };
}

export type PreparationFetchResponse = (input: PreparationFetchRequest) => AsyncIterable<string>;
export type PreparationFetchResponseEvents = (input: PreparationFetchRequest) => AsyncIterable<AIResponseEvent>;
