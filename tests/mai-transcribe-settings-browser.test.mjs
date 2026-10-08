import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { loadBrowserTestDependency } from "./helpers/browser-test-dependency.mjs";

const { playwright, skip } = loadBrowserTestDependency();
test("MAI203: real settings controls and STT request round-trip in a browser", { skip }, async () => {
  const root = process.cwd();
  const file = name => JSON.stringify(path.join(root, name));
  const mocks = {
    "@/components": `
      export {Button} from ${file("src/components/ui/button.tsx")};
      export {Input} from ${file("src/components/ui/input.tsx")};
      export {Header} from ${file("src/components/Header/index.tsx")};
      export {Selection} from ${file("src/components/Selection/index.tsx")};
      export {TextInput} from ${file("src/components/TextInput/index.tsx")};`,
    "@/lib": `export {extractVariables} from ${file("src/lib/functions/common.function.ts")};
      export const safeLocalStorage={setItem:(...args)=>localStorage.setItem(...args)};
      export const deleteAllConversations=()=>{throw new Error('unused');};`,
    // Only the app-state boundary is replaced. Hook, controls, template and request builder are real.
    "@/contexts": `import React from 'react';
      export const StateContext=React.createContext(null);
      export const useApp=()=>React.useContext(StateContext);`,
  };
  const bundle = await build({
    stdin: { resolveDir: root, loader: "tsx", contents: `
      import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router-dom';
      import {StateContext} from '@/contexts';
      import {Providers} from './src/pages/dev/components/stt-configs/Providers.tsx';
      import {useSettings} from './src/hooks/useSettings.ts';
      import {SPEECH_TO_TEXT_PROVIDERS} from './src/config/stt.constants.ts';
      import {fetchSTT} from './src/lib/functions/stt.function.ts';
      const state=window.__mai={requests:[],saved:null};
      window.fetch=async(url,init)=>{
        const form=init.body, audio=form.get('audio');
        state.requests.push({url,keys:[...form.keys()],filename:audio?.name,type:audio?.type,
          definition:JSON.parse(form.get('definition')),bytes:[...new Uint8Array(await audio.arrayBuffer())],
          contentType:new Headers(init.headers).get('content-type')});
        return Response.json({combinedPhrases:[{text:'Explain cache eviction.'}]});
      };
      function Panel(){const props=useSettings();const [result,setResult]=React.useState('');
        return <><Providers {...props}/><button onClick={async()=>{try{setResult(await fetchSTT({
          provider:SPEECH_TO_TEXT_PROVIDERS.find(p=>p.id===props.selectedSttProvider.provider),
          selectedProvider:props.selectedSttProvider,audio:new Blob([new Uint8Array([1,2,3])],{type:'audio/wav'}),terms:['HNSW']
        }));}catch(e){setResult(e.message);}}}>Transcribe fixture</button><output>{result}</output></>;}
      function App(){const [selected,setSelected]=React.useState(()=>JSON.parse(localStorage.getItem('fixture-stt')||'null')||{provider:'openai-whisper',variables:{}});
        const value={selectedSttProvider:selected,allSttProviders:SPEECH_TO_TEXT_PROVIDERS,allAiProviders:[],
          selectedAIProvider:{provider:'',variables:{}},selectedPreparationAIProvider:{provider:'',variables:{}},
          onSetSelectedSttProvider:next=>{state.saved=next;localStorage.setItem('fixture-stt',JSON.stringify(next));setSelected(next);}};
        return <MemoryRouter><StateContext.Provider value={value}><Panel/></StateContext.Provider></MemoryRouter>;}
      createRoot(document.getElementById('root')).render(<App/>);
    ` },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"test"' },
    plugins: [{ name: "stt-settings-boundaries", setup(b) {
      b.onResolve({ filter: /.*/ }, args => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: "fixture" } : undefined);
      b.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "tsx", resolveDir: root }));
    } }],
  });
  const browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.JARVIS_CHROMIUM_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 850 } });
    const errors=[];page.on("pageerror", e=>errors.push(e.message));
    const assets=fs.existsSync("dist/assets")?fs.readdirSync("dist/assets").filter(f=>f.endsWith(".css")):[];
    const css=assets.map(f=>fs.readFileSync(path.join("dist/assets",f),"utf8")).join("\n");
    await page.route("**/*",route=>route.request().url()==="http://mai-settings.fixture/"
      ?route.fulfill({contentType:"text/html",body:`<style>${css}</style><div id="root" style="max-width:720px;margin:24px auto;padding:16px"></div>`})
      :route.abort());
    const mount=async()=>{await page.goto("http://mai-settings.fixture/");await page.addScriptTag({content:bundle.outputFiles[0].text});};
    await mount();await page.getByRole("combobox").click();
    await page.getByRole("option",{name:"Azure MAI-Transcribe-2",exact:true}).click();
    const endpoint=page.getByPlaceholder("https://your-resource.cognitiveservices.azure.com");
    await endpoint.fill("https://browser-fixture.cognitiveservices.azure.com/");
    await page.locator('input[type="password"]').fill("synthetic-secret");
    assert.equal(await page.locator("input").count(),2);
    assert.equal(await page.getByText("STT_TERMS_JSON",{exact:true}).count(),0);
    assert.deepEqual(await page.evaluate(()=>window.__mai.saved),{provider:"azure-mai-transcribe",variables:{
      endpoint:"https://browser-fixture.cognitiveservices.azure.com/",api_key:"synthetic-secret"}});
    await mount();await endpoint.waitFor();
    assert.equal(await endpoint.inputValue(),"https://browser-fixture.cognitiveservices.azure.com/");
    assert.equal(await page.locator('input[type="password"]').inputValue(),"synthetic-secret");
    await page.getByRole("button",{name:"Transcribe fixture"}).click();
    await page.waitForFunction(()=>document.querySelector("output")?.textContent==="Explain cache eviction.");
    const requests=await page.evaluate(()=>window.__mai.requests);assert.equal(requests.length,1);
    assert.deepEqual(requests[0],{
      url:"https://browser-fixture.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15",
      keys:["audio","definition"],filename:"audio.wav",type:"audio/wav",bytes:[1,2,3],contentType:null,
      definition:{enhancedMode:{enabled:true,model:"MAI-Transcribe-2",modelOptions:{transcribeStyle:"verbatim"}},phraseList:{phrases:["HNSW"]}},
    });
    for(const width of [1000,420]){
      await page.setViewportSize({width,height:850});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      if(process.env.JARVIS_STT_SCREENSHOT_DIR){fs.mkdirSync(process.env.JARVIS_STT_SCREENSHOT_DIR,{recursive:true});
        await page.screenshot({path:path.join(process.env.JARVIS_STT_SCREENSHOT_DIR,`mai-settings-${width}.png`),fullPage:true});}
    }
    await endpoint.fill("https://wrong.services.ai.azure.com/api/projects/example");
    await page.getByRole("button",{name:"Transcribe fixture"}).click();
    await page.waitForFunction(()=>document.querySelector("output")?.textContent.includes("not a Project"));
    assert.equal(await page.evaluate(()=>window.__mai.requests.length),1);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
