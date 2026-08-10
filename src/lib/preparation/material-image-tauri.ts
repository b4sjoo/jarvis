import { invoke } from "@tauri-apps/api/core";

export interface PreparationMaterialImagePayload {
  base64: string;
  mediaType: string;
  sizeBytes: number;
}

export interface PreparationMaterialVisualPage {
  base64: string;
  mediaType: string;
  pageNumber: number;
  pageCount: number;
}

export interface PreparationMaterialVisualPayload {
  materialKind: "image" | "pdf";
  pageCount: number;
  pages: PreparationMaterialVisualPage[];
}

export const tauriPreparationMaterialImage = {
  read(input: {
    workspaceId: string;
    materialId: string;
  }): Promise<PreparationMaterialImagePayload> {
    return invoke("read_preparation_material_image", {
      workspaceKind: "interview",
      workspaceId: input.workspaceId,
      materialId: input.materialId,
    });
  },

  readVisuals(input: {
    workspaceId: string;
    materialId: string;
    requestedPages?: number[];
    maxPages?: number;
  }): Promise<PreparationMaterialVisualPayload> {
    return invoke("read_preparation_material_visuals", {
      workspaceKind: "interview",
      workspaceId: input.workspaceId,
      materialId: input.materialId,
      requestedPages: input.requestedPages,
      maxPages: input.maxPages,
    });
  },
};
