// 178/168 PC, commit C3: the Preview group, the Fact Risk Review selector and the Meeting
// Metadata selector of the Interview Brief area, mounted in a real browser with the real Hook.
//
// Real: useMeetingAssistant, ConfigurationsPanel and InterviewSessionBriefPanel rendered through
// the page's own call-site JSX, the UI primitives (Radix Switch, Button, Input, Label),
// localStorage and page reloads. Controlled: the Tauri boundary, the database, the provider and
// the model worker. The two panels are private to the page module, so the bundle appends one
// export line to the page source in memory; no repository file is changed.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import ts from 'typescript';
import { loadBrowserTestDependency } from './helpers/browser-test-dependency.mjs';

const { playwright, skip: browserTestSkip } = loadBrowserTestDependency();
const root = process.cwd();
const PAGE = 'src/pages/app/components/meeting/index.tsx';
const ORIGIN = 'https://pc-c3.fixture';
const SETTINGS = 'meeting_assistant_settings';
const BRIEF = 'meeting_interview_brief';
const OFF_NOTE = 'Stored mode is Off: no request is made until you pick a mode.';
const OPENING = 'Welcome to the Stripe interview loop. Tell me about a project where you reduced request latency with caching.';

const boundaries = {
  '@/contexts': `export const useApp=()=>window.__pc.app;`,
  '@tauri-apps/api/core': `export const invoke=(name,args)=>window.__pc.invoke(name,args);
    export const convertFileSrc=(p)=>p;
    export class Channel { onmessage; }`,
  '@tauri-apps/api/event': `export const listen=(name,fn)=>window.__pc.listen(name,fn);
    export const emit=async(name,payload)=>window.__pc.emit(name,payload);
    export const once=listen;`,
  '@tauri-apps/plugin-sql': `export default class Database { static async load(){return window.__pc.database;} }`,
  '@/lib/database/memory.action': `
    export const loadMemoryEntriesForSnapshot=async()=>({entries:[],timings:{databaseAcquireMs:0,databaseReadMs:0,rowMappingMs:0}});
    export const markMemoryEntriesUsedBatch=async()=>undefined;
    export const markMemoryEntriesUsed=markMemoryEntriesUsedBatch;
    export const getMemoryEntries=async()=>[];
    export const getEnabledMemoryEntries=getMemoryEntries;
    export const getMemorySources=async()=>[];
    export const getMemoryProjects=async()=>[];
    export const getMemoryEntryRevision=async()=>{throw Error('Unexpected revision read');};
    export const getMemorySourceRevision=getMemoryEntryRevision;
    export const setMemoryEntryEnabled=async()=>{throw Error('Unexpected memory write');};
    export const rebuildCuratedMemoryIndex=async()=>{throw Error('Unexpected memory publication');};`,
  // The real primitives the page imports, without the rest of the component barrel. Markdown is
  // imported by page modules that neither panel renders.
  '@/components': `export * from './src/components/ui/button'; export * from './src/components/ui/popover';
    export * from './src/components/ui/badge'; export * from './src/components/ui/input'; export * from './src/components/ui/label';
    export * from './src/components/ui/scroll-area'; export * from './src/components/ui/slider'; export * from './src/components/ui/switch';
    export * from './src/components/ui/textarea'; export const Markdown=()=>null;`,
  '@/hooks': `export {useMeetingAssistant} from './src/hooks/useMeetingAssistant';
    export const useShortcuts=()=>({}); export const useWindowResize=()=>({});`,
};

async function panelsBundle() {
  const source = readFileSync(PAGE, 'utf8');
  const file = ts.createSourceFile('main.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const callSite = tag => {
    const found = [];
    const visit = node => { if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(file) === tag) found.push(node); ts.forEachChild(node, visit); };
    visit(file);
    assert.equal(found.length, 1, `${tag} is rendered from one call site`);
    return found[0].getText(file);
  };
  return build({ stdin: { loader: 'tsx', resolveDir: root, contents: `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {useMeetingAssistant} from './src/hooks/useMeetingAssistant';
    import {ConfigurationsPanel,InterviewSessionBriefPanel} from './${PAGE.replace(/\.tsx$/, '')}';
    function Entry(){
      const meeting=useMeetingAssistant();
      // The page's own locals at the two call sites; both panels start open here.
      const [configurationsOpen,setConfigurationsOpen]=useState(true);
      const [interviewBriefOpen,setInterviewBriefOpen]=useState(true);
      const nativeAudioFaultFeedback={status:'idle'};
      const handleNativeAudioFaultInjection=async()=>undefined;
      window.__pc.meeting=meeting;
      return <div id="panels" className="space-y-3 bg-background text-foreground" style={{padding:12}}>
        <div id="configurations">${callSite('ConfigurationsPanel')}</div>
        <div id="brief">${callSite('InterviewSessionBriefPanel')}</div>
      </div>;
    }
    createRoot(document.getElementById('root')).render(<Entry/>);
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'silent',
    alias: { '@': path.join(root, 'src') },
    define: { 'import.meta.env.DEV': 'true', 'import.meta.env.PROD': 'false', 'process.env.NODE_ENV': '"development"' },
    loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'empty' },
    plugins: [{ name: 'pc-c3-boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        const name = args.path.startsWith(`${root}/src/`) ? `@/${path.relative(`${root}/src`, args.path)}` : args.path;
        if (Object.hasOwn(boundaries, name)) return { path: name, namespace: 'pc-c3-boundary' };
        if (args.path.endsWith('?raw')) return { path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'pc-c3-raw' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'pc-c3-boundary' }, args => ({ contents: boundaries[args.path], loader: 'ts', resolveDir: root }));
      builder.onLoad({ filter: /.*/, namespace: 'pc-c3-raw' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }));
      // In memory only: the two module-private panels become importable by the entry above.
      builder.onLoad({ filter: /src\/pages\/app\/components\/meeting\/index\.tsx$/ }, args => ({
        contents: `${readFileSync(args.path, 'utf8')}\nexport { ConfigurationsPanel, InterviewSessionBriefPanel };\n`,
        loader: 'tsx', resolveDir: path.dirname(args.path) }));
    } }],
  });
}

// Runs before the bundle on every navigation, reloads included. It never touches localStorage.
function installBoundaries() {
  const listeners = new Map();
  const provider = { id: 'pc', streaming: true, responseContentPath: 'choices[0].message.content',
    curl: `curl https://pc-c3.fixture/provider -H 'Content-Type: application/json' -d '{"model":"pc","messages":[{"role":"system","content":"{{SYSTEM_PROMPT}}"},{"role":"user","content":[{"type":"text","text":"{{TEXT}}"}]}]}'` };
  const pc = window.__pc = { calls: [], unexpected: [], requests: [],
    app: { screenshotConfiguration: {}, selectedSttProvider: { provider: '', variables: {} }, allSttProviders: [],
      selectedAIProvider: { provider: 'pc', variables: {} }, allAiProviders: [provider],
      selectedAudioDevices: { input: { id: 'default' }, output: { id: 'default' } } },
    database: { select: async sql => { pc.calls.push({ sql }); return []; },
      execute: async (sql, values = []) => { pc.calls.push({ sql, values }); return { rowsAffected: 0 }; } },
    listen: async (name, fn) => { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); return () => set.delete(fn); },
    emit: (name, payload) => { for (const fn of listeners.get(name) ?? []) fn({ event: name, payload }); },
    invoke: async (name, args = {}) => {
      pc.calls.push({ name, args });
      // Tasks 145/183 NDI: a scenario may answer the diagnostics command itself. Otherwise it answers null, as before.
      if (name === 'set_native_stall_diagnostics' && pc.nativeStallDiagnostics) return pc.nativeStallDiagnostics(args);
      if (['preparation_extraction_initialize', 'memory_content_initialize', 'set_native_stall_diagnostics', 'read_meeting_trace_metrics',
        'write_meeting_trace_metrics', 'write_meeting_session_recording_text'].includes(name)) return null;
      // Tasks 145/183 NDI: a scenario may give each recording its own folder path. Otherwise one path, as before.
      if (name === 'start_meeting_session_recording') return pc.recordingFolderPath ? pc.recordingFolderPath(args) : '/pc-c3-recording';
      if (name === 'write_meeting_session_recording_base64') return `/pc-c3-recording/${args.relativePath}`;
      if (name === 'export_meeting_trace') return `/pc-c3-recording/exports/${args.fileName}`;
      if (name === 'cleanup_stt_evaluation_captures') return 0;
      if (name === 'get_stt_evaluation_capture_status') return { active: false, bytesWritten: 0 };
      if (name === 'evaluation_store_import_status') return { imported: true };
      if (name === 'evaluation_store_read') return { events: [], projections: [] };
      if (name === 'evaluation_store_project') return JSON.parse(JSON.stringify(args.projection));
      // Task 178 LG: a scenario may answer the diagnostic log command itself. Otherwise the level of the call is applied
      // and every entry is taken; an invalid level rejects, as on native.
      if (name === 'write_diagnostic_log' && pc.diagnosticLog) return pc.diagnosticLog(args);
      if (name === 'write_diagnostic_log') {
        if (!['error', 'warn', 'info', 'debug', 'trace'].includes(args.level)) throw new Error('Diagnostic log level is not one of error, warn, info, debug, trace');
        return { v: 1, appliedLevel: args.level, accepted: (args.entries ?? []).length, filtered: 0, rejected: 0, dropped: 0,
          sink: { state: 'ready', droppedTotal: 0, writeFailures: 0, unsavedAtExit: 0 } };
      }
      pc.unexpected.push(name);
      throw new Error('Uncontrolled native command: ' + name);
    },
  };
  window.Worker = class { constructor() { throw new Error('External model worker unavailable in the PC C3 fixture'); } };
  window.fetch = async (url, init) => {
    if (String(url) !== 'https://pc-c3.fixture/provider') { pc.unexpected.push('fetch ' + url); throw new Error('Uncontrolled fetch: ' + url); }
    const system = JSON.parse(init.body).messages.find(message => message.role === 'system')?.content ?? '';
    const operation = system.startsWith('Infer one meeting metadata field') ? 'meeting-metadata'
      : system.includes('Classify only the question type') ? 'question-type'
      : system.startsWith('Identify factual commitments') ? 'fact-risk-review'
      : system.startsWith('Decide one thing only: whether questionText') ? 'visual-dependence'
      : 'other';
    pc.requests.push({ operation, system: system.slice(0, 80) });
    // A valid, grounded, high-confidence company proposal for the opening used below.
    const response = operation === 'meeting-metadata' ? JSON.stringify({ schemaVersion: 1, company: 'Stripe', confidence: 0.99,
        evidenceSpans: ['Welcome to the Stripe interview loop'], abstainReason: null })
      : operation === 'question-type' ? JSON.stringify({ v: 1, t: 'project-deep-dive', c: 0.99, e: 'Tell me about a project' })
      : operation === 'fact-risk-review' ? JSON.stringify({ v: 1, flags: [] })
      : operation === 'visual-dependence' ? JSON.stringify({ schemaVersion: 2, decision: 'not-visual', questionEvidenceSpans: ['Tell me about a project'], visualEvidenceSpans: [] })
      : 'Answer: I led a caching project.';
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: response }, finish_reason: null }] }) + '\n\n' +
      'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } });
  };
}

const mounted = page => page.waitForFunction(() => Boolean(window.__pc?.meeting) &&
  Boolean(document.querySelector('#configurations section')) && Boolean(document.querySelector('#brief section')), undefined, { timeout: 15000 });

// A fresh browser context whose localStorage holds exactly the given items before the page loads.
async function openPanels(browser, bundle, seed = {}) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const failures = [];
    page.on('pageerror', error => failures.push(error.stack ?? error.message));
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url === `${ORIGIN}/seed`) return route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' });
      if (url === `${ORIGIN}/`) return route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>' });
      if (url === `${ORIGIN}/bundle.js`) return route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text });
      failures.push(`Uncontrolled network: ${url}`);
      await route.abort();
    });
    await page.goto(`${ORIGIN}/seed`);
    await page.evaluate(items => {
      localStorage.clear();
      for (const [key, value] of Object.entries(items)) localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    }, seed);
    await page.addInitScript(installBoundaries);
    await page.goto(`${ORIGIN}/`);
    await mounted(page);
    return { page, context, failures, reload: async () => { await page.reload(); await mounted(page); } };
  } catch (error) { await context.close(); throw error; }
}

// What the two panels show in the DOM, next to what the Hook holds and what storage holds.
const shown = page => page.evaluate(({ SETTINGS, BRIEF }) => {
  const own = element => [...element.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join(' ').replace(/\s+/g, ' ').trim();
  const configurations = document.querySelector('#configurations');
  const brief = document.querySelector('#brief');
  // A group is a title row followed by its rows.
  const titles = [...configurations.querySelectorAll('div')].filter(element => ['Response', 'Context', 'Audio', 'Preview', 'Debug'].includes(own(element)) &&
    element.parentElement.children.length === 2 && element.parentElement.firstElementChild === element);
  const preview = titles.find(element => own(element) === 'Preview')?.parentElement;
  const selector = (scope, label) => {
    const labels = scope ? [...scope.querySelectorAll('label')].filter(element => element.textContent.trim() === label) : [];
    const buttons = labels.length === 1 ? [...labels[0].parentElement.querySelectorAll('button')] : [];
    // The selected option is the one drawn with the Button's filled variant.
    return { count: labels.length, options: buttons.map(button => button.textContent.trim()),
      selected: buttons.filter(button => button.className.split(/\s+/).includes('bg-primary')).map(button => button.textContent.trim()) };
  };
  return {
    groups: titles.map(own),
    previewTitleControls: preview ? preview.firstElementChild.querySelectorAll('button,input,select,textarea').length : -1,
    previewSwitches: preview ? [...preview.querySelectorAll('button[role="switch"]')].map(element => ({ checked: element.getAttribute('aria-checked'), disabled: element.disabled })) : [],
    previewButtons: preview ? [...preview.querySelectorAll('button:not([role="switch"])')].map(button => button.textContent.trim()) : [],
    previewOtherControls: preview ? preview.querySelectorAll('select,input,textarea').length : -1,
    factRisk: selector(preview, 'Fact Risk Review'),
    metadataInConfigurations: selector(configurations, 'Meeting Metadata').count,
    metadata: selector(brief, 'Meeting Metadata'),
    offNotes: [...brief.querySelectorAll('div')].map(own).filter(text => text.startsWith('Stored mode is Off')),
    offOptions: [...document.querySelectorAll('#panels button, #panels option')].filter(element => /^off$/i.test(element.textContent.trim())).length,
    retired: /Semantic Type Rescue|Personal Fact Guardrail|Meeting Metadata Enforcement/.test(document.querySelector('#panels').textContent),
    companyInput: brief.querySelector('input[placeholder]').value,
    briefTitle: brief.querySelector('section > button').textContent.replace(/\s+/g, ' ').trim(),
    settings: JSON.parse(JSON.stringify(window.__pc.meeting.settings)),
    stored: localStorage.getItem(SETTINGS),
    storedBrief: localStorage.getItem(BRIEF),
  };
}, { SETTINGS, BRIEF });

// Every serialisable member of the Hook's return value, and the boundary counters.
const hookState = page => page.evaluate(() => {
  const state = {};
  for (const [key, value] of Object.entries(window.__pc.meeting)) {
    if (typeof value === 'function') continue;
    try { state[key] = JSON.parse(JSON.stringify(value ?? null)); } catch { state[key] = '<unserialisable>'; }
  }
  return { state, nativeCalls: window.__pc.calls.length, requests: window.__pc.requests.length };
});
function changed(before, after, at = '') {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key => changed(before[key], after[key], at ? `${at}.${key}` : key));
  }
  return [`${at}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`];
}
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
// The Hook's state once its effects have stopped moving it: three equal readings in a row.
async function settledState(page) {
  let previous = await hookState(page);
  for (let attempt = 0, equal = 0; attempt < 120; attempt++) {
    await frames(page);
    const next = await hookState(page);
    equal = JSON.stringify(next) === JSON.stringify(previous) ? equal + 1 : 0;
    if (equal === 2) return next;
    previous = next;
  }
  assert.fail('the Hook state did not settle');
}
// One user action, and everything of the Hook state that it moved.
async function act(page, action) {
  const before = await settledState(page);
  await action();
  await frames(page);
  const after = await settledState(page);
  return { moved: changed(before.state, after.state), nativeCalls: after.nativeCalls - before.nativeCalls, requests: after.requests - before.requests };
}

// The switch of the Configurations row with this label, and one option of a labelled selector.
const rowSwitch = (page, label) => page.locator('#configurations').getByText(new RegExp(`^${label}$`, 'i'))
  .locator('xpath=ancestor::div[./button[@role="switch"]][1]/button[@role="switch"]');
const crossChecksSwitch = page => rowSwitch(page, 'Runtime Cross-checks');
const option = (page, scope, label, name) => page.locator(scope).locator('label', { hasText: new RegExp(`^${label}$`, 'i') })
  .locator('xpath=..').getByRole('button', { name, exact: true });
const clean = async (page, failures) => {
  assert.deepEqual(failures, [], 'no page error and no uncontrolled network');
  assert.deepEqual(await page.evaluate(() => window.__pc.unexpected), [], 'no uncontrolled native command or fetch');
};

// Tasks 145/183 NDI: the Native Stall Diagnostics row of the Debug group as it is drawn, next to what the Hook exports,
// what it returned in each render, what reached the native command and what each recording's timeline received.
const diagnostics = page => page.evaluate(() => {
  const line = element => element.textContent.replace(/\s+/g, ' ').trim();
  const timelines = {};
  for (const call of window.__pc.calls) {
    if (call.name !== 'write_meeting_session_recording_text' || call.args.relativePath !== 'timeline.jsonl') continue;
    for (const text of String(call.args.payload).split('\n').filter(Boolean)) {
      const event = JSON.parse(text);
      if (event.kind !== 'capture-lifecycle' || !String(event.metadata?.stage).startsWith('native-stall-diagnostics')) continue;
      (timelines[call.args.folderName] ??= []).push({ sessionId: event.sessionId, ...event.metadata });
    }
  }
  const label = [...document.querySelectorAll('#configurations div')].find(element => element.children.length === 0 && line(element) === 'Native Stall Diagnostics');
  const row = label.parentElement.parentElement;
  const block = row.nextElementSibling;
  const lines = block && block.firstElementChild && line(block.firstElementChild).startsWith('Status: ') ? [...block.children] : [];
  const recording = window.__pc.meeting.sessionRecording;
  return {
    caption: line(label.nextElementSibling),
    checked: row.querySelector('button[role="switch"]').getAttribute('aria-checked'),
    lines: lines.map(line),
    red: lines.map(element => element.className.split(/\s+/).includes('text-red-600')),
    controls: lines.length ? block.querySelectorAll('button,a,input,select,textarea,[role="button"]').length : -1,
    exported: JSON.parse(JSON.stringify(window.__pc.meeting.nativeStallDiagnostics)),
    recording: { active: recording.active, lifecycle: recording.lifecycle, folderName: recording.folderName ?? null, folderPath: recording.folderPath ?? null,
      sessionId: recording.sessionId ?? null },
    renders: (window.__pc.nativeStallRenders ?? []).slice(),
    timelines,
    commands: window.__pc.calls.filter(call => call.name === 'set_native_stall_diagnostics').map(call => call.args),
    held: (window.__pc.nativeStallHeld ?? []).map(request => request.args),
    recordingStarts: window.__pc.calls.filter(call => call.name === 'start_meeting_session_recording').length,
    requests: window.__pc.requests.length,
  };
});

// One interviewer turn through the real runtime, and what Meeting Metadata did with it. The run is
// left open: stopping it starts a new session, which would discard a company set for this one.
async function runOpeningTurn(page) {
  const started = await page.evaluate(() => window.__pc.meeting.startRuntimeRegressionRun());
  assert.equal(started, true, JSON.stringify(await page.evaluate(() => ({ error: window.__pc.meeting.error, unexpected: window.__pc.unexpected }))));
  await page.evaluate(text => window.__pc.meeting.submitRuntimeRegressionText(text), OPENING);
  await page.waitForFunction(() => window.__pc.meeting.traces.some(trace => {
    const disposition = trace.metadata?.meetingMetadataInferenceDisposition;
    return typeof disposition === 'string' && disposition !== 'scheduled';
  }), undefined, { timeout: 15000 });
  // Nothing further is in flight: a late request or commit would still move the state or the counters.
  await settledState(page);
  return page.evaluate(() => {
    const fields = ['meetingMetadataInferenceMode', 'meetingMetadataInferenceDisposition', 'meetingMetadataInferenceSkipReason',
      'meetingMetadataInferenceObservationTrigger', 'meetingMetadataInferenceAppliedToRuntime'];
    const traces = window.__pc.meeting.traces.filter(trace => trace.metadata?.meetingMetadataInferenceDisposition)
      .map(trace => Object.fromEntries(fields.filter(field => trace.metadata[field] !== undefined)
        .map(field => [field.replace('meetingMetadataInference', ''), trace.metadata[field]])));
    const company = window.__pc.meeting.interviewSessionContext?.targetCompany;
    return { traces, metadataRequests: window.__pc.requests.filter(request => request.operation === 'meeting-metadata').length,
      sessionCompany: company ? { value: company.value, source: company.source } : null,
      brief: JSON.parse(JSON.stringify(window.__pc.meeting.interviewSessionBrief ?? null)), error: window.__pc.meeting.error };
  });
}

// ---- Task 178 LG: the Log Level selector, mounted ----
// The Log Level block of the Debug group as it is drawn, next to what the Hook exports, what it returned in each
// render and what reached the native command.
const logLevel = page => page.evaluate(SETTINGS => {
  const line = element => element.textContent.replace(/\s+/g, ' ').trim();
  const labels = [...document.querySelectorAll('#configurations label')].filter(element => line(element) === 'Log Level');
  const grid = labels[0].parentElement;
  const block = grid.parentElement;
  const buttons = [...grid.querySelectorAll('button')];
  const rows = [...block.children];
  const status = rows.slice(2);
  // The group this block belongs to, by its title row.
  const group = block.parentElement.parentElement;
  return {
    selectors: labels.length,
    group: line(group.firstElementChild),
    previous: line(block.previousElementSibling),
    options: buttons.map(button => button.textContent.trim()),
    selected: buttons.filter(button => button.className.split(/\s+/).includes('bg-primary')).map(button => button.textContent.trim()),
    help: line(rows[1]),
    status: status.map(line),
    red: status.map(element => element.className.split(/\s+/).includes('text-red-600')),
    controls: status.reduce((count, element) => count + element.querySelectorAll('button,a,input,select,textarea,[role="button"]').length, 0),
    exported: JSON.parse(JSON.stringify(window.__pc.meeting.diagnosticLogLevelStatus)),
    setting: window.__pc.meeting.settings.diagnosticLogLevel,
    debugMode: window.__pc.meeting.settings.debugMode,
    stored: localStorage.getItem(SETTINGS),
    // The applies: the calls with an empty batch. Since commit 3 the command also carries the entries of the migrated
    // call sites; they are listed on their own, each with the level of its call.
    commands: window.__pc.calls.filter(call => call.name === 'write_diagnostic_log' && (call.args.entries ?? []).length === 0).map(call => call.args),
    entries: window.__pc.calls.filter(call => call.name === 'write_diagnostic_log').flatMap(call => (call.args.entries ?? [])
      .map(entry => [call.args.level, entry.level, entry.source, entry.event, entry.data ?? null])),
    held: (window.__pc.diagnosticLogHeld ?? []).map(request => request.args),
    renders: (window.__pc.diagnosticLogRenders ?? []).slice(),
    requests: window.__pc.requests.length,
  };
}, SETTINGS);

test('PC1 and PC7: Preview controls and the Meeting Metadata selector with the real Hook in a real browser', { timeout: 180000, skip: browserTestSkip }, async t => {
  const browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.JARVIS_CHROMIUM_EXECUTABLE });
  try {
    const bundle = await panelsBundle();
    const scenario = (name, seed, body) => t.test(name, async () => {
      const host = await openPanels(browser, bundle, seed);
      try {
        await body(host.page, host);
        await clean(host.page, host.failures);
      } finally { await host.context.close(); }
    });

    await scenario('PC1 a fresh store: Preview is a group with one switch and one selector; a real click on Runtime Cross-checks is saved and read back after reloads', {}, async (page, host) => {
      let view = await shown(page);
      assert.deepEqual(view.groups, ['Response', 'Context', 'Audio', 'Preview', 'Debug']);
      assert.equal(view.previewTitleControls, 0, 'the group title holds no control: Preview is not a switch');
      assert.deepEqual(view.previewSwitches, [{ checked: 'false', disabled: false }]);
      assert.deepEqual(view.previewButtons, ['Enforcement', 'Shadow']);
      assert.equal(view.previewOtherControls, 0);
      assert.deepEqual(view.factRisk, { count: 1, options: ['Enforcement', 'Shadow'], selected: ['Enforcement'] });
      assert.equal(view.metadataInConfigurations, 0, 'Meeting Metadata is no longer in Configurations');
      assert.deepEqual(view.metadata, { count: 1, options: ['Enforcement', 'Shadow'], selected: ['Shadow'] });
      assert.deepEqual(view.offNotes, []);
      assert.equal(view.offOptions, 0);
      assert.equal(view.retired, false);
      assert.equal(view.settings.runtimeCrossChecksEnabled, false, 'the default is off');
      assert.equal(view.stored, null, 'mounting writes nothing');
      assert.equal(await crossChecksSwitch(page).count(), 1);

      const on = await act(page, () => crossChecksSwitch(page).click());
      assert.deepEqual(on, { moved: ['settings.runtimeCrossChecksEnabled: false -> true'], nativeCalls: 0, requests: 0 });
      view = await shown(page);
      assert.equal(view.previewSwitches[0].checked, 'true');
      assert.deepEqual(JSON.parse(view.stored), view.settings);
      const saved = view.stored;

      await host.reload();
      view = await shown(page);
      assert.equal(view.previewSwitches[0].checked, 'true');
      assert.equal(view.settings.runtimeCrossChecksEnabled, true);
      assert.equal(view.stored, saved, 'reloading reads the saved value and writes nothing');

      const off = await act(page, () => crossChecksSwitch(page).click());
      assert.deepEqual(off, { moved: ['settings.runtimeCrossChecksEnabled: true -> false'], nativeCalls: 0, requests: 0 });
      await host.reload();
      view = await shown(page);
      assert.equal(view.previewSwitches[0].checked, 'false');
      assert.equal(JSON.parse(view.stored).runtimeCrossChecksEnabled, false);
    });

    await scenario('PC1 Fact Risk Review writes exactly the existing guardrail mode, adds no key and reads back after a reload', {}, async (page, host) => {
      const shadow = await act(page, () => option(page, '#configurations', 'Fact Risk Review', 'Shadow').click());
      assert.deepEqual(shadow, { moved: ['settings.personalEvidenceGuardrailMode: "enforcement" -> "shadow"'], nativeCalls: 0, requests: 0 });
      let view = await shown(page);
      assert.deepEqual(view.factRisk.selected, ['Shadow']);
      assert.equal(JSON.parse(view.stored).personalEvidenceGuardrailMode, 'shadow');
      await host.reload();
      view = await shown(page);
      assert.deepEqual(view.factRisk.selected, ['Shadow']);
      assert.equal(view.settings.personalEvidenceGuardrailMode, 'shadow');
      const enforcement = await act(page, () => option(page, '#configurations', 'Fact Risk Review', 'Enforcement').click());
      assert.deepEqual(enforcement.moved, ['settings.personalEvidenceGuardrailMode: "shadow" -> "enforcement"']);
      view = await shown(page);
      assert.deepEqual(view.factRisk.selected, ['Enforcement']);
      assert.deepEqual(Object.keys(JSON.parse(view.stored)).sort(), ['activeScreenTaskTimeoutMinutes', 'audio', 'codingModel', 'debugMode',
        'diagnosticLogLevel', 'microphoneContextEnabled', 'nativeStallDiagnosticsEnabled', 'personalEvidenceGuardrailMode', 'response',
        'runtimeCrossChecksEnabled', 'taxonomyAdjudication', 'useMemory'],
        'the saved settings hold the keys they held before this commit, and diagnosticLogLevel, which Task 178 LG added later');
    });

    const storedBrief = { targetCompany: 'Oracle', companyLocked: true, interviewTypes: ['coding'], updatedAt: 5 };
    await scenario('PC1 and PC7 Meeting Metadata in the Brief panel moves only settings.taxonomyAdjudication; the Brief, its storage and the session context stay; Brief edits and Clear leave the mode', {
      [SETTINGS]: { taxonomyAdjudication: { provider: 'pc', variables: {}, meetingMetadataMode: 'shadow' } }, [BRIEF]: storedBrief }, async (page, host) => {
      const before = await shown(page);
      assert.deepEqual(before.metadata.selected, ['Shadow']);
      assert.equal(before.companyInput, 'Oracle');
      const picked = await act(page, () => option(page, '#brief', 'Meeting Metadata', 'Enforcement').click());
      assert.deepEqual(picked, { moved: ['settings.taxonomyAdjudication.meetingMetadataMode: "shadow" -> "enforcement"'], nativeCalls: 0, requests: 0 },
        'no Brief, context, Preparation or task state moved, and nothing was requested');
      let view = await shown(page);
      assert.deepEqual(view.metadata.selected, ['Enforcement']);
      assert.deepEqual(JSON.parse(view.stored).taxonomyAdjudication, { enabled: true, questionTypeMode: 'enforcement', taskRelationMode: 'shadow',
        meetingMetadataMode: 'enforcement', provider: 'pc', variables: {} });
      assert.equal(view.storedBrief, before.storedBrief, 'the stored Brief is byte-identical');
      assert.equal(view.companyInput, 'Oracle');
      assert.equal(view.briefTitle, before.briefTitle);
      await host.reload();
      view = await shown(page);
      assert.deepEqual(view.metadata.selected, ['Enforcement']);
      assert.equal(view.storedBrief, before.storedBrief);
      assert.equal(view.companyInput, 'Oracle');

      // The Brief's own controls write the Brief and never the mode.
      const settingsBefore = view.stored;
      await page.locator('#brief input[placeholder]').fill('Anthropic');
      await page.waitForFunction(key => JSON.parse(localStorage.getItem(key) ?? '{}').targetCompany === 'Anthropic', BRIEF);
      await page.locator('#brief').getByRole('button', { name: 'Clear', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#brief input[placeholder]').value === '');
      view = await shown(page);
      assert.equal(view.stored, settingsBefore, 'a Brief edit and Clear leave the settings untouched');
      assert.deepEqual(view.metadata.selected, ['Enforcement'], 'Clear does not reset the mode');
    });

    await scenario('PC1 a stored legacy Metadata off shows neither option and one note, survives unrelated saves and a reload, and the first pick writes that mode', {
      [SETTINGS]: { taxonomyAdjudication: { provider: 'pc', variables: {}, meetingMetadataMode: 'off' } } }, async (page, host) => {
      let view = await shown(page);
      assert.deepEqual(view.metadata, { count: 1, options: ['Enforcement', 'Shadow'], selected: [] }, 'neither option is selected and Off is not offered');
      assert.deepEqual(view.offNotes, [OFF_NOTE]);
      assert.equal(view.offOptions, 0);
      assert.equal(view.settings.taxonomyAdjudication.meetingMetadataMode, 'off');
      const seeded = view.stored;

      if (process.env.JARVIS_VISUAL_EVIDENCE_DIR) {
        const css = readdirSync('dist/assets').find(name => name.startsWith('index-') && name.endsWith('.css'));
        assert.ok(css, 'run npm run build first: the built stylesheet is needed for the layout check');
        // Measured at rest: a header chevron that is still rotating briefly reaches outside its box.
        await page.addStyleTag({ content: readFileSync(`dist/assets/${css}`, 'utf8') +
          '\n*,*::before,*::after{transition:none!important;animation:none!important}' });
        for (const width of [440, 860]) {
          await page.setViewportSize({ width, height: 2400 });
          await frames(page);
          const layout = await page.evaluate(() => {
            const note = [...document.querySelectorAll('#brief div')].find(element => element.children.length === 0 && element.textContent.trim().startsWith('Stored mode is Off'));
            const range = document.createRange();
            range.selectNodeContents(note);
            const panels = document.querySelector('#panels');
            return { noteLines: new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size,
              overflowing: [...panels.querySelectorAll('*')].filter(element => element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX === 'visible')
                .map(element => `${element.tagName.toLowerCase()} "${element.textContent.trim().slice(0, 40)}" ${element.scrollWidth}>${element.clientWidth} [${String(element.className).slice(0, 80)}]`) };
          });
          assert.deepEqual(layout, { noteLines: 1, overflowing: [] }, `the legacy note is one line and nothing overflows at ${width}px`);
          await page.locator('#brief').screenshot({ path: `${process.env.JARVIS_VISUAL_EVIDENCE_DIR}/pc-c3-brief-legacy-off-${width}.png` });
          await page.locator('#configurations').screenshot({ path: `${process.env.JARVIS_VISUAL_EVIDENCE_DIR}/pc-c3-configurations-${width}.png` });
        }
      }
      assert.equal((await shown(page)).stored, seeded, 'rendering does not rewrite the stored off');

      // Unrelated saves, one of them to the same owner object from the other panel.
      await act(page, () => crossChecksSwitch(page).click());
      await act(page, () => option(page, '#configurations', 'Fact Risk Review', 'Shadow').click());
      const models = page.locator('#configurations select');
      assert.equal(await models.count(), 2, 'the coding and Fast Runtime model selectors');
      const cleared = await act(page, () => models.nth(1).selectOption(''));
      assert.deepEqual(cleared.moved, ['settings.taxonomyAdjudication.provider: "pc" -> ""']);
      view = await shown(page);
      assert.equal(JSON.parse(view.stored).taxonomyAdjudication.meetingMetadataMode, 'off', 'the backend keeps honouring off');
      assert.deepEqual(view.metadata.selected, []);
      assert.deepEqual(view.offNotes, [OFF_NOTE]);
      await host.reload();
      view = await shown(page);
      assert.equal(view.settings.taxonomyAdjudication.meetingMetadataMode, 'off');
      assert.deepEqual([view.metadata.selected, view.offNotes], [[], [OFF_NOTE]]);
      assert.deepEqual([view.settings.runtimeCrossChecksEnabled, view.settings.personalEvidenceGuardrailMode], [true, 'shadow']);

      const picked = await act(page, () => option(page, '#brief', 'Meeting Metadata', 'Shadow').click());
      assert.deepEqual(picked, { moved: ['settings.taxonomyAdjudication.meetingMetadataMode: "off" -> "shadow"'], nativeCalls: 0, requests: 0 });
      view = await shown(page);
      assert.deepEqual([view.metadata.selected, view.offNotes], [['Shadow'], []]);
      await host.reload();
      view = await shown(page);
      assert.deepEqual([view.metadata.selected, view.offNotes], [['Shadow'], []]);
      assert.equal(JSON.parse(view.stored).taxonomyAdjudication.meetingMetadataMode, 'shadow');
    });

    // Stores written before this slice, and stores holding values the controls do not offer.
    const olderStores = [
      ['Debug on, the retired semantic mode, no newer key', { debugMode: true, semanticTaxonomyMode: 'enforcement', useMemory: false },
        { crossChecks: 'false', factRisk: ['Enforcement'], metadata: ['Shadow'] }],
      ['values of the wrong type or outside the two modes', { debugMode: true, runtimeCrossChecksEnabled: 'true', personalEvidenceGuardrailMode: 'off',
        taxonomyAdjudication: { meetingMetadataMode: 'garbage' } }, { crossChecks: 'false', factRisk: ['Enforcement'], metadata: ['Shadow'] }],
      ['all three controls away from their defaults', { runtimeCrossChecksEnabled: true, personalEvidenceGuardrailMode: 'shadow',
        taxonomyAdjudication: { meetingMetadataMode: 'enforcement' } }, { crossChecks: 'true', factRisk: ['Shadow'], metadata: ['Enforcement'] }],
      ['an unreadable store', '{broken', { crossChecks: 'false', factRisk: ['Enforcement'], metadata: ['Shadow'] }],
    ];
    for (const [name, store, expected] of olderStores) {
      const raw = typeof store === 'string' ? store : JSON.stringify(store);
      await scenario(`PC1 an older store (${name}) loads without a migration write and shows truthfully`, { [SETTINGS]: raw }, async (page, host) => {
        const display = view => ({ crossChecks: view.previewSwitches[0].checked, factRisk: view.factRisk.selected, metadata: view.metadata.selected });
        let view = await shown(page);
        assert.deepEqual(display(view), expected);
        assert.equal(view.settings.runtimeCrossChecksEnabled, expected.crossChecks === 'true', 'never derived from Debug or the retired mode');
        assert.equal(view.stored, raw, 'loading and rendering write nothing');
        // An unrelated save, then a reload: the same display, and the retired key is gone.
        const debugBefore = view.settings.debugMode;
        const memory = await act(page, () => rowSwitch(page, 'Use Memory').click());
        assert.equal(memory.moved.length, 1, JSON.stringify(memory.moved));
        assert.match(memory.moved[0], /^settings\.useMemory: /);
        await host.reload();
        view = await shown(page);
        assert.deepEqual(display(view), expected);
        assert.equal(view.settings.debugMode, debugBefore);
        assert.equal('semanticTaxonomyMode' in JSON.parse(view.stored), false);
        assert.equal(JSON.parse(view.stored).runtimeCrossChecksEnabled, expected.crossChecks === 'true');
      });
    }

    // The help text, checked against one real interviewer turn. Replay Lab needs Debug in a development build.
    const runtime = { debugMode: true, microphoneContextEnabled: false };
    const enteredBrief = { targetCompany: 'Oracle', companyLocked: false, interviewTypes: [], updatedAt: 9 };
    const turns = [
      ['Enforcement with no company sets the session company and leaves the Brief field empty', { [SETTINGS]: runtime },
        async page => { await act(page, () => option(page, '#brief', 'Meeting Metadata', 'Enforcement').click()); },
        { traces: [{ Mode: 'enforcement', Disposition: 'enforcement-committed', AppliedToRuntime: true }], metadataRequests: 1,
          sessionCompany: { value: 'Stripe', source: 'runtime-inference' } }, ''],
      ['Shadow with no company makes the same request and only records', { [SETTINGS]: runtime }, async () => undefined,
        { traces: [{ Mode: 'shadow', Disposition: 'shadow-observed', AppliedToRuntime: false }], metadataRequests: 1, sessionCompany: null }, ''],
      ['a stored off makes no request', { [SETTINGS]: { ...runtime, taxonomyAdjudication: { meetingMetadataMode: 'off' } } }, async () => undefined,
        { traces: [{ Mode: 'off', Disposition: 'operation-disabled', SkipReason: 'runtime-inference-disabled', AppliedToRuntime: false }],
          metadataRequests: 0, sessionCompany: null }, ''],
      ['picking a mode from a stored off makes the request again', { [SETTINGS]: { ...runtime, taxonomyAdjudication: { meetingMetadataMode: 'off' } } },
        async page => { await act(page, () => option(page, '#brief', 'Meeting Metadata', 'Shadow').click()); },
        { traces: [{ Mode: 'shadow', Disposition: 'shadow-observed', AppliedToRuntime: false }], metadataRequests: 1, sessionCompany: null }, ''],
      ['Enforcement with a company already set and Cross-checks off makes no request and keeps the company', { [SETTINGS]: runtime, [BRIEF]: enteredBrief },
        async page => { await act(page, () => option(page, '#brief', 'Meeting Metadata', 'Enforcement').click()); },
        { traces: [{ Mode: 'enforcement', Disposition: 'authoritative-observation-disabled', SkipReason: 'runtime-cross-checks-off', AppliedToRuntime: false }],
          metadataRequests: 0, sessionCompany: { value: 'Oracle', source: 'brief' } }, 'Oracle'],
      ['the Runtime Cross-checks switch admits the extra Metadata comparison, which still keeps the company', { [SETTINGS]: runtime, [BRIEF]: enteredBrief },
        async page => {
          await act(page, () => option(page, '#brief', 'Meeting Metadata', 'Enforcement').click());
          await act(page, () => crossChecksSwitch(page).click());
        },
        { traces: [{ Mode: 'enforcement', Disposition: 'shadow-observed', ObservationTrigger: 'runtime-cross-checks', AppliedToRuntime: false }],
          metadataRequests: 1, sessionCompany: { value: 'Oracle', source: 'brief' } }, 'Oracle'],
    ];
    for (const [name, seed, choose, expected, companyField] of turns) {
      await scenario(`PC7 ${name}`, seed, async page => {
        await choose(page);
        const before = await shown(page);
        const briefBefore = await page.evaluate(() => JSON.parse(JSON.stringify(window.__pc.meeting.interviewSessionBrief ?? null)));
        const { brief, error, ...observed } = await runOpeningTurn(page);
        assert.equal(error, null);
        assert.deepEqual(observed, expected);
        // Whatever the mode did, the Brief the user entered is where it was: state, storage and the field.
        // Read while the session that holds the company is still running.
        assert.deepEqual(brief, briefBefore, 'the Brief held by the Hook is unchanged');
        const after = await shown(page);
        const sessionCompanyNow = await page.evaluate(() => window.__pc.meeting.interviewSessionContext?.targetCompany?.value ?? null);
        assert.equal(sessionCompanyNow, expected.sessionCompany?.value ?? null, 'the session still holds what the turn left');
        assert.equal(after.storedBrief, before.storedBrief, 'the stored Brief is unchanged');
        assert.equal(after.companyInput, companyField, 'the Target company field is not edited');
        assert.equal(after.briefTitle, before.briefTitle);
        assert.deepEqual(after.metadata.selected, before.metadata.selected);
        await page.evaluate(() => window.__pc.meeting.stopRuntimeRegressionRun());
      });
    }

    // Tasks 145/183 NDI. Real: the Hook's arming effect, its serial queue and receipt, the recording manager, the
    // panel and its switches. Controlled: the native command, which answers an arm only when the scenario lets it,
    // and the recording folder path, which is one per recording here.
    await scenario('NDI1, NDI2 and NDI6 Native Stall Diagnostics: the status line follows the native reply through off, waiting, arming, armed, a recording change in one commit, Stop, switch-off, failed and a late reply', {}, async page => {
      const CAPTION = 'Arms only while Session Recording is active. The setting is saved: once on, each later recording re-arms from it.';
      const OFF = 'Status: switch off.';
      const WAITING = 'Status: waiting for a recording. Arming is requested when one starts.';
      const ARMING = 'Status: arming requested for this recording, waiting for the native reply.';
      const RUN_A = 'f3b1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
      const RUN_B = '0a9b8c7d-6e5f-4d3c-8b1a-f0e9d8c7b6a5';
      const RUN_C = '7c6d5e4f-3a2b-4c1d-9e8f-a7b6c5d4e3f2';
      const RUN_D = '1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a';
      const FAILURE = 'Cannot create diagnostics directory: Permission denied (os error 13)';
      const disarm = { enabled: false, folderName: null };
      const armedLine = runId => `Status: armed for this recording, run ${runId}. Armed means only that the native observer started.`;
      const evidencePath = recording => `/pc-ndi/${recording.folderName}/diagnostics/native-stall`;
      const disarmsOnly = commands => commands.length >= 1 && commands.every(args => args.enabled === false && args.folderName === null);
      // With JARVIS_VISUAL_EVIDENCE_DIR set and a build present: the row is drawn with the built stylesheet, nothing may
      // overflow the panel, and a picture of the Debug group is kept.
      let styled = false;
      const picture = async name => {
        if (!process.env.JARVIS_VISUAL_EVIDENCE_DIR) return;
        if (!styled) {
          const css = readdirSync('dist/assets').find(file => file.startsWith('index-') && file.endsWith('.css'));
          assert.ok(css, 'run npm run build first: the built stylesheet is needed for the layout check');
          await page.addStyleTag({ content: readFileSync(`dist/assets/${css}`, 'utf8') +
            '\n*,*::before,*::after{transition:none!important;animation:none!important}' });
          styled = true;
        }
        for (const width of [440, 860]) {
          await page.setViewportSize({ width, height: 2400 });
          await frames(page);
          const overflowing = await page.evaluate(() => [...document.querySelector('#configurations').querySelectorAll('*')]
            .filter(element => element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX === 'visible')
            .map(element => `${element.tagName.toLowerCase()} "${element.textContent.trim().slice(0, 40)}" ${element.scrollWidth}>${element.clientWidth}`));
          assert.deepEqual(overflowing, [], `nothing overflows at ${width}px (${name})`);
          const group = page.locator('#configurations').getByText(/^Native Stall Diagnostics$/i).locator('xpath=ancestor::div[./div[1][normalize-space()="Debug"]][1]');
          await group.screenshot({ path: `${process.env.JARVIS_VISUAL_EVIDENCE_DIR}/ndi-debug-group-${name}-${width}.png` });
        }
      };
      await page.evaluate(() => {
        const pc = window.__pc;
        pc.nativeStallHeld = [];
        pc.nativeStallDiagnostics = args => args.enabled ? new Promise((resolve, reject) => pc.nativeStallHeld.push({ args, resolve, reject })) : null;
        // One folder path per recording, so a path on screen names exactly one recording.
        pc.recordingFolderPath = args => '/pc-ndi/' + args.folderName;
        // Every render of the Hook's owner: the recording it holds and the projection the Hook returns. A frame that
        // is replaced before the browser paints it is still listed here.
        pc.nativeStallRenders = [];
        let meeting = pc.meeting;
        Object.defineProperty(pc, 'meeting', { configurable: true, get: () => meeting, set: value => {
          meeting = value;
          const recording = value.sessionRecording;
          const shown = value.nativeStallDiagnostics;
          const entry = [recording.active ? recording.folderName : null, shown.phase, shown.runId ?? null, shown.evidencePath ?? null];
          if (JSON.stringify(pc.nativeStallRenders.at(-1)) !== JSON.stringify(entry)) pc.nativeStallRenders.push(entry);
        } });
      });
      const answer = (kind, value) => page.evaluate(([kind, value]) => window.__pc.nativeStallHeld.shift()[kind](value), [kind, value]);
      const phase = name => page.waitForFunction(name => window.__pc.meeting.nativeStallDiagnostics.phase === name, name, { timeout: 15000 });
      const idle = () => page.waitForFunction(() => !window.__pc.meeting.sessionRecording.active && window.__pc.meeting.sessionRecording.lifecycle === 'idle', undefined, { timeout: 15000 });
      const armRequest = () => page.waitForFunction(() => window.__pc.nativeStallHeld.length === 1, undefined, { timeout: 15000 });
      const recordingSwitch = rowSwitch(page, 'Session Recording');
      const diagnosticsSwitch = rowSwitch(page, 'Native Stall Diagnostics');
      assert.deepEqual([await recordingSwitch.count(), await diagnosticsSwitch.count()], [1, 1]);

      // off: mounting sent one disarm. Debug Mode and Runtime Cross-checks are both off and the row is there.
      let view = await diagnostics(page);
      assert.equal(view.caption, CAPTION);
      assert.deepEqual([view.checked, view.lines, view.exported], ['false', [OFF], { phase: 'off' }]);
      assert.deepEqual(view.commands, [disarm]);
      const settings = await page.evaluate(() => window.__pc.meeting.settings);
      assert.deepEqual([settings.debugMode, settings.runtimeCrossChecksEnabled, settings.nativeStallDiagnosticsEnabled], [false, false, false]);

      // waiting: the switch is on and shows intent; nothing is armed and nothing else started.
      const on = await act(page, () => diagnosticsSwitch.click());
      assert.deepEqual(on.moved.sort(), ['nativeStallDiagnostics.phase: "off" -> "waiting-for-recording"', 'settings.nativeStallDiagnosticsEnabled: false -> true'],
        'the switch moved its setting and the projection, and nothing else the Hook exports');
      assert.deepEqual([on.nativeCalls, on.requests], [1, 0]);
      view = await diagnostics(page);
      assert.deepEqual([view.checked, view.lines, view.exported], ['true', [WAITING], { phase: 'waiting-for-recording' }]);
      assert.deepEqual(view.commands, [disarm, disarm], 'no arm request without a recording');
      assert.deepEqual([view.recordingStarts, view.recording.active, view.requests, view.held.length], [0, false, 0, 0]);
      const stored = JSON.parse(await page.evaluate(key => localStorage.getItem(key), SETTINGS));
      assert.equal(stored.nativeStallDiagnosticsEnabled, true, 'the setting is saved');
      assert.deepEqual(Object.keys(stored).sort(), ['activeScreenTaskTimeoutMinutes', 'audio', 'codingModel', 'debugMode', 'diagnosticLogLevel',
        'microphoneContextEnabled', 'nativeStallDiagnosticsEnabled', 'personalEvidenceGuardrailMode', 'response', 'runtimeCrossChecksEnabled',
        'taxonomyAdjudication', 'useMemory']);

      // arming: recording A is active, the arm request is with native, and it is not shown as armed.
      await recordingSwitch.click();
      await armRequest();
      await frames(page);
      view = await diagnostics(page);
      const first = view.recording;
      assert.deepEqual([first.active, first.folderPath, view.recordingStarts], [true, `/pc-ndi/${first.folderName}`, 1]);
      assert.deepEqual(view.held, [{ enabled: true, folderName: first.folderName }], 'the arm request names the current recording folder');
      assert.deepEqual([view.lines, view.exported], [[ARMING], { phase: 'arming' }]);

      // armed: only after the native reply, with its run id and the path derived from the recording folder.
      await answer('resolve', RUN_A);
      await phase('armed');
      await frames(page);
      view = await diagnostics(page);
      assert.deepEqual(view.lines, [armedLine(RUN_A), `Evidence folder for this recording (may be empty): ${evidencePath(first)}`]);
      assert.deepEqual(view.exported, { phase: 'armed', runId: RUN_A, evidencePath: evidencePath(first), evidenceOwner: 'current-recording' });
      assert.deepEqual([view.red, view.controls], [[false, false], 0], 'plain text: no button, link or input');
      await picture('armed');

      // Debug Mode and Runtime Cross-checks, each switched on and off while armed (this bundle is a DEV build): the
      // two lines stay as they are and no diagnostics request is sent.
      const armed = await diagnostics(page);
      const cells = [];
      for (const label of ['Debug Mode', 'Runtime Cross-checks', 'Debug Mode', 'Runtime Cross-checks']) {
        await act(page, () => rowSwitch(page, label).click());
        const now = await diagnostics(page);
        assert.deepEqual([now.lines, now.red, now.exported, now.commands, now.checked], [armed.lines, armed.red, armed.exported, armed.commands, 'true'], `after ${label}`);
        cells.push(await page.evaluate(() => [window.__pc.meeting.settings.debugMode, window.__pc.meeting.settings.runtimeCrossChecksEnabled]));
      }
      assert.deepEqual(cells, [[true, false], [true, true], [false, true], [false, false]]);

      // Stop A and Start B in one tick. The fixture's native boundary answers in microtasks, so React renders the
      // change as one commit: recording B is current while the receipt in state is still A's armed one.
      await page.evaluate(() => { const meeting = window.__pc.meeting; meeting.setSessionRecordingEnabled(false); meeting.setSessionRecordingEnabled(true); });
      await armRequest();
      await frames(page);
      view = await diagnostics(page);
      const second = view.recording;
      assert.notEqual(second.folderName, first.folderName);
      assert.deepEqual([second.active, second.folderPath, view.recordingStarts], [true, `/pc-ndi/${second.folderName}`, 2]);
      assert.deepEqual(view.held, [{ enabled: true, folderName: second.folderName }]);
      assert.deepEqual([view.lines, view.exported], [[ARMING], { phase: 'arming' }]);
      const lastOfFirst = view.renders.findLastIndex(entry => entry[0] === first.folderName);
      assert.deepEqual(view.renders.slice(lastOfFirst), [[first.folderName, 'armed', RUN_A, evidencePath(first)], [second.folderName, 'arming', null, null]],
        'no render between the two recordings, and B is arming from its first render');
      const between = view.commands.slice(armed.commands.length, -1);
      assert.deepEqual(view.commands.at(-1), { enabled: true, folderName: second.folderName });
      assert.ok(disarmsOnly(between), 'between the two arm requests: disarms only');
      // The disarm of that commit was issued while the manager already held B: it is B's disarm, with nothing of A.
      assert.deepEqual((view.timelines[second.folderName] ?? []).map(entry => [entry.stage, entry.enabled, entry.runId, entry.folderName, entry.recordingSessionId, entry.sessionId]),
        between.map(() => ['native-stall-diagnostics', false, null, second.folderName, second.sessionId, second.sessionId]));
      await answer('resolve', RUN_B);
      await phase('armed');
      await frames(page);
      view = await diagnostics(page);
      assert.deepEqual(view.lines, [armedLine(RUN_B), `Evidence folder for this recording (may be empty): ${evidencePath(second)}`]);
      assert.deepEqual(view.exported, { phase: 'armed', runId: RUN_B, evidencePath: evidencePath(second), evidenceOwner: 'current-recording' });
      for (const entry of view.renders.filter(entry => entry[0] === second.folderName)) {
        assert.ok(entry[2] !== RUN_A && entry[3] !== evidencePath(first), `B was rendered with something of A: ${JSON.stringify(entry)}`);
      }
      // Each recording's timeline holds its own receipts only, each with its identity and request id.
      for (const [recording, runId] of [[first, RUN_A], [second, RUN_B]]) {
        const entries = view.timelines[recording.folderName];
        assert.ok(entries.every(entry => entry.folderName === recording.folderName && entry.recordingSessionId === recording.sessionId &&
          entry.sessionId === recording.sessionId && Number.isInteger(entry.requestId)), JSON.stringify(entries));
        assert.deepEqual(entries.filter(entry => entry.enabled).map(entry => [entry.stage, entry.runId]), [['native-stall-diagnostics', runId]]);
        assert.deepEqual(entries.map(entry => entry.requestId), entries.map(entry => entry.requestId).sort((left, right) => left - right));
      }

      // Stop: waiting again, and the folder named is that of B, the last armed recording.
      const beforeStop = view.commands.length;
      await recordingSwitch.click();
      await idle();
      await settledState(page);
      view = await diagnostics(page);
      assert.deepEqual(view.lines, [WAITING, `Evidence folder of the last armed recording (may be empty): ${evidencePath(second)}`]);
      assert.deepEqual(view.exported, { phase: 'waiting-for-recording', evidencePath: evidencePath(second), evidenceOwner: 'last-armed-recording' });
      await picture('stopped');
      assert.ok(disarmsOnly(view.commands.slice(beforeStop)), 'Stop sent disarms only');

      // The switch off, then on again with no recording: the last armed folder is forgotten, not hidden.
      await act(page, () => diagnosticsSwitch.click());
      view = await diagnostics(page);
      assert.deepEqual([view.checked, view.lines, view.exported], ['false', [OFF], { phase: 'off' }]);
      await picture('off');
      await act(page, () => diagnosticsSwitch.click());
      view = await diagnostics(page);
      assert.deepEqual([view.checked, view.lines, view.exported], ['true', [WAITING], { phase: 'waiting-for-recording' }]);
      await picture('waiting-after-off');
      assert.ok(disarmsOnly(view.commands.slice(beforeStop)));

      // failed: the next recording's arm request is rejected.
      await recordingSwitch.click();
      await armRequest();
      await frames(page);
      view = await diagnostics(page);
      const third = view.recording;
      assert.ok(third.folderName !== first.folderName && third.folderName !== second.folderName);
      assert.deepEqual(view.held, [{ enabled: true, folderName: third.folderName }]);
      assert.deepEqual([view.lines, view.exported], [[ARMING], { phase: 'arming' }]);
      await answer('reject', FAILURE);
      await phase('failed');
      await frames(page);
      view = await diagnostics(page);
      assert.deepEqual([view.lines, view.red], [[`Status: arming failed for this recording: ${FAILURE}`], [true]]);
      assert.deepEqual(view.exported, { phase: 'failed', message: FAILURE });
      await picture('failed');

      // off again, inside the recording.
      await act(page, () => diagnosticsSwitch.click());
      view = await diagnostics(page);
      assert.deepEqual([view.checked, view.lines, view.exported], ['false', [OFF], { phase: 'off' }]);

      // A late reply. C is asked to arm again; before native answers, Stop C and Start D happen in one tick. The
      // reply for C arrives while D is the writable recording: it is not D's state and it is not written to D.
      await diagnosticsSwitch.click();
      await armRequest();
      await settledState(page);
      view = await diagnostics(page);
      assert.deepEqual([view.held, view.exported], [[{ enabled: true, folderName: third.folderName }], { phase: 'arming' }]);
      await page.evaluate(() => { const meeting = window.__pc.meeting; meeting.setSessionRecordingEnabled(false); meeting.setSessionRecordingEnabled(true); });
      await page.waitForFunction(folderName => window.__pc.meeting.sessionRecording.active && window.__pc.meeting.sessionRecording.folderName !== folderName,
        third.folderName, { timeout: 15000 });
      await settledState(page);
      view = await diagnostics(page);
      const fourth = view.recording;
      assert.deepEqual(view.held, [{ enabled: true, folderName: third.folderName }], "still C's request: the queue is serial and nothing waited for it");
      assert.deepEqual([view.lines, view.exported], [[ARMING], { phase: 'arming' }]);
      const timelineOfThird = JSON.stringify(view.timelines[third.folderName]);
      await answer('resolve', RUN_C);
      await armRequest();
      await settledState(page);
      view = await diagnostics(page);
      assert.deepEqual(view.held, [{ enabled: true, folderName: fourth.folderName }], "D's own request reached native after C's was answered");
      assert.deepEqual([view.lines, view.exported], [[ARMING], { phase: 'arming' }], "C's reply did not arm D");
      assert.ok((view.timelines[fourth.folderName] ?? []).every(entry => entry.enabled === false && entry.runId === null && entry.folderName === fourth.folderName &&
        entry.recordingSessionId === fourth.sessionId), `C's reply was written to D: ${JSON.stringify(view.timelines[fourth.folderName])}`);
      assert.equal(JSON.stringify(view.timelines[third.folderName]), timelineOfThird, 'and C, sealed, was not written again');
      await answer('resolve', RUN_D);
      await phase('armed');
      await frames(page);
      view = await diagnostics(page);
      assert.deepEqual(view.lines, [armedLine(RUN_D), `Evidence folder for this recording (may be empty): ${evidencePath(fourth)}`]);
      assert.deepEqual(view.timelines[fourth.folderName].filter(entry => entry.enabled).map(entry => [entry.runId, entry.folderName, entry.recordingSessionId, entry.sessionId]),
        [[RUN_D, fourth.folderName, fourth.sessionId, fourth.sessionId]]);

      assert.deepEqual(view.commands.filter(args => args.enabled).map(args => args.folderName),
        [first.folderName, second.folderName, third.folderName, third.folderName, fourth.folderName], 'five arm requests in all, each naming the recording that was current');
      assert.equal(view.requests, 0, 'no provider request was made');
      for (const args of view.commands) assert.deepEqual(Object.keys(args), ['enabled', 'folderName']);
      // In no render was a recording shown as armed with another recording's run id or folder; C was never armed.
      const own = { [first.folderName]: [RUN_A, evidencePath(first)], [second.folderName]: [RUN_B, evidencePath(second)], [fourth.folderName]: [RUN_D, evidencePath(fourth)] };
      for (const entry of view.renders.filter(entry => entry[1] === 'armed')) assert.deepEqual(entry.slice(2), own[entry[0]], JSON.stringify(entry));
      assert.equal(view.renders.some(entry => entry[2] === RUN_C), false, 'the late run id was never rendered');
      t.diagnostic(`NDI mounted Hook; set_native_stall_diagnostics calls=${JSON.stringify(view.commands.map(args => args.enabled ? 'arm' : 'disarm'))}`);
      const names = { [first.folderName]: 'A', [second.folderName]: 'B', [third.folderName]: 'C', [fourth.folderName]: 'D', [RUN_A]: 'RUN_A', [RUN_B]: 'RUN_B', [RUN_D]: 'RUN_D' };
      t.diagnostic(`NDI renders=${JSON.stringify(view.renders.map(entry => [names[entry[0]] ?? entry[0], entry[1], names[entry[2]] ?? entry[2], entry[3] ? 'path' : null]))}`);
      await recordingSwitch.click();
      await page.waitForFunction(() => window.__pc.meeting.sessionRecording.lifecycle === 'idle', undefined, { timeout: 15000 });
    });

    // Task 178 LG: LG1, LG7 and the LG UI, through real clicks on the Log Level selector.
    await scenario('LG1, LG7 and LG UI: a real click on a level is saved at once and shown as requested, then applied or failed from the native reply; a reload applies it again', {}, async (page, host) => {
      const HELP = 'Sets the threshold of the diagnostic log: entries at this level and every more severe level go to the terminal and to ' +
        'local log files, which keep at most 50 MiB or 14 days. Errors and warnings cover failed Voice answers, capture, ' +
        'recording and saving failures and lost model results. Info adds capture start and stop, manual corrections and Brief ' +
        'updates. Debug and Trace add operation summaries and every trace and step change. No entry holds transcript, prompt or ' +
        'answer text. Debug Mode alone no longer prints trace lines: they are Debug and Trace entries of this log. Saved ' +
        'separately from Debug Mode. Log Level does not control Preparation, the focus window, shutdown messages, other console ' +
        'and native prints, Session Recording or Native Stall Diagnostics files, and starts no model request, sampler or ' +
        'capture.';
      const pending = level => `Status: ${level} requested, waiting for the native reply. Not yet confirmed on native.`;
      const applied = (level, sink = 'ready') => `Status: native applied ${level}. Log sink at that time: ${sink}.`;
      const failed = (level, message) => `Status: native did not confirm ${level}. Select ${level} again to retry. Reason: ${message}`;
      const apply = level => ({ level, entries: [] });
      const receipt = (level, state = 'ready') => ({ v: 1, appliedLevel: level, accepted: 0, filtered: 0, rejected: 0, dropped: 0,
        sink: { state, droppedTotal: 0, writeFailures: 0, unsavedAtExit: 0 } });
      const phase = name => page.waitForFunction(name => window.__pc.meeting.diagnosticLogLevelStatus.phase === name, name, { timeout: 15000 });
      const heldCalls = count => page.waitForFunction(count => window.__pc.diagnosticLogHeld.length === count, count, { timeout: 15000 });
      const answer = (kind, value) => page.evaluate(([kind, value]) => window.__pc.diagnosticLogHeld.shift()[kind](value), [kind, value]);
      // From here native answers an apply only when the test says so, and every projection the Hook returns is listed.
      // A call that carries entries is answered at once, as before: this scenario is about the apply.
      const hold = () => page.evaluate(() => {
        const pc = window.__pc;
        pc.diagnosticLogHeld = [];
        pc.diagnosticLog = args => (args.entries ?? []).length > 0
          ? { v: 1, appliedLevel: args.level, accepted: args.entries.length, filtered: 0, rejected: 0, dropped: 0,
            sink: { state: 'ready', droppedTotal: 0, writeFailures: 0, unsavedAtExit: 0 } }
          : new Promise((resolve, reject) => pc.diagnosticLogHeld.push({ args, resolve, reject }));
        pc.diagnosticLogRenders = [];
        let meeting = pc.meeting;
        Object.defineProperty(pc, 'meeting', { configurable: true, get: () => meeting, set: value => {
          meeting = value;
          const shown = value.diagnosticLogLevelStatus;
          const entry = [value.settings.diagnosticLogLevel, shown.phase, shown.level, shown.appliedLevel ?? null];
          if (JSON.stringify(pc.diagnosticLogRenders.at(-1)) !== JSON.stringify(entry)) pc.diagnosticLogRenders.push(entry);
        } });
      });

      // A fresh store: info, applied once at mount with an empty batch, nothing written, Debug Mode off.
      await phase('applied');
      let view = await logLevel(page);
      assert.deepEqual([view.selectors, view.group, view.previous], [1, 'Debug', 'Debug Mode'], 'one selector, in the Debug group, right under Debug Mode');
      assert.deepEqual(view.options, ['Error', 'Warn', 'Info', 'Debug', 'Trace']);
      assert.deepEqual([view.selected, view.setting, view.debugMode, view.stored], [['Info'], 'info', false, null]);
      assert.equal(view.help, HELP);
      assert.deepEqual([view.status, view.red, view.controls], [[applied('info')], [false], 0]);
      assert.deepEqual(view.exported, { phase: 'applied', level: 'info', appliedLevel: 'info', sinkState: 'ready' });
      assert.deepEqual(view.commands, [apply('info')], 'one apply at mount: the level and an empty batch');
      // LG7: the one entry of this mount. This host answers the trace metrics read with null, which the Hook cannot
      // read. That used to be a console warning and is now a warn entry, with the bounded summary of the error the
      // Hook caught as its cause (decisions A8).
      const logged = count => page.waitForFunction(count => window.__pc.calls.filter(call => call.name === 'write_diagnostic_log')
        .reduce((sum, call) => sum + (call.args.entries ?? []).length, 0) === count, count, { timeout: 15000 });
      const AT_MOUNT = ['info', 'warn', 'meeting.trace-metrics', 'load-failed', { cause: "TypeError: Cannot read properties of null (reading 'trim')" }];
      await logged(1);
      assert.deepEqual((await logLevel(page)).entries, [AT_MOUNT]);

      // A real click on Trace while native is silent: saved and selected at once, shown as requested, not as applied.
      await hold();
      const picked = await act(page, () => option(page, '#configurations', 'Log Level', 'Trace').click());
      assert.deepEqual(picked.moved.sort(), ['diagnosticLogLevelStatus.appliedLevel: "info" -> undefined', 'diagnosticLogLevelStatus.level: "info" -> "trace"',
        'diagnosticLogLevelStatus.phase: "applied" -> "pending"', 'diagnosticLogLevelStatus.sinkState: "ready" -> undefined',
        'settings.diagnosticLogLevel: "info" -> "trace"'], 'the click moved its setting and the projection, and nothing else the Hook exports');
      assert.deepEqual([picked.nativeCalls, picked.requests], [1, 0], 'one native call, the apply, and no provider request');
      await heldCalls(1);
      view = await logLevel(page);
      assert.deepEqual([view.selected, view.setting, view.status, view.red], [['Trace'], 'trace', [pending('trace')], [false]]);
      assert.deepEqual(view.held, [apply('trace')]);
      assert.equal(JSON.parse(view.stored).diagnosticLogLevel, 'trace', 'the setting is saved before native answers');
      assert.equal(JSON.parse(view.stored).debugMode, false);

      // Native answers: applied, with the level and the sink state of the receipt.
      await answer('resolve', receipt('trace', 'degraded'));
      await phase('applied');
      await frames(page);
      view = await logLevel(page);
      assert.deepEqual([view.status, view.red], [[applied('trace', 'degraded')], [false]]);
      assert.deepEqual(view.exported, { phase: 'applied', level: 'trace', appliedLevel: 'trace', sinkState: 'degraded' });

      // Debug Mode on and off while a level is applied: the level, its status and native are left alone.
      // LG7: each change of Debug Mode is one info entry of the trace store, sent at the applied level. No apply is sent.
      const DEBUG_MODE = enabled => ['trace', 'info', 'meeting.trace', 'store-event', { change: 'debug-mode', enabled }];
      for (const expected of [true, false]) {
        const toggled = await act(page, () => rowSwitch(page, 'Debug Mode').click());
        assert.deepEqual(toggled.moved, [`settings.debugMode: ${!expected} -> ${expected}`]);
        await logged(expected ? 2 : 3);
        const now = await logLevel(page);
        assert.deepEqual([now.selected, now.setting, now.status, now.held.length, now.commands.length], [['Trace'], 'trace', [applied('trace', 'degraded')], 0, 2]);
        assert.deepEqual(now.entries, [AT_MOUNT, DEBUG_MODE(true), ...(expected ? [] : [DEBUG_MODE(false)])]);
      }

      // A click on Debug (the level) that native rejects: failed with the reason, in red, and never shown as applied.
      await option(page, '#configurations', 'Log Level', 'Debug').click();
      await heldCalls(1);
      view = await logLevel(page);
      assert.deepEqual([view.selected, view.status, view.held], [['Debug'], [pending('debug')], [apply('debug')]]);
      await answer('reject', 'The diagnostic log sink is not available');
      await phase('failed');
      await frames(page);
      view = await logLevel(page);
      assert.deepEqual([view.selected, view.setting, view.status, view.red, view.controls],
        [['Debug'], 'debug', [failed('debug', 'The diagnostic log sink is not available')], [true], 0]);
      assert.deepEqual(view.exported, { phase: 'failed', level: 'debug', message: 'The diagnostic log sink is not available' });
      assert.equal(JSON.parse(view.stored).diagnosticLogLevel, 'debug', 'the selection stays saved');
      assert.equal(view.debugMode, false, 'the Debug Mode switch was not moved by the Debug level');

      // A real click on the level that is already selected retries the apply. Nothing is saved: the stored text and
      // the settings object the Hook exports are the ones from before the click.
      const savedBeforeRetry = view.stored;
      await page.evaluate(() => { window.__lgSettingsBeforeRetry = window.__pc.meeting.settings; });
      const retried = await act(page, () => option(page, '#configurations', 'Log Level', 'Debug').click());
      assert.deepEqual(retried.moved.sort(), ['diagnosticLogLevelStatus.message: "The diagnostic log sink is not available" -> undefined',
        'diagnosticLogLevelStatus.phase: "failed" -> "pending"'], 'the retry moved the projection and no setting');
      assert.deepEqual([retried.nativeCalls, retried.requests], [1, 0]);
      await heldCalls(1);
      view = await logLevel(page);
      assert.deepEqual([view.selected, view.status, view.held, view.stored], [['Debug'], [pending('debug')], [apply('debug')], savedBeforeRetry]);
      assert.equal(await page.evaluate(() => window.__pc.meeting.settings === window.__lgSettingsBeforeRetry), true,
        'the settings object is the same one: nothing that depends on the settings saw a change');
      await answer('resolve', receipt('debug'));
      await phase('applied');
      await frames(page);
      view = await logLevel(page);
      assert.deepEqual([view.selected, view.status, view.red, view.stored], [['Debug'], [applied('debug')], [false], savedBeforeRetry]);

      // Two quick clicks: only the reply of the latest request is shown, and an older one changes nothing.
      await page.evaluate(() => { const meeting = window.__pc.meeting; meeting.setDiagnosticLogLevel('warn'); });
      await heldCalls(1);
      await option(page, '#configurations', 'Log Level', 'Error').click();
      await frames(page);
      view = await logLevel(page);
      assert.deepEqual([view.selected, view.status, view.held], [['Error'], [pending('error')], [apply('warn')]], 'one call at a time: error waits for the reply to warn');
      await answer('resolve', receipt('warn'));
      await heldCalls(1);
      await frames(page);
      view = await logLevel(page);
      assert.deepEqual([view.status, view.held], [[pending('error')], [apply('error')]], 'the reply to warn is not the status of error');
      await answer('resolve', receipt('error'));
      await phase('applied');
      await frames(page);
      view = await logLevel(page);
      assert.deepEqual([view.selected, view.status, view.red], [['Error'], [applied('error')], [false]]);

      // Every render: a level was shown as applied only after native confirmed that level.
      assert.deepEqual(view.renders.filter(entry => entry[1] === 'applied'),
        [['trace', 'applied', 'trace', 'trace'], ['debug', 'applied', 'debug', 'debug'], ['error', 'applied', 'error', 'error']]);
      assert.equal(view.renders.some(entry => entry[1] === 'applied' && entry[0] === 'warn'), false, 'warn was superseded: it was never shown as applied');
      const debugPhases = view.renders.filter(entry => entry[0] === 'debug').map(entry => entry[1]);
      assert.deepEqual(debugPhases, ['pending', 'failed', 'pending', 'applied'], 'debug was rejected, and shown as applied only once the retry was confirmed');
      for (const entry of view.renders) assert.equal(entry[0], entry[2], 'the status always names the saved level');
      assert.deepEqual(view.commands, [apply('info'), apply('trace'), apply('debug'), apply('debug'), apply('warn'), apply('error')]);
      assert.deepEqual(view.entries, [AT_MOUNT, DEBUG_MODE(true), DEBUG_MODE(false)], 'the clicks on a level logged nothing');
      assert.equal(view.requests, 0, 'no provider request was made');
      t.diagnostic(`LG mounted Hook; renders=${JSON.stringify(view.renders)}`);

      // LG5, the loss counts. A receipt carries the native sink's own totals. The Hook reads the logger's counters when
      // it renders, so the render that shows this reply also shows what the sink reported, in red, under the status.
      await option(page, '#configurations', 'Log Level', 'Error').click();
      await heldCalls(1);
      view = await logLevel(page);
      assert.deepEqual([view.status, view.held], [[pending('error')], [apply('error')]], 'the saved level selected again: the apply is sent once more');
      await answer('resolve', { ...receipt('error', 'degraded'), sink: { state: 'degraded', droppedTotal: 7, writeFailures: 2, unsavedAtExit: 0 } });
      await phase('applied');
      await frames(page);
      view = await logLevel(page);
      assert.deepEqual([view.status, view.red, view.controls],
        [[applied('error', 'degraded'), 'Log loss: native dropped 7, native write failures 2.'], [false, true], 0]);
      assert.deepEqual(await page.evaluate(() => JSON.parse(JSON.stringify(window.__pc.meeting.diagnosticLogLoss))),
        { frontendShed: 0, frontendRefusedEntries: 0, frontendDetailLeftOut: 0, frontendInternalErrors: 0, frontendUndelivered: 0,
          nativeRejected: 0, nativeDropped: 7, nativeWriteFailures: 2 });
      // The next receipt is the latest one: a sink that reports nothing lost removes the line. No timer refreshed it.
      await option(page, '#configurations', 'Log Level', 'Error').click();
      await heldCalls(1);
      await answer('resolve', receipt('error'));
      await phase('applied');
      await frames(page);
      view = await logLevel(page);
      assert.deepEqual([view.status, view.red], [[applied('error')], [false]]);
      assert.deepEqual(view.commands.slice(-2), [apply('error'), apply('error')]);
      assert.equal(view.requests, 0, 'no provider request was made');

      // Reload: the saved level is read back, applied again with an empty batch, and nothing is written.
      const saved = view.stored;
      await host.reload();
      await phase('applied');
      view = await logLevel(page);
      assert.deepEqual([view.selected, view.setting, view.status, view.stored], [['Error'], 'error', [applied('error')], saved]);
      assert.deepEqual(view.commands, [apply('error')], 'the new page applied the saved level once');
      assert.deepEqual(view.entries, [], 'at error, the warning of this mount is filtered before it is built or sent');
    });
  } finally { await browser.close(); }
});
