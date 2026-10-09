import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { loadBrowserTestDependency } from "./helpers/browser-test-dependency.mjs";

const { playwright, skip } = loadBrowserTestDependency();
test("SI206: native autostart readback owns the real settings UI and persisted mirror", { skip }, async () => {
  const root = process.cwd(), file = name => JSON.stringify(path.join(root, name));
  const mocks = {
    "@/components": `export {Header} from ${file("src/components/Header/index.tsx")};
      export {Switch} from ${file("src/components/ui/switch.tsx")};export {Label} from ${file("src/components/ui/label.tsx")};`,
    "@/contexts": `export {useApp} from ${file("src/contexts/app.context.tsx")};`,
    "@/lib": `export {safeLocalStorage} from ${file("src/lib/storage/helper.ts")};export const getPlatform=()=>"macos";`,
    "@tauri-apps/api/core": `export const invoke=async(command,args)=>{
      const n=window.__native;n.calls.push({command,args});
      if(command==='get_autostart_status'){if(n.readError)throw n.readError;return {...n.status};}
      if(command==='set_autostart_enabled'){
        if(!n.status.supported)throw 'unsupported';if(n.writeError)throw n.writeError;
        n.status.enabled=args.enabled;return {...n.status};
      }
    };`,
    "@tauri-apps/api/event": `export const listen=async()=>()=>{};`,
    "@tauri-apps/api/window": `export const getCurrentWindow=()=>({label:'dashboard'});`,
  };
  const bundle = await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router-dom';
    import {AppProvider} from './src/contexts/app.context.tsx';
    import {AutostartToggle} from './src/pages/settings/components/AutostartToggle.tsx';
    createRoot(document.getElementById('root')).render(<MemoryRouter><AppProvider><AutostartToggle/></AppProvider></MemoryRouter>);
  ` }, bundle:true, write:false, platform:"browser", format:"iife", jsx:"automatic",
    define:{"process.env.NODE_ENV":'"test"'}, plugins:[{name:"native-autostart-boundary",setup(b){
      b.onResolve({filter:/.*/},a=>Object.hasOwn(mocks,a.path)?{path:a.path,namespace:"fixture"}:undefined);
      b.onLoad({filter:/.*/,namespace:"fixture"},a=>({contents:mocks[a.path],loader:"tsx",resolveDir:root}));
    }}] });
  const browser = await playwright.chromium.launch({headless:true,executablePath:process.env.JARVIS_CHROMIUM_EXECUTABLE});
  try {
    const page = await browser.newPage();
    const errors=[];page.on("pageerror",e=>errors.push(e.message));
    await page.route("**/*",route=>route.request().url()==="http://startup.fixture/"
      ?route.fulfill({contentType:"text/html",body:'<div id="root"></div>'}):route.abort());
    const mount=async(status, readError=null)=>{
      await page.goto("http://startup.fixture/");
      await page.evaluate(({status,readError})=>{
        localStorage.clear();localStorage.setItem('auto-configs-enabled','true');
        localStorage.setItem('customizable',JSON.stringify({autostart:{isEnabled:true}}));
        window.__native={status,readError,calls:[]};
      },{status,readError});
      await page.addScriptTag({content:bundle.outputFiles[0].text});
      await page.waitForFunction(()=>window.__native.calls.some(c=>c.command==='get_autostart_status'));
    };
    const toggle=page.getByRole('switch',{name:'Toggle autostart'});
    const persisted=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('customizable')).autostart.isEnabled);
    await mount({supported:false,enabled:false});
    await page.getByText('Unavailable in development and test builds',{exact:true}).waitFor();
    assert.equal(await toggle.isDisabled(),true);assert.equal(await toggle.isChecked(),false);
    assert.equal(await persisted(),false);
    assert.equal(await page.evaluate(()=>window.__native.calls.filter(c=>c.command==='set_autostart_enabled').length),0);
    await mount({supported:true,enabled:false});
    await page.waitForFunction(()=>document.querySelector('[role=switch]')?.disabled===false);
    assert.equal(await persisted(),false);assert.equal(await toggle.isChecked(),false);
    await toggle.click();await page.waitForFunction(()=>document.querySelector('[role=switch]')?.getAttribute('aria-checked')==='true');
    assert.equal(await persisted(),true);
    await page.evaluate(()=>{window.__native.writeError='Synthetic login registration failure';});
    await toggle.click();await page.getByRole('alert').waitFor();
    assert.equal(await page.getByRole('alert').textContent(),'Synthetic login registration failure');
    assert.equal(await persisted(),true);assert.equal(await toggle.isChecked(),true);
    await mount({supported:true,enabled:true},'Synthetic native read failure');
    await page.getByRole('alert').waitFor();assert.equal(await toggle.isDisabled(),true);
    assert.equal(await persisted(),true);
    assert.equal(await page.getByRole('alert').textContent(),'Synthetic native read failure');
    assert.deepEqual(errors,[]);
  } finally {await browser.close();}
});
