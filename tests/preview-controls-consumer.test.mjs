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
      if (['preparation_extraction_initialize', 'memory_content_initialize', 'set_native_stall_diagnostics', 'read_meeting_trace_metrics',
        'write_meeting_trace_metrics', 'write_meeting_trace_log', 'write_meeting_session_recording_text'].includes(name)) return null;
      if (name === 'start_meeting_session_recording') return '/pc-c3-recording';
      if (name === 'write_meeting_session_recording_base64') return `/pc-c3-recording/${args.relativePath}`;
      if (name === 'export_meeting_trace') return `/pc-c3-recording/exports/${args.fileName}`;
      if (name === 'cleanup_stt_evaluation_captures') return 0;
      if (name === 'get_stt_evaluation_capture_status') return { active: false, bytesWritten: 0 };
      if (name === 'evaluation_store_import_status') return { imported: true };
      if (name === 'evaluation_store_read') return { events: [], projections: [] };
      if (name === 'evaluation_store_project') return JSON.parse(JSON.stringify(args.projection));
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
        'microphoneContextEnabled', 'nativeStallDiagnosticsEnabled', 'personalEvidenceGuardrailMode', 'response', 'runtimeCrossChecksEnabled',
        'taxonomyAdjudication', 'useMemory'], 'the saved settings hold the keys they held before this commit');
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
  } finally { await browser.close(); }
});
