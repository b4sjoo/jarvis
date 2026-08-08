import { invoke } from "@tauri-apps/api/core";
import type { PreparationMaterialStorageGateway } from "./types";

export const tauriPreparationMaterialStorage: PreparationMaterialStorageGateway = {
  import: (input) =>
    invoke("import_preparation_material_file", {
      workspaceKind: input.kind,
      workspaceId: input.workspaceId,
      materialId: input.materialId,
      sourcePath: input.sourcePath,
    }),
  stageDelete: async (input) => {
    const result = await invoke<{ token: string | null }>(
      "stage_preparation_material_storage_delete",
      {
        workspaceKind: input.kind,
        workspaceId: input.workspaceId,
        materialId: input.materialId,
      }
    );
    return { token: result.token ?? undefined };
  },
  restoreDelete: (input) =>
    invoke("restore_preparation_material_storage_delete", {
      workspaceKind: input.kind,
      workspaceId: input.workspaceId,
      materialId: input.materialId,
      token: input.token,
    }),
  commitDelete: async (input) => {
    await invoke("commit_preparation_material_storage_delete", {
      workspaceKind: input.kind,
      workspaceId: input.workspaceId,
      token: input.token,
    });
  },
};
