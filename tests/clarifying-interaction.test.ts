import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { buildCompactTraceSummary } from "../src/lib/meeting/session-recording.js";
import type { MeetingTrace } from "../src/lib/meeting/types.js";

test("compacts clarifying selection authority and lifecycle metadata", () => {
  const trace: MeetingTrace = {
    id: "trace_clarifying",
    kind: "voice",
    status: "success",
    startedAt: 1_000,
    endedAt: 1_250,
    durationMs: 250,
    steps: [],
    inputs: [],
    outputs: [],
    metadata: {
      clarifyingRequestId: "clarifying_request_1",
      clarifyingQuestionKey: "question_1",
      clarifyingOptionSource: "project-binding",
      clarifyingOptionCount: 3,
      clarifyingBooleanFallbackUsed: false,
      clarifyingMisleadingBooleanFallbackPrevented: true,
      clarifyingSelectedLabel: "Agentic Memory",
      clarifyingSelectionState: "succeeded",
      clarifyingSelectionTerminalReason: "visible-answer-committed",
      clarifyingSelectionStartedAt: 1_050,
      clarifyingSelectionCompletedAt: 1_200,
    },
  };

  const summary = buildCompactTraceSummary({
    sessionId: "session_clarifying",
    trace,
    trigger: "manual",
    traceExportPath: "traces/trace_clarifying/trace.json",
    summaryPath: "traces/trace_clarifying/summary.json",
  });

  assert.deepEqual(summary.clarifyingInteraction, {
    requestId: "clarifying_request_1",
    questionKey: "question_1",
    optionSource: "project-binding",
    optionCount: 3,
    booleanFallbackUsed: false,
    misleadingBooleanFallbackPrevented: true,
    selectedLabel: "Agentic Memory",
    state: "succeeded",
    terminalReason: "visible-answer-committed",
    startedAt: 1_050,
    completedAt: 1_200,
  });
});

test("S63 actual UI callback records pending, success, failure, retry and ignores stale completion", async () => {
  const source=ts.createSourceFile("meeting.tsx",readFileSync("src/pages/app/components/meeting/index.tsx","utf8"),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let callback:ts.ArrowFunction|undefined;
  const visit=(node:ts.Node)=>{
    if(ts.isVariableDeclaration(node)&&node.name.getText(source)==="handleClarifyingAnswer"&&node.initializer&&ts.isCallExpression(node.initializer)) {
      callback=node.initializer.arguments[0] as ts.ArrowFunction;
    }
    ts.forEachChild(node,visit);
  };
  visit(source);
  assert.ok(callback);
  const javascript=ts.transpileModule(`(${callback.getText(source)})`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  let selection:any;
  let clock=100;
  const requests:{args:any[];resolve:(value:any)=>void;reject:(error:Error)=>void}[]=[];
  const target={sessionId:"smoke",logicalQuestionUnitId:"selected-A",logicalQuestionRevision:1};
  const makeCallback=(questionKey:string, question="Which project?")=>vm.runInNewContext(javascript,{
    Error,Date:{now:()=>clock++},clarifyingQuestion:question,clarifyingQuestionKey:questionKey,
    projectChoice:{options:[{id:"a",label:"Project A",value:"project-a"}]},
    clarifyingOptions:[{id:"a",label:"Project A",value:"project-a"}],
    clarifyingOptionDisplay:{source:"project-binding",showBooleanFallback:false},adviseDisplay:{target},
    setDismissedQuestionKey:()=>{},
    setClarifyingSelection:(next:any)=>{selection=typeof next==="function"?next(selection):next;},
    meeting:{answerClarifyingQuestion:(...args:any[])=>new Promise((resolve,reject)=>requests.push({args,resolve,reject}))},
  }) as (answer:string,option?:{label:string;value:string},displayTarget?:typeof target,
    projectSelection?:{key:string;reselect:boolean})=>void;
  const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
  const first=makeCallback("question-A");
  first("option",{label:"Project A",value:"project-a"});
  assert.equal(selection.status,"pending");
  assert.equal(requests.length,1);
  assert.equal(requests[0].args[3].displayTarget,target);
  assert.equal(requests[0].args[3].optionSource,"project-binding");
  assert.equal(requests[0].args[3].booleanFallbackUsed,false);
  requests[0].resolve({state:"succeeded",requestId:"request-1",traceId:"trace-1"});
  await flush();
  assert.equal(selection.status,"succeeded");
  first("option",{label:"Project A",value:"project-a"});
  requests[1].reject(new Error("synthetic-provider-failure"));
  await flush();
  assert.equal(selection.status,"failed");
  assert.equal(selection.reason,"synthetic-provider-failure");
  first("option",{label:"Project A",value:"project-a"});
  assert.equal(selection.status,"pending");
  requests[2].resolve({state:"succeeded",requestId:"request-retry"});
  await flush();
  assert.equal(selection.requestId,"request-retry");
  first("option",{label:"Project A",value:"project-a"});
  const newer=makeCallback("question-B");
  newer("option",{label:"Project B",value:"project-b"});
  const current=selection;
  requests[3].resolve({state:"succeeded",requestId:"stale-request"});
  await flush();
  assert.equal(selection,current,"old completion cannot rewrite the current selection");
  requests[4].resolve({state:"cancelled",requestId:"request-B",reason:"stale-owner"});
  await flush();
  assert.equal(selection.status,"cancelled");
  assert.equal(selection.questionKey,"question-B");
  assert.equal(requests.length,5);
  const projectOnly=makeCallback("unused-model-key", "");
  projectOnly("option",{label:"Project A",value:"project-a"},target,{key:"parent-A:binding-0",reselect:true});
  assert.equal(requests.length,6,"runtime project choice must not require a model question");
  assert.equal(requests[5].args[0],"","the runtime control does not invent model clarifying text");
  assert.equal(requests[5].args[3].displayTarget,target);
  assert.equal(requests[5].args[3].projectChoice.key,"parent-A:binding-0");
  assert.equal(requests[5].args[3].projectChoice.reselect,true);
  assert.equal(requests[5].args[3].optionSource,"project-binding");
  assert.equal(requests[5].args[3].booleanFallbackUsed,false);
  requests[5].resolve({state:"stale",requestId:"project-stale",reason:"binding-version-changed"});
  await flush();
  assert.equal(selection.status,"stale");
  assert.equal(selection.reason,"binding-version-changed");
});
