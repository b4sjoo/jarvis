import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeManualScreenPresentationArtifacts,
  formatScreenPresentationArtifactAuthorityForTrace,
  resolveManualScreenPlaybookSubtaskIntent,
  resolveScreenGenerationRequestedArtifacts,
} from "../src/lib/meeting/screen-artifact-authority.js";
import { parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";

test("derives screen generation artifacts from the settled playbook phase", () => {
  assert.deepEqual(
    resolveScreenGenerationRequestedArtifacts(["answer", "complexity"]),
    ["answer", "complexity"]
  );
  assert.deepEqual(
    resolveScreenGenerationRequestedArtifacts([
      "whiteboard",
      "answer",
      "whiteboard",
    ]),
    ["answer", "whiteboard"]
  );
});

test("treats a manual coding screen as an implementation request", () => {
  assert.equal(
    resolveManualScreenPlaybookSubtaskIntent({
      questionType: "coding",
      inferredIntent: "complexity-probe",
    }),
    "implementation-probe"
  );
  assert.equal(
    resolveManualScreenPlaybookSubtaskIntent({
      questionType: "general-system-design",
      inferredIntent: "qps-estimation",
    }),
    "qps-estimation"
  );
});

test("grants presentation-only code authority for a parsed manual screen result", () => {
  const decision = authorizeManualScreenPresentationArtifacts({
    requestedArtifacts: ["answer", "complexity"],
    parsedAnswer: parseMeetingAnswer(
      [
        "Answer: Use a monotonic deque.",
        "Code:",
        "```python",
        "def solve():",
        "    return []",
        "```",
        "Complexity: O(n)",
        "Whiteboard: graph TD; A --> B",
      ].join("\n")
    ),
  });

  assert.deepEqual(decision.authorizedArtifacts, [
    "answer",
    "code",
    "complexity",
  ]);
  assert.equal(decision.source, "manual-screen");
  assert.equal(decision.whiteboardCandidatePresent, true);
  assert.equal(
    formatScreenPresentationArtifactAuthorityForTrace(decision)
      .screenArtifactAuthoritySource,
    "manual-screen"
  );
});

test("preserves empty coding sections and keeps whiteboard phase-controlled", () => {
  const decision = authorizeManualScreenPresentationArtifacts({
    requestedArtifacts: ["answer", "whiteboard"],
    parsedAnswer: parseMeetingAnswer(
      "Answer: Clarify the read/write ratio.\nCode: -\nComplexity: -\nWhiteboard: graph TD; Client --> API"
    ),
  });

  assert.deepEqual(decision.authorizedArtifacts, ["answer", "whiteboard"]);
  assert.equal(decision.codeCandidatePresent, false);
  assert.equal(decision.complexityCandidatePresent, false);
});
