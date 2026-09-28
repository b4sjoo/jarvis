import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import ts from "typescript";

const root = process.cwd();
const require = createRequire(import.meta.url);
const playwright = require(process.env.JARVIS_PLAYWRIGHT_MODULE ?? "playwright");
const mainSource = readFileSync("src/pages/app/components/meeting/index.tsx", "utf8");
const main = ts.createSourceFile("main.tsx", mainSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function initializer(name) {
  let result;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(main) === name) result = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(main);
  assert.ok(result, `production Main declaration missing: ${name}`);
  return result.getText(main);
}

const fixtureBundle = await build({ entryPoints: ["tests/fixtures/project-selection-consumer.ts"], bundle: true,
  platform: "node", format: "cjs", write: false, logLevel: "silent" });
const fixtureModule = { exports: {} };
new Function("module", "exports", "require", fixtureBundle.outputFiles[0].text)(fixtureModule, fixtureModule.exports, require);
const fixtures = fixtureModule.exports;

const externalModules = {
  "@/contexts": `export const useApp=()=>window.__s63.app;`,
  "@tauri-apps/api/core": `export const invoke=(name,args)=>window.__s63.invoke(name,args);
    export const convertFileSrc=(p)=>p;
    export class Channel { onmessage; }`,
  "@tauri-apps/api/event": `export const listen=(name,fn)=>window.__s63.listen(name,fn);
    export const emit=async(name,payload)=>window.__s63.emit(name,payload);
    export const once=listen;`,
  "@tauri-apps/plugin-sql": `export default class Database { static async load(){return window.__s63.database;} }`,
  "@/lib/database/memory.action": `
    export const loadMemoryEntriesForSnapshot=async()=>({entries:structuredClone(window.__s63.memory),timings:{databaseAcquireMs:0,databaseReadMs:0,rowMappingMs:0}});
    export const markMemoryEntriesUsedBatch=async(ids)=>window.__s63.usage.push(ids);
    export const markMemoryEntriesUsed=markMemoryEntriesUsedBatch;
    export const getMemoryEntries=async()=>structuredClone(window.__s63.memory);
    export const getEnabledMemoryEntries=getMemoryEntries;
    export const getMemorySources=async()=>[];
    export const getMemoryProjects=async()=>[];
    export const getMemoryEntryRevision=async()=>{throw Error('Unexpected revision read');};
    export const getMemorySourceRevision=getMemoryEntryRevision;
    export const setMemoryEntryEnabled=async()=>{throw Error('Unexpected memory write');};
    export const rebuildCuratedMemoryIndex=setMemoryEntryEnabled;`,
  "@/components": `export * from './src/components/ui/button'; export * from './src/components/ui/popover';`,
};

async function browserBundle() {
  return build({ stdin: { loader: "tsx", resolveDir: root, contents: `
    import React,{useCallback,useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {useMeetingAssistant} from './src/hooks/useMeetingAssistant';
    import {ProjectChoiceControl} from './src/pages/app/components/meeting/project-choice-control';
    import {buildMeetingAnswerDisplayModel} from './src/lib/meeting/meeting-answer-display';
    function Entry(){
      const meeting=useMeetingAssistant();
      const adviseDisplay=meeting.selectAdviseDisplay(buildMeetingAnswerDisplayModel({content:meeting.partialSuggestion}));
      const projectChoice=meeting.readProjectChoicePresentation(adviseDisplay.target);
      const [selection,setClarifyingSelection]=useState(null);
      const [,setDismissedQuestionKey]=useState(null);
      const clarifyingQuestion=adviseDisplay.sections.clarifyingQuestion;
      const clarifyingQuestionKey='';
      const clarifyingOptions=adviseDisplay.sections.clarifyingOptions??[];
      const clarifyingOptionDisplay={source:'none',showBooleanFallback:false};
      const displayTargetKey=JSON.stringify(adviseDisplay.target);
      const handleClarifyingAnswer=${initializer("handleClarifyingAnswer")};
      const handleProjectChoice=${initializer("handleProjectChoice")};
      window.__s63.meeting=meeting;
      window.__s63.observed={selection,projectChoice,adviseDisplay};
      return <><pre data-answer>{adviseDisplay.sections.primaryAnswer}</pre>
        <ProjectChoiceControl presentation={projectChoice} selectionState={selection?.status}
          selectedLabel={selection?.label} onSelect={handleProjectChoice}/></>;
    }
    createRoot(document.getElementById('root')).render(<Entry/>);
  ` }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", logLevel: "silent",
    alias: { "@": path.join(root, "src") }, define: { "import.meta.env.DEV": "true", "import.meta.env.PROD": "false", "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "s63-external-boundaries", setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        const name = args.path.startsWith(`${root}/src/`) ? `@/${path.relative(`${root}/src`, args.path)}` : args.path;
        if (Object.hasOwn(externalModules, name)) return { path: name, namespace: "s63-external" };
        if (args.path.endsWith("?raw")) return { path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: "s63-raw" };
      });
      builder.onLoad({ filter: /.*/, namespace: "s63-external" }, args => ({ contents: externalModules[args.path], loader: "ts", resolveDir: root }));
      builder.onLoad({ filter: /.*/, namespace: "s63-raw" }, args => ({ contents: readFileSync(args.path, "utf8"), loader: "text" }));
    } }],
  });
}

test("S63-N1 real Normal/Voice selection through Hook, binding, Prompt and publication", async t => {
  const bundle = await browserBundle();
  const browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.JARVIS_CHROMIUM_EXECUTABLE });
  try {
    const page = await browser.newPage();
    const failures = [];
    page.on("pageerror", error => failures.push(error.stack ?? error.message));
    await page.route("**/*", async route => {
      if (route.request().url() === "https://s63.fixture/") return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
      failures.push(`Uncontrolled network: ${route.request().url()}`);
      await route.abort();
    });
    await page.goto("https://s63.fixture/");
    await page.evaluate(({memory,answers,question}) => {
      const listeners = new Map();
      const writes = new Map();
      const evaluationProjections = new Map();
      const calls = [];
      const unexpected = [];
      const provider = { id: "s63", streaming: true, responseContentPath: "choices[0].message.content",
        curl: `curl https://s63.fixture/provider -H 'Content-Type: application/json' -d '{"model":"s63","messages":[{"role":"system","content":"{{SYSTEM_PROMPT}}"},{"role":"user","content":[{"type":"text","text":"{{TEXT}}"},{"type":"image_url","image_url":{"url":"data:image/png;base64,{{IMAGE}}"}}]}]}'` };
      window.__s63 = { calls, unexpected, memory, usage: [], writes, requests: [],
        app: { screenshotConfiguration: {}, selectedSttProvider: { provider: "", variables: {} }, allSttProviders: [],
          selectedAIProvider: { provider: "s63", variables: {} }, allAiProviders: [provider],
          selectedAudioDevices: { input: { id: "default" }, output: { id: "default" } } },
        database: { select: async sql => { calls.push({sql}); return []; }, execute: async sql => { calls.push({sql}); return {rowsAffected:0}; } },
        listen: async (name,fn) => { const set=listeners.get(name)??new Set(); set.add(fn); listeners.set(name,set); return ()=>set.delete(fn); },
        emit: (name,payload) => { for(const fn of listeners.get(name)??[]) fn({event:name,payload}); },
        invoke: async (name,args={}) => {
          calls.push({name,args});
          if (name==='preparation_extraction_initialize'||name==='memory_content_initialize'||name==='set_native_stall_diagnostics') return null;
          if (name==='start_meeting_session_recording') return '/s63-recording';
          if (name==='write_meeting_session_recording_text') {writes.set(args.relativePath,(args.append?writes.get(args.relativePath)??'':'')+args.payload);return null;}
          if (name==='read_meeting_trace_metrics') return null;
          if (name==='write_meeting_trace_metrics') return null;
          if (name==='write_meeting_trace_log') return null;
          if (name==='cleanup_stt_evaluation_captures') return 0;
          if (name==='get_stt_evaluation_capture_status') return {active:false,bytesWritten:0};
          if (name==='evaluation_store_import_status') return {imported:true};
          if (name==='evaluation_store_read') return {
            events: [],
            projections: structuredClone(Array.from(evaluationProjections.values())
              .filter(projection => projection.sessionId === args.sessionId)),
          };
          if (name==='evaluation_store_project') {
            // The real frontend has already derived this read model. The native
            // storage command persists and returns it without creating labels.
            const projection = JSON.parse(JSON.stringify(args.projection));
            if (projection?.schemaVersion !== 2 || !projection.projectionId || !projection.sessionId) {
              throw new Error('Invalid HumanEvaluationProjectionV2 storage input');
            }
            evaluationProjections.set(projection.projectionId, projection);
            return structuredClone(projection);
          }
          unexpected.push(name); throw new Error('Uncontrolled native command: '+name);
        },
      };
      localStorage.setItem('meeting_assistant_settings',JSON.stringify({debugMode:true,microphoneContextEnabled:false,semanticTaxonomyMode:'off',useMemory:true}));
      window.Worker=class { constructor(){throw new Error('External model worker unavailable in S63 fixture');} };
      window.fetch=async (url,init)=>{
        if(String(url)!=='https://s63.fixture/provider') throw new Error('Uncontrolled fetch: '+url);
        const input=JSON.parse(init.body);
        const system=input.messages.find(m=>m.role==='system')?.content??'';
        const user=JSON.stringify(input.messages.filter(m=>m.role!=='system'));
        const request={system,user};
        window.__s63.requests.push(request);
        let response;
        if(system.includes('Classify only the question type')) response=JSON.stringify({v:1,t:'project-deep-dive',c:0.99,e:question});
        else if(system.includes('Return exactly the fields v,d,c,t,r')) response=JSON.stringify({v:4,d:'o',c:0.99,t:[0],r:'ask'});
        else if(system.startsWith('You are a live meeting co-pilot')) {
          if(window.__s63.stage==='selected') {
            if(!user.includes(memory[1].content)||user.includes(memory[0].content)) throw new Error('Selected Provider Prompt has missing/wrong-project facts');
            request.selectedFactPromptChecked=true;
            response=answers.selected;
          } else response=answers.initial;
        }
        else if(system.startsWith('Decide one thing only: whether questionText')) response=JSON.stringify({schemaVersion:2,decision:'not-visual',questionEvidenceSpans:[question],visualEvidenceSpans:[]});
        else if(system.includes('whether the bounded answer')) response=JSON.stringify({schemaVersion:2,decision:'unclear',questionEvidenceSpans:[],answerEvidenceSpans:[],ambiguityReason:'fixture boundary'});
        else {request.unhandled=true;throw new Error('Uncontrolled Provider operation: '+system.slice(0,120));}
        request.response=response;
        return new Response('data: '+JSON.stringify({choices:[{delta:{content:response},finish_reason:null}]})+'\n\n'+
          'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
      };
    }, {memory:fixtures.S63_MEMORY,answers:fixtures.S63_PROVIDER_ANSWERS,question:fixtures.S63_SOURCE_QUESTION});
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    try {
      await page.waitForFunction(() => Boolean(window.__s63.meeting), undefined, { timeout: 10000 });
    } catch (error) {
      t.diagnostic(`mount errors=${JSON.stringify(failures)}; boundary errors=${JSON.stringify(await page.evaluate(()=>window.__s63.unexpected))}`);
      throw error;
    }
    t.diagnostic(`mounted Hook; external commands=${JSON.stringify(await page.evaluate(()=>window.__s63.calls.filter(c=>c.name).map(c=>c.name)))}`);
    const started = await page.evaluate(() => window.__s63.meeting.startRuntimeRegressionRun());
    t.diagnostic(`Replay start=${started}; unexpected=${JSON.stringify(await page.evaluate(()=>window.__s63.unexpected))}`);
    assert.equal(started, true, JSON.stringify(await page.evaluate(()=>({error:window.__s63.meeting.error,recording:window.__s63.meeting.sessionRecording,unexpected:window.__s63.unexpected}))));
    const submitted=await page.evaluate(text=>window.__s63.meeting.submitRuntimeRegressionText(text),fixtures.S63_SOURCE_QUESTION);
    try { await page.getByRole('button',{name:'Quartz Relay',exact:true}).waitFor({timeout:5000}); }
    catch(error) {
      t.diagnostic(`text terminal=${submitted}; state=${JSON.stringify(await page.evaluate(()=>({error:window.__s63.meeting.error,
        activeParent:window.__s63.meeting.activeMeetingTask?.parent && {
          id:window.__s63.meeting.activeMeetingTask.parent.id,
          questionType:window.__s63.meeting.activeMeetingTask.parent.questionType,
          binding:window.__s63.meeting.activeMeetingTask.parent.projectBinding,
        },
        directory:window.__s63.meeting.lastMemoryContext?.projectDirectory,
        display:window.__s63.observed.adviseDisplay.target,selection:window.__s63.observed.projectChoice,
        requests:window.__s63.requests.map(r=>({system:r.system.slice(0,100),unhandled:r.unhandled})),
        trace:window.__s63.meeting.traces.map(t=>({status:t.status,metadata:Object.fromEntries(Object.entries(t.metadata??{}).filter(([k])=>/projectBinding|currentOnly|effectiveQuestion|effectiveAdvisor|projectSelection|settlement.*Parent/i.test(k)))}))})))}`);
      throw error;
    }
    const before=await page.evaluate(()=>({id:window.__s63.meeting.taskRuntime.parent.id,
      phase:window.__s63.meeting.taskRuntime.parent.playbookPhase,binding:window.__s63.meeting.taskRuntime.parent.projectBinding}));
    assert.equal(before.binding,undefined);
    await page.evaluate(()=>{window.__s63.stage='selected';});
    await page.getByRole('button',{name:'Quartz Relay',exact:true}).click();
    await page.waitForFunction(()=>window.__s63.observed.selection?.status==='succeeded',undefined,{timeout:10000});
    const clarificationRequestId = await page.evaluate(() => window.__s63.observed.selection?.requestId);
    assert.ok(clarificationRequestId, 'successful selection must expose its actual request ID');
    try {
      await page.waitForFunction(requestId => window.__s63.meeting.traces.some(trace =>
        trace.metadata?.clarifyingRequestId === requestId &&
        trace.metadata.advisorStablePublicationCommitted === true
      ), clarificationRequestId, { timeout: 5000 });
    } catch (error) {
      const diagnostic = await page.evaluate(requestId => {
        const summarize = trace => ({
          id: trace.id,
          status: trace.status,
          metadata: {
            ...Object.fromEntries(Object.entries(trace.metadata ?? {}).filter(([key]) => /requestId$/i.test(key))),
            clarifyingSelectionState: trace.metadata?.clarifyingSelectionState,
            clarifyingSelectionTerminalReason: trace.metadata?.clarifyingSelectionTerminalReason,
            advisorStablePublicationCommitted: trace.metadata?.advisorStablePublicationCommitted,
            advisorOutputDisposition: trace.metadata?.advisorOutputDisposition,
          },
        });
        return {
          clarificationRequestId: requestId,
          selection: window.__s63.observed.selection,
          matchingTraces: window.__s63.meeting.traces
            .filter(trace => trace.metadata?.clarifyingRequestId === requestId).map(summarize),
          allTraces: window.__s63.meeting.traces.map(summarize),
        };
      }, clarificationRequestId);
      t.diagnostic(`bounded publication-trace wait timed out: ${JSON.stringify(diagnostic)}`);
      throw error;
    }
    const after=await page.evaluate(()=>({parent:window.__s63.meeting.taskRuntime.parent,
      selection:window.__s63.observed.selection,answer:window.__s63.observed.adviseDisplay.sections.primaryAnswer,
      requests:window.__s63.requests.filter(r=>r.selectedFactPromptChecked),
      traces:window.__s63.meeting.traces.filter(t=>t.metadata?.clarifyingRequestId===window.__s63.observed.selection?.requestId),
      recording:Array.from(window.__s63.writes.values())}));
    assert.equal(after.parent.id,before.id);
    assert.equal(after.parent.playbookPhase,before.phase);
    assert.equal(after.parent.projectBinding.projectId,'quartz_relay');
    assert.equal(after.parent.projectBinding.revision,1);
    assert.ok(after.answer.includes(fixtures.S63_FACT_B));
    assert.ok(!after.answer.includes(fixtures.S63_FACT_A));
    assert.equal(after.requests.length,1);
    assert.ok(after.traces.some(trace=>trace.metadata.advisorStablePublicationCommitted===true));
    assert.ok(after.recording.some(payload=>payload.includes(after.selection.requestId)));
    const storedEvaluation = await page.evaluate(() => window.__s63.invoke('evaluation_store_read', {
      sessionId: window.__s63.meeting.meetingSessionId,
    }));
    assert.deepEqual(storedEvaluation.events, [], 'this consumer fixture submits no human labels');
    assert.ok(storedEvaluation.projections.length > 0, 'actual derived observations must survive storage readback');
    for (const projection of storedEvaluation.projections) {
      assert.equal(projection.schemaVersion, 2);
      assert.deepEqual(projection.inputEventIds, []);
      assert.deepEqual(projection.activeFacts, {});
      assert.deepEqual(projection.verdicts, {}, 'observed success cannot become a human quality verdict');
    }
    assert.deepEqual(await page.evaluate(()=>window.__s63.unexpected),[]);
    assert.deepEqual(failures, []);
  } finally { await browser.close(); }
});
