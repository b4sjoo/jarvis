import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { env, pipeline } from "@huggingface/transformers";
import {
  SEMANTIC_TAXONOMY_MODEL,
  SEMANTIC_TAXONOMY_MODEL_VERSION,
} from "../src/lib/meeting/semantic-taxonomy-model.js";
import {
  ANSWER_SUFFICIENCY_SEMANTIC_PROTOTYPES,
  ANSWER_SUFFICIENCY_SEMANTIC_PROTOTYPE_VERSION,
} from "../src/lib/meeting/answer-sufficiency-semantic-prototypes.js";

const outputPath = path.join(
  process.cwd(),
  "model-manifests",
  "answer-sufficiency-semantic-prototype-vectors.v1.json"
);

env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = `${path.join(process.cwd(), "public", "models")}${path.sep}`;

const extractor = await pipeline(
  "feature-extraction",
  SEMANTIC_TAXONOMY_MODEL.modelId,
  {
    dtype: SEMANTIC_TAXONOMY_MODEL.dtype,
    device: "cpu",
    revision: SEMANTIC_TAXONOMY_MODEL.revision,
    local_files_only: true,
  }
);
const output = await extractor(
  ANSWER_SUFFICIENCY_SEMANTIC_PROTOTYPES.map(
    (prototype) => `passage: ${prototype.text}`
  ),
  { pooling: "mean", normalize: true }
);
const vectors = output.tolist() as number[][];
await extractor.dispose();

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      version: 1,
      modelVersion: SEMANTIC_TAXONOMY_MODEL_VERSION,
      prototypeVersion: ANSWER_SUFFICIENCY_SEMANTIC_PROTOTYPE_VERSION,
      embeddingDimensions: SEMANTIC_TAXONOMY_MODEL.embeddingDimensions,
      vectors: ANSWER_SUFFICIENCY_SEMANTIC_PROTOTYPES.map(
        (prototype, index) => ({
          id: prototype.id,
          vector: vectors[index],
        })
      ),
    },
    null,
    2
  )}\n`,
  "utf8"
);
process.stdout.write(
  `Wrote ${vectors.length} answer-sufficiency semantic prototype vectors to ${outputPath}\n`
);
