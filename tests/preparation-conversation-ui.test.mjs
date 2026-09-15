import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";

const root = process.cwd();
const backend = "./tests/fixtures/preparation-conversation-ui-backend.mjs";
let playwright;
try { playwright = createRequire(import.meta.url)(process.env.JARVIS_PLAYWRIGHT_MODULE ?? "playwright"); } catch {}

test("PREP-U1..5: production preparation viewport and cancellation with controlled I/O", {
  skip: !playwright && "Set JARVIS_PLAYWRIGHT_MODULE to run the real React browser test",
}, async (t) => {
  const mocks = {
    "@/components": ['export * from "./src/components/Markdown";', 'export * from "./src/components/Header";', ...["badge", "button", "dialog", "input", "label", "select", "textarea"].map((file) => `export * from './src/components/ui/${file}';`)].join("\n"),
    "@/contexts": `import { context } from '${backend}'; export const useApp = () => context;`,
    "@/lib/preparation": [`export * from '${backend}';`, ...["interview-types", "interview-process-service", "round-scheduling", "conversation-execution"].map((file) => `export * from './src/lib/preparation/${file}';`)].join("\n"),
    "../../lib/preparation/app-service": `export * from '${backend}';`,
    "./components/MaterialPanel": "export const MaterialPanel = () => <div>Material fixture boundary</div>;",
    "./components/ReviewedPreparationPanel": "export const ReviewedPreparationPanel = () => <div>Reviewed fixture boundary</div>;",
    "@tauri-apps/api/event": "export const listen = async () => () => {}; export const emit = async () => {};",
  };
  const fixture = `
    import React, { useEffect } from 'react';
    import { createRoot } from 'react-dom/client';
    import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
    import InterviewPreparation, { ProcessWorkspace } from './src/pages/interview-preparation';
    import { usePreparationData } from './src/pages/interview-preparation/usePreparationData';
    import { context, interviewPreparationConversationExecutionService as service } from '${backend}';
    context.allAiProviders.push(
      { id: 'main-advisor', curl: '{{TEXT}} {{API_KEY}} {{MODEL}}' },
      { id: 'coding-override', curl: '{{TEXT}} {{API_KEY}} {{MODEL}}' });
    context.selectedAIProvider = { provider: 'main-advisor', variables: { API_KEY: 'main-fixture-key', MODEL: 'main-fixture-model' } };
    localStorage.setItem('meeting_assistant_settings', JSON.stringify({
      codingModel: { provider: 'coding-override', variables: { API_KEY: 'coding-fixture-key', MODEL: 'coding-fixture-model' } }
    }));
    context.selectedPreparationAIProvider.variables = { API_KEY: 'writer-fixture-key', MODEL: 'writer-fixture-model' };
    window.__prep.context = context;
    window.__prep.executionInputs = [];
    const execute = service.execute.bind(service);
    service.execute = (input) => {
      window.__prep.executionInputs.push(structuredClone({ route: input.route, queryRoute: input.queryRoute }));
      return execute(input);
    };
    const noop = () => {};
    function NormalWorkspace() {
      const data = usePreparationData('process-1');
      useEffect(() => { if (data.sessions.data && !data.selectedSessionId) data.selectConversation('conversation-1'); }, [data.sessions.data, data.selectedSessionId]);
      if (!data.detail.data) return null;
      return <ProcessWorkspace data={data} detail={data.detail.data} materials={data.materials.data ?? []}
        currentContext={{revision:0,updatedAt:0}} conversationExpanded={false} onConversationDetailChange={noop}
        onError={data.onError} onNotice={data.onNotice} onMaterialsChanged={data.refreshMaterials}
        onAddRound={noop} onEditProcess={noop} onEditRound={noop} onDeleteRound={noop} onSetActiveRound={noop}
        onSetCurrentRound={noop} onArchive={noop} onReopen={noop} onDelete={noop}/>;
    }
    function App() {
      const navigate = useNavigate(); window.__prep.navigate = navigate;
      return <main style={{height:'100dvh',display:'flex',flexDirection:'column',padding:'0 24px',minWidth:0}}>
        <Routes><Route path='/interview-preparation/:processId' element={<InterviewPreparation/>}/>
        <Route path='/normal' element={<NormalWorkspace/>}/><Route path='/settings' element={<div>Settings fixture boundary</div>}/></Routes>
      </main>;
    }
    createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/interview-preparation/process-1']}><App/></MemoryRouter>);
  `;
  const bundle = await build({ stdin: { contents: fixture, loader: "tsx", resolveDir: root }, bundle: true, write: false,
    format: "iife", platform: "browser", jsx: "automatic", loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"development"', "import.meta.env.DEV": "false" },
    plugins: [{ name: "preparation-controlled-io", setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: "fixture" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ contents: mocks[args.path], loader: "tsx", resolveDir: root }));
      builder.onLoad({ filter: /interview-preparation\/index\.tsx$/ }, (args) => ({ contents: readFileSync(args.path, "utf8") + "\nexport { ProcessWorkspace };", loader: "tsx", resolveDir: path.dirname(args.path) }));
    } }],
  });
  const css = await compile(readFileSync("src/global.css", "utf8"), { base: path.join(root, "src"), onDependency() {} });
  const scanner = new Scanner({ sources: ["src/pages/interview-preparation/**/*.tsx", "src/components/ui/*.tsx", "src/components/Header/*.tsx"].map((pattern) => ({ base: root, pattern, negated: false })) });
  const browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.JARVIS_CHROMIUM_EXECUTABLE });
  const evidence = mkdtempSync(path.join(tmpdir(), "prep-ui-"));
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
    await page.goto("https://preparation.fixture/");
    await page.addStyleTag({ content: css.build(scanner.scan()) });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const panel = page.locator('[data-preparation-conversation]');
    const messages = page.locator('[data-preparation-messages]');
    const composer = page.locator('[data-preparation-composer]');
    const cancel = panel.getByTitle('Cancel response', { exact: true });
    const openConversation = async () => {
      await panel.getByText('Preparation fixture', { exact: true }).click();
      await messages.waitFor();
    };
    const start = async () => {
      const before = await page.evaluate(() => window.__prep.requests.length);
      await panel.locator('textarea').fill('Explain this tradeoff.');
      await panel.getByTitle('Send', { exact: true }).click();
      await page.waitForFunction((count) => window.__prep.requests.length === count + 1, before);
      await cancel.waitFor();
    };
    const geometry = async () => page.evaluate(() => {
      const box = (selector) => { const node = document.querySelector(selector); const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom, scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }; };
      return { messages: box('[data-preparation-messages]'), composer: box('[data-preparation-composer]'), panel: box('[data-preparation-conversation]'), bodyTop: document.scrollingElement.scrollTop, bodyWidth: document.scrollingElement.scrollWidth, width: innerWidth, height: innerHeight };
    });
    const assertViewport = async () => {
      const g = await geometry();
      assert.ok(g.messages.height >= 40, JSON.stringify(g));
      assert.ok(g.messages.bottom <= g.composer.y + 1, JSON.stringify(g));
      assert.ok(g.composer.bottom <= g.panel.bottom + 1 && g.panel.bottom <= g.height + 1, JSON.stringify(g));
      assert.equal(g.bodyTop, 0);
      assert.ok(g.bodyWidth <= g.width + 1, JSON.stringify(g));
      return g;
    };
    const finishCancelled = async () => {
      await cancel.click();
      assert.equal(await page.evaluate(() => window.__prep.requests.at(-1).signal.aborted), true);
      const before = await page.evaluate(() => window.__prep.commits.length);
      await page.evaluate(() => { window.__prep.push('LATE OUTPUT MUST NOT COMMIT'); window.__prep.finish(); });
      await page.waitForFunction(() => window.__prep.service.getSnapshot()?.status === 'cancelled');
      assert.equal(await page.evaluate(() => window.__prep.commits.length), before);
      assert.equal(await panel.getByText('LATE OUTPUT MUST NOT COMMIT', { exact: true }).count(), 0);
    };

    await t.test('U1/U2/U4: streaming stays local, scrollback survives chunks, Cancel aborts original operation', async () => {
      await openConversation();
      await start();
      const before = await assertViewport();
      await messages.evaluate((node) => {
        window.__prep.scrollEvents = [];
        node.addEventListener('scroll', () => window.__prep.scrollEvents.push({ top: node.scrollTop, height: node.clientHeight, content: node.scrollHeight }));
      });
      const buttonBefore = await cancel.boundingBox();
      for (let i = 0; i < 8; i++) {
        await page.evaluate((i) => window.__prep.push(('Streaming chunk ' + i + ' with long output.\n\n').repeat(60)), i);
        await page.waitForFunction((i) => window.__prep.service.getSnapshot().partial.includes('Streaming chunk ' + i), i);
        const after = await assertViewport();
        assert.equal(after.composer.y, before.composer.y);
        assert.deepEqual(await cancel.boundingBox(), buttonBefore);
        await page.waitForFunction(() => { const e = document.querySelector('[data-preparation-messages]'); return e.scrollHeight - e.scrollTop - e.clientHeight <= 2; }).catch(async (error) => {
          t.diagnostic(JSON.stringify({ chunk: i, geometry: await geometry(), scrolls: await page.evaluate(() => window.__prep.scrollEvents) }));
          throw error;
        });
      }
      await messages.hover();
      await page.mouse.wheel(0, -600);
      await page.waitForFunction(() => { const e = document.querySelector('[data-preparation-messages]'); return e.scrollHeight - e.scrollTop - e.clientHeight > 100; });
      const scrollback = (await geometry()).messages.scrollTop;
      await page.evaluate(() => window.__prep.push('New chunk while reading history.\n\n'.repeat(80)));
      await panel.getByText('New chunk while reading history.', { exact: true }).first().waitFor({ state: 'attached' });
      assert.equal((await geometry()).messages.scrollTop, scrollback);
      await page.mouse.wheel(0, 1000000);
      await page.waitForFunction(() => { const e = document.querySelector('[data-preparation-messages]'); return e.scrollHeight - e.scrollTop - e.clientHeight <= 2; });
      await page.evaluate(() => window.__prep.push('Following the bottom again.\n\n'.repeat(40)));
      await panel.getByText('Following the bottom again.', { exact: true }).first().waitFor({ state: 'attached' });
      await page.waitForFunction(() => { const e = document.querySelector('[data-preparation-messages]'); return e.scrollHeight - e.scrollTop - e.clientHeight <= 2; });
      await page.mouse.wheel(0, -600);
      await page.waitForFunction(() => { const e = document.querySelector('[data-preparation-messages]'); return e.scrollHeight - e.scrollTop - e.clientHeight > 100; });
      await page.screenshot({ path: path.join(evidence, 'expanded-streaming.png') });
      await finishCancelled();
      assert.deepEqual(await page.evaluate(() => window.__prep.cancellations), ['operation-2']);
    });

    await t.test('U3: normal and expanded surfaces bound short/narrow viewports, long input, editing and file recovery', async () => {
      for (const mode of ['expanded', 'normal']) {
        if (mode === 'normal') {
          await page.evaluate(() => window.__prep.navigate('/normal'));
          await messages.waitFor();
        }
        for (const size of [{ width: 1100, height: 800 }, { width: 540, height: 500 }, { width: 375, height: 600 }, { width: 375, height: 400 }]) {
          await page.setViewportSize(size);
          await panel.locator('textarea').fill('Long input line\n'.repeat(70));
          await assertViewport();
          await panel.getByTitle('Edit this message', { exact: true }).first().click();
          assert.match(await panel.locator('textarea').inputValue(), /Explain the tradeoffs/);
          await assertViewport();
          await panel.getByTitle('Cancel edit', { exact: true }).click();
          await panel.getByTitle('Select files for recovery', { exact: true }).click();
          const dialog = page.getByRole('dialog');
          await dialog.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
          const dialogBox = await dialog.boundingBox();
          assert.ok(dialogBox.y >= 0 && dialogBox.y + dialogBox.height <= size.height, JSON.stringify(dialogBox));
          for (let i = 0; i < 6; i++) await page.getByRole('dialog').getByText(new RegExp('^Material ' + i + ' ')).click();
          await page.getByRole('button', { name: 'Attach 6', exact: true }).click();
          await dialog.waitFor({ state: 'hidden' });
          await panel.getByText('File recovery', { exact: true }).waitFor();
          await assertViewport();
          const recoveryControl = await panel.getByTitle('Remove selected files', { exact: true }).evaluate((button) => {
            const control = button.getBoundingClientRect();
            const viewport = button.parentElement.parentElement.getBoundingClientRect();
            return { top: control.top, bottom: control.bottom, viewportTop: viewport.top, viewportBottom: viewport.bottom };
          });
          assert.ok(recoveryControl.top >= recoveryControl.viewportTop && recoveryControl.bottom <= recoveryControl.viewportBottom, JSON.stringify(recoveryControl));
          const field = await panel.locator('textarea').boundingBox();
          const send = await panel.getByTitle('Send', { exact: true }).boundingBox();
          assert.ok(field.y + field.height <= size.height && send.y + send.height <= size.height);
          await page.screenshot({ path: path.join(evidence, `${mode}-${size.width}x${size.height}.png`) });
          await panel.getByTitle('Remove selected files', { exact: true }).click();
          await start();
          const before = await cancel.boundingBox();
          await page.evaluate(() => window.__prep.push('Bounded stream.\n\n'.repeat(100)));
          await panel.getByText('Bounded stream.', { exact: true }).first().waitFor({ state: 'attached' });
          await assertViewport();
          assert.deepEqual(await cancel.boundingBox(), before);
          await finishCancelled();
        }
      }
    });

    await t.test('U5: Settings round trip keeps one running request and per-answer sources; shutdown cancellation waits for late output', async () => {
      await page.setViewportSize({ width: 1100, height: 800 });
      await page.evaluate(() => window.__prep.navigate('/interview-preparation/process-1'));
      await openConversation();
      await start();
      const requestCount = await page.evaluate(() => window.__prep.requests.length);
      await page.evaluate(() => window.__prep.navigate('/settings'));
      await page.getByText('Settings fixture boundary').waitFor();
      await page.evaluate(() => window.__prep.push('Navigation preserves generation.'));
      await page.evaluate(() => window.__prep.navigate('/interview-preparation/process-1'));
      await openConversation();
      await panel.getByText('Navigation preserves generation.', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__prep.requests.length), requestCount);
      await page.evaluate(() => window.__prep.finish());
      await page.waitForFunction(() => window.__prep.service.getSnapshot()?.status === 'committed');
      const snapshot = await page.evaluate(() => window.__prep.commits.at(-1).contextSnapshot);
      assert.deepEqual(snapshot.sourceRefs.map((source) => source.kind), ['material', 'kmb']);
      assert.equal(await page.evaluate(() => window.__prep.compositions.length), requestCount);
      await start();
      await page.evaluate(() => { window.__prep.shutdownFinished = false; void window.__prep.service.cancelAndWait().then(() => { window.__prep.shutdownFinished = true; }); });
      assert.equal(await page.evaluate(() => window.__prep.requests.at(-1).signal.aborted), true);
      assert.equal(await page.evaluate(() => window.__prep.shutdownFinished), false);
      await page.evaluate(() => { window.__prep.push('LATE QUIT OUTPUT'); window.__prep.finish(); });
      await page.waitForFunction(() => window.__prep.shutdownFinished);
      assert.equal(await page.evaluate(() => window.__prep.commits.length), 1);
    });
    await t.test('PQ-R1/R2: actual Send passes ordinary main Advisor separately from Preparation and Coding override', async () => {
      const inputs = await page.evaluate(() => window.__prep.executionInputs);
      assert.ok(inputs.length > 0);
      for (const input of inputs) {
        assert.equal(input.route.provider.id, 'fixture-model');
        assert.deepEqual(input.route.selectedProvider, { provider: 'fixture-model', variables: { API_KEY: 'writer-fixture-key', MODEL: 'writer-fixture-model' } });
        assert.equal(input.queryRoute.status, 'ready');
        assert.equal(input.queryRoute.provider.id, 'main-advisor');
        assert.deepEqual(input.queryRoute.selectedProvider, { provider: 'main-advisor', variables: { API_KEY: 'main-fixture-key', MODEL: 'main-fixture-model' } });
      }
      // Active rounds in this backend are Coding; changing its override must not alter query routing.
      await page.evaluate(() => {
        localStorage.setItem('meeting_assistant_settings', JSON.stringify({
          codingModel: { provider: 'fixture-model', variables: { MODEL: 'changed-coding-model' } }
        }));
        window.__prep.navigate('/settings');
      });
      await page.getByText('Settings fixture boundary').waitFor();
      await page.evaluate(() => window.__prep.navigate('/interview-preparation/process-1'));
      await openConversation();
      await start();
      assert.deepEqual(await page.evaluate(() => window.__prep.executionInputs.at(-1)), inputs.at(-1));
      await finishCancelled();
    });
    assert.deepEqual(errors, []);
    t.diagnostic(`Headless screenshots: ${evidence}. Settings/native Quit and retrieval I/O are controlled boundaries, not native acceptance.`);
  } finally { await browser.close(); }
});
