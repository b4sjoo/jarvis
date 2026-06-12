import assert from "node:assert/strict";
import test from "node:test";
import {
  getDisplayClarifyingOptions,
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
