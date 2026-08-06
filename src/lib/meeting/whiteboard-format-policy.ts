import { normalizeCanonicalQuestionType } from "./task-taxonomy.js";

export type WhiteboardFormatPreference =
  | "none"
  | "mermaid"
  | "plain-text";

export type WhiteboardFormatConversionDisposition =
  | "not-needed"
  | "converted"
  | "explicit-plain-text"
  | "no-flow-structure"
  | "conversion-limit-exceeded";

export interface WhiteboardFormatPolicyDecision {
  eligible: boolean;
  preference: WhiteboardFormatPreference;
  explicitPlainTextRequested: boolean;
  sourceKind: "none" | "mermaid" | "plain-text";
  effectiveWhiteboard?: string;
  policyMiss: boolean;
  conversionAttempted: boolean;
  conversionDisposition: WhiteboardFormatConversionDisposition;
}

const MAX_CONVERSION_LINES = 24;
const MAX_CONVERSION_NODES = 20;
const MAX_NODE_LABEL_CHARS = 120;

export function resolveWhiteboardFormatPreference({
  questionType,
  artifactIntent,
  sourceQuestion,
}: {
  questionType: unknown;
  artifactIntent?: string;
  sourceQuestion?: string;
}): WhiteboardFormatPreference {
  const normalizedType = normalizeCanonicalQuestionType(questionType);
  const eligible =
    (normalizedType === "general-system-design" ||
      normalizedType === "ai-ml-system-design") &&
    (!artifactIntent || artifactIntent === "revise-whiteboard");
  if (!eligible) return "none";
  return hasExplicitPlainTextWhiteboardRequest(sourceQuestion)
    ? "plain-text"
    : "mermaid";
}

export function applyWhiteboardFormatPolicy({
  whiteboard,
  preference,
}: {
  whiteboard?: string;
  preference: WhiteboardFormatPreference;
}): WhiteboardFormatPolicyDecision {
  const normalized = normalizeWhiteboard(whiteboard);
  const sourceKind = classifyWhiteboardKind(normalized);
  const eligible = preference !== "none";
  const explicitPlainTextRequested = preference === "plain-text";

  if (!normalized || !eligible || sourceKind === "mermaid") {
    return {
      eligible,
      preference,
      explicitPlainTextRequested,
      sourceKind,
      effectiveWhiteboard: normalized || undefined,
      policyMiss: false,
      conversionAttempted: false,
      conversionDisposition: "not-needed",
    };
  }

  if (explicitPlainTextRequested) {
    return {
      eligible,
      preference,
      explicitPlainTextRequested,
      sourceKind,
      effectiveWhiteboard: normalized,
      policyMiss: false,
      conversionAttempted: false,
      conversionDisposition: "explicit-plain-text",
    };
  }

  const conversion = convertPlainTextWhiteboardToMermaid(normalized);
  return {
    eligible,
    preference,
    explicitPlainTextRequested,
    sourceKind,
    effectiveWhiteboard: conversion.whiteboard ?? normalized,
    policyMiss: true,
    conversionAttempted: true,
    conversionDisposition: conversion.disposition,
  };
}

export function formatWhiteboardFormatPolicyForTrace({
  decision,
  validationDisposition,
  visibleStatus,
}: {
  decision?: WhiteboardFormatPolicyDecision;
  validationDisposition?: string;
  visibleStatus?: string;
}): Record<string, unknown> {
  const eligible = decision?.eligible ?? false;
  const mermaidRequested = decision?.preference === "mermaid";
  const mermaidCommitted =
    mermaidRequested &&
    validationDisposition === "valid-mermaid" &&
    visibleStatus === "valid-mermaid";
  const asciiFallback =
    mermaidRequested &&
    (visibleStatus === "ascii-fallback" ||
      (decision?.sourceKind === "plain-text" && !mermaidCommitted));
  return {
    whiteboardFormatPreference: decision?.preference ?? "none",
    whiteboardMermaidEligible: eligible,
    whiteboardMermaidEligibleCount: eligible ? 1 : 0,
    whiteboardMermaidRequested: mermaidRequested,
    whiteboardMermaidRequestedCount: mermaidRequested ? 1 : 0,
    whiteboardMermaidCommitted: mermaidCommitted,
    whiteboardMermaidCommittedCount: mermaidCommitted ? 1 : 0,
    whiteboardFormatPolicyMiss: decision?.policyMiss ?? false,
    whiteboardFormatPolicyMissCount: decision?.policyMiss ? 1 : 0,
    whiteboardFormatConversionAttempted:
      decision?.conversionAttempted ?? false,
    whiteboardFormatConversionAttemptCount:
      decision?.conversionAttempted ? 1 : 0,
    whiteboardFormatConversionDisposition:
      decision?.conversionDisposition,
    whiteboardAsciiFallback: asciiFallback,
    whiteboardAsciiFallbackCount: asciiFallback ? 1 : 0,
    whiteboardAsciiFallbackReason: asciiFallback
      ? visibleStatus === "ascii-fallback"
        ? "invalid-mermaid-validation-fallback"
        : decision?.conversionDisposition ?? "plain-text-policy-miss"
      : undefined,
  };
}

export function hasExplicitPlainTextWhiteboardRequest(value: unknown) {
  if (typeof value !== "string") return false;
  const normalized = value.toLowerCase().replace(/[_-]+/g, " ");
  return (
    /\b(?:in|as)\s+(?:ascii|plain text|text only)\b/.test(normalized) ||
    /\b(?:use|draw|show|render|write|provide|output|format)(?:\s+\w+){0,3}\s+(?:ascii|plain text|text only)\b/.test(
      normalized
    )
  );
}

function convertPlainTextWhiteboardToMermaid(value: string): {
  whiteboard?: string;
  disposition: Extract<
    WhiteboardFormatConversionDisposition,
    "converted" | "no-flow-structure" | "conversion-limit-exceeded"
  >;
} {
  const lines = value
    .replace(/```(?:text|plaintext|ascii)?/gi, "")
    .split(/\r?\n/)
    .map((line) => normalizeDiagramLine(line))
    .filter(Boolean);
  if (lines.length > MAX_CONVERSION_LINES) {
    return { disposition: "conversion-limit-exceeded" };
  }

  const parsedLines = lines.map((line) =>
    line
      .split(/\s*(?:-+>|→)\s*/)
      .map((part) => normalizeNodeLabel(part))
      .filter(Boolean)
  );
  const chains = parsedLines.filter((parts) => parts.length >= 2);
  if (!chains.length) return { disposition: "no-flow-structure" };
  const standaloneLabels = parsedLines
    .filter((parts) => parts.length === 1)
    .flatMap((parts) => (parts[0] ? [parts[0]] : []));

  const nodeIds = new Map<string, string>();
  const usedNodeIds = new Set<string>();
  const edgeKeys = new Set<string>();
  const edges: Array<[string, string]> = [];
  const getNodeId = (label: string) => {
    const existing = nodeIds.get(label);
    if (existing) return existing;
    const baseId = toMermaidNodeId(label);
    let id = baseId;
    let suffix = 2;
    while (usedNodeIds.has(id)) {
      id = `${baseId}_${suffix}`;
      suffix += 1;
    }
    nodeIds.set(label, id);
    usedNodeIds.add(id);
    return id;
  };

  for (const chain of chains) {
    for (let index = 0; index < chain.length - 1; index += 1) {
      const from = getNodeId(chain[index]);
      const to = getNodeId(chain[index + 1]);
      const key = `${from}->${to}`;
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        edges.push([from, to]);
      }
    }
  }
  for (const label of standaloneLabels) getNodeId(label);
  if (nodeIds.size > MAX_CONVERSION_NODES) {
    return { disposition: "conversion-limit-exceeded" };
  }

  const mermaidEdges = edges.map(([from, to]) => `  ${from} --> ${to}`);
  const edgeNodeIds = new Set(edges.flat());
  const standaloneNodes = standaloneLabels
    .map((label) => nodeIds.get(label))
    .filter((id): id is string => Boolean(id))
    .filter((id) => !edgeNodeIds.has(id))
    .map((id) => `  ${id}`);
  return {
    whiteboard: [
      "```mermaid",
      "flowchart LR",
      ...mermaidEdges,
      ...standaloneNodes,
      "```",
    ].join("\n"),
    disposition: "converted",
  };
}

function normalizeWhiteboard(value: string | undefined) {
  const normalized = value?.trim().replace(/\r\n/g, "\n");
  return normalized && normalized !== "-" ? normalized : "";
}

function classifyWhiteboardKind(value: string) {
  if (!value) return "none" as const;
  return /```[ \t]*(?:mermaid|mmd)\b/i.test(value)
    ? ("mermaid" as const)
    : ("plain-text" as const);
}

function normalizeDiagramLine(value: string) {
  return value
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/^PROVISIONAL(?:\s+r\d+)?\s*:?\s*/i, "")
    .trim();
}

function normalizeNodeLabel(value: string) {
  return value
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/\s+/g, " ")
    .slice(0, MAX_NODE_LABEL_CHARS)
    .trim();
}

function toMermaidNodeId(value: string) {
  const normalized = value
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_NODE_LABEL_CHARS);
  if (!normalized) return "Node";
  return /^\d/.test(normalized) ? `Node_${normalized}` : normalized;
}
