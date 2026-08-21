import { classifyRuntimeMemoryRole } from "./runtime-role.js";
import type {
  MemoryEntry,
  MemorySource,
  ParsedMemoryDraft,
  RuntimeMemoryRole,
} from "./types.js";

export const KMB_EVIDENCE_AUDIT_SCHEMA_VERSION = 1 as const;

export type KmbEvidenceAuditIssueCode =
  | "duplicate-source-id"
  | "duplicate-entry-id"
  | "missing-source"
  | "missing-related-entry"
  | "missing-evidence-entry"
  | "self-referential-entry-link"
  | "project-source-mismatch"
  | "project-evidence-missing-project"
  | "runtime-role-eligibility-drift"
  | "guidance-contains-first-person-claim"
  | "project-coverage-gap";

export interface KmbEvidenceAuditIssue {
  code: KmbEvidenceAuditIssueCode;
  severity: "error" | "warning";
  entryId?: string;
  sourceId?: string;
  projectId?: string;
  detail: string;
}

export interface KmbProjectEvidenceCoverage {
  projectId: string;
  projectName?: string;
  entryIds: string[];
  factEvidenceEntryIds: string[];
  coverage: Record<ProjectEvidenceQuestionFamily, string[]>;
  missingFamilies: ProjectEvidenceQuestionFamily[];
}

export type ProjectEvidenceQuestionFamily =
  | "architecture-choice"
  | "implementation-contribution"
  | "failure-debug-recovery"
  | "tradeoff-alternative"
  | "impact-limitation";

export interface KmbEvidenceAuditReport {
  schemaVersion: typeof KMB_EVIDENCE_AUDIT_SCHEMA_VERSION;
  generatedAt: number;
  draftCount: number;
  sourceCount: number;
  entryCount: number;
  roleCounts: Record<RuntimeMemoryRole, number>;
  anchorEligibleCount: number;
  issueCounts: Record<"error" | "warning", number>;
  issues: KmbEvidenceAuditIssue[];
  projects: KmbProjectEvidenceCoverage[];
}

const COVERAGE_PATTERNS: Record<ProjectEvidenceQuestionFamily, RegExp> = {
  "architecture-choice":
    /architect|design|decision|choice|routing|pipeline|topology|approach|migration|schema|架构|设计|选择|路由|方案|迁移/iu,
  "implementation-contribution":
    /implement|built|added|created|developed|designed|introduced|migrat|owned|contribution|实现|开发|构建|设计|引入|迁移|负责/iu,
  "failure-debug-recovery":
    /fail|error|debug|investigat|root cause|recover|rollback|incident|risk|protect|skew|429|conflict|blocker|故障|失败|调试|排查|恢复|回滚|风险|保护|冲突|阻塞/iu,
  "tradeoff-alternative":
    /tradeoff|trade-off|alternative|versus| vs |constraint|pros|cons|approximate|best-effort|compatib|取舍|权衡|替代|约束|近似|兼容/iu,
  "impact-limitation":
    /impact|result|metric|latency|cost|limit|risk|outcome|beta|blocked|reliability|影响|结果|指标|延迟|成本|限制|风险|阻塞|可靠性/iu,
};

const FIRST_PERSON_CLAIM =
  /\b(?:I|my|we|our)\s+(?:implemented|built|created|designed|owned|led|delivered|fixed|debugged|migrated|reduced|improved)\b|(?:我|我们)(?:实现|开发|设计|负责|主导|交付|修复|迁移|降低|改进)/iu;

export function auditCuratedMemoryEvidence(input: {
  drafts: ParsedMemoryDraft[];
  now?: number;
}): KmbEvidenceAuditReport {
  const sources = input.drafts.flatMap((draft) => draft.sources);
  const entries = input.drafts.flatMap((draft) => draft.entries);
  const issues: KmbEvidenceAuditIssue[] = [];
  const sourceIndex = indexSources(sources, issues);
  const entryIndex = indexUnique(entries, (entry) => entry.id, (id) => {
    issues.push({
      code: "duplicate-entry-id",
      severity: "error",
      entryId: id,
      detail: "Entry id appears more than once in the active curated corpus.",
    });
  });
  const roleCounts: Record<RuntimeMemoryRole, number> = {
    "fact-evidence": 0,
    guidance: 0,
    template: 0,
    overlay: 0,
  };
  let anchorEligibleCount = 0;

  for (const entry of entries) {
    const role = classifyRuntimeMemoryRole(entry);
    roleCounts[role.role] += 1;
    if (role.anchorEligible) anchorEligibleCount += 1;
    if (role.anchorEligible !== (role.role === "fact-evidence")) {
      issues.push({
        code: "runtime-role-eligibility-drift",
        severity: "error",
        entryId: entry.id,
        detail: `${role.role} resolved anchorEligible=${role.anchorEligible}.`,
      });
    }
    if (role.role === "fact-evidence" && !hasProjectIdentity(entry)) {
      if (isProjectEvidenceType(entry.type)) {
        issues.push({
          code: "project-evidence-missing-project",
          severity: "error",
          entryId: entry.id,
          detail: "Project fact evidence has no project id or name.",
        });
      }
    }
    if (role.role === "guidance" && FIRST_PERSON_CLAIM.test(entry.content)) {
      issues.push({
        code: "guidance-contains-first-person-claim",
        severity: "warning",
        entryId: entry.id,
        projectId: entry.projectId,
        detail: "Guidance contains first-person implementation wording.",
      });
    }

    const resolvedSources = entry.sourceIds
      .map((sourceId) => sourceIndex.get(sourceId))
      .filter((source): source is MemorySource => Boolean(source));
    for (const sourceId of entry.sourceIds) {
      if (!sourceIndex.has(sourceId)) {
        issues.push({
          code: "missing-source",
          severity: "error",
          entryId: entry.id,
          sourceId,
          projectId: entry.projectId,
          detail: "Entry references a source outside the active curated corpus.",
        });
      }
    }
    for (const source of resolvedSources) {
      if (
        entry.projectId &&
        source.projectId &&
        normalizeId(entry.projectId) !== normalizeId(source.projectId)
      ) {
        issues.push({
          code: "project-source-mismatch",
          severity: "error",
          entryId: entry.id,
          sourceId: source.id,
          projectId: entry.projectId,
          detail: `Entry project ${entry.projectId} differs from source project ${source.projectId}.`,
        });
      }
    }
    auditEntryLinks(entry, entryIndex, issues);
  }

  const projects = buildProjectCoverage(entries);
  for (const project of projects) {
    for (const family of project.missingFamilies) {
      issues.push({
        code: "project-coverage-gap",
        severity: "warning",
        projectId: project.projectId,
        detail: `No fact-evidence entry covers ${family}.`,
      });
    }
  }

  return {
    schemaVersion: KMB_EVIDENCE_AUDIT_SCHEMA_VERSION,
    generatedAt: input.now ?? Date.now(),
    draftCount: input.drafts.length,
    sourceCount: sources.length,
    entryCount: entries.length,
    roleCounts,
    anchorEligibleCount,
    issueCounts: {
      error: issues.filter((issue) => issue.severity === "error").length,
      warning: issues.filter((issue) => issue.severity === "warning").length,
    },
    issues: issues.sort(compareIssues),
    projects,
  };
}

export function renderKmbEvidenceAuditMarkdown(
  report: KmbEvidenceAuditReport
) {
  const lines = [
    "# KMB Evidence Alignment Audit",
    "",
    `- Drafts: ${report.draftCount}`,
    `- Sources / entries: ${report.sourceCount} / ${report.entryCount}`,
    `- Fact-evidence / guidance / template / overlay: ${report.roleCounts["fact-evidence"]} / ${report.roleCounts.guidance} / ${report.roleCounts.template} / ${report.roleCounts.overlay}`,
    `- Anchor eligible: ${report.anchorEligibleCount}`,
    `- Errors / warnings: ${report.issueCounts.error} / ${report.issueCounts.warning}`,
    "",
    "## Projects",
    "",
    "| Project | Entries | Fact evidence | Missing families |",
    "| --- | ---: | ---: | --- |",
    ...report.projects.map(
      (project) =>
        `| ${project.projectName ?? project.projectId} | ${project.entryIds.length} | ${project.factEvidenceEntryIds.length} | ${project.missingFamilies.join(", ") || "-"} |`
    ),
    "",
    "## Issues",
    "",
    "| Severity | Code | Project | Entry | Detail |",
    "| --- | --- | --- | --- | --- |",
    ...report.issues.map(
      (issue) =>
        `| ${issue.severity} | ${issue.code} | ${issue.projectId ?? "-"} | ${issue.entryId ?? issue.sourceId ?? "-"} | ${issue.detail.replace(/\|/g, "\\|")} |`
    ),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function auditEntryLinks(
  entry: MemoryEntry,
  entryIndex: Map<string, MemoryEntry>,
  issues: KmbEvidenceAuditIssue[]
) {
  for (const [kind, ids] of [
    ["related", entry.relatedEntryIds],
    ["evidence", entry.evidenceEntryIds],
  ] as const) {
    for (const id of ids) {
      if (id === entry.id) {
        issues.push({
          code: "self-referential-entry-link",
          severity: "error",
          entryId: entry.id,
          detail: `${kind} link references the entry itself.`,
        });
      } else if (!entryIndex.has(id)) {
        issues.push({
          code:
            kind === "evidence"
              ? "missing-evidence-entry"
              : "missing-related-entry",
          severity: "error",
          entryId: entry.id,
          detail: `${kind} link references missing entry ${id}.`,
        });
      }
    }
  }
}

function buildProjectCoverage(entries: MemoryEntry[]) {
  const projects = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    if (!entry.projectId && !entry.projectName) continue;
    const id = normalizeId(entry.projectId ?? entry.projectName ?? "");
    const projectEntries = projects.get(id) ?? [];
    projectEntries.push(entry);
    projects.set(id, projectEntries);
  }
  return Array.from(projects.entries())
    .map(([projectId, projectEntries]) => {
      const factEntries = projectEntries.filter(
        (entry) => classifyRuntimeMemoryRole(entry).role === "fact-evidence"
      );
      const coverage = Object.fromEntries(
        Object.entries(COVERAGE_PATTERNS).map(([family, pattern]) => [
          family,
          factEntries
            .filter((entry) => pattern.test(searchableEntryText(entry)))
            .map((entry) => entry.id)
            .sort(),
        ])
      ) as Record<ProjectEvidenceQuestionFamily, string[]>;
      const missingFamilies = (
        Object.keys(COVERAGE_PATTERNS) as ProjectEvidenceQuestionFamily[]
      ).filter((family) => coverage[family].length === 0);
      return {
        projectId,
        projectName: projectEntries.find((entry) => entry.projectName)
          ?.projectName,
        entryIds: projectEntries.map((entry) => entry.id).sort(),
        factEvidenceEntryIds: factEntries.map((entry) => entry.id).sort(),
        coverage,
        missingFamilies,
      } satisfies KmbProjectEvidenceCoverage;
    })
    .sort((left, right) => left.projectId.localeCompare(right.projectId));
}

function searchableEntryText(entry: MemoryEntry) {
  return [
    entry.title,
    entry.summary,
    entry.tags.join(" "),
    entry.keywords.join(" "),
    entry.content,
  ]
    .filter(Boolean)
    .join(" ");
}

function hasProjectIdentity(entry: MemoryEntry) {
  return Boolean(entry.projectId?.trim() || entry.projectName?.trim());
}

function isProjectEvidenceType(type: MemoryEntry["type"]) {
  return [
    "working_summary",
    "project_context",
    "design_doc",
    "implementation_note",
    "decision_record",
    "investigation_note",
    "threat_model",
  ].includes(type);
}

function indexUnique<T>(
  values: T[],
  idOf: (value: T) => string,
  onDuplicate: (id: string) => void
) {
  const index = new Map<string, T>();
  for (const value of values) {
    const id = idOf(value);
    if (index.has(id)) onDuplicate(id);
    else index.set(id, value);
  }
  return index;
}

function indexSources(
  sources: MemorySource[],
  issues: KmbEvidenceAuditIssue[]
) {
  const index = new Map<string, MemorySource>();
  for (const source of sources) {
    const existing = index.get(source.id);
    if (!existing) {
      index.set(source.id, source);
      continue;
    }
    if (
      JSON.stringify(comparableSource(existing)) ===
      JSON.stringify(comparableSource(source))
    ) {
      continue;
    }
    issues.push({
      code: "duplicate-source-id",
      severity: "error",
      sourceId: source.id,
      detail: "Source id has conflicting definitions across curated drafts.",
    });
  }
  return index;
}

function comparableSource(source: MemorySource) {
  const {
    draftPath: _draftPath,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...stable
  } = source;
  return stable;
}

function normalizeId(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function compareIssues(left: KmbEvidenceAuditIssue, right: KmbEvidenceAuditIssue) {
  return (
    left.severity.localeCompare(right.severity) ||
    left.code.localeCompare(right.code) ||
    (left.projectId ?? "").localeCompare(right.projectId ?? "") ||
    (left.entryId ?? "").localeCompare(right.entryId ?? "")
  );
}
