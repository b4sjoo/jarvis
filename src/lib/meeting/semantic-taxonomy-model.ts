import manifest from "../../../model-manifests/semantic-taxonomy-multilingual-e5-small.json" with {
  type: "json",
};

export const SEMANTIC_TAXONOMY_MODEL = {
  modelId: manifest.modelId,
  baseModelId: manifest.baseModelId,
  revision: manifest.revision,
  dtype: manifest.dtype as "q8",
  embeddingDimensions: manifest.embeddingDimensions,
  localModelRoot: manifest.localModelRoot,
  localWasmRoot: manifest.localWasmRoot,
  assetBytes:
    manifest.files.reduce((total, file) => total + file.size, 0) +
    manifest.wasmFiles.reduce((total, file) => total + file.size, 0),
} as const;

export const SEMANTIC_TAXONOMY_MODEL_VERSION = `${SEMANTIC_TAXONOMY_MODEL.modelId}@${SEMANTIC_TAXONOMY_MODEL.revision}:${SEMANTIC_TAXONOMY_MODEL.dtype}`;
