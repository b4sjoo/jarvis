/// <reference lib="webworker" />

import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { SEMANTIC_TAXONOMY_MODEL_VERSION } from "./semantic-taxonomy-model.js";
import type {
  SemanticTaxonomyWorkerRequest,
  SemanticTaxonomyWorkerResponse,
} from "./semantic-taxonomy-runtime.protocol.js";

const workerScope = self as DedicatedWorkerGlobalScope;
let extractor: FeatureExtractionPipeline | undefined;

workerScope.onmessage = async (
  event: MessageEvent<SemanticTaxonomyWorkerRequest>
) => {
  const request = event.data;
  try {
    if (request.type === "initialize") {
      const startedAt = performance.now();
      configureLocalRuntime(request.model.localModelRoot, request.model.localWasmRoot);
      extractor = await pipeline("feature-extraction", request.model.modelId, {
        dtype: request.model.dtype,
        device: "wasm",
        revision: request.model.revision,
        local_files_only: true,
      });
      post({
        type: "ready",
        requestId: request.requestId,
        modelVersion: SEMANTIC_TAXONOMY_MODEL_VERSION,
        durationMs: performance.now() - startedAt,
      });
      return;
    }

    if (request.type === "embed") {
      if (!extractor) throw new Error("Semantic taxonomy model is not ready");
      const startedAt = performance.now();
      const prefix = request.input.kind === "query" ? "query: " : "passage: ";
      const output = await extractor(
        request.input.texts.map((text) => `${prefix}${text.trim()}`),
        { pooling: "mean", normalize: true }
      );
      post({
        type: "embedding",
        requestId: request.requestId,
        input: request.input,
        embeddings: output.tolist() as number[][],
        durationMs: performance.now() - startedAt,
      });
      return;
    }

    if (extractor) {
      await extractor.dispose();
      extractor = undefined;
    }
    post({ type: "disposed", requestId: request.requestId });
  } catch (error) {
    post({
      type: "error",
      requestId: request.requestId,
      message: error instanceof Error ? error.message : String(error),
      recoverable: request.type !== "dispose",
    });
  }
};

function configureLocalRuntime(modelRoot: string, wasmRoot: string) {
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = modelRoot;
  const isSafari = /safari/i.test(navigator.userAgent) && !/chrome|chromium/i.test(navigator.userAgent);
  const stem = isSafari
    ? "ort-wasm-simd-threaded"
    : "ort-wasm-simd-threaded.asyncify";
  const wasmBackend = env.backends.onnx?.wasm;
  if (!wasmBackend) {
    throw new Error("Transformers.js ONNX WASM backend is unavailable");
  }
  wasmBackend.wasmPaths = {
    mjs: `${wasmRoot}${stem}.mjs`,
    wasm: `${wasmRoot}${stem}.wasm`,
  };
}

function post(response: SemanticTaxonomyWorkerResponse) {
  workerScope.postMessage(response);
}

export {};
