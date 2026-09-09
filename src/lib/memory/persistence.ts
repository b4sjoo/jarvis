import type { MemoryEntry, MemoryInterviewFamily, MemorySource } from "./types.js";

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

export interface MemoryContentCandidate {
  id: string;
  enabled?: boolean;
  content: Record<string, string | null>;
}

export function buildMemoryEntryCandidate(entry: MemoryEntry): MemoryContentCandidate {
  return {
    id: entry.id,
    enabled: entry.enabled,
    content: {
      source_ids: JSON.stringify(entry.sourceIds),
      type: entry.type,
      title: entry.title,
      content: entry.content,
      summary: entry.summary ?? null,
      scope: entry.scope,
      project_id: entry.projectId ?? null,
      project_name: entry.projectName ?? null,
      tags: JSON.stringify(entry.tags),
      keywords: JSON.stringify(entry.keywords),
      priority: entry.priority,
      injection_mode: entry.injectionMode,
      use_cases: JSON.stringify(entry.useCases),
      interview_families: encodePersistedMemoryInterviewFamilies(entry.interviewFamilies),
      confidentiality: entry.confidentiality,
      curation_status: entry.curationStatus,
      related_entry_ids: JSON.stringify(entry.relatedEntryIds),
      evidence_entry_ids: JSON.stringify(entry.evidenceEntryIds),
      draft_path: entry.draftPath ?? null,
    },
  };
}

export function buildMemorySourceCandidate(source: MemorySource): MemoryContentCandidate {
  return {
    id: source.id,
    content: {
      title: source.title,
      collection: source.collection,
      source_origin: source.sourceOrigin,
      source_format: source.sourceFormat,
      source_role: source.sourceRole,
      original_path: source.originalPath ?? null,
      scope: source.scope,
      project_id: source.projectId ?? null,
      project_name: source.projectName ?? null,
      confidentiality: source.confidentiality,
      canonicality: source.canonicality,
      raw_injection_policy: source.rawInjectionPolicy,
      curation_status: source.curationStatus,
      checksum: source.checksum ?? null,
      draft_path: source.draftPath ?? null,
    },
  };
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
