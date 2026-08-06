import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClarifyingOptionDisplayModel,
  getDisplayClarifyingOptions,
  isLikelyBooleanClarifyingQuestion,
  parseClarifyingOptionsText,
  readProjectBindingClarifyingCandidates,
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

test("uses project binding candidates for a project selection question", () => {
  const model = buildClarifyingOptionDisplayModel({
    question: "Which verified project should I use for this answer?",
    projectBindingNeedsSelection: true,
    projectBindingCandidates: [
      { projectId: "agentic-memory", projectName: "Agentic Memory" },
      { projectId: "throttling", projectName: "Distributed Throttling" },
    ],
  });

  assert.equal(model.source, "project-binding");
  assert.equal(model.showBooleanFallback, false);
  assert.deepEqual(
    model.options.map((option) => [option.label, option.value]),
    [
      ["Agentic Memory", "agentic-memory"],
      ["Distributed Throttling", "throttling"],
    ]
  );
});

test("structured options outrank project candidates", () => {
  const model = buildClarifyingOptionDisplayModel({
    question: "Which direction should I use?",
    options: [
      { id: "a", label: "Read path", value: "read" },
      { id: "b", label: "Write path", value: "write" },
    ],
    projectBindingNeedsSelection: true,
    projectBindingCandidates: [
      { projectId: "project", projectName: "Project" },
    ],
  });

  assert.equal(model.source, "structured-answer");
  assert.deepEqual(
    model.options.map((option) => option.label),
    ["Read path", "Write path"]
  );
});

test("reads privacy-safe project candidates from binding trace metadata", () => {
  const result = readProjectBindingClarifyingCandidates({
    projectBindingAction: "needs-selection",
    projectBindingCandidates: [
      {
        projectId: "agentic-memory",
        projectName: "Agentic Memory",
        primaryEntryId: "private-entry-id",
      },
      { projectName: "Distributed Throttling" },
    ],
  });

  assert.equal(result.needsSelection, true);
  assert.deepEqual(result.candidates, [
    { projectId: "agentic-memory", projectName: "Agentic Memory" },
    { projectName: "Distributed Throttling" },
  ]);
});
