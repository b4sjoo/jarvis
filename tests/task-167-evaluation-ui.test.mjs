import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { build } from "esbuild";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";

const root = process.cwd();
const panelFile = path.join(root, "src/pages/app/components/meeting/index.tsx");
const source = readFileSync(panelFile, "utf8");
const ast = ts.createSourceFile(panelFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let attemptSection;
const visit = node => {
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === "section" &&
      node.getText(ast).includes("Attempt evaluation") && node.getText(ast).includes("key={evaluationTrace.id}")) {
    attemptSection = node.getText(ast);
  }
  ts.forEachChild(node, visit);
};
visit(ast);
assert.ok(attemptSection, "production attempt wrapper must be tested, not only its child panel");
const selectionStart = source.indexOf("const currentEvaluationQuestionKey =");
const selectionEnd = source.indexOf("const currentTranscriptTurnIds", selectionStart);
assert.ok(selectionStart > 0 && selectionEnd > selectionStart);
const attemptSelection = source.slice(selectionStart, selectionEnd);
let playwright;
try { playwright = createRequire(import.meta.url)(process.env.JARVIS_PLAYWRIGHT_MODULE ?? "playwright"); } catch {}

async function manualCorrectionReceiptFixture() {
  // Reuse Darwin's actual writer fixture, without executing its test registrations.
  const file = path.join(root, "tests/manual-correction-observation.test.ts");
  const fixtureAst = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const declarations = fixtureAst.statements.filter(node => ts.isFunctionDeclaration(node) || ts.isVariableStatement(node) ||
    (ts.isImportDeclaration(node) && node.moduleSpecifier.text !== "node:test"));
  const bundle = await build({ stdin: { contents: declarations.map(node => node.getText(fixtureAst)).join("\n") +
    "\nexport { committed, buildHumanEvaluationAttemptEvidenceV2, evaluateTaskSettlementTupleCompatibilityV2 };",
    loader: "ts", resolveDir: path.dirname(file) }, bundle: true, write: false, platform: "node", format: "cjs", external: ["typescript"] });
  const module = { exports: {} };
  return vm.compileFunction(bundle.outputFiles[0].text + "\nreturn module.exports;", ["module", "exports", "require"])(
    module, module.exports, createRequire(import.meta.url));
}

test("MC8 UI tuple validators consume only committed Observed evidence, not the menu intent", async () => {
  const production = await manualCorrectionReceiptFixture();
  const { trace } = production.committed("merge-recent-parent");
  const variables = new Map();
  const scan = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) variables.set(node.name.text, node);
    if (ts.isFunctionDeclaration(node) && node.name) variables.set(node.name.text, node);
    ts.forEachChild(node, scan);
  };
  scan(ast);
  const evaluate = (name, env) => vm.runInNewContext(ts.transpileModule(
    `(${(ts.isFunctionDeclaration(variables.get(name)) ? variables.get(name) : variables.get(name).initializer).getText(ast)})`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
  ).outputText, env);
  assert.ok(Array.from(evaluate("evaluationTaskRelations", {})).includes("followup-parent"));
  assert.ok(Array.from(evaluate("evaluationParentActions", {})).includes("resume"));
  const cases = [
    [trace, true],
    [{ ...trace, status: "error" }, true],
    [{ ...trace, metadata: { ...trace.metadata, manualCorrectionIntentReceipt: undefined } }, false],
    [{ ...trace, status: "cancelled", metadata: { ...trace.metadata, correctionAtomicCommitAuthorized: false } }, false],
    [{ ...trace, metadata: { ...trace.metadata, taskLifecycleExecutionPlanId: "foreign-plan" } }, false],
  ];
  const criticalPanel = variables.get("CriticalMomentEvaluationPanel");
  let criticalRelationSelect, criticalObservedInput;
  const findBindings = node => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === "CriticalMomentButtonGroup" &&
        node.attributes.properties.some(prop => prop.name?.getText(ast) === "label" && prop.initializer?.text === "Expected relation")) {
      criticalRelationSelect = node.attributes.properties.find(prop => prop.name?.getText(ast) === "onSelect").initializer.expression;
    }
    ts.forEachChild(node, findBindings);
  };
  findBindings(criticalPanel);
  const findObservedInput = node => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === "CriticalMomentEvaluationPanel") {
      criticalObservedInput = node.attributes.properties.find(prop => prop.name?.getText(ast) === "observed").initializer.expression;
    }
    ts.forEachChild(node, findObservedInput);
  };
  findObservedInput(ast);
  const evaluateNode = (node, env) => vm.runInNewContext(ts.transpileModule(`(${node.getText(ast)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, env);
  for (const [candidate, compatible] of cases) {
    const observed = production.buildHumanEvaluationAttemptEvidenceV2({ trace: candidate, traces: [candidate] }).observed;
    assert.equal(Boolean(observed.manualCorrectionEvidence), compatible);
    const facts = [];
    const env = { evaluateTaskSettlementTupleCompatibilityV2: production.evaluateTaskSettlementTupleCompatibilityV2,
      expectedQuestionType: "ai-ml-system-design", expectedRelation: "followup-parent", expectedParentAction: "resume",
      observedSnapshotV2: observed, observed, recordGroundTruth: fact => facts.push(fact), setTaskFixOpen() {}, trace: candidate,
    };
    env.expectedSettlementCompatibility = evaluate("expectedSettlementCompatibility", env);
    assert.equal(env.expectedSettlementCompatibility.compatible, compatible);
    assert.equal(evaluate("settlementCompatibility", env).compatible, compatible, "Critical Moment uses supplied Observed, not candidate traces");
    let selectedAction = "resume";
    evaluateNode(criticalRelationSelect, { ...env,
      normalizeEvaluationTaskRelation: evaluate("normalizeEvaluationTaskRelation", { evaluationTaskRelations: evaluate("evaluationTaskRelations", {}) }),
      setExpectedRelation() {}, setExpectedParentAction: update => { selectedAction = update(selectedAction); },
    })("followup-parent");
    assert.equal(selectedAction, compatible ? "resume" : "preserve", "relation selection preserves resume only with the committed merge evidence");
    evaluate("recordCorrectedTaskSettlement", env)();
    assert.equal(facts.length, compatible ? 1 : 0, "ordinary Save never bypasses the tuple guard");
    if (compatible) {
      assert.equal(evaluate("observedSettlementCompatibility", { ...env, observedRelation: observed.relation,
        observedParentAction: observed.parentAction }).compatible, true);
      assert.equal(facts[0].expectedParentAction, "resume");
    }
  }
  const observed = production.buildHumanEvaluationAttemptEvidenceV2({ trace, traces: [trace] }).observed;
  const joinEnv = { latestCriticalMomentGroundTruth: { projectionId: "exact-projection" },
    latestCriticalMomentCandidate: { sessionId: "mc8-session" },
    meeting: { humanEvaluationProjectionsV2: [{ projectionId: "exact-projection", sessionId: "mc8-session", observed }] } };
  assert.equal(evaluateNode(criticalObservedInput, joinEnv), observed);
  assert.equal(evaluateNode(criticalObservedInput, { ...joinEnv, latestCriticalMomentGroundTruth: {} }), undefined);
  assert.equal(evaluateNode(criticalObservedInput, { ...joinEnv, latestCriticalMomentCandidate: { sessionId: "other-session" } }), undefined);
});

test("E167-8: evaluation production bindings retire V1 writers and keep runtime intervention paths", () => {
  const panel = source.slice(source.indexOf("const TraceHumanEvaluationPanel ="), source.indexOf("const TraceClassifierMetadata ="));
  assert.doesNotMatch(panel, /onUpdateQuestion|onUpdate\b|primaryAskCorrect\b|updateQuestionVerdict|Correct question type|Answer verdict|Task quality/);
  assert.doesNotMatch(source, /meeting\.updateTraceHumanEvaluation|meeting\.updateQuestionHumanEvaluation/);
  assert.match(source, /onRecordGroundTruthV2=\{\(fact, options\) => \{\s*meeting\.recordHumanGroundTruthV2/);
  assert.match(source, /evaluationPersistence=\{meeting\.evaluationPersistence\}/);
  assert.match(source, /onRetrySave=\{meeting\.retryHumanEvaluationSave\}/);
  assert.match(source, /key=\{evaluationTrace\.id\}/);
  assert.match(source, /decideForceAdviseEligibility/);
  assert.match(source, /hasManualQuestionTypeCorrectionPresentationTarget/);
});

test("E167-8: real production React JSX, optional labels, specialist facts and persistence feedback", {
  skip: !playwright && "Set JARVIS_PLAYWRIGHT_MODULE to host playwright",
}, async (t) => {
  const primitives = ["Button", "Input", "Textarea", "Label"];
  const mocks = {
    "@/hooks": "export const useMeetingAssistant = () => {}; export const useShortcuts = () => {}; export const useWindowResize = () => {};",
    "@/lib": "export const extractVariables = () => []; export const safeLocalStorage = { getItem: () => null };",
    "@/lib/meeting": [
      'export * from "./src/lib/meeting/human-ground-truth-v2";',
      'export * from "./src/lib/meeting/task-taxonomy";',
      'export * from "./src/lib/meeting/question-type-observation";',
      'export * from "./src/lib/meeting/meeting-metadata-evaluation";',
      'export * from "./src/lib/meeting/human-evaluation";',
      'export * from "./src/lib/meeting/memory-evaluation";',
      'export * from "./src/lib/meeting/preparation-runtime-provenance";',
    ].join("\n"),
    "@/components": ['export * from "./src/components/Markdown";', ...primitives.map((name) => `export { ${name} } from "./src/components/ui/${name.toLowerCase()}";`)].join("\n"),
  };
  // Only imported bindings outside the evaluation subtree receive inert stubs.
  for (const module of ["@/lib/meeting", "@/components"]) {
    const importBlock = [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g)].find((match) => match[2] === module)?.[1] ?? "";
    const used = new Set(module === "@/components" ? [...primitives, "Markdown"] : ["freezeObservedTaskOwnerIdentityV2", "evaluateTaskSettlementTupleCompatibilityV2", "normalizeCanonicalQuestionType", "projectQuestionTypeObservation", "projectMeetingMetadataEvaluationObservation", "resolveSettledAttemptEvaluationTarget", "buildHumanEvaluationSelectionSnapshot", "captureHumanGroundTruthEvaluationTarget", "findQuestionHumanEvaluationForTrace", "resolveTraceMemoryEvaluationSnapshot", "selectPreparationArtifactUseReceiptsForEvaluation"]);
    for (const name of importBlock.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!used.has(name)) mocks[module] += `\nexport const ${name} = () => null;`;
    }
  }
  const bundle = await build({
    entryPoints: [path.join(root, "tests/fixtures/task-167-evaluation-ui.tsx")],
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"development"', "import.meta.env.DEV": "false" },
    plugins: [{ name: "evaluation-production-ui", setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => {
        if (Object.hasOwn(mocks, args.path)) return { path: args.path, namespace: "fixture" };
        if (args.path === "./whiteboard-viewer") return { path: "whiteboard", namespace: "fixture" };
      });
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
        contents: mocks[args.path] ?? "export const WhiteboardViewer = () => null;", loader: "tsx", resolveDir: root,
      }));
      builder.onLoad({ filter: /meeting\/index\.tsx$/ }, (args) => ({
        contents: readFileSync(args.path, "utf8") + `
          export { TraceHumanEvaluationPanel };
          export function AttemptEvaluationFixture({meeting, adviseDisplay, open = true}) {
            const isFocusMode = false;
            const displayTargetKey = JSON.stringify(adviseDisplay.target);
            ${attemptSelection}
            return open ? (${attemptSection}) : null;
          }
        `, loader: "tsx", resolveDir: path.dirname(args.path),
      }));
    } }],
  });
  const css = await compile(readFileSync(path.join(root, "src/global.css"), "utf8"), { base: path.join(root, "src"), onDependency() {} });
  const scanner = new Scanner({ sources: [{ base: root, pattern: "src/pages/app/components/meeting/index.tsx", negated: false }, { base: root, pattern: "src/components/ui/*.tsx", negated: false }] });
  const browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.JARVIS_CHROMIUM_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
    await page.goto("http://task167.fixture/");
    await page.addStyleTag({ content: css.build(scanner.scan()) + "body{position:static;overflow:auto;height:auto}" });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.waitForFunction(() => window.__evaluation?.projection);
    const snapshot = () => page.evaluate(() => ({ calls: window.__evaluation.calls, legacy: window.__evaluation.legacyCalls, retries: window.__evaluation.retries, projection: window.__evaluation.projection }));
    const group = (name) => page.locator(`[data-evaluation-group="${name}"]`);
    const choose = async (scope, label, value) => scope.getByText(label, { exact: true }).locator("..").getByRole("button", { name: value, exact: true }).click();
    const lastFact = async () => (await snapshot()).calls.at(-1)?.fact;
    await t.test("mount, open and rerender never label; default is exactly three optional groups", async () => {
      assert.equal((await snapshot()).calls.length, 0);
      await page.getByText("Human evaluation", { exact: true }).click();
      assert.deepEqual(await page.locator("[data-evaluation-group]:visible").evaluateAll((nodes) => nodes.map((node) => node.dataset.evaluationGroup)), ["response-opportunity", "task-settlement", "answer-quality"]);
      await page.evaluate(() => window.__evaluation.rerender());
      assert.equal((await snapshot()).calls.length, 0);
      assert.equal((await snapshot()).projection.verdicts.taskSettlementCorrect, undefined);
      assert.equal(await page.getByText("Explain the original project.", { exact: true }).count(), 1);
    });
    await t.test("core callbacks each emit one correct V2 fact, without implicit opportunity or identity loss", async () => {
      await group("answer-quality").getByRole("button", { name: "Useful", exact: true }).click();
      assert.deepEqual(await lastFact(), { kind: "answer-quality", outcome: "useful", failureReasons: [], expectedContextTurnIds: [] });
      assert.equal((await snapshot()).calls.length, 1);
      await group("response-opportunity").getByRole("button", { name: "Buffer", exact: true }).click();
      assert.deepEqual(await lastFact(), { kind: "expected-runtime-action", expectedAction: "buffer" });
      await group("task-settlement").getByRole("button", { name: "Correct", exact: true }).click();
      const fact = await lastFact();
      assert.equal(fact.kind, "expected-task-settlement");
      assert.equal(fact.expectedParentAction, "preserve");
      assert.equal(fact.expectedParentId, "parent-167");
      assert.equal(fact.expectedBranchId, "parent-167");
      assert.equal(fact.expectedContextOwnerId, "parent-167");
      assert.equal((await snapshot()).calls.length, 3);
      await group("task-settlement").getByRole("button", { name: "Fix", exact: true }).click();
      await choose(group("task-settlement"), "Expected relation", "new-parent");
      await group("task-settlement").getByRole("button", { name: "Save settlement", exact: true }).click();
      assert.equal((await lastFact()).expectedParentAction, "preserve");
      await group("task-settlement").getByRole("button", { name: "Fix", exact: true }).click();
      await choose(group("task-settlement"), "Expected parent action", "retype");
      await choose(group("task-settlement"), "Expected relation", "new-parent");
      await group("task-settlement").getByRole("button", { name: "Save settlement", exact: true }).click();
      assert.equal((await lastFact()).expectedParentAction, "retype");
    });
    await t.test("Primary Ask only records an actual text correction even with specialist flags", async () => {
      const before = (await snapshot()).calls.length;
      await group("response-opportunity").getByRole("button", { name: "Correct primary ask", exact: true }).click();
      const save = group("response-opportunity").getByRole("button", { name: "Save", exact: true });
      assert.equal(await save.isDisabled(), true);
      await page.getByPlaceholder("Correct primary ask", { exact: true }).fill("   ");
      assert.equal(await save.isDisabled(), true);
      assert.equal((await snapshot()).calls.length, before);
      await page.getByPlaceholder("Correct primary ask", { exact: true }).fill("Explain the reliability tradeoff.");
      await save.click();
      assert.deepEqual(await lastFact(), { kind: "primary-ask-correction", correctedPrimaryAsk: "Explain the reliability tradeoff." });
      await page.getByText("Expert audit", { exact: true }).click();
      assert.equal(await group("metadata").getByRole("button", { name: "Correct", exact: true }).isDisabled(), true);
      for (const title of ["Clarifying options", "Personal status policy", "Runtime type adjudication labels", "Answer sufficiency", "Task quality", "Answer verdict"]) {
        assert.equal(await page.getByText(title, { exact: true }).count(), 0, title);
      }
    });
    await t.test("Context, Artifact, Project and Metadata retain specific existing fact controls", async () => {
      await group("context").getByRole("button", { name: "Child", exact: true }).click();
      assert.deepEqual(await lastFact(), { kind: "expected-context-read-scope", expectedScope: "active-child-read" });
      await group("artifact-intent").getByRole("button", { name: "Whiteboard", exact: true }).click();
      assert.deepEqual(await lastFact(), { kind: "expected-artifact-intent", expectedIntent: "revise-whiteboard" });
      await group("project").getByRole("button", { name: "Fix", exact: true }).click();
      await page.getByPlaceholder("Project id or name").fill("Project corrected");
      await choose(group("project"), "Expected fact support", "weak-anchor");
      await choose(group("project"), "Expected child/resume", "child-attached");
      await group("project").getByRole("button", { name: "Present", exact: true }).click();
      await group("project").getByRole("button", { name: "Save trajectory", exact: true }).click();
      assert.deepEqual(await lastFact(), { kind: "expected-project-trajectory", expectedProjectName: "Project corrected", expectedPhase: undefined, expectedFactAnchorState: "weak-anchor", expectedChildContinuity: "child-attached", unsupportedFirstPersonClaim: true });
      await group("metadata").getByRole("button", { name: "Fix", exact: true }).click();
      await page.getByPlaceholder("Source company truth (blank = none)").fill("Amazon");
      await page.getByPlaceholder("Expected effective company (blank = none)").fill("Amazon");
      await choose(group("metadata"), "Expected mutation", "Preserve");
      await choose(group("metadata"), "Failure kind", "Brief override");
      await group("metadata").getByRole("button", { name: "Save metadata labels", exact: true }).click();
      assert.deepEqual(await lastFact(), { kind: "expected-meeting-metadata", sourceCompany: "Amazon", expectedEffectiveCompany: "Amazon", expectedMutationDisposition: "preserve", errorKind: "locked-brief-overridden" });
    });
    await t.test("Memory and all artifact quality dimensions execute real V2 callbacks with no legacy writer", async () => {
      await page.getByText("Memory", { exact: true }).click();
      for (const [label, verdict] of [["Relevant", "relevant"], ["Irrelevant", "irrelevant"], ["Forbidden", "forbidden"]]) {
        await choose(page, "Memory relevance: Project reliability", label);
        assert.deepEqual(await lastFact(), { kind: "memory-label", verdict, memoryIds: ["memory-167"] });
      }
      await page.getByLabel("Missing expected memory ID", { exact: true }).fill("memory-missing");
      await page.getByRole("button", { name: "Record missing memory", exact: true }).click();
      assert.deepEqual(await lastFact(), { kind: "memory-label", verdict: "missing", memoryIds: ["memory-missing"] });
      await page.getByText("Artifact quality", { exact: true }).click();
      for (const artifact of ["code", "complexity", "whiteboard"]) {
        for (const [label, verdict] of [["Useful", "useful"], ["Partial", "partial"], ["Wrong", "wrong"], ["Missing", "missing"]]) {
          await choose(page, `Artifact quality: ${artifact}`, label);
          assert.deepEqual(await lastFact(), { kind: "artifact-quality", artifact, verdict });
        }
      }
      assert.deepEqual((await snapshot()).legacy, []);
      await page.getByRole("button", { name: "polluting", exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.__evaluation.preparationCalls), [{ receiptId: "receipt-167", label: "polluting" }]);
    });
    await t.test("failure reasons do not manufacture outcome and failed persistence never claims saved", async () => {
      await group("answer-quality").getByText("Failure reasons", { exact: true }).click();
      const before = (await snapshot()).calls.length;
      await group("answer-quality").getByLabel("Too slow", { exact: true }).check();
      assert.equal((await snapshot()).calls.length, before);
      await group("answer-quality").getByRole("button", { name: "Partial", exact: true }).click();
      assert.deepEqual((await lastFact()).failureReasons, ["too-slow"]);
      await page.evaluate(() => window.__evaluation.persistence({ pending: 2, error: null }));
      assert.match(await page.getByRole("status").textContent(), /Saving human evaluation \(2\)/);
      await page.evaluate(() => window.__evaluation.persistence({ pending: 2, error: "SQLite unavailable" }));
      assert.match(await page.getByRole("alert").textContent(), /not saved.*SQLite unavailable/);
      assert.equal(await page.getByRole("status").count(), 0);
      await page.getByRole("button", { name: "Retry save", exact: true }).click();
      assert.equal((await snapshot()).retries, 1);
      assert.equal((await snapshot()).calls.length, before + 1);
      await page.evaluate(() => { window.__evaluation.commit(); window.__evaluation.persistence({ pending: 0, error: null }); });
      await page.getByRole("alert").waitFor({ state: "detached" });
      assert.equal((await snapshot()).projection.activeFacts["answer-quality"].fact.outcome, "partial");
    });
    await t.test("desktop and mobile rendering fit; changing attempt discards unsent correction draft", async () => {
      for (const width of [1100, 375]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: `/tmp/task-167-evaluation-${width}.png`, fullPage: true });
      }
      await group("response-opportunity").getByRole("button", { name: "Correct primary ask", exact: true }).click();
      await page.getByPlaceholder("Correct primary ask", { exact: true }).fill("Unsent old attempt correction");
      const before = (await snapshot()).calls.length;
      await page.evaluate(() => window.__evaluation.newAttempt());
      await page.getByText("Human evaluation", { exact: true }).click();
      assert.equal(await page.getByPlaceholder("Correct primary ask", { exact: true }).count(), 0);
      assert.equal((await snapshot()).calls.length, before);
      assert.deepEqual((await snapshot()).legacy, []);
    });
    await t.test("A1: recorded HNSW is visibly Advise-only none/preserve; drafts and confirmed facts survive refresh", async () => {
      await page.evaluate(() => window.__evaluation.loadTrace(structuredClone(window.__evaluation.hnsw)));
      await page.getByText("Human evaluation", { exact: true }).click();
      assert.match(await group("task-settlement").textContent(), /settlement: N\/A\s*\/\s*preserve/);
      assert.match(await page.locator("[data-evaluation-advise-only]").textContent(), /Advise-only: canonical-topology-incompatible/);
      assert.equal((await snapshot()).calls.length, 0);
      for (const width of [1100, 375]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: `/tmp/jarvis-a1-tests/advise-only-${width}.png`, fullPage: true });
      }
      await group("task-settlement").getByRole("button", { name: "Correct", exact: true }).click();
      assert.equal((await lastFact()).expectedRelation, "none");
      assert.equal((await lastFact()).expectedParentAction, "preserve");
      await page.evaluate(() => window.__evaluation.commit());
      await page.waitForFunction(() => {
        const fact = window.__evaluation.projection.activeFacts["expected-task-settlement"]?.fact;
        return fact?.expectedRelation === "none" && fact.expectedParentAction === "preserve";
      });
      assert.equal((await snapshot()).projection.verdicts.taskSettlementCorrect, true);
      await group("task-settlement").getByRole("button", { name: "Fix", exact: true }).click();
      await choose(group("task-settlement"), "Expected relation", "child-probe");
      await choose(group("task-settlement"), "Expected parent action", "attach-child");
      await page.evaluate(() => window.__evaluation.updateTrace({ ...window.__evaluation.hnsw.metadata,
        settledExecutionPlanRelation: "new-parent", settledExecutionPlanTaskMutationCommand: "create-parent" }));
      await group("task-settlement").getByRole("button", { name: "Save settlement", exact: true }).click();
      assert.equal((await lastFact()).expectedRelation, "child-probe");
      assert.equal((await lastFact()).expectedParentAction, "attach-child");
      await page.evaluate(() => window.__evaluation.commit());
      assert.equal((await snapshot()).projection.activeFacts["expected-task-settlement"].fact.expectedRelation, "child-probe");
      await page.evaluate(() => window.__evaluation.newAttempt());
      await page.getByText("Human evaluation", { exact: true }).click();
      await group("answer-quality").getByRole("button", { name: "Useful", exact: true }).click();
      assert.equal((await snapshot()).calls.at(-1).subject.attemptId, "attempt-168");
    });
    await t.test("A1: existing human child-probe expectation stays unchanged while Observed becomes none/preserve", async () => {
      await page.evaluate(() => { window.__evaluation.loadTrace(structuredClone(window.__evaluation.hnsw)); window.__evaluation.loadHnswFacts(); });
      await page.getByText("Human evaluation", { exact: true }).click();
      assert.match(await group("task-settlement").textContent(), /expected: field-knowledge \/ child-probe \/ attach-child/);
      assert.equal((await snapshot()).calls.length, 0);
      await group("task-settlement").getByRole("button", { name: "Fix", exact: true }).click();
      await page.evaluate(() => window.__evaluation.updateTrace({ ...window.__evaluation.hnsw.metadata, taskRelationSplitCanonicalDisposition: "timeout" }));
      await group("task-settlement").getByRole("button", { name: "Save settlement", exact: true }).click();
      assert.equal((await lastFact()).expectedRelation, "child-probe");
      assert.equal((await lastFact()).expectedParentAction, "attach-child");
    });
    await t.test("A1: real UI distinguishes final fallback, no-parent, artifact-only, receipt and missing evidence", async () => {
      const base = await page.evaluate(() => window.__evaluation.hnsw);
      const noParent = { ...base.metadata };
      for (const key of Object.keys(noParent)) {
        if (/Parent|Child/.test(key) && !/ParentMutation|ParentScope/.test(key)) delete noParent[key];
      }
      const cases = [
        ["ordinary-followup", { ...base.metadata, settledExecutionPlanRelation: "followup-parent", settledExecutionPlanContextReadScope: "active-parent-read", settledExecutionPlanRelationApplicable: true }, "followup-parent", "preserve", false],
        ["first-parent", { ...base.metadata, settledExecutionPlanRelation: "new-parent", settledExecutionPlanTaskMutationCommand: "create-parent" }, "new-parent", "create", false],
        ["no-parent", { ...noParent, taskRelationOrderedResolutionReason: "no-parent-current-question" }, "N/A", "none", true],
        ["fallback", { ...base.metadata, currentQuestionSettlementRelation: "unknown", taskRelationSplitCanonicalDisposition: "timeout" }, "N/A", "preserve", true, "error"],
        ["receipt", { ...base.metadata, sourceTransitionRuntimeKind: "replace-parent", sourceTransitionDurableAuthorized: true, sourceTransitionDurableMutationApplied: true,
          sourceTransitionParentBeforeId: "p", sourceTransitionParentAfterId: "p", sourceTransitionParentBeforeType: "coding", sourceTransitionParentAfterType: "field-knowledge" }, "N/A", "retype", false],
        ["missing", { effectiveAdvisorCurrentOnly: true, currentQuestionSettlementRelation: "unknown", activeMeetingParentId: "p" }, "N/A", "ERROR: unresolved action", false],
        ["cancelled", { effectiveAdvisorCurrentOnly: true, currentQuestionSettlementRelation: "unknown", activeMeetingParentId: "p" }, "N/A", "N/A", false, "cancelled"],
      ];
      for (const [id, metadata, relation, action, adviseOnly, status = "success"] of cases) {
        await page.evaluate(trace => window.__evaluation.loadTrace(trace), { ...base, id, metadata, status });
        await page.getByText("Human evaluation", { exact: true }).click();
        assert.ok((await group("task-settlement").textContent()).includes(`settlement: ${relation} / ${action}`), id);
        assert.equal(await page.locator("[data-evaluation-advise-only]").count(), adviseOnly ? 1 : 0, id);
        assert.equal((await snapshot()).calls.length, 0, id);
      }
    });
    await t.test("MC8 real merge receipt enables Correct/Save without override; menu-only and stale receipts stay guarded", async () => {
      const production = await manualCorrectionReceiptFixture();
      const { trace: merged } = production.committed("merge-recent-parent");
      for (const status of ["success", "error"]) {
        await page.evaluate(trace => window.__evaluation.loadTrace(trace), { ...merged, id: "merge-" + status, status });
        await page.getByText("Human evaluation", { exact: true }).click();
        assert.match(await group("task-settlement").textContent(), /settlement: followup-parent\s*\/\s*resume/);
        assert.equal((await snapshot()).projection.observed.manualCorrectionEvidence.authority, "manual-correction-durable-receipt");
        await group("task-settlement").getByRole("button", { name: "Correct", exact: true }).click();
        assert.equal((await lastFact()).expectedParentAction, "resume");
        assert.equal((await lastFact()).expectedParentId, "A");
        await group("task-settlement").getByRole("button", { name: "Fix", exact: true }).click();
        await choose(group("task-settlement"), "Expected type", "AI/ML design");
        await choose(group("task-settlement"), "Expected relation", "followup-parent");
        await choose(group("task-settlement"), "Expected parent action", "resume");
        assert.equal(await group("task-settlement").getByRole("button", { name: "Expert override", exact: true }).count(), 0);
        const save = group("task-settlement").getByRole("button", { name: "Save settlement", exact: true });
        assert.equal(await save.isDisabled(), false);
        await save.click();
        assert.equal((await snapshot()).calls.length, 2);
        assert.equal((await lastFact()).expectedRelation, "followup-parent");
        assert.equal((await lastFact()).expectedParentAction, "resume");
      }
      for (const [id, patch] of [
        ["menu-only", { manualCorrectionIntentReceipt: undefined }],
        ["not-committed", { correctionAtomicCommitAuthorized: false }],
        ["foreign-plan", { taskLifecycleExecutionPlanId: "foreign-plan" }],
      ]) {
        await page.evaluate(trace => window.__evaluation.loadTrace(trace), { ...merged, id,
          metadata: { ...merged.metadata, ...patch } });
        await page.getByText("Human evaluation", { exact: true }).click();
        assert.equal((await snapshot()).projection.observed.manualCorrectionEvidence, undefined);
        await group("task-settlement").getByRole("button", { name: "Fix", exact: true }).click();
        await choose(group("task-settlement"), "Expected type", "AI/ML design");
        await choose(group("task-settlement"), "Expected relation", "followup-parent");
        await choose(group("task-settlement"), "Expected parent action", "resume");
        await group("task-settlement").getByRole("button", { name: "Expert override", exact: true }).waitFor();
        assert.equal(await group("task-settlement").getByRole("button", { name: "Save settlement", exact: true }).isDisabled(), true);
        assert.equal((await snapshot()).calls.length, 0, id);
      }
    });
    await t.test("evaluating A never pins the production wrapper to A when B arrives", async () => {
      await page.evaluate(() => window.__evaluation.showAttemptWrapper());
      await page.getByText("trace: attempt-A", { exact: true }).waitFor();
      await page.getByText("Human evaluation", { exact: true }).click();
      await group("answer-quality").getByRole("button", { name: "Useful", exact: true }).click();
      assert.equal(await page.evaluate(() => window.__attempt.calls.at(-1).traceId), "attempt-A");
      // Publishing a new attempt does not blur the previously clicked control first.
      await page.evaluate(() => window.__attempt.publish("B"));
      await page.getByText("trace: attempt-B", { exact: true }).waitFor();
      await page.getByText("Human evaluation", { exact: true }).click();
      await group("answer-quality").getByRole("button", { name: "Useful", exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.__attempt.calls.map(x => x.traceId)), ["attempt-A", "attempt-B"]);
      await page.evaluate(() => window.__attempt.finishSave(0));
      await page.getByText("trace: attempt-B", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__attempt.saved[0].traceId), "attempt-A", "late save must retain its original subject");
    });
    await t.test("an actual Advise pin keeps A, and unlocking follows B without a second evaluation lock", async () => {
      await page.evaluate(() => window.__attempt.reset());
      await page.getByText("trace: attempt-A", { exact: true }).waitFor();
      await page.evaluate(() => window.__attempt.pin());
      await page.getByText("Human evaluation", { exact: true }).click();
      await group("answer-quality").getByRole("button", { name: "Useful", exact: true }).click();
      await page.evaluate(() => window.__attempt.publish("B"));
      await page.getByText("trace: attempt-A", { exact: true }).waitFor();
      assert.equal(await page.getByText("trace: attempt-B", { exact: true }).count(), 0);
      await page.evaluate(() => window.__attempt.unlock());
      await page.getByText("trace: attempt-B", { exact: true }).waitFor();
    });
    await t.test("B survives historical A regeneration/enhancement through unlock, evaluation and delayed save", async () => {
      await page.evaluate(() => window.__attempt.reset());
      await page.getByText("trace: attempt-A", { exact: true }).waitFor();
      await page.evaluate(() => window.__attempt.pin());
      await page.evaluate(() => window.__attempt.publish("B"));
      await page.evaluate(() => window.__attempt.amendSelected("A-regenerate"));
      await page.getByText("trace: attempt-A-regenerate", { exact: true }).waitFor();
      await page.evaluate(() => window.__attempt.amendSelected("A-enhance"));
      await page.getByText("trace: attempt-A-enhance", { exact: true }).waitFor();
      await page.getByText("Human evaluation", { exact: true }).click();
      await group("answer-quality").getByRole("button", { name: "Useful", exact: true }).click();
      await page.evaluate(() => window.__attempt.unlock());
      await page.getByText("trace: attempt-B", { exact: true }).waitFor();
      await page.getByText("Human evaluation", { exact: true }).click();
      await group("answer-quality").getByRole("button", { name: "Useful", exact: true }).click();
      const calls = await page.evaluate(() => window.__attempt.calls);
      assert.deepEqual(calls.map(call => call.traceId), ["attempt-A-enhance", "attempt-B"]);
      assert.equal(calls[0].options.evaluationTarget.logicalQuestionUnitId, "unit-A");
      assert.equal(calls[1].options.evaluationTarget.logicalQuestionUnitId, "unit-B");
      assert.equal(calls[1].options.evaluationTarget.attemptId, "attempt-B");
      await page.evaluate(() => window.__attempt.publish("C", "error", false));
      await page.getByText("trace: attempt-C", { exact: true }).waitFor();
      await page.evaluate(() => window.__attempt.finishSave(1));
      assert.equal(await page.evaluate(() => window.__attempt.saved[0].options.evaluationTarget.attemptId), "attempt-B");
    });
    await t.test("selection observation quiesces across recorder rerenders and only records a shown changed target", async () => {
      await page.evaluate(() => window.__attempt.reset());
      await page.getByText("trace: attempt-A", { exact: true }).waitFor();
      const count = await page.evaluate(() => window.__attempt.observations.length);
      await page.evaluate(() => { for (let i = 0; i < 20; i++) window.__attempt.rerender(); });
      assert.equal(await page.evaluate(() => window.__attempt.observations.length), count);
      await page.evaluate(() => window.__attempt.showPanel(false));
      await page.evaluate(() => window.__attempt.publish("B"));
      assert.equal(await page.evaluate(() => window.__attempt.observations.length), count);
      await page.evaluate(() => window.__attempt.showPanel(true));
      await page.getByText("trace: attempt-B", { exact: true }).waitFor();
      const observations = await page.evaluate(() => window.__attempt.observations);
      assert.equal(observations.length, count + 1);
      assert.equal(observations.at(-1).currentQuestion.logicalQuestionUnitId, "unit-B");
      assert.equal(observations.at(-1).attempt.attemptId, "attempt-B");
      assert.equal(JSON.stringify(observations).includes("Response B"), false);
      await page.evaluate(() => window.__attempt.rerender());
      assert.equal(await page.evaluate(() => window.__attempt.observations.length), count + 1);
    });
    await t.test("new attempt clears unsent drafts and failed/no-answer attempts remain evaluable", async () => {
      await page.evaluate(() => window.__attempt.reset());
      await page.getByText("trace: attempt-A", { exact: true }).waitFor();
      await page.getByText("Human evaluation", { exact: true }).click();
      await group("response-opportunity").getByRole("button", { name: "Correct primary ask", exact: true }).click();
      await page.getByPlaceholder("Correct primary ask", { exact: true }).fill("Unsent A draft");
      await page.evaluate(() => window.__attempt.publish("C", "error", false));
      await page.getByText("trace: attempt-C", { exact: true }).waitFor();
      await page.getByText("Human evaluation", { exact: true }).click();
      assert.equal(await page.getByPlaceholder("Correct primary ask", { exact: true }).count(), 0);
      assert.equal(await page.evaluate(() => window.__attempt.calls.length), 0);
      await group("answer-quality").getByRole("button", { name: "No answer", exact: true }).click();
      assert.equal(await page.evaluate(() => window.__attempt.calls.at(-1).traceId), "attempt-C");
      await page.evaluate(() => window.__attempt.publish("D", "running", false));
      await page.getByText("trace: attempt-D", { exact: true }).waitFor();
      await page.getByText("Evaluation is available after the answer finishes.", { exact: true }).waitFor();
      await page.evaluate(() => window.__attempt.publish("D"));
      await page.getByText("Human evaluation", { exact: true }).click();
      await group("answer-quality").getByRole("button", { name: "Useful", exact: true }).click();
      assert.equal(await page.evaluate(() => window.__attempt.calls.at(-1).traceId), "attempt-D");
      await page.setViewportSize({ width: 375, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: "/tmp/evaluation-target-follow-375.png", fullPage: true });
    });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
