import assert from "node:assert/strict";
import test from "node:test";
import {
  applyWhiteboardFormatPolicy,
  formatWhiteboardFormatPolicyForTrace,
  hasExplicitPlainTextWhiteboardRequest,
  resolveWhiteboardFormatPreference,
} from "../src/lib/meeting/whiteboard-format-policy.js";
import { validateWhiteboardRenderCandidate } from "../src/lib/meeting/whiteboard-artifact.js";

test("defaults eligible design whiteboards to Mermaid", () => {
  assert.equal(
    resolveWhiteboardFormatPreference({
      questionType: "general-system-design",
      artifactIntent: "revise-whiteboard",
      sourceQuestion: "Design a URL shortener.",
    }),
    "mermaid"
  );
  assert.equal(
    resolveWhiteboardFormatPreference({
      questionType: "coding",
      artifactIntent: "revise-code",
      sourceQuestion: "Implement a queue.",
    }),
    "none"
  );
});

test("honors explicit ASCII or plain-text requests", () => {
  assert.equal(
    hasExplicitPlainTextWhiteboardRequest(
      "Please draw the architecture in ASCII."
    ),
    true
  );
  assert.equal(
    resolveWhiteboardFormatPreference({
      questionType: "ai-ml-system-design",
      artifactIntent: "revise-whiteboard",
      sourceQuestion: "Show this as plain text.",
    }),
    "plain-text"
  );
  assert.equal(
    hasExplicitPlainTextWhiteboardRequest(
      "How does ASCII encoding work?"
    ),
    false
  );
  const explicitText = applyWhiteboardFormatPolicy({
    preference: "plain-text",
    whiteboard: "Client -> API",
  });
  assert.equal(
    formatWhiteboardFormatPolicyForTrace({
      decision: explicitText,
      validationDisposition: "valid-text",
      visibleStatus: "valid-text",
    }).whiteboardAsciiFallbackCount,
    0
  );
});

test("converts bounded arrow-only plain text without adding architecture", async () => {
  const decision = applyWhiteboardFormatPolicy({
    preference: "mermaid",
    whiteboard: [
      "PROVISIONAL r1",
      "Open: traffic, latency, and consistency constraints",
      "Client -> API Gateway -> URL Service -> Database",
      "URL Service -> Cache",
    ].join("\n"),
  });

  assert.equal(decision.policyMiss, true);
  assert.equal(decision.conversionAttempted, true);
  assert.equal(decision.conversionDisposition, "converted");
  assert.match(decision.effectiveWhiteboard ?? "", /```mermaid/);
  assert.match(decision.effectiveWhiteboard ?? "", /Client/);
  assert.match(decision.effectiveWhiteboard ?? "", /URL_Service/);
  assert.match(decision.effectiveWhiteboard ?? "", /Open_traffic_latency/);
  const validation = await validateWhiteboardRenderCandidate({
    whiteboard: decision.effectiveWhiteboard,
  });
  assert.equal(validation.disposition, "valid-mermaid");
});

test("keeps readable text when a semantics-preserving conversion is unavailable", () => {
  const whiteboard = "Components: client, service, and database.";
  const decision = applyWhiteboardFormatPolicy({
    preference: "mermaid",
    whiteboard,
  });

  assert.equal(decision.policyMiss, true);
  assert.equal(decision.conversionDisposition, "no-flow-structure");
  assert.equal(decision.effectiveWhiteboard, whiteboard);
  const trace = formatWhiteboardFormatPolicyForTrace({
    decision,
    validationDisposition: "valid-text",
    visibleStatus: "valid-text",
  });
  assert.equal(trace.whiteboardMermaidRequestedCount, 1);
  assert.equal(trace.whiteboardFormatPolicyMissCount, 1);
  assert.equal(trace.whiteboardAsciiFallbackCount, 1);
});
