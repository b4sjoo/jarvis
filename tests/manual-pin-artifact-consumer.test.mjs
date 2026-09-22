import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const root = path.resolve(process.env.JARVIS_TEST_OUTPUT_DIR ?? ".tmp-tests");
const modules = {};
for (const name of ["manual-advise-display", "unpublished-artifact", "meeting-answer", "meeting-answer-display",
  "stable-answer", "response-action-target", "artifact-regeneration", "human-evaluation", "manual-runtime-action", "current-question-settlement"]) {
  Object.assign(modules, await import(pathToFileURL(path.join(root, `src/lib/meeting/${name}.js`))));
}
const source = ts.createSourceFile("hook.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);
function find(ast, predicate) {
  let match;
  const visit = (node) => { if (predicate(node)) match ??= node; if (!match) ts.forEachChild(node, visit); };
  visit(ast); assert.ok(match); return match;
}
function declaration(name) { return find(source, n => ts.isVariableDeclaration(n) && n.name.getText(source) === name); }
function evaluate(text, context) {
  return vm.runInContext(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, context);
}
function callback(name, context) { return evaluate(`(${declaration(name).initializer.arguments[0].getText(source)})`, context); }

function fixture() {
  // Reuse the characterized source-owner fixture, not a second authority implementation.
  const ast = ts.createSourceFile("fixture.ts", readFileSync("tests/response-action-target.test.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const names = new Set(["voiceLogicalQuestion", "voiceSourceHash", "frozenSettlement", "stable", "context", "effectiveVoiceRecord"]);
  const declarations = ast.statements.filter(n => ts.isFunctionDeclaration(n) ? names.has(n.name.text) :
    ts.isVariableStatement(n) && names.has(n.declarationList.declarations[0].name.getText(ast)));
  return evaluate(`${declarations.map(n => n.getText(ast)).join("\n")}\n({stable, context:context(), unit:voiceLogicalQuestion, records:[effectiveVoiceRecord()]})`, vm.createContext({...modules}));
}
function harness() {
  const f = fixture(), calls = [], events = [], traces = [];
  f.stable.suggestion.sourceTraceId = "trace-A";
  const display = new modules.ManualAdviseDisplay();
  const snapshot = { stable: f.stable, streaming: false,
    target: { sessionId: "session-a", suggestionId: "suggestion-a", traceId: "trace-A", stableRevision: 5 },
    sections: modules.buildMeetingAnswerDisplayModel({ content: f.stable.suggestion.content }) };
  display.select(snapshot, snapshot); display.toggle();
  const b = structuredClone(f.stable); b.revision = 6; b.suggestion.id = "hidden-B"; b.suggestion.content = "Answer: hidden B";
  const environment = {
    ...modules, structuredClone, Date, console,
    manualAdviseDisplayRef: {current:display}, stableAnswerRevisionRef: {current:b},
    contextManagerRef: {current:{clearExpiredActiveMeetingTask(){},getState:()=>f.context}},
    logicalQuestionUnitRef:{current:{...f.unit,id:"hidden-B-unit"}}, effectiveQuestionSourceLedgerRef:{current:{list:()=>f.records}},
    runtimeEpochRef:{current:3}, currentSuggestionText:b.suggestion.content,
    state:{status:"listening"}, createMeetingId:()=>`action-${events.length}`,
    recordManualRuntimeAction:event=>events.push(event), isManualRuntimeActionBusy:()=>false,
    setState(){}, flushPendingSentenceCompletion(){}, activateAdvisorJob:()=>true,
    buildAdvisorJob:job=>({...job,id:"job",traceId:"manual-trace"}),
    runAdvisor:async options=>calls.push(options),
    traceStoreRef:{current:{getTraces:()=>traces,startTrace:()=>({id:"manual-trace"}),finishTrace(){},updateMetadata(){}}},
    projectObservedAdvisorAttempt:()=>({outcome:"visible-committed"}),
    resolveCurrentSuggestionQuestionLineage:()=>{throw new Error("must use captured source");},
    buildEffectiveAdvisorBasePromptContext:()=>({}),
    composeContextScopeAdvisorPromptContext:({logicalQuestionUnit})=>({promptContext:{},logicalQuestionUnitId:logicalQuestionUnit.id,
      logicalQuestionUnitRevision:logicalQuestionUnit.revision,budgets:{maxExpansionChars:0}}),
    formatContextScopeResponseActionForTrace:()=>({}),
  };
  const context = vm.createContext(environment);
  return {f, snapshot, display, environment, context, calls, events};
}

for (const action of ["regenerate", "enhance-context", "narrow-context", "regenerate-artifacts", "speakable"]) {
  test(`ML7 actual ${action} ingress freezes visible A while background is B`, async () => {
    const h = harness();
    if (action === "regenerate-artifacts") {
      h.f.stable.settlementSnapshot.questionType = "coding";
      h.f.context.activeMeetingTask.parent.questionType = "coding";
      h.f.context.activeMeetingTask.parent.playbookPhase = "implementation_validation";
      const snap = {...h.snapshot, stable:structuredClone(h.f.stable)};
      h.display.clear(); h.display.select(snap,snap); h.display.toggle();
    }
    const invocation={displayTarget:h.snapshot.target,uiSurface:"focus-mode",actionId:"focus-A"};
    if (action === "regenerate") await callback("regenerateSuggestion",h.context)(invocation);
    else await callback("applyResponseAction",h.context)(action,invocation);
    assert.equal(h.calls.length,1);
    const request=h.calls[0].advisorJob ?? h.calls[0];
    assert.equal(request.logicalQuestionUnit.id,"question-voice");
    assert.equal(request.currentSuggestion,h.f.stable.suggestion.content);
    assert.equal(request.currentQuestionSettlementOverride.settlementId,"settlement-voice");
    for(const event of h.events) {
      assert.equal(event.observedVisibleAnswerRevision,5);
      assert.equal(event.observedLogicalQuestionUnitId,"question-voice");
    }
    h.calls.length=0;
    const old={...invocation,displayTarget:{...invocation.displayTarget,suggestionId:"different-render"}};
    if(action==="regenerate") await callback("regenerateSuggestion",h.context)(old);
    else await callback("applyResponseAction",h.context)(action,old);
    assert.equal(h.calls.length,0,"old Focus snapshot must not retarget");
    h.f.context.activeMeetingTask.parent.id="exited-parent";
    if(action==="regenerate") await callback("regenerateSuggestion",h.context)(invocation);
    else await callback("applyResponseAction",h.context)(action,invocation);
    assert.equal(h.calls.length,0,"retired source cannot borrow B authority");
  });
}

function reuseHarness(whiteboard = false) {
  const slot=new modules.UnpublishedArtifactSlot();
  const raw=whiteboard?"Answer: accepted\n\nWhiteboard: A --> B":"Answer: accepted\n\nCode:\n```ts\nreturn 42;\n```\n\nComplexity: O(1)";
  const parsed=modules.parseMeetingAnswer(raw);
  const suggestion={id:"G2",sourceTraceId:"G2",content:raw,meetingAnswer:parsed,kind:"answer",createdAt:1,
    basedOnTurnIds:[],basedOnObservationIds:[],confidence:"high"};
  const stable=modules.commitStableAnswerRevision({candidate:suggestion,authorizedArtifacts:["answer"],taskId:"p",
    logicalQuestionUnitId:"q",logicalQuestionRevision:1,sessionId:"s",runtimeEpoch:1,settlementId:"S2"});
  const target={sessionId:"s",runtimeEpoch:1,visibleAnswerRevision:stable.revision,logicalQuestionUnitId:"q",
    logicalQuestionRevision:1,settlementId:"S2",parentId:"p",parentRevision:3,questionType:whiteboard?"general-system-design":"coding",
    playbookPhase:whiteboard?"design_framing":"implementation_validation",phaseOwnerKind:"parent",phaseOwnerId:"p",phaseOwnerRevision:3,
    sectionOwner:{kind:"parent-mainline",parentId:"p"},artifactFamilies:whiteboard?["whiteboard"]:["code","complexity"]};
  const inputs={manualCorrectionRevision:1,preparationContextRevision:1,settings:{useMemory:false}};
  slot.accepted({stable,current:stable,target,currentInputs:inputs,offer:{parsed,authorizedArtifacts:["answer"],inputs}});
  let requests=0;
  const metadata={};
  const env={...modules,Date,structuredClone,
    options:{artifactRegenerationTarget:target,currentSuggestion:stable.suggestion.content},
    unpublishedArtifactSlotRef:{current:slot},stableAnswerRevisionRef:{current:stable}, readArtifactReuseInputs:()=>inputs,
    validateWhiteboardRenderCandidate:async()=>({valid:true}),rejectStaleCommit:()=>false,
    traceId:"manual",requestId:"manual-request",advisorAnswerProfile:undefined,advisorPromptMode:"response-action",
    advisorModelPromptContext:{},advisorModelRoute:{},advisorScreenSourceRead:{},advisorModelRequestOptions:{},
    advisorModelExecutionIdentity:{},responseConfig:{},advisorModelCurrentSuggestion:stable.suggestion.content,
    traceStoreRef:{current:{updateMetadata:(_,update)=>Object.assign(metadata,update)}},
    advisorEngineRef:{current:{
      toSuggestion:(id,content,_turns,_observations,_task,meetingAnswer)=>({...suggestion,id,content,meetingAnswer}),
      async *streamSuggestion(){requests++;yield {type:"candidate",candidate:{content:raw,attempts:[]}};},
    }},
  };
  const run=declaration("runAdvisor").initializer.arguments[0];
  const attempt=find(run,n=>ts.isTryStatement(n) && n.tryBlock.statements[0]?.getText(source).includes("unpublishedArtifactSlotRef.current.take"));
  const statements=attempt.tryBlock.statements.slice(0,2);
  assert.match(statements[1].getText(source),/if \(!reusedArtifactCandidate\)/);
  const context=vm.createContext(env);
  return {slot,stable,target,inputs,env,metadata,get requests(){return requests;},
    execute:()=>evaluate(`(async()=>{let finalContent="",reusedArtifactCandidate,reusedWhiteboardValidation,advisorResponseCandidate;
      ${statements.map(n=>n.getText(source)).join("\n")}
      return {finalContent,reusedArtifactCandidate,advisorResponseCandidate};})()`,context)};
}

test("AR-C1/4/5 real candidate source branch skips main Advisor once, then generates", async()=>{
  const h=reuseHarness();
  const result=await h.execute();
  assert.equal(h.requests,0); assert.equal(result.reusedArtifactCandidate.suggestionId,"G2");
  assert.equal(h.metadata.artifactCandidateSource,"reused");
  assert.equal(h.metadata.artifactReuseMainAdvisorCalled,false);
  assert.equal(result.advisorResponseCandidate,undefined,"no copied Provider attempts");
  await h.execute(); assert.equal(h.requests,1);
});

test("AR-C3 real Whiteboard validation failure falls through to main Advisor",async()=>{
  const h=reuseHarness(true);
  h.env.validateWhiteboardRenderCandidate=async()=>({valid:false});
  const result=await h.execute(); assert.equal(h.requests,1);
  assert.equal(result.reusedArtifactCandidate,undefined); assert.equal(h.metadata.artifactReuseValidationPassed,false);
});

test("AR-C2/4 Correction during async validation drops reserved candidate without model or publication",async()=>{
  const h=reuseHarness(true);
  let stale=false;
  h.env.validateWhiteboardRenderCandidate=async()=>{stale=true;h.inputs.manualCorrectionRevision++;return {valid:true};};
  h.env.rejectStaleCommit=()=>stale;
  assert.equal(await h.execute(),undefined); assert.equal(h.requests,0); assert.equal(h.slot.present,false);
});

test("AR-C1/4 real post-commit offer consumer admits Correction G2, ignores late G1, and clears on no-candidate G3",()=>{
  const h=harness();
  h.f.context.activeMeetingTask.parent.questionType="coding";
  h.f.context.activeMeetingTask.parent.playbookPhase="implementation_validation";
  const parsed=modules.parseMeetingAnswer("Answer: Accepted correction.\n\nCode:\n```ts\nreturn 42;\n```\n\nComplexity: O(1)");
  const slot=new modules.UnpublishedArtifactSlot();
  const inputs={manualCorrectionRevision:1,preparationContextRevision:1,settings:{}};
  const make=(id)=>modules.commitStableAnswerRevision({
    candidate:{...h.f.stable.suggestion,id,sourceTraceId:id,content:parsed.rawContent,meetingAnswer:parsed},
    authorizedArtifacts:["answer"],taskId:h.f.stable.taskId,
    logicalQuestionUnitId:h.f.stable.logicalQuestionUnitId,logicalQuestionRevision:h.f.stable.logicalQuestionRevision,
    sessionId:h.f.stable.sessionId,runtimeEpoch:3,questionSourceHash:h.f.stable.questionSourceHash,settlementId:"S2",
    settlementSnapshot:{...h.f.stable.settlementSnapshot,questionType:"coding",settlementId:"S2",manualCorrectionRevision:1},
  });
  const g2=make("G2");
  const scope={...h.environment,stable:g2,activeContextState:h.f.context,
    options:{unpublishedArtifacts:{parsed,authorizedArtifacts:["answer"],inputs}},
    stableAnswerRevisionRef:{current:g2},unpublishedArtifactSlotRef:{current:slot},
    readArtifactReuseInputs:()=>inputs,sessionRecordingManagerRef:{current:undefined}};
  const block=find(declaration("finalizeStableAnswerPublication"),n=>ts.isIfStatement(n)&&n.getText(source).includes("unpublishedArtifactSlotRef.current.accepted"));
  const context=vm.createContext(scope);
  evaluate(block.getText(source),context); assert.equal(slot.present,true);
  scope.stable=make("G1"); scope.options={};
  evaluate(block.getText(source),context); assert.equal(slot.present,true,"late G1 must not erase G2");
  const visibleSource=modules.resolveVisibleAnswerResponseActionTarget({stableAnswer:g2,
    currentLogicalQuestionUnit:h.f.unit,effectiveQuestionSources:h.f.records,meetingContext:h.f.context,runtimeEpoch:3});
  const decision=modules.resolveArtifactRegenerationTarget({stableAnswer:g2,visibleSource,
    activeMeetingTask:h.f.context.activeMeetingTask,sessionId:"session-a",runtimeEpoch:3});
  assert.equal(slot.take({stable:g2,target:decision.target,inputs}).candidate.suggestionId,"G2");
  scope.stable=g2; scope.options={unpublishedArtifacts:{parsed,authorizedArtifacts:["answer"],inputs}};
  evaluate(block.getText(source),context);
  scope.stable=make("G3");scope.stableAnswerRevisionRef.current=scope.stable;scope.options={};
  evaluate(block.getText(source),context);assert.equal(slot.present,false);
});

test("ML7 actual evaluation label handler captures rendered A even with a newer background B trace",()=>{
  const ui=ts.createSourceFile("meeting.tsx",readFileSync("src/pages/app/components/meeting/index.tsx","utf8"),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const panel=find(ui,n=>ts.isJsxSelfClosingElement(n)&&n.tagName.getText(ui)==="TraceHumanEvaluationPanel"&&n.getText(ui).includes("key={evaluationTrace.id}"));
  const attribute=panel.attributes.properties.find(n=>n.name?.getText(ui)==="onRecordGroundTruthV2");
  const writes=[];
  const context=vm.createContext({evaluationTrace:{id:"trace-A"},meeting:{traces:[{id:"trace-B"},{id:"trace-A"}],
    recordHumanGroundTruthV2:(...args)=>writes.push(args)}});
  const handler=evaluate(`(${attribute.initializer.expression.getText(ui)})`,context);
  handler({kind:"answer-quality",outcome:"ok"},{source:"human"});
  assert.equal(writes[0][0],"trace-A");
  assert.equal(writes[0][2].uiSurface,"normal-debug-evaluation");
});

test("ML1 actual shortcut callback reaches the same pin handler with frontend receipt identity and debounce",()=>{
  const h=harness();
  Object.assign(h.environment,{answerDeliveryProgressRef:{current:null},tryCommitPendingAnswer(){},
    sessionRecordingManagerRef:{current:undefined}});
  const toggle=callback("toggleAdvisePin",h.context);
  const ui=ts.createSourceFile("meeting.tsx",readFileSync("src/pages/app/components/meeting/index.tsx","utf8"),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const ingress=find(ui,n=>ts.isFunctionDeclaration(n)&&n.name?.text==="manualShortcutInvocation");
  const handler=find(ui,n=>ts.isPropertyAssignment(n)&&n.name.getText(ui)==="meeting_toggle_advise_pin");
  const context=vm.createContext({meeting:{toggleAdvisePin:toggle},adviseDisplay:h.snapshot,focusModeActive:true,
    resolveShortcutDisplayTarget:()=>h.snapshot.target,isJarvisEditableElementFocused:()=>false});
  evaluate(ingress.getText(ui),context);
  const dispatch=evaluate(`(${handler.initializer.getText(ui)})`,context);
  dispatch({invocationId:"shortcut-pin",receivedAt:123,disposition:"dispatch"});
  assert.equal(h.display.locked,false);
  const accepted=h.events.filter(event=>event.actionId==="shortcut-pin");
  assert.deepEqual(accepted.map(event=>event.stage),["requested","accepted","terminal"]);
  assert.equal(accepted[0].ingressReceivedAt,123);
  dispatch({invocationId:"shortcut-debounce",receivedAt:124,disposition:"debounced"});
  assert.equal(h.display.locked,false);assert.equal(h.events.at(-1).reason,"shortcut-debounced");
  assert.equal(h.calls.length,0);
});
