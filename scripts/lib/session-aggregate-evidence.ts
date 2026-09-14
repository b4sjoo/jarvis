import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { HumanEvaluationProjectionV2 } from "../../src/lib/meeting/human-ground-truth-v2.js";
import type { HumanEvaluationProjectionMaterializationStatsV2 } from "../../src/lib/meeting/human-evaluation-projection-materialization.js";

const missing = (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");

async function optionalJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; }
  catch (error) { if (missing(error)) return fallback; throw error; }
}

export async function readRecordedTraceSummaries<T = Record<string, unknown>>(directory: string): Promise<{ traces: T[]; reconstructed: boolean; warnings: string[] }> {
  const manifest = await optionalJson<{ status?: string }>(path.join(directory, "manifest.json"), {});
  const warnings: string[] = [];
  let latest: { traces?: T[] } = {};
  try { latest = await optionalJson(path.join(directory, "metrics/trace-summaries.latest.json"), {}); }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; warnings.push("Incomplete trace aggregate; using individual records."); }
  if (manifest.status === "stopped" && latest.traces) return { traces: latest.traces, reconstructed: false, warnings };
  const rows = new Map<string, T & { traceId: string; startedAt: number }>();
  let folders: Dirent[];
  try { folders = await readdir(path.join(directory, "traces"), { withFileTypes: true }); }
  catch (error) { if (!missing(error)) throw error; folders = []; }
  for (const folder of folders.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, "traces", folder.name, "summary.json");
    try {
      const row = await optionalJson<(T & { traceId: string; startedAt: number }) | undefined>(file, undefined);
      if (row?.traceId) rows.set(row.traceId, row);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      warnings.push(`Incomplete trace summary: ${folder.name}`);
    }
  }
  // Older fixtures/archives may only have the aggregate. Never merge its stale rows into a reconstructed live view.
  const hasIndividualRecords = folders.some((entry) => entry.isDirectory());
  return { traces: hasIndividualRecords ? [...rows.values()].sort((a, b) => a.startedAt - b.startedAt) as T[] : latest.traces ?? [], reconstructed: hasIndividualRecords, warnings };
}

export function latestRecordedProjections(history: HumanEvaluationProjectionV2[]) {
  const latest = new Map<string, HumanEvaluationProjectionV2>();
  for (const projection of history) latest.set(projection.projectionId, projection);
  return [...latest.values()];
}

export async function readRecordedProjectionSnapshot(directory: string) {
  let snapshot: { projections?: HumanEvaluationProjectionV2[]; materialization?: HumanEvaluationProjectionMaterializationStatsV2 } = {};
  try { snapshot = await optionalJson(path.join(directory, "human-evaluation/projections-v2.json"), {}); }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; console.warn("Incomplete projection aggregate; using journal."); }
  const history = await readRecordedJsonLines<HumanEvaluationProjectionV2>(path.join(directory, "human-evaluation/projections-v2.jsonl"));
  const manifest = await optionalJson<{ status?: string }>(path.join(directory, "manifest.json"), {});
  if (manifest.status !== "stopped") {
    // Counter-only duplicate attempts after the last persisted delta were never durable.
    // Do not publish an older checkpoint's counters as the current journal's totals.
    snapshot.materialization = undefined;
    console.warn("Unsealed recording: materialization diagnostics are lower bounds from saved rows, not final runtime attempt/suppression totals.");
  }
  return { ...snapshot, projections: history.length ? latestRecordedProjections(history) : snapshot.projections ?? [], history };
}

export async function readRecordedJsonLines<T>(file: string): Promise<T[]> {
  let text = "";
  try { text = await readFile(file, "utf8"); }
  catch (error) { if (!missing(error)) throw error; }
  const lines = text.trim().split("\n").filter(Boolean);
  const history: T[] = [];
  for (let i = 0; i < lines.length; i++) {
    try { history.push(JSON.parse(lines[i])); }
    catch (error) {
      if (!(error instanceof SyntaxError) || i !== lines.length - 1) throw error;
      console.warn(`Incomplete final journal record in ${file}; retained complete preceding records.`);
    }
  }
  return history;
}
