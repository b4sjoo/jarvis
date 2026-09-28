import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";

let playwright;
try { playwright = createRequire(import.meta.url)(process.env.JARVIS_PLAYWRIGHT_MODULE ?? "playwright"); } catch {}

test("project choice component: explicit initial choice, reselect, bound retry and stale menu", {
  skip: !playwright && "Set JARVIS_PLAYWRIGHT_MODULE to run controlled browser UI evidence",
}, async () => {
  const root = process.cwd();
  const bundle = await build({ stdin: { loader: "tsx", resolveDir: root, contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { ProjectChoiceControl } from './src/pages/app/components/meeting/project-choice-control';
    const root=createRoot(document.getElementById('root'));
    window.requests=[];
    window.show=(presentation,state)=>root.render(<ProjectChoiceControl presentation={presentation}
      selectionState={state} selectedLabel={state?'Project B':undefined}
      selectionMessage={state?'Project B: '+state:undefined} onSelect={value=>window.requests.push(value)}/>);
  ` }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "only-control-dependencies", setup(builder) {
      builder.onResolve({ filter: /^@\/components$/ }, () => ({ path: "ui", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ loader: "tsx", resolveDir: root,
        contents: 'export * from "./src/components/ui/button"; export * from "./src/components/ui/popover";' }));
    } }],
  });
  const css = await compile(readFileSync("src/global.css", "utf8"), { base: path.join(root, "src"), onDependency() {} });
  const scanner = new Scanner({ sources: [{ base: root, pattern: "src/pages/app/components/meeting/project-choice-control.tsx", negated: false },
    { base: root, pattern: "src/components/ui/*.tsx", negated: false }] });
  const browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.JARVIS_CHROMIUM_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 700 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<div id="root" style="padding:12px"></div>' }));
    await page.goto("https://project-choice.fixture/");
    await page.addStyleTag({ content: css.build(scanner.scan()) });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const target = { sessionId: "s", logicalQuestionUnitId: "A", logicalQuestionRevision: 1 };
    const presentation = { key: "P:binding-0", displayTarget: target, canSelect: true, canReselect: false,
      options: [{ id: "a", label: "Project A", value: "project-a" }, { id: "b", label: "Project B", value: "project-b" }] };
    await page.evaluate(value => window.show(value), presentation);
    await page.getByText("Choose project", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Yes", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Project B", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.requests), [{ key: presentation.key, displayTarget: target,
      option: presentation.options[1], reselect: false }]);
    for (const state of ["pending", "failed", "cancelled", "succeeded"]) {
      await page.evaluate(({ presentation, state }) => window.show(presentation, state), { presentation, state });
      await page.getByRole("status").getByText("Project B: " + state, { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Project B", exact: true }).isDisabled(), state === "pending");
      assert.equal(await page.getByRole("button", { name: "Retry project answer", exact: true }).count(), 0);
    }
    const bound = { ...presentation, key: "P:binding-1", currentProject: { id: "project-a", name: "Project A" }, canSelect: false, canReselect: true };
    await page.evaluate(value => window.show(value), bound);
    await page.getByRole("button", { name: "Change project", exact: true }).click();
    assert.equal(await page.evaluate(() => window.requests.length), 1, "opening edit does not mutate");
    await page.getByRole("button", { name: "Cancel project change", exact: true }).click();
    await page.getByRole("button", { name: "Cancel project change", exact: true }).waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => window.requests.length), 1);
    await page.getByRole("button", { name: "Change project", exact: true }).click();
    await page.getByRole("button", { name: "Project B", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.requests.at(-1)), { key: bound.key, displayTarget: target,
      option: presentation.options[1], reselect: true });
    await page.getByRole("button", { name: "Cancel project change", exact: true }).waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Change project", exact: true }).click();
    await page.evaluate(value => window.show(value), { ...bound, key: "other-parent:binding-1" });
    await page.getByRole("alert").getByText("The project selection changed. Reopen the project menu.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Project B", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Cancel project change", exact: true }).click();
    await page.getByRole("button", { name: "Cancel project change", exact: true }).waitFor({ state: "hidden" });
    await page.evaluate(value => window.show(value), { ...bound, canReselect: false });
    assert.equal(await page.getByRole("button", { name: "Change project", exact: true }).count(), 0);
    await page.evaluate(value => window.show(value), { ...presentation, canSelect: false, options: [] });
    await page.locator("[data-project-choice]").waitFor({ state: "hidden" });
    await page.evaluate(value => window.show(value), { ...presentation, options: [presentation.options[0]] });
    await page.getByRole("button", { name: "Project A", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.requests.length), 2, "one candidate still needs confirmation");
    assert.equal(await page.getByRole("button", { name: "Retry project answer", exact: true }).count(), 0);
    for (const canReselect of [true, false]) {
      const retryPresentation = { ...bound, canReselect, key: "P:binding-retry:" + canReselect,
        displayTarget: { ...target, logicalQuestionRevision: 2 } };
      const before = await page.evaluate(() => window.requests.length);
      await page.evaluate(value => window.show(value, "failed"), retryPresentation);
      const retry = page.getByRole("button", { name: "Retry project answer", exact: true });
      await retry.waitFor();
      assert.equal(await retry.getAttribute("title"), "Retry project answer");
      assert.equal(await page.evaluate(() => window.requests.length), before, "failure never retries automatically");
      await retry.click();
      assert.deepEqual(await page.evaluate(() => window.requests.at(-1)), { key: retryPresentation.key,
        displayTarget: retryPresentation.displayTarget, option: presentation.options[0], reselect: false });
      for (const state of ["pending", "succeeded", "stale"]) {
        await page.evaluate(({ value, state }) => window.show(value, state), { value: retryPresentation, state });
        await retry.waitFor({ state: "hidden" });
      }
      await page.evaluate(value => window.show(value, "failed"), { ...retryPresentation, options: [presentation.options[1]] });
      await page.getByRole("status").getByText("Project B: failed", { exact: true }).waitFor();
      assert.equal(await retry.count(), 0, "no retry when the bound project has no exact candidate option");
      assert.equal(await page.evaluate(() => window.requests.length), before + 1);
    }
    const output = process.env.JARVIS_FOCUS_UI_OUTPUT ?? "/tmp";
    mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, "project-choice-420.png") });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
