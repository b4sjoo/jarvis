import type {
  InterviewProcessRepository,
  InterviewRoundResourceDeletionLease,
} from "./interview-types.js";
import type {
  PreparationMaterial,
  PreparationRetrievalPurpose,
  PreparationMaterialRepository,
  PreparationMaterialScope,
  PreparationMaterialStorageGateway,
  PreparationSourceRef,
  PreparationWorkspaceRepository,
} from "./types.js";
import type { PreparationMaterialExtractionScheduler } from "./extraction-types.js";

const MAX_FILES_PER_IMPORT = 12;

export interface PreparationMaterialServiceDependencies {
  materials: PreparationMaterialRepository;
  materialStorage: PreparationMaterialStorageGateway;
  workspaces: PreparationWorkspaceRepository;
  interviewProcesses: InterviewProcessRepository;
  extractionScheduler?: PreparationMaterialExtractionScheduler;
  now?: () => number;
  createId?: () => string;
}

export type PreparationMaterialImportOutcome =
  | { status: "imported"; material: PreparationMaterial }
  | { status: "duplicate"; existing: PreparationMaterial }
  | { status: "failed"; selectionIndex: number; error: string };

export function createPreparationMaterialService(
  dependencies: PreparationMaterialServiceDependencies
) {
  const now = dependencies.now ?? Date.now;
  const createId = dependencies.createId ?? (() => crypto.randomUUID());

  return {
    async updatePurpose(workspaceId: string, materialId: string, purpose?: PreparationRetrievalPurpose) {
      if (purpose !== undefined && purpose !== "guidance" && purpose !== "personal-context") {
        throw new Error("Invalid preparation material purpose.");
      }
      await requireWritableInterviewWorkspace(dependencies, workspaceId);
      const material = await dependencies.materials.get(materialId);
      if (!material || material.workspaceId !== workspaceId || material.status === "deleted") {
        throw new Error("Preparation material not found.");
      }
      await dependencies.materials.updatePurpose({ id: materialId, workspaceId, purpose });
      return { ...material, purpose };
    },
    list(workspaceId: string) {
      return dependencies.materials.list(workspaceId);
    },

    async importPaths(input: {
      workspaceId: string;
      sourcePaths: string[];
      scope: PreparationMaterialScope;
    }): Promise<PreparationMaterialImportOutcome[]> {
      if (
        input.sourcePaths.length === 0 ||
        input.sourcePaths.length > MAX_FILES_PER_IMPORT
      ) {
        throw new Error(`Select 1-${MAX_FILES_PER_IMPORT} preparation materials.`);
      }
      const workspace = await requireWritableInterviewWorkspace(
        dependencies,
        input.workspaceId
      );
      await validateScope(dependencies.interviewProcesses, input.workspaceId, input.scope);

      const outcomes: PreparationMaterialImportOutcome[] = [];
      for (const [selectionIndex, sourcePath] of input.sourcePaths.entries()) {
        try {
          outcomes.push(
            await importOne({
              dependencies,
              workspaceId: input.workspaceId,
              workspaceKind: workspace.kind,
              scope: input.scope,
              sourcePath,
              now,
              createId,
            })
          );
        } catch (error) {
          outcomes.push({
            status: "failed",
            selectionIndex,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return outcomes;
    },

    async delete(workspaceId: string, materialId: string) {
      const workspace = await requireWritableInterviewWorkspace(
        dependencies,
        workspaceId
      );
      const material = await dependencies.materials.get(materialId);
      if (!material || material.workspaceId !== workspaceId || material.status === "deleted") {
        throw new Error("Preparation material not found.");
      }

      const staged = await dependencies.materialStorage.stageDelete({
        kind: workspace.kind,
        workspaceId,
        materialId,
      });
      const timestamp = now();
      try {
        await dependencies.materials.setLifecycle({
          id: materialId,
          workspaceId,
          status: "deleted",
          updatedAt: timestamp,
          deletedAt: timestamp,
        });
        if (staged.token) {
          await dependencies.materialStorage.commitDelete({
            kind: workspace.kind,
            workspaceId,
            token: staged.token,
          });
        }
      } catch (error) {
        const storageRestored = staged.token
          ? await dependencies.materialStorage
              .restoreDelete({
                kind: workspace.kind,
                workspaceId,
                materialId,
                token: staged.token,
              })
              .then(() => true)
              .catch(() => false)
          : false;

        // Only expose the material again when its immutable original is back.
        if (storageRestored) {
          await dependencies.materials
            .setLifecycle({
              id: materialId,
              workspaceId,
              status: material.status,
              updatedAt: now(),
              deletedAt: material.deletedAt,
            })
            .catch(() => {});
        }
        throw error;
      }
    },

    async updateScope(
      workspaceId: string,
      materialId: string,
      scope: PreparationMaterialScope
    ) {
      await requireWritableInterviewWorkspace(dependencies, workspaceId);
      await validateScope(dependencies.interviewProcesses, workspaceId, scope);
      const material = await dependencies.materials.get(materialId);
      if (
        !material ||
        material.workspaceId !== workspaceId ||
        material.status === "deleted"
      ) {
        throw new Error("Preparation material not found.");
      }
      if (sameMaterialScope(material.scope, scope)) return material;

      const updatedAt = now();
      await dependencies.materials.updateScope({
        id: material.id,
        workspaceId,
        scope,
        updatedAt,
      });
      return { ...material, scope, updatedAt };
    },

    async stageRoundDeletion(
      workspaceId: string,
      roundId: string
    ): Promise<InterviewRoundResourceDeletionLease> {
      const workspace = await requireWritableInterviewWorkspace(
        dependencies,
        workspaceId
      );
      await validateScope(dependencies.interviewProcesses, workspaceId, {
        kind: "round",
        roundId,
      });
      const materials = (await dependencies.materials.list(workspaceId)).filter(
        (material) =>
          material.scope.kind === "round" && material.scope.roundId === roundId
      );
      return stageMaterialDeletionLease({
        dependencies,
        workspaceKind: workspace.kind,
        workspaceId,
        materials,
        now,
      });
    },
  };
}

function sameMaterialScope(
  current: PreparationMaterialScope,
  next: PreparationMaterialScope
) {
  return (
    current.kind === next.kind &&
    (current.kind === "workspace" ||
      (next.kind === "round" && current.roundId === next.roundId))
  );
}

async function stageMaterialDeletionLease(input: {
  dependencies: PreparationMaterialServiceDependencies;
  workspaceKind: "interview";
  workspaceId: string;
  materials: PreparationMaterial[];
  now: () => number;
}): Promise<InterviewRoundResourceDeletionLease> {
  const staged: Array<{
    material: PreparationMaterial;
    token?: string;
  }> = [];
  try {
    for (const material of input.materials) {
      const result = await input.dependencies.materialStorage.stageDelete({
        kind: input.workspaceKind,
        workspaceId: input.workspaceId,
        materialId: material.id,
      });
      staged.push({ material, token: result.token });
    }
  } catch (error) {
    const restoration = await restoreStagedMaterialDirectories(input, staged);
    if (restoration.failures.length) {
      throw new AggregateError(
        [error, ...restoration.failures],
        "Round material staging failed and could not be fully restored."
      );
    }
    throw error;
  }

  const hidden: PreparationMaterial[] = [];
  try {
    const timestamp = input.now();
    for (const entry of staged) {
      await input.dependencies.materials.setLifecycle({
        id: entry.material.id,
        workspaceId: input.workspaceId,
        status: "deleted",
        updatedAt: timestamp,
        deletedAt: timestamp,
      });
      hidden.push(entry.material);
    }
  } catch (error) {
    try {
      await rollbackStagedMaterialDeletion(input, staged, hidden);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Round material metadata failed and could not be fully restored."
      );
    }
    throw error;
  }

  let settled = false;
  return {
    materialCount: staged.length,
    conversationCount: 0,
    async commit() {
      if (settled) return;
      for (const entry of staged) {
        if (!entry.token) continue;
        await input.dependencies.materialStorage.commitDelete({
          kind: input.workspaceKind,
          workspaceId: input.workspaceId,
          token: entry.token,
        });
      }
      settled = true;
    },
    async rollback() {
      if (settled) return;
      await rollbackStagedMaterialDeletion(input, staged, hidden);
      settled = true;
    },
  };
}

async function rollbackStagedMaterialDeletion(
  input: {
    dependencies: PreparationMaterialServiceDependencies;
    workspaceKind: "interview";
    workspaceId: string;
    now: () => number;
  },
  staged: Array<{ material: PreparationMaterial; token?: string }>,
  hidden: PreparationMaterial[]
) {
  const restoration = await restoreStagedMaterialDirectories(input, staged);
  for (const material of hidden) {
    if (!restoration.restored.has(material.id)) continue;
    await input.dependencies.materials.setLifecycle({
      id: material.id,
      workspaceId: input.workspaceId,
      status: material.status,
      updatedAt: input.now(),
      deletedAt: material.deletedAt,
    });
  }
  if (restoration.failures.length) {
    throw new AggregateError(
      restoration.failures,
      `Could not restore ${restoration.failures.length} staged round material(s).`
    );
  }
}

async function restoreStagedMaterialDirectories(
  input: {
    dependencies: PreparationMaterialServiceDependencies;
    workspaceKind: "interview";
    workspaceId: string;
  },
  staged: Array<{ material: PreparationMaterial; token?: string }>
) {
  const restored = new Set<string>();
  const failures: unknown[] = [];
  for (const entry of [...staged].reverse()) {
    if (!entry.token) {
      restored.add(entry.material.id);
      continue;
    }
    try {
      await input.dependencies.materialStorage.restoreDelete({
        kind: input.workspaceKind,
        workspaceId: input.workspaceId,
        materialId: entry.material.id,
        token: entry.token,
      });
      restored.add(entry.material.id);
    } catch (error) {
      failures.push(error);
    }
  }
  return { restored, failures };
}

async function importOne(input: {
  dependencies: PreparationMaterialServiceDependencies;
  workspaceId: string;
  workspaceKind: "interview";
  scope: PreparationMaterialScope;
  sourcePath: string;
  now: () => number;
  createId: () => string;
}): Promise<PreparationMaterialImportOutcome> {
  const materialId = input.createId();
  const imported = await input.dependencies.materialStorage.import({
    kind: input.workspaceKind,
    workspaceId: input.workspaceId,
    materialId,
    sourcePath: input.sourcePath,
  });

  const duplicate = await input.dependencies.materials.findByChecksum(
    input.workspaceId,
    imported.checksumSha256
  );
  if (duplicate) {
    await discardImportedMaterial(input, materialId);
    return { status: "duplicate", existing: duplicate };
  }

  const timestamp = input.now();
  const revisionId = input.createId();
  const material: PreparationMaterial = {
    id: materialId,
    workspaceId: input.workspaceId,
    scope: input.scope,
    displayName: imported.originalFileName,
    originalFileName: imported.originalFileName,
    mimeType: imported.mimeType,
    extension: imported.extension,
    sizeBytes: imported.sizeBytes,
    checksumSha256: imported.checksumSha256,
    storageRelativePath: imported.storageRelativePath,
    status: "received",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const sourceRef: PreparationSourceRef = {
    id: input.createId(),
    workspaceId: input.workspaceId,
    materialId,
    materialRevisionId: revisionId,
    sourceKind: "user-upload",
    locator: `material:${materialId}`,
    contentHash: imported.checksumSha256,
    createdAt: timestamp,
  };

  try {
    await input.dependencies.materials.insert({
      material,
      revision: {
        id: revisionId,
        materialId,
        revision: 1,
        sourceChecksumSha256: imported.checksumSha256,
        extractionStatus: "pending",
        createdAt: timestamp,
      },
      sourceRef,
    });
    void input.dependencies.extractionScheduler
      ?.schedule(input.workspaceId, material.id)
      .catch(() => {});
    return { status: "imported", material };
  } catch (error) {
    const concurrentDuplicate = await input.dependencies.materials
      .findByChecksum(input.workspaceId, imported.checksumSha256)
      .catch(() => undefined);
    await discardImportedMaterial(input, materialId).catch(() => {});
    if (concurrentDuplicate) {
      return { status: "duplicate", existing: concurrentDuplicate };
    }
    throw error;
  }
}

async function discardImportedMaterial(
  input: {
    dependencies: PreparationMaterialServiceDependencies;
    workspaceId: string;
    workspaceKind: "interview";
  },
  materialId: string
) {
  const staged = await input.dependencies.materialStorage.stageDelete({
    kind: input.workspaceKind,
    workspaceId: input.workspaceId,
    materialId,
  });
  if (staged.token) {
    await input.dependencies.materialStorage.commitDelete({
      kind: input.workspaceKind,
      workspaceId: input.workspaceId,
      token: staged.token,
    });
  }
}

async function requireWritableInterviewWorkspace(
  dependencies: PreparationMaterialServiceDependencies,
  workspaceId: string
) {
  const workspace = await dependencies.workspaces.get(workspaceId);
  if (!workspace || workspace.kind !== "interview") {
    throw new Error("Interview preparation workspace not found.");
  }
  if (workspace.status !== "active") {
    throw new Error("Archived interview processes are read-only.");
  }
  return workspace as typeof workspace & { kind: "interview" };
}

async function validateScope(
  interviewProcesses: InterviewProcessRepository,
  workspaceId: string,
  scope: PreparationMaterialScope
) {
  if (scope.kind === "workspace") return;
  const round = await interviewProcesses.getRound(scope.roundId);
  if (!round || round.processId !== workspaceId) {
    throw new Error("Preparation material round does not belong to this process.");
  }
}
