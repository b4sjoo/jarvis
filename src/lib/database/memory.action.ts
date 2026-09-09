import { invoke } from "@tauri-apps/api/core";
import { CURATED_MEMORY_DRAFTS } from "@/lib/memory/curated-drafts";
import { auditMemoryInterviewFamilyNormalization } from "@/lib/memory/interview-family";
import { parseCuratedMemoryDrafts } from "@/lib/memory/parser";
import {
  buildMemoryEntryCandidate,
  buildMemorySourceCandidate,
  hydratePersistedMemoryInterviewFamilies,
} from "@/lib/memory/persistence";
import {
  invalidateMemoryRetrievalSnapshot,
  type MemorySnapshotLoadResult,
} from "@/lib/memory/retrieval-runtime";
import type {
  MemoryEntry,
  MemoryImportSummary,
  MemoryProject,
  MemorySource,
} from "@/lib/memory";
import { getDatabase } from "./config";

interface MemorySourceRow {
  revision: number;
  content_hash: string | null;
  id: string;
  title: string;
  collection: string;
  source_origin: string;
  source_format: string;
  source_role: string;
  original_path: string | null;
  scope: string;
  project_id: string | null;
  project_name: string | null;
  confidentiality: string;
  canonicality: string;
  raw_injection_policy: string;
  curation_status: string;
  checksum: string | null;
  draft_path: string | null;
  created_at: number;
  updated_at: number;
}

interface MemoryEntryRow {
  revision: number;
  content_hash: string | null;
  source_revisions_json: string | null;
  id: string;
  source_ids: string;
  type: string;
  title: string;
  content: string;
  summary: string | null;
  scope: string;
  project_id: string | null;
  project_name: string | null;
  tags: string;
  keywords: string;
  priority: string;
  enabled: number;
  injection_mode: string;
  use_cases: string;
  interview_families: string | null;
  confidentiality: string;
  curation_status: string;
  related_entry_ids: string;
  evidence_entry_ids: string;
  draft_path: string | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

interface MemoryProjectRow {
  id: string;
  name: string;
  scope: string;
  entry_count: number;
  created_at: number;
  updated_at: number;
}

const ENTRY_SELECT = `SELECT r.*, e.id, e.enabled, e.created_at, e.updated_at, e.last_used_at
  FROM memory_entries e JOIN memory_entry_revisions r
    ON r.entry_id=e.id AND r.revision=e.current_content_revision`;
const SOURCE_SELECT = `SELECT r.*, s.id, s.created_at, s.updated_at
  FROM memory_sources s JOIN memory_source_revisions r
    ON r.source_id=s.id AND r.revision=s.current_content_revision`;

export async function rebuildCuratedMemoryIndex(): Promise<MemoryImportSummary> {
  const parsedDrafts = parseCuratedMemoryDrafts(CURATED_MEMORY_DRAFTS);
  const sources = dedupeById(parsedDrafts.flatMap((draft) => draft.sources));
  const entries = dedupeById(parsedDrafts.flatMap((draft) => draft.entries));
  const warnings = parsedDrafts.flatMap((draft) => draft.warnings);
  warnings.push(
    ...auditMemoryInterviewFamilyNormalization(entries).map(
      (issue) =>
        `${issue.entryId}: specialized interview-family metadata (${issue.aliases.join(", ")}) resolved as general`
    )
  );
  const projects = buildProjects(entries, sources);
  const importedAt = Date.now();
  await getDatabase();

  const publication = await invoke<NonNullable<MemoryImportSummary["publication"]>>("memory_content_publish", {
    input: {
      sources: sources.map(buildMemorySourceCandidate),
      entries: entries.map(buildMemoryEntryCandidate),
      projects,
      importedAt,
    },
  });
  if (publication.retainedStaleEntries) {
    warnings.push(`Preserved ${publication.retainedStaleEntries} stale memory entries referenced by Preparation snapshots and disabled them.`);
  }

  invalidateMemoryRetrievalSnapshot({
    kind: "hard",
    reason: "curated-index-rebuilt",
  });

  return {
    importedAt,
    publication,
    draftCount: parsedDrafts.length,
    sourceCount: sources.length,
    entryCount: entries.length,
    projectCount: projects.length,
    warnings,
  };
}

export async function getMemorySources(): Promise<MemorySource[]> {
  const db = await getDatabase();
  const rows = await db.select<MemorySourceRow[]>(
    `${SOURCE_SELECT} ORDER BY r.collection ASC, r.project_name ASC, r.title ASC`
  );
  return rows.map(mapSourceRow);
}

export async function getMemoryEntries(): Promise<MemoryEntry[]> {
  return (await loadMemoryEntriesForSnapshot()).entries;
}

export async function loadMemoryEntriesForSnapshot(): Promise<MemorySnapshotLoadResult> {
  const acquireStartedAt = monotonicNow();
  const db = await getDatabase();
  const databaseAcquireMs = elapsedMs(acquireStartedAt);
  const readStartedAt = monotonicNow();
  const rows = await db.select<MemoryEntryRow[]>(
    `${ENTRY_SELECT} ORDER BY r.priority DESC, r.project_name ASC, r.title ASC`
  );
  const databaseReadMs = elapsedMs(readStartedAt);
  const mappingStartedAt = monotonicNow();
  let persistedInterviewFamiliesExplicitCount = 0;
  let persistedInterviewFamiliesMissingCount = 0;
  let persistedInterviewFamiliesMalformedCount = 0;
  const entries = rows.map((row) => {
    const mapped = mapEntryRow(row);
    if (mapped.interviewFamiliesStatus === "explicit") {
      persistedInterviewFamiliesExplicitCount += 1;
    } else if (mapped.interviewFamiliesStatus === "malformed") {
      persistedInterviewFamiliesMalformedCount += 1;
    } else {
      persistedInterviewFamiliesMissingCount += 1;
    }
    return mapped.entry;
  });
  const rowMappingMs = elapsedMs(mappingStartedAt);
  return {
    entries,
    timings: {
      databaseAcquireMs,
      databaseReadMs,
      rowMappingMs,
      persistedInterviewFamiliesExplicitCount,
      persistedInterviewFamiliesMissingCount,
      persistedInterviewFamiliesMalformedCount,
    },
  };
}

export async function getEnabledMemoryEntries(): Promise<MemoryEntry[]> {
  const db = await getDatabase();
  const rows = await db.select<MemoryEntryRow[]>(
    `${ENTRY_SELECT} WHERE e.enabled = 1`
  );
  return rows.map((row) => mapEntryRow(row).entry);
}

export async function getMemoryProjects(): Promise<MemoryProject[]> {
  const db = await getDatabase();
  const rows = await db.select<MemoryProjectRow[]>(
    "SELECT * FROM memory_projects ORDER BY name ASC"
  );
  return rows.map(mapProjectRow);
}

export async function getMemoryEntryRevision(id: string, revision: number): Promise<MemoryEntry | undefined> {
  const db = await getDatabase();
  const rows = await db.select<MemoryEntryRow[]>(`SELECT r.*, e.id, e.enabled, e.created_at, e.updated_at, e.last_used_at
    FROM memory_entries e JOIN memory_entry_revisions r ON r.entry_id=e.id
    WHERE e.id=? AND r.revision=?`, [id, revision]);
  return rows[0] ? mapEntryRow(rows[0]).entry : undefined;
}

export async function getMemorySourceRevision(id: string, revision: number): Promise<MemorySource | undefined> {
  const db = await getDatabase();
  const rows = await db.select<MemorySourceRow[]>(`SELECT r.*, s.id, s.created_at, s.updated_at
    FROM memory_sources s JOIN memory_source_revisions r ON r.source_id=s.id
    WHERE s.id=? AND r.revision=?`, [id, revision]);
  return rows[0] ? mapSourceRow(rows[0]) : undefined;
}

export async function setMemoryEntryEnabled(id: string, enabled: boolean) {
  const db = await getDatabase();
  await db.execute(
    "UPDATE memory_entries SET enabled = ?, updated_at = ? WHERE id = ?",
    [enabled ? 1 : 0, Date.now(), id]
  );
  invalidateMemoryRetrievalSnapshot({
    kind: enabled ? "soft" : "hard",
    reason: enabled ? "memory-entry-enabled" : "memory-entry-disabled",
    affectedEntryIds: enabled ? undefined : [id],
  });
}

export async function markMemoryEntriesUsedBatch(entryIds: string[]) {
  const uniqueIds = Array.from(
    new Set(entryIds.map((id) => id.trim()).filter(Boolean))
  );
  if (!uniqueIds.length) return;

  const db = await getDatabase();
  const now = Date.now();
  const chunkSize = 400;
  for (let index = 0; index < uniqueIds.length; index += chunkSize) {
    const chunk = uniqueIds.slice(index, index + chunkSize);
    const placeholders = chunk.map(() => "?").join(", ");
    await db.execute(
      `UPDATE memory_entries
       SET last_used_at = ?
       WHERE id IN (${placeholders})`,
      [now, ...chunk]
    );
  }
}

export async function markMemoryEntriesUsed(entryIds: string[]) {
  await markMemoryEntriesUsedBatch(entryIds);
}

function buildProjects(
  entries: MemoryEntry[],
  sources: MemorySource[]
): MemoryProject[] {
  const projectMap = new Map<string, MemoryProject>();

  for (const item of [...sources, ...entries]) {
    if (item.scope !== "project" || !item.projectId) continue;
    const existing = projectMap.get(item.projectId);
    const name = item.projectName || item.projectId;
    projectMap.set(item.projectId, {
      id: item.projectId,
      name: existing?.name || name,
      scope: "project",
      entryCount: entries.filter((entry) => entry.projectId === item.projectId)
        .length,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    });
  }

  return Array.from(projectMap.values()).sort((left, right) =>
    left.name.localeCompare(right.name)
  );
}

function dedupeById<T extends { id: string }>(items: T[]) {
  const itemMap = new Map<string, T>();
  for (const item of items) {
    itemMap.set(item.id, item);
  }
  return Array.from(itemMap.values());
}

function mapSourceRow(row: MemorySourceRow): MemorySource {
  return {
    contentRevision: row.revision,
    contentHash: row.content_hash ?? undefined,
    id: row.id,
    title: row.title,
    collection: row.collection as MemorySource["collection"],
    sourceOrigin: row.source_origin as MemorySource["sourceOrigin"],
    sourceFormat: row.source_format as MemorySource["sourceFormat"],
    sourceRole: row.source_role as MemorySource["sourceRole"],
    originalPath: row.original_path ?? undefined,
    scope: row.scope as MemorySource["scope"],
    projectId: row.project_id ?? undefined,
    projectName: row.project_name ?? undefined,
    confidentiality: row.confidentiality as MemorySource["confidentiality"],
    canonicality: row.canonicality as MemorySource["canonicality"],
    rawInjectionPolicy:
      row.raw_injection_policy as MemorySource["rawInjectionPolicy"],
    curationStatus: row.curation_status as MemorySource["curationStatus"],
    checksum: row.checksum ?? undefined,
    draftPath: row.draft_path ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEntryRow(row: MemoryEntryRow) {
  return hydratePersistedMemoryInterviewFamilies(
    {
      id: row.id,
      contentRevision: row.revision,
      contentHash: row.content_hash ?? undefined,
      sourceRevisions: row.source_revisions_json ? JSON.parse(row.source_revisions_json) as Record<string, number | null> : undefined,
      sourceIds: parseJsonArray(row.source_ids),
      type: row.type as MemoryEntry["type"],
      title: row.title,
      content: row.content,
      summary: row.summary ?? undefined,
      scope: row.scope as MemoryEntry["scope"],
      projectId: row.project_id ?? undefined,
      projectName: row.project_name ?? undefined,
      tags: parseJsonArray(row.tags),
      keywords: parseJsonArray(row.keywords),
      priority: row.priority as MemoryEntry["priority"],
      enabled: Boolean(row.enabled),
      injectionMode: row.injection_mode as MemoryEntry["injectionMode"],
      useCases: parseJsonArray(row.use_cases) as MemoryEntry["useCases"],
      confidentiality: row.confidentiality as MemoryEntry["confidentiality"],
      curationStatus: row.curation_status as MemoryEntry["curationStatus"],
      relatedEntryIds: parseJsonArray(row.related_entry_ids),
      evidenceEntryIds: parseJsonArray(row.evidence_entry_ids),
      draftPath: row.draft_path ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at ?? undefined,
    } satisfies MemoryEntry,
    row.interview_families
  );
}

function mapProjectRow(row: MemoryProjectRow): MemoryProject {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope as MemoryProject["scope"],
    entryCount: row.entry_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function monotonicNow() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function elapsedMs(startedAt: number) {
  return Math.max(0, monotonicNow() - startedAt);
}

function parseJsonArray(value: string | null | undefined) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
