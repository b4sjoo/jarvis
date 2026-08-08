export type PreparationWorkspaceKind = "interview" | "case";
export type PreparationWorkspaceStatus = "active" | "archived" | "deleting";

export interface PreparationWorkspace {
  id: string;
  kind: PreparationWorkspaceKind;
  title: string;
  status: PreparationWorkspaceStatus;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

export interface PreparationWorkspaceRepository {
  insert(workspace: PreparationWorkspace): Promise<void>;
  get(id: string): Promise<PreparationWorkspace | undefined>;
  list(input?: {
    kind?: PreparationWorkspaceKind;
    includeArchived?: boolean;
  }): Promise<PreparationWorkspace[]>;
  setLifecycle(input: {
    id: string;
    status: PreparationWorkspaceStatus;
    updatedAt: number;
    archivedAt?: number;
  }): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface PreparationWorkspaceStorageGateway {
  ensure(input: {
    kind: PreparationWorkspaceKind;
    workspaceId: string;
  }): Promise<{ relativeRoot: string; created: boolean }>;
  stageDelete(input: {
    kind: PreparationWorkspaceKind;
    workspaceId: string;
  }): Promise<{ token?: string }>;
  restoreDelete(input: {
    kind: PreparationWorkspaceKind;
    workspaceId: string;
    token: string;
  }): Promise<void>;
  commitDelete(input: {
    kind: PreparationWorkspaceKind;
    token: string;
  }): Promise<void>;
}

export type PreparationMaterialScope =
  | { kind: "workspace" }
  | { kind: "round"; roundId: string };

export type PreparationMaterialStatus =
  | "received"
  | "extracting"
  | "ready"
  | "needs-review"
  | "unsupported"
  | "failed"
  | "deleted";

export interface PreparationMaterial {
  id: string;
  workspaceId: string;
  scope: PreparationMaterialScope;
  displayName: string;
  originalFileName: string;
  mimeType: string;
  extension?: string;
  sizeBytes: number;
  checksumSha256: string;
  storageRelativePath: string;
  status: PreparationMaterialStatus;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export type PreparationSourceKind =
  | "user-upload"
  | "screenshot"
  | "pasted-image"
  | "pasted-text"
  | "job-url"
  | "kmb-entry";

export interface PreparationSourceRef {
  id: string;
  workspaceId: string;
  materialId?: string;
  materialRevisionId?: string;
  sourceKind: PreparationSourceKind;
  locator: string;
  contentHash: string;
  createdAt: number;
}

export type PreparationMaterialRevisionStatus =
  | "pending"
  | "extracting"
  | "ready"
  | "needs-review"
  | "unsupported"
  | "failed";

export interface PreparationMaterialRevision {
  id: string;
  materialId: string;
  revision: number;
  sourceChecksumSha256: string;
  extractionStatus: PreparationMaterialRevisionStatus;
  extractedTextRelativePath?: string;
  extractionMetadata?: string;
  createdAt: number;
  completedAt?: number;
}

export interface PreparationMaterialRepository {
  insert(input: {
    material: PreparationMaterial;
    revision: PreparationMaterialRevision;
    sourceRef: PreparationSourceRef;
  }): Promise<void>;
  get(id: string): Promise<PreparationMaterial | undefined>;
  list(workspaceId: string): Promise<PreparationMaterial[]>;
  findByChecksum(
    workspaceId: string,
    checksumSha256: string
  ): Promise<PreparationMaterial | undefined>;
  setLifecycle(input: {
    id: string;
    workspaceId: string;
    status: PreparationMaterialStatus;
    updatedAt: number;
    deletedAt?: number;
  }): Promise<void>;
}

export interface ImportedPreparationMaterialFile {
  originalFileName: string;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  checksumSha256: string;
  storageRelativePath: string;
}

export interface PreparationMaterialStorageGateway {
  import(input: {
    kind: PreparationWorkspaceKind;
    workspaceId: string;
    materialId: string;
    sourcePath: string;
  }): Promise<ImportedPreparationMaterialFile>;
  stageDelete(input: {
    kind: PreparationWorkspaceKind;
    workspaceId: string;
    materialId: string;
  }): Promise<{ token?: string }>;
  restoreDelete(input: {
    kind: PreparationWorkspaceKind;
    workspaceId: string;
    materialId: string;
    token: string;
  }): Promise<void>;
  commitDelete(input: {
    kind: PreparationWorkspaceKind;
    workspaceId: string;
    token: string;
  }): Promise<void>;
}
