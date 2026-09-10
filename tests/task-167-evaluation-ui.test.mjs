import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";

const root = process.cwd();
const panelFile = path.join(root, "src/pages/app/components/meeting/index.tsx");
const source = readFileSync(panelFile, "utf8");
let playwright;
try { playwright = createRequire(import.meta.url)(process.env.JARVIS_PLAYWRIGHT_MODULE ?? "playwright"); } catch {}

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
    ].join("\n"),
    "@/components": ['export * from "./src/components/Markdown";', ...primitives.map((name) => `export { ${name} } from "./src/components/ui/${name.toLowerCase()}";`)].join("\n"),
  };
  // Only imported bindings outside the evaluation subtree receive inert stubs.
  for (const module of ["@/lib/meeting", "@/components"]) {
    const importBlock = [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g)].find((match) => match[2] === module)?.[1] ?? "";
    const used = new Set(module === "@/components" ? [...primitives, "Markdown"] : ["freezeObservedTaskOwnerIdentityV2", "evaluateTaskSettlementTupleCompatibilityV2", "normalizeCanonicalQuestionType", "projectQuestionTypeObservation", "projectMeetingMetadataEvaluationObservation"]);
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
        contents: readFileSync(args.path, "utf8") + "\nexport { TraceHumanEvaluationPanel };", loader: "tsx", resolveDir: path.dirname(args.path),
      }));
    } }],
  });
  const css = await compile(readFileSync(path.join(root, "src/global.css"), "utf8"), { base: path.join(root, "src"), onDependency() {} });
  const scanner = new Scanner({ sources: [{ base: root, pattern: "src/pages/app/components/meeting/index.tsx", negated: false }, { base: root, pattern: "src/components/ui/*.tsx", negated: false }] });
  const browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.JARVIS_CHROMIUM_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
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
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
