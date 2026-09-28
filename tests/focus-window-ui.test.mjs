import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { build } from "esbuild";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";

const root = process.cwd();
const artifactDirectory = process.env.JARVIS_FOCUS_UI_OUTPUT ?? "/tmp";
let playwright;
try { playwright = createRequire(import.meta.url)(process.env.JARVIS_PLAYWRIGHT_MODULE ?? "playwright"); } catch {}

test("Task170 production React receivers, shared renderer and embedded Focus with controlled native transport", {
  skip: !playwright && "Set JARVIS_PLAYWRIGHT_MODULE to run the real React browser test",
}, async (t) => {
  mkdirSync(artifactDirectory, { recursive: true });
  const mainSource = readFileSync("src/pages/app/components/meeting/index.tsx", "utf8");
  const mainAst = ts.createSourceFile("meeting.tsx", mainSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const normalAnswerSections = [];
  let selectedLabelsStart, selectedLabelsEnd;
  let phaseNoticeExpression;
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(mainAst) === "phaseOutputNotice" &&
        node.initializer.getText(mainAst).includes("meeting.phaseOutputNotice")) phaseNoticeExpression = node.initializer.getText(mainAst);
    if (ts.isVariableDeclaration(node) && node.name.getText(mainAst) === "currentQuestionSuggestion") selectedLabelsStart = node.parent.getStart(mainAst);
    if (ts.isVariableDeclaration(node) && node.name.getText(mainAst) === "activeManualQuestionTypeCorrection") selectedLabelsEnd = node.parent.end;
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(mainAst) === "section" &&
      node.children.some(child => ts.isJsxSelfClosingElement(child) && child.tagName.getText(mainAst) === "PhaseOutputNotice" && child.getText(mainAst).includes("focusSnapshot.phaseOutputNotice"))) {
      normalAnswerSections.push(node.getText(mainAst));
    }
    ts.forEachChild(node, visit);
  };
  visit(mainAst);
  assert.equal(normalAnswerSections.length, 2, "both production Normal Answer layouts");
  assert.ok(selectedLabelsStart && selectedLabelsEnd > selectedLabelsStart);
  assert.ok(phaseNoticeExpression);
  const selectedLabels = mainSource.slice(selectedLabelsStart, selectedLabelsEnd) + ";";
  const mocks = {
    "@/hooks": "export const useMeetingAssistant = () => {}; export const useShortcuts = () => {}; export const useWindowResize = () => {};",
    "@/lib": "export const extractVariables = () => []; export const safeLocalStorage = { getItem: () => null };",
    "@/lib/meeting": ["focus-window", "meeting-id", "screen-task-answer", "whiteboard-viewport", "whiteboard-ascii-fallback", "task-taxonomy", "question-type-observation"].map((file) => `export * from './src/lib/meeting/${file}';`).join("\n"),
    "@/components": ['export * from "./src/components/Markdown";', ...["badge", "button", "input", "label", "popover", "scroll-area", "slider", "switch", "textarea"].map((file) => `export * from './src/components/ui/${file}';`)].join("\n"),
    "@tauri-apps/api/event": "export const listen = (event, callback) => window.__focusBus.listen(event, value => callback({payload:value})); export const emit = (event, value) => window.__focusBus.emit(event, value);",
    "@tauri-apps/api/core": "export const invoke = async (command, args) => { window.__focusInvokes.push({command,args}); };",
  };
  const real = new Set(["createMeetingId", "stripOuterCodeFence", "normalizeCanonicalQuestionType", "projectQuestionTypeObservation", "MEETING_FOCUS_ACTION_EVENT", "MEETING_FOCUS_SNAPSHOT_EVENT"]);
  const bindings = [...mainSource.matchAll(/import\s*\{([^}]+)\}\s*from\s*"@\/lib\/meeting"/g)][0][1];
  for (const name of bindings.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!real.has(name)) mocks["@/lib/meeting"] += `\nexport const ${name} = () => null;`;
  }
  const fixture = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { MeetingFocusWindow } from './src/pages/app/components/meeting/focus-window';
    import { FocusModePanel, NormalAnswerFixture, SelectedDisplayLabelsFixture } from './src/pages/app/components/meeting/index';
    import { EMPTY_MEETING_FOCUS_SNAPSHOT as empty } from './src/lib/meeting/focus-window';
    import { createMeetingFocusPublisher } from './src/lib/meeting/focus-window-protocol';
    import { createMeetingFocusDisplayModel } from './src/lib/meeting/focus-display';
    import { getManualCorrectionCapabilities } from './src/lib/meeting/manual-correction-intent';
    import { createPhaseOutputUiFixture } from './tests/helpers/phase-output-ui-fixture';
    import { createFocusOwnerDisplayFixture } from './tests/helpers/focus-owner-display-fixture';
    import { buildMeetingAnswerDisplayModel } from './src/lib/meeting/meeting-answer-display';
    const handlers = new Map(), releases = [], sent = [], actions = [], invokes = [], errors = [];
    let delayed = true, source = empty;
    const bus = {
      async listen(event, receive) {
        if (event === 'meeting-focus-snapshot' && delayed) await new Promise(resolve => releases.push(resolve));
        const listeners = handlers.get(event) ?? new Set(); listeners.add(receive); handlers.set(event, listeners);
        return () => listeners.delete(receive);
      },
      async emit(event, payload) {
        const data = JSON.parse(JSON.stringify(payload));
        const marker = payload.type === 'snapshot-applied' ? document.querySelector('#'+payload.windowKind+' [data-focus-window]') : undefined;
        sent.push({event, payload:data, appliedIdentity: marker ? {publisherInstanceId:marker.dataset.focusPublisher,sequence:Number(marker.dataset.focusSequence),windowKind:marker.dataset.focusWindow} : undefined});
        handlers.get(event)?.forEach(receive => receive(data));
      }
    };
    window.__focusBus = bus; window.__focusInvokes = invokes;
    const publisherEndpoint = {subscribe:receive=>bus.listen('meeting-focus-action',receive),send:payload=>bus.emit('meeting-focus-snapshot',payload)};
    // UI/transport evidence only: production pure capabilities, no transaction/Advisor success stub.
    function readCorrectionMenu(correctedType, displayTarget) {
      const target = {sessionId:displayTarget.sessionId,runtimeEpoch:1,logicalQuestionUnitId:displayTarget.logicalQuestionUnitId??'lqu-A',
        logicalQuestionRevision:displayTarget.logicalQuestionRevision??1,sourceHash:'source-A',manualCorrectionRevision:0,
        taskRuntimeRevision:1,owner:{kind:'parent-mainline',parentId:'parent-A'}};
      const context = {target,currentSessionId:target.sessionId,currentRuntimeEpoch:1,manualCorrectionRevision:0,runtime:{revision:1,parent:{id:'parent-A',stableKind:'general-system-design',topic:'Service design'}},
        source:{...target,relation:'followup-parent'},currentQuestion:{sessionId:target.sessionId,runtimeEpoch:1,
          logicalQuestionUnitId:target.logicalQuestionUnitId,revision:target.logicalQuestionRevision,sourceHash:'source-A',sourceTurnIds:['turn-A'],sourceObservationIds:[]}};
      return {correctedType,target,...getManualCorrectionCapabilities(context,correctedType)};
    }
    function onAction(action) {
      actions.push(action);
      if(action.type==='request-correction-menu') void publisher.respondCorrectionMenu(action,readCorrectionMenu(action.correctedType,action.displayTarget));
    }
    let publisher = createMeetingFocusPublisher({transport:publisherEndpoint, publisherInstanceId:'A', onAction, onError:error=>errors.push(error.message)});
    const roots = Object.fromEntries(['answer','controls','embedded','normal-technical','normal-general'].map(id=>[id,createRoot(document.getElementById(id))]));
    roots.answer.render(<MeetingFocusWindow kind='answer'/>); roots.controls.render(<MeetingFocusWindow kind='controls'/>);
    function renderEmbedded(d) {
      const noop = () => {};
      roots['normal-technical'].render(<NormalAnswerFixture focusSnapshot={d} technical={true}/>);
      roots['normal-general'].render(<NormalAnswerFixture focusSnapshot={d} technical={false}/>);
      roots.embedded.render(<FocusModePanel suggestionSections={d.sections} codingArtifactCached={false} whiteboardArtifactCached={false}
        advisePin={d.advisePin} onToggleAdvisePin={()=>actions.push({type:'toggle-advise-pin',displayTarget:d.advisePin?.target})}
        whiteboardViewKey={d.sections.whiteboardViewKey} hasCorrectableQuestion={d.hasCorrectableQuestion} effectiveQuestionType={d.effectiveQuestionType}
        factGuardrailNotice={d.factGuardrailNotice} phaseOutputNotice={d.phaseOutputNotice} answerDeliveryState={d.answerDelivery.state} manualQuestionTypeCorrection={d.manualQuestionTypeCorrection}
        latestTurnText={d.latestTurnText} forceAdviseAvailable={d.forceAdviseAvailable} forceAdvisePending={d.forceAdvisePending} forceAdviseCompleted={d.forceAdviseCompleted}
        speechCorrectionInput='' speechCorrections={[]} status='listening' error={null} audioInputLiveness={null} isBusy={d.isBusy} audioControl={d.audioControl}
        showClarifyingQuestion={d.showClarifyingQuestion} clarifyingQuestion={d.clarifyingQuestion} clarifyingOptions={d.sections.clarifyingOptions}
        showClarifyingBooleanFallback={d.showClarifyingBooleanFallback} isTaskSwitchClarifyingQuestion={d.isTaskSwitchClarifyingQuestion}
        typeCorrectionMenu={{displayTarget:d.advisePin?.target??{sessionId:''},requestMenu:readCorrectionMenu,
          onSelect:selection=>actions.push({type:'correct-question-type',source:'focus-mode',correctedType:selection.correctedType,
            displayTarget:selection.displayTarget,correctionTarget:selection.target,correctionIntent:selection.option.intent})}} onForceAdvise={noop} onSpeechCorrectionInputChange={noop} onSpeechCorrectionSubmit={noop} onSpeechCorrectionDeactivate={noop}
        onToggleAudio={noop} onClarifyingAnswer={noop} onNewTaskConfirmation={noop} onSameTaskConfirmation={noop} onDismissClarifyingQuestion={noop} onBriefChange={noop} />);
    }
    window.__focus = {
      sent, actions, invokes, errors,
      release() { delayed = false; releases.splice(0).forEach(resolve=>resolve()); },
      registered() { return releases.length; },
      async publish(patch) { source = {...source,...patch, sections:{...source.sections,...patch.sections}}; const display = createMeetingFocusDisplayModel(source); renderEmbedded(display); await publisher.publish(display); },
      display() { return createMeetingFocusDisplayModel(source); },
      async publishOwner(input) {
        const data = createFocusOwnerDisplayFixture(input);
        const labels = SelectedDisplayLabelsFixture(data);
        await this.publish({ ...labels, hasCorrectableQuestion:true,
          advisePin:{locked:true,backgroundUpdated:true,target:data.adviseDisplay.target},
          sections:buildMeetingAnswerDisplayModel({content:data.adviseDisplay.stable.suggestion.content,
            parsedAnswer:data.adviseDisplay.stable.suggestion.meetingAnswer}),
        });
        return {labels,stablePhase:data.adviseDisplay.stable.sections.answer.phase};
      },
      async publishPhase(input) {
        const result = createPhaseOutputUiFixture(input);
        await this.publish({phaseOutputNotice:result.notice, sections:result.sections});
        return result;
      },
      async restart() { publisher.dispose(); publisher = createMeetingFocusPublisher({transport:publisherEndpoint,publisherInstanceId:'B',onAction,onError:error=>errors.push(error.message)}); await publisher.start(); await publisher.publish(source); },
      inject(payload) { return bus.emit('meeting-focus-snapshot',payload); },
      ack(role) { return publisher.getLatestApplied(role); },
      remount() { roots.controls.unmount(); roots.controls = createRoot(document.getElementById('controls')); roots.controls.render(<MeetingFocusWindow kind='controls'/>); }
    };
    publisher.start().then(()=>window.__focus.publish({active:true,latestTurnText:'Initial transcript',audioControl:{...empty.audioControl,action:'pause',label:'Pause',title:'Pause audio',disabled:false}, sections:{primaryAnswer:'Initial answer',chineseThinking:'Initial thinking'}}));
  `;
  const bundle = await build({ stdin: { contents: fixture, loader: "tsx", resolveDir: root }, bundle: true,
    write: false, format: "iife", platform: "browser", jsx: "automatic", loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"development"', "import.meta.env.DEV": "false" },
    plugins: [{ name: "focus-native-io", setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: "fixture" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ contents: mocks[args.path], loader: "tsx", resolveDir: root }));
      builder.onLoad({ filter: /meeting\/index\.tsx$/ }, (args) => ({ contents: readFileSync(args.path, "utf8") + `
        export { FocusModePanel };
        export function SelectedDisplayLabelsFixture({meeting,adviseDisplay}) {
          const hasCorrectableQuestion = true;
          const activeTaskKind = meeting.activeMeetingTask?.parent.questionType;
          ${selectedLabels}
          return { effectiveQuestionType,currentQuestionId,transientPersonalStatusLabel,
            phaseOutputNotice:${phaseNoticeExpression},
            currentQuestionTypeAuthority:currentQuestionTypeObservation.observedCurrentQuestionTypeAuthority,
            parentQuestionType:currentQuestionTypeObservation.observedParentType,
            parentTaskId:currentQuestionTypeObservation.observedParentId,
            activeTask:selectedTaskDisplay?.task,manualQuestionTypeCorrection:activeManualQuestionTypeCorrection };
        }
        export function NormalAnswerFixture({focusSnapshot, technical}: {focusSnapshot: MeetingFocusSnapshot; technical: boolean}) {
          const adviseDisplay = focusSnapshot.advisePin ?? {locked:false,backgroundUpdated:false,target:undefined};
          const meeting = {toggleAdvisePin:(invocation)=>window.__focus.actions.push({type:'toggle-advise-pin',displayTarget:invocation.displayTarget})};
          const transientPersonalStatusLabel = focusSnapshot.transientPersonalStatusLabel;
          return technical ? (${normalAnswerSections[0]}) : (${normalAnswerSections[1]});
        }
      `, loader: "tsx", resolveDir: path.dirname(args.path) }));
    } }],
  });
  const css = await compile(readFileSync("src/global.css", "utf8"), { base: path.join(root, "src"), onDependency() {} });
  const scanner = new Scanner({ sources: [{ base: root, pattern: "src/pages/app/components/meeting/*.tsx", negated: false }, { base: root, pattern: "src/components/ui/*.tsx", negated: false }] });
  const browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.JARVIS_CHROMIUM_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors = []; page.on("pageerror", (error) => { errors.push(error.message); t.diagnostic(error.message); });
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: '<div id="answer"></div><div id="controls"></div><div id="embedded" style="height:900px;display:flex"></div><div id="normal-technical"></div><div id="normal-general"></div>' }));
    await page.goto("https://focus.fixture/");
    await page.addStyleTag({ content: css.build(scanner.scan()) + "body{position:static;overflow:auto;height:auto}" });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.waitForFunction(() => window.__focus?.registered() === 2);
    await t.test("initial request waits for both real consumer listeners; ACK follows applied DOM", async () => {
      assert.equal(await page.evaluate(() => window.__focus.sent.filter(m=>m.payload.type==='request-snapshot').length), 0);
      await page.evaluate(() => window.__focus.release());
      await page.waitForFunction(() => window.__focus.ack('answer') && window.__focus.ack('controls')).catch(async error => {
        t.diagnostic(JSON.stringify(await page.evaluate(() => ({ errors:window.__focus.errors, messages:window.__focus.sent.map(m=>({event:m.event,type:m.payload.type,role:m.payload.windowKind,sequence:m.payload.sequence})), text:document.body.textContent?.slice(0,2000) }))));
        throw error;
      });
      const acks = await page.evaluate(() => window.__focus.sent.filter(m=>m.payload.type==='snapshot-applied'));
      for (const role of ['answer','controls']) {
        const ack=acks.find(m=>m.payload.windowKind===role);
        assert.deepEqual(ack.appliedIdentity,{publisherInstanceId:ack.payload.publisherInstanceId,sequence:ack.payload.sequence,windowKind:role});
      }
      await page.locator('#answer').getByText('Initial answer',{exact:true}).waitFor();
      await page.locator('#controls p:not([aria-hidden])').filter({hasText:/^Initial transcript$/}).waitFor();
      assert.equal(await page.evaluate(() => window.__focus.actions.length), 0);
    });
    await t.test("guardrail, approach and authorized artifact retain identical content in both actual renderers", async () => {
      await page.evaluate(() => window.__focus.publish({
        factGuardrailNotice: {kind:'generic-hypothetical-fallback',message:'Treat this as hypothetical.'},
        showClarifyingQuestion:true, clarifyingQuestion:'Which storage?',
        sections:{primaryAnswer:'Streaming answer B',approach:'Use the existing authority.',code:'cached_code_170()',complexity:'O(n)',clarifyingOptions:[{id:'one',label:'Postgres',value:'postgres'}]},
      }));
      for (const surface of ['answer','embedded']) {
        await page.locator('#'+surface).getByText('Streaming answer B',{exact:true}).waitFor();
        assert.equal(await page.locator('#'+surface).getByRole('note').textContent(),'Treat this as hypothetical.');
        assert.match(await page.locator('#'+surface).textContent(),/Use the existing authority\./);
        assert.match(await page.locator('#'+surface).textContent(),/cached_code_170\(\)/);
      }
      await page.locator('#answer').getByRole('button',{name:'Postgres',exact:true}).click();
      assert.deepEqual(await page.evaluate(()=>window.__focus.actions.at(-1)),{type:'clarifying-answer',answer:'option',option:{label:'Postgres',value:'postgres'}});
    });
    await t.test("MR5 phase-output notice is shared by inline/native answer areas and absent from controls", async () => {
      const notice = 'Implementation validation: Code, Complexity not ready for this phase. Generation cancelled. Previously published content remains available.';
      await page.evaluate(phaseOutputNotice => window.__focus.publish({phaseOutputNotice}), notice);
      for (const surface of ['answer', 'embedded']) {
        await page.locator('#'+surface).getByRole('status').filter({hasText: notice}).waitFor();
        await page.locator('#'+surface).getByText('Streaming answer B',{exact:true}).waitFor();
      }
      assert.equal(await page.locator('#controls').getByText(notice,{exact:true}).count(), 0);
      for (const width of [1100, 375]) {
        await page.setViewportSize({width, height:900});
        assert.equal(await page.locator('#answer [role="status"], #embedded [role="status"]').evaluateAll(elements => elements.every(el => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= innerWidth)), true);
        await page.locator('#answer').screenshot({path:path.join(artifactDirectory,'task153-phase-output-'+width+'.png')});
      }
      await page.setViewportSize({width:1100, height:900});
      await page.evaluate(() => window.__focus.publish({phaseOutputNotice:undefined}));
      for (const surface of ['answer', 'embedded']) {
        await page.locator('#'+surface).getByText(notice,{exact:true}).waitFor({state:'detached'});
        assert.equal(await page.locator('#'+surface).getByText(notice,{exact:true}).count(), 0);
      }
    });
    await t.test("MR5/6 real publication and phase ledger drive all four Answer layouts with full source references", async () => {
      const before = await page.evaluate(() => window.__focus.display());
      const surfaces = ['answer', 'embedded', 'normal-technical', 'normal-general'];
      for (const input of [
        {},
        {sourcePhase:'optimized_pseudocode',status:'failed'},
        {sourcePhase:'optimized_pseudocode',status:'cancelled'},
        {sourcePhase:'optimized_pseudocode',status:'pending'},
        {sourcePhase:'optimized_pseudocode',restartAfterCancellation:true},
        {sourcePhase:'optimized_pseudocode',repair:'answer'},
        {sourcePhase:'optimized_pseudocode',withRetainedCode:true,repair:'artifacts'},
        {sourcePhase:'implementation_validation',repair:'artifacts'},
      ]) {
        const result = await page.evaluate(input => window.__focus.publishPhase(input), input);
        for (const surface of surfaces) {
          const area = page.locator('#'+surface);
          await area.getByText('Retained LRU explanation.',{exact:true}).waitFor();
          if (result.notice) {
            await area.getByRole('status').filter({hasText:result.notice}).waitFor();
            assert.equal(await area.getByRole('status').textContent(), result.notice);
          } else {
            await area.getByRole('status').waitFor({state:'detached'});
          }
        }
        assert.equal(await page.locator('#controls').getByText(result.notice ?? 'Source phase is unknown',{exact:true}).count(), 0);
        for (const key of ['sessionId','runtimeEpoch','taskId','logicalQuestionUnitId','logicalQuestionRevision','questionSourceHash','settlementId']) {
          assert.equal(result.stable[key], result.reference[key]);
        }
        assert.deepEqual(result.stable.suggestion.questionLineage, result.previousStable.suggestion.questionLineage);
        assert.deepEqual(result.stable.suggestion.basedOnTurnIds, result.reference.sourceTurnIds);
        assert.deepEqual(result.stable.suggestion.basedOnObservationIds, result.reference.sourceObservationIds);
        const wire = await page.evaluate(() => window.__focus.sent.filter(item => item.event==='meeting-focus-snapshot').at(-1).payload.payload);
        assert.equal(wire.phaseOutputNotice, result.notice);
        assert.equal(JSON.stringify(wire).includes(result.reference.sourceTraceId), false);
        assert.equal('parsedAnswer' in wire.sections, false);
        if (!input.sourcePhase) {
          assert.match(result.notice, /Source phase is unknown for Answer, Code, Complexity/);
          assert.doesNotMatch(result.notice, /not ready|failed|cancelled|Generating/);
          assert.equal(result.stable.sections.answer.phase, undefined);
          for (const width of [1100,375]) {
            await page.setViewportSize({width,height:900});
            for (const surface of surfaces) {
              assert.equal(await page.locator('#'+surface+' [role="status"]').evaluate(el => el.scrollWidth<=el.clientWidth && el.getBoundingClientRect().right<=innerWidth), true);
            }
            await page.locator('#normal-technical').screenshot({path:path.join(artifactDirectory,'task153-legacy-phase-normal-'+width+'.png')});
            await page.locator('#answer').screenshot({path:path.join(artifactDirectory,'task153-legacy-phase-focus-'+width+'.png')});
          }
          await page.setViewportSize({width:1100,height:900});
        }
        if (input.restartAfterCancellation) {
          assert.equal(result.generation.status, 'started');
          assert.match(result.notice, /Generating/);
          assert.doesNotMatch(result.notice, /cancelled/);
        }
        if (input.repair==='answer') assert.match(result.notice, /Code, Complexity not ready/);
        if (input.repair==='artifacts') {
          assert.deepEqual(result.stable.sections.answer, result.previousStable.sections.answer);
          assert.deepEqual(result.artifactCommit.mutatedArtifacts, []);
          assert.equal(result.stable.sections.code.revision, result.previousStable.sections.code.revision);
          assert.equal(result.stable.suggestion.meetingAnswer.sections.code, result.previousStable.suggestion.meetingAnswer.sections.code);
          if (input.sourcePhase==='implementation_validation') {
            assert.equal(result.artifactCommit.reason, 'artifact-candidate-no-change');
            assert.equal(result.notice, undefined);
          } else {
            assert.equal(result.artifactCommit.disposition, 'committed');
            assert.equal(result.stable.sections.code.phase, 'implementation_validation');
            assert.match(result.notice, /Answer not ready/);
            assert.doesNotMatch(result.notice, /Code|Complexity/);
          }
        }
      }
      await page.evaluate(display => window.__focus.publish({...display,phaseOutputNotice:display.phaseOutputNotice}), before);
      await page.locator('#answer').getByText('Streaming answer B',{exact:true}).waitFor();
    });
    await t.test("native correction draft survives snapshots and restart, controls dispatch original intents", async () => {
      const input=page.locator('#controls').getByPlaceholder('Correction: RAG not rec / Glean');
      await input.fill('RAG not rec');
      await page.evaluate(()=>window.__focus.publish({latestTurnText:'New transcript',hasCorrectableQuestion:true,effectiveQuestionType:'coding'}));
      assert.equal(await input.inputValue(),'RAG not rec');
      await page.locator('#controls').getByRole('button',{name:'Apply',exact:true}).click();
      assert.deepEqual(await page.evaluate(()=>window.__focus.actions.at(-1)),{type:'submit-correction',correction:'RAG not rec'});
      await page.locator('#controls').getByRole('button',{name:'Pause',exact:true}).click();
      assert.deepEqual(await page.evaluate(()=>window.__focus.actions.at(-1)),{type:'toggle-listening'});
      await input.fill('Unsent draft');
      await page.evaluate(()=>window.__focus.restart());
      await page.waitForFunction(()=>window.__focus.ack('answer')?.publisherInstanceId==='B' && window.__focus.ack('controls')?.publisherInstanceId==='B');
      assert.equal(await input.inputValue(),'Unsent draft');
      const old=await page.evaluate(()=>window.__focus.sent.find(m=>m.event==='meeting-focus-snapshot').payload);
      await page.evaluate(old=>window.__focus.inject({...old,sequence:999,payload:{...old.payload,sections:{...old.payload.sections,primaryAnswer:'STALE'}}}),old);
      assert.equal(await page.getByText('STALE',{exact:true}).count(),0);
      await page.evaluate(()=>window.__focus.remount());
      await page.locator('#controls').getByPlaceholder('Correction: RAG not rec / Glean').waitFor();
      await page.waitForFunction(()=>window.__focus.ack('controls')?.publisherInstanceId==='B');
    });
    await t.test("Term cancel and two-step type correction preserve identity; version errors preserve applied state", async () => {
      await page.evaluate(()=>window.__focus.publish({advisePin:{locked:false,backgroundUpdated:false,target:{sessionId:'menu-session',logicalQuestionUnitId:'lqu-A',logicalQuestionRevision:1}},speechCorrections:[{id:'term-170',input:'RAG not rec',from:'rec',to:'RAG',appliedCount:1,activeQuestion:{disposition:'current-question-overlay',regenerationStatus:'running'}}]}));
      await page.waitForFunction(()=>window.__focus.ack('controls')?.displayTarget?.sessionId==='menu-session');
      await page.locator('#controls').getByRole('button',{name:'Stop correction rec',exact:true}).click();
      assert.deepEqual(await page.evaluate(()=>window.__focus.actions.at(-1)),{type:'deactivate-correction',correctionId:'term-170'});
      await page.locator('#controls').getByRole('button',{name:'Field',exact:true}).click();
      assert.equal(await page.evaluate(()=>window.__focus.actions.at(-1).type),'request-correction-menu');
      await page.getByRole('group',{name:'Correction actions'}).getByRole('button').first().click();
      const correctionAction = await page.evaluate(()=>window.__focus.actions.at(-1));
      assert.match(correctionAction.actionId,/^manual_action_/);
      assert.equal(typeof correctionAction.requestedAt,'number');
      assert.equal(correctionAction.type,'correct-question-type');
      assert.equal(correctionAction.correctedType,'field-knowledge');
      assert.deepEqual(correctionAction.correctionIntent,{kind:'new-child',parentId:'parent-A'});
      assert.equal(correctionAction.correctionTarget.logicalQuestionUnitId,'lqu-A');
      const before=await page.evaluate(()=>window.__focus.ack('answer'));
      await page.evaluate(()=>window.__focus.inject({...window.__focus.sent.filter(m=>m.event==='meeting-focus-snapshot').at(-1).payload,schemaVersion:999}));
      assert.match(await page.locator('#answer').getByRole('alert').textContent(),/Unsupported Focus snapshot version/);
      assert.deepEqual(await page.evaluate(()=>window.__focus.ack('answer')),before);
      await page.locator('#answer').getByText('Streaming answer B',{exact:true}).waitFor();
    });
    await t.test("ML1/8 real Main/native/embedded pin icons carry rendered identity at narrow and wide sizes", async () => {
      const target = {sessionId:'pin-session',logicalQuestionUnitId:'lqu-A',logicalQuestionRevision:3,
        suggestionId:'A',traceId:'trace-A',generationId:'generation-A',stableRevision:1};
      await page.evaluate(target=>window.__focus.publish({advisePin:{locked:true,backgroundUpdated:true,target}}),target);
      for (const width of [375,1100]) {
        await page.setViewportSize({width,height:900});
        for (const surface of ['answer','embedded','normal-technical','normal-general']) {
          const button=page.locator('#'+surface).getByRole('button',{name:'Unlock question',exact:true});
          await button.click();
          assert.deepEqual(await page.evaluate(()=>window.__focus.actions.at(-1)),{type:'toggle-advise-pin',displayTarget:target});
          const box=await button.boundingBox();
          assert.ok(box && box.width===28 && box.height===28 && box.x>=0 && box.x+box.width<=width);
          assert.match(await button.getAttribute('title'),/newer answer ready/);
        }
        await page.locator('#answer').screenshot({path:path.join(artifactDirectory,'locked-focus-answer-'+width+'.png')});
        await page.locator('#controls').screenshot({path:path.join(artifactDirectory,'locked-focus-controls-'+width+'.png')});
      }
      assert.deepEqual(await page.evaluate(()=>window.__focus.ack('answer').displayTarget),target);
      await page.locator('#controls').getByRole('button',{name:'Field',exact:true}).click();
      assert.deepEqual((await page.evaluate(()=>window.__focus.actions.at(-1))).displayTarget,target);
      await page.getByRole('button',{name:'Cancel type correction',exact:true}).click();
      await page.getByRole('button',{name:'Cancel type correction',exact:true}).waitFor({state:'hidden'});
      await page.evaluate(target=>window.__focus.publish({advisePin:{locked:false,backgroundUpdated:false,target}}),target);
      await page.waitForFunction(()=>window.__focus.ack('controls')?.adviseLocked === false);
      for (const surface of ['answer','embedded','normal-technical','normal-general']) {
        assert.equal(await page.locator('#'+surface).getByRole('button',{name:'Lock question',exact:true}).getAttribute('aria-pressed'),'false');
      }
      await page.locator('#controls').getByRole('button',{name:'Field',exact:true}).click();
      assert.deepEqual((await page.evaluate(()=>window.__focus.actions.at(-1))).displayTarget,target,
        'unlocked correction also retains the displayed target at menu open');
      await page.getByRole('button',{name:'Cancel type correction',exact:true}).click();
      await page.getByRole('button',{name:'Cancel type correction',exact:true}).waitFor({state:'hidden'});
      await page.evaluate(()=>window.__focus.publish({advisePin:undefined}));
    });
    await t.test("B selected real owner metadata keeps A labels/summary across B and shows committed A changes before regeneration", async () => {
      for (const input of [{}, {differentParent:true}, {committedUpdate:true}]) {
        const result = await page.evaluate(input=>window.__focus.publishOwner(input),input);
        const type = input.committedUpdate ? 'AI/ML SD' : 'General SD';
        const badge = page.locator('#controls').getByText(`Q: ${type} · P: ${type}`,{exact:true});
        await badge.waitFor();
        assert.equal(result.labels.activeTask.id,'parent-A');
        assert.equal(result.labels.activeTask.child,undefined);
        assert.equal(result.labels.activeTask.playbookPhase,input.committedUpdate?'design_framing':'requirement_clarification');
        assert.equal(result.stablePhase,'requirement_clarification');
        assert.match(await badge.locator('..').getAttribute('title'),input.committedUpdate?/phase: design_framing/:/phase: requirement_clarification/);
        for (const surface of ['answer','embedded','normal-technical','normal-general']) {
          await page.locator('#'+surface).getByText('Selected A answer',{exact:true}).waitFor();
          await page.locator('#'+surface).getByText(input.committedUpdate?'Selected A: design framing output pending.':'Selected A: clarification output pending.',{exact:true}).waitFor();
        }
      }
      for (const width of [375,1100]) {
        await page.setViewportSize({width,height:900});
        await page.locator('#answer').screenshot({path:path.join(artifactDirectory,'selected-owner-A-update-answer-'+width+'.png')});
        if (width===1100) await page.locator('#controls').screenshot({path:path.join(artifactDirectory,'selected-owner-A-update-controls-1100.png')});
      }
    });
    await t.test("B locked Advise-only Field A hides a foreign Coding owner phase notice only", async () => {
      const result = await page.evaluate(()=>window.__focus.publishOwner({selectedChild:true,matchingChild:true,adviseOnly:true}));
      await page.locator('#controls').getByText('Q: Field Knowledge · P: General SD',{exact:true}).waitFor();
      assert.equal(result.labels.activeTask,undefined);
      assert.equal(result.labels.phaseOutputNotice,undefined);
      for (const surface of ['answer','embedded','normal-technical','normal-general']) {
        assert.equal(await page.locator('#'+surface).getByText('Foreign Coding child phase notice.',{exact:true}).count(),0);
        await page.locator('#'+surface).getByText('Selected A answer',{exact:true}).waitFor();
      }
      await page.locator('#answer').screenshot({path:path.join(artifactDirectory,'advise-only-no-foreign-phase.png')});
    });
    await t.test("Clear removes old content/notice, long markdown width stays contained", async () => {
      await page.evaluate(()=>window.__focus.publish({factGuardrailNotice:undefined,showClarifyingQuestion:false,sections:{primaryAnswer:'',approach:'',code:'',complexity:''}}));
      await page.locator('#answer').getByText('Waiting for answer.',{exact:true}).waitFor();
      assert.equal(await page.locator('#answer').getByRole('note').count(),0);
      const wide='| '+Array.from({length:12},(_,i)=>'Column'+i).join(' | ')+' |\n| '+Array(12).fill('---').join(' | ')+' |\n| '+Array(12).fill('long_unbroken_content_'.repeat(10)).join(' | ')+' |';
      await page.evaluate(text=>window.__focus.publish({sections:{primaryAnswer:text}}),wide);
      await page.locator('#answer .meeting-assistant-markdown table').waitFor();
      for (const width of [1100,375]) {
        await page.setViewportSize({width,height:900});
        assert.equal(await page.locator('#answer').evaluate(el=>el.scrollWidth<=innerWidth),true);
        assert.equal(await page.locator('#answer section, #embedded section').evaluateAll(elements=>elements.every(el=>el.getBoundingClientRect().right<=innerWidth)),true);
        assert.equal(await page.locator('#answer [data-streamdown="table-wrapper"] > div:last-child').evaluate(el=>{el.scrollLeft=100;return el.scrollLeft>0;}),true);
        await page.locator('#answer').screenshot({path:path.join(artifactDirectory,'task170-answer-'+width+'.png')});
      }
    });
    assert.deepEqual(errors,[]);
    assert.deepEqual(await page.evaluate(()=>window.__focus.errors),[]);
  } finally { await browser.close(); }
});
