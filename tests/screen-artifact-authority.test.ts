import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeManualScreenPresentationArtifacts,
  formatScreenPresentationArtifactAuthorityForTrace,
  resolveManualScreenGenerationRequestedArtifacts,
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
  assert.equal(
    resolveManualScreenPlaybookSubtaskIntent({
      questionType: "coding",
      inferredIntent: "concept-probe",
      boundVoicePrimaryAsk: true,
    }),
    "concept-probe"
  );
});

test("bounds generation artifacts to the Voice primary ask", () => {
  assert.deepEqual(
    resolveManualScreenGenerationRequestedArtifacts({
      requiredArtifacts: ["answer", "code", "complexity"],
      questionType: "coding",
      boundVoicePrimaryAsk: true,
      primaryAskIntent: "concept-probe",
    }),
    ["answer"]
  );
  assert.deepEqual(
    resolveManualScreenGenerationRequestedArtifacts({
      requiredArtifacts: ["answer", "code", "complexity"],
      questionType: "coding",
      boundVoicePrimaryAsk: true,
      primaryAskIntent: "complexity-probe",
    }),
    ["answer", "complexity"]
  );
  assert.deepEqual(
    resolveManualScreenGenerationRequestedArtifacts({
      requiredArtifacts: ["answer", "complexity"],
      questionType: "coding",
      boundVoicePrimaryAsk: true,
      primaryAskIntent: "implementation-probe",
    }),
    ["answer", "code", "complexity"]
  );
  assert.deepEqual(
    resolveManualScreenGenerationRequestedArtifacts({
      requiredArtifacts: ["answer", "whiteboard"],
      questionType: "general-system-design",
      boundVoicePrimaryAsk: true,
      primaryAskIntent: "concept-probe",
    }),
    ["answer", "whiteboard"]
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

test("preserves Code and Complexity for a Voice explanation recovery", () => {
  const decision = authorizeManualScreenPresentationArtifacts({
    requestedArtifacts: ["answer"],
    parsedAnswer: parseMeetingAnswer(
      [
        "Answer: Lines 35 through 38 update recency.",
        "Code:",
        "```python",
        "cache.move_to_end(key)",
        "```",
        "Complexity: O(1)",
      ].join("\n")
    ),
    boundVoicePrimaryAsk: true,
    primaryAskIntent: "concept-probe",
  });

  assert.deepEqual(decision.authorizedArtifacts, ["answer"]);
  assert.match(decision.reason, /code-family-blocked-by-primary-ask/);
  assert.equal(
    formatScreenPresentationArtifactAuthorityForTrace(decision)
      .screenArtifactAuthorityAuthorized,
    false
  );
});

test("authorizes Code and Complexity through one Voice artifact family", () => {
  const parsedAnswer = parseMeetingAnswer(
    [
      "Answer: Update the eviction branch.",
      "Code:",
      "```python",
      "cache.popitem(last=False)",
      "```",
      "Complexity: O(1)",
    ].join("\n")
  );
  const complexity = authorizeManualScreenPresentationArtifacts({
    requestedArtifacts: ["answer", "complexity"],
    parsedAnswer,
    boundVoicePrimaryAsk: true,
    primaryAskIntent: "complexity-probe",
  });
  const implementation = authorizeManualScreenPresentationArtifacts({
    requestedArtifacts: ["answer", "code", "complexity"],
    parsedAnswer,
    boundVoicePrimaryAsk: true,
    primaryAskIntent: "implementation-probe",
  });

  assert.deepEqual(complexity.authorizedArtifacts, [
    "answer",
    "code",
    "complexity",
  ]);
  assert.deepEqual(implementation.authorizedArtifacts, [
    "answer",
    "code",
    "complexity",
  ]);
});
