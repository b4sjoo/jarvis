import type { SEMANTIC_TAXONOMY_MODEL } from "./semantic-taxonomy-model.js";

export type SemanticTaxonomyEmbeddingKind = "query" | "passage";

export interface SemanticTaxonomyRuntimeIdentity {
  sessionId: string;
  runtimeEpoch: number;
}

export interface SemanticTaxonomyEmbeddingInput
  extends SemanticTaxonomyRuntimeIdentity {
  turnId: string;
  texts: string[];
  kind: SemanticTaxonomyEmbeddingKind;
}

export type SemanticTaxonomyWorkerRequest =
  | {
      type: "initialize";
      requestId: string;
      model: typeof SEMANTIC_TAXONOMY_MODEL;
    }
  | {
      type: "embed";
      requestId: string;
      input: SemanticTaxonomyEmbeddingInput;
    }
  | { type: "dispose"; requestId: string };

export type SemanticTaxonomyWorkerResponse =
  | {
      type: "ready";
      requestId: string;
      modelVersion: string;
      durationMs: number;
    }
  | {
      type: "embedding";
      requestId: string;
      input: SemanticTaxonomyEmbeddingInput;
      embeddings: number[][];
      durationMs: number;
    }
  | {
      type: "disposed";
      requestId: string;
    }
  | {
      type: "error";
      requestId: string;
      message: string;
      recoverable: boolean;
    };
