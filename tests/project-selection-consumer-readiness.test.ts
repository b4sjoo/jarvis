import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import type * as TypeScript from "typescript";
import {
  S63_CONSUMER_EXECUTIONS,
  S63_EXECUTION_CONSTRAINTS,
  S63_FACT_A,
  S63_FACT_B,
  S63_MEMORY,
  S63_PROVIDER_ANSWERS,
  S63_SOURCE_QUESTION,
  assertS63SelectedProviderPrompt,
} from "./fixtures/project-selection-consumer.js";
import { parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";

const ts = createRequire(`${process.cwd()}/package.json`)("typescript") as typeof TypeScript;

test("S63 fixture fixes eight cases and ten executions without seeding runtime identity", () => {
  assert.equal(new Set(S63_CONSUMER_EXECUTIONS.map((item) => item.caseId)).size, 8);
  assert.equal(new Set(S63_CONSUMER_EXECUTIONS.map((item) => item.executionId)).size, 10);
  assert.deepEqual(S63_CONSUMER_EXECUTIONS.filter((item) => item.pauseAt).map((item) => item.pauseAt), [
    "storage-before-binding", "provider-after-binding", "storage-before-binding", "provider-after-binding",
  ]);
  assert.equal(S63_CONSUMER_EXECUTIONS.filter((item) => item.surface === "normal").length, 5);
  assert.equal(S63_CONSUMER_EXECUTIONS.filter((item) => item.source === "screen").length, 5);
  assert.equal(S63_MEMORY.length, 2);
  assert.ok(!S63_MEMORY.some((entry) => S63_SOURCE_QUESTION.includes(entry.projectName!)));
  for (const item of S63_CONSUMER_EXECUTIONS) {
    for (const key of ["parent", "parentId", "binding", "taskId", "lquId", "settlement", "expectedSemanticResult"]) {
      assert.ok(!Object.hasOwn(item, key), `runtime input must not pre-seed ${key}`);
    }
  }
  assert.deepEqual(S63_EXECUTION_CONSTRAINTS.controlledBoundaries, ["provider", "storage", "transport", "clock"]);
});

test("S63 fixed Provider output uses the real Answer parser and contains no model-provided selection", () => {
  const initial = parseMeetingAnswer(S63_PROVIDER_ANSWERS.initial);
  const selected = parseMeetingAnswer(S63_PROVIDER_ANSWERS.selected);
  assert.equal(initial.sections.clarifyingQuestion ?? "", "");
  assert.equal(initial.sections.clarifyingOptions?.length ?? 0, 0);
  assert.equal(selected.sections.clarifyingQuestion ?? "", "");
  assert.ok(selected.sections.answer?.includes(S63_FACT_B));
});

test("S63 Provider-boundary assertion rejects name-only support and cross-project fact contamination", () => {
  assert.throws(() => assertS63SelectedProviderPrompt("Eligible choices: Cedar Analytics, Quartz Relay"));
  assert.throws(() => assertS63SelectedProviderPrompt(`${S63_FACT_A}\n${S63_FACT_B}`));
  assertS63SelectedProviderPrompt(`Eligible choices: Cedar Analytics, Quartz Relay\n${S63_FACT_B}`);
});

test("S63 production callback inventory reports the unexecuted boundaries, not a consumer pass", (t) => {
  const filename = "src/hooks/useMeetingAssistant.ts";
  const program = ts.createProgram([filename], { noResolve: true });
  const file = program.getSourceFile(filename)!;
  const checker = program.getTypeChecker();
  const names = ["answerClarifyingQuestion", "runAdvisor", "captureScreenContext", "processCanonicalTurnIngress", "submitRuntimeRegressionText"];
  for (const name of names) {
    let declaration: TypeScript.VariableDeclaration | undefined;
    const find = (node: TypeScript.Node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(file) === name) declaration = node;
      ts.forEachChild(node, find);
    };
    find(file);
    assert.ok(declaration?.initializer && ts.isCallExpression(declaration.initializer), `${name} production callback missing`);
    const body = declaration.initializer.arguments[0];
    assert.ok(body);
    const dependencies = new Set<string>();
    const visit = (node: TypeScript.Node) => {
      if (ts.isIdentifier(node)) {
        for (const owner of checker.getSymbolAtLocation(node)?.declarations ?? []) {
          if (owner.getSourceFile() !== file || (owner.pos >= body.pos && owner.end <= body.end)) continue;
          if (ts.isVariableDeclaration(owner) || ts.isFunctionDeclaration(owner) || ts.isParameter(owner)) dependencies.add(node.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(body);
    t.diagnostic(`${name}: ${body.getText(file).split("\n").length} lines, ${dependencies.size} Hook-scope dependencies`);
    if (name === "answerClarifyingQuestion") {
      t.diagnostic(`projectChoice accepted by current Hook source: ${body.getText(file).includes("projectChoice")}; this source observation does not prove execution`);
    }
  }
  const existingUiTest = readFileSync("tests/clarifying-interaction.test.ts", "utf8");
  const existingPublicationTest = readFileSync("tests/pending-answer-publication-callback.test.mjs", "utf8");
  t.diagnostic(`existing UI test controls callback outcome: ${existingUiTest.includes('resolve({state:"succeeded"')}`);
  t.diagnostic(`existing publication test prepares candidates outside runAdvisor: ${existingPublicationTest.includes("function prepareOutputCandidate")}`);
});

// N1 now has a real browser/Hook test in project-selection-hook-browser.test.mjs.
// Keep the remaining nine executions pending, independently of readiness checks.
for (const execution of S63_CONSUMER_EXECUTIONS.filter(item => item.executionId !== "S63-N1")) {
  test.todo(`${execution.executionId}: ${execution.surface}/${execution.source} ${execution.behavior}${execution.pauseAt ? ` at ${execution.pauseAt}` : ""}; not yet accepted by the complete production consumer matrix`);
}
