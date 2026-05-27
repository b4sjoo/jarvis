import type {
  MemoryCurationStatus,
  MemoryEntry,
  MemoryImportDraft,
  MemorySource,
  MemorySourceCanonicality,
  MemorySourceRole,
  ParsedMemoryDraft,
  RawInjectionPolicy,
} from "./types";

const MEMORY_SOURCE_COLLECTIONS = [
  "profiles",
  "project_docs",
  "question_bank",
  "interview_guide",
] as const;

const MEMORY_SCOPES = ["global", "project"] as const;
const MEMORY_CONFIDENTIALITIES = [
  "normal",
  "sensitive",
  "confidential",
] as const;
const MEMORY_CURATION_STATUSES = [
  "raw",
  "extracted",
  "curated",
  "verified",
  "stale",
] as const;
const MEMORY_SOURCE_CANONICALITIES = [
  "canonical",
  "supporting",
  "evidence",
  "stale",
] as const;
const RAW_INJECTION_POLICIES = [
  "allow",
  "summary_only",
  "title_only",
  "never",
] as const;
const MEMORY_SOURCE_FORMATS = [
  "markdown",
  "txt",
  "xml",
  "diff",
  "patch",
  "plain_text",
  "unknown",
] as const;
const MEMORY_SOURCE_ORIGINS = ["manual", "imported", "generated"] as const;
const MEMORY_SOURCE_ROLES = [
  "resume",
  "promotion_doc",
  "behavioral_bank",
  "technical_question_bank",
  "company_profile",
  "leadership_principle_rubric",
  "project_summary",
  "design_doc",
  "implementation_plan",
  "implementation_tracker",
  "investigation",
  "working_summary",
  "sop",
  "release_doc",
  "checklist",
  "threat_model",
  "api_guide",
  "prompt_template",
  "code_patch",
  "dev_context",
  "misc",
] as const;
const MEMORY_ENTRY_TYPES = [
  "profile",
  "preference",
  "resume_fact",
  "personal_story",
  "achievement_metric",
  "answer_evidence",
  "working_summary",
  "project_context",
  "design_doc",
  "implementation_note",
  "decision_record",
  "investigation_note",
  "threat_model",
  "field_note",
  "glossary",
  "correction",
  "interview_framework",
  "behavioral_question",
  "technical_question",
  "coding_question",
  "answer_template",
  "cached_answer",
  "evaluation_criteria",
] as const;
const MEMORY_PRIORITIES = ["low", "normal", "high", "pinned"] as const;
const MEMORY_INJECTION_MODES = [
  "always",
  "retrieval",
  "manual_only",
  "never",
] as const;
const MEMORY_USE_CASES = [
  "meeting_assistant",
  "coding_interview",
  "behavioral_interview",
  "answer_alignment",
  "general_chat",
] as const;

type YamlValue = string | boolean | string[] | undefined;
type YamlRecord = Record<string, YamlValue>;

export function parseCuratedMemoryDrafts(
  drafts: MemoryImportDraft[],
  now = Date.now()
) {
  return drafts.map((draft) => parseCuratedMemoryDraft(draft, now));
}

export function parseCuratedMemoryDraft(
  draft: MemoryImportDraft,
  now = Date.now()
): ParsedMemoryDraft {
  const warnings: string[] = [];
  const blocks = extractYamlBlocks(draft.content);
  const sources: MemorySource[] = [];
  const entries: MemoryEntry[] = [];

  for (const block of blocks) {
    const records = parseYamlRecords(block);
    if (!records.length) continue;

    const isSourceBlock = block.trimStart().startsWith("sources:");
    for (const record of records) {
      if (isSourceBlock) {
        const source = normalizeSourceRecord(record, draft.path, now, warnings);
        if (source) sources.push(source);
      } else {
        const entry = normalizeEntryRecord(record, draft.path, now, warnings);
        if (entry) entries.push(entry);
      }
    }
  }

  return { path: draft.path, sources, entries, warnings };
}

function extractYamlBlocks(content: string) {
  const blocks: string[] = [];
  const regex = /```yaml\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    blocks.push(match[1].trimEnd());
  }

  return blocks;
}

function parseYamlRecords(block: string): YamlRecord[] {
  const rawLines = block.replace(/\r/g, "").split("\n");
  const lines = rawLines[0]?.trim() === "sources:" ? rawLines.slice(1) : rawLines;
  const records: YamlRecord[] = [];
  let current: YamlRecord | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;

    const itemMatch = rawLine.match(/^\s*-\s+([A-Za-z0-9_]+):\s*(.*)$/);
    if (itemMatch) {
      if (current) records.push(current);
      current = {};
      current[itemMatch[1]] = parseInlineYamlValue(itemMatch[2]);
      continue;
    }

    if (!current) continue;

    const keyMatch = rawLine.match(/^(\s*)([A-Za-z0-9_]+):\s*(.*)$/);
    if (!keyMatch) continue;

    const [, indent, key, rawValue] = keyMatch;
    if (rawValue.trim() === "|") {
      const { value, nextIndex } = readBlockScalar(lines, index + 1, indent.length);
      current[key] = value;
      index = nextIndex - 1;
      continue;
    }

    current[key] = parseInlineYamlValue(rawValue);
  }

  if (current) records.push(current);
  return records;
}

function readBlockScalar(lines: string[], startIndex: number, parentIndent: number) {
  const values: string[] = [];
  let index = startIndex;
  let trimIndent: number | undefined;

  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      values.push("");
      continue;
    }

    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (indent <= parentIndent) break;
    trimIndent = trimIndent ?? indent;
    values.push(line.slice(Math.min(trimIndent, line.length)));
  }

  return { value: values.join("\n").trim(), nextIndex: index };
}

function parseInlineYamlValue(rawValue: string): YamlValue {
  const trimmed = rawValue.trim();
  if (!trimmed) return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const body = trimmed.slice(1, -1).trim();
    if (!body) return [];
    return body
      .split(",")
      .map((value) => unquote(value.trim()))
      .filter(Boolean);
  }
  return unquote(trimmed);
}

function normalizeSourceRecord(
  record: YamlRecord,
  draftPath: string,
  now: number,
  warnings: string[]
): MemorySource | null {
  const id = readString(record.id);
  const title = readString(record.title);
  const collection = readEnum(
    record.collection,
    MEMORY_SOURCE_COLLECTIONS,
    "project_docs"
  );
  const sourceRole = readEnum(record.sourceRole, MEMORY_SOURCE_ROLES, "misc");
  const curationStatus = readEnum(
    record.curationStatus,
    MEMORY_CURATION_STATUSES,
    "extracted"
  );

  if (!id || !title) {
    warnings.push(`${draftPath}: skipped source without id or title.`);
    return null;
  }

  const source: MemorySource = {
    id,
    title,
    collection,
    sourceOrigin: readEnum(record.sourceOrigin, MEMORY_SOURCE_ORIGINS, "manual"),
    sourceFormat: readEnum(record.sourceFormat, MEMORY_SOURCE_FORMATS, "unknown"),
    sourceRole,
    originalPath: readOptionalString(record.originalPath),
    scope: readEnum(record.scope, MEMORY_SCOPES, "global"),
    projectId: readOptionalString(record.projectId),
    projectName: readOptionalString(record.projectName),
    confidentiality: readEnum(
      record.confidentiality,
      MEMORY_CONFIDENTIALITIES,
      "sensitive"
    ),
    canonicality: readEnum(
      record.canonicality,
      MEMORY_SOURCE_CANONICALITIES,
      inferSourceCanonicality(sourceRole, curationStatus)
    ),
    rawInjectionPolicy: readEnum(
      record.rawInjectionPolicy,
      RAW_INJECTION_POLICIES,
      inferRawInjectionPolicy(sourceRole, curationStatus)
    ),
    curationStatus,
    checksum: readOptionalString(record.checksum),
    draftPath,
    createdAt: now,
    updatedAt: now,
  };

  if (source.scope === "project" && !source.projectId) {
    warnings.push(`${draftPath}: source ${id} is project scoped without projectId.`);
  }

  return source;
}

function normalizeEntryRecord(
  record: YamlRecord,
  draftPath: string,
  now: number,
  warnings: string[]
): MemoryEntry | null {
  const id = readString(record.id);
  const title = readString(record.title);
  const content = readString(record.content);
  const sourceIds = readStringArray(record.sourceIds).length
    ? readStringArray(record.sourceIds)
    : readStringArray(record.sourceId);

  if (!id || !title || !content || !sourceIds.length) {
    warnings.push(`${draftPath}: skipped entry without id, title, content, or sourceIds.`);
    return null;
  }

  const entry: MemoryEntry = {
    id,
    sourceIds,
    type: readEnum(record.type, MEMORY_ENTRY_TYPES, "field_note"),
    title,
    content,
    summary: readOptionalString(record.summary),
    scope: readEnum(record.scope, MEMORY_SCOPES, "global"),
    projectId: readOptionalString(record.projectId),
    projectName: readOptionalString(record.projectName),
    tags: readStringArray(record.tags),
    keywords: readStringArray(record.keywords),
    priority: readEnum(record.priority, MEMORY_PRIORITIES, "normal"),
    enabled: readBoolean(record.enabled, true),
    injectionMode: readEnum(
      record.injectionMode,
      MEMORY_INJECTION_MODES,
      "retrieval"
    ),
    useCases: readEnumArray(record.useCases, MEMORY_USE_CASES, [
      "meeting_assistant",
    ]),
    confidentiality: readEnum(
      record.confidentiality,
      MEMORY_CONFIDENTIALITIES,
      "sensitive"
    ),
    curationStatus: readEnum(
      record.curationStatus,
      MEMORY_CURATION_STATUSES,
      "curated"
    ),
    relatedEntryIds: readStringArray(record.relatedEntryIds),
    evidenceEntryIds: readStringArray(record.evidenceEntryIds),
    draftPath,
    createdAt: now,
    updatedAt: now,
  };

  if (entry.scope === "project" && !entry.projectId) {
    warnings.push(`${draftPath}: entry ${id} is project scoped without projectId.`);
  }

  if (entry.injectionMode !== "manual_only" && entry.curationStatus === "raw") {
    warnings.push(`${draftPath}: entry ${id} is raw but not manual_only.`);
  }

  return entry;
}

function readString(value: YamlValue) {
  return typeof value === "string" ? value.trim() : "";
}

function readOptionalString(value: YamlValue) {
  const stringValue = readString(value);
  return stringValue || undefined;
}

function readBoolean(value: YamlValue, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function readStringArray(value: YamlValue) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const stringValue = readString(value);
  return stringValue ? [stringValue] : [];
}

function readEnum<T extends readonly string[]>(
  value: YamlValue,
  allowed: T,
  fallback: T[number]
): T[number] {
  const stringValue = readString(value);
  return allowed.includes(stringValue) ? stringValue : fallback;
}

function readEnumArray<T extends readonly string[]>(
  value: YamlValue,
  allowed: T,
  fallback: T[number][]
): T[number][] {
  const values = readStringArray(value).filter((candidate): candidate is T[number] =>
    allowed.includes(candidate)
  );
  return values.length ? values : fallback;
}

function inferSourceCanonicality(
  sourceRole: MemorySourceRole,
  curationStatus: MemoryCurationStatus
): MemorySourceCanonicality {
  if (curationStatus === "stale") return "stale";
  if (
    sourceRole === "project_summary" ||
    sourceRole === "company_profile" ||
    sourceRole === "leadership_principle_rubric" ||
    sourceRole === "promotion_doc" ||
    sourceRole === "resume"
  ) {
    return "canonical";
  }
  if (sourceRole === "code_patch") return "evidence";
  return "supporting";
}

function inferRawInjectionPolicy(
  sourceRole: MemorySourceRole,
  curationStatus: MemoryCurationStatus
): RawInjectionPolicy {
  if (curationStatus === "raw" || curationStatus === "stale") return "never";
  if (sourceRole === "code_patch" || sourceRole === "dev_context") {
    return "never";
  }
  if (sourceRole === "implementation_tracker" || sourceRole === "release_doc") {
    return "summary_only";
  }
  return "summary_only";
}

function unquote(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
