import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClarifyingOptionDisplayModel,
  getDisplayClarifyingOptions,
  isLikelyBooleanClarifyingQuestion,
  parseClarifyingOptionsText,
} from "../src/lib/meeting/clarifying-options.js";

test("parses labeled multi-line clarifying options", () => {
  const options = parseClarifyingOptionsText(`
A. Optimize consistency
B. Optimize latency
C. Optimize cost
`);

  assert.deepEqual(
    options?.map((option) => option.label),
    ["Optimize consistency", "Optimize latency", "Optimize cost"]
  );
});

test("parses JSON clarifying options", () => {
  const options = parseClarifyingOptionsText(
    `["Small launch", "Major event spike", "Global scale"]`
  );

  assert.deepEqual(
    options?.map((option) => option.label),
    ["Small launch", "Major event spike", "Global scale"]
  );
});

test("parses pipe-separated option labels", () => {
  const options = parseClarifyingOptionsText(
    "Existing implementation | Future design"
  );

  assert.deepEqual(
    options?.map((option) => option.label),
    ["Existing implementation", "Future design"]
  );
});

test("infers options from non-boolean clarifying question text", () => {
  const options = getDisplayClarifyingOptions({
    question:
      "Should I focus on consistency, latency, or cost for this design?",
  });

  assert.deepEqual(
    options.map((option) => option.label),
    ["consistency", "latency", "cost"]
  );
});

test("keeps boolean clarifying questions as yes/no fallback", () => {
  const options = getDisplayClarifyingOptions({
    question: "Should I treat this as a new task?",
  });

  assert.deepEqual(options, []);
});

test("only admits yes/no for semantically boolean questions", () => {
  assert.equal(
    isLikelyBooleanClarifyingQuestion("Do you want me to continue?"),
    true
  );
  assert.equal(
    isLikelyBooleanClarifyingQuestion(
      "Which verified project should I use for this answer?"
    ),
    false
  );
  assert.equal(
    isLikelyBooleanClarifyingQuestion("How should I scope this design?"),
    false
  );
});

test("does not invent yes/no for a non-boolean question without options", () => {
  const model = buildClarifyingOptionDisplayModel({
    question: "Which verified project should I use for this answer?",
  });

  assert.equal(model.source, "none");
  assert.equal(model.showBooleanFallback, false);
  assert.equal(model.misleadingBooleanFallbackPrevented, true);
  assert.deepEqual(model.options, []);
});

test("structured options remain available for ordinary clarification", () => {
  const model = buildClarifyingOptionDisplayModel({
    question: "Which direction should I use?",
    options: [
      { id: "a", label: "Read path", value: "read" },
      { id: "b", label: "Write path", value: "write" },
    ],
  });

  assert.equal(model.source, "structured-answer");
  assert.deepEqual(
    model.options.map((option) => option.label),
    ["Read path", "Write path"]
  );
});
