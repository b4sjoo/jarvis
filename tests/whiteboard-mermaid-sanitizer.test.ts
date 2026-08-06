import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeWhiteboardMermaidSyntax } from "../src/lib/meeting/whiteboard-mermaid-sanitizer.js";

test("normalizes unsafe Mermaid group and node labels without changing topology", () => {
  const result = sanitizeWhiteboardMermaidSyntax([
    "```mermaid",
    "flowchart TD",
    "  subgraph Open Constraints & Unclear Scale",
    "  Client[Web / Mobile Client] --> API[API Gateway]",
    "  end",
    "```",
  ].join("\n"));

  assert.equal(result.changed, true);
  assert.deepEqual(result.changes.sort(), [
    "normalized-subgraph-label",
    "quoted-node-label",
  ]);
  assert.match(
    result.whiteboard,
    /subgraph group_open_constraints_unclear_scale\["Open Constraints & Unclear Scale"\]/
  );
  assert.match(result.whiteboard, /Client\["Web \/ Mobile Client"\]/);
  assert.match(result.whiteboard, /Client.*--> API/);
});

test("leaves already stable Mermaid unchanged", () => {
  const whiteboard = [
    "```mermaid",
    "flowchart LR",
    '  subgraph serving["Online Serving"]',
    '  Client["Client"] --> API["API Gateway"]',
    "  end",
    "```",
  ].join("\n");
  const result = sanitizeWhiteboardMermaidSyntax(whiteboard);

  assert.equal(result.changed, false);
  assert.deepEqual(result.changes, []);
  assert.equal(result.whiteboard, whiteboard);
});
