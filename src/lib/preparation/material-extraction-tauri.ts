import { invoke } from "@tauri-apps/api/core";
import type { PreparationMaterialExtractionGateway } from "./extraction-types.js";

export const tauriPreparationMaterialExtraction: PreparationMaterialExtractionGateway = {
  extract(input) {
    return invoke("extract_preparation_material_file", input);
  },
  discard(input) {
    return invoke("discard_preparation_material_extraction_file", input);
  },
};
