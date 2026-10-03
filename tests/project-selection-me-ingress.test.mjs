import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import {
  browserBundle, browserTestSkip, fixtures, openProjectSelectionBrowserHost, playwright,
  readRecordedSelectionTrace,
} from "./project-selection-hook-browser.test.mjs";

// Expose an existing accepted-STT boundary only inside the test bundle. The
// canonical ingress, inference scheduler, binding and publication stay intact.
const finalMeIngressPlugin = {
  name: "pd5-existing-final-me-ingress",
  setup(builder) {
    builder.onLoad({filter:/useMeetingAssistant\.ts$/},args=>{
      const source=readFileSync(args.path,"utf8");
      const file=ts.createSourceFile(args.path,source,ts.ScriptTarget.Latest,true);
      const hook=file.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='useMeetingAssistant');
      assert.ok(hook?.body);
      const returns=hook.body.statements.filter(ts.isReturnStatement);
      assert.equal(returns.length,1,'expose ingress at the actual Hook return, without replacing any callback');
      const at=returns[0].getStart(file);
      const exposure=`window.__pd5Ingress = {
        accept: processCanonicalTurnIngress,
        traces: traceStoreRef.current,
        readTransportSessionId: () => audioSessionIdRef.current,
      };\n`;
      return {contents:source.slice(0,at)+exposure+source.slice(at),loader:'ts',resolveDir:path.dirname(args.path)};
    });
  },
};

const cases = [
  {id:'PD5-Me-explicit',kind:'choice',text:'I choose Quartz Relay.'},
  {id:'PD5-Me-null',kind:'null',text:'I have worked on both of those projects.'},
  {id:'PD5-Me-duplicate-final',kind:'duplicate',text:'I choose Quartz Relay.'},
  {id:'PD5-Me-late-after-button',kind:'button-race',text:'I choose Quartz Relay.'},
  {id:'PD5-Me-late-after-owner-change',kind:'owner-race',text:'I choose Quartz Relay.'},
];

async function installMeProvider(page,scenario) {
  await page.evaluate(({scenario,factA,factB})=>{
    const underlyingFetch=window.fetch;
    const control={requests:[],advisorRequests:[],hold:scenario.kind.endsWith('race'),waiters:[],released:0,
      answerProjectId:'quartz_relay',release(){this.hold=false;for(const release of this.waiters.splice(0))release();}};
    window.__pd5Provider=control;
    const response=text=>new Response(
      'data: '+JSON.stringify({choices:[{delta:{content:text},finish_reason:null}]})+'\n\n'+
      'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',
      {headers:{'Content-Type':'text/event-stream'}});
    window.fetch=async(url,init)=>{
      const body=JSON.parse(init.body);
      const system=body.messages.find(message=>message.role==='system')?.content??'';
      const userMessage=body.messages.find(message=>message.role==='user');
      const user=typeof userMessage?.content==='string'?userMessage.content:
        userMessage?.content.find(part=>part.type==='text')?.text??'';
      if(system.startsWith("Resolve only the user's affirmative project choice")) {
        const captured={system,user,body,aborted:false};
        control.requests.push(captured);
        init.signal?.addEventListener('abort',()=>{captured.aborted=true;},{once:true});
        if(control.hold)await new Promise(resolve=>control.waiters.push(resolve));
        // Deliberately allow a delayed external result after abort. Real request
        // and lease owners must decide whether it can have any effect.
        captured.abortedBeforeRelease=captured.aborted;
        control.released++;
        return response(JSON.stringify({schemaVersion:1,projectId:scenario.kind==='null'?null:'quartz_relay',
          evidenceSpans:scenario.kind==='null'?[]:[scenario.text]}));
      }
      if(system.startsWith('You are a live meeting co-pilot')&&window.__s63.stage==='selected') {
        const expected=control.answerProjectId==='cedar_analytics'?factA:factB;
        const forbidden=control.answerProjectId==='cedar_analytics'?factB:factA;
        if(!user.includes(expected)||user.includes(forbidden))throw new Error('PD5 actual Advisor Prompt has missing/wrong-project facts');
        control.advisorRequests.push({user,projectId:control.answerProjectId});
        return response('Answer: '+expected+'\n\nClarifying question: -\n\nClarifying options: -');
      }
      return underlyingFetch(url,init);
    };
  },{scenario,factA:fixtures.S63_FACT_A,factB:fixtures.S63_FACT_B});
}

async function deliverFinalMe(page,scenario,duplicate=false) {
  return page.evaluate(async({text,id,duplicate})=>{
    const boundary=window.__pd5Ingress;
    const now=Date.now();
    const trace=boundary.traces.startTrace('voice',{speaker:'me',source:'microphone',syntheticValidation:true});
    const turn={id,speaker:'me',source:'microphone',text,startedAt:now-1800,endedAt:now,isFinal:true};
    const segment={audioBase64Chars:0,sessionId:boundary.readTransportSessionId(),sequence:1,
      queuedAt:now,queueDepthAtEnqueue:0,speaker:'me',source:'microphone',traceId:trace.id};
    await boundary.accept({turn:structuredClone(turn),segment,transport:'accepted-stt'});
    if(duplicate)await boundary.accept({turn:structuredClone(turn),segment,transport:'accepted-stt'});
    return {traceId:trace.id,turnId:id,text};
  },{text:scenario.text,id:`${scenario.id}-final-turn`,duplicate});
}

async function waitMeDisposition(page,traceId,expected) {
  await page.waitForFunction(({traceId,expected})=>window.__s63.meeting.traces.some(trace=>
    trace.id===traceId&&expected.includes(trace.metadata?.projectSelectionDisposition)
  ),{traceId,expected},{timeout:6000});
}

async function inspect(page,turn) {
  return page.evaluate(({traceId,turnId})=>({
    parent:window.__s63.meeting.taskRuntime.parent,
    display:window.__s63.observed.adviseDisplay,
    choice:window.__s63.observed.projectChoice,
    meTrace:window.__s63.meeting.traces.find(trace=>trace.id===traceId),
    selections:window.__s63.meeting.traces.filter(trace=>trace.metadata?.clarifyingRequestId),
    meTurns:window.__s63.meeting.transcriptTurns.filter(item=>item.id===turnId),
    inferenceRequests:window.__pd5Provider.requests,
    advisorRequests:window.__pd5Provider.advisorRequests,
    released:window.__pd5Provider.released,
    unexpected:window.__s63.unexpected,
  }),turn);
}

async function execute(t,bundle,browser,scenario) {
  const host=await openProjectSelectionBrowserHost(t,bundle,browser,{source:'voice',surface:'normal'});
  const {page,context,failures}=host;
  try {
    const before=await page.evaluate(()=>({parentId:window.__s63.meeting.taskRuntime.parent.id,
      phase:window.__s63.meeting.taskRuntime.parent.playbookPhase,
      revision:window.__s63.observed.adviseDisplay.stable.revision}));
    await installMeProvider(page,scenario);
    await page.evaluate(()=>{window.__s63.stage='selected';});
    const turn=await deliverFinalMe(page,scenario,scenario.kind==='duplicate');
    await page.waitForFunction(()=>window.__pd5Provider.requests.length>0,undefined,{timeout:4000});

    if(scenario.kind==='button-race') {
      await page.evaluate(()=>{window.__pd5Provider.answerProjectId='cedar_analytics';});
      await page.getByRole('button',{name:'Cedar Analytics',exact:true}).click();
      await page.waitForFunction(()=>window.__s63.observed.selection?.status==='succeeded',undefined,{timeout:5000});
      await page.evaluate(()=>window.__pd5Provider.release());
      await waitMeDisposition(page,turn.traceId,['stale']);
    } else if(scenario.kind==='owner-race') {
      await page.evaluate(nextQuestion=>{
        window.__s63.stage='replacement';
        window.__s63.meeting.clearActiveTask();
        window.__pd5Replacement=window.__s63.meeting.submitRuntimeRegressionText(nextQuestion);
      },fixtures.S63_NEXT_SOURCE_QUESTION);
      await page.waitForFunction(parentId=>window.__s63.meeting.taskRuntime.parent?.id&&
        window.__s63.meeting.taskRuntime.parent.id!==parentId,before.parentId,{timeout:5000});
      await page.evaluate(()=>window.__pd5Provider.release());
      await page.evaluate(()=>window.__pd5Replacement);
      await waitMeDisposition(page,turn.traceId,['stale']);
    } else if(scenario.kind==='null') {
      await waitMeDisposition(page,turn.traceId,['choice-unresolved']);
    } else {
      await page.waitForFunction(traceId=>window.__s63.meeting.traces.some(trace=>
        trace.id===traceId&&trace.metadata?.projectSelectionBindingTerminal==='succeeded'
      ),turn.traceId,{timeout:8000});
    }

    const result=await inspect(page,turn);
    assert.equal(result.inferenceRequests.length,1,'one physical inference per admitted final-Me identity');
    assert.equal(result.meTrace.metadata.canonicalTurnIngressTransport,'accepted-stt');
    assert.equal(result.meTrace.metadata.canonicalTurnIngressSpeaker,'me');
    assert.equal(result.meTrace.metadata.canonicalTurnIngressTurnId,turn.turnId);
    assert.equal(result.meTrace.metadata.projectSelectionSourceTurnId,turn.turnId);
    assert.equal(result.released,1);
    if(scenario.kind.endsWith('race'))assert.equal(result.inferenceRequests[0].abortedBeforeRelease,true,
      'release the delayed external result only after real runtime cancellation');
    assert.ok(result.meTurns.some(item=>item.text===scenario.text&&item.isFinal));
    const payload=result.inferenceRequests[0].user;
    assert.ok(payload.includes(scenario.text));
    assert.ok(payload.includes('cedar_analytics')&&payload.includes('quartz_relay'));
    assert.ok(!payload.includes(fixtures.S63_FACT_A)&&!payload.includes(fixtures.S63_FACT_B),'selection inference receives identities, not Memory fact bodies');

    if(scenario.kind==='choice'||scenario.kind==='duplicate') {
      assert.equal(result.parent.id,before.parentId);
      assert.equal(result.parent.playbookPhase,before.phase);
      assert.equal(result.parent.projectBinding.projectId,'quartz_relay');
      assert.equal(result.parent.projectBinding.revision,1);
      assert.equal(result.parent.projectBinding.authority,'user-explicit');
      assert.ok(result.parent.projectBinding.sourceTurnIds.includes(turn.turnId));
      assert.ok(result.display.sections.primaryAnswer.includes(fixtures.S63_FACT_B));
      assert.equal(result.advisorRequests.length,1);
      assert.equal(result.selections.length,1);
      const selection=result.selections[0];
      assert.ok(selection.metadata.projectBindingSourceTurnIds.includes(turn.turnId));
      assert.equal(selection.metadata.advisorStablePublicationCommitted,true);
      const saved=await readRecordedSelectionTrace(page,selection.metadata.clarifyingRequestId,'succeeded');
      assert.equal(saved.id,selection.id);
    } else if(scenario.kind==='null') {
      assert.equal(result.parent.id,before.parentId);
      assert.equal(result.parent.projectBinding,undefined);
      assert.equal(result.display.stable.revision,before.revision);
      assert.equal(result.choice.canSelect,true);
      assert.equal(result.advisorRequests.length,0);
      assert.equal(result.selections.length,0);
    } else if(scenario.kind==='button-race') {
      assert.equal(result.parent.id,before.parentId);
      assert.equal(result.parent.projectBinding.projectId,'cedar_analytics');
      assert.equal(result.parent.projectBinding.revision,1);
      assert.ok(!result.parent.projectBinding.sourceTurnIds.includes(turn.turnId));
      assert.ok(result.display.sections.primaryAnswer.includes(fixtures.S63_FACT_A));
      assert.equal(result.advisorRequests.length,1);
      assert.equal(result.selections.length,1);
    } else {
      assert.notEqual(result.parent.id,before.parentId);
      assert.equal(result.parent.stableKind,'coding');
      assert.equal(result.parent.projectBinding,undefined);
      assert.equal(result.advisorRequests.length,0);
      assert.equal(result.selections.length,0);
      assert.ok(!result.display.sections.primaryAnswer.includes(fixtures.S63_FACT_B));
    }
    assert.deepEqual(result.unexpected,[]);
    assert.deepEqual(failures,[]);
    await page.waitForFunction(({traceId,turnId,disposition,terminal})=>{
      const payload=window.__s63.writes.get(`traces/${traceId}.json`);
      if(!payload)return false;
      const saved=JSON.parse(payload).trace;
      return saved?.metadata?.projectSelectionSourceTurnId===turnId&&
        saved.metadata.projectSelectionDisposition===disposition&&
        (!terminal||saved.metadata.projectSelectionBindingTerminal===terminal);
    },{...turn,disposition:result.meTrace.metadata.projectSelectionDisposition,
      terminal:result.meTrace.metadata.projectSelectionBindingTerminal},{timeout:5000});
    t.diagnostic(`${scenario.id}: real final-Me ingress ${turn.turnId}; disposition=${result.meTrace.metadata.projectSelectionDisposition}; binding terminal=${result.meTrace.metadata.projectSelectionBindingTerminal??'none'}`);
  } catch(error) {
    t.diagnostic(`PD5 first divergence=${JSON.stringify(await page.evaluate(()=>({
      error:window.__s63.meeting.error,parent:window.__s63.meeting.taskRuntime.parent&&{
        id:window.__s63.meeting.taskRuntime.parent.id,binding:window.__s63.meeting.taskRuntime.parent.projectBinding},
      inference:window.__pd5Provider?.requests,advisorRequests:window.__pd5Provider?.advisorRequests?.length,
      traces:window.__s63.meeting.traces.map(trace=>({id:trace.id,status:trace.status,error:trace.error,
        metadata:Object.fromEntries(Object.entries(trace.metadata??{}).filter(([key])=>/projectSelection|projectBinding|canonicalTurnIngress|clarifying|advisorStablePublication|runtimeEpoch/i.test(key)))})),
    })))}`);
    throw error;
  } finally {await context.close();}
}

test('PD5 bounded real final-Me ingress consumer cases',{timeout:90000,skip:browserTestSkip},async t=>{
  const enabled=new Set((process.env.PD5_ME_CASES??cases.map(item=>item.id).join(',')).split(','));
  for(const id of enabled)assert.ok(cases.some(item=>item.id===id),`unknown PD5 case ${id}`);
  const bundle=await browserBundle([finalMeIngressPlugin]);
  const browser=await playwright.chromium.launch({headless:true,executablePath:process.env.JARVIS_CHROMIUM_EXECUTABLE});
  try {
    for(const scenario of cases.filter(item=>enabled.has(item.id))) {
      let failed=false;
      await t.test(scenario.id,async child=>{
        try {await execute(child,bundle,browser,scenario);}catch(error){failed=true;throw error;}
      });
      if(failed)break;
    }
  }finally{await browser.close();}
});
