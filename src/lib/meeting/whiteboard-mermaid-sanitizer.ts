export type WhiteboardMermaidSanitationChange =
  | "quoted-node-label"
  | "normalized-subgraph-label"
  | "normalized-edge-arrow";

export interface WhiteboardMermaidSanitationResult {
  whiteboard: string;
  changed: boolean;
  changes: WhiteboardMermaidSanitationChange[];
}

const MERMAID_FENCE =
  /```([ \t]*(?:mermaid|mmd)\b[^\S\r\n]*)\r?\n([\s\S]*?)(```|$)/gi;

export function sanitizeWhiteboardMermaidSyntax(
  whiteboard: string
): WhiteboardMermaidSanitationResult {
  const changes = new Set<WhiteboardMermaidSanitationChange>();
  const sanitized = whiteboard.replace(
    MERMAID_FENCE,
    (_match, fenceInfo: string, source: string, closingFence: string) => {
      const block = sanitizeMermaidBlock(source, changes);
      return `\`\`\`${fenceInfo}\n${block}${closingFence}`;
    }
  );
  return {
    whiteboard: sanitized,
    changed: sanitized !== whiteboard,
    changes: Array.from(changes),
  };
}

function sanitizeMermaidBlock(
  source: string,
  changes: Set<WhiteboardMermaidSanitationChange>
) {
  const usedIds = collectMermaidIds(source);
  return source
    .split(/\r?\n/)
    .map((line) => normalizeEdgeArrows(line, changes))
    .map((line) => sanitizeSubgraphLine(line, usedIds, changes))
    .map((line) => quoteNodeLabels(line, changes))
    .join("\n");
}

function sanitizeSubgraphLine(
  line: string,
  usedIds: Set<string>,
  changes: Set<WhiteboardMermaidSanitationChange>
) {
  const match = line.match(/^(\s*)subgraph\s+(.+?)\s*$/i);
  if (!match) return line;

  const indent = match[1];
  const declaration = match[2].trim();
  if (/^[A-Za-z_][\w-]*$/.test(declaration)) return line;
  if (/^[A-Za-z_][\w-]*\s*\[\s*"[\s\S]*"\s*\]$/.test(declaration)) {
    return line;
  }
  const canonical = declaration.match(
    /^([A-Za-z_][\w-]*)\s*(?:\[\s*"?([\s\S]*?)"?\s*\])$/
  );
  const label = cleanLabel(canonical?.[2] ?? declaration);
  if (!label) return line;
  const requestedId = canonical?.[1] ?? `group_${slugify(label)}`;
  const id = canonical?.[1]
    ? canonical[1]
    : reserveUniqueId(requestedId, usedIds);
  usedIds.add(id);
  changes.add("normalized-subgraph-label");
  return `${indent}subgraph ${id}["${escapeMermaidLabel(label)}"]`;
}

function normalizeEdgeArrows(
  line: string,
  changes: Set<WhiteboardMermaidSanitationChange>
) {
  const normalized = line.replace(/\s+(?:→|⇒)\s+/g, " --> ");
  if (normalized !== line) changes.add("normalized-edge-arrow");
  return normalized;
}

function quoteNodeLabels(
  line: string,
  changes: Set<WhiteboardMermaidSanitationChange>
) {
  if (/^\s*(?:subgraph|classDef|class|style|linkStyle)\b/i.test(line)) {
    return line;
  }
  return line.replace(
    /\b([A-Za-z_][\w-]*)\s*([\[{])\s*([^\]\}\r\n]+?)\s*([\]\}])/g,
    (match, id: string, open: string, rawLabel: string, close: string) => {
      const label = rawLabel.trim();
      if (
        (label.startsWith('"') && label.endsWith('"')) ||
        (label.startsWith("'") && label.endsWith("'"))
      ) {
        return match;
      }
      changes.add("quoted-node-label");
      return `${id}${open}"${escapeMermaidLabel(label)}"${close}`;
    }
  );
}

function collectMermaidIds(source: string) {
  const ids = new Set<string>();
  for (const match of source.matchAll(/\b([A-Za-z_][\w-]*)\s*(?=[\[{(])/g)) {
    ids.add(match[1]);
  }
  for (const match of source.matchAll(/^\s*subgraph\s+([A-Za-z_][\w-]*)/gim)) {
    ids.add(match[1]);
  }
  return ids;
}

function reserveUniqueId(requested: string, usedIds: Set<string>) {
  const base = /^[A-Za-z_]/.test(requested) ? requested : `group_${requested}`;
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function cleanLabel(value: string) {
  return value
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ");
}

function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "diagram"
  );
}

function escapeMermaidLabel(value: string) {
  return value.replace(/"/g, "&quot;");
}
