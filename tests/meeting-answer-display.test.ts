import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMeetingAnswerDisplayModel,
  overlayMeetingAnswerArtifacts,
} from "../src/lib/meeting/meeting-answer-display.js";
import { parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";

test("uses one primary answer for a legacy compact reply", () => {
  const parsed = parseMeetingAnswer(`中文思路: 先讲结论。
Reply: I would start with the customer impact.
Question: -`);
  const display = buildMeetingAnswerDisplayModel({
    content: parsed.rawContent,
    parsedAnswer: parsed,
    expectedProfile: "compact-spoken",
  });

  assert.equal(
    display.primaryAnswer,
    "I would start with the customer impact."
  );
  assert.equal(display.clarifyingQuestion, "");
  assert.equal(display.hasTechnicalDetails, false);
});

test("builds a technical display without depending on modality", () => {
  const display = buildMeetingAnswerDisplayModel({
    content: `Question: What is RAG?
Answer: Retrieval augments generation with external evidence.
Approach: Retrieve, rerank, then generate.`,
    expectedProfile: "technical",
  });

  assert.equal(display.focusedQuestion, "What is RAG?");
  assert.equal(display.primaryAnswer, "Retrieval augments generation with external evidence.");
  assert.equal(display.hasTechnicalDetails, true);
});

test("overlays parent-scoped artifacts without changing the parsed answer", () => {
  const display = buildMeetingAnswerDisplayModel({
    content: "Answer: The follow-up does not replace the implementation.",
    expectedProfile: "coding",
  });
  const overlaid = overlayMeetingAnswerArtifacts(display, {
    whiteboard: { kind: "preserve" },
    code: { kind: "replace", value: "def solve():\n    return 1" },
    complexity: { kind: "replace", value: "O(1) time and space." },
  });

  assert.equal(overlaid.primaryAnswer, display.primaryAnswer);
  assert.equal(overlaid.code, "def solve():\n    return 1");
  assert.equal(overlaid.complexity, "O(1) time and space.");
  assert.equal(overlaid.parsedAnswer, display.parsedAnswer);
});

test("an authoritative clear cannot fall back to stale parsed artifacts", () => {
  const display = buildMeetingAnswerDisplayModel({
    content:
      "Answer: Old answer.\nCode:\n```python\ndef stale(): pass\n```\nComplexity: O(n)",
    expectedProfile: "coding",
  });
  const overlaid = overlayMeetingAnswerArtifacts(display, {
    whiteboard: { kind: "clear" },
    code: { kind: "clear" },
    complexity: { kind: "clear" },
  });

  assert.equal(overlaid.code, "");
  assert.equal(overlaid.complexity, "");
  assert.equal(overlaid.whiteboard, "");
});
