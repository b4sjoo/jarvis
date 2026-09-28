import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const main = ts.createSourceFile("meeting.tsx", readFileSync("src/pages/app/components/meeting/index.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const focus = ts.createSourceFile("focus.tsx", readFileSync("src/pages/app/components/meeting/focus-window.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const { projectQuestionTypeObservation } = await import(pathToFileURL(path.join(
  process.env.JARVIS_TEST_OUTPUT_DIR ?? ".tmp-tests", "src/lib/meeting/question-type-observation.js")));
const { projectSelectedFocusTask } = await import(pathToFileURL(path.join(
  process.env.JARVIS_TEST_OUTPUT_DIR ?? ".tmp-tests", "src/lib/meeting/focus-display.js")));
const { normalizeCanonicalQuestionType } = await import(pathToFileURL(path.join(
  process.env.JARVIS_TEST_OUTPUT_DIR ?? ".tmp-tests", "src/lib/meeting/task-taxonomy.js")));
const { createFocusOwnerDisplayFixture } = await import(pathToFileURL(path.join(
  process.env.JARVIS_TEST_OUTPUT_DIR ?? ".tmp-tests", "tests/helpers/focus-owner-display-fixture.js")));
function nodes(ast, predicate) {
  const found = [];
  const visit = node => { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); };
  visit(ast); return found;
}
function variable(ast, name) {
  const found = nodes(ast, node => ts.isVariableDeclaration(node) && node.name.getText(ast) === name);
  assert.equal(found.length, 1, name); return found[0];
}
function evaluate(code, env) {
  return vm.runInNewContext(ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, env);
}
function callback(name, env) {
  return evaluate(`(${variable(main, name).initializer.arguments[0].getText(main)})`, env);
}
const targetA = { sessionId: "session", logicalQuestionUnitId: "lqu-A", logicalQuestionRevision: 3,
  generationId: "generation-A", traceId: "trace-A", suggestionId: "answer-A", stableRevision: 4 };
const targetB = { ...targetA, logicalQuestionUnitId: "lqu-B", traceId: "trace-B", suggestionId: "answer-B", generationId: "generation-B" };
function environment(locked = true) {
  const calls = [];
  return { calls, setOpen() {}, manualShortcutInvocation: invocation => ({ ingressSource: "shortcut", ...invocation }),
    adviseDisplay: { locked, target: targetA }, focusModeActive: false, focusWindowsVisible: false,
    focusPublisherRef: { current: { getLatestApplied: () => ({ adviseLocked: locked, displayTarget: targetA }) } },
    meeting: {
      applyResponseAction: (...args) => { calls.push({ method: "phase", args }); },
      correctActiveQuestionType: (...args) => { calls.push({ method: "type", args }); },
    },
  };
}

test("B UI: Next/Back shortcuts use the actually applied locked Focus target; unpinned retains active-branch invocation", () => {
  for (const native of [false, true]) for (const locked of [false, true]) {
    const env = environment(locked);
    env.focusModeActive = env.focusWindowsVisible = native;
    if (native) env.adviseDisplay.target = targetB;
    env.resolveShortcutDisplayTarget = callback("resolveShortcutDisplayTarget", env);
    callback("handleNextPhaseShortcut", env)({ actionId: "next" });
    callback("handleScopedResponseActionShortcut", env)("previous-phase", { actionId: "back" });
    assert.deepEqual(env.calls.map(call => call.args[0]), ["next-phase", "previous-phase"]);
    for (const call of env.calls) {
      assert.equal(Object.hasOwn(call.args[1], "displayTarget"), locked);
      if (locked) assert.deepEqual(call.args[1].displayTarget, targetA);
    }
  }
  const delayed = environment(false);
  delayed.focusModeActive = delayed.focusWindowsVisible = true;
  delayed.adviseDisplay.target = targetB;
  delayed.focusPublisherRef.current.getLatestApplied = () => ({ adviseLocked: true, displayTarget: targetA });
  delayed.resolveShortcutDisplayTarget = callback("resolveShortcutDisplayTarget", delayed);
  callback("handleNextPhaseShortcut", delayed)({ actionId: "old-focus-next-after-unlock" });
  assert.deepEqual(delayed.calls[0].args[1].displayTarget, targetA);
});

test("B UI: native producer and main consumer retain the clicked locked target across delayed delivery after unlock", () => {
  const assignment = nodes(main, node => ts.isBinaryExpression(node) && node.left.getText(main) === "focusActionHandlerRef.current")[0];
  assert.ok(assignment);
  for (const action of [{ type: "response-action", action: "next-phase" },
    { type: "response-action", action: "previous-phase" },
    { type: "correct-question-type", correctedType: "field-knowledge", source: "focus-mode", displayTarget: targetA,
      correctionTarget: { logicalQuestionUnitId: "lqu-A", logicalQuestionRevision: 3 },
      correctionIntent: { kind: "new-child", parentId: "parent-A" } }]) {
    for (const locked of [false, true]) {
      const queue = [];
      const send = evaluate(`(${variable(focus, "sendFocusAction").initializer.getText(focus)})`, {
        snapshot: { advisePin: { locked, target: targetA } },
        consumerRef: { current: { dispatch: value => queue.push(JSON.parse(JSON.stringify(value))) } },
        createMeetingId: () => "action-A", console: { info() {} },
      });
      send(action);
      const pending = queue[0];
      const scoped = locked || action.type === "correct-question-type";
      assert.equal(Object.hasOwn(pending, "displayTarget"), scoped);
      const env = environment(false);
      env.adviseDisplay.target = targetB;
      const receive = evaluate(`(${assignment.right.getText(main)})`, env);
      receive(pending);
      const invocation = env.calls[0].args.at(-1);
      assert.equal(Object.hasOwn(invocation, "displayTarget"), scoped);
      if (scoped) assert.deepEqual(invocation.displayTarget, targetA);
      if (action.type === "correct-question-type") {
        assert.equal(invocation.actionId, "action-A");
        assert.deepEqual(JSON.parse(JSON.stringify(invocation.correctionTarget)), action.correctionTarget);
        assert.deepEqual(JSON.parse(JSON.stringify(invocation.correctionIntent)), action.correctionIntent);
      }
    }
  }
});

test("MC7 UI: both type menus submit the original selection; phase buttons retain locked-only scope", () => {
  const corrections = nodes(main, node => ts.isJsxAttribute(node) &&
    ["menu", "typeCorrectionMenu"].includes(node.name.getText(main)) &&
    node.initializer?.expression?.getText(main).includes("submitTypeCorrection("));
  assert.equal(corrections.length, 2);
  const response = nodes(main, node => ts.isJsxAttribute(node) && node.name.getText(main) === "onClick" &&
    node.initializer?.expression?.getText(main).includes("meeting.applyResponseAction(action.id"));
  assert.equal(response.length, 1);
  for (const locked of [false, true]) {
    for (const control of corrections) {
      const env = environment(locked);
      env.submitTypeCorrection = evaluate(`(${variable(main, "submitTypeCorrection").initializer.getText(main)})`, env);
      const menu = evaluate(`(${control.initializer.expression.getText(main)})`, env);
      assert.deepEqual(menu.displayTarget, targetA);
      env.adviseDisplay.target = targetB;
      const selection = { correctedType: "coding", displayTarget: targetA, target: { logicalQuestionUnitId: "lqu-A" },
        option: { intent: { kind: "retype-parent", parentId: "parent-A" } } };
      menu.onSelect(selection);
      assert.deepEqual(env.calls[0].args[2].displayTarget, targetA);
      assert.equal(env.calls[0].args[2].correctionTarget, selection.target);
      assert.equal(env.calls[0].args[2].correctionIntent, selection.option.intent);
    }
    for (const id of ["previous-phase", "next-phase", "enhance-context", "narrow-context"]) {
      const env = { ...environment(locked), action: { id } };
      evaluate(`(${response[0].initializer.expression.getText(main)})`, env)();
      const scoped = locked || id === "enhance-context" || id === "narrow-context";
      assert.equal(Object.hasOwn(env.calls[0].args[1], "displayTarget"), scoped);
      if (scoped) assert.deepEqual(env.calls[0].args[1].displayTarget, targetA);
    }
  }
});

test("PDD UI phase choices are Summary/QA while historical Observed and Expected values round-trip unchanged", () => {
  const phases = evaluate(`(${variable(main, "projectTrajectoryPhases").initializer.getText(main)})`, {});
  assert.deepEqual(Array.from(phases), ["project_summary", "project_QA"]);
  const group = nodes(main, node => ts.isJsxSelfClosingElement(node) &&
    node.tagName.getText(main) === "CriticalMomentButtonGroup" &&
    node.attributes.properties.some(prop => prop.name?.getText(main) === "label" && prop.initializer?.text === "Expected phase"))[0];
  assert.ok(group);
  const optionExpression = group.attributes.properties.find(prop => prop.name?.getText(main) === "options").initializer.expression;
  const options = evaluate(`(${optionExpression.getText(main)})`, { projectTrajectoryPhases: phases });
  assert.deepEqual(JSON.parse(JSON.stringify(options)), [["project_summary", "Summary"], ["project_QA", "QA"]]);
  const draftDeclaration = nodes(main, node => ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) &&
    node.name.elements[0]?.name?.getText(main) === "expectedProjectPhase")[0];
  assert.equal(draftDeclaration.initializer.typeArguments[0].getText(main), "RecordedInterviewPlaybookPhase");
  const fix = nodes(main, node => ts.isJsxAttribute(node) && node.name.getText(main) === "onClick" &&
    node.initializer?.expression?.getText(main).includes("setExpectedProjectPhase("))[0];
  assert.ok(fix);
  for (const phase of ["project_narrative", "architecture_decision", "validation_reliability", "impact_lessons", ...phases]) {
    const facts = [];
    const env = { activeProjectTrajectoryFact: undefined, observedProjectId: "project-a", observedProjectName: "Project A",
      observedProjectPhase: phase, observedProjectFactAnchorState: undefined, observedProjectChildContinuity: undefined,
      expectedProjectName: "Project A", expectedProjectPhase: undefined, expectedProjectFactAnchorState: undefined,
      expectedProjectChildContinuity: undefined, expectedUnsupportedFirstPersonClaim: undefined,
      setExpectedProjectName() {}, setExpectedProjectPhase: value => { env.expectedProjectPhase = value; },
      setExpectedProjectFactAnchorState() {}, setExpectedProjectChildContinuity() {}, setExpectedUnsupportedFirstPersonClaim() {},
      setProjectTrajectoryFixOpen() {}, recordExpectedProjectTrajectory: fact => facts.push(fact),
    };
    evaluate(`(${fix.initializer.expression.getText(main)})`, env)();
    assert.equal(env.expectedProjectPhase, phase);
    evaluate(`(${variable(main, "saveCorrectedProjectTrajectory").initializer.getText(main)})`, env)();
    evaluate(`(${variable(main, "recordObservedProjectTrajectory").initializer.getText(main)})`, env)();
    assert.deepEqual(facts.map(fact => fact.expectedPhase), [phase, phase]);
    const observed = evaluate(`(${variable(main, "observedProjectPhase").initializer.getText(main)})`, {
      observedSnapshotV2: { playbookPhase: phase },
    });
    assert.equal(observed, phase);
  }
});

function displayLabels(adviseDisplay, overrides = {}) {
  const trace = (id, questionType, parentQuestionType) => ({ id, metadata: {
    effectiveCurrentQuestionSettlementQuestionType: questionType, activeMeetingParentQuestionType: parentQuestionType,
    activeMeetingParentId: "shared-parent", questionInstanceId: `question-${id}`,
  } });
  const latestSuggestion = { sourceTraceId: "trace-B", questionType: "coding",
    questionLineage: { questionInstanceId: "question-trace-B" }, transientPersonalStatus: { label: "Wrong latest status" } };
  const meeting = { latestSuggestion, traces: [trace("trace-A", "field-knowledge", "ai-ml-system-design"), trace("trace-B", "coding", "coding")],
    activeMeetingTask: { id: "shared-parent", parent: { id: "shared-parent" } },
    currentQuestionLineage: latestSuggestion.questionLineage,
    manualQuestionTypeCorrection: { questionId: "question-trace-B", taskId: "shared-parent" }, ...overrides };
  const first = variable(main, "currentQuestionSuggestion").parent;
  const last = variable(main, "activeManualQuestionTypeCorrection").parent;
  const block = main.text.slice(first.getStart(main), last.end);
  return evaluate(`${block};\n({ currentQuestionTrace, currentQuestionId, effectiveQuestionType,
    currentQuestionTypeObservation, transientPersonalStatusLabel, activeManualQuestionTypeCorrection, selectedTaskDisplay });`, {
    adviseDisplay, meeting, activeTaskKind: "coding", hasCorrectableQuestion: true, projectQuestionTypeObservation,
    projectSelectedFocusTask, normalizeCanonicalQuestionType,
    readStringMetadata: (metadata, key) => typeof metadata?.[key] === "string" ? metadata[key] : undefined,
  });
}

test("B UI: locked labels use selected source trace, including streaming, without borrowing newer global metadata", () => {
  const locked = { locked: true, target: targetA, stable: { suggestion: {
    sourceTraceId: "trace-A", questionType: "field-knowledge", questionLineage: { questionInstanceId: "question-trace-A" },
  }, sections: { answer: { owner: null } } } };
  const result = displayLabels(locked);
  assert.equal(result.currentQuestionTrace.id, "trace-A");
  assert.equal(result.effectiveQuestionType, "field-knowledge");
  assert.equal(result.currentQuestionTypeObservation.observedParentType, "ai-ml-system-design");
  assert.equal(result.currentQuestionId, "question-trace-A");
  assert.equal(result.transientPersonalStatusLabel, undefined);
  assert.equal(result.activeManualQuestionTypeCorrection, undefined, "same-parent B correction is not an A correction");
  assert.equal(displayLabels({ ...locked, stable: null }).effectiveQuestionType, "field-knowledge");
  const missing = displayLabels({ ...locked, target: { ...targetA, traceId: "missing" }, stable: null });
  assert.equal(missing.effectiveQuestionType, "unknown");
  assert.equal(missing.currentQuestionTypeObservation.observedParentType, undefined);
  assert.equal(displayLabels({ ...locked, locked: false }).effectiveQuestionType, "coding");
});

test("B UI: selected phase notice and the owner-scoped task summary remain visible while locked", () => {
  const snapshot = variable(main, "focusSnapshot").initializer.arguments[0].body;
  const properties = snapshot.arguments[0].properties;
  const expression = key => properties.find(property => property.name?.getText(main) === key).initializer.getText(main);
  const env = { adviseDisplay: { locked: true }, meeting: { phaseOutputNotice: "A implementation pending", activeMeetingTask: { id: "B" } },
    selectedTaskDisplay: { task: { id: "A", playbookPhase: "design_framing" } }, getActiveMeetingTaskFocusSummary: task => task };
  assert.equal(evaluate(expression("phaseOutputNotice"), env), "A implementation pending");
  assert.equal(evaluate(expression("activeTask"), env).id, "A");
});

test("B UI: real selected metadata retains A across B, while same-owner committed type/phase updates precede answer regeneration", () => {
  for (const input of [{}, { differentParent: true }, { committedUpdate: true }]) {
    const fixture = createFocusOwnerDisplayFixture(input);
    const original = JSON.stringify(fixture);
    const result = displayLabels(fixture.adviseDisplay, fixture.meeting);
    assert.equal(result.currentQuestionTrace.id, "trace-A");
    assert.equal(result.effectiveQuestionType, input.committedUpdate ? "ai-ml-system-design" : "general-system-design");
    assert.equal(result.currentQuestionTypeObservation.observedParentType, result.effectiveQuestionType);
    assert.equal(result.selectedTaskDisplay.task.id, "parent-A");
    assert.equal(result.selectedTaskDisplay.task.child, undefined, "background B child is not part of selected parent A");
    assert.equal(result.selectedTaskDisplay.task.playbookPhase, input.committedUpdate ? "design_framing" : "requirement_clarification");
    assert.equal(fixture.adviseDisplay.stable.sections.answer.phase, "requirement_clarification", "answer still predates the manual commit");
    assert.equal(JSON.stringify(fixture), original, "presentation cannot mutate owner state or the Stable result");
  }
  for (const matchingChild of [false, true]) {
    const fixture = createFocusOwnerDisplayFixture({ selectedChild: true, matchingChild });
    const result = displayLabels(fixture.adviseDisplay, fixture.meeting);
    assert.equal(result.selectedTaskDisplay.task.child.id, "child-A");
    assert.equal(result.selectedTaskDisplay.task.child.playbookPhase, matchingChild ? "implementation_validation" : "baseline_reasoning");
  }
});

test("B UI: Advise-only Field A cannot inherit a retained Coding child's type or phase", () => {
  const fixture = createFocusOwnerDisplayFixture({ selectedChild: true, matchingChild: true });
  const metadata = fixture.meeting.traces[0].metadata;
  metadata.effectiveCurrentQuestionSettlementQuestionType = "field-knowledge";
  metadata.settledExecutionPlanRelation = "none";
  metadata.settledExecutionPlanRelationApplicable = false;
  fixture.adviseDisplay.stable.suggestion.questionType = "field-knowledge";
  fixture.adviseDisplay.stable.settlementSnapshot = { relation: "none" };
  const result = displayLabels(fixture.adviseDisplay, fixture.meeting);
  assert.equal(result.effectiveQuestionType, "field-knowledge");
  assert.equal(result.selectedTaskDisplay.currentOwnerQuestionType, undefined);
  assert.equal(result.selectedTaskDisplay.task, undefined, "the retained child is not this output's phase owner");
  assert.equal(result.selectedTaskDisplay.affiliated, false);
  const snapshot = variable(main, "focusSnapshot").initializer.arguments[0].body;
  const notice = snapshot.arguments[0].properties.find(property => property.name?.getText(main) === "phaseOutputNotice");
  assert.equal(evaluate(notice.initializer.getText(main), {
    adviseDisplay: fixture.adviseDisplay, selectedTaskDisplay: result.selectedTaskDisplay,
    meeting: { phaseOutputNotice: "Foreign Coding child phase notice." },
  }), undefined);
  assert.equal(result.currentQuestionTypeObservation.observedParentType, "general-system-design");
  fixture.meeting.traces = [];
  const evicted = displayLabels(fixture.adviseDisplay, fixture.meeting);
  assert.equal(evicted.effectiveQuestionType, "field-knowledge");
  assert.equal(evicted.selectedTaskDisplay.task, undefined);
});

test("B UI: an evicted trace and retired child owner expose missing historical parent fields without borrowing B", () => {
  const fixture = createFocusOwnerDisplayFixture({ selectedChild: true, differentParent: true });
  fixture.meeting.traces = [];
  const result = displayLabels(fixture.adviseDisplay, fixture.meeting);
  assert.equal(result.currentQuestionTrace, undefined);
  assert.equal(result.effectiveQuestionType, "coding");
  assert.equal(result.selectedTaskDisplay.task.id, "parent-A");
  assert.equal(result.selectedTaskDisplay.task.questionType, "unknown");
  assert.equal(result.selectedTaskDisplay.task.playbookPhase, undefined);
  assert.equal(result.selectedTaskDisplay.task.child.id, "child-A");
  assert.equal(result.selectedTaskDisplay.task.child.playbookPhase, "baseline_reasoning");
  assert.equal(result.currentQuestionTypeObservation.observedParentId, "parent-A");
  assert.equal(result.currentQuestionTypeObservation.observedParentType, "unknown");
});
