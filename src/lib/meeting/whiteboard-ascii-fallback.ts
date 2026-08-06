const MAX_ASCII_FALLBACK_LINES = 48;
const MAX_ASCII_FALLBACK_CHARS = 3_200;

export interface WhiteboardAsciiFallback {
  content: string;
  source:
    | "mermaid-topology"
    | "mermaid-edge-list"
    | "sanitized-text"
    | "unavailable";
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
  const edges: MermaidFallbackEdge[] = [];

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
    edges.push(...parseMermaidEdges(line));
  }

  const topology = renderAsciiTopology(edges, nodeLabels);
  if (topology.length) {
    const bounded = boundAsciiLines([
      "Architecture sketch (ASCII fallback):",
      ...uniqueLines(groups),
      ...(groups.length ? [""] : []),
      ...topology,
    ]);
    return {
      content: bounded.content,
      source: "mermaid-topology",
      nodeCount: new Set(edges.flatMap((edge) => [edge.from, edge.to])).size,
      edgeCount: edges.length,
      truncated: bounded.truncated,
    };
  }

  const projectedEdges = uniqueLines(
    edges.map((edge) =>
      [resolveNodeLabel(edge.from, nodeLabels), resolveNodeLabel(edge.to, nodeLabels)].join(
        " -> "
      )
    )
  );
  if (projectedEdges.length) {
    const bounded = boundAsciiLines([
      "Architecture connections (emergency text fallback):",
      ...uniqueLines(groups),
      ...projectedEdges,
    ]);
    return {
      content: bounded.content,
      source: "mermaid-edge-list",
      nodeCount: new Set(edges.flatMap((edge) => [edge.from, edge.to])).size,
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
      "Whiteboard notes (sanitized text fallback):",
      ...sanitized,
    ]);
    return {
      content: bounded.content,
      source: "sanitized-text",
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

interface MermaidFallbackEdge {
  from: string;
  to: string;
}

function parseMermaidEdges(rawLine: string): MermaidFallbackEdge[] {
  const normalized = rawLine
    .replace(/--\s+[^-\n]+?\s+-->/g, " --> ")
    .replace(/\|[^|]*\|/g, " ");
  const segments = normalized.split(
    /\s*(?:-->|---|-.->|==>|~~~|--x|--o)\s*/
  );
  if (segments.length < 2) return [];
  const edges: MermaidFallbackEdge[] = [];
  let previous = extractSegmentNodeIds(segments[0]);
  for (const segment of segments.slice(1)) {
    const current = extractSegmentNodeIds(segment);
    for (const from of previous) {
      for (const to of current) {
        if (from !== to) edges.push({ from, to });
      }
    }
    previous = current;
  }
  return edges;
}

function extractSegmentNodeIds(segment: string) {
  return segment
    .split("&")
    .map((branch) =>
      branch.match(/\b([A-Za-z_][\w-]*)\s*(?=\[|\(|\{|$|\s)/)?.[1]
    )
    .filter((id): id is string => Boolean(id));
}

function renderAsciiTopology(
  edges: MermaidFallbackEdge[],
  labels: Map<string, string>
) {
  if (!edges.length) return [];
  const adjacency = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  const nodeOrder: string[] = [];
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) {
      adjacency.set(edge.from, []);
      nodeOrder.push(edge.from);
    }
    if (!adjacency.has(edge.to)) {
      adjacency.set(edge.to, []);
      nodeOrder.push(edge.to);
    }
    const children = adjacency.get(edge.from)!;
    if (!children.includes(edge.to)) children.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    if (!indegree.has(edge.from)) indegree.set(edge.from, 0);
  }

  const roots = nodeOrder.filter((node) => (indegree.get(node) ?? 0) === 0);
  const componentRoots = roots.length ? roots : [nodeOrder[0]];
  const rendered = new Set<string>();
  const lines: string[] = [];
  for (const root of componentRoots) {
    if (rendered.has(root)) continue;
    if (lines.length) lines.push("");
    lines.push(`[${resolveNodeLabel(root, labels)}]`);
    rendered.add(root);
    renderAsciiChildren({
      node: root,
      prefix: "",
      adjacency,
      labels,
      rendered,
      ancestors: new Set([root]),
      lines,
    });
  }
  for (const node of nodeOrder) {
    if (rendered.has(node)) continue;
    if (lines.length) lines.push("");
    lines.push(`[${resolveNodeLabel(node, labels)}]`);
    rendered.add(node);
    renderAsciiChildren({
      node,
      prefix: "",
      adjacency,
      labels,
      rendered,
      ancestors: new Set([node]),
      lines,
    });
  }
  return lines;
}

function renderAsciiChildren(input: {
  node: string;
  prefix: string;
  adjacency: Map<string, string[]>;
  labels: Map<string, string>;
  rendered: Set<string>;
  ancestors: Set<string>;
  lines: string[];
}) {
  const children = input.adjacency.get(input.node) ?? [];
  children.forEach((child, index) => {
    const last = index === children.length - 1;
    const cycle = input.ancestors.has(child);
    const shared = input.rendered.has(child) && !cycle;
    const suffix = cycle ? " (cycle)" : shared ? " (shared)" : "";
    input.lines.push(
      `${input.prefix}${last ? "\\-->" : "+-->"} [${resolveNodeLabel(child, input.labels)}]${suffix}`
    );
    if (cycle || shared) return;
    input.rendered.add(child);
    renderAsciiChildren({
      ...input,
      node: child,
      prefix: `${input.prefix}${last ? "     " : "|    "}`,
      ancestors: new Set([...input.ancestors, child]),
    });
  });
}

function resolveNodeLabel(id: string, labels: Map<string, string>) {
  return (labels.get(id) ?? id).replace(/\s+/g, " ").slice(0, 120);
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
