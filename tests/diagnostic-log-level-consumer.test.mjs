// Task 178 LG, LG2: evidence independence. One fixed Screen turn through the real Hook in a real
// browser, at each of the five log levels, in every combination of Debug Mode, Session Recording and
// Runtime Cross-checks (2 x 2 x 2 x 5 = 40 mounted sessions).
//
// Real: useMeetingAssistant with everything it imports (the diagnostic logger included), the runtime,
// the recorder and the critical event stream. Controlled: the Tauri boundary, the database, the
// provider and the model worker, by the S63 host of tests/project-selection-hook-browser.test.mjs.
// The stream is reached only inside this test bundle, as in the 178A cases of that file; the
// subscriber below is a test-side observer.
//
// What is compared inside one combination, across the five levels: the answer, task state and trace
// metadata the user is given, the provider requests, the 178A facts delivered and journalled, every
// file the recording wrote, the Native Stall Diagnostics requests, and the native commands with
// their counts. The recording stores the settings it started with, so the one value expected to differ
// there is the recorded diagnosticLogLevel itself, which is checked against the level the session was mounted with.
// The other thing that differs by level is the diagnostic log itself, and only it: the calls of its one
// command are taken out of the command counts and checked on their own. Each session's first call is the
// apply, with an empty batch, and the entries that follow are those of this session that pass the level:
// since commit 3 the trace store's changes (debug and trace), the Fact Risk Review summary (debug), the
// Debug Mode change at mount (info) and one warning, because this host answers the trace metrics read with
// a value the Hook cannot parse. Within a combination, the entries at a level are the entries at trace that
// pass that level: the level filters and does nothing else. Debug Mode does not decide them (LG7): the trace
// store's changes are logged at debug and trace with Debug Mode off, and are not logged at info with it on.
// The combination with every switch on runs once more at trace with a sink that rejects every batch that
// carries entries after it confirmed the apply: a failing delivery is held to the same comparison as a level.
//
// How numbers are compared. Exact: the list of 178A facts, the count of each native command, the
// number of recorded files, and the size of every array and the key set of every object (so the
// number of provider requests, traces, steps and recorded lines). Not compared: the value of every
// JSON number. Times, durations, identifiers and the character counts that follow from them differ
// between two identical sessions, and a count that happens to be equal in the two reference sessions
// would fail a third one for no reason. Booleans and text are compared, digits in text included.
//
// The last part is about a level change during a session. In the matrix the level is stored before
// the Hook mounts and one turn runs, so no setting is written while a session is under way. A
// change of the level is a settings write. GG178 compares each such write to no action, including
// the actual second Provider prompt (only generated identity/time noise is normalized). Reference
// content and source travel together; refreshing a React closure cannot decide their presence.
// A recording that is running when the level changes keeps the level it started with: its settings
// file is written once, at the start, and the change adds no recording write.
//
// The last part is LG8, the cost: the scripted Voice and Screen turns of the Replay run at each level with
// Debug Mode on and off, with the entries, calls and bytes of each turn next to what the retired string
// command sent for the same turn, and the logger's queue peak and shed counts.
//
// Run. This file needs a browser, so plain `npm test` reports it as skipped. It is run by name, with
// the environment of the browser gate, next to that gate's seven files (about 6 minutes). It is one
// test with one browser, like every consumer file.
// Not covered here: resource contention between the log sink and the runtime (the sink is native and
// is not running), and raw audio (this input is a Screen capture).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { browserBundle, fixtures, openProjectSelectionBrowserHost, playwright, browserTestSkip } from './project-selection-hook-browser.test.mjs';

const LEVELS = ['error', 'warn', 'info', 'debug', 'trace'];
const JOURNAL = 'runtime-events/critical-events.v1.jsonl';
const EXECUTION = { executionId: 'LG2', caseId: 'LG2', surface: 'normal', source: 'screen', behavior: 'success' };

// Expose the Hook's own stream and the logger's own counters at its return, inside the test bundle only.
const criticalEventStreamPlugin = {
  name: 'lg-critical-event-stream',
  setup(builder) {
    builder.onLoad({ filter: /useMeetingAssistant\.ts$/ }, args => {
      const source = readFileSync(args.path, 'utf8');
      const file = ts.createSourceFile(args.path, source, ts.ScriptTarget.Latest, true);
      const hook = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'useMeetingAssistant');
      assert.ok(hook?.body);
      const returns = hook.body.statements.filter(ts.isReturnStatement);
      assert.equal(returns.length, 1, 'expose the stream at the actual Hook return, without replacing any callback');
      const at = returns[0].getStart(file);
      return { contents: `${source.slice(0, at)}window.__lg = { stream: runtimeCriticalEventStreamRef.current, snapshot: readDiagnosticLogSnapshot };\n${source.slice(at)}`,
        loader: 'ts', resolveDir: path.dirname(args.path) };
    });
  },
};

// Two sessions never share their identifiers, clock values, durations or the hashes derived from them, whatever
// the level is. That session noise is removed in two steps. First by shape: created identifiers and times in text,
// and every JSON number, become placeholders. Then by measurement: each combination runs the default level twice,
// and whatever still differs between those two identical sessions (hash-derived names, mostly) is masked for that
// combination. Everything else has to be equal at every level, digits in text included.
const scrub = text => text
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}[:-]\d{2}[:-]\d{2}(?:[.-]\d+)?Z?/g, '<time>')
  .replace(/(?<![0-9])1[0-9]{12}(?![0-9])/g, '<ms>')
  .replace(/<(?:ms|time)>[-_][a-z0-9]{1,6}(?![a-z0-9])/g, '<id>');
function shape(value, key) {
  if (key === 'diagnosticLogLevel') return '<level>';
  if (typeof value === 'number') return '<n>';
  if (typeof value === 'string') {
    // A prompt, a payload or a file that is itself JSON is compared part by part; other text line by line.
    if (/^\s*[[{]/.test(value)) { try { return shape(JSON.parse(value)); } catch { /* not JSON: text */ } }
    const text = scrub(value);
    return text.includes('\n') ? text.split('\n') : text;
  }
  if (Array.isArray(value)) return value.map(item => shape(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [scrub(name), shape(item, name)]));
  return value;
}
// Two recorded artifacts depend on when the trace-metrics debounce timer fired, not on anything the session decided:
// the snapshot it saves, and the place of its own line among the last lines of the timeline. The snapshot is compared
// by its presence; the timeline is compared as its ordered events and, apart from them, its trace-metrics lines.
const DEBOUNCED_SNAPSHOT = 'metrics/trace-metrics.json';
function shapeFile(file, content) {
  if (file === DEBOUNCED_SNAPSHOT) return '<debounced snapshot>';
  if (!file.endsWith('.jsonl')) return shape(content);
  const lines = content.split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (file !== 'timeline.jsonl') return lines.map(line => shape(line));
  return { events: lines.filter(line => line.kind !== 'trace-metrics').map(line => shape(line)),
    traceMetrics: lines.filter(line => line.kind === 'trace-metrics').map(line => shape(line)) };
}
// Every leaf of a shaped value by its path, with the size of each array and the keys of each object as leaves of their own.
function leaves(value, at = '', found = new Map()) {
  if (Array.isArray(value)) {
    found.set(`${at}#length`, value.length);
    value.forEach((item, index) => leaves(item, `${at}[${index}]`, found));
  } else if (value && typeof value === 'object') {
    found.set(`${at}#keys`, Object.keys(value).join(','));
    for (const [name, item] of Object.entries(value)) leaves(item, `${at}/${name}`, found);
  } else found.set(at, value);
  return found;
}
const differing = (left, right) => [...new Set([...left.keys(), ...right.keys()])].filter(at => left.get(at) !== right.get(at));
const label = event => event.terminal ? `${event.fact}:${event.terminal.object}:${event.terminal.disposition}` : `${event.fact}:${event.stage}`;
// What an entry is, for a comparison of two sessions: its level and tags, and for the trace store the kind of change.
const tagOf = entry => `${entry.level} ${entry.source} ${entry.event}${entry.source === 'meeting.trace' ? ` ${entry.data.change}` : ''}`;
const passes = (threshold, level) => LEVELS.indexOf(level) <= LEVELS.indexOf(threshold);
// The trace store's changes of a turn, by the level A7 gives each.
const STORE_DEBUG = ['trace-started', 'step-finished', 'trace-finished'];
const STORE_TRACE = ['step-started', 'trace-metadata-updated'];
const bytesOf = text => new TextEncoder().encode(text).length;

// One session: mount with the stored settings, optionally start a recording, run the Screen turn to its
// stable answer, let trailing work finish, stop the recording, and collect what the session produced.
// With `between`, the session goes on after the first answer: the action runs once while the session is idle, then
// the project is selected, which is the second turn and its Advisor request.
// With `rejectLogEntries`, the native side confirms the level apply and then rejects every later diagnostic log call
// that carries entries, as a sink that became unwritable would.
async function runSession(t, bundle, browser, { debug, recording, crossChecks, level, between, rejectLogEntries }) {
  const settings = { debugMode: debug, runtimeCrossChecksEnabled: crossChecks, diagnosticLogLevel: level, nativeStallDiagnosticsEnabled: true };
  const { page, context, failures } = await openProjectSelectionBrowserHost(t, bundle, browser, EXECUTION, { mountOnly: true, settings });
  try {
    await page.waitForFunction(() => window.__s63.meeting.diagnosticLogLevelStatus.phase === 'applied', undefined, { timeout: 10000 });
    if (rejectLogEntries) {
      await page.evaluate(() => {
        const host = window.__s63, invoke = host.invoke;
        host.rejectedLogCalls = 0;
        // What native had already taken when it stopped taking entries: the apply, and the entries of the mount.
        const taken = host.calls.filter(call => call.name === 'write_diagnostic_log');
        host.logCallsBeforeReject = taken.length;
        host.logEntriesBeforeReject = taken.reduce((sum, call) => sum + (call.args.entries ?? []).length, 0);
        host.invoke = (name, args = {}) => {
          if (name !== 'write_diagnostic_log' || (args.entries ?? []).length === 0) return invoke(name, args);
          // What the logger handed over is still recorded, as the host records every command.
          host.calls.push({ name, args });
          host.rejectedLogCalls += 1;
          return Promise.reject(new Error('the diagnostic log directory is not writable'));
        };
      });
    }
    if (recording) {
      await page.evaluate(() => window.__s63.meeting.setSessionRecordingEnabled(true));
      await page.waitForFunction(() => window.__s63.meeting.sessionRecording.active, undefined, { timeout: 10000 });
    }
    const subscription = await page.evaluate(() => {
      window.__lgDeliveries = [];
      const { accepted, reason } = window.__lg.stream.subscribe(delivery => { window.__lgDeliveries.push(delivery); });
      return { accepted, reason: reason ?? null };
    });
    assert.deepEqual(subscription, { accepted: true, reason: null });
    await page.evaluate(() => window.__s63.meeting.captureScreenContext());
    await page.getByRole('button', { name: 'Quartz Relay', exact: true }).waitFor({ timeout: 15000 });
    // Trailing work (the risk review, persistence) is done when nothing moves for a while.
    const signature = () => page.evaluate(() => JSON.stringify([window.__s63.calls.length, window.__s63.requests.length,
      window.__lgDeliveries.length, window.__s63.meeting.traces.map(trace => trace.status)]));
    const settle = async () => {
      for (let previous = await signature(), equal = 0, attempt = 0; equal < 6; attempt += 1) {
        assert.ok(attempt < 200, 'the session did not settle');
        await page.waitForTimeout(100);
        const next = await signature();
        equal = next === previous ? equal + 1 : 0;
        previous = next;
      }
    };
    await settle();
    if (between) {
      await page.evaluate(BETWEEN_TURNS[between]);
      await settle();
      await page.evaluate(() => { window.__s63.stage = 'selected'; window.__s63.failSelected = false; window.__s63.holdSelected = false; });
      await page.getByRole('button', { name: 'Quartz Relay', exact: true }).click();
      await page.waitForFunction(() => window.__s63.meeting.traces.some(trace => trace.metadata?.clarifyingSelectionState === 'succeeded'),
        undefined, { timeout: 15000 });
      await settle();
    }
    if (recording) {
      await page.evaluate(() => window.__s63.meeting.setSessionRecordingEnabled(false));
      await page.waitForFunction(() => !window.__s63.meeting.sessionRecording.active && window.__s63.meeting.sessionRecording.lifecycle === 'idle',
        undefined, { timeout: 15000 });
    }
    const raw = await page.evaluate(() => {
      const s63 = window.__s63;
      const meeting = s63.meeting;
      const parent = meeting.taskRuntime.parent;
      return {
        status: meeting.status, error: meeting.error,
        applied: meeting.diagnosticLogLevelStatus,
        settings: meeting.settings,
        answer: s63.observed.adviseDisplay.stable?.suggestion?.content ?? null,
        visible: document.querySelector('[data-answer]').textContent,
        task: parent ? { questionType: parent.questionType, playbookPhase: parent.playbookPhase, bound: Boolean(parent.projectBinding) } : null,
        choice: s63.observed.projectChoice ? { options: (s63.observed.projectChoice.options ?? []).map(option => option.label ?? option.projectName ?? option.id) } : null,
        traces: meeting.traces.map(trace => ({ kind: trace.kind, status: trace.status,
          steps: trace.steps.map(step => `${step.name}:${step.status}`), metadata: trace.metadata ?? {} })),
        requests: s63.requests.map(request => ({ system: request.system, user: request.user, images: request.imageUrls.length, response: request.response ?? null })),
        // The Advisor request of the project selection, when the session had that second turn: its generated guidance block.
        selected: s63.requests.filter(request => request.selectedFactPromptChecked)
          .map(request => (/<generated_guidance>([\s\S]*?)<\/generated_guidance>/.exec(request.user.replace(/\\n/g, '\n')) ?? [])[1]?.trim() ?? null),
        selectedRequests: s63.requests.filter(request => request.selectedFactPromptChecked)
          .map(request => ({ system: request.system, user: request.user, images: request.imageUrls.length })),
        deliveries: window.__lgDeliveries,
        files: [...s63.writes.entries()],
        binaries: [...s63.binaryWrites.keys()],
        commands: s63.calls.filter(call => call.name).map(call => ({ name: call.name, args: call.name === 'write_diagnostic_log' ||
          call.name === 'set_native_stall_diagnostics' ? call.args : undefined })),
        rejectedLogCalls: s63.rejectedLogCalls ?? 0,
        logCallsBeforeReject: s63.logCallsBeforeReject ?? 0, logEntriesBeforeReject: s63.logEntriesBeforeReject ?? 0,
        loss: meeting.diagnosticLogLoss,
        unexpected: s63.unexpected,
      };
    });
    assert.deepEqual(failures, [], 'no page error and no uncontrolled network');
    assert.deepEqual(raw.unexpected, [], 'no uncontrolled native command');
    return raw;
  } finally { await context.close(); }
}

// The one action of a two-turn session, taken while the session is idle between its turns.
const BETWEEN_TURNS = {
  // Nothing at all.
  'no action': () => {},
  // The level is changed.
  'level change': () => window.__s63.meeting.setDiagnosticLogLevel('debug'),
  // The saved level is selected again: the apply is sent again and nothing is saved.
  'saved level again': () => window.__s63.meeting.setDiagnosticLogLevel('info'),
  // Another setting is written with the value it already has: the settings object is replaced and nothing else changes.
  'another settings write': () => window.__s63.meeting.setUseMemory(window.__s63.meeting.settings.useMemory),
};

// What one session produced: the shaped evidence compared across levels, and the exact counts that are not shaped.
function evidence(raw) {
  // Every native command but the diagnostic log's own: its calls are the one thing a level is meant to change.
  const commandCounts = {};
  for (const { name } of raw.commands) if (name !== 'write_diagnostic_log') commandCounts[name] = (commandCounts[name] ?? 0) + 1;
  const facts = raw.deliveries.map(delivery => delivery.kind === 'event' ? label(delivery.event) : `<${delivery.kind}>`);
  return {
    facts,
    commandCounts,
    fileCount: raw.files.length,
    nativeStall: raw.commands.filter(command => command.name === 'set_native_stall_diagnostics')
      .map(command => ({ enabled: command.args.enabled, folderName: command.args.folderName === null ? null : '<folder>' })),
    shaped: leaves(shape({
      business: { status: raw.status, error: raw.error, answer: raw.answer, visible: raw.visible, task: raw.task, choice: raw.choice, traces: raw.traces },
      requests: raw.requests,
      deliveries: raw.deliveries,
      // By name: the order in which the files were first written depends on timing.
      files: Object.fromEntries(raw.files.map(([file, content]) => [scrub(file), shapeFile(file, content)])
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))),
      binaries: raw.binaries.map(scrub).sort(),
    })),
  };
}

// The two-turn part of the one test of this file: six sessions on the browser the matrix used.
async function levelChangeBetweenTwoTurns(t, bundle, browser) {
  // Recording on, so that the recorded trace metadata of both turns is part of what is compared.
  const cell = { debug: false, recording: true, crossChecks: false, level: 'info' };
  const session = async between => {
    const raw = await runSession(t, bundle, browser, { ...cell, between });
    assert.equal(raw.error, null, between);
    assert.equal(raw.selected.length, 1, `${between}: one Advisor request for the selected project`);
    assert.ok(raw.traces.some(trace => trace.metadata.clarifyingSelectionState === 'succeeded'), between);
    const produced = evidence(raw);
    // The diagnostic log calls are the one difference that is expected by construction: the applies (the calls with
    // an empty batch) and the entries are compared on their own below.
    const logCalls = raw.commands.filter(command => command.name === 'write_diagnostic_log').map(command => command.args);
    return { raw, ...produced, applies: logCalls.filter(call => call.entries.length === 0).map(call => call.level),
      logged: logCalls.flatMap(call => call.entries.map(entry => [call.level, entry.level, entry.source, entry.event])),
      guidance: raw.selected[0] };
  };
  // `left` twice gives the session noise of this pair; `right` then has to equal `left` beyond it.
  const same = async (leftAction, rightAction) => {
    const left = await session(leftAction);
    const again = await session(leftAction);
    const right = await session(rightAction);
    const noise = new Set(differing(left.shaped, again.shaped));
    const noisyParents = [...noise].flatMap(leaf => leaf.endsWith('#keys') ? [`${leaf.slice(0, -5)}/`] : leaf.endsWith('#length') ? [`${leaf.slice(0, -7)}[`] : []);
    const masked = leaf => noise.has(leaf) || noisyParents.some(parent => leaf.startsWith(parent));
    const maskedLeaves = [...left.shaped.keys()].filter(masked).length;
    assert.ok(maskedLeaves * 5 < left.shaped.size, `${leftAction}: the noise mask covers ${maskedLeaves} of ${left.shaped.size} leaves`);
    const at = `"${rightAction}" against "${leftAction}"`;
    assert.deepEqual([again.facts, again.nativeStall, again.commandCounts, again.fileCount], [left.facts, left.nativeStall, left.commandCounts, left.fileCount],
      `two sessions with "${leftAction}" agree`);
    assert.deepEqual(right.facts, left.facts, `${at}: the 178A facts and their order`);
    assert.deepEqual(right.nativeStall, left.nativeStall, `${at}: the Native Stall Diagnostics requests`);
    assert.deepEqual(right.commandCounts, left.commandCounts, `${at}: the native commands and how often each was called`);
    assert.equal(right.fileCount, left.fileCount, `${at}: the number of recorded files`);
    const moved = differing(left.shaped, right.shaped).filter(leaf => !masked(leaf));
    assert.deepEqual(moved.slice(0, 12).map(leaf => `${leaf}: ${JSON.stringify(left.shaped.get(leaf))} -> ${JSON.stringify(right.shaped.get(leaf))}`), [],
      `${at}: ${moved.length} leaves differ beyond the session noise`);
    // The generated guidance of the second Advisor request, apart from the identifier of the trace it names.
    assert.equal(scrub(right.guidance), scrub(left.guidance), `${at}: the generated guidance of the second Advisor request`);
    return { left, right, leaves: left.shaped.size, maskedLeaves };
  };

  // GG178: the baseline has no intervening action, not a second settings write.
  const changed = await same('no action', 'level change');
  const sameValue = await same('no action', 'another settings write');
  assert.deepEqual([changed.left.applies, changed.right.applies], [['info'], ['info', 'debug']], 'the level change is applied; the other write sends nothing');
  // At info these two turns log one entry: the warning of this host's trace metrics read, at mount. The turns
  // themselves have no warning and no error. After the change to debug, the second turn's debug entries are sent, at
  // that level, and nothing else of the session differs (compared above).
  const AT_MOUNT = [['info', 'warn', 'meeting.trace-metrics', 'load-failed']];
  assert.deepEqual(changed.left.logged, AT_MOUNT, 'the entries at info');
  assert.deepEqual(changed.right.logged.filter(([callLevel]) => callLevel === 'info'), AT_MOUNT, 'the entries before the change, at info');
  const afterChange = changed.right.logged.filter(([callLevel]) => callLevel === 'debug');
  assert.ok(afterChange.length > 0 && afterChange.every(([, level]) => level === 'debug') && afterChange.length + 1 === changed.right.logged.length,
    `entries after the change to debug: ${JSON.stringify(afterChange.slice(0, 6))}`);
  // They are the second turn's: its trace and step ends, and the summaries of its reviews.
  assert.deepEqual([...new Set(afterChange.map(([, , source]) => source))].sort(), ['meeting.fact-risk-review', 'meeting.trace']);
  assert.deepEqual([changed.left.raw.settings.diagnosticLogLevel, changed.right.raw.settings.diagnosticLogLevel], ['info', 'debug']);
  assert.deepEqual(changed.right.raw.applied, { phase: 'applied', level: 'debug', appliedLevel: 'debug', sinkState: 'ready' });
  // The recording was running when the level changed. Its settings file is written once, at the start, so it holds
  // the level the recording started with while the Hook has the new one.
  const recorded = raw => JSON.parse(raw.files.find(([file]) => file === 'settings/meeting-assistant-settings.json')[1]).settings;
  assert.equal(recorded(changed.right.raw).diagnosticLogLevel, 'info', 'a running recording keeps the level it started with');
  assert.deepEqual(recorded(changed.right.raw), recorded(changed.left.raw), 'the recorded settings are those of the start in both sessions');

  // The saved level selected again against no action at all.
  const reselected = await same('no action', 'saved level again');
  assert.deepEqual([reselected.left.applies, reselected.right.applies], [['info'], ['info', 'info']], 'the re-selection sends the apply again, and that is all it does');
  assert.deepEqual([reselected.left.logged, reselected.right.logged], [AT_MOUNT, AT_MOUNT], 'the same one entry at info in either session');
  assert.deepEqual(reselected.right.raw.settings, reselected.left.raw.settings);

  // The level change adds no recording write: the session wrote the recording as often, and into as many files, as
  // the session in which nothing was done between the turns.
  const recordingWrites = session => ({ text: session.commandCounts.write_meeting_session_recording_text ?? 0,
    binary: session.commandCounts.write_meeting_session_recording_base64 ?? 0, files: session.fileCount });
  assert.ok(recordingWrites(reselected.left).text > 0 && recordingWrites(reselected.left).files > 0, 'the recording was written');
  assert.deepEqual(recordingWrites(changed.right), recordingWrites(reselected.left),
    'a running recording keeps the level it started with; the change adds no recording write');

  const present = guidance => guidance !== null && guidance !== 'No generated guidance.';
  const promptInput = requests => JSON.stringify(requests.map(request => ({ ...request,
    system: scrub(request.system),
    // This source identity includes the newly allocated Screen operation ID.
    user: scrub(request.user).replace(/question_source_[a-z0-9]+/g, 'question_source_<id>'),
  })));
  for (const run of [changed.left, changed.right, sameValue.left, sameValue.right, reselected.left, reselected.right]) {
    assert.ok(present(run.guidance), 'GG178: the actual authorized reference is present without a settings refresh');
    const actual = promptInput(run.raw.selectedRequests), expected = promptInput(changed.left.raw.selectedRequests);
    const difference = [...actual].findIndex((char, index) => char !== expected[index]);
    assert.ok(actual === expected,
      `GG178 Provider input differs at ${difference}: ${actual.slice(difference - 60, difference + 160)} vs ${expected.slice(difference - 60, difference + 160)}`);
  }
  t.diagnostic(`LG2 two turns: recording writes with a level change ${JSON.stringify(recordingWrites(changed.right))}, with no action ${JSON.stringify(recordingWrites(reselected.left))}; ` +
    `level change == no action over ${changed.leaves} leaves (${changed.maskedLeaves} masked as noise); ` +
    `saved level again == no action over ${reselected.leaves} leaves (${reselected.maskedLeaves} masked). ` +
    `Generated guidance in the second Advisor request: no action=${present(reselected.left.guidance)}, saved level again=${present(reselected.right.guidance)}, ` +
    `another settings write=${present(sameValue.right.guidance)}, level change=${present(changed.right.guidance)}`);
}

// ---- LG8: the cost of the scripted turns ----
//
// What the retired string command sent for the same scripted turns with Debug Mode on: one call per line, with the
// whole metadata of each trace change. Measured on 2026-10-04 with this host on the tree before the migration, by a
// script that is not in the repository: [calls, bytes of the lines]. With Debug Mode off it sent nothing for a turn.
const OLD_TRACE_LOG = { voice: { first: [202, 351260], selection: [138, 223953] }, screen: { first: [122, 132717], selection: [135, 218351] } };

// One scripted session of the Replay run: mount with Debug Mode on (the run needs it to start), start the run,
// optionally turn Debug Mode off inside it, then the first turn (the Voice question or the Screen capture), the
// project selection turn, and Stop. Returns what the diagnostic log command carried in each part, and the logger's counters.
async function scriptedTurns(t, bundle, browser, { source, debug, level }) {
  const execution = { executionId: `LG8-${source}`, caseId: 'LG8', surface: 'normal', source, behavior: 'success' };
  const settings = { debugMode: true, runtimeCrossChecksEnabled: false, diagnosticLogLevel: level, nativeStallDiagnosticsEnabled: true };
  const { page, context, failures } = await openProjectSelectionBrowserHost(t, bundle, browser, execution, { mountOnly: true, settings });
  try {
    await page.waitForFunction(() => window.__s63.meeting.diagnosticLogLevelStatus.phase === 'applied', undefined, { timeout: 10000 });
    const signature = () => page.evaluate(() => JSON.stringify([window.__s63.calls.length, window.__s63.requests.length,
      window.__s63.meeting.traces.map(trace => trace.status)]));
    const settle = async () => {
      for (let previous = await signature(), equal = 0, attempt = 0; equal < 6; attempt += 1) {
        assert.ok(attempt < 200, 'the session did not settle');
        await page.waitForTimeout(100);
        const next = await signature();
        equal = next === previous ? equal + 1 : 0;
        previous = next;
      }
      return page.evaluate(() => window.__s63.calls.length);
    };
    assert.equal(await page.evaluate(() => window.__s63.meeting.startRuntimeRegressionRun()), true, 'the Replay run started');
    await page.waitForFunction(() => window.__s63.meeting.sessionRecording.active, undefined, { timeout: 10000 });
    if (!debug) {
      await page.evaluate(() => window.__s63.meeting.setDebugMode(false));
      await page.waitForFunction(() => window.__s63.meeting.settings.debugMode === false, undefined, { timeout: 5000 });
    }
    const marks = [await settle()];
    if (source === 'voice') await page.evaluate(text => { void window.__s63.meeting.submitRuntimeRegressionText(text); }, fixtures.S63_SOURCE_QUESTION);
    else await page.evaluate(() => { void window.__s63.meeting.captureScreenContext(); });
    await page.getByRole('button', { name: 'Quartz Relay', exact: true }).waitFor({ timeout: 15000 });
    marks.push(await settle());
    await page.evaluate(() => { window.__s63.stage = 'selected'; window.__s63.failSelected = false; window.__s63.holdSelected = false; });
    await page.getByRole('button', { name: 'Quartz Relay', exact: true }).click();
    await page.waitForFunction(() => window.__s63.meeting.traces.some(trace => trace.metadata?.clarifyingSelectionState === 'succeeded'), undefined, { timeout: 15000 });
    marks.push(await settle());
    await page.evaluate(() => window.__s63.meeting.stopRuntimeRegressionRun());
    await page.waitForFunction(() => !window.__s63.meeting.sessionRecording.active && window.__s63.meeting.sessionRecording.lifecycle === 'idle', undefined, { timeout: 15000 });
    marks.push(await settle());
    const raw = await page.evaluate(() => ({ calls: window.__s63.calls.map(call => call.name === 'write_diagnostic_log' ? { name: call.name, args: call.args } : { name: call.name ?? null }),
      snapshot: window.__lg.snapshot(), loss: window.__s63.meeting.diagnosticLogLoss, error: window.__s63.meeting.error, unexpected: window.__s63.unexpected }));
    assert.deepEqual(failures, [], 'no page error and no uncontrolled network');
    assert.deepEqual([raw.unexpected, raw.error], [[], null], 'no uncontrolled native command and no error');
    assert.equal(raw.calls.some(call => call.name === 'write_meeting_trace_log'), false, 'no call of the retired trace log command');
    const part = (from, to) => {
      const calls = raw.calls.slice(from, to).filter(call => call.name === 'write_diagnostic_log' && call.args.entries.length > 0);
      const entries = calls.flatMap(call => call.args.entries);
      return { calls: calls.length, entries: entries.length, bytes: entries.reduce((sum, entry) => sum + bytesOf(JSON.stringify(entry)), 0),
        largestBatch: Math.max(0, ...calls.map(call => call.args.entries.length)), largestEntry: Math.max(0, ...entries.map(entry => bytesOf(JSON.stringify(entry)))),
        levels: entries.map(entry => entry.level), tags: entries.map(tagOf).sort() };
    };
    return { beforeTurns: part(0, marks[0]), first: part(marks[0], marks[1]), selection: part(marks[1], marks[2]), stop: part(marks[2], marks[3]),
      snapshot: raw.snapshot, loss: raw.loss };
  } finally { await context.close(); }
}

async function costOfScriptedTurns(t, bundle, browser) {
  for (const source of ['voice', 'screen']) {
    const measured = {};
    for (const debug of [true, false]) for (const level of LEVELS) {
      const at = `${source} debug=${debug} level=${level}`;
      const run = measured[`${debug}/${level}`] = await scriptedTurns(t, bundle, browser, { source, debug, level });
      // Nothing was shed, refused, cut or left undelivered, at any level, and the queue never filled its 512 entries.
      assert.deepEqual(Object.values(run.loss).filter(count => count !== 0), [], `${at}: no loss`);
      assert.deepEqual([run.snapshot.dropped, run.snapshot.truncatedFields, run.snapshot.oversizeEntries, run.snapshot.refusedFields],
        [{ error: 0, warn: 0, info: 0, debug: 0, trace: 0 }, 0, 0, 0], at);
      assert.ok(run.snapshot.queuePeak < 512, `${at}: queue peak ${run.snapshot.queuePeak}`);
      for (const turn of ['first', 'selection']) {
        const part = run[turn], [oldCalls, oldBytes] = OLD_TRACE_LOG[source][turn];
        assert.ok(part.levels.every(entryLevel => passes(level, entryLevel)), `${at} ${turn}: every entry passes the level`);
        assert.ok(part.largestBatch <= 64 && part.largestEntry <= 2048, `${at} ${turn}: within the batch and entry bounds`);
        // The scripted turns have no failure and no lost evidence: nothing at error, warn or info.
        if (!['debug', 'trace'].includes(level)) assert.deepEqual([part.entries, part.calls], [0, 0], `${at} ${turn}: a turn logs nothing at this level`);
        else {
          // The entries leave in batches: how many depends on how the turn falls into the logger's 50 ms windows.
          assert.ok(part.entries > 0 && part.calls < part.entries && (level !== 'trace' || part.calls * 4 <= part.entries),
            `${at} ${turn}: ${part.entries} entries left in ${part.calls} calls`);
          // Against the old one-call-per-line printing of the same turn: several times fewer calls and bytes.
          assert.ok(part.calls * 4 <= oldCalls && part.bytes * 3 <= oldBytes, `${at} ${turn}: ${part.calls} calls and ${part.bytes} bytes against ${oldCalls} and ${oldBytes}`);
        }
        t.diagnostic(`LG8 ${source} debugMode=${debug ? 'on' : 'off'} level=${level} ${turn} turn: entries=${part.entries} calls=${part.calls} bytes=${part.bytes} ` +
          `largestBatch=${part.largestBatch} largestEntryBytes=${part.largestEntry}; old trace log command with Debug Mode ${debug ? `on: calls=${oldCalls} bytes=${oldBytes}` : 'off: calls=0 bytes=0'}`);
      }
      t.diagnostic(`LG8 ${source} debugMode=${debug ? 'on' : 'off'} level=${level} session: entries=${run.snapshot.accepted} filteredCalls=${run.snapshot.filtered} ` +
        `ipcCalls=${run.snapshot.ipcCalls} ipcBytes=${run.snapshot.ipcBytes} queuePeak=${run.snapshot.queuePeak} shed=${Object.values(run.snapshot.dropped).reduce((sum, count) => sum + count, 0)} ` +
        `beforeTurns=${run.beforeTurns.entries} stop=${run.stop.entries}`);
    }
    for (const debug of [true, false]) {
      const trace = measured[`${debug}/trace`], cell = `${source} debug=${debug}`;
      // At trace a turn's entries are about as many as the lines the old printing had with Debug Mode on, in batches.
      for (const turn of ['first', 'selection']) {
        const oldCalls = OLD_TRACE_LOG[source][turn][0];
        assert.ok(Math.abs(trace[turn].entries - oldCalls) <= 8, `${cell} ${turn}: ${trace[turn].entries} entries at trace, ${oldCalls} old lines`);
        // The level only filters: the turn's entries at debug are its entries at trace that pass debug.
        assert.deepEqual(measured[`${debug}/debug`][turn].tags, trace[turn].tags.filter(tag => passes('debug', tag.split(' ')[0])), `${cell} ${turn}: debug is trace filtered`);
      }
    }
    // LG7: Debug Mode does not decide what a turn logs. With it off, a turn's entries at trace are those with it on,
    // apart from what Debug Mode itself puts into the trace store (a raw output record).
    for (const turn of ['first', 'selection']) {
      const on = measured['true/trace'][turn], off = measured['false/trace'][turn];
      assert.ok(Math.abs(on.entries - off.entries) <= 2 && off.entries > 100, `${source} ${turn}: ${on.entries} entries with Debug Mode on, ${off.entries} with it off`);
    }
  }
}

test('LG2 the log level changes no formal result, 178A fact, recording write, diagnostics request or native command: Debug x Recording x Cross-checks x five levels, and a level change between two turns; LG8 the cost of the scripted turns', { timeout: 1500000, skip: browserTestSkip }, async t => {
  // LG2_CELLS narrows a local run to some parts: a combination is written as three digits for Debug, Recording and
  // Cross-checks (for example 110,011), the two-turn part as two-turns and the cost part as lg8. Without it everything runs.
  const only = process.env.LG2_CELLS?.split(',');
  const bundle = await browserBundle([criticalEventStreamPlugin]);
  const browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.JARVIS_CHROMIUM_EXECUTABLE });
  let sessions = 0;
  try {
    for (const debug of [false, true]) for (const recording of [false, true]) for (const crossChecks of [false, true]) {
      const cell = `debug=${debug} recording=${recording} crossChecks=${crossChecks}`;
      if (only && !only.includes(`${Number(debug)}${Number(recording)}${Number(crossChecks)}`)) continue;
      await t.test(`LG2 ${cell}`, async child => {
        const session = async (level, rejectLogEntries = false) => {
          const raw = await runSession(child, bundle, browser, { debug, recording, crossChecks, level, rejectLogEntries });
          const at = `${cell} level=${level}${rejectLogEntries ? ' with the log entries rejected' : ''}`;
          // The session ran with the level it was given, native confirmed it, and the other settings are what was stored.
          assert.deepEqual([raw.settings.diagnosticLogLevel, raw.settings.debugMode, raw.settings.runtimeCrossChecksEnabled], [level, debug, crossChecks], at);
          assert.deepEqual(raw.applied, { phase: 'applied', level, appliedLevel: level, sinkState: 'ready' }, at);
          // The diagnostic log calls: the apply first, this level and an empty batch, then batches of the entries of
          // this session that pass the level.
          const logCalls = raw.commands.filter(command => command.name === 'write_diagnostic_log').map(command => command.args);
          assert.deepEqual(logCalls[0], { level, entries: [] }, at);
          assert.ok(logCalls.every(call => call.level === level), `${at}: every call carries the session's level`);
          assert.ok(logCalls.slice(1).every(call => call.entries.length >= 1 && call.entries.length <= 64), `${at}: every later call is one batch of at most 64 entries`);
          const logged = logCalls.flatMap(call => call.entries);
          // Every entry passes the level, is version 1 with fixed tags and no message, and holds scalars alone.
          for (const entry of logged) {
            assert.ok(passes(level, entry.level), `${at}: ${tagOf(entry)} passes the level`);
            assert.deepEqual([entry.v, /^meeting\.[a-z-]+$/.test(entry.source), /^[a-z-]+$/.test(entry.event), 'message' in entry], [1, true, true, false], `${at}: ${tagOf(entry)}`);
            for (const value of Object.values(entry.data ?? {})) assert.ok(value === null || ['string', 'number', 'boolean'].includes(typeof value), `${at}: ${tagOf(entry)}`);
            assert.ok(bytesOf(JSON.stringify(entry)) <= 2048, `${at}: ${tagOf(entry)} is within the entry bound`);
          }
          // The turn's one summary, at debug: its Fact Risk Review completed with no flag. It holds enum values, counts,
          // a duration and two identifiers, and no text of the answer or of the review.
          assert.deepEqual(logged.filter(entry => entry.source === 'meeting.fact-risk-review').map(entry => [entry.level, entry.event,
            Object.keys(entry).sort().join(','), entry.data.stage, entry.data.status, entry.data.flagCount, entry.data.answerRevision, typeof entry.data.durationMs,
            Object.keys(entry.data).sort().join(','), Object.keys(entry.refs).sort().join(',')]),
          ['debug', 'trace'].includes(level) ? [['debug', 'review-ended', 'at,data,event,level,refs,source,v',
            'settled', 'completed', 0, 1, 'number', 'answerRevision,durationMs,flagCount,stage,status', 'runtimeSessionId,traceId']] : [], at);
          // LG7: the trace store's changes are entries of the log by their own level, whatever Debug Mode is. The Debug
          // Mode change itself is the one info entry of the store, at mount, when Debug Mode is stored on.
          const store = logged.filter(entry => entry.source === 'meeting.trace');
          const changes = new Set(store.map(entry => entry.data.change));
          assert.deepEqual(STORE_DEBUG.map(change => changes.has(change)), STORE_DEBUG.map(() => ['debug', 'trace'].includes(level)), `${at}: trace and step ends are debug entries`);
          assert.deepEqual(STORE_TRACE.map(change => changes.has(change)), STORE_TRACE.map(() => level === 'trace'), `${at}: step starts and metadata updates are trace entries`);
          assert.deepEqual(store.filter(entry => entry.data.change === 'debug-mode').map(entry => [entry.level, entry.data.enabled]),
            debug && passes(level, 'info') ? [['info', true]] : [], `${at}: the Debug Mode change at mount`);
          // A trace store entry holds the projection alone: a trace reference, names, statuses, counts and durations.
          for (const entry of store) {
            assert.deepEqual(Object.keys(entry.data).filter(key => !['change', 'kind', 'step', 'status', 'durationMs', 'valueChars', 'metadataKeys', 'enabled'].includes(key)), [], `${at}: ${tagOf(entry)}`);
            assert.deepEqual(Object.keys(entry.refs ?? {}).filter(key => key !== 'traceId'), [], `${at}: ${tagOf(entry)}`);
          }
          // With a rejecting sink every batch after the mount was rejected; otherwise nothing was.
          assert.equal(raw.rejectedLogCalls, rejectLogEntries ? logCalls.length - raw.logCallsBeforeReject : 0, `${at}: rejected diagnostic log calls`);
          if (rejectLogEntries) assert.ok(raw.rejectedLogCalls >= 2 && raw.logCallsBeforeReject >= 1, `${at}: the turn's batches were rejected`);
          // LG4: no entry holds text of the answer or of the question on the screen.
          const text = JSON.stringify(logged);
          assert.equal(text.includes(raw.answer.slice(8, 40)), false, `${at}: no answer text in an entry`);
          assert.equal(text.includes(fixtures.S63_SOURCE_QUESTION.slice(0, 24)), false, `${at}: no question text in an entry`);
          // The turn itself completed: a stable answer, shown, with no error.
          assert.ok(raw.answer && raw.answer.startsWith('Answer:'), at);
          assert.equal(raw.error, null, at);
          const current = evidence(raw);
          assert.ok(current.facts.includes('stable-answer-committed:stable-publication'), at);
          // The retired string command is never called, with Debug Mode on or off (the host no longer answers it).
          assert.equal(raw.commands.some(command => command.name === 'write_meeting_trace_log'), false, `${at}: no call of the retired trace log command`);
          current.tags = logged.map(tagOf).sort();
          current.logCalls = logCalls.length - 1;
          current.logBytes = logged.reduce((sum, entry) => sum + bytesOf(JSON.stringify(entry)), 0);
          current.loss = raw.loss;
          assert.deepEqual(Object.values(raw.loss).filter(count => count !== 0), rejectLogEntries ? [logged.length - raw.logEntriesBeforeReject] : [],
            `${at}: nothing shed, refused or cut; with a rejecting sink the entries of the rejected batches are counted as not delivered`);
          // Recording writes exist exactly when a recording was on; the journal holds the facts that were delivered.
          assert.equal(raw.files.length > 0, recording, at);
          if (recording) {
            const recorded = JSON.parse(raw.files.find(([file]) => file === 'settings/meeting-assistant-settings.json')[1]);
            assert.equal(recorded.settings.diagnosticLogLevel, level, `${at}: the recording stores the setting it started with`);
            const journalled = raw.files.find(([file]) => file === JOURNAL)[1].split('\n').filter(Boolean).map(line => label(JSON.parse(line)));
            const delivered = current.facts.filter(fact => !fact.startsWith('<'));
            assert.deepEqual(journalled.slice(-delivered.length), delivered, `${at}: the journal ends with the facts the observer received`);
            assert.deepEqual(current.nativeStall.filter(request => request.enabled), [{ enabled: true, folderName: '<folder>' }],
              `${at}: Native Stall Diagnostics was armed for the recording`);
          } else {
            assert.equal(current.nativeStall.some(request => request.enabled), false, `${at}: nothing to arm without a recording`);
          }
          sessions += 1;
          return current;
        };
        // The default level twice: what two identical sessions do not share is this combination's session noise.
        const reference = await session('info');
        const again = await session('info');
        const byLevel = { info: reference };
        const noise = new Set(differing(reference.shaped, again.shaped));
        // An object whose keys, or an array whose size, differ between the two is keyed or sized by session noise: all of it is masked.
        const noisyParents = [...noise].flatMap(leaf => leaf.endsWith('#keys') ? [`${leaf.slice(0, -5)}/`] : leaf.endsWith('#length') ? [`${leaf.slice(0, -7)}[`] : []);
        const masked = leaf => noise.has(leaf) || noisyParents.some(parent => leaf.startsWith(parent));
        assert.deepEqual([again.facts, again.nativeStall, again.commandCounts], [reference.facts, reference.nativeStall, reference.commandCounts],
          `${cell}: two sessions at the same level agree on facts, diagnostics requests and command counts`);
        const maskedLeaves = [...reference.shaped.keys()].filter(masked).length;
        assert.ok(maskedLeaves * 5 < reference.shaped.size, `${cell}: the noise mask covers ${maskedLeaves} of ${reference.shaped.size} leaves`);
        for (const level of LEVELS.filter(candidate => candidate !== 'info')) {
          const at = `${cell} level=${level}`;
          const current = await session(level);
          byLevel[level] = current;
          assert.deepEqual(current.facts, reference.facts, `${at}: the 178A facts and their order`);
          assert.deepEqual(current.nativeStall, reference.nativeStall, `${at}: the Native Stall Diagnostics requests`);
          assert.deepEqual(current.commandCounts, reference.commandCounts, `${at}: the native commands and how often each was called`);
          assert.equal(current.fileCount, reference.fileCount, `${at}: the number of recorded files`);
          const moved = differing(reference.shaped, current.shaped).filter(leaf => !masked(leaf));
          assert.deepEqual(moved.slice(0, 12).map(leaf => `${leaf}: ${JSON.stringify(reference.shaped.get(leaf))} -> ${JSON.stringify(current.shaped.get(leaf))}`), [],
            `${at}: ${moved.length} leaves differ from level=info beyond the session noise`);
        }
        // LG1: the level filters and does nothing else. The entries of the session at each level are the entries of
        // the session at trace that pass that level, tag for tag; two sessions at info log the same.
        assert.deepEqual(again.tags, reference.tags, `${cell}: two sessions at info log the same entries`);
        for (const level of LEVELS) {
          assert.deepEqual(byLevel[level].tags, byLevel.trace.tags.filter(tag => passes(level, tag.split(' ')[0])), `${cell} level=${level}: the entries at trace that pass the level`);
        }
        // One more session of the combination with every switch on, at trace, where native rejects the batch that
        // carries the turn's entry after it confirmed the apply. No call site reads a delivery result: the session is
        // what it is at info with a working sink, and the same entry was handed over (checked in `session`).
        if (debug && recording && crossChecks) {
          const at = `${cell} level=trace with the log entries rejected`;
          const current = await session('trace', true);
          assert.deepEqual(current.tags, byLevel.trace.tags, `${at}: the same entries were handed over`);
          assert.deepEqual(current.facts, reference.facts, `${at}: the 178A facts and their order`);
          assert.deepEqual(current.nativeStall, reference.nativeStall, `${at}: the Native Stall Diagnostics requests`);
          assert.deepEqual(current.commandCounts, reference.commandCounts, `${at}: the native commands and how often each was called`);
          assert.equal(current.fileCount, reference.fileCount, `${at}: the number of recorded files`);
          const moved = differing(reference.shaped, current.shaped).filter(leaf => !masked(leaf));
          assert.deepEqual(moved.slice(0, 12).map(leaf => `${leaf}: ${JSON.stringify(reference.shaped.get(leaf))} -> ${JSON.stringify(current.shaped.get(leaf))}`), [],
            `${at}: ${moved.length} leaves differ from level=info beyond the session noise`);
        }
        child.diagnostic(`LG2 ${cell}: five levels identical over ${reference.shaped.size} leaves (${maskedLeaves} masked as session noise); ` +
          `facts=${reference.facts.length} requests=${reference.shaped.get('/requests#length')} ` +
          `recordedFiles=${reference.fileCount} recordingWrites=${reference.commandCounts.write_meeting_session_recording_text ?? 0} ` +
          `log entries/calls/bytes by level: ${LEVELS.map(level => `${level}=${byLevel[level].tags.length}/${byLevel[level].logCalls}/${byLevel[level].logBytes}`).join(' ')}`);
      });
    }
    if (!only || only.includes('two-turns')) {
      await t.test('GG178 dynamic settings preserve the actual second Provider input against no action',
        child => levelChangeBetweenTwoTurns(child, bundle, browser));
    }
    if (!only || only.includes('lg8')) {
      await t.test('LG8 the scripted Voice and Screen turns at five levels with Debug Mode on and off: entries, calls and bytes per turn next to the old one-call-per-line printing, queue peak and shed counts',
        child => costOfScriptedTurns(child, bundle, browser));
    }
  } finally { await browser.close(); }
  if (!only) assert.equal(sessions, 49, 'eight combinations, six sessions each (info twice and the four other levels), and one with the log entries rejected');
});
