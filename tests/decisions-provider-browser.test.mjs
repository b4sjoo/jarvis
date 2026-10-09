import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { loadBrowserTestDependency } from "./helpers/browser-test-dependency.mjs";

const { playwright, skip } = loadBrowserTestDependency();
test("DR205: real AppProvider persists independent masked Decisions credentials across windows", { skip }, async () => {
  const root = process.cwd(), file = name => JSON.stringify(path.join(root, name));
  const mocks = {
    "@/components": `export {Header} from ${file("src/components/Header/index.tsx")};
      export {Input} from ${file("src/components/ui/input.tsx")};export {Button} from ${file("src/components/ui/button.tsx")};`,
    "@/contexts": `export {useApp} from ${file("src/contexts/app.context.tsx")};`,
    "@/lib": `export {safeLocalStorage} from ${file("src/lib/storage/helper.ts")};export const getPlatform=()=>"macos";`,
    "@tauri-apps/api/core": `export const invoke=async()=>undefined;`,
    "@tauri-apps/api/event": `export const listen=async()=>()=>{};`,
    "@tauri-apps/api/window": `export const getCurrentWindow=()=>({label:'dashboard'});`,
    "@tauri-apps/plugin-autostart": `export const enable=async()=>{};export const disable=async()=>{};`,
  };
  const bundle = await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router-dom';
    import {AppProvider} from './src/contexts/app.context.tsx';
    import {DecisionsProvider} from './src/pages/dev/components/DecisionsProvider.tsx';
    import MeetingInputLanguages from './src/pages/audio/components/MeetingInputLanguages.tsx';
    createRoot(document.getElementById('root')).render(<MemoryRouter><AppProvider><DecisionsProvider/><MeetingInputLanguages/></AppProvider></MemoryRouter>);
  ` }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"test"' },
    plugins: [{ name: "native-boundaries", setup(b) {
      b.onResolve({ filter: /.*/ }, args => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: "fixture" } : undefined);
      b.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "tsx", resolveDir: root }));
    } }],
  });
  const browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.JARVIS_CHROMIUM_EXECUTABLE });
  try {
    const context = await browser.newContext();
    let requests=0;const errors=[];
    await context.route("**/*", route=>route.request().url()==="http://decisions-settings.fixture/"
      ?route.fulfill({contentType:"text/html",body:'<div id="root"></div>'})
      :(requests++,route.abort()));
    const page = await context.newPage();page.on("pageerror",e=>errors.push(e.message));
    await page.goto("http://decisions-settings.fixture/");
    const stt={provider:"azure-mai-transcribe",variables:{api_key:"synthetic-azure",endpoint:"fixture.cognitiveservices.azure.com"}};
    await page.evaluate(stt=>{localStorage.clear();localStorage.setItem('auto-configs-enabled','true');localStorage.setItem('autostart_initialized','true');
      localStorage.setItem('curl_selected_stt_provider',JSON.stringify(stt));},stt);
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    assert.equal(await page.getByLabel("English",{exact:true}).isChecked(),true);
    assert.equal(await page.getByLabel("中文",{exact:true}).isChecked(),true);
    await page.getByLabel("中文",{exact:true}).uncheck();
    assert.equal(await page.getByLabel("English",{exact:true}).isDisabled(),true);
    assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('meeting_input_languages'))),["en"]);
    await page.getByLabel("API Key",{exact:true}).fill("synthetic-openai");
    await page.waitForFunction(()=>JSON.parse(localStorage.getItem('curl_selected_decisions_provider')||'null')?.variables?.api_key==='synthetic-openai');
    assert.equal(await page.getByLabel("API Key",{exact:true}).getAttribute("type"),"password");
    assert.equal(await page.getByLabel("Model",{exact:true}).inputValue(),"gpt-6-luna");
    assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('curl_selected_stt_provider'))),stt);
    const second=await context.newPage();second.on("pageerror",e=>errors.push(e.message));
    await second.goto("http://decisions-settings.fixture/");await second.addScriptTag({content:bundle.outputFiles[0].text});
    await second.waitForFunction(()=>document.querySelector('#decisions-api-key')?.value==='synthetic-openai');
    assert.equal(await second.getByLabel("中文",{exact:true}).isChecked(),false);
    await page.getByLabel("中文",{exact:true}).check();
    await second.waitForFunction(()=>[...document.querySelectorAll('input[type=checkbox]')].every(input=>input.checked));
    await page.getByLabel("API Key",{exact:true}).fill("replacement-openai");
    await second.waitForFunction(()=>document.querySelector('#decisions-api-key')?.value==='replacement-openai');
    await second.getByRole("button",{name:"Remove Decisions API key"}).click();
    await page.waitForFunction(()=>document.querySelector('#decisions-api-key')?.value==='');
    // A failed write must not activate an unpersisted provider or language policy.
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      window.__restoreStorage = () => { Storage.prototype.setItem = original; };
      Storage.prototype.setItem = function(key, value) {
        if (["curl_selected_decisions_provider", "meeting_input_languages"].includes(key)) {
          throw new DOMException("synthetic quota failure", "QuotaExceededError");
        }
        return original.call(this, key, value);
      };
    });
    await page.getByLabel("API Key", { exact: true }).fill("unsaved-secret");
    assert.match(await page.getByRole("alert").textContent(), /Decisions settings were not saved: local storage is full/);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('curl_selected_decisions_provider')).variables.api_key), "");
    await page.getByLabel("中文", { exact: true }).click();
    assert.equal(await page.getByLabel("中文", { exact: true }).isChecked(), true);
    assert.ok((await page.getByRole("alert").allTextContents()).some(text => text.includes("Language settings were not saved")));
    await page.evaluate(() => window.__restoreStorage());
    await page.getByLabel("API Key", { exact: true }).fill("saved-after-quota");
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('curl_selected_decisions_provider')).variables.api_key === 'saved-after-quota');
    await second.waitForFunction(() => document.querySelector('#decisions-api-key')?.value === 'saved-after-quota');
    await page.reload();await page.addScriptTag({content:bundle.outputFiles[0].text});
    await page.waitForFunction(() => document.querySelector('#decisions-api-key')?.value === 'saved-after-quota');
    assert.equal(await page.getByRole("alert").count(), 0);
    assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('curl_selected_stt_provider'))),stt);
    assert.equal(requests,0);assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});
