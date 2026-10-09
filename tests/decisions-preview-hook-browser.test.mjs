import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { browserBundle, openProjectSelectionBrowserHost, playwright, browserTestSkip } from "./project-selection-hook-browser.test.mjs";

const observer = { name: "decisions-read-only-observer", setup(builder) {
  builder.onLoad({ filter: /useMeetingAssistant\.ts$/ }, args => {
    const text = readFileSync(args.path, "utf8"), file = ts.createSourceFile(args.path, text, ts.ScriptTarget.Latest, true);
    const hook = file.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "useMeetingAssistant");
    const returns = hook.body.statements.filter(ts.isReturnStatement);assert.equal(returns.length, 1);
    const at = returns[0].getStart(file);
    return { loader: "ts", resolveDir: path.dirname(args.path), contents: text.slice(0, at) + `
      window.__preview = { context: () => contextManagerRef.current.getState(), unit: () => logicalQuestionUnitRef.current,
        traces: () => traceStoreRef.current.getObserverSnapshot(), enabled: () => decisionsRuntimeEnabledRef.current,
        policy: () => languagePolicyRef.current, stream: runtimeCriticalEventStreamRef.current };
    ` + text.slice(at) };
  });
} };

async function mount(t, bundle, browser) {
  const host = await openProjectSelectionBrowserHost(t, bundle, browser, { source: "voice", surface: "normal" },
    { mountOnly: true, memory: [], settings: { useMemory: false, runtimeCrossChecksEnabled: false, personalEvidenceGuardrailMode: "shadow" } });
  await host.page.evaluate(() => {
    const app = window.__s63;
    app.app.selectedDecisionsProvider = { provider: "openai-decisions", variables: { api_key: "synthetic-decisions-key" } };
    window.__protocol = { calls: [], type: "general-system-design", relation: "followup-parent", input: "Design a cache for a web service.", events: [], holdLanguage: false };
    window.fetch = async (url, init) => {
      const state = window.__protocol;
      const body = JSON.parse(init.body);
      if (String(url) === "https://api.openai.com/v1/decisions") {
        const name = body.questions[0].name;
        state.calls.push({ kind: name, body, protocol: "decisions" });
        if (name === "input_language" && state.holdLanguage) await new Promise(resolve => { state.releaseLanguage = resolve; });
        const choice = { input_language: "en", question_type: state.type, response_opportunity: "output-request",
          affinity: "related", canonical_relation: state.relation }[name];
        if (!choice) throw Error("Unexpected Decisions question: " + name);
        return new Response(JSON.stringify({ answers: [{ name, type: "choice", choice, confidence: .99,
          probabilities: [{ value: choice, probability: .7 }] }] }));
      }
      if (String(url) !== "https://s63.fixture/provider") throw Error("External network denied: " + url);
      const system = body.messages.find(m => m.role === "system").content;
      const user = body.messages.find(m => m.role === "user");
      const userText = typeof user.content === "string" ? user.content : user.content.filter(c => c.type === "text").map(c => c.text).join("\n");
      const call = { protocol: "legacy", system, input: userText };state.calls.push(call);
      let result;
      if (system.startsWith("The settled response decision")) { call.kind = "target";result = '{"t":[0]}'; }
      else if (system.startsWith("The supplied settledDecision")) {
        call.kind = "evidence";const input = JSON.parse(userText);
        result = JSON.stringify({ q: input.source.currentQuestion.sourceTexts[0].slice(0, 180),
          b: (input.source.activeParent?.topic ?? input.source.activeChild?.question).slice(0, 180) });
      } else if (system.includes("Classify only the question type")) { call.kind = "type";result = JSON.stringify({ v: 1, t: state.type, c: 1, e: state.input }); }
      else if (system.includes("Return exactly the fields v,d,c,t,r")) { call.kind = "ro";result = '{"v":4,"d":"o","c":1,"t":[0],"r":"ask"}'; }
      else if (system.startsWith("Decide one thing only: whether the current interviewer question depends")) {
        call.kind = "affinity";const input = JSON.parse(userText);
        result = JSON.stringify({ v: 1, d: "r", c: .7, q: input.currentQuestion.sourceTexts[0].slice(0, 180),
          b: (input.activeParent?.topic ?? input.activeChild?.question).slice(0, 180) });
      } else if (system.startsWith("Classify one canonical relationship")) {
        call.kind = "canonical";const input = JSON.parse(userText);
        result = JSON.stringify({ schemaVersion: 3, relation: state.relation, confidence: .7,
          currentQuestionEvidenceSpans: [input.currentQuestion.sourceTexts[0].slice(0, 180)], parentEvidenceSpans: [input.activeParent.topic.slice(0, 180)] });
      } else if (system.startsWith("You are a live meeting co-pilot") || system.startsWith("You are Jarvis, a private live meeting assistant")) {
        call.kind = "advisor";
        result = 'Answer: Use a bounded cache and measure hit rate.\nApproach: Compare memory cost and latency.\nWhiteboard:\n```mermaid\nflowchart LR\n  Client --> Cache\n```\nCode:\n```python\nclass Cache:\n    pass\n```\nComplexity: O(1).\nAnswer disposition: not-fact-dependent\nSupporting anchor IDs: -';
      } else if (system.startsWith("Decide one thing only: whether questionText")) {
        call.kind = "visual";result = JSON.stringify({ schemaVersion: 2, decision: "not-visual", questionEvidenceSpans: [state.input], visualEvidenceSpans: [] });
      } else if (system.includes("whether the bounded answer") || system.startsWith("Judge whether answerText")) {
        call.kind = "resolution";result = '{"schemaVersion":2,"decision":"unclear","questionEvidenceSpans":[],"answerEvidenceSpans":[],"ambiguityReason":"fixture"}';
      } else if (system.startsWith("Infer one meeting metadata field")) {
        call.kind = "metadata";result = '{"schemaVersion":1,"company":null,"confidence":0,"evidenceSpans":[],"abstainReason":"fixture"}';
      } else if (system.startsWith("You are a fast metadata extractor")) {
        call.kind = "preflight";result = JSON.stringify({ question: state.input, focusedEvidenceSummary: null, questionType: state.type,
          askFrame: "hypothetical-design", topicDomain: "backend", projectAnchor: null, programmingLanguage: "Python", confidence: 1,
          isBehavioralInterview: false, amazonLeadershipPrinciple: null });
      } else if (system.startsWith("Decide one thing only: whether the deliberate screen capture")) {
        call.kind = "source-linkage";const source = JSON.parse(userText);
        result = JSON.stringify({ schemaVersion: 1, decision: "use-screen", voiceEvidenceSpans: [], screenEvidenceSpans: [source.screenQuestion] });
      } else throw Error("Unexpected legacy model operation: " + system.slice(0, 100));
      return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: result }, finish_reason: null }] }) +
        '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
    };
    window.__s63.meeting.startRuntimeRegressionRun();
  });
  await host.page.waitForFunction(() => window.__preview.policy().provider.provider === "openai-decisions");
  await host.page.evaluate(() => window.__preview.stream.subscribe(delivery => {
    if (delivery.kind === "event") window.__protocol.events.push(delivery.event);
  }));
  return host;
}
async function input(page, text) {
  return page.evaluate(async text => { window.__protocol.input = text;return window.__s63.meeting.submitRuntimeRegressionText(text); }, text);
}
const snapshot = page => page.evaluate(() => ({ calls: window.__protocol.calls, events: window.__protocol.events,
  context: window.__preview.context(), traces: window.__preview.traces(), error: window.__s63.meeting.error }));

test("DR205 browser: Voice, Screen and Correction use one settlement chain", { skip: browserTestSkip }, async t => {
  const bundle = await browserBundle([observer]);
  const browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.JARVIS_CHROMIUM_EXECUTABLE });
  try {
    await t.test("Voice pipeline, switch freezing and rollback", async t => {
    const { page, context, failures } = await mount(t, bundle, browser);
    try {
      assert.equal(await input(page, "Design a cache for a web service."), true);
      let saved = await snapshot(page);const parentId = saved.context.taskRuntime.parent.id;
      assert.ok(saved.calls.some(c => c.kind === "type" && c.protocol === "legacy"));
      assert.ok(saved.calls.some(c => c.kind === "ro" && c.protocol === "legacy"));
      assert.equal(saved.calls.filter(c => c.protocol === "decisions" && c.kind !== "input_language").length, 0);
      await page.evaluate(() => { window.__s63.meeting.setDecisionsRuntimeEnabled(true);window.__protocol.calls = [];window.__protocol.events = []; });
      await page.waitForFunction(() => window.__preview.enabled());
      assert.equal(await input(page, "How would you handle eviction in this cache?"), true);
      saved = await snapshot(page);
      assert.equal(saved.context.taskRuntime.parent.id, parentId);
      for (const kind of ["question_type", "response_opportunity", "affinity", "canonical_relation"]) {
        assert.equal(saved.calls.filter(c => c.protocol === "decisions" && c.kind === kind).length, 1, kind);
      }
      assert.equal(saved.calls.filter(c => c.protocol === "legacy" && ["type", "ro", "affinity", "canonical"].includes(c.kind)).length, 0);
      assert.ok(saved.calls.some(c => c.kind === "target"));assert.ok(saved.calls.some(c => c.kind === "evidence"));
      assert.equal(saved.events.filter(e => e.fact === "relation-settled").at(-1)?.refs?.relation, "followup-parent");
      assert.doesNotMatch(JSON.stringify({ traces: saved.traces, events: saved.events }), /synthetic-decisions-key/);

      await page.evaluate(() => { window.__protocol.calls = [];window.__protocol.holdLanguage = true;
        window.__protocol.input = "How would you monitor this cache in production?";
        window.__pendingInput = window.__s63.meeting.submitRuntimeRegressionText(window.__protocol.input); });
      await page.waitForFunction(() => Boolean(window.__protocol.releaseLanguage));
      await page.evaluate(() => { window.__s63.meeting.setDecisionsRuntimeEnabled(false);window.__protocol.holdLanguage = false;window.__protocol.releaseLanguage(); });
      assert.equal(await page.evaluate(() => window.__pendingInput), true);
      saved = await snapshot(page);assert.ok(saved.calls.some(c => c.kind === "question_type" && c.protocol === "decisions"));
      await page.evaluate(() => { window.__protocol.calls = []; });
      assert.equal(await input(page, "What latency target would you set for this cache?"), true);
      saved = await snapshot(page);
      assert.equal(saved.calls.filter(c => c.protocol === "decisions" && c.kind !== "input_language").length, 0);
      assert.ok(saved.calls.some(c => c.kind === "type" && c.protocol === "legacy"));
      assert.equal(saved.context.taskRuntime.parent.id, parentId);
      assert.deepEqual(failures, []);
    } finally { await context.close(); }
    });

    await t.test("Screen and term resettlement; explicit human Type bypass", async t => {
    const { page, context, failures } = await mount(t, bundle, browser);
    try {
      await page.evaluate(() => window.__s63.meeting.setDecisionsRuntimeEnabled(true));
      await page.waitForFunction(() => window.__preview.enabled());
      assert.equal(await input(page, "Please design a car-sharing app."), true);
      let saved = await snapshot(page);const parentId = saved.context.taskRuntime.parent.id;
      await page.evaluate(async () => {
        window.__protocol.calls = [];window.__protocol.type = "ai-ml-system-design";
        await window.__s63.meeting.submitSpeechCorrection("RAG not car-sharing");
      });
      saved = await snapshot(page);
      assert.equal(saved.context.taskRuntime.parent.id, parentId);
      assert.equal(saved.context.taskRuntime.parent.stableKind, "ai-ml-system-design", JSON.stringify({ parent: saved.context.taskRuntime.parent, error: saved.error }));
      assert.ok(saved.calls.some(c => c.kind === "question_type" && c.protocol === "decisions"));
      assert.ok(saved.calls.some(c => c.kind === "affinity" && c.protocol === "decisions"));
      assert.equal(saved.calls.filter(c => c.protocol === "legacy" && ["type", "affinity", "canonical"].includes(c.kind)).length, 0);

      await page.evaluate(async () => {
        window.__protocol.calls = [];window.__protocol.type = "general-system-design";
        const displayTarget = window.__s63.observed.adviseDisplay.target;
        const menu = window.__s63.meeting.readManualCorrectionMenu("general-system-design", displayTarget);
        const choice = menu.options.find(option => option.intent.kind === "retype-parent");
        if (!choice) throw Error("Missing retype-parent option");
        await window.__s63.meeting.correctActiveQuestionType("general-system-design", "normal-mode", {
          displayTarget, correctionTarget: menu.target, correctionIntent: choice.intent,
        });
      });
      saved = await snapshot(page);
      assert.equal(saved.context.taskRuntime.parent.stableKind, "general-system-design");
      assert.equal(saved.calls.filter(c => c.protocol === "decisions").length, 0);

      await page.evaluate(async () => {
        window.__protocol.calls = [];window.__protocol.input = "Design a reconciliation service for payments.";
        await window.__s63.meeting.captureScreenContext();
      });
      saved = await snapshot(page);
      assert.equal(saved.error, null);
      assert.equal(saved.context.taskRuntime.parent.latestScreenObservationId, saved.context.screenObservations.at(-1)?.id);
      assert.equal(saved.context.taskRuntime.lastMutation.reason, "screen-answer-continuity-committed");
      assert.ok(saved.calls.some(c => c.kind === "preflight" && c.protocol === "legacy"));
      assert.ok(saved.calls.some(c => c.kind === "affinity" && c.protocol === "decisions"), JSON.stringify(saved.calls.map(c => [c.kind, c.protocol])));
      assert.ok(saved.calls.some(c => c.kind === "canonical_relation" && c.protocol === "decisions"));
      assert.equal(saved.calls.filter(c => ["input_language", "question_type", "response_opportunity"].includes(c.kind)).length, 0);
      assert.deepEqual(failures, []);
    } finally { await context.close(); }
    });
  } finally { await browser.close(); }
});
