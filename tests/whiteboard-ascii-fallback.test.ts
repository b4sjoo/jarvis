import assert from "node:assert/strict";
import test from "node:test";
import { buildWhiteboardAsciiFallback } from "../src/lib/meeting/whiteboard-ascii-fallback.js";

test("projects Mermaid node labels, groups, and edges to readable ASCII topology", () => {
  const fallback = buildWhiteboardAsciiFallback([
    "```mermaid",
    "flowchart LR",
    '  subgraph online["Online Serving"]',
    '  A["Client"] --> B["API Gateway"]',
    '  B --> C["Reservation Service"]',
    "  end",
    "```",
  ].join("\n"));

  assert.equal(fallback.source, "mermaid-topology");
  assert.equal(fallback.edgeCount, 2);
  assert.match(fallback.content, /Group: Online Serving/);
  assert.match(fallback.content, /\[Client\]/);
  assert.match(fallback.content, /\\--> \[API Gateway\]/);
  assert.match(fallback.content, /\\--> \[Reservation Service\]/);
  assert.doesNotMatch(fallback.content, /```|flowchart LR/);
});

test("falls back to sanitized architecture lines for malformed Mermaid", () => {
  const fallback = buildWhiteboardAsciiFallback([
    "```mermaid",
    "flowchart TD",
    "  Retrieval pipeline with vector search",
  ].join("\n"));

  assert.equal(fallback.source, "sanitized-text");
  assert.match(fallback.content, /Retrieval pipeline with vector search/);
  assert.doesNotMatch(fallback.content, /flowchart TD/);
});

test("bounds large fallback projections", () => {
  const edges = Array.from(
    { length: 100 },
    (_, index) => `N${index}[Node ${index}] --> N${index + 1}[Node ${index + 1}]`
  );
  const fallback = buildWhiteboardAsciiFallback(
    ["```mermaid", "flowchart TD", ...edges, "```"].join("\n")
  );

  assert.equal(fallback.truncated, true);
  assert.ok(fallback.content.length <= 3_200);
  assert.match(fallback.content, /\.\.\.$/);
});
