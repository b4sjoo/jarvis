import type { Message } from "../../types/index.js";
import type {
  PreparationContextBudget,
  PreparationContextSourceRef,
  PreparationConversationRequestLease,
  PreparationMessage,
} from "./conversation-types.js";
import type { InterviewProcess, InterviewRound } from "./interview-types.js";
import type {
  PreparationMaterial,
  PreparationMaterialRepository,
} from "./types.js";

export interface PreparationMaterialContextCandidate {
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
}
