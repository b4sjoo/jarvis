import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

export interface RuntimeTraceEvidence {
  traceId: string;
  traceKind: string | undefined;
  status: string | undefined;
  startedAt: number | undefined;
  durationMs: number | undefined;
  exportedAt?: number;
  metadata: Record<string, unknown>;
}

// Shared by the two offline CLIs; final trace metadata remains read-only evidence.
export async function readRuntimeTraceEvidence(directory: string): Promise<RuntimeTraceEvidence[]> {
  let filenames: string[];
  try {
    filenames = await readdir(directory);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const traces: RuntimeTraceEvidence[] = [];
  for (const filename of filenames.filter(name => name.endsWith(".json")).sort()) {
    const payload = JSON.parse(await readFile(path.join(directory, filename), "utf8"));
    const trace = payload.trace ?? payload;
    if (!trace.id) continue;
    traces.push({ traceId: trace.id, traceKind: trace.kind, status: trace.status,
      startedAt: trace.startedAt, durationMs: trace.durationMs, exportedAt: payload.exportedAt,
      metadata: trace.metadata ?? {} });
  }
  return traces;
}

export async function missingAdjudicationEvidenceFiles(directory: string) {
  const missing: string[] = [];
  for (const filename of ["taxonomy/question-type-adjudications.jsonl", "taxonomy/question-type-adjudication-outcomes.jsonl", "runtime-inference/task-relation-decisions.jsonl", "human-evaluation/ground-truth-v2.jsonl", "human-evaluation/projections-v2.json", "traces"]) {
    try { await access(path.join(directory, filename)); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        if (filename === "human-evaluation/projections-v2.json") {
          try { await access(path.join(directory, "human-evaluation/projections-v2.jsonl")); continue; }
          catch (journalError) { if (!(journalError && typeof journalError === "object" && "code" in journalError && journalError.code === "ENOENT")) throw journalError; }
        }
        missing.push(filename);
      }
      else throw error;
    }
  }
  return missing;
}
