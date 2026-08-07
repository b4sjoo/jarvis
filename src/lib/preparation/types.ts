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
