import {
  SemanticTaxonomyRuntime,
  type SemanticTaxonomyEmbeddingResult,
} from "../lib/meeting/semantic-taxonomy-runtime";
import { SEMANTIC_TAXONOMY_MODEL } from "../lib/meeting/semantic-taxonomy-model";

const BENCHMARK_TURNS = [
  "Walk me through how retrieval augmented generation works.",
  "Design a ticket selling service that avoids double booking.",
  "How would you build a self evolving travel recommendation agent?",
  "Implement a monotonic queue for sliding window maximum.",
  "What was your contribution to the memory feature you built?",
  "Tell me about a time you had to persuade a skeptical teammate.",
  "向我解释一下向量数据库的索引是怎么工作的。",
  "请设计一个高并发的外卖配送系统。",
  "这个 RAG pipeline 的 reranking 为什么要放在 retrieval 后面？",
  "Can you 设计一个 loss function and write the Python implementation?",
] as const;

interface BenchmarkReport {
  model: typeof SEMANTIC_TAXONOMY_MODEL;
  userAgent: string;
  hardwareConcurrency?: number;
  coldWarmupMs?: number;
  readiness: string;
  iterations: number;
  successes: number;
  failures: Array<{ status: string; reason?: string }>;
  latencyMs: {
    p50?: number;
    p95?: number;
    max?: number;
    samples: number[];
  };
  mainThreadTimerDriftMs: {
    p95?: number;
    max?: number;
    samples: number[];
  };
  elapsedMs: number;
}

declare global {
  interface Window {
    __JARVIS_SEMANTIC_TAXONOMY_BENCHMARK__?: BenchmarkReport;
  }
}

const statusElement = document.querySelector<HTMLElement>("#status");
const resultElement = document.querySelector<HTMLElement>("#result");
let benchmarkRevision = 0;

void runBenchmark();

async function runBenchmark() {
  const startedAt = performance.now();
  const runtime = new SemanticTaxonomyRuntime({ warmupTimeoutMs: 120_000 });
  runtime.pinSession(
    { sessionId: "semantic-taxonomy-benchmark", runtimeEpoch: 1 },
    "benchmark"
  );
  updateStatus("Loading local multilingual-e5-small model...");
  const warmup = await runtime.prewarm();
  const failures: BenchmarkReport["failures"] = [];
  const latencySamples: number[] = [];
  const timerDriftSamples: number[] = [];
  let lastTick = performance.now();
  const timer = window.setInterval(() => {
    const now = performance.now();
    timerDriftSamples.push(Math.max(0, now - lastTick - 16));
    lastTick = now;
  }, 16);

  if (warmup.readiness === "ready") {
    updateStatus("Running warm inference samples...");
    await embed(runtime, BENCHMARK_TURNS[0], "warmup", failures);
    for (let index = 0; index < 50; index += 1) {
      const text = BENCHMARK_TURNS[index % BENCHMARK_TURNS.length];
      const result = await embed(runtime, text, `turn-${index}`, failures);
      if (result.status === "success") latencySamples.push(result.durationMs);
    }
  } else {
    failures.push({ status: warmup.readiness, reason: warmup.error });
  }

  window.clearInterval(timer);
  await runtime.dispose("benchmark-finished");
  const report: BenchmarkReport = {
    model: SEMANTIC_TAXONOMY_MODEL,
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    coldWarmupMs: warmup.warmupDurationMs,
    readiness: warmup.readiness,
    iterations: 50,
    successes: latencySamples.length,
    failures,
    latencyMs: summarize(latencySamples),
    mainThreadTimerDriftMs: summarize(timerDriftSamples),
    elapsedMs: performance.now() - startedAt,
  };
  window.__JARVIS_SEMANTIC_TAXONOMY_BENCHMARK__ = report;
  if (resultElement) resultElement.textContent = JSON.stringify(report, null, 2);
  updateStatus(failures.length === 0 ? "Complete" : "Complete with failures");
  document.title = failures.length === 0 ? "BENCHMARK_COMPLETE" : "BENCHMARK_FAILED";
}

async function embed(
  runtime: SemanticTaxonomyRuntime,
  text: string,
  turnId: string,
  failures: BenchmarkReport["failures"]
): Promise<SemanticTaxonomyEmbeddingResult> {
  benchmarkRevision += 1;
  const result = await runtime.embed(
    {
      kind: "query",
      texts: [text],
      sessionId: "semantic-taxonomy-benchmark",
      runtimeEpoch: 1,
      turnId,
    },
    {
      consumer: "benchmark",
      coalescingKey: "semantic-taxonomy-benchmark",
      revision: benchmarkRevision,
      deadlines: {
        coldComputeMs: 5_000,
        warmComputeMs: 5_000,
      },
    }
  );
  if (result.status !== "success") {
    failures.push({ status: result.status, reason: result.reason });
  }
  return result;
}

function summarize(samples: number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1),
    samples: sorted,
  };
}

function percentile(sorted: number[], quantile: number) {
  if (sorted.length === 0) return undefined;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function updateStatus(message: string) {
  if (statusElement) statusElement.textContent = message;
}
