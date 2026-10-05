import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("hook.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);
function find(predicate) {
  let found;
  function visit(node) { if (predicate(node)) found ??= node; if (!found) ts.forEachChild(node, visit); }
  visit(source);
  assert.ok(found, "production reference consumer exists");
  return found;
}
function evaluate(node, environment) {
  return vm.runInNewContext(ts.transpileModule(`(${node.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, environment);
}
const captureNode = find(n => ts.isFunctionDeclaration(n) && n.name?.text === "captureAdvisorReferenceSuggestion");
const guidanceNode = find(n => ts.isPropertyAssignment(n) && n.name.getText(source) === "generatedGuidance" &&
  n.initializer.getText(source).includes("options.currentSuggestion")).initializer;
const currentNode = find(n => ts.isVariableDeclaration(n) && n.name.getText(source) === "currentSuggestion" &&
  n.initializer?.getText(source).includes("displayed?.streaming")).initializer;
const capture = evaluate(captureNode, {});
const guidance = (currentSuggestion, transientPersonalStatusDecision = false) => evaluate(guidanceNode, {
  options: { currentSuggestion }, transientPersonalStatusDecision,
  // Any ambient read fails rather than silently supplying a matching test value.
  get state() { throw new Error("reference source must not be read from ambient state"); },
});

test("GG178 reference copies two fields; later source mutation cannot change the captured pair", () => {
  const selected = { content: "Answer: A", sourceTraceId: "trace-A", id: "A", unrelated: true };
  const reference = capture(selected);
  selected.content = "Answer: B"; selected.sourceTraceId = "trace-B";
  assert.deepEqual(JSON.parse(JSON.stringify(reference)), { content: "Answer: A", sourceTraceId: "trace-A" });
  assert.equal(guidance(reference).text, "Answer: A");
  assert.equal(guidance(reference).sourceTraceId, "trace-A");
});

test("GG178 absent, blank, missing-source and transient inputs do not borrow a global source", () => {
  for (const input of [undefined, { content: "" }, { content: "  ", sourceTraceId: "A" }, { content: "Answer: A" }]) {
    assert.equal(guidance(input), undefined);
  }
  assert.equal(guidance({ content: "Answer: A", sourceTraceId: "A" }, true), undefined);
  assert.equal(capture({ content: "Answer without provenance" }).content, "Answer without provenance",
    "original text remains usable by existing action consumers");
});

test("GG178 partial input carries the displayed stream provenance, never the older stable provenance", () => {
  const current = (partial, stream) => evaluate(currentNode, {
    displayed: { streaming: Boolean(partial), sections: { parsedAnswer: { rawContent: partial } }, target: { traceId: stream?.traceId } },
    actionStableAnswer: { suggestion: { content: "Answer: stable", sourceTraceId: "stable" } },
    state: { latestSuggestion: { content: "Answer: stable", sourceTraceId: "stable" } },
    captureAdvisorReferenceSuggestion: capture,
  });
  assert.equal(guidance(current("Answer: streaming", { traceId: "stream" })).sourceTraceId, "stream");
  assert.equal(guidance(current("Answer: streaming", null)), undefined);
  assert.equal(guidance(current("", { traceId: "stream" })).sourceTraceId, "stable");
});

test("GG178 reference capture cost is a two-scalar projection independent of answer length", t => {
  for (const chars of [100, 100_000]) {
    const value = { content: "A".repeat(chars), sourceTraceId: "trace-A" };
    const samples = Array.from({ length: 1000 }, () => {
      const start = performance.now();
      const result = capture(value);
      const duration = performance.now() - start;
      assert.equal(result.content, value.content);
      assert.equal(Object.keys(result).length, 2);
      return duration;
    }).sort((a, b) => a - b);
    t.diagnostic(`GG178 capture chars=${chars} samples=1000 p50Ms=${samples[499]} p95Ms=${samples[949]} maxMs=${samples.at(-1)}`);
  }
});
