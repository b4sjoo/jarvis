import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { buildClarifyingOptionDisplayModel, parseClarifyingOptionsText } from "../src/lib/meeting/clarifying-options.js";
import { formatProjectBindingDecisionForPrompt, isProjectIdentityPending, resolveProjectBinding } from "../src/lib/meeting/project-binding.js";
import { buildAdvisorUserMessage } from "../src/lib/meeting/advisor-prompt.js";
import { loadScreenTaskPromptBuilder } from "./helpers/screen-task-prompt-builder.js";
import { createMeetingFocusDisplayModel } from "../src/lib/meeting/focus-display.js";
import { EMPTY_MEETING_FOCUS_SNAPSHOT } from "../src/lib/meeting/focus-window.js";

const missing = resolveProjectBinding({questionType: "project-deep-dive", currentSourceText: "Choose a project and describe your contributions."});
const question = "Which project should we discuss: Backend, Pipeline, or ML?";
const options = parseClarifyingOptionsText("Backend | Pipeline | ML")!;

test("PC1 existing unresolved binding owns the generic-option permission without a classifier", () => {
  assert.equal(missing.action, "needs-selection");
  assert.equal(isProjectIdentityPending(missing), true);
  assert.equal(isProjectIdentityPending(undefined), false);
  assert.equal(isProjectIdentityPending({...missing, action: "not-applicable"}), false);
  assert.equal(isProjectIdentityPending({...missing, action: "invalidate"}), true);
  assert.equal(isProjectIdentityPending({...missing, action: "preserve"}), false);
  for (const text of [question, "Do you want me to pick a project?", "Read path or write path?"]) {
    for (const values of [options, []]) {
      const result = buildClarifyingOptionDisplayModel({question: text, options: values, projectIdentityPending: true});
      assert.equal(result.source, "none");
      assert.deepEqual(result.options, []);
      assert.equal(result.showBooleanFallback, false);
    }
  }
  const normal = buildClarifyingOptionDisplayModel({question: "Read path or write path?", options, projectIdentityPending: false});
  assert.equal(normal.source, "structured-answer");
  assert.equal(normal.options.length, 3);
});

test("PC1 Prompt uses the trusted menu and no synthetic alternatives when identity is unresolved", () => {
  const policy = formatProjectBindingDecisionForPrompt(missing);
  assert.match(policy, /Clarifying options: -/);
  assert.match(policy, /trusted project menu/);
  assert.match(policy, /Eligible choices: none/);
  const context = {transcript: question, screenContext: "", rollingSummary: "", userProfileContext: "", glossaryText: "",
    taskRuntime: {revision: 0, parent: undefined}, projectBindingDecision: missing};
  const voice = buildAdvisorUserMessage(context);
  const screen = loadScreenTaskPromptBuilder()({observation: {id: "s", capturedAt: 1, summary: question},
    recentTranscript: question, projectBindingDecision: missing});
  assert.ok(voice.includes(policy));
  assert.ok(screen.includes(policy));
  assert.match(formatProjectBindingDecisionForPrompt({...missing, action: "preserve"}), /technical requirements or scope/);
});

test("PC2 production binding input does not promote ordinary clarification strings", () => {
  const source = ts.createSourceFile("hook.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);
  let value: string | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "projectBindingDecision" &&
        node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === "resolveProjectBinding") {
      const arg = node.initializer.arguments[0];
      assert.ok(ts.isObjectLiteralExpression(arg));
      const property = arg.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(source) === "explicitProjectSelection");
      assert.ok(property && ts.isPropertyAssignment(property));
      value = property.initializer.getText(source);
    }
    ts.forEachChild(node, visit);
  };
  visit(source); assert.ok(value);
  const trusted = {projectId: "real-project", authority: "user-explicit"};
  for (const explicitProjectSelection of [undefined, trusted]) {
    const options = {explicitProjectSelection, clarifyingFeedback: {answer: "option", answerValue: "Other real project", answerLabel: "Other real project"}};
    assert.equal(vm.runInNewContext(`(${value})`, {options}), explicitProjectSelection);
  }
});

function initializer(name: string) {
  const source = ts.createSourceFile("meeting.tsx", readFileSync("src/pages/app/components/meeting/index.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression: string | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) expression = node.initializer?.getText(source);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(expression);
  return ts.transpile(`(${expression})`, {target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React});
}

test("PC3 actual Normal selector uses locked answer A, not background B, and Focus preserves it", () => {
  for (const pending of [true, false]) {
    const globals = {
      displayedSuggestion: {projectIdentityPending: pending},
      meeting: {latestSuggestion: {projectIdentityPending: !pending}},
      clarifyingQuestion: question, rawClarifyingOptions: options,
      buildClarifyingOptionDisplayModel, useMemo: (fn: () => unknown) => fn(),
      isTaskSwitchQuestion: () => true,
    };
    const context = vm.createContext(globals);
    const selected = vm.runInContext(initializer("projectIdentityPending"), context);
    Object.assign(globals, {projectIdentityPending: selected});
    assert.equal(selected, pending);
    const display = vm.runInContext(initializer("clarifyingOptionDisplay"), context);
    assert.equal(display.options.length, pending ? 0 : 3);
    assert.equal(vm.runInContext(initializer("isTaskSwitchClarifyingQuestion"), context), !pending);
    const focus = createMeetingFocusDisplayModel({...EMPTY_MEETING_FOCUS_SNAPSHOT,
      sections: {...EMPTY_MEETING_FOCUS_SNAPSHOT.sections, clarifyingQuestion: question, clarifyingOptions: display.options},
      showClarifyingBooleanFallback: display.showBooleanFallback});
    assert.equal(focus.sections.clarifyingOptions.length, pending ? 0 : 3);
    assert.equal(focus.sections.clarifyingQuestion, question);
    assert.equal(focus.showClarifyingBooleanFallback, false);
  }
});
