import { classifyRuntimeMemoryRole } from "./runtime-role.js";
import type { MemorySnapshotReadResult } from "./retrieval-runtime.js";
import type {
  MemoryEntry,
  MemoryProjectCandidate,
  MemoryProjectDirectory,
} from "./types.js";

const PRIORITY = { low: 0, normal: 4, high: 12, pinned: 24 };

export function buildMemoryProjectDirectory(
  snapshot: MemorySnapshotReadResult
): MemoryProjectDirectory {
  const { telemetry } = snapshot;
  const directory: MemoryProjectDirectory = {
    status: telemetry.cacheState === "unavailable" ? "unavailable" : "ready",
    candidates: [],
    snapshotVersion: telemetry.snapshotVersion,
    snapshotGeneration: telemetry.snapshotGeneration,
    authorityRevision: telemetry.authorityRevision,
    snapshotSessionId: telemetry.snapshotSessionId,
    rejectedEntries: [],
    degradedReason: telemetry.degradedReason,
  };
  if (directory.status !== "ready") return directory;

  const groups = new Map<string, MemoryEntry[]>();
  for (const entry of snapshot.entries) {
    const projectId = entry.projectId?.trim();
    const projectName = entry.projectName?.trim();
    const reason = projectDiscoveryRejection(entry);
    if (reason) {
      directory.rejectedEntries.push({ entryId: entry.id, reason });
      continue;
    }
    // Scope describes sharing; canonical identity describes project membership.
    const key = projectId ? `id:${projectId}` : `name:${projectName}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  directory.candidates = Array.from(groups.values())
    .map((entries): MemoryProjectCandidate => {
      const ordered = [...entries].sort((a, b) =>
        PRIORITY[b.priority] - PRIORITY[a.priority] || a.id.localeCompare(b.id)
      );
      const projectId = ordered[0].projectId?.trim();
      const projectName = ordered.find((entry) => entry.projectName?.trim())
        ?.projectName?.trim() || projectId!;
      return {
        projectId,
        projectName,
        primaryEntryId: ordered[0].id,
        evidenceEntryIds: Array.from(new Set(ordered.map((entry) => entry.id))),
        // Feature terms remain hints, never interviewer-explicit identity authority.
        identityAliases: collectProjectIdentityAliases(projectName, projectId, ordered),
        score: PRIORITY[ordered[0].priority],
      };
    })
    .sort((a, b) => b.score - a.score || a.projectName.localeCompare(b.projectName));
  return directory;
}

function projectDiscoveryRejection(entry: MemoryEntry) {
  if (!entry.enabled) return "disabled";
  if (entry.injectionMode === "manual_only" || entry.injectionMode === "never") {
    return "manual-or-never";
  }
  if (entry.curationStatus !== "curated" && entry.curationStatus !== "verified") {
    return "uncurated";
  }
  if (!entry.projectId?.trim() && !entry.projectName?.trim()) return "missing-project-identity";
  if (!classifyRuntimeMemoryRole(entry).anchorEligible) return "not-fact-evidence";
  if (!entry.content.trim()) return "empty-fact-evidence";
  return undefined;
}

function collectProjectIdentityAliases(
  projectName: string,
  projectId: string | undefined,
  entries: MemoryEntry[]
) {
  const rawAliases = [
    projectName, projectId,
    ...entries.flatMap((entry) => [entry.title, ...entry.tags, ...entry.keywords]),
  ].filter((value): value is string => Boolean(value?.trim()));
  return Array.from(new Set(rawAliases.flatMap((value) => {
    const tokens = value.normalize("NFKC").toLowerCase()
      .replace(/[^\p{L}\p{N}+#.]+/gu, " ").split(/\s+/)
      .filter((token) => token && !ALIAS_STOP_TERMS.has(token));
    if (tokens.length < 2) return [];
    if (tokens.length <= 4) return [tokens.join(" ")];
    return [4, 3].flatMap((size) => Array.from(
      { length: tokens.length - size + 1 },
      (_, index) => tokens.slice(index, index + size).join(" ")
    ));
  })));
}

// Existing project-binding alias vocabulary, moved with candidate construction.
const ALIAS_STOP_TERMS = new Set([
  "project", "system", "service", "platform", "feature", "tool", "app", "application",
  "a", "an", "and", "api", "apis", "for", "in", "of", "on", "the", "to", "with",
]);
