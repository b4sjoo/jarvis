import type { MemoryEntry } from "./types.js";

export function isMemoryProjectAnchorCompatible(
  entry: MemoryEntry,
  strictProjectAnchor: string | undefined
) {
  const anchor = strictProjectAnchor?.trim();
  if (!anchor || !isProjectSpecificEntry(entry)) return true;
  if (isGlobalProjectAnchorExemptEntry(entry)) return true;

  const anchorTokens = extractProjectAnchorTokens(anchor);
  if (!anchorTokens.size) return true;

  const directAnchorText = [entry.projectId, entry.projectName, entry.title]
    .filter(Boolean)
    .join(" ");
  if (
    directAnchorText &&
    hasProjectAnchorTokenCoverage(anchorTokens, tokenize(directAnchorText))
  ) {
    return true;
  }

  return hasProjectAnchorTokenCoverage(
    anchorTokens,
    tokenize(buildEntrySearchableText(entry))
  );
}

function isProjectSpecificEntry(entry: MemoryEntry) {
  return (
    entry.scope === "project" ||
    Boolean(entry.projectId || entry.projectName) ||
    [
      "answer_evidence",
      "working_summary",
      "project_context",
      "design_doc",
      "implementation_note",
      "decision_record",
      "investigation_note",
    ].includes(entry.type)
  );
}

function isGlobalProjectAnchorExemptEntry(entry: MemoryEntry) {
  return (
    entry.scope === "global" &&
    (entry.type === "profile" ||
      entry.type === "preference" ||
      entry.type === "resume_fact" ||
      entry.type === "answer_template" ||
      entry.type === "evaluation_criteria" ||
      entry.type === "interview_framework")
  );
}

function extractProjectAnchorTokens(anchor: string) {
  const genericAnchorTokens = new Set([
    "project",
    "system",
    "service",
    "platform",
    "feature",
    "tool",
    "app",
    "application",
  ]);

  return new Set(
    Array.from(tokenize(anchor)).filter(
      (token) => token.length >= 3 && !genericAnchorTokens.has(token)
    )
  );
}

function hasProjectAnchorTokenCoverage(
  anchorTokens: Set<string>,
  candidateTokens: Set<string>
) {
  if (!anchorTokens.size) return true;

  let matched = 0;
  for (const token of anchorTokens) {
    if (candidateTokens.has(token)) matched += 1;
  }

  if (anchorTokens.size === 1) return matched === 1;
  if (anchorTokens.size === 2) return matched === 2;
  return matched >= Math.ceil(anchorTokens.size * 0.75);
}

function buildEntrySearchableText(entry: MemoryEntry) {
  return [
    entry.projectId,
    entry.projectName,
    entry.type,
    entry.title,
    entry.tags.join(" "),
    entry.keywords.join(" "),
    entry.summary,
    entry.content.slice(0, 1000),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function tokenize(text: string | undefined) {
  if (!text) return new Set<string>();
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}+#.]+/gu, " ")
      .split(/\s+/)
      .filter(Boolean)
  );
}
