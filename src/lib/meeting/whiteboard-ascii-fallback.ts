const MAX_ASCII_FALLBACK_LINES = 48;
const MAX_ASCII_FALLBACK_CHARS = 3_200;

export interface WhiteboardAsciiFallback {
  content: string;
  source: "mermaid-projection" | "sanitized-lines" | "unavailable";
  nodeCount: number;
  edgeCount: number;
  truncated: boolean;
}

export function buildWhiteboardAsciiFallback(
  whiteboard: string
): WhiteboardAsciiFallback {
  const normalized = whiteboard.trim().replace(/\r\n/g, "\n");
  const mermaidBlocks = Array.from(
    normalized.matchAll(
      /```[ \t]*mermaid[^\S\r\n]*\r?\n([\s\S]*?)(?:```|$)/gi
    ),
    (match) => match[1]?.trim() ?? ""
  ).filter(Boolean);
  const source = mermaidBlocks.join("\n");
  const nodeLabels = extractNodeLabels(source);
  const groups: string[] = [];
  const edges: string[] = [];

  for (const rawLine of source.split("\n")) {
    const line = stripMermaidComment(rawLine).trim();
    if (!line) continue;
    const group = line.match(/^subgraph\s+(.+)$/i)?.[1];
    if (group) {
      const label = cleanMermaidLabel(group, nodeLabels);
      if (label) groups.push(`Group: ${label}`);
      continue;
    }
    if (!containsMermaidEdge(line)) continue;
    const projected = projectMermaidEdge(line, nodeLabels);
    if (projected) edges.push(projected);
  }

  const projectedLines = uniqueLines([...groups, ...edges]);
  if (projectedLines.length) {
    const bounded = boundAsciiLines([
      "Architecture sketch (diagram fallback):",
      ...projectedLines,
    ]);
    return {
      content: bounded.content,
      source: "mermaid-projection",
      nodeCount: nodeLabels.size,
      edgeCount: edges.length,
      truncated: bounded.truncated,
    };
  }

  const sanitized = uniqueLines(
    normalized
      .replace(/```[ \t]*mermaid/gi, "")
      .replace(/```/g, "")
      .split("\n")
      .map((line) => stripMermaidComment(line).trim())
      .filter((line) => !isMermaidControlLine(line))
      .map((line) => cleanMermaidLabel(line, nodeLabels))
      .filter(Boolean)
  );
  if (sanitized.length) {
    const bounded = boundAsciiLines([
      "Architecture sketch (diagram fallback):",
      ...sanitized,
    ]);
    return {
      content: bounded.content,
      source: "sanitized-lines",
      nodeCount: nodeLabels.size,
      edgeCount: 0,
      truncated: bounded.truncated,
    };
  }

  return {
    content: "Whiteboard is temporarily unavailable.",
    source: "unavailable",
    nodeCount: 0,
    edgeCount: 0,
    truncated: false,
  };
}

function extractNodeLabels(source: string) {
  const labels = new Map<string, string>();
  for (const match of source.matchAll(
    /\b([A-Za-z_][\w-]*)\s*(?:\[\s*"?(.*?)"?\s*\]|\(\s*"?(.*?)"?\s*\)|\{\s*"?(.*?)"?\s*\})/g
  )) {
    const id = match[1];
    const label = cleanMermaidLabel(
      match[2] ?? match[3] ?? match[4] ?? id,
      labels
    );
    if (label) labels.set(id, label);
  }
  return labels;
}

function projectMermaidEdge(
  rawLine: string,
  labels: Map<string, string>
) {
  const withoutEdgeLabels = rawLine
    .replace(/--\s*\|([^|]+)\|\s*--?>/g, " --> ")
    .replace(/\|([^|]+)\|/g, " ");
  const parts = withoutEdgeLabels
    .split(/\s*(?:-->|---|-.->|==>|~~~|--x|--o)\s*/)
    .map((part) => cleanMermaidLabel(part, labels))
    .filter(Boolean);
  return parts.length >= 2 ? parts.join(" -> ") : "";
}

function cleanMermaidLabel(
  value: string,
  labels: Map<string, string>
) {
  const trimmed = value
    .trim()
    .replace(/^[;:,]+|[;:,]+$/g, "")
    .replace(/^["']|["']$/g, "");
  if (!trimmed) return "";
  if (labels.has(trimmed)) return labels.get(trimmed) ?? trimmed;

  const declaration = trimmed.match(
    /^([A-Za-z_][\w-]*)\s*(?:\[\s*"?(.*?)"?\s*\]|\(\s*"?(.*?)"?\s*\)|\{\s*"?(.*?)"?\s*\})$/
  );
  if (declaration) {
    return (
      declaration[2] ??
      declaration[3] ??
      declaration[4] ??
      declaration[1]
    )
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return trimmed
    .replace(/\s+/g, " ")
    .replace(/&amp;/gi, "&")
    .slice(0, 240);
}

function containsMermaidEdge(line: string) {
  return /(?:-->|---|-.->|==>|~~~|--x|--o)/.test(line);
}

function stripMermaidComment(line: string) {
  return line.replace(/%%.*$/, "");
}

function isMermaidControlLine(line: string) {
  return (
    !line ||
    /^(?:flowchart|graph|sequenceDiagram|direction|end|style|classDef|class|linkStyle)\b/i.test(
      line
    )
  );
}

function uniqueLines(lines: string[]) {
  return Array.from(new Set(lines.map((line) => line.trim()).filter(Boolean)));
}

function boundAsciiLines(lines: string[]) {
  const selected = lines.slice(0, MAX_ASCII_FALLBACK_LINES);
  let content = selected.join("\n");
  let truncated = lines.length > selected.length;
  if (content.length > MAX_ASCII_FALLBACK_CHARS) {
    content = `${content.slice(0, MAX_ASCII_FALLBACK_CHARS - 4).trimEnd()}\n...`;
    truncated = true;
  } else if (truncated) {
    content = `${content}\n...`;
  }
  return { content, truncated };
}
