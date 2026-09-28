import type { MemoryEntry } from "./types.js";
import { classifyRuntimeMemoryRole } from "./runtime-role.js";

export function isMemoryProjectAnchorCompatible(
  entry: MemoryEntry,
  strictProjectAnchor: string | undefined
) {
  const anchor = strictProjectAnchor?.trim();
  if (!anchor || !isProjectSpecificEntry(entry)) return true;
  if (isGlobalProjectAnchorExemptEntry(entry)) return true;

  return isMemoryProjectIdentityMatch(entry, anchor);
}

export function isMemoryProjectIdentityMatch(
  entry: MemoryEntry,
  projectIdentity: string | undefined
) {
  const identity = projectIdentity?.trim();
  if (!identity) return false;
  const anchorTokens = extractProjectAnchorTokens(identity);
  if (!anchorTokens.size) return false;

  const canonicalIdentityText = [entry.projectId, entry.projectName]
    .filter(Boolean)
    .join(" ");
  if (!canonicalIdentityText) return false;
  return hasProjectAnchorTokenCoverage(
    anchorTokens,
    tokenize(canonicalIdentityText)
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
    (!classifyRuntimeMemoryRole(entry).anchorEligible ||
      (!entry.projectId?.trim() && !entry.projectName?.trim())) &&
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
