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
      window.__s63.sendFocusAction=sendFocusAction;
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
    await page.evaluate(({memory,answers,question,nextQuestion,surface,source,holdFactReview,guardrailMode,settings}) => {
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
          // Task 178 LG: the level of the call is applied and every entry is taken. An invalid level rejects, as on native.
          if (name==='write_diagnostic_log') {
            if (!['error','warn','info','debug','trace'].includes(args.level)) throw new Error('Diagnostic log level is not one of error, warn, info, debug, trace');
            return {v:1,appliedLevel:args.level,accepted:(args.entries??[]).length,filtered:0,rejected:0,dropped:0,
              sink:{state:'ready',droppedTotal:0,writeFailures:0,unsavedAtExit:0}};
          }
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
      // inputs.settings (Task 178 LG) overrides single stored settings; without it the store is what it was.
      localStorage.setItem('meeting_assistant_settings',JSON.stringify({debugMode:true,microphoneContextEnabled:false,semanticTaxonomyMode:'off',useMemory:true,
        personalEvidenceGuardrailMode:guardrailMode??'enforcement',...settings}));
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
    }, {memory:inputs.memory??fixtures.S63_MEMORY,answers:inputs.answers??fixtures.S63_PROVIDER_ANSWERS,question:inputs.question??fixtures.S63_SOURCE_QUESTION,
      nextQuestion:fixtures.S63_NEXT_SOURCE_QUESTION,surface:execution.surface,source:execution.source,
      holdFactReview:inputs.holdFactReview??false,guardrailMode:inputs.guardrailMode,settings:inputs.settings??{}});
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    try {
      await page.waitForFunction(() => Boolean(window.__s63.meeting), undefined, { timeout: 10000 });
    } catch (error) {
      t.diagnostic(`mount errors=${JSON.stringify(failures)}; boundary errors=${JSON.stringify(await page.evaluate(()=>window.__s63.unexpected))}`);
      throw error;
    }
    t.diagnostic(`mounted Hook; external commands=${JSON.stringify(await page.evaluate(()=>window.__s63.calls.filter(c=>c.name).map(c=>c.name)))}`);
    // inputs.mountOnly (Task 178 LG) hands the mounted Hook to the caller, which starts and feeds the session itself.
    if(inputs.mountOnly)return {page,context,failures};
    const started = await page.evaluate(() => window.__s63.meeting.startRuntimeRegressionRun());
    t.diagnostic(`Replay start=${started}; unexpected=${JSON.stringify(await page.evaluate(()=>window.__s63.unexpected))}`);
    assert.equal(started, true, JSON.stringify(await page.evaluate(()=>({error:window.__s63.meeting.error,recording:window.__s63.meeting.sessionRecording,unexpected:window.__s63.unexpected}))));
    const submitted=execution.source==='voice'
      ? await page.evaluate(text=>window.__s63.meeting.submitRuntimeRegressionText(text),inputs.question??fixtures.S63_SOURCE_QUESTION)
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
// ===========================================================================
// Task 178A (AE1, AE3, AE5, AE6, AE7): whole inputs through the mounted Hook in
// a real browser. The stream is reached only inside this test bundle; the
// observer below is a test-side consumer and not a production executor.
// ===========================================================================

// Expose the Hook's own stream at its return, inside the test bundle only.
const criticalEventStreamPlugin = {
  name: "ae-critical-event-stream",
  setup(builder) {
    builder.onLoad({filter:/useMeetingAssistant\.ts$/},args=>{
      const source=readFileSync(args.path,"utf8");
      const file=ts.createSourceFile(args.path,source,ts.ScriptTarget.Latest,true);
      const hook=file.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='useMeetingAssistant');
      assert.ok(hook?.body);
      const returns=hook.body.statements.filter(ts.isReturnStatement);
      assert.equal(returns.length,1,'expose the stream at the actual Hook return, without replacing any callback');
      const at=returns[0].getStart(file);
      // __aeTick lets a case arrange a failure mode before the first fact exists.
      const exposure=`window.__ae = { stream: runtimeCriticalEventStreamRef.current,
        recording: () => sessionRecordingManagerRef.current?.getState(),
        recorderRef: sessionRecordingManagerRef,
        settlement: () => currentQuestionSettlementRef.current };
        window.__aeTick?.(window.__ae);\n`;
      return {contents:source.slice(0,at)+exposure+source.slice(at),loader:'ts',resolveDir:path.dirname(args.path)};
    });
  },
};
const leafBundle=await build({entryPoints:["src/lib/meeting/runtime-critical-event.ts"],bundle:true,
  platform:"node",format:"cjs",write:false,logLevel:"silent"});
const leafModule={exports:{}};
new Function("module","exports","require",leafBundle.outputFiles[0].text)(leafModule,leafModule.exports,require);
const {parseRuntimeCriticalEventJournal}=leafModule.exports;
const JOURNAL='runtime-events/critical-events.v1.jsonl';
const label=event=>event.terminal?`${event.fact}:${event.terminal.object}:${event.terminal.disposition}`:`${event.fact}:${event.stage}`;
// The production reader over what the mounted Hook's real recorder wrote.
async function readJournal(page) {
  const journal=parseRuntimeCriticalEventJournal(await page.evaluate(file=>window.__s63.writes.get(file),JOURNAL));
  assert.equal(journal.status,'ok');
  return journal;
}
// Each named fact must appear, in this relative order.
function assertOrdered(events,expected,what) {
  let from=0;
  const indexes=[];
  for(const name of expected) {
    const index=events.findIndex((event,position)=>position>=from&&label(event)===name);
    assert.notEqual(index,-1,`${what}: ${name} missing or out of order in ${JSON.stringify(events.map(label))}`);
    indexes.push(index);
    from=index+1;
  }
  return indexes.map(index=>events[index]);
}
// A test-side observer in the page: collects deliveries and resolves one-shot
// waits from the subscriber itself. No timer and no polling of runtime state.
// It is a function of the page, so a case can install one inside its own turn.
// A wait given a sequence first reads what was already delivered after it, so
// a wait chained from another wait cannot miss a fact of the same batch.
const observerSource=`(name=>{
  const observer={log:[],waits:[]};
  const answer=(wait,delivery)=>{
    if(delivery.kind==='closed')return {status:'closed',reason:delivery.reason,discarded:delivery.discarded};
    if(delivery.kind!=='event')return {status:'incomplete',reason:delivery.reason};
    if(wait.matches(delivery.event))return {status:'matched',event:delivery.event};
    if(wait.endsOn?.(delivery.event))return {status:'ended',event:delivery.event};
  };
  const subscription=window.__ae.stream.subscribe(delivery=>{
    observer.log.push(delivery);
    for(const wait of observer.waits.splice(0)) {
      const result=answer(wait,delivery);
      if(result)wait.resolve(result);
      else observer.waits.push(wait);
    }
  });
  observer.until=(matches,endsOn,afterSequence)=>new Promise(resolve=>{
    const wait={matches,endsOn,resolve};
    if(afterSequence!==undefined) {
      for(const delivery of observer.log) {
        if(delivery.kind==='event'&&delivery.event.sequence<=afterSequence)continue;
        const result=answer(wait,delivery);
        if(result)return resolve(result);
      }
    }
    observer.waits.push(wait);
  });
  observer.subscription={accepted:subscription.accepted,reason:subscription.reason,runtimeSessionId:subscription.runtimeSessionId};
  window[name]=observer;
  return observer;
})`;
async function installObserver(page,name='__aeObserver') {
  await page.evaluate(source=>{window.__aeInstallObserver=(0,eval)(source);},observerSource);
  return page.evaluate(name=>{
    const {accepted,runtimeSessionId}=window.__aeInstallObserver(name).subscription;
    return {accepted,runtimeSessionId};
  },name);
}
const deliveredEvents=async(page,name='__aeObserver')=>
  (await page.evaluate(name=>window[name].log,name)).filter(delivery=>delivery.kind==='event').map(delivery=>delivery.event);
// A test-side hold of one answer generation request (Main Advisor or Screen
// solver) at the external fetch boundary. The product code is untouched.
async function installGenerationHold(page) {
  await page.evaluate(()=>{
    const underlying=window.fetch;
    const hold={armed:false,blocked:0,waiters:[],release(){this.armed=false;for(const release of this.waiters.splice(0))release();}};
    window.__aeHold=hold;
    window.fetch=async(url,init)=>{
      const system=JSON.parse(init.body).messages.find(message=>message.role==='system')?.content??'';
      if(hold.armed&&(system.startsWith('You are a live meeting co-pilot')||system.startsWith('You are Jarvis, a private live meeting assistant'))) {
        hold.armed=false;hold.blocked++;
        await new Promise(resolve=>hold.waiters.push(resolve));
      }
      return underlying(url,init);
    };
  });
}
// A host with no project memory: the source question is answered directly.
const openAnswered=async(child,bundle,browser,source='voice')=>{
  const opened=await openProjectSelectionBrowserHost(child,bundle,browser,{surface:'normal',source},{memory:[]});
  await opened.page.waitForFunction(()=>Boolean(window.__s63.observed.adviseDisplay.stable),undefined,{timeout:8000});
  return opened;
};
const stats=page=>page.evaluate(()=>JSON.parse(JSON.stringify(window.__ae.stream.getStats())));
// Ids are allocated per run: each distinct identifier becomes its order of
// first appearance, business values stay as they are.
const IDENTIFIERS=new Set(['traceId','operationId','requestId','attemptId','executionPlanId','turnId','logicalQuestionUnitId',
  'settlementId','receiptId','taskId','generationLeaseId','advisorJobId','suggestionId','generationId','manualActionId',
  'scenarioRunId','scenarioStepId','sourceTurnIds','sourceObservationIds']);
function normalizeFormal(events) {
  const aliases=new Map();
  const alias=(kind,value)=>{
    const key=`${kind}|${value}`;
    if(!aliases.has(key))aliases.set(key,`${kind}#${[...aliases.keys()].filter(item=>item.startsWith(`${kind}|`)).length+1}`);
    return aliases.get(key);
  };
  return events.filter(event=>event.purpose==='formal').map(event=>({
    fact:event.fact,stage:event.stage,terminal:event.terminal&&{...event.terminal},epochKnown:event.runtimeEpoch!==undefined,
    refs:Object.fromEntries(Object.entries(event.refs).map(([key,value])=>[key,!IDENTIFIERS.has(key)?value:
      Array.isArray(value)?value.map(item=>alias(key,item)):alias(key,value)])),
    omittedRefs:event.omittedRefs,digestedRefs:event.digestedRefs,
  }));
}

// The cases, each [execution id, name, run]. They run as subtests of the one
// top-level consumer test of this file, after the S63 executions.
const aeCases=[];
{
    for(const source of ['voice','screen']) {
      aeCases.push([`AE1-${source}`,`AE1 ${source} entry: acceptance, settlement, commit and display are distinct facts in the owner's order, saved by the real recorder`,async(child,bundle,browser)=>{
        const {page,context,failures}=await openProjectSelectionBrowserHost(child,bundle,browser,{surface:'normal',source});
        try {
          // The stable Answer of the source question is on screen.
          await page.waitForFunction(()=>Boolean(window.__s63.observed.adviseDisplay.stable),undefined,{timeout:5000});
          const sessionId=await page.evaluate(()=>window.__s63.meeting.meetingSessionId);
          const journal=await readJournal(page);
          const session=journal.sessions.find(candidate=>candidate.runtimeSessionId===sessionId);
          assert.ok(session,'the recording holds this runtime session');
          assert.deepEqual(session.gaps,[],'no hole in the saved sequence');
          assert.equal(session.firstSequence,1);
          const events=session.events;
          child.diagnostic(`${source} facts=${JSON.stringify(events.map(label))}`);
          const accepted=events.find(event=>event.fact==='input-accepted');
          assert.ok(accepted);
          const ofTrace=events.filter(event=>event.refs.traceId===accepted.refs.traceId);
          // Voice adopts its settlement before the source-owned lifecycle commit;
          // Screen adopts it only after that commit returned its receipt.
          const ordered=assertOrdered(ofTrace,source==='voice'?[
            'input-accepted:canonical-turn-ingress-admitted','lqu-committed:canonical-publish',
            'type-settled:settlement-adopted','relation-settled:settlement-adopted',
            'lifecycle-committed:task-writer-committed',
            'generation-admitted:ledger-entry-created','provider-request-started:request-start',
            'terminal:provider-request:success','stable-answer-committed:stable-publication',
            'terminal:generation:committed','first-visible-content:stable',
          ]:[
            'input-accepted:screen-operation-claimed','lifecycle-committed:task-writer-committed',
            'type-settled:settlement-adopted','relation-settled:settlement-adopted',
            'generation-admitted:ledger-entry-created','provider-request-started:request-start',
            'terminal:provider-request:success','stable-answer-committed:stable-publication',
            'terminal:generation:committed','terminal:screen-operation:released','first-visible-content:stable',
          ],`${source} whole path`);
          assert.equal(ofTrace.length,ordered.length,'no other fact was produced for this input');
          const fact=name=>ordered.find(event=>label(event).startsWith(name));
          if(source==='voice') {
            assert.deepEqual([accepted.refs.transport,accepted.refs.scenarioStepId],['manual-text','step-1']);
            assert.equal(fact('lqu-committed').refs.turnId,accepted.refs.turnId);
            assert.equal(fact('type-settled').refs.logicalQuestionUnitId,fact('lqu-committed').refs.logicalQuestionUnitId);
          } else {
            assert.equal(accepted.refs.operationKind,'screen-operation');
            assert.equal(events.some(event=>event.fact==='lqu-committed'),false,'Screen never commits a session LQU');
            assert.equal(fact('provider-request-started').refs.operationId,accepted.refs.operationId);
            assert.deepEqual(fact('terminal:screen-operation').terminal,{object:'screen-operation',disposition:'released'},
              'an operation that captured and answered names no reason at release');
          }
          assert.equal(fact('relation-settled').refs.settlementId,fact('type-settled').refs.settlementId);
          const started=fact('provider-request-started');
          assert.equal(started.refs.operationKind,source==='voice'?'main-advisor':'screen-solver');
          assert.equal(started.refs.generationLeaseId,fact('generation-admitted').refs.generationLeaseId);
          assert.equal(started.refs.attemptId,undefined,'no physical attempt exists at the logical start');
          const providerTerminal=fact('terminal:provider-request');
          assert.equal(providerTerminal.refs.requestId,started.refs.requestId);
          assert.ok(providerTerminal.refs.attemptId,'the attempt is named by its own terminal');
          const stable=fact('stable-answer-committed');
          assert.equal(fact('terminal:generation').refs.generationLeaseId,started.refs.generationLeaseId);
          assert.equal(fact('terminal:generation').refs.stableRevision,stable.refs.stableRevision);
          const visible=fact('first-visible-content');
          assert.deepEqual([visible.refs.suggestionId,visible.refs.stableRevision,visible.refs.displaySurface],
            [stable.refs.suggestionId,stable.refs.stableRevision,'normal-mode']);
          assert.equal(events.filter(event=>event.fact==='first-visible-content'&&
            event.refs.suggestionId===stable.refs.suggestionId&&event.refs.stableRevision===stable.refs.stableRevision).length,1,
            'the display effect re-runs; the first-visible fact does not repeat');
          // Bounded values of references only: no prompt, answer, image or secret.
          const text=JSON.stringify(events);
          for(const forbidden of [fixtures.S63_SOURCE_QUESTION,'A useful project explanation','data:image','{{SYSTEM_PROMPT}}','curl ']) {
            assert.equal(text.includes(forbidden),false,`no payload text in events: ${forbidden.slice(0,20)}`);
          }
          assert.ok(events.every(event=>event.schemaVersion===1&&JSON.stringify(event).length<=2048+200));
          assert.ok(events.every(event=>event.purpose==='formal'),'Cross-checks is off: no observation fact');
          // The same generation for every saved line, and the manifest untouched by events.
          assert.equal(new Set(events.map(event=>event.recordingGenerationId)).size,1);
          assert.deepEqual(await page.evaluate(()=>window.__s63.unexpected),[]);
          assert.deepEqual(failures,[]);
        } finally {await context.close();}
      }]);
    }

    aeCases.push(['AE7-screen-latest-wins','AE7 latest-wins: the observer waits for A\'s real Provider-start fact, then B enters through the same Screen entry while A\'s request is in flight; B\'s capture ends A (request aborted, generation aborted, Screen operation rejected as stale) and B commits and is shown',async(child,bundle,browser)=>{
      const {page,context,failures}=await openAnswered(child,bundle,browser,'voice');
      try {
        const sessionId=await page.evaluate(()=>window.__s63.meeting.meetingSessionId);
        // Registered before A exists.
        assert.deepEqual(await installObserver(page),{accepted:true,runtimeSessionId:sessionId});
        await installGenerationHold(page);
        await page.evaluate(()=>{
          const o=window.__aeObserver;
          window.__aeHold.armed=true;
          // The wait ends on A's Provider-start fact, or on A's own Screen terminal if it never starts.
          o.startOfA=o.until(event=>event.fact==='provider-request-started'&&event.purpose==='formal'&&
            event.refs.operationKind==='screen-solver',event=>event.fact==='terminal'&&event.terminal.object==='screen-operation');
          // B is submitted from the delivery of that fact, through the same original entry, while A is in flight.
          o.submittedB=o.startOfA.then(result=>{
            if(result.status!=='matched')return result;
            o.heldAtFact=window.__aeHold.blocked;
            window.__s63.stage='replacement';
            o.captureB=window.__s63.meeting.captureScreenContext();
            return result;
          });
          // B is on screen: the first-visible fact that follows A's start.
          o.visibleB=o.submittedB.then(result=>result.status!=='matched'?result:
            o.until(event=>event.fact==='first-visible-content'&&event.sequence>result.event.sequence));
          o.captureA=window.__s63.meeting.captureScreenContext();
        });
        const reached=await page.evaluate(()=>window.__aeObserver.submittedB);
        assert.equal(reached.status,'matched',JSON.stringify(reached));
        const startOfA=reached.event;
        assert.equal(await page.evaluate(()=>window.__aeObserver.heldAtFact),1,'A\'s solver request was really dispatched and is in flight');
        const visibleB=await page.evaluate(()=>window.__aeObserver.visibleB);
        assert.equal(visibleB.status,'matched',JSON.stringify(visibleB));
        // Release A's request only now: B has committed and is shown.
        const endOfA=await page.evaluate(operationId=>{
          const o=window.__aeObserver;
          const ended=o.until(event=>event.fact==='terminal'&&event.terminal.object==='screen-operation'&&event.refs.operationId===operationId);
          window.__aeHold.release();
          return ended;
        },startOfA.refs.operationId);
        assert.equal(endOfA.status,'matched',JSON.stringify(endOfA));
        await page.evaluate(()=>Promise.all([window.__aeObserver.captureA,window.__aeObserver.captureB]));
        const delivered=await deliveredEvents(page);
        child.diagnostic(`AE7 latest-wins facts=${JSON.stringify(delivered.map(event=>`${event.sequence} ${label(event)}`))}`);
        assert.deepEqual((await page.evaluate(()=>window.__aeObserver.log)).filter(delivery=>delivery.kind!=='event'),[],'no gap and no close during the run');
        // A: accepted and started, then ended by B's capture. It commits and shows nothing.
        const ofA=delivered.filter(event=>event.refs.traceId===startOfA.refs.traceId);
        const tail=ofA.filter(event=>event.sequence>startOfA.sequence);
        assert.deepEqual(tail.map(event=>[label(event),event.terminal?.reason]),[
          ['terminal:provider-request:aborted',undefined],
          ['terminal:generation:aborted','provider-request-aborted'],
          ['terminal:screen-operation:stale-rejected','parent-revision-mismatch'],
        ],'A\'s real latest-wins terminals, in its owners\' order');
        assert.equal(tail[0].refs.requestId,startOfA.refs.requestId,'the request that started is the one aborted');
        assert.equal(tail[1].refs.generationLeaseId,startOfA.refs.generationLeaseId);
        assert.equal(tail[2].refs.operationId,startOfA.refs.operationId);
        assert.equal(ofA.some(event=>event.fact==='stable-answer-committed'||event.fact==='first-visible-content'),false,'A commits and shows nothing');
        // B: accepted after A's Provider-start fact, and the latest owner commits and is shown.
        const acceptedB=delivered.find(event=>event.fact==='input-accepted'&&event.sequence>startOfA.sequence);
        assert.ok(acceptedB,'B was accepted through the Screen entry after A\'s Provider-start fact');
        assert.equal(acceptedB.sequence,startOfA.sequence+1,'B is the next fact after A\'s start: A was still in flight');
        assert.notEqual(acceptedB.refs.operationId,startOfA.refs.operationId);
        const ofB=delivered.filter(event=>event.refs.traceId===acceptedB.refs.traceId);
        assertOrdered(ofB,['input-accepted:screen-operation-claimed','generation-admitted:ledger-entry-created',
          'provider-request-started:request-start','terminal:provider-request:success','stable-answer-committed:stable-publication',
          'terminal:generation:committed','terminal:screen-operation:released','first-visible-content:stable'],'B whole path');
        assert.equal(visibleB.event.refs.traceId,acceptedB.refs.traceId,'what became visible is B');
        assert.ok(tail[0].sequence>visibleB.event.sequence,'A\'s terminals arrived after B was shown');
        assert.ok((await page.evaluate(()=>window.__s63.observed.adviseDisplay.sections.primaryAnswer)).includes('doubly linked list'));
        // Sequence: monotonic per session, no hole, as delivered.
        assert.deepEqual(delivered.map(event=>event.sequence),delivered.map((_,index)=>delivered[0].sequence+index));
        // AE6: what the observer received is what the real recorder saved, same identity and order.
        const journal=await readJournal(page);
        const saved=journal.sessions.find(candidate=>candidate.runtimeSessionId===sessionId).events;
        const savedTail=saved.filter(event=>event.sequence>=delivered[0].sequence&&event.sequence<=delivered.at(-1).sequence);
        assert.deepEqual(savedTail.map(({recordingSessionId,recordingGenerationId,...event})=>event),delivered);
        assert.equal(journal.contiguous,true);
        const after=await stats(page);
        assert.deepEqual([after.overflowDropped,after.subscriberFailures,after.staleSessionRejected],[0,0,0]);
        assert.deepEqual(await page.evaluate(()=>window.__s63.unexpected),[]);
        assert.deepEqual(failures,[]);
      } finally {await context.close();}
    }]);

    aeCases.push(['AE7-cancel','AE7 cancel at the Main Advisor: the observer waits for A\'s real Provider-start fact, then the test clears the task and submits B through the Replay text entry; A ends by its own cancelled terminal (a cancel by Clear, not latest-wins)',async(child,bundle,browser)=>{
      const {page,context,failures}=await openProjectSelectionBrowserHost(child,bundle,browser,{surface:'normal',source:'voice'});
      try {
        const before=await page.evaluate(()=>({parentId:window.__s63.meeting.taskRuntime.parent.id,sessionId:window.__s63.meeting.meetingSessionId}));
        // Registered before A exists.
        const observer=await installObserver(page);
        assert.deepEqual(observer,{accepted:true,runtimeSessionId:before.sessionId});
        await page.evaluate(nextQuestion=>{
          const o=window.__aeObserver;
          window.__s63.stage='selected';window.__s63.holdSelected=true;
          // The wait ends on A's Provider-start fact, or on A's own generation terminal if it never starts.
          o.startOfA=o.until(event=>event.fact==='provider-request-started'&&event.purpose==='formal'&&
            event.refs.operationKind==='main-advisor',event=>event.fact==='terminal'&&event.terminal.object==='generation');
          // B is submitted from the delivery of that fact, through the original entries.
          o.submittedB=o.startOfA.then(result=>{
            if(result.status!=='matched')return result;
            o.providerBlockedAtFact=window.__s63.providerBlocked;
            window.__s63.stage='replacement';
            window.__s63.meeting.clearActiveTask();
            o.replacement=window.__s63.meeting.submitRuntimeRegressionText(nextQuestion);
            return result;
          });
          // B's own facts say that B was accepted and that its answer is on screen
          // (or that its generation ended without one).
          o.acceptedB=o.submittedB.then(result=>result.status!=='matched'?result:
            o.until(event=>event.fact==='input-accepted'&&event.refs.transport==='manual-text',undefined,result.event.sequence));
          o.visibleB=o.acceptedB.then(result=>result.status!=='matched'?result:
            o.until(event=>event.fact==='first-visible-content'&&event.refs.traceId===result.event.refs.traceId,
              event=>event.fact==='terminal'&&event.terminal.object==='generation'&&event.refs.traceId===result.event.refs.traceId&&
                event.terminal.disposition!=='committed',result.event.sequence));
        },fixtures.S63_NEXT_SOURCE_QUESTION);
        // A: the real clarifying answer, through the real button.
        await page.getByRole('button',{name:'Quartz Relay',exact:true}).click();
        const reached=await page.evaluate(()=>window.__aeObserver.submittedB);
        assert.equal(reached.status,'matched',JSON.stringify(reached));
        const startOfA=reached.event;
        // Release A's provider only now: B was already submitted.
        await page.evaluate(()=>window.__s63.releaseProvider());
        // B's end is read from B's own first-visible fact: no poll of the trace or of the page.
        const visibleB=await page.evaluate(()=>window.__aeObserver.visibleB);
        assert.equal(visibleB.status,'matched',JSON.stringify(visibleB));
        assert.ok((await page.evaluate(()=>window.__s63.observed.adviseDisplay.stable?.suggestion.content)).includes('doubly linked list'),
          'the first-visible fact is the display\'s own acknowledgement: the answer is already on screen');
        // Consistency only: the runner's own promise for B agrees.
        assert.equal(await page.evaluate(()=>window.__aeObserver.replacement),true,'B ran to its recorded terminal');
        const result=await page.evaluate(()=>({log:window.__aeObserver.log,parent:window.__s63.meeting.taskRuntime.parent,
          answer:window.__s63.observed.adviseDisplay.sections.primaryAnswer,stats:window.__ae.stream.getStats(),
          selectedRequests:window.__s63.requests.filter(request=>request.selectedFactPromptChecked).length}));
        const delivered=result.log.filter(delivery=>delivery.kind==='event').map(delivery=>delivery.event);
        child.diagnostic(`AE7 facts=${JSON.stringify(delivered.map(event=>`${event.sequence} ${label(event)}`))}`);
        assert.deepEqual(result.log.filter(delivery=>delivery.kind!=='event'),[],'no gap and no close during the run');
        assert.equal(result.selectedRequests,1,'A\'s provider request was really dispatched');
        // A: started, never a Stable Answer, ended by its own terminals.
        const ofA=delivered.filter(event=>event.refs.generationLeaseId===startOfA.refs.generationLeaseId||event.refs.traceId===startOfA.refs.traceId);
        const generationTerminalOfA=ofA.find(event=>event.fact==='terminal'&&event.terminal.object==='generation');
        assert.ok(generationTerminalOfA,'A has an explicit generation terminal');
        // Clear cancelled A before B existed: the exact terminal of that cancel.
        assert.deepEqual([generationTerminalOfA.terminal.disposition,generationTerminalOfA.terminal.reason],
          ['cancelled','active-task-cleared']);
        const cleared=delivered.find(event=>event.fact==='lifecycle-committed'&&event.refs.transition==='clear-all'&&event.sequence>startOfA.sequence);
        assert.ok(cleared&&generationTerminalOfA.sequence<cleared.sequence,'A was cancelled by the clear, before B was accepted');
        assert.equal(ofA.some(event=>event.fact==='stable-answer-committed'),false,'A commits no answer');
        assert.equal(ofA.some(event=>event.fact==='first-visible-content'&&event.sequence>startOfA.sequence),false,'A shows nothing');
        // B: accepted after A's Provider-start fact, and the latest owner commits.
        const acceptedB=delivered.find(event=>event.fact==='input-accepted'&&event.refs.transport==='manual-text'&&event.sequence>startOfA.sequence);
        assert.ok(acceptedB,'B was accepted through the canonical ingress after A\'s Provider-start fact');
        assert.ok(acceptedB.sequence>generationTerminalOfA.sequence,'B arrived after A had already ended: this run shows a cancel, not latest-wins');
        assert.equal(acceptedB.refs.scenarioStepId,'step-2');
        assert.equal(visibleB.event.refs.traceId,acceptedB.refs.traceId,'what became visible is B');
        assert.ok(acceptedB.runtimeEpoch>startOfA.runtimeEpoch,'Clear advanced the epoch between A and B');
        const ofB=delivered.filter(event=>event.refs.traceId===acceptedB.refs.traceId);
        assertOrdered(ofB,['input-accepted:canonical-turn-ingress-admitted','lqu-committed:canonical-publish',
          'generation-admitted:ledger-entry-created','provider-request-started:request-start',
          'stable-answer-committed:stable-publication','terminal:generation:committed'],'B whole path');
        assert.ok(generationTerminalOfA.sequence>startOfA.sequence);
        assert.notEqual(result.parent.id,before.parentId);
        assert.ok(result.answer.includes('doubly linked list'));
        // Sequence: monotonic per session, no hole, as delivered.
        assert.deepEqual(delivered.map(event=>event.sequence),delivered.map((_,index)=>delivered[0].sequence+index));
        // AE6: what the observer received is what the real recorder saved, same identity and order.
        const journal=await readJournal(page);
        const saved=journal.sessions.find(candidate=>candidate.runtimeSessionId===before.sessionId).events;
        const savedTail=saved.filter(event=>event.sequence>=delivered[0].sequence&&event.sequence<=delivered.at(-1).sequence);
        assert.deepEqual(savedTail.map(({recordingSessionId,recordingGenerationId,...event})=>event),delivered);
        assert.equal(journal.contiguous,true);
        assert.equal(result.stats.overflowDropped,0);
        assert.equal(result.stats.subscriberFailures,0);
        assert.deepEqual(await page.evaluate(()=>window.__s63.unexpected),[]);
        assert.deepEqual(failures,[]);
      } finally {await context.close();}
    }]);

    aeCases.push(['AE7-advisor-latest-wins','AE7 latest-wins at the Main Advisor: the observer waits for the real Provider-start fact of a regenerate (A), then B enters through the Screen entry while A\'s Advisor request is in flight; B commits and is shown, and A ends by its own generation and manual-action terminals with no Stable Answer, no visible fact and no provider terminal',async(child,bundle,browser)=>{
      const {page,context,failures}=await openAnswered(child,bundle,browser,'voice');
      try {
        const sessionId=await page.evaluate(()=>window.__s63.meeting.meetingSessionId);
        // Registered before A exists.
        assert.deepEqual(await installObserver(page),{accepted:true,runtimeSessionId:sessionId});
        await installGenerationHold(page);
        await page.evaluate(()=>{
          const o=window.__aeObserver;
          window.__aeHold.armed=true;
          // The wait ends on A's Provider-start fact, or on A's own manual-action terminal if it never starts.
          o.startOfA=o.until(event=>event.fact==='provider-request-started'&&event.purpose==='formal'&&
            event.refs.operationKind==='main-advisor',event=>event.fact==='terminal'&&event.terminal.object==='manual-action');
          // B is submitted from the delivery of that fact, through the Screen entry, while A's Advisor request is in flight.
          o.submittedB=o.startOfA.then(result=>{
            if(result.status!=='matched')return result;
            o.heldAtFact=window.__aeHold.blocked;
            window.__s63.stage='replacement';
            o.captureB=window.__s63.meeting.captureScreenContext();
            return result;
          });
          // B is on screen: the first-visible fact that follows A's start, or B's own Screen terminal without one.
          o.visibleB=o.submittedB.then(result=>result.status!=='matched'?result:
            o.until(event=>event.fact==='first-visible-content',event=>event.fact==='terminal'&&
              event.terminal.object==='screen-operation'&&event.terminal.disposition!=='released',result.event.sequence));
          // A: a regenerate through its production entry.
          o.regenerateA=window.__s63.meeting.regenerateSuggestion();
        });
        const reached=await page.evaluate(()=>window.__aeObserver.submittedB);
        assert.equal(reached.status,'matched',JSON.stringify(reached));
        const startOfA=reached.event;
        assert.equal(await page.evaluate(()=>window.__aeObserver.heldAtFact),1,'A\'s Advisor request was really dispatched and is in flight');
        const visibleB=await page.evaluate(()=>window.__aeObserver.visibleB);
        assert.equal(visibleB.status,'matched',JSON.stringify(visibleB));
        const acceptedA=(await deliveredEvents(page)).find(event=>event.fact==='input-accepted'&&event.refs.manualAction==='regenerate');
        assert.ok(acceptedA&&acceptedA.sequence<startOfA.sequence,'A was accepted as a manual action before its request started');
        // Release A's request only now: B has committed and is shown. A's last fact is its manual-action terminal.
        const endOfA=await page.evaluate(({manualActionId,after})=>{
          const o=window.__aeObserver;
          const ended=o.until(event=>event.fact==='terminal'&&event.terminal.object==='manual-action'&&
            event.refs.manualActionId===manualActionId,undefined,after);
          window.__aeHold.release();
          return ended;
        },{manualActionId:acceptedA.refs.manualActionId,after:startOfA.sequence});
        assert.equal(endOfA.status,'matched',JSON.stringify(endOfA));
        await page.evaluate(()=>Promise.all([window.__aeObserver.regenerateA,window.__aeObserver.captureB]));
        const delivered=await deliveredEvents(page);
        child.diagnostic(`AE7 advisor latest-wins facts=${JSON.stringify(delivered.map(event=>`${event.sequence} ${label(event)}${event.terminal?.reason?`(${event.terminal.reason})`:''}`))}`);
        assert.deepEqual((await page.evaluate(()=>window.__aeObserver.log)).filter(delivery=>delivery.kind!=='event'),[],'no gap and no close during the run');
        // A: accepted, admitted and started; then ended by B's commit. It commits and shows nothing.
        const isOfA=event=>event.refs.generationLeaseId===startOfA.refs.generationLeaseId||event.refs.requestId===startOfA.refs.requestId||
          event.refs.manualActionId===acceptedA.refs.manualActionId;
        const tail=delivered.filter(event=>event.sequence>startOfA.sequence&&isOfA(event));
        assert.deepEqual(tail.map(event=>[label(event),event.terminal?.reason]),[
          ['terminal:generation:rejected','parent-revision-mismatch'],
          ['terminal:manual-action:cancelled','suppressed'],
        ],'A\'s real latest-wins terminals, in its owners\' order');
        assert.equal(tail[0].refs.generationLeaseId,startOfA.refs.generationLeaseId,'the generation that started is the one rejected');
        assert.ok(tail[0].sequence>visibleB.event.sequence,'A\'s terminals arrived after B was shown');
        // A's request started and has no provider terminal: its consumer left the provider stream on the
        // stale output before the provider's terminal event was read. The generation terminal is its only end.
        assert.equal(delivered.some(event=>event.fact==='terminal'&&event.terminal.object==='provider-request'&&
          event.refs.requestId===startOfA.refs.requestId),false,'a started request can end with only its generation terminal');
        const stableAfterStart=delivered.filter(event=>event.fact==='stable-answer-committed'&&event.sequence>startOfA.sequence);
        const visibleAfterStart=delivered.filter(event=>event.fact==='first-visible-content'&&event.sequence>startOfA.sequence);
        // B: accepted after A's Provider-start fact through the Screen entry; the latest owner commits and is shown.
        const acceptedB=delivered.find(event=>event.fact==='input-accepted'&&event.sequence>startOfA.sequence);
        assert.ok(acceptedB,'B was accepted through the Screen entry after A\'s Provider-start fact');
        assert.deepEqual([acceptedB.stage,acceptedB.sequence],['screen-operation-claimed',startOfA.sequence+1],
          'B is the next fact after A\'s start: A was still in flight');
        const ofB=delivered.filter(event=>event.refs.traceId===acceptedB.refs.traceId);
        assertOrdered(ofB,['input-accepted:screen-operation-claimed','generation-admitted:ledger-entry-created',
          'provider-request-started:request-start','terminal:provider-request:success','stable-answer-committed:stable-publication',
          'terminal:generation:committed','terminal:screen-operation:released','first-visible-content:stable'],'B whole path');
        assert.deepEqual([stableAfterStart.map(event=>event.refs.traceId),visibleAfterStart.map(event=>event.refs.traceId)],
          [[acceptedB.refs.traceId],[acceptedB.refs.traceId]],'the only answer committed and shown after A started is B\'s: A commits and shows nothing');
        assert.equal(visibleB.event.refs.traceId,acceptedB.refs.traceId,'what became visible is B');
        assert.ok((await page.evaluate(()=>window.__s63.observed.adviseDisplay.sections.primaryAnswer)).includes('doubly linked list'));
        // Sequence: monotonic per session, no hole, as delivered.
        assert.deepEqual(delivered.map(event=>event.sequence),delivered.map((_,index)=>delivered[0].sequence+index));
        // AE6: what the observer received is what the real recorder saved, same identity and order.
        const journal=await readJournal(page);
        const saved=journal.sessions.find(candidate=>candidate.runtimeSessionId===sessionId).events;
        const savedTail=saved.filter(event=>event.sequence>=delivered[0].sequence&&event.sequence<=delivered.at(-1).sequence);
        assert.deepEqual(savedTail.map(({recordingSessionId,recordingGenerationId,...event})=>event),delivered);
        assert.equal(journal.contiguous,true);
        const after=await stats(page);
        assert.deepEqual([after.overflowDropped,after.subscriberFailures,after.staleSessionRejected,after.lateAfterClose],[0,0,0,0]);
        assert.deepEqual(await page.evaluate(()=>window.__s63.unexpected),[]);
        assert.deepEqual(failures,[]);
      } finally {await context.close();}
    }]);

    aeCases.push(['AE2-screen-failure','AE2 a Screen operation that did not answer says so in its own terminal: a failed capture ends released with capture-failed and no other fact, a failed solver ends with its provider and generation terminals and released with operation-error, and one that Pause cancels while its solver request is in flight ends released with cancelled; none is the terminal of an answered operation',async(child,bundle,browser)=>{
      for(const variant of ['capture-fails','solver-fails','paused-in-flight']) {
        const {page,context,failures}=await openAnswered(child,bundle,browser,'voice');
        try {
          // An idle session: one Screen capture and nothing else.
          await page.evaluate(()=>window.__s63.meeting.stopRuntimeRegressionRun());
          const sessionId=await page.evaluate(()=>window.__s63.meeting.meetingSessionId);
          await page.evaluate(variant=>{
            if(variant==='capture-fails') {
              // The native capture command fails at its external boundary.
              const invoke=window.__s63.invoke;
              window.__s63.invoke=async(name,args={})=>{
                if(name==='capture_screen_context_to_base64')throw new Error('AE2: the capture command failed');
                return invoke(name,args);
              };
            } else if(variant==='solver-fails') {
              // The solver's provider answers 503 at the fetch boundary.
              const underlying=window.fetch;
              window.fetch=async(url,init)=>{
                const system=JSON.parse(init.body).messages.find(message=>message.role==='system')?.content??'';
                if(system.startsWith('You are a live meeting co-pilot')||system.startsWith('You are Jarvis, a private live meeting assistant')) {
                  return new Response(JSON.stringify({error:{message:'AE2 controlled solver failure'}}),{status:503,headers:{'Content-Type':'application/json'}});
                }
                return underlying(url,init);
              };
            } else {
              // The solver's request stays in flight at the fetch boundary until its own signal aborts it.
              const underlying=window.fetch;
              window.fetch=async(url,init)=>{
                const system=JSON.parse(init.body).messages.find(message=>message.role==='system')?.content??'';
                if(system.startsWith('You are a live meeting co-pilot')||system.startsWith('You are Jarvis, a private live meeting assistant')) {
                  await new Promise((resolve,reject)=>init.signal.addEventListener('abort',
                    ()=>reject(Object.assign(new Error('AE2 request aborted'),{name:'AbortError'})),{once:true}));
                }
                return underlying(url,init);
              };
            }
          },variant);
          assert.deepEqual(await installObserver(page),{accepted:true,runtimeSessionId:sessionId});
          const before=await page.evaluate(()=>window.__s63.observed.adviseDisplay.stable?.revision??null);
          const terminal=await page.evaluate(variant=>{
            const o=window.__aeObserver;
            const ended=o.until(event=>event.fact==='terminal'&&event.terminal.object==='screen-operation');
            // Pause arrives from the delivery of the solver's Provider-start fact, while that request is in flight.
            if(variant==='paused-in-flight')o.until(event=>event.fact==='provider-request-started'&&event.refs.operationKind==='screen-solver',
              event=>event.fact==='terminal'&&event.terminal.object==='screen-operation').then(result=>{
                if(result.status==='matched')o.paused=window.__s63.meeting.pause();
              });
            o.capture=window.__s63.meeting.captureScreenContext().then(()=>'resolved',error=>`threw: ${error?.message}`);
            return ended;
          },variant);
          assert.equal(terminal.status,'matched',JSON.stringify(terminal));
          assert.equal(await page.evaluate(()=>window.__aeObserver.capture),'resolved','the Screen entry handles its own failure');
          const events=await deliveredEvents(page);
          child.diagnostic(`${variant} facts=${JSON.stringify(events.map(event=>`${event.sequence} ${label(event)}${event.terminal?.reason?`(${event.terminal.reason})`:''}`))}`);
          const outcome=variant==='paused-in-flight'?'aborted':'failed';
          assert.deepEqual(events.map(label),variant==='capture-fails'
            ? ['input-accepted:screen-operation-claimed','terminal:screen-operation:released']
            : ['input-accepted:screen-operation-claimed','lifecycle-committed:task-writer-committed','type-settled:settlement-adopted',
              'relation-settled:settlement-adopted','generation-admitted:ledger-entry-created','provider-request-started:request-start',
              `terminal:provider-request:${outcome}`,`terminal:generation:${outcome}`,'terminal:screen-operation:released'],
            `${variant}: no stage that did not happen is announced`);
          assert.deepEqual(events.at(-1).terminal,{object:'screen-operation',disposition:'released',
            reason:{'capture-fails':'capture-failed','solver-fails':'operation-error','paused-in-flight':'cancelled'}[variant]},
            `${variant}: the release names how the operation ended`);
          assert.equal(events.at(-1).refs.operationId,events[0].refs.operationId);
          assert.equal(events.some(event=>event.fact==='stable-answer-committed'||event.fact==='first-visible-content'),false);
          assert.equal(await page.evaluate(()=>window.__s63.observed.adviseDisplay.stable?.revision??null),before,'nothing new was committed or shown');
          assert.equal(JSON.stringify(events).includes('AE2'),false,'no error text travels in an event');
          // The owner's own exit, as the page state shows it: an error, or a cancellation with no error.
          await page.waitForFunction(({traceId,status})=>window.__s63.meeting.traces.find(trace=>trace.id===traceId)?.status===status,
            {traceId:events[0].refs.traceId,status:variant==='paused-in-flight'?'cancelled':'error'},{timeout:5000});
          if(variant==='paused-in-flight') {
            await page.evaluate(()=>window.__aeObserver.paused);
            assert.equal(await page.evaluate(()=>window.__s63.meeting.error),null,'a cancelled operation shows no error');
          }
          assert.deepEqual(failures,[]);
        } finally {await context.close();}
      }
    }]);

    // A test-side hold of the Relation requests at the external fetch boundary: a
    // held request stays in flight until its own signal aborts it. The product
    // code is untouched.
    async function installRelationHold(page) {
      await page.evaluate(()=>{
        const underlying=window.fetch;
        const hold={armed:false,blocked:0};
        window.__aeRelationHold=hold;
        window.fetch=async(url,init)=>{
          const system=JSON.parse(init.body).messages.find(message=>message.role==='system')?.content??'';
          if(hold.armed&&(system.startsWith('Decide one thing only')||system.startsWith('Classify one canonical relationship'))) {
            hold.blocked++;
            await new Promise((resolve,reject)=>init.signal.addEventListener('abort',
              ()=>reject(Object.assign(new Error('AE2 request aborted'),{name:'AbortError'})),{once:true}));
          }
          return underlying(url,init);
        };
      });
    }

    aeCases.push(['AE2-screen-relation-wait','AE2 a Screen operation that loses its authority during its Relation wait still ends with its own terminal: superseded when a second capture takes its slot, stale-rejected when Pause, Clear Task or Stop invalidates the runtime work; it is never released and commits nothing',async(child,bundle,browser)=>{
      for(const how of ['second-capture','pause','clear-task','stop']) {
        const {page,context,failures}=await openAnswered(child,bundle,browser,'voice');
        try {
          // A normal Stop keeps the runtime session, so Stop is taken outside the Replay run.
          if(how==='stop')await page.evaluate(()=>window.__s63.meeting.stopRuntimeRegressionRun());
          const sessionId=await page.evaluate(()=>window.__s63.meeting.meetingSessionId);
          assert.deepEqual(await installObserver(page,'__aeWait'),{accepted:true,runtimeSessionId:sessionId});
          if(how==='stop') {
            // The idle session gets a task first, so that the next capture needs a Relation.
            const shown=await page.evaluate(()=>{
              const o=window.__aeWait;
              const shown=o.until(event=>event.fact==='first-visible-content',event=>event.fact==='terminal'&&
                event.terminal.object==='screen-operation'&&event.terminal.disposition!=='released');
              o.first=window.__s63.meeting.captureScreenContext();
              return shown;
            });
            assert.equal(shown.status,'matched',JSON.stringify(shown));
            await page.evaluate(()=>window.__aeWait.first);
          }
          await installRelationHold(page);
          const before=await stats(page);
          await page.evaluate(how=>{
            const o=window.__aeWait,meeting=window.__s63.meeting;
            window.__aeRelationHold.armed=true;
            // A is in its Relation wait: a formal Relation request of its trace has really started.
            o.waitingA=o.until(event=>event.fact==='provider-request-started'&&event.purpose==='formal'&&
              String(event.refs.operationKind).startsWith('task-relation-'),
              event=>event.fact==='terminal'&&event.terminal.object==='screen-operation');
            // The authority is taken from the delivery of that fact, through the original entries.
            o.acted=o.waitingA.then(result=>{
              if(result.status!=='matched')return result;
              o.heldAtFact=window.__aeRelationHold.blocked;
              if(how==='second-capture') {
                window.__aeRelationHold.armed=false;
                o.action=meeting.captureScreenContext();
              } else if(how==='pause')o.action=meeting.pause();
              else if(how==='clear-task')o.action=Promise.resolve(meeting.clearActiveTask());
              else {
                // Stop ends this observer's subscription and the session goes on:
                // the next observer subscribes when this one's closed marker arrives.
                o.afterStop=o.until(()=>false).then(closed=>({closed,next:window.__aeInstallObserver('__aeAfterStop').subscription}));
                o.action=meeting.stop();
              }
              return result;
            });
            // A's own terminal ends the wait, whichever observer is subscribed when it is produced.
            o.endOfA=o.acted.then(async result=>{
              if(result.status!=='matched')return result;
              const terminalOfA=event=>event.fact==='terminal'&&event.terminal.object==='screen-operation'&&
                event.refs.traceId===result.event.refs.traceId;
              if(how!=='stop')return o.until(terminalOfA,undefined,result.event.sequence);
              await o.afterStop;
              return window.__aeAfterStop.until(terminalOfA,undefined,result.event.sequence);
            });
            o.captureA=meeting.captureScreenContext().then(()=>'resolved',error=>`threw: ${error?.message}`);
          },how);
          const reached=await page.evaluate(()=>window.__aeWait.acted);
          assert.equal(reached.status,'matched',JSON.stringify(reached));
          assert.ok(await page.evaluate(()=>window.__aeWait.heldAtFact)>=1,'A\'s Relation request was really dispatched and is in flight');
          const endOfA=await page.evaluate(()=>window.__aeWait.endOfA);
          assert.equal(endOfA.status,'matched',JSON.stringify(endOfA));
          // A's flow ends by itself, without throwing.
          assert.equal(await page.evaluate(()=>window.__aeWait.captureA),'resolved');
          await page.evaluate(()=>window.__aeWait.action);
          if(how==='stop') {
            const afterStop=await page.evaluate(()=>window.__aeWait.afterStop);
            assert.deepEqual([afterStop.closed.status,afterStop.closed.reason,afterStop.closed.discarded,afterStop.next.accepted,
              afterStop.next.runtimeSessionId],['closed','meeting-assistant-stopped',0,true,sessionId],
              'Stop ended the subscription, not the session, and handed over what was queued');
          }
          const log=[...await page.evaluate(()=>window.__aeWait.log),
            ...(how==='stop'?await page.evaluate(()=>window.__aeAfterStop.log):[])];
          const events=log.filter(delivery=>delivery.kind==='event').map(delivery=>delivery.event);
          const after=await stats(page);
          const acceptedA=events.find(event=>event.fact==='input-accepted'&&event.refs.traceId===reached.event.refs.traceId);
          assert.ok(acceptedA,'A was accepted through the Screen entry');
          const ofA=events.filter(event=>event.refs.traceId===acceptedA.refs.traceId);
          child.diagnostic(`${how}: A=${JSON.stringify(ofA.map(event=>`${event.sequence} ${label(event)}${event.terminal?.reason?`(${event.terminal.reason})`:''}`))} stale ${before.staleSessionRejected}->${after.staleSessionRejected}`);
          const terminals=ofA.filter(event=>event.fact==='terminal'&&event.terminal.object==='screen-operation');
          assert.deepEqual(terminals.map(event=>[event.stage,event.terminal.disposition,event.terminal.reason,event.refs.operationId,event.runtimeSessionId]),
            [['screen-operation-exit',how==='second-capture'?'superseded':'stale-rejected',
              how==='second-capture'?'pipeline-owner-mismatch':'runtime-epoch-mismatch',acceptedA.refs.operationId,sessionId]],
            `${how}: A's one terminal, from its own authorization reading`);
          assert.equal(ofA.at(-1).eventId,terminals[0].eventId,'the terminal is A\'s last fact');
          assert.equal(ofA.some(event=>['generation-admitted','stable-answer-committed','first-visible-content','type-settled','relation-settled']
            .includes(event.fact)),false,`${how}: A settled, generated, committed and showed nothing`);
          // Each Relation request of A that started has its own terminal too. (Around
          // Stop no observer is subscribed for a moment, so only what was seen is paired.)
          const started=ofA.filter(event=>event.fact==='provider-request-started').map(event=>event.refs.requestId);
          const ended=ofA.filter(event=>event.fact==='terminal'&&event.terminal.object==='provider-request').map(event=>event.refs.requestId);
          if(how==='stop')assert.deepEqual(started.filter(requestId=>!ended.includes(requestId)),[],'every Relation request seen to start ended');
          else assert.deepEqual([...started].sort(),[...ended].sort(),`${how}: every started Relation request ended`);
          assert.equal(after.staleSessionRejected,before.staleSessionRejected,'A ended in its own runtime session: no fact was refused');
          // The owner's own exit, as the page state shows it: the Relation wait
          // came back unresolved and the flow returned.
          await page.waitForFunction(traceId=>{
            const trace=window.__s63.meeting.traces.find(candidate=>candidate.id===traceId);
            return trace?.status==='cancelled'&&trace.metadata?.taskRelationScreenReleaseAuthorized===false;
          },acceptedA.refs.traceId,{timeout:5000});
          if(how==='second-capture') {
            // The capture that took the slot runs to its end as the owner.
            const acceptedB=events.find(event=>event.fact==='input-accepted'&&event.sequence>reached.event.sequence);
            const terminalB=events.find(event=>event.fact==='terminal'&&event.terminal.object==='screen-operation'&&
              event.refs.operationId===acceptedB.refs.operationId);
            assert.deepEqual(terminalB.terminal,{object:'screen-operation',disposition:'released'},'B ran to its end');
            assert.ok(acceptedB.sequence<terminals[0].sequence,'A ended after B had taken its slot');
          }
          const uncontrolled=await page.evaluate(()=>window.__s63.unexpected);
          child.diagnostic(`${how}: uncontrolled native commands=${JSON.stringify(uncontrolled)}`);
          // The fixture host has no native audio session. Pause and Stop ask it to
          // stop one, and handle the refusal themselves.
          assert.deepEqual(uncontrolled.filter(name=>name!=='stop_meeting_audio_session'),[]);
          if(how==='second-capture'||how==='clear-task')assert.deepEqual(uncontrolled,[]);
          assert.deepEqual(failures,[]);
        } finally {await context.close();}
      }
    }]);

    aeCases.push(['AE2-settlement-return','AE2 the session\'s current settlement returns to an earlier one: a follow-up adopts its own settlement and its answer fails, then a regenerate of the first answer, which is still shown, adopts the first settlement again; that return is announced, so the last Type and Relation facts name the settlement the session holds',async(child,bundle,browser)=>{
      const {page,context,failures}=await openAnswered(child,bundle,browser,'voice');
      try {
        const sessionId=await page.evaluate(()=>window.__s63.meeting.meetingSessionId);
        const current=()=>page.evaluate(()=>{
          const settlement=window.__ae.settlement();
          return settlement&&{settlementId:settlement.settlementId,questionType:settlement.questionType,relation:settlement.relation};
        });
        const settlementFacts=async()=>(await readJournal(page)).sessions.find(session=>session.runtimeSessionId===sessionId).events
          .filter(event=>event.fact==='type-settled'||event.fact==='relation-settled');
        const first=await current();
        assert.ok(first?.settlementId,'the first answer adopted a settlement');
        assert.deepEqual(await installObserver(page),{accepted:true,runtimeSessionId:sessionId});
        // The follow-up's Main Advisor request fails once at the fetch boundary.
        await page.evaluate(()=>{
          const underlying=window.fetch;
          window.__aeFailAdvisor=1;
          window.fetch=async(url,init)=>{
            const system=JSON.parse(init.body).messages.find(message=>message.role==='system')?.content??'';
            if(window.__aeFailAdvisor>0&&system.startsWith('You are a live meeting co-pilot')) {
              window.__aeFailAdvisor--;
              return new Response(JSON.stringify({error:{message:'AE2 controlled advisor failure'}}),{status:503,headers:{'Content-Type':'application/json'}});
            }
            return underlying(url,init);
          };
        });
        const failed=await page.evaluate(text=>{
          const o=window.__aeObserver;
          const ended=o.until(event=>event.fact==='terminal'&&event.terminal.object==='generation');
          o.followup=window.__s63.meeting.submitRuntimeRegressionText(text);
          return ended;
        },'What tradeoffs did you make in that relay project and how did you measure its impact?');
        assert.equal(failed.status,'matched',JSON.stringify(failed));
        assert.notEqual(failed.event.terminal.disposition,'committed','the follow-up produced no answer');
        await page.evaluate(()=>window.__aeObserver.followup);
        const second=await current();
        assert.ok(second?.settlementId&&second.settlementId!==first.settlementId,'the follow-up adopted its own settlement');
        // The first answer is still the one shown. Its regenerate adopts the first settlement again.
        const regenerated=await page.evaluate(()=>{
          const o=window.__aeObserver;
          const ended=o.until(event=>event.fact==='terminal'&&event.terminal.object==='manual-action'&&event.refs.manualAction==='regenerate');
          o.regenerate=window.__s63.meeting.regenerateSuggestion();
          return ended;
        });
        assert.equal(regenerated.status,'matched',JSON.stringify(regenerated));
        await page.evaluate(()=>window.__aeObserver.regenerate);
        const now=await current();
        assert.equal(now.settlementId,first.settlementId,'the session\'s settlement is the first one again');
        const facts=await settlementFacts();
        child.diagnostic(`settlement facts=${JSON.stringify(facts.map(event=>`${event.sequence} ${label(event)} ${event.refs.questionType??event.refs.relation} ${event.refs.settlementId===first.settlementId?'S1':event.refs.settlementId===second.settlementId?'S2':'?'}`))}`);
        const order=facts.map(event=>[event.fact,event.refs.settlementId===first.settlementId?'S1':event.refs.settlementId===second.settlementId?'S2':'other']);
        // Collapse a settlement's own consecutive facts: the order of adoption is S1, S2, S1.
        assert.deepEqual(order.filter(([fact])=>fact==='type-settled').map(([,settlement])=>settlement)
          .filter((settlement,index,all)=>settlement!==all[index-1]),['S1','S2','S1'],'Type: the return to the first settlement is announced');
        assert.deepEqual(order.filter(([fact])=>fact==='relation-settled').map(([,settlement])=>settlement)
          .filter((settlement,index,all)=>settlement!==all[index-1]),['S1','S2','S1'],'Relation: the return to the first settlement is announced');
        const lastType=facts.filter(event=>event.fact==='type-settled').at(-1);
        const lastRelation=facts.filter(event=>event.fact==='relation-settled').at(-1);
        assert.deepEqual([lastType.refs.settlementId,lastType.refs.questionType,lastRelation.refs.settlementId,lastRelation.refs.relation],
          [now.settlementId,now.questionType,now.settlementId,now.relation],'the last settlement facts name the session\'s current settlement and its values');
        assert.ok(lastType.sequence>failed.event.sequence&&lastRelation.sequence>failed.event.sequence,'both were produced by the regenerate');
        assert.equal((await readJournal(page)).contiguous,true);
        assert.deepEqual(await page.evaluate(()=>window.__s63.unexpected),[]);
        assert.deepEqual(failures,[]);
      } finally {await context.close();}
    }]);

    aeCases.push(['AE2-retype-there-and-back','AE1/AE2 the owner that the current question shares is retyped four times, there and back, through the production correction menu while an earlier answer is pinned: every change of the current settlement\'s adopted Type is one Type fact, the last Type fact names the Type adopted now, and its unchanged Relation is not repeated',async(child,bundle,browser)=>{
      const {page,context,failures}=await openAnswered(child,bundle,browser,'voice');
      try {
        const sessionId=await page.evaluate(()=>window.__s63.meeting.meetingSessionId);
        const ask=text=>page.evaluate(text=>window.__s63.meeting.submitRuntimeRegressionText(text),text);
        // A follow-up is answered and pinned; a newer follow-up shares its owner and becomes the current question.
        assert.equal(await ask('How did you validate the relay design before shipping it to production?'),true);
        await page.evaluate(()=>window.__s63.meeting.toggleAdvisePin());
        await page.waitForFunction(()=>window.__s63.observed.adviseDisplay.locked===true,undefined,{timeout:5000});
        assert.equal(await ask('What tradeoffs did you make in that relay project and how did you measure its impact?'),true);
        const read=()=>page.evaluate(()=>{
          const settlement=window.__ae.settlement();
          return {settlementId:settlement?.settlementId,questionType:settlement?.questionType,relation:settlement?.relation,
            shown:window.__s63.observed.adviseDisplay.target.logicalQuestionUnitId,current:settlement?.logicalQuestionUnitId};
        });
        const before=await read();
        assert.ok(before.settlementId&&before.shown&&before.shown!==before.current,'the pinned answer is an earlier question than the current one');
        // A correction also appends a Human evaluation event. The fixture host has no
        // store for it, so this case answers that one native command as the store
        // does: it returns what it was asked to persist.
        await page.evaluate(()=>{
          const invoke=window.__s63.invoke;
          window.__s63.invoke=async(name,args={})=>name==='evaluation_store_append'
            ? JSON.parse(JSON.stringify(args.input)):invoke(name,args);
        });
        const mark=(await readJournal(page)).sessions.find(session=>session.runtimeSessionId===sessionId).lastSequence;
        const sequence=['coding','project-deep-dive','coding','project-deep-dive'];
        assert.notEqual(before.questionType,sequence[0]);
        for(const type of sequence) {
          const picked=await page.evaluate(async type=>{
            const displayTarget=window.__s63.observed.adviseDisplay.target;
            const menu=window.__s63.meeting.readManualCorrectionMenu(type,displayTarget);
            const option=menu.options.find(candidate=>candidate.id==='retype-parent');
            if(!option)return {missing:menu.options.map(candidate=>candidate.id),rejection:menu.rejectionReason};
            await window.__s63.meeting.correctActiveQuestionType(type,'normal-mode',
              {displayTarget,correctionTarget:menu.target,correctionIntent:option.intent});
            return {picked:option.id};
          },type);
          assert.deepEqual(picked,{picked:'retype-parent'},`the menu offers the owner retype to ${type}`);
          const adopted=await read();
          assert.deepEqual([adopted.settlementId,adopted.questionType],[before.settlementId,type],
            `the current settlement adopted ${type} with the same settlement id`);
          // What the recorder saved up to now: the last Type fact of this settlement names that Type.
          const saved=(await readJournal(page)).sessions.find(session=>session.runtimeSessionId===sessionId).events;
          const last=saved.filter(event=>event.fact==='type-settled'&&event.refs.settlementId===before.settlementId).at(-1);
          assert.deepEqual([last.stage,last.refs.questionType,last.sequence>mark],['manual-retype-projection',type,true],
            `the retype to ${type} is announced`);
        }
        const journal=await readJournal(page);
        const events=journal.sessions.find(session=>session.runtimeSessionId===sessionId).events;
        const ofSettlement=events.filter(event=>event.refs.settlementId===before.settlementId&&
          (event.fact==='type-settled'||event.fact==='relation-settled'));
        child.diagnostic(`settlement facts=${JSON.stringify(ofSettlement.map(event=>`${event.sequence} ${label(event)} ${event.refs.questionType??event.refs.relation}`))}`);
        assert.deepEqual(ofSettlement.filter(event=>event.sequence>mark).map(event=>[label(event),event.refs.questionType]),
          sequence.map(type=>['type-settled:manual-retype-projection',type]),'four changes of the adopted Type, four facts, nothing else');
        assert.deepEqual(ofSettlement.filter(event=>event.fact==='relation-settled').map(event=>[event.stage,event.refs.relation]),
          [['settlement-adopted',before.relation]],'the Relation was adopted once and no retype changed it');
        assert.deepEqual([journal.contiguous,(await read()).questionType],[true,sequence.at(-1)]);
        assert.deepEqual(await page.evaluate(()=>window.__s63.unexpected),[]);
        assert.deepEqual(failures,[]);
      } finally {await context.close();}
    }]);

    aeCases.push(['AE7-provider-failure','AE7 Advisor level negative: A\'s provider fails, so a wait for A\'s Stable Answer ends on A\'s own generation terminal and a provider terminal never stands for an answer',async(child,bundle,browser)=>{
      const {page,context,failures}=await openProjectSelectionBrowserHost(child,bundle,browser,{surface:'normal',source:'voice'});
      try {
        await installObserver(page);
        await page.evaluate(()=>{
          const o=window.__aeObserver;
          window.__s63.stage='selected';window.__s63.failSelected=true;
          o.answerOfA=o.until(event=>event.fact==='stable-answer-committed',
            event=>event.fact==='terminal'&&event.terminal.object==='generation');
        });
        await page.getByRole('button',{name:'Quartz Relay',exact:true}).click();
        const outcome=await page.evaluate(()=>window.__aeObserver.answerOfA);
        assert.equal(outcome.status,'ended',JSON.stringify(outcome));
        assert.notEqual(outcome.event.terminal.disposition,'committed');
        const delivered=(await page.evaluate(()=>window.__aeObserver.log)).filter(delivery=>delivery.kind==='event').map(delivery=>delivery.event);
        child.diagnostic(`AE7 failure facts=${JSON.stringify(delivered.map(label))}`);
        const providerTerminal=delivered.find(event=>event.fact==='terminal'&&event.terminal.object==='provider-request');
        assert.ok(providerTerminal,'the provider attempt has its own terminal');
        assert.equal(providerTerminal.terminal.disposition,'failed');
        assert.ok(providerTerminal.sequence<outcome.event.sequence,'the provider terminal precedes and does not replace the generation terminal');
        assert.equal(delivered.some(event=>event.fact==='stable-answer-committed'),false);
        assert.deepEqual(failures,[]);
      } finally {await context.close();}
    }]);

    const SCREEN_FACTS=['input-accepted:screen-operation-claimed','lifecycle-committed:task-writer-committed',
      'type-settled:settlement-adopted','relation-settled:settlement-adopted','generation-admitted:ledger-entry-created',
      'provider-request-started:request-start','terminal:provider-request:success','stable-answer-committed:stable-publication',
      'terminal:generation:committed','terminal:screen-operation:released','first-visible-content:stable'];
    // One idle Screen capture, observed from before it starts until its answer is shown.
    async function captureIdleScreen(page) {
      const subscription=await installObserver(page);
      const visible=await page.evaluate(()=>{
        const o=window.__aeObserver;
        const shown=o.until(event=>event.fact==='first-visible-content',event=>event.fact==='terminal'&&
          event.terminal.object==='screen-operation'&&event.terminal.disposition!=='released');
        o.capture=window.__s63.meeting.captureScreenContext();
        return shown;
      });
      await page.evaluate(()=>window.__aeObserver.capture);
      return {subscription,visible,events:await deliveredEvents(page)};
    }

    aeCases.push(['AE1-idle-screen-after-stop','AE1/AE5 after a normal Stop the runtime session is unchanged: a new observer is accepted and an idle Screen capture produces its whole fact sequence, as it does before any Stop',async(child,bundle,browser)=>{
      const runs={};
      for(const withStop of [false,true]) {
        const {page,context,failures}=await openAnswered(child,bundle,browser,'voice');
        try {
          // Leave the Replay run: an idle session with Recording off.
          await page.evaluate(()=>window.__s63.meeting.stopRuntimeRegressionRun());
          const sessionId=await page.evaluate(()=>window.__s63.meeting.meetingSessionId);
          if(withStop) {
            // An observer of the run that Stop ends.
            await installObserver(page,'__aeStopped');
            await page.evaluate(()=>window.__s63.meeting.stop());
            assert.equal(await page.evaluate(()=>window.__s63.meeting.meetingSessionId),sessionId,'Stop keeps the runtime session');
          }
          const before=await stats(page);
          const {subscription,visible,events}=await captureIdleScreen(page);
          assert.deepEqual(subscription,{accepted:true,runtimeSessionId:sessionId},`withStop=${withStop}: the observer is accepted`);
          assert.equal(visible.status,'matched',JSON.stringify(visible));
          const after=await stats(page);
          child.diagnostic(`withStop=${withStop} facts=${JSON.stringify(events.map(event=>`${event.sequence} ${label(event)}`))}`);
          assert.deepEqual(events.map(label),SCREEN_FACTS,`withStop=${withStop}: the whole Screen path`);
          assert.ok(events.every(event=>event.runtimeSessionId===sessionId));
          assert.deepEqual(events.map(event=>event.sequence),events.map((_,index)=>events[0].sequence+index));
          assert.deepEqual([after.lateAfterClose,after.accepting,after.produced-before.produced],[0,true,SCREEN_FACTS.length]);
          assert.equal(after.recording['not-recording']-before.recording['not-recording'],SCREEN_FACTS.length,
            'Recording is off: every fact is in memory only and nothing was written');
          assert.equal(await page.evaluate(file=>window.__s63.writes.has(file),JOURNAL)&&(await readJournal(page)).sessions
            .some(session=>session.runtimeSessionId===sessionId),false,'no journal line for the idle session');
          const answer=await page.evaluate(()=>({stable:window.__s63.observed.adviseDisplay.stable?.suggestion.taskSource,
            text:window.__s63.observed.adviseDisplay.sections.primaryAnswer}));
          assert.equal(answer.stable,'screen');
          if(withStop) {
            // The stopped run's observer ended at its own closed marker and saw none of the idle facts.
            const stopped=await page.evaluate(()=>window.__aeStopped.log);
            assert.deepEqual(stopped.at(-1),{kind:'closed',schemaVersion:1,runtimeSessionId:sessionId,
              reason:'meeting-assistant-stopped',lastSequence:stopped.at(-1).lastSequence,discarded:0});
            assert.equal(stopped.filter(delivery=>delivery.kind==='event').some(delivery=>delivery.event.sequence>=events[0].sequence),false);
          }
          runs[withStop]=normalizeFormal(events);
          assert.deepEqual(failures,[]);
        } finally {await context.close();}
      }
      assert.deepEqual(runs[true],runs[false],'the same idle Screen input gives the same facts with and without a Stop before it');
    }]);

    aeCases.push(['AE3-screen-switches','AE3 Debug x Recording x Cross-checks over one whole Screen input in the mounted Hook: the eight combinations give the same formal facts with the same normalized identities in the same order; Recording decides only where they are saved',async(child,bundle,browser)=>{
      const runs=[];
      for(const debug of [false,true])for(const recording of [false,true])for(const crossChecks of [false,true]) {
        const {page,context,failures}=await openAnswered(child,bundle,browser,'voice');
        try {
          await page.evaluate(()=>window.__s63.meeting.stopRuntimeRegressionRun());
          await page.evaluate(({debug,crossChecks})=>{
            window.__s63.meeting.setRuntimeCrossChecksEnabled(crossChecks);window.__s63.meeting.setDebugMode(debug);
          },{debug,crossChecks});
          await page.waitForFunction(({debug,crossChecks})=>window.__s63.meeting.settings.debugMode===debug&&
            window.__s63.meeting.settings.runtimeCrossChecksEnabled===crossChecks,{debug,crossChecks},{timeout:5000});
          if(recording) {
            await page.evaluate(()=>window.__s63.meeting.setSessionRecordingEnabled(true));
            await page.waitForFunction(()=>window.__ae.recording()?.active===true,undefined,{timeout:5000});
          }
          assert.equal(Boolean(await page.evaluate(()=>window.__ae.recording()?.active)),recording);
          const sessionId=await page.evaluate(()=>window.__s63.meeting.meetingSessionId);
          const before=await stats(page);
          const {subscription,visible,events}=await captureIdleScreen(page);
          assert.equal(subscription.accepted,true);
          assert.equal(visible.status,'matched',JSON.stringify(visible));
          const after=await stats(page);
          const formal=events.filter(event=>event.purpose==='formal');
          const run={switches:{debug,recording,crossChecks},formal:normalizeFormal(events),labels:formal.map(label),
            observation:events.filter(event=>event.purpose==='observation').map(event=>`${label(event)}/${event.refs.operationKind}`)};
          // Recording: the same facts, saved or not; never filtered by the other two switches.
          const produced=after.produced-before.produced;
          assert.equal(produced,events.length);
          if(recording) {
            assert.equal(after.recording.accepted-before.recording.accepted,produced,`${JSON.stringify(run.switches)}: every fact was handed to the recording`);
            const saved=(await readJournal(page)).sessions.find(session=>session.runtimeSessionId===sessionId).events
              .filter(event=>event.sequence>=events[0].sequence);
            assert.deepEqual(saved.map(({recordingSessionId,recordingGenerationId,...event})=>event),events);
          } else {
            assert.equal(after.recording['not-recording']-before.recording['not-recording'],produced);
          }
          assert.deepEqual(failures,[]);
          runs.push(run);
        } finally {await context.close();}
      }
      const reference=runs[0];
      assert.deepEqual(reference.labels,SCREEN_FACTS,'the reference run is the whole Screen path');
      for(const run of runs) {
        child.diagnostic(`${JSON.stringify(run.switches)} formal=${run.labels.length} observation=${JSON.stringify(run.observation)}`);
        assert.deepEqual(run.formal,reference.formal,`formal facts with ${JSON.stringify(run.switches)}`);
        // An observation request exists only when Cross-checks admitted it, and it carries its purpose.
        if(!run.switches.crossChecks)assert.deepEqual(run.observation,[],`no observation fact with ${JSON.stringify(run.switches)}`);
      }
    }]);

    aeCases.push(['AE3-voice-switches','AE3 Debug x Recording x Cross-checks over whole Voice inputs in the mounted Hook, for a new question and for a short follow-up: the eight combinations give the same formal facts with the same normalized identities in the same order; Recording (stopped inside the Replay run) decides only where they are saved; observation Relation requests exist only with Cross-checks, carry their purpose and never enter the formal facts',async(child,bundle,browser)=>{
      // The new question follows a Clear Task: the clear's own commit and terminal come first.
      const NEW_QUESTION=['lifecycle-committed:task-writer-committed','terminal:manual-action:completed',
        'input-accepted:canonical-turn-ingress-admitted','lqu-committed:canonical-publish','type-settled:settlement-adopted',
        'relation-settled:settlement-adopted','lifecycle-committed:task-writer-committed','generation-admitted:ledger-entry-created',
        'provider-request-started:request-start','terminal:provider-request:success','stable-answer-committed:stable-publication',
        'terminal:generation:committed','first-visible-content:stable'];
      const FOLLOWUP=['input-accepted:canonical-turn-ingress-admitted','lqu-committed:canonical-publish','type-settled:settlement-adopted',
        'relation-settled:settlement-adopted','lifecycle-committed:task-writer-committed','generation-admitted:ledger-entry-created',
        'provider-request-started:request-start','terminal:provider-request:success','stable-answer-committed:stable-publication',
        'terminal:generation:committed','first-visible-content:stable'];
      // The follow-up has an active parent and requests no release window, so
      // Cross-checks admits the observation Relation stages (two candidates each).
      const OBSERVATION_KINDS=['task-relation-parent-affinity','task-relation-canonical-shadow'];
      for(const input of [{name:'new question',followup:false,text:fixtures.S63_NEXT_SOURCE_QUESTION,expected:NEW_QUESTION},
        {name:'short follow-up',followup:true,text:'Why?',expected:FOLLOWUP}]) {
        const runs=[];
        for(const debug of [true,false])for(const recording of [true,false])for(const crossChecks of [false,true]) {
          const {page,context,failures}=await openAnswered(child,bundle,browser,'voice');
          try {
            const sessionId=await page.evaluate(()=>window.__s63.meeting.meetingSessionId);
            await page.evaluate(({debug,crossChecks})=>{
              window.__s63.meeting.setRuntimeCrossChecksEnabled(crossChecks);window.__s63.meeting.setDebugMode(debug);
            },{debug,crossChecks});
            await page.waitForFunction(({debug,crossChecks})=>window.__s63.meeting.settings.debugMode===debug&&
              window.__s63.meeting.settings.runtimeCrossChecksEnabled===crossChecks,{debug,crossChecks},{timeout:5000});
            assert.equal(await page.evaluate(()=>window.__ae.recording()?.active),true,'the Replay run records');
            if(!recording) {
              // The user stops the recording inside the run; the run and its runtime session continue.
              await page.evaluate(()=>window.__s63.meeting.setSessionRecordingEnabled(false));
              await page.waitForFunction(()=>window.__ae.recording()?.active!==true,undefined,{timeout:5000});
            }
            assert.equal(await page.evaluate(()=>window.__s63.meeting.meetingSessionId),sessionId,'the switches keep the runtime session');
            assert.equal((await installObserver(page)).accepted,true);
            const before=await stats(page);
            const expectedObservationTerminals=input.followup&&crossChecks?OBSERVATION_KINDS.length*2:0;
            const outcome=await page.evaluate(({text,followup,expectedObservationTerminals})=>{
              const o=window.__aeObserver;
              window.__s63.stage='replacement';
              // The input's own first-visible fact, or its generation ending without one.
              const accepted=o.until(event=>event.fact==='input-accepted'&&event.refs.transport==='manual-text');
              const shown=accepted.then(result=>o.until(event=>event.fact==='first-visible-content'&&event.refs.traceId===result.event.refs.traceId,
                event=>event.fact==='terminal'&&event.terminal.object==='generation'&&event.refs.traceId===result.event.refs.traceId&&
                  event.terminal.disposition!=='committed',result.event.sequence));
              // The observation requests end by their own terminals. The guard only bounds a wait that would never end.
              let terminals=0;
              const observed=expectedObservationTerminals===0?Promise.resolve({status:'none'}):Promise.race([
                o.until(event=>event.purpose==='observation'&&event.fact==='terminal'&&++terminals===expectedObservationTerminals),
                new Promise(resolve=>setTimeout(()=>resolve({status:'timeout',terminals}),8000))]);
              if(!followup)window.__s63.meeting.clearActiveTask();
              o.step=window.__s63.meeting.submitRuntimeRegressionText(text);
              return Promise.all([shown,observed]).then(([shown,observed])=>({shown,observed:observed.status}));
            },{text:input.text,followup:input.followup,expectedObservationTerminals});
            assert.equal(outcome.shown.status,'matched',JSON.stringify(outcome));
            assert.equal(outcome.observed,expectedObservationTerminals?'matched':'none',JSON.stringify(outcome));
            assert.equal(await page.evaluate(()=>window.__aeObserver.step),true);
            assert.equal(await page.evaluate(()=>window.__s63.meeting.meetingSessionId),sessionId);
            const events=await deliveredEvents(page);
            const after=await stats(page);
            const observation=events.filter(event=>event.purpose==='observation');
            runs.push({switches:{debug,recording,crossChecks},formal:normalizeFormal(events),
              labels:events.filter(event=>event.purpose==='formal').map(label),
              observation:observation.map(event=>`${label(event)}/${event.refs.operationKind}/${event.refs.providerTier}`),
              observationKinds:[...new Set(observation.map(event=>event.refs.operationKind))]});
            // Recording decides only where the facts are saved, never which facts exist.
            const produced=after.produced-before.produced;
            assert.equal(produced,events.length);
            if(recording) {
              assert.equal(after.recording.accepted-before.recording.accepted,produced,'every fact was handed to the recording');
              const saved=(await readJournal(page)).sessions.find(session=>session.runtimeSessionId===sessionId).events
                .filter(event=>event.sequence>=events[0].sequence);
              assert.deepEqual(saved.map(({recordingSessionId,recordingGenerationId,...event})=>event),events);
            } else {
              assert.equal(after.recording['not-recording']-before.recording['not-recording'],produced,'Recording is off: memory only');
              assert.equal((await readJournal(page)).sessions.find(session=>session.runtimeSessionId===sessionId).events
                .some(event=>event.sequence>=events[0].sequence),false,'no line was written after the recording stopped');
            }
            assert.deepEqual(failures,[]);
          } finally {await context.close();}
        }
        const reference=runs[0];
        assert.deepEqual(reference.labels,input.expected,`${input.name}: the reference run is the whole Voice path`);
        for(const run of runs) {
          child.diagnostic(`${input.name} ${JSON.stringify(run.switches)} formal=${run.labels.length} observation=${JSON.stringify(run.observation)}`);
          assert.deepEqual(run.formal,reference.formal,`${input.name}: formal facts with ${JSON.stringify(run.switches)}`);
          // An observation request exists only when Cross-checks admitted it.
          if(!run.switches.crossChecks)assert.deepEqual(run.observation,[],`${input.name}: no observation fact with ${JSON.stringify(run.switches)}`);
          else if(input.followup) {
            // Each observation candidate started and ended as an observation, under its own operation kind.
            assert.deepEqual(run.observationKinds.sort(),[...OBSERVATION_KINDS].sort(),JSON.stringify(run.switches));
            assert.equal(run.observation.filter(row=>row.startsWith('provider-request-started:')).length,OBSERVATION_KINDS.length*2);
            assert.equal(run.observation.filter(row=>row.startsWith('terminal:provider-request:')).length,OBSERVATION_KINDS.length*2);
          }
        }
        assert.equal(runs.length,8);
      }
    }]);

    // -----------------------------------------------------------------------
    // AE4: one whole Voice question and one whole Screen capture, run to their
    // answer and then through Stop, with the interface idle (twice: the
    // comparison's own noise floor) and in six other modes of this same code.
    // The business projection must be the same in every one.
    // -----------------------------------------------------------------------
    const AE4_MODES=['idle','idle-again','observer','throwing-observer','async-failing-observer','queue-overflow','write-failure','recorder-throws'];
    // Arranged before the Hook's first render, so the mode holds from the first fact.
    const ae4ModeScript=mode=>`
      window.__ae4={mode:${JSON.stringify(mode)},attached:0,delivered:0,thrown:0,failedWrites:0,recorderThrows:0};
      window.__aeTick=ae=>{
        const p=window.__ae4,stream=ae.stream;
        if(p.mode==='write-failure'&&!p.wrapped) {
          // The disk refuses every journal append at the native boundary.
          p.wrapped=true;const invoke=window.__s63.invoke;
          window.__s63.invoke=async(name,args)=>{
            if(name==='write_meeting_session_recording_text'&&String(args?.relativePath).startsWith('runtime-events/')) {
              p.failedWrites++;throw new Error('AE4: the disk refused the journal append');
            }
            return invoke(name,args);
          };
        }
        if(p.mode==='queue-overflow'&&!p.limited){stream.limits=Object.freeze({...stream.limits,queueCapacity:1});p.limited=true;}
        if((p.mode==='observer'||p.mode==='queue-overflow')&&stream.getStats().subscribers===0&&
          stream.subscribe(()=>{p.delivered++;}).accepted)p.attached++;
        if(p.mode==='throwing-observer'&&stream.getStats().subscribers===0&&
          stream.subscribe(()=>{p.thrown++;throw new Error('AE4: observer failure');}).accepted)p.attached++;
        if(p.mode==='async-failing-observer'&&stream.getStats().subscribers===0&&
          stream.subscribe(async()=>{p.thrown++;throw new Error('AE4: async observer failure');}).accepted)p.attached++;
        if(p.mode==='recorder-throws'&&ae.recorderRef.current&&!ae.recorderRef.current.__ae4) {
          ae.recorderRef.current.__ae4=true;
          ae.recorderRef.current.recordRuntimeCriticalEvent=()=>{p.recorderThrows++;throw new Error('AE4: recording owner failure');};
        }
      };`;
    // What the product did, read from the page: no event is read here.
    const ae4Collect=()=>{
      const meeting=window.__s63.meeting,observed=window.__s63.observed;
      return JSON.parse(JSON.stringify({
        business:{
          error:meeting.error,status:meeting.status,taskRuntime:meeting.taskRuntime,activeMeetingTask:meeting.activeMeetingTask,
          latestSuggestion:meeting.latestSuggestion&&{content:meeting.latestSuggestion.content,
            answerProfile:meeting.latestSuggestion.answerProfile,meetingAnswer:meeting.latestSuggestion.meetingAnswer},
          generationResult:meeting.generationResult,answerDelivery:meeting.answerDelivery,
          display:{sections:observed.adviseDisplay.sections,streaming:observed.adviseDisplay.streaming,
            locked:observed.adviseDisplay.locked,stableRevision:observed.adviseDisplay.stable?.revision},
          traces:meeting.traces.map(trace=>({id:trace.id,status:trace.status,kind:trace.kind,source:trace.source,error:trace.error,metadata:trace.metadata})),
          sessionId:meeting.meetingSessionId,
          // Call counts: every provider request and every native command, the journal append aside.
          providerRequests:window.__s63.requests.map(request=>`${request.system.slice(0,48)} => ${String(request.response??request.fixtureFailure??'').slice(0,48)}`),
          nativeCommands:window.__s63.calls.filter(call=>call.name&&!(call.name==='write_meeting_session_recording_text'&&
            String(call.args?.relativePath).startsWith('runtime-events/')))
            .map(call=>call.name+(call.args?.relativePath?`:${String(call.args.relativePath).replace(/[A-Za-z0-9_-]{20,}/g,'<id>')}`:'')),
        },
        recordingLastError:meeting.sessionRecording?.lastError??null,
        unexpected:window.__s63.unexpected,
        mode:window.__ae4??null,
        stats:window.__ae?window.__ae.stream.getStats():null,
      }));
    };
    // Run-to-run noise only: identifiers, times, sizes that follow them, and hashes over them.
    // Every other value, including every owner code, is compared as it is.
    const AE4_NOISE_KEY=/(Ms|At|Latency|Duration|Elapsed|Timestamp|Hash|Fingerprint|BudgetKey|BudgetSlot|Chars)$|^(createdAt|updatedAt|startedAt|endedAt|timestamp)$/;
    const AE4_ID_KEY=/(^id$|Id$|Ids$)/;
    function ae4Normalize(value) {
      const identifiers=new Set();
      const collect=(node,key)=>{
        if(typeof node==='string'){if(AE4_ID_KEY.test(key)&&node.length>=6)identifiers.add(node);}
        else if(Array.isArray(node))node.forEach(item=>collect(item,key));
        else if(node&&typeof node==='object')for(const [name,child] of Object.entries(node))collect(child,name);
      };
      collect(value,'');
      const ordered=[...identifiers].sort((left,right)=>right.length-left.length);
      const text=input=>{
        let output=input;
        for(const identifier of ordered)output=output.split(identifier).join('<id>');
        return output.replace(/[A-Za-z][A-Za-z0-9_-]*_\d{10,}_[a-z0-9]+/g,'<id>').replace(/\d{10,}/g,'<n>');
      };
      const normalize=node=>typeof node==='string'?text(node):typeof node==='number'?(node>=1e9?'<t>':node)
        :Array.isArray(node)?node.map(normalize)
        :node&&typeof node==='object'?Object.fromEntries(Object.entries(node)
          .filter(([key])=>!AE4_NOISE_KEY.test(key)&&!AE4_ID_KEY.test(key)).map(([key,child])=>[key,normalize(child)])):node;
      const normalized=normalize(value);
      normalized.nativeCommands=[...normalized.nativeCommands].sort();
      return normalized;
    }
    const ae4Difference=(left,right,at='',out=[])=>{
      if(JSON.stringify(left)===JSON.stringify(right))return out;
      if(left&&right&&typeof left==='object'&&typeof right==='object'&&Array.isArray(left)===Array.isArray(right)) {
        for(const key of new Set([...Object.keys(left),...Object.keys(right)]))ae4Difference(left[key],right[key],`${at}/${key}`,out);
      } else out.push(`${at}: ${JSON.stringify(left)?.slice(0,80)} != ${JSON.stringify(right)?.slice(0,80)}`);
      return out;
    };
    // The page has been quiet for a while: no running trace, no new provider
    // request, no new native command. A wait on page state, not on events, so
    // that every mode is measured the same way, also one whose observer was cut off.
    const ae4Quiet=async(page,quietMs)=>{
      await page.evaluate(()=>{window.__ae4Quiet=undefined;});
      await page.waitForFunction(quietMs=>{
        const s=window.__s63;
        const key=JSON.stringify([s.meeting.traces.map(trace=>trace.status),s.requests.length,s.calls.length,s.meeting.status]);
        const quiet=window.__ae4Quiet??={key:'',since:performance.now()};
        if(quiet.key!==key){quiet.key=key;quiet.since=performance.now();return false;}
        return performance.now()-quiet.since>=quietMs&&!s.meeting.traces.some(trace=>trace.status==='running');
      },quietMs,{timeout:20000,polling:100});
    };
    async function ae4Run(browser,text,source) {
      const {page,context,failures}=await openProjectSelectionBrowserHost({diagnostic(){}},{outputFiles:[{text}]},browser,
        {surface:'normal',source},{memory:[]});
      try {
        await page.waitForFunction(()=>Boolean(window.__s63.observed.adviseDisplay.stable),undefined,{timeout:15000});
        await ae4Quiet(page,1000);
        const answered=await page.evaluate(ae4Collect);
        // The run's own Stop: the scenario-runner stop, the recording close and the reset.
        const stopOutcome=await page.evaluate(async()=>{
          try{await window.__s63.meeting.stop();return 'resolved';}catch(error){return `threw: ${error?.message??error}`;}
        });
        await ae4Quiet(page,600);
        const stopped=await page.evaluate(ae4Collect);
        const manifest=await page.evaluate(()=>{
          const text=window.__s63.writes.get('manifest.json');
          if(!text)return null;
          const manifest=JSON.parse(text);
          return {status:manifest.status,integrity:manifest.recordingIntegrity?.status,failedWriteCount:manifest.recordingIntegrity?.failedWriteCount,
            failedPaths:[...new Set((manifest.recordingIntegrity?.failedWrites??[]).map(write=>write.relativePath))],eventCount:manifest.eventCount};
        });
        return {answered:{...answered,business:ae4Normalize(answered.business)},stopped:{...stopped,business:ae4Normalize(stopped.business)},
          stopOutcome,manifest,pageErrors:[...failures]};
      } finally {await context.close();}
    }
    for(const source of ['voice','screen']) {
      aeCases.push([`AE4-${source}-isolation`,`AE4 one whole ${source==='voice'?'Voice question':'Screen capture'} through the mounted Hook, to its answer and through Stop: with the interface idle, observed, with an observer that throws, with one that fails by a rejected promise, with queue overflow, with a failing journal write and with a throwing Recording owner, the task, Type, Relation, Plan, phase, answer, Artifacts, traces, provider requests, native commands and error exits are the same`,async(child,bundle,browser)=>{
        const work=bundle.outputFiles[0].text;
        const runs={};
        for(const mode of AE4_MODES)runs[mode]=await ae4Run(browser,ae4ModeScript(mode)+work,source);
        const reference=runs.idle;
        for(const [name,run] of Object.entries(runs)) {
          child.diagnostic(`${source}/${name}: stop=${run.stopOutcome} traces=${JSON.stringify(run.stopped.business.traces.map(trace=>`${trace.kind}:${trace.status}`))} provider=${run.stopped.business.providerRequests.length} native=${run.stopped.business.nativeCommands.length} manifest=${JSON.stringify(run.manifest)} mode=${JSON.stringify(run.stopped.mode)} stream=${JSON.stringify(run.stopped.stats&&{produced:run.stopped.stats.produced,delivered:run.stopped.stats.delivered,subscriberFailures:run.stopped.stats.subscriberFailures,overflowDropped:run.stopped.stats.overflowDropped,gapMarkers:run.stopped.stats.gapMarkers,recording:run.stopped.stats.recording})}`);
        }
        // The reference run really answered and stopped.
        assert.ok(reference.answered.business.latestSuggestion?.content,'the reference run produced an answer');
        assert.ok(reference.answered.business.taskRuntime?.parent,'and a task');
        assert.equal(reference.stopOutcome,'resolved');
        assert.ok(reference.answered.business.providerRequests.length>=2&&reference.answered.business.nativeCommands.length>10);
        // What is compared is not empty: the adopted Type and Relation, the settled Plan, the task's phase,
        // the answer and (for Voice) the inference budgets are all in the projection.
        const referenceTrace=reference.answered.business.traces[0].metadata;
        const referenceParent=reference.answered.business.taskRuntime.parent;
        assert.deepEqual([referenceTrace.currentQuestionSettlementType,referenceTrace.currentQuestionSettlementRelation,
          referenceTrace.settledExecutionPlanQuestionType,referenceTrace.settledExecutionPlanSourceKind,referenceParent.stableKind,
          referenceParent.playbook.phase],['project-deep-dive','new-parent','project-deep-dive',source,'project-deep-dive','project_summary']);
        assert.ok(Object.keys(referenceTrace).length>300,`the trace projection holds ${Object.keys(referenceTrace).length} fields`);
        if(source==='voice')assert.ok(Object.keys(referenceTrace).filter(key=>/BudgetStartsAfter$/.test(key)).length>=2,'inference budgets are compared');
        assert.ok(reference.answered.business.display.sections.primaryAnswer,'the displayed answer is compared');
        // The comparison's own noise floor: two runs with the interface idle are equal.
        assert.deepEqual(ae4Difference(runs['idle-again'].answered.business,reference.answered.business),[],'noise floor, answered');
        assert.deepEqual(ae4Difference(runs['idle-again'].stopped.business,reference.stopped.business),[],'noise floor, stopped');
        for(const mode of AE4_MODES) {
          const run=runs[mode];
          assert.deepEqual(ae4Difference(run.answered.business,reference.answered.business),[],`${source}/${mode}: business projection when answered`);
          assert.deepEqual(ae4Difference(run.stopped.business,reference.stopped.business),[],`${source}/${mode}: business projection after Stop`);
          assert.equal(run.stopOutcome,reference.stopOutcome,`${source}/${mode}: Stop's own exit`);
          assert.deepEqual([run.pageErrors,run.answered.unexpected,run.stopped.unexpected],[[],[],[]],`${source}/${mode}: no page error, no uncontrolled command`);
          assert.deepEqual([run.manifest.status,run.manifest.eventCount],[reference.manifest.status,reference.manifest.eventCount],
            `${source}/${mode}: the recording's own timeline is unchanged`);
          // Only a failing journal write marks the recording, and only as the Recording owner's own incomplete evidence.
          if(mode==='write-failure') {
            assert.deepEqual([run.manifest.integrity,run.manifest.failedPaths],['incomplete',[JOURNAL]]);
            assert.equal(run.manifest.failedWriteCount,run.stopped.mode.failedWrites);
            assert.ok(run.stopped.recordingLastError?.includes(JOURNAL));
          } else {
            assert.deepEqual([run.manifest.integrity,run.manifest.failedWriteCount,run.answered.recordingLastError,run.stopped.recordingLastError],
              [reference.manifest.integrity,0,null,null],`${source}/${mode}: recording integrity`);
          }
          assert.ok(run.stopped.stats.produced>=5,`${source}/${mode}: the facts of the input were produced`);
          assert.equal(run.stopped.stats.produced,runs.idle.stopped.stats.produced,`${source}/${mode}: the same number of facts as the idle interface`);
        }
        // Each mode really happened.
        const mode=name=>({...runs[name].stopped.mode,stats:runs[name].stopped.stats});
        for(const idle of ['idle','idle-again']) {
          assert.deepEqual([mode(idle).attached,mode(idle).stats.delivered,mode(idle).stats.queuePeak],[0,0,0]);
        }
        assert.ok(mode('observer').delivered>=5&&mode('observer').stats.subscriberFailures===0);
        assert.ok(mode('throwing-observer').thrown>=1&&mode('throwing-observer').stats.subscriberFailures===mode('throwing-observer').thrown);
        // An async observer is cut off once per subscription, whatever one batch handed to it
        // before its first rejection ran; an unhandled rejection would be a page error above.
        assert.ok(mode('async-failing-observer').thrown>=1&&mode('async-failing-observer').stats.subscriberFailures>=1&&
          mode('async-failing-observer').stats.subscriberFailures<=mode('async-failing-observer').attached);
        assert.ok(mode('queue-overflow').stats.overflowDropped>=1&&mode('queue-overflow').stats.gapMarkers>=1);
        assert.ok(mode('write-failure').failedWrites>=5&&mode('write-failure').stats.recording.failed===0,
          'a failed write is reported by the recording\'s integrity, not by the synchronous call');
        assert.ok(mode('recorder-throws').recorderThrows>=5&&mode('recorder-throws').stats.recording.failed===mode('recorder-throws').recorderThrows);
        assert.ok(mode('recorder-throws').stats.failureDetails.length<=8,'bounded failure details, no error storm');
      }]);
    }

    aeCases.push(['AE5-manual-across-session','AE3/AE5 a real regenerate is accepted in one runtime session and returns after the session changed: its terminal keeps the action\'s own session and is refused, and the new session starts with its own facts only',async(child,bundle,browser)=>{
      const {page,context,failures}=await openAnswered(child,bundle,browser,'voice');
      try {
        const first=await page.evaluate(()=>window.__s63.meeting.meetingSessionId);
        assert.equal((await installObserver(page,'__aeFirst')).runtimeSessionId,first);
        await installGenerationHold(page);
        // The regenerate is accepted and its Advisor request is in flight.
        const started=await page.evaluate(()=>{
          const o=window.__aeFirst;
          window.__aeHold.armed=true;
          const inFlight=o.until(event=>event.fact==='provider-request-started'&&event.refs.operationKind==='main-advisor',
            event=>event.fact==='terminal'&&event.terminal.object==='manual-action');
          o.regenerate=window.__s63.meeting.regenerateSuggestion();
          return inFlight;
        });
        assert.equal(started.status,'matched',JSON.stringify(started));
        const accepted=(await deliveredEvents(page,'__aeFirst')).find(event=>event.fact==='input-accepted'&&event.refs.manualAction==='regenerate');
        assert.ok(accepted,'the regenerate was accepted in the first session');
        assert.equal(accepted.runtimeSessionId,first);
        // The runtime session changes while the regenerate still awaits its Advisor.
        await page.evaluate(()=>window.__s63.meeting.stopRuntimeRegressionRun());
        const second=await page.evaluate(()=>window.__s63.meeting.meetingSessionId);
        assert.notEqual(second,first);
        assert.deepEqual(await installObserver(page,'__aeSecond'),{accepted:true,runtimeSessionId:second});
        const before=await stats(page);
        // The held request returns; the regenerate records its terminal now.
        await page.evaluate(async()=>{window.__aeHold.release();await window.__aeFirst.regenerate;});
        // A fact of the new session, so its sequence has a first member to read.
        const own=await page.evaluate(()=>{
          const o=window.__aeSecond;
          const cleared=o.until(event=>event.fact==='terminal'&&event.terminal.object==='manual-action'&&event.refs.manualAction==='clear-task');
          window.__s63.meeting.clearActiveTask();
          return cleared;
        });
        assert.equal(own.status,'matched',JSON.stringify(own));
        const after=await stats(page);
        const inSecond=await deliveredEvents(page,'__aeSecond');
        child.diagnostic(`first=${first.slice(-6)} second=${second.slice(-6)} delivered in second=${JSON.stringify(inSecond.map(event=>`${event.sequence} ${label(event)} ${event.refs.manualAction??''}`))} stale ${before.staleSessionRejected}->${after.staleSessionRejected}`);
        assert.ok(after.staleSessionRejected>before.staleSessionRejected,'the old session\'s late facts were refused with their own session');
        assert.equal(inSecond.some(event=>event.refs.manualActionId===accepted.refs.manualActionId),false,
          'the regenerate\'s terminal did not join the new session');
        assert.ok(inSecond.every(event=>event.runtimeSessionId===second));
        assert.equal(inSecond[0].sequence,1,'the new session\'s sequence starts with its own first fact');
        assert.equal(inSecond.some(event=>event.refs.generationLeaseId===started.event.refs.generationLeaseId),false);
        // The first session's observer ended at the run's closed marker.
        const firstLog=await page.evaluate(()=>window.__aeFirst.log);
        assert.equal(firstLog.at(-1).kind,'closed');
        assert.equal(firstLog.at(-1).reason,'scenario-runner-stopped');
        // Saved evidence: the acceptance is in the first session, and no terminal of that action was saved under the second.
        const journal=await readJournal(page);
        const savedFirst=journal.sessions.find(session=>session.runtimeSessionId===first).events;
        assert.ok(savedFirst.some(event=>event.eventId===accepted.eventId));
        assert.equal(journal.sessions.filter(session=>session.runtimeSessionId!==first)
          .some(session=>session.events.some(event=>event.refs.manualActionId===accepted.refs.manualActionId)),false);
        assert.deepEqual(failures,[]);
      } finally {await context.close();}
    }]);

    aeCases.push(['AE6-stop-late-terminal','AE6 the terminal of a request that Stop cancelled arrives after Stop ended the subscriptions and while the recording is closing: it is still a fact of the session, saved by the generation being closed, and the stopped run\'s observer does not receive it',async(child,bundle,browser)=>{
      const {page,context,failures}=await openAnswered(child,bundle,browser,'voice');
      try {
        const sessionId=await page.evaluate(()=>window.__s63.meeting.meetingSessionId);
        await installObserver(page,'__aeRun');
        await installGenerationHold(page);
        const startOfA=await page.evaluate(()=>{
          const o=window.__aeRun;
          window.__aeHold.armed=true;
          const inFlight=o.until(event=>event.fact==='provider-request-started'&&event.refs.operationKind==='main-advisor',
            event=>event.fact==='terminal'&&event.terminal.object==='manual-action');
          o.regenerate=window.__s63.meeting.regenerateSuggestion();
          return inFlight;
        });
        assert.equal(startOfA.status,'matched',JSON.stringify(startOfA));
        // One aggregate write of the recording's close is held at the native boundary.
        await page.evaluate(()=>{
          const invoke=window.__s63.invoke;
          const gate={};
          gate.reached=new Promise(resolve=>{gate.enter=resolve;});
          window.__aeGate=gate;
          window.__s63.invoke=async(name,args={})=>{
            if(!gate.release&&name==='write_meeting_session_recording_text'&&args.relativePath==='metrics/session-summary.json') {
              gate.enter();
              await new Promise(resolve=>{gate.release=resolve;});
            }
            return invoke(name,args);
          };
        });
        // Stop the run. In the same turn, before any later fact can be produced,
        // a new observer subscribes and waits for the cancelled request's terminal.
        const subscription=await page.evaluate(requestId=>{
          window.__aeStopping=window.__s63.meeting.stopRuntimeRegressionRun();
          const o=window.__aeInstallObserver('__aeAfterStop');
          o.terminalOfA=o.until(event=>event.fact==='terminal'&&event.terminal.object==='provider-request'&&event.refs.requestId===requestId);
          return {accepted:o.subscription.accepted,runtimeSessionId:o.subscription.runtimeSessionId};
        },startOfA.event.refs.requestId);
        assert.deepEqual(subscription,{accepted:true,runtimeSessionId:sessionId},'Stop ended the run\'s subscriptions, not the session');
        await page.evaluate(()=>window.__aeGate.reached);
        assert.equal(await page.evaluate(()=>window.__ae.recording()?.lifecycle),'closing');
        // The cancelled request returns now, while the recording is closing.
        const terminal=await page.evaluate(()=>{window.__aeHold.release();return window.__aeAfterStop.terminalOfA;});
        assert.equal(terminal.status,'matched',JSON.stringify(terminal));
        assert.deepEqual([terminal.event.terminal.disposition,terminal.event.runtimeSessionId],['aborted',sessionId]);
        await page.evaluate(async()=>{window.__aeGate.release();await window.__aeStopping;await window.__aeRun.regenerate;});
        // The stopped run's observer: everything up to Stop, one closed marker, and not the late terminal.
        const runLog=await page.evaluate(()=>window.__aeRun.log);
        assert.equal(runLog.at(-1).kind,'closed');
        assert.equal(runLog.at(-1).reason,'scenario-runner-stopped');
        assert.equal(runLog.some(delivery=>delivery.kind==='event'&&delivery.event.eventId===terminal.event.eventId),false);
        assert.ok(terminal.event.sequence>runLog.at(-1).lastSequence,'the late terminal continues the session\'s own sequence');
        // The recording that Stop closed holds the start and its terminal, with no hole.
        const journal=await readJournal(page);
        const saved=journal.sessions.find(session=>session.runtimeSessionId===sessionId);
        child.diagnostic(`saved tail=${JSON.stringify(saved.events.filter(event=>event.sequence>=startOfA.event.sequence).map(event=>`${event.sequence} ${label(event)}`))}`);
        assert.deepEqual(saved.gaps,[]);
        const savedStart=saved.events.find(event=>event.eventId===startOfA.event.eventId);
        const savedTerminal=saved.events.find(event=>event.eventId===terminal.event.eventId);
        assert.ok(savedStart&&savedTerminal,'the started request and its terminal are both saved');
        assert.equal(savedTerminal.recordingGenerationId,savedStart.recordingGenerationId,'by the generation that Stop closed');
        assert.ok(saved.events.some(event=>event.terminal?.object==='generation'&&
          event.refs.generationLeaseId===startOfA.event.refs.generationLeaseId),'and the generation\'s own terminal');
        const after=await stats(page);
        assert.equal(after.lateAfterClose,0);
        assert.deepEqual(failures,[]);
      } finally {await context.close();}
    }]);
}

test('S63 finite real consumer executions',{timeout:600000,skip:browserTestSkip},async t=>{
  const enabled=new Set((process.env.S63_EXECUTIONS??[...fixtures.S63_CONSUMER_EXECUTIONS.map(item=>item.executionId),
    ...aeCases.map(([id])=>id)].join(',')).split(','));
  const implemented=new Set([...fixtures.S63_CONSUMER_EXECUTIONS.map(item=>item.executionId),...aeCases.map(([id])=>id)]);
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
    // Task 178A: the same host with the Hook's stream exposed inside the bundle.
    const selectedAeCases=aeCases.filter(([id])=>enabled.has(id));
    if(selectedAeCases.length) {
      const aeBundle=await browserBundle([criticalEventStreamPlugin]);
      for(const [id,name,run] of selectedAeCases) {
        await t.test(`${id}: ${name}`,child=>run(child,aeBundle,browser));
      }
    }
  }finally{await browser.close();}
});
}
