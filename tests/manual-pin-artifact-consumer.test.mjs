import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const root = path.resolve(process.env.JARVIS_TEST_OUTPUT_DIR ?? ".tmp-tests");
const modules = {};
const moduleNames = ["manual-advise-display", "unpublished-artifact", "meeting-answer", "meeting-answer-display",
  "stable-answer", "response-action-target", "artifact-regeneration", "human-evaluation", "manual-runtime-action",
  "current-question-settlement", "staged-answer-delivery", "answer-generation-lease", "runtime-commit-authorization",
  "manual-question-type-correction", "bounded-recent-history", "suggestion-task",
  "advisor-trigger-job", "logical-question-ownership", "generation-result-ledger",
  "whiteboard-artifact", "whiteboard-format-policy", "context-manager", "response-artifact-authorization",
  "visual-evidence-recovery", "source-owned-transition-transaction",
  "interview-playbook", "playbook-phase", "generated-answer-consumer", "fact-anchor-guardrail", "fact-anchor-output-guardrail"];
for (const name of moduleNames) {
  Object.assign(modules, await import(pathToFileURL(path.join(root, `src/lib/meeting/${name}.js`))));
}
const source = ts.createSourceFile("hook.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);
// Opt-in regression proof executes the same assertions against unmodified Git callbacks.
const publicationSource = process.env.JARVIS_TEST_PUBLICATION_BASELINE
  ? ts.createSourceFile("baseline-hook.ts", execFileSync("git", ["show",
    `${process.env.JARVIS_TEST_PUBLICATION_BASELINE}:src/hooks/useMeetingAssistant.ts`], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }), ts.ScriptTarget.Latest, true)
  : source;
function find(ast, predicate) {
  let match;
  const visit = (node) => { if (predicate(node)) match ??= node; if (!match) ts.forEachChild(node, visit); };
  visit(ast); assert.ok(match); return match;
}
function declaration(name, ast = source) { return find(ast, n => ts.isVariableDeclaration(n) && n.name.getText(ast) === name); }
function evaluate(text, context) {
  return vm.runInContext(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, context);
}
function callback(name, context, ast = source) { return evaluate(`(${declaration(name, ast).initializer.arguments[0].getText(ast)})`, context); }

function bindQuestionReaders(env, context) {
  for (const name of ["readStableAnswerForQuestion", "isSelectedHistoricalQuestion", "isQuestionHiddenByPin"]) {
    env[name] = callback(name, context);
  }
}

function stableSnapshot(stable) {
  return { stable, streaming: false, target: {
    sessionId: stable.sessionId, logicalQuestionUnitId: stable.logicalQuestionUnitId,
    logicalQuestionRevision: stable.logicalQuestionRevision, suggestionId: stable.suggestion.id,
    generationId: stable.suggestion.id, traceId: stable.suggestion.sourceTraceId, stableRevision: stable.revision,
  }, sections: stable.display ?? modules.buildMeetingAnswerDisplayModel({ content: stable.suggestion.content,
    parsedAnswer: stable.suggestion.meetingAnswer }) };
}

function plainStable(id, content, questionId = id, revision = 1) {
  return modules.commitStableAnswerRevision({
    candidate: { id, content, sourceTraceId: id, meetingAnswer: modules.parseMeetingAnswer(content),
      kind: "answer", createdAt: 1, basedOnTurnIds: [], basedOnObservationIds: [], confidence: "high" },
    authorizedArtifacts: ["answer"], taskId: "parent", logicalQuestionUnitId: questionId,
    logicalQuestionRevision: 1, sessionId: "session", runtimeEpoch: 1, revision,
  });
}

function screenStreamHarness({ pinPrevious = false, revokeDuringStream = false } = {}) {
  const capture = declaration("captureScreenContext").initializer.arguments[0];
  const local = name => find(capture, n => ts.isVariableDeclaration(n) && n.name.getText(source) === name);
  const solve = find(capture, n => ts.isCallExpression(n) && n.expression.getText(source) === "solveScreenAnchoredTask");
  const partial = solve.arguments[0].properties.find(n => n.name?.getText(source) === "onPartialContent").initializer;
  const display = new modules.ManualAdviseDisplay();
  const ref = {current:null}, controller = {}, abortRef = {current:controller};
  let state = {partialSuggestion:""}, ids = 0;
  const metadata = [], revoked = [];
  const previous = stableSnapshot(plainStable("old", "Answer: previous"));
  const runtimeSnapshot = { sessionId: "session", runtimeEpoch: 1, parentId: "parent", parentRevision: 1 };
  const screenGenerationLease = modules.createAnswerGenerationLease({
    ...runtimeSnapshot, preparationContextRevision: 0, taskId: "parent", taskRevision: 1,
    logicalQuestionUnitId: "screen-question", logicalQuestionRevision: 1,
    baseVisibleAnswerRevision: 1, sourceTurnIds: [], manualCorrectionRevision: 0, responseActionRevision: 0,
    modelRoute: "fixture", artifactOwnerId: "parent", requestedArtifacts: ["answer"], startedAt: 1,
  });
  if (pinPrevious) { display.select(previous,previous); display.toggle(); }
  const env = {...modules,Date,structuredClone, trace:{id:"screen"}, screenGenerationLease,
    displayedStreamRef:ref, manualAdviseDisplayRef:{current:display}, stableAnswerRevisionRef:{current:previous.stable},
    screenAnalysisAbortRef:abortRef, analysisController:controller, boundVisualRecoveryFact:undefined,
    screenFactAnchorDecision:modules.buildFactAnchorDecision({questionType:"coding"}), holdScreenPartialForFactAnchor:false, screenModelCompletedAt:undefined,
    screenRuntimeToken: modules.createRuntimeCommitToken({ operationId: "screen-operation", pipeline: "screen", snapshot: runtimeSnapshot }),
    readRuntimeCommitSnapshot:()=>runtimeSnapshot, screenOperationCoordinatorRef:{current:{getActiveOperationId:()=>"screen-operation"}},
    contextManagerRef:{current:{getState:()=>({sessionId:"session"})}}, state,
    generationResultLedgerRef:{current:{getEntry:()=>undefined}},
    formatModelGenerationTimingForTrace:()=>({}),
    traceStoreRef:{current:{updateMetadata:(_id,m)=>metadata.push(m)}},setState:update=>{state=update(state);env.state=state;},
    createMeetingId:kind=>`${kind}-${++ids}`,
    revokeIncompleteAdvisePin:(id,reason)=>{revoked.push({id,reason});display.revokeIncomplete(id);},
  };
  const context = vm.createContext(env);
  env.isQuestionHiddenByPin = callback("isQuestionHiddenByPin", context);
  env.readScreenAuthorization = evaluate(`(${local("readScreenAuthorization").initializer.getText(source)})`, context);
  const select = callback("selectAdviseDisplay", context);
  env.driveStream = async onPartial => {
    onPartial("Answer: screen partial");
    select(modules.buildMeetingAnswerDisplayModel({content:state.partialSuggestion}));
    if (!pinPrevious) display.toggle();
    if (revokeDuringStream) runtimeSnapshot.parentRevision++;
    onPartial("Answer: screen final");
    select(modules.buildMeetingAnswerDisplayModel({content:state.partialSuggestion}));
    return "Answer: screen final";
  };
  // Retain production declaration order and the entire production partial/clear
  // callbacks. Only provider IO and unrelated parse/commit work are omitted.
  const nodes = ["requestId","screenStagedChunkCount","screenStagedFirstChunkAt","screenStagedFirstVisiblePartialAt",
    "screenModelRequestStartedAt","screenModelFirstContentAt","screenStagedVisible","clearScreenStagedPartial"]
    .map(name=>local(name).parent.parent);
  const model = local("screenTaskContent").parent.parent;
  nodes.push(model);nodes.sort((a,b)=>a.pos-b.pos);
  const body = nodes.map(n=>n===model ? `let screenTaskContent = await driveStream(${partial.getText(source)});` : n.getText(source)).join("\n");
  return {display,ref,metadata,revoked,get state(){return state;},get ids(){return ids;},
    async run(){return evaluate(`(async()=>{${body}\nreturn {id:requestId,content:screenTaskContent,clear:clearScreenStagedPartial};})()`,context);}};
}

test("Screen stream creates one result ID before the real partial callback, then completes its pin",async()=>{
  const h=screenStreamHarness(); const result=await h.run();
  assert.equal(h.ids,1);assert.equal(result.id,h.ref.current.generationId);
  assert.equal(h.display.current.sections.primaryAnswer,"screen final");
  assert.equal(h.ref.current.logicalQuestionUnitId,"screen-question");
  assert.equal(h.ref.current.logicalQuestionRevision,1);
  assert.equal(h.display.current.target.logicalQuestionUnitId,"screen-question");
  const stable=plainStable(result.id,result.content,"screen-question",2);
  stable.suggestion.sourceTraceId="screen";
  const completed=stableSnapshot(stable);
  h.display.complete(completed);h.display.select(completed,completed);
  assert.equal(h.display.current.streaming,false);assert.equal(h.display.locked,true);
  assert.equal(h.display.current.target.suggestionId,result.id);
});

test("Screen stream behind an existing pin does not replace that display or mark its partial visible",async()=>{
  const h=screenStreamHarness({pinPrevious:true});const result=await h.run();
  assert.equal(result.id,h.ref.current.generationId);assert.equal(h.display.current.target.traceId,"old");
  assert.equal(h.display.current.sections.primaryAnswer,"previous");
  assert.equal(h.metadata.some(m=>m.stagedAnswerDeliveryFirstVisiblePartialAt!==undefined),false);
});

test("Screen source revocation stops later partial; existing clear callback revokes its incomplete pin",async()=>{
  const h=screenStreamHarness({revokeDuringStream:true});const result=await h.run();
  assert.equal(h.state.partialSuggestion,"Answer: screen partial");
  result.clear("stale-post-model");
  assert.equal(h.state.partialSuggestion,"");assert.equal(h.display.locked,false);
  assert.equal(h.revoked[0].reason,"stale-post-model");
});

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
  f.stable = modules.commitStableAnswerRevision({ ...f.stable,
    candidate: { ...f.stable.suggestion, meetingAnswer: modules.parseMeetingAnswer(f.stable.suggestion.content) },
    authorizedArtifacts: ["answer"],
  });
  const display = new modules.ManualAdviseDisplay();
  const snapshot = stableSnapshot(f.stable);
  display.select(snapshot, snapshot); display.toggle();
  const b = structuredClone(f.stable); b.revision = 6; b.suggestion.id = "hidden-B"; b.suggestion.content = "Answer: hidden B";
  b.logicalQuestionUnitId = "hidden-B-unit";
  b.suggestion.meetingAnswer = modules.parseMeetingAnswer(b.suggestion.content);
  const environment = {
    ...modules, structuredClone, Date, console,
    manualAdviseDisplayRef: {current:display}, stableAnswerRevisionRef: {current:b},
    latestManualCorrectionTargetRef:{current:undefined},
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
  bindQuestionReaders(environment, context);
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
    manualAdviseDisplayRef:{current:new modules.ManualAdviseDisplay()},
    unpublishedArtifactSlotRef:{current:slot},stableAnswerRevisionRef:{current:stable}, readArtifactReuseInputs:()=>inputs,
    validateWhiteboardRenderCandidate:async()=>({valid:true}),
    traceId:"manual",requestId:"manual-request",advisorAnswerProfile:undefined,advisorPromptMode:"response-action",
    advisorModelPromptContext:{},advisorModelRoute:{},advisorScreenSourceRead:{},advisorModelRequestOptions:{},
    advisorModelExecutionIdentity:{},responseConfig:{},advisorModelCurrentSuggestion:stable.suggestion.content,
    traceStoreRef:{current:{updateMetadata:(_,update)=>Object.assign(metadata,update)}},
    advisorEngineRef:{current:{
      toSuggestion:(id,content,_turns,_observations,_task,meetingAnswer)=>({...suggestion,id,content,meetingAnswer}),
      async *streamSuggestion(){requests++;yield {type:"candidate",candidate:{content:raw,attempts:[]}};},
    }},
  };
  return {slot,stable,target,inputs,env,metadata,get requests(){return requests;},execute:reuseConsumer(env)};
}

function reuseConsumer(env) {
  const run=declaration("runAdvisor").initializer.arguments[0];
  const attempt=find(run,n=>ts.isTryStatement(n) && n.tryBlock.statements[0]?.getText(source).includes("unpublishedArtifactSlotRef.current.take"));
  const statements=attempt.tryBlock.statements.slice(0,2);
  assert.match(statements[1].getText(source),/if \(!reusedArtifactCandidate\)/);
  const context=vm.createContext(env);
  bindReuseAuthorization(env, context, run);
  env.readStableAnswerForQuestion = callback("readStableAnswerForQuestion", context);
  const base = find(run,n=>ts.isVariableDeclaration(n)&&n.name.getText(source)==="readPublicationBase");
  env.readPublicationBase = evaluate(`(${base.initializer.getText(source)})`, context);
  return ()=>evaluate(`(async()=>{let finalContent="",reusedArtifactCandidate,reusedWhiteboardValidation,advisorResponseCandidate;
      ${statements.map(n=>n.getText(source)).join("\n")}
      return {finalContent,reusedArtifactCandidate,advisorResponseCandidate};})()`,context);
}

function bindReuseAuthorization(env, context, run) {
  const target = env.options.artifactRegenerationTarget;
  const input = env.readArtifactReuseInputs();
  const unit = env.questionForAction ?? { ...fixture().unit, id: target.logicalQuestionUnitId,
    revision: target.logicalQuestionRevision, sessionId: target.sessionId, runtimeEpoch: target.runtimeEpoch };
  env.contextManagerRef ??= { current: { getState: () => ({ sessionId: target.sessionId,
    activeMeetingTask: { parent: { id: target.parentId, revisions: target.parentRevision } } }) } };
  env.runtimeEpochRef ??= { current: target.runtimeEpoch };
  env.readRuntimeCommitSnapshot = () => modules.buildRuntimeCommitSnapshot({
    contextState: env.contextManagerRef.current.getState(), runtimeEpoch: env.runtimeEpochRef.current });
  env.advisorJob = modules.createAdvisorTriggerJob({ source: "artifact-regeneration", mode: "response-action",
    sessionId: target.sessionId, runtimeEpoch: target.runtimeEpoch, runtimeCommitSnapshot: env.readRuntimeCommitSnapshot(),
    logicalQuestionUnit: unit, promptContext: {}, snapshotTurnCount: 1, taskMutationAuthority: "output-only-current-branch" });
  env.effectiveRuntimeCommitToken = env.advisorJob.runtimeCommitToken;
  env.activeAdvisorJobRef = { current: env.advisorJob };
  env.logicalQuestionUnitRef ??= { current: unit };
  env.latestManualCorrectionTargetRef ??= { current: undefined };
  env.latestForceAdviseTargetRef = { current: undefined };
  env.pendingAdvisorGenerationSupersessionRef = { current: undefined };
  env.manualCorrectionTargetHistoryRef ??= { current: [] };
  env.manualCorrectionRevisionRef ??= { get current() { return env.readArtifactReuseInputs().manualCorrectionRevision; } };
  env.preparationRuntimeContextRef ??= { get current() {
    return { preparationContextRevision: env.readArtifactReuseInputs().preparationContextRevision }; } };
  env.responseActionRevisionRef ??= { current: 0 };
  env.visibleAnswerRevisionRef ??= { current: target.visibleAnswerRevision };
  bindQuestionReaders(env, context);
  env.selectedQuestionOnly = env.isSelectedHistoricalQuestion(target.logicalQuestionUnitId);
  env.logicalQuestionLease = modules.createLogicalQuestionUnitLease(env.advisorJob.logicalQuestionUnit);
  env.settledExecutionPlan = undefined;
  env.generationAuthorizedArtifacts = target.artifactFamilies;
  env.answerGenerationLease = modules.createAnswerGenerationLease({ sessionId: target.sessionId,
    runtimeEpoch: target.runtimeEpoch, taskId: target.parentId, taskRevision: target.parentRevision,
    logicalQuestionUnitId: target.logicalQuestionUnitId, logicalQuestionRevision: target.logicalQuestionRevision,
    baseVisibleAnswerRevision: env.visibleAnswerRevisionRef.current,
    preparationContextRevision: input.preparationContextRevision, manualCorrectionRevision: input.manualCorrectionRevision,
    responseActionRevision: env.responseActionRevisionRef.current, sourceTurnIds: unit.sourceTurnIds,
    modelRoute: "fixture", artifactOwnerId: target.parentId, requestedArtifacts: target.artifactFamilies });
  env.authorizationEvents = [];
  // Terminal/trace sinks observe real authorizer decisions and do not decide admission.
  env.terminalizeGenerationLease = event => env.authorizationEvents.push(event);
  env.finishRunningAdvisorJobTrace = (...args) => env.authorizationEvents.push({ kind: "finish", args });
  env.releaseAdvisorJob = (...args) => env.authorizationEvents.push({ kind: "release", args });
  env.updateForceAdviseTargetForAdvisorOutcome = event => env.authorizationEvents.push(event);
  env.setState ??= () => {};
  for (const name of ["readLogicalQuestionAuthorizationTarget", "readCommitDecision",
    "terminalizeAuthorizationRejection", "rejectStaleCommit"]) {
    const local = find(run,n=>ts.isVariableDeclaration(n)&&n.name.getText(source)===name);
    env[name] = evaluate(`(${local.initializer.getText(source)})`, context);
  }
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
  h.env.validateWhiteboardRenderCandidate=async()=>{h.inputs.manualCorrectionRevision++;return {valid:true};};
  assert.equal(await h.execute(),undefined); assert.equal(h.requests,0); assert.equal(h.slot.present,false);
  assert.ok(h.env.authorizationEvents.some(event=>event.reason==="manual-correction-revision-mismatch"));
});

test("B-C9 real generation lease rejects a changed publication base during reserved candidate validation", async () => {
  const h = reuseHarness(true);
  h.env.validateWhiteboardRenderCandidate = async () => {
    h.env.visibleAnswerRevisionRef.current++;
    return { valid: true };
  };
  assert.equal(await h.execute(), undefined);
  assert.equal(h.requests, 0);
  assert.equal(h.slot.present, false);
  assert.ok(h.env.authorizationEvents.some(event => event.reason === "visible-answer-revision-mismatch"));
});

test("B-C3 actual regenerate ingress rejects a nonmatching effective source without retargeting B", async () => {
  const h = harness();
  h.f.records[0].sourceHash = "different-source";
  await callback("regenerateSuggestion", h.context)({ displayTarget: h.snapshot.target, actionId: "source-changed" });
  assert.equal(h.calls.length, 0);
  assert.ok(h.events.some(event => event.reason === "visible-answer-effective-source-mismatch"));
  assert.equal(h.display.selectedStable, h.f.stable);
  assert.equal(h.environment.stableAnswerRevisionRef.current.logicalQuestionUnitId, "hidden-B-unit");
});

function publicationHarness({ aRevision = 5, bRevision = 6 } = {}) {
  const f = fixture();
  f.context.activeMeetingTask.parent.questionType = "coding";
  f.context.activeMeetingTask.parent.playbookPhase = "implementation_validation";
  const unitB = { ...structuredClone(f.unit), id: "question-B", currentTurnId: "turn-B", sourceTurnIds: ["turn-B"],
    sources: [{ ...f.unit.sources[0], turnId: "turn-B", text: "Explain the second queue." }],
    normalizedText: "Explain the second queue.", restoredAnswerFocusText: "Explain the second queue." };
  const recordB = { ...structuredClone(f.records[0]), recordId: "source-B", logicalQuestionUnitId: unitB.id,
    currentTurnId: "turn-B", sourceTurnIds: ["turn-B"], text: unitB.normalizedText, answerFocusText: unitB.normalizedText,
    effectiveSourceTexts: [{ turnId: "turn-B", text: unitB.normalizedText }],
    sourceHash: modules.createProvisionalCurrentQuestion({ logicalQuestionUnit: unitB, sourceKind: "voice" }).sourceHash };
  f.records.push(recordB);
  f.context.transcriptTurns.push({ ...f.context.transcriptTurns[0], id: "turn-B", text: unitB.normalizedText });
  const content = id => `Answer: Answer ${id}\n\nCode:\n\`\`\`ts\nreturn "${id}";\n\`\`\`\n\nComplexity: O(${id.length})\n\nWhiteboard: ${id} --> queue`;
  const makeStable = (id, unit, record, revision, current, authorizedArtifacts) => {
    const raw = content(id);
    const stable = modules.commitStableAnswerRevision({
      current, revision, sessionId: "session-a", runtimeEpoch: 3, taskId: "parent-a",
      sectionOwner: { kind: "parent-mainline", parentId: "parent-a" },
      logicalQuestionUnitId: unit.id, logicalQuestionRevision: unit.revision, questionSourceHash: record.sourceHash,
      settlementId: `settlement-${unit.id}`, settlementSnapshot: { ...f.stable.settlementSnapshot,
        settlementId: `settlement-${unit.id}`, logicalQuestionUnitId: unit.id, revision: unit.revision,
        questionType: "coding", sourceHash: record.sourceHash, sourceTurnIds: unit.sourceTurnIds },
      candidate: { ...f.stable.suggestion, id, sourceTraceId: `trace-${id}`, content: raw,
        basedOnTurnIds: unit.sourceTurnIds, meetingAnswer: modules.parseMeetingAnswer(raw) },
      authorizedArtifacts, committedAt: revision * 100,
    });
    assert.ok(stable);
    return stable;
  };
  const all = ["answer", "code", "complexity", "whiteboard"];
  const a = makeStable("A", f.unit, f.records[0], aRevision, null, all);
  const bBase = makeStable("B-published-artifacts", unitB, recordB, bRevision - 1, null, all);
  const bCandidate = makeStable("B", unitB, recordB, bRevision, bBase, ["answer"]);
  const aPrime = makeStable("A-prime", f.unit, f.records[0], bRevision + 1, a, ["answer"]);
  const display = new modules.ManualAdviseDisplay(), slot = new modules.UnpublishedArtifactSlot();
  const inputs = { manualCorrectionRevision: 0, preparationContextRevision: 0, settings: {} };
  const events = [], traces = [];
  let state = { latestSuggestion: a.suggestion, latestReliableSuggestion: null, partialSuggestion: "" };
  const environment = { ...modules, structuredClone, Date, console, state,
    manualAdviseDisplayRef: { current: display }, stableAnswerRevisionRef: { current: a },
    displayedStreamRef: { current: null }, unpublishedArtifactSlotRef: { current: slot },
    visibleAnswerRevisionRef: { current: a.revision }, pendingAnswerRevisionRef: { current: null },
    answerDeliveryProgressRef: { current: null }, runtimeEpochRef: { current: 3 },
    logicalQuestionUnitRef: { current: unitB }, contextManagerRef: { current: { getState: () => f.context } },
    effectiveQuestionSourceLedgerRef: { current: { list: () => f.records } },
    latestManualCorrectionTargetRef: { current: { logicalQuestionUnit: unitB, updatedAt: 20 } },
    manualCorrectionTargetHistoryRef: { current: [
      { logicalQuestionUnit: f.unit, updatedAt: 10 }, { logicalQuestionUnit: unitB, updatedAt: 20 },
    ] },
    recentAdvisorContinuityRef: { current: { recentCapsules: [] } },
    pendingAnswerResolutionCommitByTraceRef: { current: new Map() },
    readArtifactReuseInputs: () => inputs, clearPendingAnswerCommitTimer() {},
    traceStoreRef: { current: { updateMetadata: (id, metadata) => traces.push({ id, metadata }) } },
    sessionRecordingManagerRef: { current: { recordCaptureLifecycle: event => events.push(event) } },
    setState: update => { state = update(state); environment.state = state; },
  };
  const context = vm.createContext(environment);
  bindQuestionReaders(environment, context);
  for (const name of ["withLatestReliableSuggestion", "isCacheableReliableSuggestion"]) {
    const helper = find(source,n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);
    evaluate(helper.getText(source), context);
  }
  const callbacks = {};
  for (const name of ["prepareStableAnswerPublication", "installPreparedStableAnswerPublication",
    "rollbackPreparedStableAnswerPublication", "finalizeStableAnswerPublication"]) {
    callbacks[name] = callback(name, context, publicationSource);
  }
  const select = callback("selectAdviseDisplay", context);
  const render = () => select(modules.buildMeetingAnswerDisplayModel({ content: state.latestSuggestion.content }));
  render();
  assert.equal(display.toggle().accepted, true);
  function resolve(stable) {
    const visibleSource = modules.resolveVisibleAnswerResponseActionTarget({ stableAnswer: stable,
      currentLogicalQuestionUnit: environment.logicalQuestionUnitRef.current,
      effectiveQuestionSources: f.records, meetingContext: f.context, runtimeEpoch: 3 });
    assert.equal(visibleSource.authorized, true, visibleSource.reason);
    const decision = modules.resolveArtifactRegenerationTarget({ stableAnswer: stable, visibleSource,
      activeMeetingTask: f.context.activeMeetingTask, sessionId: "session-a", runtimeEpoch: 3 });
    assert.equal(decision.authorized, true, decision.reason);
    return decision.target;
  }
  function publish(stable, options = {}) {
    // This fixture enters at the accepted-result publication boundary, after real source resolution.
    resolve(stable);
    const prepared = callbacks.prepareStableAnswerPublication(stable, options);
    assert.equal(callbacks.installPreparedStableAnswerPublication(prepared), prepared.stable);
    callbacks.finalizeStableAnswerPublication(prepared);
    return prepared;
  }
  const offer = stable => ({ unpublishedArtifacts: { parsed: modules.parseMeetingAnswer(content(stable.suggestion.id)),
    authorizedArtifacts: ["answer"], inputs }, latestUsefulAnswerCommitted: true });
  const b = publish(bCandidate, offer(bCandidate)).stable;
  render();
  return { f, a, b, bBase, aPrime, display, slot, inputs, environment, context, events, traces,
    callbacks, render, resolve, publish, offer, get state() { return state; } };
}

test("B-C2 actual publication updates selected A-prime while preserving global B and continuity", () => {
  const h = publicationHarness();
  const env = h.environment;
  const before = { continuity: env.recentAdvisorContinuityRef.current,
    latestTarget: env.latestManualCorrectionTargetRef.current, latest: h.state.latestSuggestion,
    reliable: h.state.latestReliableSuggestion, lineage: h.f.context.activeMeetingTask };
  assert.equal(env.stableAnswerRevisionRef.current, h.b);
  assert.equal(h.render().stable, h.a);
  const prepared = h.publish(h.aPrime, h.offer(h.aPrime));
  assert.ok(env.stableAnswerRevisionRef.current === h.b, "historical A-prime must not replace global latest B");
  assert.equal(prepared.selectedQuestionOnly, true);
  assert.equal(h.display.selectedStable, prepared.stable);
  assert.equal(h.render().stable, prepared.stable);
  assert.equal(h.display.locked, true);
  assert.equal(env.readStableAnswerForQuestion(h.aPrime.logicalQuestionUnitId), prepared.stable);
  assert.equal(env.readStableAnswerForQuestion(h.b.logicalQuestionUnitId), h.b);
  assert.equal(env.recentAdvisorContinuityRef.current, before.continuity);
  assert.equal(env.latestManualCorrectionTargetRef.current, before.latestTarget);
  assert.equal(h.state.latestSuggestion, before.latest);
  assert.equal(h.state.latestReliableSuggestion, before.reliable);
  assert.equal(h.f.context.activeMeetingTask, before.lineage);
  const publication = h.events.findLast(event => event.stage === "stable-answer-visible-commit");
  assert.equal(publication.publicationSelectedQuestionOnly, true);
  assert.equal(publication.latestQuestionResultId, h.b.logicalQuestionUnitId);
  assert.equal(publication.publicationHiddenByManualPin, false);
  assert.equal(h.events.find(event => event.traceId === h.b.suggestion.sourceTraceId &&
    event.stage === "stable-answer-visible-commit").publicationHiddenByManualPin, true);
});

test("B-C7 actual finalizers replace the single B candidate with A-prime and preserve one-use reservation", () => {
  const h = publicationHarness();
  const bTarget = h.resolve(h.b);
  assert.equal(h.slot.present, true);
  h.publish(h.aPrime, h.offer(h.aPrime));
  const aTarget = h.resolve(h.aPrime);
  assert.equal(h.slot.take({ stable: h.b, target: bTarget, inputs: h.inputs }).reason, "generation-mismatch");
  assert.equal(h.slot.present, true);
  assert.equal(h.slot.take({ stable: h.aPrime, target: { ...aTarget, sourceHash: "different-source" },
    inputs: h.inputs }).reason, "target-mismatch");
  const changedBase = structuredClone(h.aPrime);
  changedBase.sections.code.revision++;
  assert.equal(h.slot.take({ stable: changedBase, target: aTarget, inputs: h.inputs }).reason, "artifact-base-changed");
  assert.equal(h.slot.take({ stable: h.aPrime, target: aTarget,
    inputs: { ...h.inputs, preparationContextRevision: 1 } }).reason, "inputs-changed");
  const reserved = h.slot.take({ stable: h.aPrime, target: aTarget, inputs: h.inputs });
  assert.equal(reserved.reason, "matched");
  assert.equal(reserved.candidate.suggestionId, h.aPrime.suggestion.id);
  assert.match(reserved.candidate.sections.code, /A-prime/);
  assert.doesNotMatch(h.aPrime.suggestion.meetingAnswer.sections.code, /A-prime/);
  assert.equal(h.slot.take({ stable: h.aPrime, target: aTarget, inputs: h.inputs }).reason, "candidate-missing");
  assert.equal(h.environment.stableAnswerRevisionRef.current, h.b);
});

function selectedArtifactConsumer(h, stable = h.display.selectedStable, generatedContent = stable.suggestion.content) {
  const env = h.environment, target = h.resolve(stable);
  let requests = 0;
  Object.assign(env, {
    options: { artifactRegenerationTarget: target, currentSuggestion: stable.suggestion.content,
      responseAction: "regenerate-artifacts" }, questionForAction: h.f.unit,
    validateWhiteboardRenderCandidate: async () => ({ valid: true }),
    traceId: "artifact-A", requestId: "artifact-A", advisorAnswerProfile: undefined,
    advisorPromptMode: "response-action", advisorModelPromptContext: {}, advisorModelRoute: {},
    advisorScreenSourceRead: {}, advisorModelRequestOptions: {}, advisorModelExecutionIdentity: {},
    responseConfig: {}, advisorModelCurrentSuggestion: stable.suggestion.content,
    advisorEngineRef: { current: {
      toSuggestion: (id, content, _turns, _observations, _task, meetingAnswer) =>
        ({ ...stable.suggestion, id, sourceTraceId: env.traceId, content, meetingAnswer }),
      async *streamSuggestion() { requests++; yield { type: "candidate", candidate: {
        content: generatedContent, attempts: [],
      } }; },
    } },
  });
  const execute = reuseConsumer(env);
  const run = declaration("runAdvisor").initializer.arguments[0];
  const names = ["visibleAnswerRevisionBefore", "previousStableAnswer", "resetVisibleSections",
    "deliveryLockActive", "stableAnswerCommitDecision", "canonicalWhiteboardRejection",
    "artifactOnlyCommitDecision", "candidateStableAnswer"];
  const finalBlock = find(run,n=>ts.isVariableDeclaration(n)&&n.name.getText(source)==="candidateStableAnswer").parent.parent.parent;
  const finalDeclarations = names.map(name => {
    const statement = finalBlock.statements.find(n=>ts.isVariableStatement(n)&&
      n.declarationList.declarations.some(declaration=>declaration.name.getText(source)===name));
    assert.ok(statement, `missing final publication declaration ${name}`);
    return statement.getText(source);
  });
  return { target, execute, get requests() { return requests; },
    finish(result) {
      Object.assign(env, { nextSuggestion: env.advisorEngineRef.current.toSuggestion("artifact-A", result.finalContent,
        [], [], {}, modules.parseMeetingAnswer(result.finalContent)), continuity: {},
        taskBoundaryCommittedBeforeAdvisor: false, stagedAnswerDeliveryVisible: false,
        canonicalWhiteboardRegeneration: undefined, publicationSectionOwner: target.sectionOwner });
      const decision = evaluate(`(()=>{${finalDeclarations.join("\n")}\nreturn artifactOnlyCommitDecision;})()`, h.context);
      assert.equal(decision.disposition, "committed", decision.reason);
      return h.publish(decision.stable, { artifactOnly: true }).stable;
    } };
}

test("B-C7/9 actual reuse and final Artifact reducer read selected A-prime, then publish only its authorized sections", async () => {
  const h = publicationHarness();
  const selected = h.publish(h.aPrime, h.offer(h.aPrime)).stable;
  const consumer = selectedArtifactConsumer(h);
  const originalB = structuredClone(h.b);
  const result = await consumer.execute();
  assert.equal(consumer.requests, 0);
  assert.equal(result.reusedArtifactCandidate.suggestionId, h.aPrime.suggestion.id);
  assert.equal(h.environment.readPublicationBase(), selected);
  const published = consumer.finish(result);
  assert.equal(h.display.selectedStable, published);
  assert.equal(h.environment.stableAnswerRevisionRef.current, h.b);
  assert.equal(h.render().stable, published);
  assert.equal(published.suggestion.meetingAnswer.sections.answer, h.aPrime.suggestion.meetingAnswer.sections.answer);
  assert.equal(published.suggestion.meetingAnswer.sections.whiteboard, h.aPrime.suggestion.meetingAnswer.sections.whiteboard);
  assert.match(published.suggestion.meetingAnswer.sections.code, /A-prime/);
  assert.equal(published.sections.answer.revision, h.aPrime.sections.answer.revision);
  assert.equal(published.sections.whiteboard.revision, h.aPrime.sections.whiteboard.revision);
  assert.deepEqual(structuredClone(h.b), originalB);
  assert.equal(h.slot.present, false);
  // A fresh second action has no candidate left and follows the production generation branch.
  const second = selectedArtifactConsumer(h, published);
  await second.execute();
  assert.equal(second.requests, 1);
});

test("B-C7/9 direct Artifacts on older pinned A keeps its exact base and advances the global publication counter", async () => {
  const h = publicationHarness({ aRevision: 1, bRevision: 5 });
  const originalB = structuredClone(h.b);
  const originalA = structuredClone(h.a);
  const generated = "Answer: Answer A\n\nCode:\n```ts\nreturn \"A-new-artifacts\";\n```\n\nComplexity: O(n log n)";
  const consumer = selectedArtifactConsumer(h, h.a, generated);
  assert.equal(h.display.selectedStable, h.a);
  assert.equal(consumer.target.visibleAnswerRevision, 1, "action must capture A's actual source revision");
  assert.equal(h.environment.visibleAnswerRevisionRef.current, 5);
  assert.equal(h.environment.answerGenerationLease.baseVisibleAnswerRevision, 5);
  assert.equal(h.slot.present, true, "the only candidate currently belongs to background B");

  const result = await consumer.execute();
  assert.equal(result.reusedArtifactCandidate, undefined, "B's candidate cannot satisfy the A request");
  assert.equal(consumer.requests, 1);
  assert.equal(h.environment.readPublicationBase(), h.a);
  const published = consumer.finish(result);
  assert.equal(published.revision, 6, "artifact publication must use global 5 + 1, not selected base 1 + 1");
  assert.equal(h.environment.visibleAnswerRevisionRef.current, 6, "publication counter must not roll back to 2");
  assert.equal(h.display.selectedStable, published);
  assert.equal(h.render().stable, published);
  assert.equal(h.environment.stableAnswerRevisionRef.current, h.b);
  assert.equal(published.logicalQuestionUnitId, h.a.logicalQuestionUnitId);
  assert.equal(published.suggestion.meetingAnswer.sections.answer, originalA.suggestion.meetingAnswer.sections.answer);
  assert.equal(published.suggestion.meetingAnswer.sections.whiteboard, originalA.suggestion.meetingAnswer.sections.whiteboard);
  assert.equal(published.sections.answer.revision, originalA.sections.answer.revision);
  assert.equal(published.sections.whiteboard.revision, originalA.sections.whiteboard.revision);
  assert.match(published.suggestion.meetingAnswer.sections.code, /A-new-artifacts/);
  assert.deepEqual(structuredClone(h.a), originalA);
  assert.deepEqual(structuredClone(h.b), originalB);
  assert.equal(h.events.filter(event => event.stage === "stable-answer-visible-commit" &&
    event.traceId === published.suggestion.sourceTraceId).length, 1);
});

test("B-C9 actual reuse rejects a historical selection released after action capture", async () => {
  const h = publicationHarness();
  h.publish(h.aPrime, h.offer(h.aPrime));
  h.render();
  const consumer = selectedArtifactConsumer(h);
  h.display.toggle(h.display.current.target);
  assert.equal(await consumer.execute(), undefined);
  assert.equal(consumer.requests, 0);
  assert.ok(h.environment.authorizationEvents.some(event => event.kind === "finish" &&
    event.args.at(-1) === "selected-question-released"));
  assert.equal(h.environment.stableAnswerRevisionRef.current, h.b);
});

test("B-C8 actual unlock selection uses full published B sections, never unconsumed A-prime artifacts", () => {
  const h = publicationHarness();
  const originalB = structuredClone(h.b);
  h.publish(h.aPrime, h.offer(h.aPrime));
  const selected = h.render();
  assert.equal(h.slot.present, true);
  assert.equal(h.display.toggle(selected.target).reason, "manual-unlock");
  const unlocked = h.render();
  assert.ok(unlocked.stable === h.b, "unlock must return the background B result, not latest-completed A-prime");
  assert.equal(unlocked.target.logicalQuestionUnitId, h.b.logicalQuestionUnitId);
  assert.deepEqual(structuredClone(unlocked.sections), stableSnapshot(originalB).sections);
  assert.deepEqual(structuredClone(h.b), originalB);
  assert.match(unlocked.sections.code, /B-published-artifacts/);
  assert.match(unlocked.sections.whiteboard, /B-published-artifacts/);
  assert.equal(unlocked.stable.sections.code.sourceSuggestionId, h.bBase.suggestion.id);
  assert.equal(h.slot.present, true, "unlock cannot consume or publish the pending candidate");
  assert.equal(h.slot.take({ stable: h.b, target: h.resolve(h.b), inputs: h.inputs }).reason, "generation-mismatch");
});

test("B-C7 accepted A-prime without an offer clears the single slot without deleting either result", () => {
  const h = publicationHarness();
  assert.equal(h.slot.present, true);
  const prepared = h.publish(h.aPrime);
  assert.equal(h.slot.present, false);
  assert.equal(h.render().stable, prepared.stable);
  assert.equal(h.environment.stableAnswerRevisionRef.current, h.b);
});

test("B-C3 historical publication follows latest correction target even when runtime LQU is A", () => {
  const h = publicationHarness();
  h.environment.logicalQuestionUnitRef.current = h.f.unit;
  const prepared = h.publish(h.aPrime, h.offer(h.aPrime));
  assert.equal(h.environment.stableAnswerRevisionRef.current, h.b);
  assert.equal(h.render().stable, prepared.stable);
  assert.equal(h.environment.latestManualCorrectionTargetRef.current.logicalQuestionUnit.id, h.b.logicalQuestionUnitId);
});

test("B-C4 failed installation rollback preserves background B and its candidate", () => {
  const h = publicationHarness();
  const continuity = h.environment.recentAdvisorContinuityRef.current;
  const prepared = h.callbacks.prepareStableAnswerPublication(h.aPrime, h.offer(h.aPrime));
  h.callbacks.installPreparedStableAnswerPublication(prepared);
  assert.equal(h.callbacks.rollbackPreparedStableAnswerPublication(prepared), true);
  assert.equal(h.environment.stableAnswerRevisionRef.current, h.b);
  assert.equal(h.environment.recentAdvisorContinuityRef.current, continuity);
  assert.equal(h.render().stable, h.a);
  assert.equal(h.slot.take({ stable: h.b, target: h.resolve(h.b), inputs: h.inputs }).candidate.suggestionId, h.b.suggestion.id);
});

async function whiteboardPublicationHarness(withLastValid = true) {
  const text = readFileSync("tests/pending-answer-publication-callback.test.mjs", "utf8");
  const ast = ts.createSourceFile("pending.mjs", text, ts.ScriptTarget.Latest, true);
  const firstTest = ast.statements.find(node => ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === "test");
  assert.ok(firstTest);
  const api = await import(`data:text/javascript;base64,${Buffer.from(text.slice(0, firstTest.getStart(ast)) +
    "\nexport { createHarness, suggestion };\n").toString("base64")}`);
  const lastValid = withLastValid ? modules.updateWhiteboardArtifactFromAnswer({
    parentTaskId: "parent-a", parentQuestionType: "general-system-design", parentTopic: "Queue",
    finalContent: "Whiteboard:\nClient -> API -> Valid A", phase: "design_framing", updateSource: "model-output", now: 1,
  }) : undefined;
  const h = api.createHarness({ parent: { stableKind: "general-system-design", playbookPhase: "design_framing",
    whiteboardArtifact: lastValid } });
  async function prepare({ id, content, questionId = h.refs.logicalQuestionUnitRef.current.id,
    whiteboardAuthorized = true, sourceQuestion = "Design a queue system" }) {
    const parent = h.manager.getTaskRuntimeState().parent;
    const candidate = api.suggestion(id, content);
    const format = modules.applyWhiteboardFormatPolicy({ whiteboard: candidate.meetingAnswer.sections.whiteboard,
      preference: modules.resolveWhiteboardFormatPreference({ questionType: parent.stableKind,
        artifactIntent: whiteboardAuthorized ? "revise-whiteboard" : "answer-only", sourceQuestion }) });
    assert.equal(format.effectiveWhiteboard, candidate.meetingAnswer.sections.whiteboard);
    const validation = whiteboardAuthorized
      ? await modules.validateWhiteboardRenderCandidate({ whiteboard: format.effectiveWhiteboard, operationId: `validate-${id}` })
      : undefined;
    const authorizedArtifacts = whiteboardAuthorized ? ["answer", "whiteboard"] : ["answer"];
    const authorization = modules.authorizeResponseArtifactMutation({ parentTaskId: parent.id,
      parentQuestionType: parent.stableKind, responseOwnerQuestionType: parent.stableKind,
      responseOwnerSource: "canonical-parent", relation: "followup-parent", requiredArtifacts: authorizedArtifacts });
    assert.equal(authorization.allowWhiteboard, whiteboardAuthorized);
    const continuity = h.evaluate("updateInterviewTaskContinuityForAnswer(continuityInput)", { continuityInput: {
      existingTask: parent, source: "voice", responseOwner: { questionType: parent.stableKind,
        source: "committed-parent", relation: "followup-parent" },
      finalContent: candidate.content, parsedAnswer: candidate.meetingAnswer, whiteboardRenderValidation: validation,
      artifactAuthorization: authorization, artifactIntent: whiteboardAuthorized ? "revise-whiteboard" : "answer-only",
    } });
    const taskPublication = continuity.task !== parent ? h.manager.prepareTaskRuntimeTransition({
      id: `task-${id}`, transition: "update-parent-context", authorizedArtifacts,
      reason: "advisor-answer-continuity-committed", expectedRevision: h.manager.getTaskRuntimeState().revision,
      parent: continuity.task,
    }) : null;
    if (taskPublication) assert.equal(taskPublication.result.authorized, true, taskPublication.result.reason);
    const presentationParent = taskPublication?.result.state.parent ?? parent;
    const rawStable = modules.commitStableAnswerRevision({ current: h.environment.readStableAnswerForQuestion(questionId),
      candidate, authorizedArtifacts, taskId: parent.id, sectionOwner: { kind: "parent-mainline", parentId: parent.id },
      logicalQuestionUnitId: questionId, logicalQuestionRevision: 1, sessionId: "session-a", runtimeEpoch: 1,
      revision: h.refs.visibleAnswerRevisionRef.current + 1 });
    assert.ok(rawStable);
    const original = structuredClone({ candidate, rawStable, presentationParent, validation });
    Object.freeze(candidate);
    Object.freeze(rawStable);
    const prepared = h.environment.prepareStableAnswerPublication(rawStable, { presentationParent });
    assert.notEqual(prepared.stable, rawStable);
    assert.equal(rawStable.display, undefined);
    assert.deepEqual(structuredClone({ candidate, rawStable, presentationParent, validation }), original);
    return { candidate, rawStable, presentationParent, validation, original, prepared,
      commit() {
        if (taskPublication) assert.equal(h.manager.commitPreparedTaskRuntimeTransition(taskPublication).authorized, true);
        assert.equal(h.environment.installPreparedStableAnswerPublication(prepared), prepared.stable);
        h.environment.finalizeStableAnswerPublication(prepared);
        assert.deepEqual(structuredClone({ candidate, rawStable, presentationParent, validation }), original);
        return prepared.stable;
      } };
  }
  const render = (sections) => h.environment.selectAdviseDisplay(sections ??
    modules.buildMeetingAnswerDisplayModel({ content: h.uiState.latestSuggestion.content,
      parsedAnswer: h.uiState.latestSuggestion.meetingAnswer }));
  return { ...h, prepare, render, lastValid };
}

const invalidMermaid = "```mermaid\nflowchart TD\n  subgraph Open Constraints & Unclear Scale\n  Client --> API\n```";

for (const withLastValid of [true, false]) {
  test(`B-C8 actual invalid Mermaid publication captures ${withLastValid ? "preserved-last-valid" : "ASCII fallback"} without mutating raw inputs`, async () => {
    const h = await whiteboardPublicationHarness(withLastValid);
    try {
      const publication = await h.prepare({ id: "whiteboard-A", content: `Answer: Use a queue.\n\nWhiteboard:\n${invalidMermaid}` });
      assert.equal(publication.validation.disposition, "invalid-mermaid");
      const canonical = publication.presentationParent.whiteboardArtifact;
      assert.equal(canonical.parentTaskId, publication.rawStable.taskId);
      assert.equal(canonical.renderState.status, withLastValid ? "preserved-last-valid" : "ascii-fallback");
      assert.equal(h.manager.getTaskRuntimeState().parent.whiteboardArtifact?.content, h.lastValid?.content,
        "prepare must read the supplied transaction projection without prematurely installing it");
      const accepted = publication.commit();
      assert.equal(h.refs.stableAnswerRevisionRef.current, accepted);
      assert.equal(accepted.suggestion.meetingAnswer.sections.whiteboard, invalidMermaid, "provider/parser payload stays raw");
      assert.equal(accepted.display.whiteboard, canonical.content);
      assert.notEqual(accepted.display.whiteboard, invalidMermaid);
      assert.equal(h.render().sections.whiteboard, canonical.content);
      assert.equal(h.render().stable, accepted);
      assert.deepEqual(structuredClone(accepted.sections), publication.original.rawStable.sections,
        "capturing display must not invent section revisions or authority");
      if (withLastValid) assert.equal(accepted.display.whiteboard, h.lastValid.content);
      else assert.match(accepted.display.whiteboard, /Architecture sketch \(ASCII fallback\)/);
    } finally { h.restore(); }
  });
}

test("B-C8 captured canonical A survives Answer-only A-prime and its stream while unlock restores complete B", async () => {
  const h = await whiteboardPublicationHarness();
  try {
    const a = (await h.prepare({ id: "whiteboard-A", content: `Answer: A.\n\nWhiteboard:\n${invalidMermaid}` })).commit();
    h.render();
    assert.equal(h.refs.manualAdviseDisplayRef.current.toggle().accepted, true);
    h.refs.logicalQuestionUnitRef.current = { id: "lqu-B", revision: 1 };
    const b = (await h.prepare({ id: "whiteboard-B", content: "Answer: B.\n\nWhiteboard:\nClient -> Background B",
      sourceQuestion: "Show the architecture in ASCII" })).commit();
    const originalB = structuredClone(b);
    assert.equal(h.render().stable, a);
    const replacement = await h.prepare({ id: "whiteboard-A-prime", questionId: a.logicalQuestionUnitId,
      content: "Answer: revised A.\n\nWhiteboard:\nUnpublished A candidate", whiteboardAuthorized: false });
    const aPrime = replacement.commit();
    assert.equal(h.refs.stableAnswerRevisionRef.current, b);
    assert.equal(aPrime.display.whiteboard, a.display.whiteboard);
    assert.notEqual(aPrime.display.whiteboard, b.display.whiteboard);
    assert.equal(h.render().sections.whiteboard, a.display.whiteboard);
    h.refs.displayedStreamRef.current = { traceId: "stream-A", generationId: "stream-A", leaseId: "stream-A",
      logicalQuestionUnitId: a.logicalQuestionUnitId, logicalQuestionRevision: 1 };
    h.environment.state = { ...h.environment.state, partialSuggestion: "Answer: later A preview" };
    const stream = h.render(b.display);
    assert.equal(stream.streaming, true);
    assert.equal(stream.sections.whiteboard, a.display.whiteboard);
    assert.equal(h.refs.manualAdviseDisplayRef.current.toggle(stream.target).reason, "manual-unlock");
    const unlocked = h.render(aPrime.display);
    assert.equal(unlocked.stable, b);
    assert.deepEqual(structuredClone(unlocked.sections), originalB.display);
    assert.match(unlocked.sections.whiteboard, /Background B/);
    assert.deepEqual(structuredClone(b), originalB);
    assert.equal(replacement.candidate.meetingAnswer.sections.whiteboard, "Unpublished A candidate");
  } finally { h.restore(); }
});

test("B-C8 non-design B clears its Whiteboard display without discarding selected historical A", async () => {
  const h = await whiteboardPublicationHarness();
  try {
    const a = (await h.prepare({ id: "whiteboard-A", content: `Answer: A.\n\nWhiteboard:\n${invalidMermaid}` })).commit();
    h.render();
    h.refs.manualAdviseDisplayRef.current.toggle();
    const parent = h.manager.getTaskRuntimeState().parent;
    const changed = h.manager.commitTaskRuntimeTransition({ id: "accepted-non-design-owner", transition: "replace-parent",
      reason: "manual-type-correction", expectedRevision: h.manager.getTaskRuntimeState().revision,
      parent: { ...parent, stableKind: "behavioral", playbookPhase: "story_selection",
        whiteboardArtifact: undefined, revisions: parent.revisions + 1 } });
    assert.equal(changed.authorized, true, changed.reason);
    h.refs.logicalQuestionUnitRef.current = { id: "lqu-B", revision: 1 };
    const b = (await h.prepare({ id: "behavioral-B", content: "Answer: Tell the B story.", whiteboardAuthorized: false })).commit();
    assert.equal(b.sections.whiteboard.sourceSuggestionId, a.sections.whiteboard.sourceSuggestionId);
    assert.equal(b.display.whiteboard, "", "current non-design owner must retain the production clear projection");
    const selected = h.render();
    assert.equal(selected.stable, a);
    assert.equal(selected.sections.whiteboard, a.display.whiteboard);
    h.refs.manualAdviseDisplayRef.current.toggle(selected.target);
    assert.equal(h.render().stable, b);
    assert.equal(h.render().sections.whiteboard, "");
  } finally { h.restore(); }
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
    prepared:{selectedQuestionOnly:false},
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
  const context=vm.createContext({captureHumanGroundTruthEvaluationTarget:modules.captureHumanGroundTruthEvaluationTarget,
    answerQuestionEvaluation:undefined,evaluationTrace:{id:"trace-A",metadata:{}},meeting:{traces:[{id:"trace-B"},{id:"trace-A"}],
    recordHumanGroundTruthV2:(...args)=>writes.push(args)}});
  const handler=evaluate(`(${attribute.initializer.expression.getText(ui)})`,context);
  handler({kind:"answer-quality",outcome:"ok"},{source:"human"});
  assert.equal(writes[0][0],"trace-A");
  assert.equal(writes[0][2].uiSurface,"normal-debug-evaluation");
  assert.equal(writes[0][2].evaluationTarget.attemptId,"trace-A");
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
