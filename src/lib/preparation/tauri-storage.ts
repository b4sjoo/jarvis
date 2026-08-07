import { invoke } from "@tauri-apps/api/core";
import type { PreparationWorkspaceStorageGateway } from "./types";

export const tauriPreparationWorkspaceStorage: PreparationWorkspaceStorageGateway = {
  ensure: (input) =>
    invoke("ensure_preparation_workspace_storage", {
      workspaceKind: input.kind,
      workspaceId: input.workspaceId,
    }),
  stageDelete: async (input) => {
    const result = await invoke<{ token: string | null }>(
      "stage_preparation_workspace_storage_delete",
      {
        workspaceKind: input.kind,
        workspaceId: input.workspaceId,
      }
    );
    return { token: result.token ?? undefined };
  },
  restoreDelete: (input) =>
    invoke("restore_preparation_workspace_storage_delete", {
      workspaceKind: input.kind,
      workspaceId: input.workspaceId,
      token: input.token,
    }),
  commitDelete: async (input) => {
    await invoke("commit_preparation_workspace_storage_delete", {
      workspaceKind: input.kind,
      token: input.token,
    });
  },
};
