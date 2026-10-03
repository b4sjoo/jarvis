import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import ts from "typescript";
import { loadBrowserTestDependency } from "./helpers/browser-test-dependency.mjs";

const root = process.cwd();
const require = createRequire(import.meta.url);
// Importers gate on the same decision: a skip reason, or false when a real browser run proceeds.
export const { playwright, skip: browserTestSkip } = loadBrowserTestDependency();
const mainSource = readFileSync("src/pages/app/components/meeting/index.tsx", "utf8");
const main = ts.createSourceFile("main.tsx", mainSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const focus = ts.createSourceFile("focus.tsx", readFileSync("src/pages/app/components/meeting/focus-window.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function findOne(file, predicate) {
  const found=[];
  const visit=node=>{if(predicate(node))found.push(node);ts.forEachChild(node,visit);};
  visit(file);
  assert.equal(found.length,1,'expected one production consumer');
  return found[0];
}
const focusActionHandler = findOne(main,node=>ts.isBinaryExpression(node)&&node.left.getText(main)==='focusActionHandlerRef.current').right.getText(main);
const focusChoice = findOne(focus,node=>(ts.isJsxSelfClosingElement(node)||ts.isJsxOpeningElement(node))&&node.tagName.getText(focus)==='ProjectChoiceControl');
const focusChoiceSelect = focusChoice.attributes.properties.find(node=>node.name?.getText(focus)==='onSelect').initializer.expression.getText(focus);
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
export const fixtures = fixtureModule.exports;

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
    export const loadMemoryEntriesForSnapshot=async()=>{
      if(window.__s63.holdStorage){window.__s63.storageBlocked++;await new Promise(resolve=>window.__s63.storageWaiters.push(resolve));}
      return {entries:structuredClone(window.__s63.memory),timings:{databaseAcquireMs:0,databaseReadMs:0,rowMappingMs:0}};
    };
    export const markMemoryEntriesUsedBatch=async(ids)=>window.__s63.usage.push(ids);
    export const markMemoryEntriesUsed=markMemoryEntriesUsedBatch;
    export const getMemoryEntries=async()=>structuredClone(window.__s63.memory);
    export const getEnabledMemoryEntries=getMemoryEntries;
    export const getMemorySources=async()=>[];
    export const getMemoryProjects=async()=>[];
    export const getMemoryEntryRevision=async()=>{throw Error('Unexpected revision read');};
    export const getMemorySourceRevision=getMemoryEntryRevision;
    export {setMemoryEntryEnabled} from 's63:actual-memory-action';
    export const rebuildCuratedMemoryIndex=async()=>{throw Error('Unexpected memory publication');};`,
  "@/components": `export * from './src/components/ui/button'; export * from './src/components/ui/popover';`,
};

export async function browserBundle(additionalPlugins = []) {
  return build({ stdin: { loader: "tsx", resolveDir: root, contents: `
    import React,{useCallback,useState,useRef,useEffect,useMemo} from 'react';
    import {createRoot} from 'react-dom/client';
    import {useMeetingAssistant} from './src/hooks/useMeetingAssistant';
    import {ProjectChoiceControl} from './src/pages/app/components/meeting/project-choice-control';
    import {FactRiskNotice} from './src/pages/app/components/meeting/fact-risk-notice';
    import {buildMeetingAnswerDisplayModel} from './src/lib/meeting/meeting-answer-display';
    import {buildClarifyingOptionDisplayModel} from './src/lib/meeting/clarifying-options';
    import {createMeetingFocusPublisher,createMeetingFocusConsumer} from './src/lib/meeting/focus-window-protocol';
    import {EMPTY_MEETING_FOCUS_SNAPSHOT} from './src/lib/meeting/focus-window';
    import {setMemoryEntryEnabled} from '@/lib/database/memory.action';
    window.__s63.setMemoryEntryEnabled=setMemoryEntryEnabled;
    function FocusEntry(){
      const [envelope,setEnvelope]=useState(null);
      const consumer=useRef(null);
      if(!consumer.current)consumer.current=createMeetingFocusConsumer({
        transport:window.__s63.transport('snapshot','action'),windowKind:'answer',
        onSnapshot:setEnvelope,onError:error=>window.__s63.protocolErrors.push(error.message),
        observe:event=>window.__s63.protocolEvents.push(event),
      });
      useEffect(()=>{void consumer.current.start();return()=>consumer.current.dispose();},[]);
      useEffect(()=>{if(envelope){consumer.current.applied(envelope);window.__s63.focusSnapshot=envelope;}},[envelope]);
      const snapshot=envelope?.payload;
      const sendFocusAction=action=>consumer.current.dispatch(action);
      if(!snapshot)return null;
      return <><pre data-answer>{snapshot.sections.primaryAnswer}</pre>
        <FactRiskNotice result={snapshot.factRiskReview}/>
        <ProjectChoiceControl presentation={snapshot.projectChoice} selectionState={snapshot.clarifyingSelectionState}
          selectedLabel={snapshot.selectedClarifyingAnswerLabel} onSelect={${focusChoiceSelect}}/></>;
    }
    function Entry(){
      const meeting=useMeetingAssistant();
      const adviseDisplay=meeting.selectAdviseDisplay(buildMeetingAnswerDisplayModel({content:meeting.partialSuggestion}));
      const projectChoice=meeting.readProjectChoicePresentation(adviseDisplay.target);
      const factRiskReview=adviseDisplay.streaming?undefined:meeting.readFactRiskReview(adviseDisplay.stable);
      const [selection,setClarifyingSelection]=useState(null);
      const [,setDismissedQuestionKey]=useState(null);
      const clarifyingQuestion=adviseDisplay.sections.clarifyingQuestion;
      const clarifyingQuestionKey='';
      const clarifyingSelection=selection;
      const activeClarifyingSelection=${initializer("activeClarifyingSelection")};
      const rawClarifyingOptions=adviseDisplay.sections.clarifyingOptions??[];
      const displayedSuggestion=adviseDisplay.stable?.suggestion;
      const projectIdentityPending=${initializer("projectIdentityPending")};
      const clarifyingOptionDisplay=${initializer("clarifyingOptionDisplay")};
      const clarifyingOptions=clarifyingOptionDisplay.options;
      const displayTargetKey=JSON.stringify(adviseDisplay.target);
      useEffect(()=>{if(window.__s63.surface==='normal')meeting.recordAdviseDisplayApplied(adviseDisplay.target,'normal-mode');},
        [displayTargetKey,adviseDisplay.locked,factRiskReview?.answerKey,factRiskReview?.status,meeting.recordAdviseDisplayApplied]);
      const handleClarifyingAnswer=${initializer("handleClarifyingAnswer")};
      const handleProjectChoice=${initializer("handleProjectChoice")};
      const focusActionHandlerRef=useRef(null);
      const focusPublisherRef=useRef(null);
      focusActionHandlerRef.current=${focusActionHandler};
      const meetingRef=useRef(meeting);meetingRef.current=meeting;
      if(!focusPublisherRef.current)focusPublisherRef.current=createMeetingFocusPublisher({
        transport:window.__s63.transport('action','snapshot'),
        onAction:action=>focusActionHandlerRef.current(action),
        onError:error=>window.__s63.protocolErrors.push(error.message),
        observe:event=>{window.__s63.protocolEvents.push(event);
          if(event.event==='applied'&&event.displayTarget)meetingRef.current.recordAdviseDisplayApplied(event.displayTarget,'focus-mode',event.adviseLocked);},
      });
      useEffect(()=>{void focusPublisherRef.current.start();return()=>focusPublisherRef.current.dispose();},[]);
      const payload={...EMPTY_MEETING_FOCUS_SNAPSHOT,active:true,factRiskReview,
        sections:{...adviseDisplay.sections,clarifyingOptions},showClarifyingBooleanFallback:clarifyingOptionDisplay.showBooleanFallback,
        advisePin:{target:adviseDisplay.target,locked:adviseDisplay.locked,backgroundUpdated:adviseDisplay.backgroundUpdated},
        projectChoice,selectedClarifyingAnswerLabel:activeClarifyingSelection?.label,clarifyingSelectionState:activeClarifyingSelection?.status,
        clarifyingQuestion,showClarifyingQuestion:Boolean(clarifyingQuestion),
        answerDelivery:meeting.answerDelivery,statusLabel:meeting.status,error:meeting.error};
      const payloadKey=JSON.stringify(payload);
      useEffect(()=>{if(window.__s63.surface==='focus')void focusPublisherRef.current.publish(payload);},[payloadKey]);
      window.__s63.meeting=meeting;
      window.__s63.observed={selection,activeClarifyingSelection,projectChoice,adviseDisplay,clarifyingOptionDisplay,factRiskReview};
      useEffect(()=>{if(selection)window.__s63.selections.push(structuredClone(selection));},[selection]);
      if(window.__s63.surface==='focus')return <FocusEntry/>;
      return <><pre data-answer>{adviseDisplay.sections.primaryAnswer}</pre>
        <FactRiskNotice result={factRiskReview}/>
        <ProjectChoiceControl presentation={projectChoice} selectionState={activeClarifyingSelection?.status}
          selectedLabel={activeClarifyingSelection?.label} onSelect={handleProjectChoice}/></>;
    }
    createRoot(document.getElementById('root')).render(<Entry/>);
  ` }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", logLevel: "silent",
    alias: { "@": path.join(root, "src") }, define: { "import.meta.env.DEV": "true", "import.meta.env.PROD": "false", "process.env.NODE_ENV": '"development"' },
    plugins: [...additionalPlugins, { name: "s63-external-boundaries", setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if(args.path==='s63:actual-memory-action')return {path:path.join(root,'src/lib/database/memory.action.ts'),namespace:'s63-actual'};
        const name = args.path.startsWith(`${root}/src/`) ? `@/${path.relative(`${root}/src`, args.path)}` : args.path;
        if (Object.hasOwn(externalModules, name)) return { path: name, namespace: "s63-external" };
        if (args.path.endsWith("?raw")) return { path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: "s63-raw" };
      });
      builder.onLoad({ filter: /.*/, namespace: "s63-external" }, args => ({ contents: externalModules[args.path], loader: "ts", resolveDir: root }));
      builder.onLoad({filter:/.*/,namespace:'s63-actual'},args=>({contents:readFileSync(args.path,'utf8'),loader:'ts',resolveDir:path.dirname(args.path)}));
      builder.onLoad({ filter: /.*/, namespace: "s63-raw" }, args => ({ contents: readFileSync(args.path, "utf8"), loader: "text" }));
    } }],
  });
}

export async function readRecordedSelectionTrace(page, requestId, state) {
  await page.waitForFunction(({requestId,state})=>Array.from(window.__s63.writes.entries()).some(([file,payload])=>{
    if(!file.startsWith('traces/')||!file.endsWith('.json'))return false;
    try {
      const trace=JSON.parse(payload).trace;
      return trace?.metadata?.clarifyingRequestId===requestId&&trace.metadata.clarifyingSelectionState===state&&
        (state!=='succeeded'||trace.metadata.advisorStablePublicationCommitted===true);
    } catch {return false;}
  }),{requestId,state},{timeout:5000});
  return page.evaluate(requestId=>Array.from(window.__s63.writes.entries())
    .filter(([file])=>file.startsWith('traces/')&&file.endsWith('.json'))
    .map(([,payload])=>JSON.parse(payload).trace)
    .find(trace=>trace?.metadata?.clarifyingRequestId===requestId),requestId);
}

export async function openProjectSelectionBrowserHost(t,bundle,browser,execution,inputs={}) {
  const context=await browser.newContext();
  try {
    const page = await context.newPage();
    const failures = [];
    page.on("pageerror", error => failures.push(error.stack ?? error.message));
    await page.route("**/*", async route => {
      if (route.request().url() === "https://s63.fixture/") return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
      failures.push(`Uncontrolled network: ${route.request().url()}`);
      await route.abort();
    });
    await page.goto("https://s63.fixture/");
    await page.evaluate(({memory,answers,question,nextQuestion,surface,source,holdFactReview,guardrailMode}) => {
      const listeners = new Map();
      const transports = new Map();
      const writes = new Map();
      const binaryWrites = new Map();
      const evaluationProjections = new Map();
      const calls = [];
      const unexpected = [];
      const provider = { id: "s63", streaming: true, responseContentPath: "choices[0].message.content",
        curl: `curl https://s63.fixture/provider -H 'Content-Type: application/json' -d '{"model":"s63","messages":[{"role":"system","content":"{{SYSTEM_PROMPT}}"},{"role":"user","content":[{"type":"text","text":"{{TEXT}}"},{"type":"image_url","image_url":{"url":"data:image/png;base64,{{IMAGE}}"}}]}]}'` };
      const canvas=document.createElement('canvas');canvas.width=1000;canvas.height=300;
      const pixels=canvas.getContext('2d');pixels.fillStyle='white';pixels.fillRect(0,0,1000,300);
      pixels.fillStyle='black';pixels.font='22px sans-serif';pixels.fillText(question,25,120);
      const imageBase64=canvas.toDataURL('image/png').split(',')[1];
      window.__s63 = { calls, unexpected, memory, answers, holdFactReview, usage: [], writes, binaryWrites, requests: [],surface,source,selections:[],
        protocolErrors:[],protocolEvents:[],transportMessages:[],transportDeliveries:[],imageBase64,
        providerWaiters:[],providerBlocked:0,
        storageWaiters:[],storageBlocked:0,
        releaseProvider(){this.holdSelected=false;for(const release of this.providerWaiters.splice(0))release();},
        releaseStorage(){this.holdStorage=false;for(const release of this.storageWaiters.splice(0))release();},
        transport(receive,send){return {
          async subscribe(fn){const set=transports.get(receive)??new Set();set.add(fn);transports.set(receive,set);return()=>set.delete(fn);},
          async send(payload){const wire=structuredClone(payload);window.__s63.transportMessages.push({channel:send,payload:wire});
            await Promise.resolve();
            const copies=window.__s63.duplicateActions&&send==='action'&&wire.type==='clarifying-answer'?2:1;
            for(let copy=0;copy<copies;copy++) {
              window.__s63.transportDeliveries.push({channel:send,payload:structuredClone(wire)});
              for(const fn of transports.get(send)??[])fn(structuredClone(wire));
            }},
        };},
        app: { screenshotConfiguration: {}, selectedSttProvider: { provider: "", variables: {} }, allSttProviders: [],
          selectedAIProvider: { provider: "s63", variables: {} }, allAiProviders: [provider],
          selectedAudioDevices: { input: { id: "default" }, output: { id: "default" } } },
        database: { select: async sql => { calls.push({sql}); return []; }, execute: async (sql,values=[]) => {
          calls.push({sql,values});
          if(sql.includes('UPDATE memory_entries SET enabled')) {
            const entry=memory.find(item=>item.id===values[2]);
            if(entry)entry.enabled=Boolean(values[0]);
            return {rowsAffected:entry?1:0};
          }
          return {rowsAffected:0};
        } },
        listen: async (name,fn) => { const set=listeners.get(name)??new Set(); set.add(fn); listeners.set(name,set); return ()=>set.delete(fn); },
        emit: (name,payload) => { for(const fn of listeners.get(name)??[]) fn({event:name,payload}); },
        invoke: async (name,args={}) => {
          calls.push({name,args});
          if (name==='preparation_extraction_initialize'||name==='memory_content_initialize'||name==='set_native_stall_diagnostics') return null;
          if (name==='start_meeting_session_recording') return '/s63-recording';
          if (name==='capture_screen_context_to_base64') return {imageBase64,imageMediaType:'image/png',target:{targetType:'active-window',title:'S63 question',appName:'Fixture',x:0,y:0,width:1000,height:300,imageWidth:1000,imageHeight:300}};
          if (name==='write_meeting_session_recording_base64') {
            const bytes=Uint8Array.from(atob(args.base64Payload),character=>character.charCodeAt(0));
            binaryWrites.set(`${args.folderName}/${args.relativePath}`,bytes);
            return `/s63-recording/${args.relativePath}`;
          }
          if (name==='write_meeting_session_recording_text') {writes.set(args.relativePath,(args.append?writes.get(args.relativePath)??'':'')+args.payload);return null;}
          if (name==='read_meeting_trace_metrics') return null;
          if (name==='write_meeting_trace_metrics') return null;
          if (name==='write_meeting_trace_log') return null;
          if (name==='export_meeting_trace') {
            writes.set(`exports/${args.fileName}`,args.payload);
            return `/s63-recording/exports/${args.fileName}`;
          }
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
      localStorage.setItem('meeting_assistant_settings',JSON.stringify({debugMode:true,microphoneContextEnabled:false,semanticTaxonomyMode:'off',useMemory:true,
        personalEvidenceGuardrailMode:guardrailMode??'enforcement'}));
      window.Worker=class { constructor(){throw new Error('External model worker unavailable in S63 fixture');} };
      window.fetch=async (url,init)=>{
        if(String(url)!=='https://s63.fixture/provider') throw new Error('Uncontrolled fetch: '+url);
        const input=JSON.parse(init.body);
        const system=input.messages.find(m=>m.role==='system')?.content??'';
        const user=JSON.stringify(input.messages.filter(m=>m.role!=='system'));
        const currentQuestion=user.includes(nextQuestion)?nextQuestion:question;
        const request={system,user,imageUrls:input.messages.flatMap(message=>Array.isArray(message.content)?message.content.filter(item=>item.type==='image_url').map(item=>item.image_url.url):[])};
        window.__s63.requests.push(request);
        let response;
        if(system.startsWith('Identify factual commitments')) {
          request.factRiskReview=true;
          const content=input.messages.find(m=>m.role==='user').content;
          const payload=JSON.parse(typeof content==='string'?content:content.find(c=>c.type==='text').text);
          if(window.__s63.holdFactReview){window.__s63.factReviewBlocked=true;await new Promise(resolve=>window.__s63.releaseFactReview=resolve);}
          response=JSON.stringify({v:1,flags:payload.answerSections.answer.includes('40%')
            ? [{section:'answer',quote:'40%',reason:'Measurement needs verification.',sourceIds:[]}] : []});
        }
        else if(system.includes('Classify only the question type')) response=JSON.stringify({v:1,t:currentQuestion===nextQuestion?'coding':'project-deep-dive',c:0.99,e:currentQuestion});
        else if(system.includes('Return exactly the fields v,d,c,t,r')) response=JSON.stringify({v:4,d:'o',c:0.99,t:[0],r:'ask'});
        else if(system.startsWith('You are a fast metadata extractor')) response=JSON.stringify({question,focusedEvidenceSummary:null,questionType:'project-deep-dive',askFrame:'past-project',topicDomain:'backend',projectAnchor:null,programmingLanguage:null,confidence:0.99,isBehavioralInterview:false,amazonLeadershipPrinciple:null});
        else if(system.startsWith('You are a live meeting co-pilot')||system.startsWith('You are Jarvis, a private live meeting assistant')) {
          if(window.__s63.stage==='selected') {
            if(!user.includes(memory[1].content)||user.includes(memory[0].content)) throw new Error('Selected Provider Prompt has missing/wrong-project facts');
            if(source==='screen'&&!request.imageUrls.includes('data:image/png;base64,'+imageBase64)) throw new Error('Selected Provider request lost its source Screen image');
            request.selectedFactPromptChecked=true;
            if(window.__s63.holdSelected){window.__s63.providerBlocked++;await new Promise(resolve=>window.__s63.providerWaiters.push(resolve));}
            if(window.__s63.failSelected) {
              request.fixtureFailure=true;
              return new Response(JSON.stringify({error:{message:'S63 controlled Provider failure'}}),{status:503,headers:{'Content-Type':'application/json'}});
            }
            response=answers.selected;
          } else response=window.__s63.stage==='replacement'
            ? 'Answer: For the cache, use a hash map with a doubly linked list to keep each lookup and recency update constant time.'
            : answers.initial;
        }
        else if(system.startsWith('Decide one thing only: whether questionText')) response=JSON.stringify({schemaVersion:2,decision:'not-visual',questionEvidenceSpans:[question],visualEvidenceSpans:[]});
        else if(system.includes('whether the bounded answer')) response=JSON.stringify({schemaVersion:2,decision:'unclear',questionEvidenceSpans:[],answerEvidenceSpans:[],ambiguityReason:'fixture boundary'});
        else {request.unhandled=true;throw new Error('Uncontrolled Provider operation: '+system.slice(0,120));}
        request.response=response;
        return new Response('data: '+JSON.stringify({choices:[{delta:{content:response},finish_reason:null}]})+'\n\n'+
          'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
      };
    }, {memory:inputs.memory??fixtures.S63_MEMORY,answers:inputs.answers??fixtures.S63_PROVIDER_ANSWERS,question:fixtures.S63_SOURCE_QUESTION,
      nextQuestion:fixtures.S63_NEXT_SOURCE_QUESTION,surface:execution.surface,source:execution.source,
      holdFactReview:inputs.holdFactReview??false,guardrailMode:inputs.guardrailMode});
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
    const submitted=execution.source==='voice'
      ? await page.evaluate(text=>window.__s63.meeting.submitRuntimeRegressionText(text),fixtures.S63_SOURCE_QUESTION)
      : await page.evaluate(()=>window.__s63.meeting.captureScreenContext());
    try {
      if(inputs.memory?.length===0) await page.waitForFunction(()=>Boolean(window.__s63.observed.adviseDisplay.stable),undefined,{timeout:5000});
      else await page.getByRole('button',{name:'Quartz Relay',exact:true}).waitFor({timeout:5000});
    }
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
    return {page,context,failures};
  } catch(error) {await context.close();throw error;}
}

async function runConsumerCase(t,bundle,browser,execution) {
  const {page,context,failures}=await openProjectSelectionBrowserHost(t,bundle,browser,execution);
  try {
    const before=await page.evaluate(()=>({id:window.__s63.meeting.taskRuntime.parent.id,
      phase:window.__s63.meeting.taskRuntime.parent.playbookPhase,binding:window.__s63.meeting.taskRuntime.parent.projectBinding,
      sessionId:window.__s63.meeting.meetingSessionId,epoch:JSON.parse(window.__s63.observed.projectChoice.key)[1]}));
    assert.equal(before.binding,undefined);
    if(execution.pauseAt==='storage-before-binding') {
      await page.evaluate(async()=>{window.__s63.holdStorage=true;await window.__s63.setMemoryEntryEnabled('s63_fact_cedar_analytics',false);});
      await page.waitForFunction(()=>window.__s63.storageBlocked>0,undefined,{timeout:5000});
    }
    await page.evaluate(({fail,duplicate,surface,holdProvider})=>{
      window.__s63.stage='selected';window.__s63.failSelected=fail;
      window.__s63.holdSelected=duplicate||holdProvider;window.__s63.duplicateActions=duplicate&&surface==='focus';
    },{fail:execution.behavior==='provider-failure-retry',duplicate:execution.behavior==='duplicate-click',surface:execution.surface,
      holdProvider:execution.pauseAt==='provider-after-binding'});
    if(execution.behavior==='duplicate-click'&&execution.surface==='normal') {
      await page.getByRole('button',{name:'Quartz Relay',exact:true}).evaluate(button=>{button.click();button.click();});
    } else await page.getByRole('button',{name:'Quartz Relay',exact:true}).click();
    if(execution.behavior==='duplicate-click') {
      await page.waitForFunction(()=>window.__s63.providerBlocked>0,undefined,{timeout:5000});
      await page.evaluate(()=>window.__s63.releaseProvider());
    }
    if(execution.behavior==='owner-change') {
      if(execution.pauseAt==='provider-after-binding')await page.waitForFunction(()=>window.__s63.providerBlocked>0,undefined,{timeout:5000});
      await page.waitForFunction(()=>window.__s63.meeting.traces.some(trace=>trace.metadata?.clarifyingRequestId),undefined,{timeout:5000});
      const paused=await page.evaluate(()=>({parent:window.__s63.meeting.taskRuntime.parent,
        trace:window.__s63.meeting.traces.find(trace=>trace.metadata?.clarifyingRequestId),
        providerCount:window.__s63.requests.filter(request=>request.selectedFactPromptChecked).length}));
      assert.equal(paused.parent.id,before.id);
      if(execution.pauseAt==='storage-before-binding') {
        assert.equal(paused.parent.projectBinding,undefined);
        assert.equal(paused.providerCount,0);
      } else {
        assert.equal(paused.parent.projectBinding.projectId,'quartz_relay');
        assert.equal(paused.parent.projectBinding.revision,1);
        assert.equal(paused.providerCount,1);
      }
      await page.evaluate(nextQuestion=>{
        window.__s63.stage='replacement';
        window.__s63.meeting.clearActiveTask();
        window.__s63.replacementPromise=window.__s63.meeting.submitRuntimeRegressionText(nextQuestion);
      },fixtures.S63_NEXT_SOURCE_QUESTION);
      try {
        await page.waitForFunction(oldId=>window.__s63.meeting.taskRuntime.parent?.id&&
          window.__s63.meeting.taskRuntime.parent.id!==oldId,before.id,{timeout:5000});
      } catch(error) {
        t.diagnostic(`replacement ingress=${JSON.stringify(await page.evaluate(()=>({error:window.__s63.meeting.error,
          parent:window.__s63.meeting.taskRuntime.parent,requests:window.__s63.requests.map(request=>({system:request.system.slice(0,100),unhandled:request.unhandled}))})))}`);
        throw error;
      }
      const replacementId=await page.evaluate(()=>window.__s63.meeting.taskRuntime.parent.id);
      await page.evaluate(()=>{window.__s63.releaseStorage();window.__s63.releaseProvider();});
      await page.evaluate(()=>window.__s63.replacementPromise);
      await page.waitForFunction(requestId=>window.__s63.meeting.traces.some(trace=>
        trace.metadata?.clarifyingRequestId===requestId&&['stale','cancelled'].includes(trace.metadata.clarifyingSelectionState)
      ),paused.trace.metadata.clarifyingRequestId,{timeout:5000});
      const completed=await page.evaluate(requestId=>({parent:window.__s63.meeting.taskRuntime.parent,
        selection:window.__s63.observed.selection,activeSelection:window.__s63.observed.activeClarifyingSelection,
        sessionId:window.__s63.meeting.meetingSessionId,
        replayEpochs:window.__s63.meeting.traces.filter(trace=>trace.metadata?.scenarioInputKind==='them-text')
          .map(trace=>trace.metadata.runtimeEpoch),
        answer:window.__s63.observed.adviseDisplay.sections.primaryAnswer,
        trace:window.__s63.meeting.traces.find(trace=>trace.metadata?.clarifyingRequestId===requestId),
        recordings:Array.from(window.__s63.writes.values()),unexpected:window.__s63.unexpected,
        protocolErrors:window.__s63.protocolErrors}),paused.trace.metadata.clarifyingRequestId);
      assert.equal(completed.parent.id,replacementId);
      assert.equal(completed.parent.stableKind,'coding');
      assert.equal(completed.parent.projectBinding,undefined);
      assert.equal(completed.sessionId,before.sessionId);
      assert.ok(completed.replayEpochs.includes(before.epoch+1),'Clear + Replay changes runtime epoch in the same session');
      assert.equal(completed.activeSelection,null,'production target-triple projection must hide the old selection on the new owner');
      assert.ok(!completed.answer.includes(fixtures.S63_FACT_B));
      assert.notEqual(completed.trace.metadata.advisorStablePublicationCommitted,true);
      assert.notEqual(completed.selection?.status,'pending');
      assert.ok(completed.recordings.some(payload=>payload.includes(paused.trace.metadata.clarifyingRequestId)));
      assert.deepEqual(completed.unexpected,[]);
      assert.deepEqual(completed.protocolErrors,[]);
      assert.deepEqual(failures,[]);
      const recorded=await readRecordedSelectionTrace(page,paused.trace.metadata.clarifyingRequestId,completed.trace.metadata.clarifyingSelectionState);
      assert.equal(recorded.id,completed.trace.id);
      assert.notEqual(recorded.metadata.advisorStablePublicationCommitted,true);
      if(execution.surface==='focus') {
        await page.waitForFunction(()=>window.__s63.focusSnapshot?.payload.projectChoice===undefined,undefined,{timeout:5000});
        assert.ok(await page.evaluate(()=>!window.__s63.focusSnapshot.payload.sections.primaryAnswer.includes('For Quartz Relay')));
        assert.equal(await page.evaluate(()=>window.__s63.focusSnapshot.payload.clarifyingSelectionState),undefined);
        assert.equal(await page.evaluate(()=>window.__s63.focusSnapshot.payload.selectedClarifyingAnswerLabel),undefined);
      }
      t.diagnostic(`old selection ${paused.trace.metadata.clarifyingRequestId}: ${completed.trace.metadata.clarifyingSelectionState}; replacement owner preserved; Clear + Replay epoch ${before.epoch} -> ${before.epoch+1}, same session (not same-epoch automatic latest-wins)`);
      return;
    }
    let failedSelection;
    if(execution.behavior==='provider-failure-retry') {
      await page.waitForFunction(()=>window.__s63.observed.selection?.status==='failed',undefined,{timeout:15000});
      failedSelection=await page.evaluate(()=>({selection:window.__s63.observed.selection,
        parent:window.__s63.meeting.taskRuntime.parent,answer:window.__s63.observed.adviseDisplay.sections.primaryAnswer}));
      assert.equal(failedSelection.parent.id,before.id);
      assert.equal(failedSelection.parent.projectBinding.projectId,'quartz_relay');
      assert.equal(failedSelection.parent.projectBinding.revision,1,'binding commits before a Provider failure');
      assert.ok(!failedSelection.answer.includes(fixtures.S63_FACT_B),'failed generation must preserve the previous visible answer');
      await page.waitForFunction(requestId=>window.__s63.meeting.traces.some(trace=>
        trace.metadata?.clarifyingRequestId===requestId&&trace.metadata.clarifyingSelectionState==='failed'
      ),failedSelection.selection.requestId,{timeout:5000});
      await page.evaluate(()=>{window.__s63.failSelected=false;});
      await page.getByRole('button',{name:'Retry project answer',exact:true}).click();
    }
    try {
      await page.waitForFunction(()=>window.__s63.observed.selection?.status==='succeeded',undefined,{timeout:10000});
    } catch(error) {
      t.diagnostic(`selection failure=${JSON.stringify(await page.evaluate(()=>({
        selection:window.__s63.observed.selection,error:window.__s63.meeting.error,
        parent:window.__s63.meeting.taskRuntime.parent&&{id:window.__s63.meeting.taskRuntime.parent.id,binding:window.__s63.meeting.taskRuntime.parent.projectBinding},
        unexpected:window.__s63.unexpected,protocolErrors:window.__s63.protocolErrors,
        requests:window.__s63.requests.map(request=>({system:request.system.slice(0,80),selectedFactPromptChecked:request.selectedFactPromptChecked,unhandled:request.unhandled})),
        trace:window.__s63.meeting.traces.map(trace=>({id:trace.id,status:trace.status,error:trace.error,
          metadata:Object.fromEntries(Object.entries(trace.metadata??{}).filter(([key])=>/clarifying|projectBinding|advisorOutput|rejection|stale|cancellation|failure|Error/i.test(key)))})),
      })))}`);
      throw error;
    }
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
    if(execution.behavior!=='duplicate-click')assert.equal(after.requests.filter(request=>!request.fixtureFailure).length,1);
    if(failedSelection) {
      assert.notEqual(after.selection.requestId,failedSelection.selection.requestId);
      assert.ok(after.requests.some(request=>request.fixtureFailure));
      const attempts=await page.evaluate(()=>window.__s63.meeting.traces.filter(trace=>trace.metadata?.clarifyingRequestId));
      assert.equal(attempts.filter(trace=>trace.metadata.projectBindingSettlementCommitted===true&&
        trace.metadata.projectBindingSettlementNextRevision>trace.metadata.projectBindingSettlementPreviousRevision).length,1);
      assert.ok(attempts.every(trace=>trace.metadata.clarifyingSelectionState!=='pending'));
      assert.ok(after.recording.some(payload=>payload.includes(failedSelection.selection.requestId)));
    }
    if(execution.behavior==='duplicate-click') {
      const attempts=await page.evaluate(()=>window.__s63.meeting.traces.filter(trace=>trace.metadata?.clarifyingRequestId));
      assert.ok(attempts.length>=1&&attempts.length<=2);
      assert.equal(attempts.filter(trace=>trace.metadata.projectBindingSettlementCommitted===true&&
        trace.metadata.projectBindingSettlementNextRevision>trace.metadata.projectBindingSettlementPreviousRevision).length,1);
      assert.equal(attempts.filter(trace=>trace.metadata.advisorStablePublicationCommitted===true).length,1);
      assert.ok(attempts.every(trace=>['succeeded','stale','failed','cancelled'].includes(trace.metadata.clarifyingSelectionState)),
        JSON.stringify(attempts.map(trace=>({status:trace.status,requestId:trace.metadata.clarifyingRequestId,selection:trace.metadata.clarifyingSelectionState}))));
      if(execution.surface==='focus')assert.equal(await page.evaluate(()=>window.__s63.transportDeliveries
        .filter(message=>message.channel==='action'&&message.payload.type==='clarifying-answer').length),2);
    }
    assert.ok(after.traces.some(trace=>trace.metadata.advisorStablePublicationCommitted===true));
    assert.ok(after.recording.some(payload=>payload.includes(after.selection.requestId)));
    const recorded=await readRecordedSelectionTrace(page,after.selection.requestId,'succeeded');
    assert.equal(recorded.metadata.projectBindingProjectId,'quartz_relay');
    if(failedSelection)await readRecordedSelectionTrace(page,failedSelection.selection.requestId,'failed');
    if(execution.source==='screen') {
      assert.ok(after.requests.every(request=>request.imageUrls.length>0),'Screen-selected generation must retain source image');
      assert.ok(await page.evaluate(()=>window.__s63.requests.filter(r=>r.selectedFactPromptChecked)
        .every(r=>r.imageUrls.includes('data:image/png;base64,'+window.__s63.imageBase64))),'selected request must use captured image exactly');
      assert.ok(await page.evaluate(()=>{
        const expected=atob(window.__s63.imageBase64);
        return Array.from(window.__s63.binaryWrites.values()).some(bytes=>bytes.length===expected.length&&
          bytes.every((byte,index)=>byte===expected.charCodeAt(index)));
      }),'recorded Screen bytes must match the actual capture transport image');
    }
    if(execution.surface==='focus') {
      await page.waitForFunction(()=>window.__s63.focusSnapshot?.payload.sections.primaryAnswer.includes('For Quartz Relay'),undefined,{timeout:5000});
      assert.ok(await page.evaluate(()=>window.__s63.transportMessages.some(message=>message.channel==='action'&&message.payload.type==='clarifying-answer'&&message.payload.option?.value==='quartz_relay')));
      assert.ok(await page.evaluate(()=>window.__s63.protocolEvents.some(event=>event.event==='applied'&&event.displayTarget?.traceId===window.__s63.observed.adviseDisplay.target.traceId)));
      assert.deepEqual(await page.evaluate(()=>window.__s63.protocolErrors),[]);
    }
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
  } finally { await context.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
test('S63 finite real consumer executions',{timeout:120000,skip:browserTestSkip},async t=>{
  const enabled=new Set((process.env.S63_EXECUTIONS??fixtures.S63_CONSUMER_EXECUTIONS.map(item=>item.executionId).join(',')).split(','));
  const implemented=new Set(fixtures.S63_CONSUMER_EXECUTIONS.map(item=>item.executionId));
  for(const id of enabled)assert.ok(implemented.has(id),`${id} is not implemented; a success-only route cannot certify retry/duplicate/stale cases`);
  const bundle=await browserBundle();
  const browser=await playwright.chromium.launch({headless:true,executablePath:process.env.JARVIS_CHROMIUM_EXECUTABLE});
  try {
    for(const execution of fixtures.S63_CONSUMER_EXECUTIONS.filter(item=>enabled.has(item.executionId))) {
      let failed=false;
      await t.test(execution.executionId,async child=>{
        try {await runConsumerCase(child,bundle,browser,execution);}
        catch(error){failed=true;throw error;}
      });
      if(failed)break;
    }
  }finally{await browser.close();}
});
}
