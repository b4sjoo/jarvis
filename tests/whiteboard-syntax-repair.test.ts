import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeWhiteboardSyntaxRepairLease,
  buildWhiteboardSyntaxRepairPrompts,
  createWhiteboardSyntaxRepairLease,
  createWhiteboardSyntaxRepairRequest,
  parseWhiteboardSyntaxRepairOutput,
  WHITEBOARD_SYNTAX_REPAIR_MAX_PARSER_ERROR_CHARS,
} from "../src/lib/meeting/whiteboard-syntax-repair.js";

const INVALID_WHITEBOARD = [
  "```mermaid",
  "flowchart TD",
  "  subgraph Open Constraints & Unclear Scale",
  "  Client --> API",
  "  API --> InventoryDB",
  "  end",
  "```",
].join("\n");

test("builds a bounded atomic request from invalid Mermaid", () => {
  const request = createWhiteboardSyntaxRepairRequest({
    whiteboard: INVALID_WHITEBOARD,
    parserError: "mermaid-syntax-error",
  });

  assert.ok(request);
  assert.equal(request.input.diagramKind, "flowchart");
  assert.equal(request.input.parserError, "mermaid-syntax-error");
  assert.match(request.input.parserContext ?? "", /subgraph Open Constraints/);
  assert.doesNotMatch(request.input.mermaid, /```/);
  const prompts = buildWhiteboardSyntaxRepairPrompts(request);
  assert.match(prompts.systemPrompt, /Change syntax only/);
  assert.match(prompts.userMessage, /Open Constraints/);
  assert.match(prompts.userMessage, /parserContext/);
});

test("bounds parser diagnostics before sending the repair request", () => {
  const request = createWhiteboardSyntaxRepairRequest({
    whiteboard: INVALID_WHITEBOARD,
    parserError: `  ${"parser detail ".repeat(100)}  `,
  });

  assert.ok(request);
  assert.equal(
    request.input.parserError.length,
    WHITEBOARD_SYNTAX_REPAIR_MAX_PARSER_ERROR_CHARS
  );
  assert.doesNotMatch(request.input.parserError, /\s{2,}/);
});

test("accepts strict syntax-only output that preserves graph semantics", () => {
  const request = createWhiteboardSyntaxRepairRequest({
    whiteboard: INVALID_WHITEBOARD,
    parserError: "mermaid-syntax-error",
  });
  assert.ok(request);

  const parsed = parseWhiteboardSyntaxRepairOutput(
    JSON.stringify({
      mermaid: [
        "flowchart TD",
        '  subgraph open_constraints["Open Constraints & Unclear Scale"]',
        "  Client --> API",
        "  API --> InventoryDB",
        "  end",
      ].join("\n"),
      asciiFallback: [
        "Open Constraints & Unclear Scale",
        "Client -> API -> InventoryDB",
      ].join("\n"),
      changedSyntaxOnly: true,
    }),
    request
  );

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.match(parsed.value.mermaid, /open_constraints/);
    assert.ok(parsed.preservedSemanticAnchors.includes("client"));
  }
});

test("rejects explanation, missing fallback, and semantic drift", () => {
  const request = createWhiteboardSyntaxRepairRequest({
    whiteboard: INVALID_WHITEBOARD,
    parserError: "mermaid-syntax-error",
  });
  assert.ok(request);

  assert.equal(
    parseWhiteboardSyntaxRepairOutput(
      `Here is the fix:\n${JSON.stringify({
        mermaid: "flowchart TD\nClient --> API",
        asciiFallback: "Client -> API",
        changedSyntaxOnly: true,
      })}`,
      request
    ).ok,
    false
  );
  assert.deepEqual(
    parseWhiteboardSyntaxRepairOutput(
      JSON.stringify({
        mermaid: "flowchart TD\nClient --> API",
        asciiFallback: "",
        changedSyntaxOnly: true,
      }),
      request
    ),
    { ok: false, reason: "missing-ascii-fallback" }
  );
  const drifted = parseWhiteboardSyntaxRepairOutput(
    JSON.stringify({
      mermaid: "flowchart TD\nUser --> RecommendationService",
      asciiFallback: "User -> RecommendationService",
      changedSyntaxOnly: true,
    }),
    request
  );
  assert.equal(drifted.ok, false);
  if (!drifted.ok) {
    assert.equal(drifted.reason, "semantic-anchor-mismatch");
    assert.ok(drifted.missingSemanticAnchors?.includes("inventorydb"));
  }
});

test("authorizes only the exact session, parent, artifact, and revision lease", () => {
  const lease = createWhiteboardSyntaxRepairLease({
    operationId: "repair_1",
    sessionId: "session_1",
    runtimeEpoch: 4,
    parentTaskId: "parent_1",
    parentRevision: 7,
    artifactId: "artifact_1",
    candidateRevision: 2,
    visibleRevision: 1,
    candidateWhiteboard: INVALID_WHITEBOARD,
    validationOperationId: "validation_1",
    now: 100,
  });
  const current = {
    currentOperationId: "repair_1",
    sessionId: "session_1",
    runtimeEpoch: 4,
    parentTaskId: "parent_1",
    parentRevision: 7,
    artifactId: "artifact_1",
    candidateRevision: 2,
    visibleRevision: 1,
    candidateFingerprint: lease.candidateFingerprint,
    validationOperationId: "validation_1",
  };

  assert.deepEqual(authorizeWhiteboardSyntaxRepairLease(lease, current), {
    authorized: true,
    reason: "authorized",
  });
  assert.deepEqual(
    authorizeWhiteboardSyntaxRepairLease(lease, {
      ...current,
      candidateRevision: 3,
    }),
    {
      authorized: false,
      reason: "candidate-revision-changed",
    }
  );
  assert.deepEqual(
    authorizeWhiteboardSyntaxRepairLease(lease, {
      ...current,
      parentTaskId: "parent_2",
    }),
    {
      authorized: false,
      reason: "parent-changed",
    }
  );
});
