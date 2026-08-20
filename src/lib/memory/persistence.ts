import type { MemoryEntry, MemoryInterviewFamily } from "./types.js";

const MEMORY_INTERVIEW_FAMILIES = new Set<MemoryInterviewFamily>([
  "behavioral",
  "coding",
  "system-design",
  "ai-ml-system-design",
  "project-deep-dive",
]);

export type PersistedMemoryInterviewFamiliesStatus =
  | "missing"
  | "explicit"
  | "malformed";

export interface PersistedMemoryInterviewFamiliesDecision {
  status: PersistedMemoryInterviewFamiliesStatus;
  families?: MemoryInterviewFamily[];
  reason?: "invalid-json" | "not-array" | "invalid-family";
}

export const UPSERT_PERSISTED_MEMORY_ENTRY_SQL = `INSERT INTO memory_entries
  (id, source_ids, type, title, content, summary, scope, project_id,
   project_name, tags, keywords, priority, enabled, injection_mode,
   use_cases, interview_families, confidentiality, curation_status, related_entry_ids,
   evidence_entry_ids, draft_path, created_at, updated_at, last_used_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT(id) DO UPDATE SET
   source_ids = excluded.source_ids,
   type = excluded.type,
   title = excluded.title,
   content = excluded.content,
   summary = excluded.summary,
   scope = excluded.scope,
   project_id = excluded.project_id,
   project_name = excluded.project_name,
   tags = excluded.tags,
   keywords = excluded.keywords,
   priority = excluded.priority,
   enabled = excluded.enabled,
   injection_mode = excluded.injection_mode,
   use_cases = excluded.use_cases,
   interview_families = excluded.interview_families,
   confidentiality = excluded.confidentiality,
   curation_status = excluded.curation_status,
   related_entry_ids = excluded.related_entry_ids,
   evidence_entry_ids = excluded.evidence_entry_ids,
   draft_path = excluded.draft_path,
   updated_at = excluded.updated_at,
   last_used_at = COALESCE(excluded.last_used_at, memory_entries.last_used_at)`;

export function buildPersistedMemoryEntryParameters(
  entry: MemoryEntry,
  importedAt: number
): Array<string | number | null> {
  return [
    entry.id,
    JSON.stringify(entry.sourceIds),
    entry.type,
    entry.title,
    entry.content,
    entry.summary ?? null,
    entry.scope,
    entry.projectId ?? null,
    entry.projectName ?? null,
    JSON.stringify(entry.tags),
    JSON.stringify(entry.keywords),
    entry.priority,
    entry.enabled ? 1 : 0,
    entry.injectionMode,
    JSON.stringify(entry.useCases),
    encodePersistedMemoryInterviewFamilies(entry.interviewFamilies),
    entry.confidentiality,
    entry.curationStatus,
    JSON.stringify(entry.relatedEntryIds),
    JSON.stringify(entry.evidenceEntryIds),
    entry.draftPath ?? null,
    importedAt,
    importedAt,
    entry.lastUsedAt ?? null,
  ];
}

export function encodePersistedMemoryInterviewFamilies(
  families: MemoryEntry["interviewFamilies"]
): string | null {
  const canonical = dedupeFamilies(families ?? []);
  return canonical.length ? JSON.stringify(canonical) : null;
}

export function decodePersistedMemoryInterviewFamilies(
  value: string | null | undefined
): PersistedMemoryInterviewFamiliesDecision {
  if (!value) return { status: "missing" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { status: "malformed", reason: "invalid-json" };
  }

  if (!Array.isArray(parsed)) {
    return { status: "malformed", reason: "not-array" };
  }
  if (!parsed.length) return { status: "missing" };
  if (
    parsed.some(
      (family) =>
        typeof family !== "string" ||
        !MEMORY_INTERVIEW_FAMILIES.has(family as MemoryInterviewFamily)
    )
  ) {
    return { status: "malformed", reason: "invalid-family" };
  }

  return {
    status: "explicit",
    families: dedupeFamilies(parsed as MemoryInterviewFamily[]),
  };
}

export function hydratePersistedMemoryInterviewFamilies<T extends MemoryEntry>(
  entry: T,
  value: string | null | undefined
) {
  const decision = decodePersistedMemoryInterviewFamilies(value);
  return {
    entry: {
      ...entry,
      interviewFamilies: decision.families,
    } satisfies T,
    interviewFamiliesStatus: decision.status,
  };
}

function dedupeFamilies(families: MemoryInterviewFamily[]) {
  return Array.from(new Set(families));
}
