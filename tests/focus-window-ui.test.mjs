import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";

const root = process.cwd();
let playwright;
try { playwright = createRequire(import.meta.url)(process.env.JARVIS_PLAYWRIGHT_MODULE ?? "playwright"); } catch {}

test("Task170 production React receivers, shared renderer and embedded Focus with controlled native transport", {
  skip: !playwright && "Set JARVIS_PLAYWRIGHT_MODULE to run the real React browser test",
}, async (t) => {
  const mainSource = readFileSync("src/pages/app/components/meeting/index.tsx", "utf8");
  const mocks = {
    "@/hooks": "export const useMeetingAssistant = () => {}; export const useShortcuts = () => {}; export const useWindowResize = () => {};",
    "@/lib": "export const extractVariables = () => []; export const safeLocalStorage = { getItem: () => null };",
    "@/lib/meeting": ["focus-window", "screen-task-answer", "whiteboard-viewport", "whiteboard-ascii-fallback", "task-taxonomy"].map((file) => `export * from './src/lib/meeting/${file}';`).join("\n"),
    "@/components": ['export * from "./src/components/Markdown";', ...["badge", "button", "input", "label", "popover", "scroll-area", "slider", "switch", "textarea"].map((file) => `export * from './src/components/ui/${file}';`)].join("\n"),
    "@tauri-apps/api/event": "export const listen = (event, callback) => window.__focusBus.listen(event, value => callback({payload:value})); export const emit = (event, value) => window.__focusBus.emit(event, value);",
    "@tauri-apps/api/core": "export const invoke = async (command, args) => { window.__focusInvokes.push({command,args}); };",
  };
  const real = new Set(["stripOuterCodeFence", "normalizeCanonicalQuestionType", "MEETING_FOCUS_ACTION_EVENT", "MEETING_FOCUS_SNAPSHOT_EVENT"]);
  const bindings = [...mainSource.matchAll(/import\s*\{([^}]+)\}\s*from\s*"@\/lib\/meeting"/g)][0][1];
  for (const name of bindings.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!real.has(name)) mocks["@/lib/meeting"] += `\nexport const ${name} = () => null;`;
  }
  const fixture = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { MeetingFocusWindow } from './src/pages/app/components/meeting/focus-window';
    import { FocusModePanel } from './src/pages/app/components/meeting/index';
    import { EMPTY_MEETING_FOCUS_SNAPSHOT as empty } from './src/lib/meeting/focus-window';
    import { createMeetingFocusPublisher } from './src/lib/meeting/focus-window-protocol';
    import { createMeetingFocusDisplayModel } from './src/lib/meeting/focus-display';
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
    let publisher = createMeetingFocusPublisher({transport:publisherEndpoint, publisherInstanceId:'A', onAction:action=>actions.push(action), onError:error=>errors.push(error.message)});
    const roots = Object.fromEntries(['answer','controls','embedded'].map(id=>[id,createRoot(document.getElementById(id))]));
    roots.answer.render(<MeetingFocusWindow kind='answer'/>); roots.controls.render(<MeetingFocusWindow kind='controls'/>);
    function renderEmbedded(d) {
      const noop = () => {};
      roots.embedded.render(<FocusModePanel suggestionSections={d.sections} codingArtifactCached={false} whiteboardArtifactCached={false}
        whiteboardViewKey={d.sections.whiteboardViewKey} hasCorrectableQuestion={d.hasCorrectableQuestion} effectiveQuestionType={d.effectiveQuestionType}
        factGuardrailNotice={d.factGuardrailNotice} answerDeliveryState={d.answerDelivery.state} manualQuestionTypeCorrection={d.manualQuestionTypeCorrection}
        latestTurnText={d.latestTurnText} forceAdviseAvailable={d.forceAdviseAvailable} forceAdvisePending={d.forceAdvisePending} forceAdviseCompleted={d.forceAdviseCompleted}
        speechCorrectionInput='' speechCorrections={[]} status='listening' error={null} audioInputLiveness={null} isBusy={d.isBusy} audioControl={d.audioControl}
        showClarifyingQuestion={d.showClarifyingQuestion} clarifyingQuestion={d.clarifyingQuestion} clarifyingOptions={d.sections.clarifyingOptions}
        showClarifyingBooleanFallback={d.showClarifyingBooleanFallback} isTaskSwitchClarifyingQuestion={d.isTaskSwitchClarifyingQuestion}
        onCorrectQuestionType={noop} onForceAdvise={noop} onSpeechCorrectionInputChange={noop} onSpeechCorrectionSubmit={noop} onSpeechCorrectionDeactivate={noop}
        onToggleAudio={noop} onClarifyingAnswer={noop} onNewTaskConfirmation={noop} onSameTaskConfirmation={noop} onDismissClarifyingQuestion={noop} onBriefChange={noop} />);
    }
    window.__focus = {
      sent, actions, invokes, errors,
      release() { delayed = false; releases.splice(0).forEach(resolve=>resolve()); },
      registered() { return releases.length; },
      async publish(patch) { source = {...source,...patch, sections:{...source.sections,...patch.sections}}; const display = createMeetingFocusDisplayModel(source); renderEmbedded(display); await publisher.publish(display); },
      async restart() { publisher.dispose(); publisher = createMeetingFocusPublisher({transport:publisherEndpoint,publisherInstanceId:'B',onAction:action=>actions.push(action),onError:error=>errors.push(error.message)}); await publisher.start(); await publisher.publish(source); },
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
      builder.onLoad({ filter: /meeting\/index\.tsx$/ }, (args) => ({ contents: readFileSync(args.path, "utf8") + "\nexport { FocusModePanel };", loader: "tsx", resolveDir: path.dirname(args.path) }));
    } }],
  });
  const css = await compile(readFileSync("src/global.css", "utf8"), { base: path.join(root, "src"), onDependency() {} });
  const scanner = new Scanner({ sources: [{ base: root, pattern: "src/pages/app/components/meeting/*.tsx", negated: false }, { base: root, pattern: "src/components/ui/*.tsx", negated: false }] });
  const browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.JARVIS_CHROMIUM_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors = []; page.on("pageerror", (error) => { errors.push(error.message); t.diagnostic(error.message); });
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: '<div id="answer"></div><div id="controls"></div><div id="embedded" style="height:900px;display:flex"></div>' }));
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
    await t.test("Term cancel and type correction keep their existing payloads; version errors preserve applied state", async () => {
      await page.evaluate(()=>window.__focus.publish({speechCorrections:[{id:'term-170',input:'RAG not rec',from:'rec',to:'RAG',appliedCount:1,activeQuestion:{disposition:'current-question-overlay',regenerationStatus:'running'}}]}));
      await page.locator('#controls').getByRole('button',{name:'Stop correction rec',exact:true}).click();
      assert.deepEqual(await page.evaluate(()=>window.__focus.actions.at(-1)),{type:'deactivate-correction',correctionId:'term-170'});
      await page.locator('#controls').getByRole('button',{name:'Field',exact:true}).click();
      assert.deepEqual(await page.evaluate(()=>window.__focus.actions.at(-1)),{type:'correct-question-type',correctedType:'field-knowledge',source:'focus-mode'});
      const before=await page.evaluate(()=>window.__focus.ack('answer'));
      await page.evaluate(()=>window.__focus.inject({...window.__focus.sent.filter(m=>m.event==='meeting-focus-snapshot').at(-1).payload,schemaVersion:999}));
      assert.match(await page.locator('#answer').getByRole('alert').textContent(),/Unsupported Focus snapshot version/);
      assert.deepEqual(await page.evaluate(()=>window.__focus.ack('answer')),before);
      await page.locator('#answer').getByText('Streaming answer B',{exact:true}).waitFor();
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
        await page.locator('#answer').screenshot({path:'/tmp/task170-answer-'+width+'.png'});
      }
    });
    assert.deepEqual(errors,[]);
    assert.deepEqual(await page.evaluate(()=>window.__focus.errors),[]);
  } finally { await browser.close(); }
});
