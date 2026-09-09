import type {
  PreparationMaterialQualitySignal,
  PreparationMaterialReviewActor,
  PreparationMaterialReviewStatus,
  PreparationMaterialRevisionStatus,
} from "./types.js";

export type PreparationExtractionMethod =
  | "plain-text"
  | "markdown"
  | "docx-text"
  | "pdf-text"
  | "pdf-ocr"
  | "pdf-hybrid-ocr"
  | "cloud-ocr"
  | "multimodal-recovery"
  | "manual-transcription"
  | "none";

export interface PreparationMaterialChunk {
  id: string;
  workspaceId: string;
  materialId: string;
  materialRevisionId: string;
  extractionRequestId: string;
  ordinal: number;
  content: string;
  searchText: string;
  page?: number;
  section?: string;
  sourceMethod: string;
  confidence?: number;
  startOffset?: number;
  endOffset?: number;
  createdAt: number;
}

export interface NativePreparationMaterialChunk {
  ordinal: number;
  content: string;
  searchText: string;
  page?: number;
  section?: string;
  sourceMethod: string;
  confidence?: number;
  startOffset: number;
  endOffset: number;
}

export interface NativePreparationMaterialExtractionResult {
  transform?: Record<string, unknown>;
  method: PreparationExtractionMethod;
  status: Extract<
    PreparationMaterialRevisionStatus,
    "ready" | "needs-review" | "unsupported"
  >;
  extractedTextRelativePath?: string;
  textChars: number;
  pageCount?: number;
  ocrPageCount: number;
  ocrAverageConfidence?: number;
  ocrCandidatePageCount: number;
  ocrProcessedPageCount: number;
  ocrFailedPageCount: number;
  ocrSupplementChars: number;
  warningCodes: string[];
  durationMs: number;
  chunks: NativePreparationMaterialChunk[];
}

export interface PreparationExtractionMetadata {
  transform?: Record<string, unknown> | null;
  method: PreparationExtractionMethod;
  textChars: number;
  pageCount?: number;
  ocrPageCount?: number;
  ocrAverageConfidence?: number;
  ocrCandidatePageCount?: number;
  ocrProcessedPageCount?: number;
  ocrFailedPageCount?: number;
  ocrSupplementChars?: number;
  chunkCount: number;
  warningCodes: string[];
  durationMs: number;
  offsetUnit: "unicode-scalar";
  recoveryMode?: "full-replacement" | "page-patch";
  baseRevisionId?: string;
  patchedPages?: number[];
  inheritedChunkCount?: number;
  replacedChunkCount?: number;
  recoveredChunkCount?: number;
  error?: string;
}

export interface PreparationRecoveredPage {
  pageNumber: number;
  text: string;
}

export type PreparationRecoveredContent =
  | {
      kind: "full";
      text: string;
    }
  | {
      kind: "pdf-pages";
      pageCount: number;
      pages: PreparationRecoveredPage[];
    };

export interface PreparationExtractionCandidate {
  outputHash?: string;
  reviewEventId?: string;
  workspaceId: string;
  materialId: string;
  extension: string;
  revisionId: string;
  revision: number;
  sourceChecksumSha256: string;
  status: PreparationMaterialRevisionStatus;
  requestId?: string;
  startedAt?: number;
  completedAt?: number;
  extractedTextRelativePath?: string;
  metadata?: PreparationExtractionMetadata;
  reviewStatus: PreparationMaterialReviewStatus;
  reviewActor?: PreparationMaterialReviewActor;
  reviewUpdatedAt?: number;
  qualitySignals: PreparationMaterialQualitySignal[];
  derivedFromRevisionId?: string;
}

export interface PreparationExtractionInspection {
  candidate: PreparationExtractionCandidate;
  chunks: PreparationMaterialChunk[];
}

export interface PreparationMaterialExtractionRepository {
  getCurrent(materialId: string): Promise<PreparationExtractionCandidate | undefined>;
  getSelected(materialId: string): Promise<PreparationExtractionCandidate | undefined>;
  getRevision(materialId: string, revisionId: string): Promise<PreparationExtractionCandidate | undefined>;
  listRecoverable(
    workspaceId: string,
    staleBefore: number
  ): Promise<PreparationExtractionCandidate[]>;
  claim(input: {
    newRevisionId: string;
    workspaceId: string;
    materialId: string;
    revisionId: string;
    sourceChecksumSha256: string;
    requestId: string;
    startedAt: number;
    staleBefore: number;
    force?: boolean;
  }): Promise<PreparationExtractionCandidate | undefined>;
  complete(input: {
    workspaceId: string;
    materialId: string;
    revisionId: string;
    requestId: string;
    status: Extract<
      PreparationMaterialRevisionStatus,
      "ready" | "needs-review" | "unsupported"
    >;
    extractedTextRelativePath?: string;
    metadata: PreparationExtractionMetadata;
    chunks: PreparationMaterialChunk[];
    reviewStatus: PreparationMaterialReviewStatus;
    reviewActor: PreparationMaterialReviewActor;
    qualitySignals?: PreparationMaterialQualitySignal[];
    completedAt: number;
  }): Promise<boolean>;
  fail(input: {
    workspaceId: string;
    materialId: string;
    revisionId: string;
    requestId: string;
    metadata: PreparationExtractionMetadata;
    completedAt: number;
  }): Promise<boolean>;
  createDerivedRevision(input: {
    workspaceId: string;
    materialId: string;
    baseRevisionId: string;
    revisionId: string;
    requestId: string;
    createdAt: number;
    reviewStatus: PreparationMaterialReviewStatus;
    reviewActor: PreparationMaterialReviewActor;
    qualitySignals?: PreparationMaterialQualitySignal[];
    action: "recovery-created" | "manual-content-created";
  }): Promise<PreparationExtractionCandidate | undefined>;
  discardDerivedRevision(input: {
    workspaceId: string;
    materialId: string;
    revisionId: string;
    requestId: string;
    baseRevisionId: string;
  }): Promise<boolean>;
  setReviewState(input: {
    expectedRequestId?: string;
    expectedReviewEventId?: string;
    workspaceId: string;
    materialId: string;
    revisionId: string;
    reviewStatus: PreparationMaterialReviewStatus;
    actor: PreparationMaterialReviewActor;
    qualitySignals?: PreparationMaterialQualitySignal[];
    eventId: string;
    action: "quality-flagged" | "approved";
    detail?: string;
    updatedAt: number;
  }): Promise<boolean>;
  listChunks(revisionId: string): Promise<PreparationMaterialChunk[]>;
}

export interface PreparationMaterialExtractionGateway {
  extract(input: {
    workspaceKind: "interview";
    workspaceId: string;
    materialId: string;
    revision: number;
    requestId: string;
    extension: string;
  }): Promise<NativePreparationMaterialExtractionResult>;
  discard(input: {
    workspaceKind: "interview";
    workspaceId: string;
    materialId: string;
    revision: number;
    requestId: string;
  }): Promise<boolean>;
}

export interface PreparationExtractionTraceEvent {
  outputHash?: string;
  name:
    | "Preparation extraction started"
    | "Preparation extraction finished"
    | "Preparation extraction failed"
    | "Preparation extraction stale result dropped";
  workspaceId: string;
  materialId: string;
  revisionId: string;
  revision: number;
  requestId: string;
  timestamp: number;
  extension?: string;
  status?: PreparationMaterialRevisionStatus;
  method?: PreparationExtractionMethod;
  textChars?: number;
  pageCount?: number;
  ocrPageCount?: number;
  ocrAverageConfidence?: number;
  ocrCandidatePageCount?: number;
  ocrProcessedPageCount?: number;
  ocrFailedPageCount?: number;
  ocrSupplementChars?: number;
  chunkCount?: number;
  warningCodes?: string[];
  durationMs?: number;
  committed?: boolean;
  baseRevisionId?: string;
  patchedPages?: number[];
  inheritedChunkCount?: number;
  replacedChunkCount?: number;
}

export interface PreparationMaterialExtractionScheduler {
  schedule(
    workspaceId: string,
    materialId: string,
    options?: { force?: boolean }
  ): Promise<PreparationExtractionInspection | undefined>;
}
