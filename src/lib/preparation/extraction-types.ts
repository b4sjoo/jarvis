import type { PreparationMaterialRevisionStatus } from "./types.js";

export type PreparationExtractionMethod =
  | "plain-text"
  | "markdown"
  | "docx-text"
  | "pdf-text"
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
  startOffset: number;
  endOffset: number;
}

export interface NativePreparationMaterialExtractionResult {
  method: PreparationExtractionMethod;
  status: Extract<
    PreparationMaterialRevisionStatus,
    "ready" | "needs-review" | "unsupported"
  >;
  extractedTextRelativePath?: string;
  textChars: number;
  pageCount?: number;
  warningCodes: string[];
  durationMs: number;
  chunks: NativePreparationMaterialChunk[];
}

export interface PreparationExtractionMetadata {
  method: PreparationExtractionMethod;
  textChars: number;
  pageCount?: number;
  chunkCount: number;
  warningCodes: string[];
  durationMs: number;
  offsetUnit: "unicode-scalar";
  error?: string;
}

export interface PreparationExtractionCandidate {
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
}

export interface PreparationExtractionInspection {
  candidate: PreparationExtractionCandidate;
  chunks: PreparationMaterialChunk[];
}

export interface PreparationMaterialExtractionRepository {
  getCurrent(materialId: string): Promise<PreparationExtractionCandidate | undefined>;
  listRecoverable(
    workspaceId: string,
    staleBefore: number
  ): Promise<PreparationExtractionCandidate[]>;
  claim(input: {
    workspaceId: string;
    materialId: string;
    revisionId: string;
    sourceChecksumSha256: string;
    requestId: string;
    startedAt: number;
    staleBefore: number;
    force?: boolean;
  }): Promise<boolean>;
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
  chunkCount?: number;
  warningCodes?: string[];
  durationMs?: number;
  committed?: boolean;
}

export interface PreparationMaterialExtractionScheduler {
  schedule(
    workspaceId: string,
    materialId: string,
    options?: { force?: boolean }
  ): Promise<PreparationExtractionInspection | undefined>;
}
