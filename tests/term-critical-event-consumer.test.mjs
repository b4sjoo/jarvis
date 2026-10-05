import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { browserBundle, openProjectSelectionBrowserHost, playwright, browserTestSkip } from "./project-selection-hook-browser.test.mjs";
import { buildSessionProcedureV1 } from "../.tmp-tests/scripts/lib/session-procedure.js";

const EXECUTION = { executionId: "AET", caseId: "AET", surface: "normal", source: "voice", behavior: "success" };
function plugin(baseline) {
  return { name: "aet-test-observer", setup(builder) {
    builder.onLoad({ filter: /useMeetingAssistant\.ts$/ }, args => {
      const text = baseline ? execFileSync("git", ["show", `${baseline}:src/hooks/useMeetingAssistant.ts`], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }) : readFileSync(args.path, "utf8");
      const ast = ts.createSourceFile(args.path, text, ts.ScriptTarget.Latest, true);
      const hook = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "useMeetingAssistant");
      const returns = hook.body.statements.filter(ts.isReturnStatement);
      assert.equal(returns.length, 1);
      const at = returns[0].getStart(ast);
      return { loader: "ts", resolveDir: path.dirname(args.path), contents: text.slice(0, at) +
        "window.__aet={stream:runtimeCriticalEventStreamRef.current,lqu:logicalQuestionUnitRef,epoch:runtimeEpochRef,context:contextManagerRef};\n" + text.slice(at) };
    });
  } };
}
async function mount(t, bundle, browser, settings = {}, answered = false) {
  const host = await openProjectSelectionBrowserHost(t, bundle, browser, EXECUTION, { mountOnly: !answered, settings });
  await host.page.evaluate(() => {
    window.__aetEvents = [];
    window.__aetSubscription = window.__aet.stream.subscribe(item => {
      if (item.kind === "event") window.__aetEvents.push(item.event);
    });
  });
  return host;
}
async function collect(page) {
  await page.waitForTimeout(50);
  return page.evaluate(() => ({
    events: window.__aetEvents,
    rules: window.__s63.meeting.speechCorrections,
    lqu: window.__aet.lqu.current,
    error: window.__s63.meeting.error,
    requests: window.__s63.requests.length,
    advisorRequests: window.__s63.requests.filter(request => request.system.startsWith("You are a live meeting co-pilot") ||
      request.system.startsWith("You are Jarvis, a private live meeting assistant")).length,
    unexpected: window.__s63.unexpected,
    stats: window.__aet.stream.getStats(),
    journal: window.__s63.calls.filter(call => call.name === "write_meeting_session_recording_text" &&
      call.args.relativePath === "runtime-events/critical-events.v1.jsonl")
      .flatMap(call => call.args.payload.split("\n").filter(Boolean).map(line => JSON.parse(line))),
  }));
}
const manual = rows => rows.filter(row => row.refs.manualAction === "term-correction" || row.refs.manualAction === "stop-term-replacement");
const terminals = rows => manual(rows).filter(row => row.fact === "terminal");

test("AET actual Term entry points emit original outcomes without changing their business effects", { timeout: 300000, skip: browserTestSkip }, async t => {
  const bundle = await browserBundle([plugin()]);
  const browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.JARVIS_CHROMIUM_EXECUTABLE });
  try {
    await t.test("AET1 invalid, future-only, stop and duplicate stop have distinct action terminals", async child => {
      const { page, context, failures } = await mount(child, bundle, browser);
      try {
        await page.evaluate(async () => {
          await window.__s63.meeting.submitSpeechCorrection(" ");
          await window.__s63.meeting.submitSpeechCorrection("responsibility not contribution");
        });
        const saved = await collect(page);
        assert.equal(saved.requests, 0);
        assert.equal(saved.rules.length, 1);
        assert.deepEqual(terminals(saved.events).map(e => [e.stage, e.terminal.disposition, e.terminal.reason]), [
          ["manual-action-terminal", "rejected", "invalid-term-correction"],
          ["future-speech-bias", "completed", "future-rule-stored"],
        ]);
        await page.evaluate(async id => {
          await window.__s63.meeting.deactivateSpeechCorrection(id);
          await window.__s63.meeting.deactivateSpeechCorrection(id);
          await window.__s63.meeting.deactivateSpeechCorrection("missing-rule");
        }, saved.rules[0].id);
        const stopped = await collect(page);
        assert.equal(terminals(stopped.events).length, 5);
        assert.equal(new Set(terminals(stopped.events).map(e => e.refs.manualActionId)).size, 5);
        assert.deepEqual(terminals(stopped.events).slice(2).map(e => e.terminal.disposition), ["completed", "rejected", "rejected"]);
        assert.equal(manual(stopped.events).filter(e => e.fact === "input-accepted").length, 2);
        assert.equal(stopped.events.some(e => e.fact === "stable-answer-committed" || e.fact === "first-visible-content"), false);
        assert.equal(stopped.requests, 0);
        assert.ok(stopped.rules[0].deactivatedAt);
        assert.deepEqual(failures, []);
      } finally { await context.close(); }
    });

    for (const mode of ["success", "provider-failure", "cancelled", "new-session", "stop", "new-recording", "reversal-source-missing"]) {
      await t.test(`AET2/3 active correction ${mode}`, async child => {
        const { page, context, failures } = await mount(child, bundle, browser, {}, true);
        try {
          const before = await collect(page);
          await page.evaluate(mode => {
            const fetch = window.fetch;
            window.fetch = async (url, init) => {
              const system = JSON.parse(init.body).messages.find(m => m.role === "system")?.content ?? "";
              if (system.startsWith("You are a live meeting co-pilot") || system.startsWith("You are Jarvis, a private live meeting assistant")) {
                if (mode === "provider-failure") return new Response(JSON.stringify({ error: { message: "AET controlled unavailable" } }), { status: 503 });
                if (["cancelled", "new-session", "stop", "new-recording"].includes(mode)) {
                  window.__aetHeld = true;
                  await new Promise(resolve => { window.__aetRelease = resolve; });
                }
              }
              return fetch(url, init);
            };
            window.__aetCorrection = window.__s63.meeting.submitSpeechCorrection("responsibility not contribution");
          }, mode);
          if (["cancelled", "new-session", "stop", "new-recording"].includes(mode)) {
            await page.waitForFunction(() => window.__aetHeld, undefined, { timeout: 15000 });
            if (mode === "new-recording") {
              await page.evaluate(() => window.__s63.meeting.setSessionRecordingEnabled(false));
              await page.waitForFunction(() => window.__s63.meeting.sessionRecording.lifecycle === "idle", undefined, { timeout: 10000 });
              await page.evaluate(() => window.__s63.meeting.setSessionRecordingEnabled(true));
              await page.waitForFunction(() => window.__s63.meeting.sessionRecording.active, undefined, { timeout: 10000 });
            }
            await page.evaluate(async mode => {
              // Controlled identity fault at the original async boundary. No production hook is added.
              if (mode === "cancelled" || mode === "new-session") window.__aet.epoch.current += 1;
              if (mode === "new-session") {
                window.__aet.context.current.getState().sessionId = "AET-new-session";
                window.__aet.stream.bind("AET-new-session");
              }
              const stopping = mode === "stop" ? window.__s63.meeting.stopRuntimeRegressionRun() : undefined;
              window.__aetRelease();
              await stopping;
            }, mode);
          }
          await page.evaluate(() => window.__aetCorrection);
          const after = await collect(page);
          assert.ok(after.events.some(event => event.fact === "lqu-committed" && event.refs.logicalQuestionUnitId === before.lqu.id &&
            event.refs.logicalQuestionRevision > before.lqu.revision), "the correction revision committed before generation ended");
          if (mode === "stop" || mode === "new-recording") assert.equal(after.lqu, undefined, "Runner Stop retains its original current-LQU cleanup");
          else {
            assert.equal(after.lqu.id, before.lqu.id);
            assert.ok(after.lqu.revision > before.lqu.revision);
          }
          const own = terminals(after.events);
          if (mode === "new-session" || mode === "stop" || mode === "new-recording") {
            assert.equal(own.length, 0, "a changed session or stopped subscriber does not receive the late terminal");
          } else {
            assert.equal(own.length, 1);
            assert.equal(own[0].terminal.disposition, mode === "provider-failure" ? "failed" : mode === "cancelled" ? "cancelled" : "completed");
            assert.equal(own[0].runtimeEpoch, manual(after.events)[0].runtimeEpoch);
            assert.equal(own[0].refs.logicalQuestionRevision, after.lqu.revision);
          }
          if (mode === "new-recording") {
            const acceptedId = manual(after.events).find(event => event.fact === "input-accepted").refs.manualActionId;
            assert.equal(after.journal.some(event => event.refs.manualActionId === acceptedId && event.fact === "terminal"), false,
              "the old trace terminal cannot enter the new recording generation");
            assert.ok(after.stats.staleSessionRejected > 0, JSON.stringify(after.stats));
          }
          if (mode === "success") {
            const priorRequests = after.advisorRequests, priorRevision = after.lqu.revision;
            await page.evaluate(() => window.__s63.meeting.submitSpeechCorrection("responsibility not contribution"));
            const duplicate = await collect(page);
            assert.equal(duplicate.advisorRequests, priorRequests, JSON.stringify(terminals(duplicate.events).map(e => e.terminal)));
            assert.equal(duplicate.lqu.revision, priorRevision, JSON.stringify(duplicate.lqu.termCorrectionOverlays));
            assert.equal(terminals(duplicate.events).at(-1).terminal.reason, "already-applied");
          }
          if (mode === "success" || mode === "reversal-source-missing") {
            if (mode === "reversal-source-missing") await page.evaluate(id => {
              // This fault concerns an STT source already normalized by the saved rule, not just a manual overlay.
              window.__aet.lqu.current = { ...window.__aet.lqu.current,
                sources: window.__aet.lqu.current.sources.map(source => ({ ...source,
                  appliedSpeechCorrectionIds: [id], preNormalizationText: undefined })) };
            }, after.rules[0].id);
            await page.evaluate(id => window.__s63.meeting.deactivateSpeechCorrection(id), after.rules[0].id);
            const deactivated = await collect(page);
            const last = terminals(deactivated.events).at(-1);
            assert.equal(last.refs.manualAction, "stop-term-replacement");
            assert.equal(last.terminal.disposition, "completed");
            assert.equal(last.stage, mode === "success" ? "current-lqu-reversed" : "future-rule-deactivated");
            if (mode === "reversal-source-missing") {
              assert.equal(last.terminal.reason, "source-pre-normalization-text-missing");
              assert.match(deactivated.error, /Future replacement was stopped/);
            }
            assert.ok(deactivated.rules[0].deactivatedAt);
          }
          assert.deepEqual(failures, []);
        } finally { await context.close(); }
      });
    }
    await t.test("AET original pre-result internal error still propagates, with no invented success", async child => {
      const { page, context } = await mount(child, bundle, browser);
      try {
        const failure = await page.evaluate(async () => {
          window.__aet.context.current.clearExpiredActiveMeetingTask = () => { throw new Error("AET original invariant failure"); };
          try { await window.__s63.meeting.submitSpeechCorrection("RAG not rec"); return "unexpected-success"; }
          catch (error) { return error.message; }
        });
        assert.equal(failure, "AET original invariant failure");
        assert.equal(terminals((await collect(page)).events).length, 0);
      } finally { await context.close(); }
    });
  } finally { await browser.close(); }
});

async function isolatedCorrection(t, bundle, browser, settings, recording, fault = "none") {
  // Runner startup requires Debug; switch to the measured mode only after the source exists.
  const { page, context, failures } = await mount(t, bundle, browser, { ...settings, debugMode: true }, true);
  try {
    await page.evaluate(debug => window.__s63.meeting.setDebugMode(debug), settings.debugMode);
    await page.waitForFunction(debug => window.__s63.meeting.settings.debugMode === debug, settings.debugMode);
    if (!recording) {
      await page.evaluate(() => window.__s63.meeting.setSessionRecordingEnabled(false));
      await page.waitForFunction(() => !window.__s63.meeting.sessionRecording.active &&
        window.__s63.meeting.sessionRecording.lifecycle === "idle", undefined, { timeout: 10000 });
    }
    await page.evaluate(fault => {
      if (fault === "no-observer") window.__aetSubscription.unsubscribe();
      if (fault === "observer-throw") window.__aet.stream.subscribe(() => { throw new Error("AET observer failure"); });
      if (fault === "write-failure") {
        const invoke = window.__s63.invoke;
        window.__s63.invoke = (name, args = {}) => {
          if (name === "write_meeting_session_recording_text" && args.relativePath === "runtime-events/critical-events.v1.jsonl") {
            window.__aetWriteFailures = (window.__aetWriteFailures ?? 0) + 1;
            return Promise.reject(new Error("AET event append failure"));
          }
          return invoke(name, args);
        };
      }
    }, fault);
    await page.evaluate(() => window.__s63.meeting.submitSpeechCorrection("responsibility not contribution"));
    await page.waitForTimeout(500);
    const result = await page.evaluate(() => {
      const host = window.__s63, meeting = host.meeting, unit = window.__aet.lqu.current;
      const rule = meeting.speechCorrections[0];
      const parent = meeting.taskRuntime.parent;
      return {
        business: { error: meeting.error, type: parent?.questionType, phase: parent?.playbookPhase,
          parentRevision: parent?.revisions, lquRevision: unit?.revision, text: unit?.normalizedText,
          answer: meeting.latestSuggestion?.content, correction: { from: rule.from, to: rule.to,
            disposition: rule.activeQuestion?.disposition, regenerationStatus: rule.activeQuestion?.regenerationStatus },
          requests: host.requests.map(request => ({ family: request.system.split("\n")[0], images: request.imageUrls.length })).sort((a,b) => a.family.localeCompare(b.family)),
        },
        events: window.__aetEvents, stats: window.__aet.stream.getStats(),
        writes: [...host.writes.entries()], failedWrites: window.__aetWriteFailures ?? 0,
        recording: meeting.sessionRecording,
      };
    });
    assert.deepEqual(failures, []);
    return result;
  } finally { await context.close(); }
}

test("AET4/5 original business path, switches and Procedure survive observation changes", { timeout: 300000, skip: browserTestSkip }, async t => {
  const current = await browserBundle([plugin()]);
  // Acceptance can opt into a frozen parent; ordinary tests do not require Git history.
  const before = process.env.AET_BASELINE ? await browserBundle([plugin(process.env.AET_BASELINE)]) : current;
  t.diagnostic(`AET comparison baseline=${process.env.AET_BASELINE ?? "current repeated run"}`);
  const browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.JARVIS_CHROMIUM_EXECUTABLE });
  try {
    for (const debugMode of [false, true]) for (const runtimeCrossChecksEnabled of [false, true]) for (const recording of [false, true]) {
      await t.test(`AET4 debug=${debugMode} crossChecks=${runtimeCrossChecksEnabled} recording=${recording}`, async child => {
        const settings = { debugMode, runtimeCrossChecksEnabled };
        const baseline = await isolatedCorrection(child, before, browser, settings, recording);
        const now = await isolatedCorrection(child, current, browser, settings, recording);
        assert.deepEqual(now.business, baseline.business, "actual original/current Hook business effects and Provider operations agree");
        assert.equal(now.business.correction.regenerationStatus, "succeeded");
        assert.equal(terminals(now.events).length, 1);
        assert.equal(terminals(now.events)[0].terminal.disposition, "completed");
        const jsonl = (run, name) => (run.writes.find(([file]) => file === name)?.[1] ?? "").split("\n").filter(Boolean).map(line => JSON.parse(line));
        const termRows = jsonl(now, "runtime-events/critical-events.v1.jsonl").filter(event =>
          event.refs?.manualActionId === terminals(now.events)[0].refs.manualActionId);
        assert.equal(termRows.length, recording ? 2 : 0, "recording follows its own switch; in-memory facts do not");
        if (recording) {
          const procedure = run => buildSessionProcedureV1({ recordingSessionId: "fixture", folderName: "fixture", sourceDigest: "fixture",
            scriptedValidation: true, forcedScripted: true, timelineEvents: jsonl(run, "timeline.jsonl"),
            transcriptTurns: [], manualActions: [], humanEvaluationProjections: [] });
          const inputs = run => procedure(run).steps.filter(step => step.kind === "term-correction").map(step => step.input);
          assert.deepEqual(inputs(now), inputs(baseline), "original compiler still consumes one specialized correction input");
          assert.equal(inputs(now).length, 1);
        }
        child.diagnostic(`AET events=${manual(now.events).length} queuePeak=${now.stats.queuePeak} maxPayload=${Math.max(...manual(now.events).map(event => JSON.stringify(event).length))}`);
      });
    }
    const settings = { debugMode: false, runtimeCrossChecksEnabled: false };
    const reference = await isolatedCorrection(t, current, browser, settings, true);
    for (const fault of ["no-observer", "observer-throw", "write-failure"]) {
      await t.test(`AET4 ${fault}`, async child => {
        const result = await isolatedCorrection(child, current, browser, settings, true, fault);
        assert.deepEqual(result.business, reference.business);
        if (fault === "write-failure") assert.ok(result.failedWrites > 0);
        if (fault === "observer-throw") assert.ok(result.stats.subscriberFailures > 0);
      });
    }
  } finally { await browser.close(); }
});
