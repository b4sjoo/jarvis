import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { browserBundle, openProjectSelectionBrowserHost, playwright, browserTestSkip }
  from "./project-selection-hook-browser.test.mjs";

// Read-only observation in the test bundle; all actions use the exported Hook.
const observer = { name: "correction-plan-observer", setup(builder) {
  builder.onLoad({ filter: /useMeetingAssistant\.ts$/ }, args => {
    const source = readFileSync(args.path, "utf8");
    const file = ts.createSourceFile(args.path, source, ts.ScriptTarget.Latest, true);
    const hook = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "useMeetingAssistant");
    const returns = hook.body.statements.filter(ts.isReturnStatement);
    assert.equal(returns.length, 1);
    const at = returns[0].getStart(file);
    const observation = `window.__cb174 = {
      context: () => contextManagerRef.current.getState(),
      traces: () => traceStoreRef.current.getObserverSnapshot(),
      sources: () => effectiveQuestionSourceLedgerRef.current.list(),
      settlement: () => currentQuestionSettlementRef.current,
      stream: runtimeCriticalEventStreamRef.current
    };\n`;
    return { contents: source.slice(0, at) + observation + source.slice(at), loader: "ts", resolveDir: path.dirname(args.path) };
  });
} };

const question = "Implement an LRU cache.";
async function mount(t, bundle, browser, source = "voice", initial = {}) {
  const host = await openProjectSelectionBrowserHost(t, bundle, browser,
    { source, surface: "normal" }, { mountOnly: true, memory: [],
      settings: { useMemory: false, runtimeCrossChecksEnabled: false, personalEvidenceGuardrailMode: "shadow" } });
  await host.page.evaluate(initial => {
    window.__case = { ...initial, requests: [], events: [], hold: false };
    const oldInvoke = window.__s63.invoke;
    window.__s63.invoke = async (name, args) => {
      if (name === "evaluation_store_append") {
        window.__s63.calls.push({ name, args });
        return structuredClone(args.input);
      }
      return oldInvoke(name, args);
    };
    window.fetch = async (url, init) => {
      assertFixtureUrl(url);
      const config = { ...window.__case };
      const body = JSON.parse(init.body);
      const system = body.messages.find(item => item.role === "system").content;
      const user = JSON.stringify(body.messages.filter(item => item.role !== "system"));
      const request = { system, user };
      window.__case.requests.push(request);
      let value;
      if (system.includes("Classify only the question type")) {
        request.kind = "type";
        value = JSON.stringify({ v: 1, t: config.type, c: 1, e: config.question });
      } else if (system.includes("Return exactly the fields v,d,c,t,r")) {
        request.kind = "ro"; value = '{"v":4,"d":"o","c":1,"t":[0],"r":"ask"}';
      } else if (system.startsWith("Decide one thing only: whether the current interviewer question depends")) {
        request.kind = "affinity";
        value = JSON.stringify({ v: 1, d: "i", c: 1, q: config.question, b: null });
      } else if (system.startsWith("Classify one canonical relationship")) {
        request.kind = "canonical";
        value = JSON.stringify({ schemaVersion: 3, relation: "new-parent", confidence: 1,
          currentQuestionEvidenceSpans: [config.question], parentEvidenceSpans: [] });
      } else if (system.startsWith("You are a fast metadata extractor")) {
        request.kind = "preflight";
        value = JSON.stringify({ question: config.question, focusedEvidenceSummary: null, questionType: config.type,
          askFrame: "hypothetical-design", topicDomain: "algorithms", projectAnchor: null, programmingLanguage: "Python",
          confidence: 1, isBehavioralInterview: false, amazonLeadershipPrinciple: null });
      } else if (system.startsWith("You are a live meeting co-pilot") || system.startsWith("You are Jarvis, a private live meeting assistant")) {
        request.kind = "advisor";
        if (config.hold) await new Promise(resolve => { window.__case.release = resolve; });
        if (config.fail) throw Error("Controlled CB174 generation failure");
        value = `Answer: CB174 ${config.type} answer.\nApproach: Separate lookup from eviction.\nWhiteboard:\n\`\`\`mermaid\nflowchart LR\n  Request --> Store\n\`\`\`\nCode:\n\`\`\`python\nclass LRUCache:\n    pass\n\`\`\`\nComplexity: O(1).\nAnswer disposition: not-fact-dependent\nSupporting anchor IDs: -`;
      } else if (system.startsWith("Decide one thing only: whether questionText")) {
        request.kind = "visual";
        value = JSON.stringify({ schemaVersion: 2, decision: "not-visual", questionEvidenceSpans: [config.question], visualEvidenceSpans: [] });
      } else if (system.includes("whether the bounded answer") || system.startsWith("Judge whether answerText")) {
        request.kind = "resolution";
        value = '{"schemaVersion":2,"decision":"unclear","questionEvidenceSpans":[],"answerEvidenceSpans":[],"ambiguityReason":"controlled boundary"}';
      } else if (system.startsWith("Infer one meeting metadata field")) {
        request.kind = "metadata";
        value = '{"schemaVersion":1,"company":null,"confidence":0,"evidenceSpans":[],"abstainReason":"synthetic case"}';
      } else throw Error("Uncontrolled CB174 Provider: " + system.slice(0, 100));
      request.response = value;
      return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: value }, finish_reason: null }] }) +
        '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n',
        { headers: { "Content-Type": "text/event-stream" } });
    };
    function assertFixtureUrl(url) {
      if (String(url) !== "https://s63.fixture/provider") throw Error("External request denied: " + url);
    }
  }, { question, type: "coding", ...initial });
  assert.equal(await host.page.evaluate(() => window.__s63.meeting.startRuntimeRegressionRun()), true);
  await host.page.evaluate(() => window.__cb174.stream.subscribe(delivery => {
    if (delivery.kind === "event") window.__case.events.push(delivery.event);
  }));
  if (source === "screen") await host.page.evaluate(() => window.__s63.meeting.captureScreenContext());
  else assert.equal(await host.page.evaluate(() => window.__s63.meeting.submitRuntimeRegressionText(window.__case.question)), true);
  return host;
}

const snapshot = page => page.evaluate(() => ({
  parent: window.__cb174.context().taskRuntime.parent,
  sources: window.__cb174.sources(), settlement: window.__cb174.settlement(),
  traces: window.__cb174.traces(), display: window.__s63.observed.adviseDisplay,
  events: window.__case.events, requests: window.__case.requests,
  error: window.__s63.meeting.error, calls: window.__s63.calls,
}));
async function correct(page, { ingress = "ui", intent = "retype-parent", hold = false, fail = false } = {}) {
  await page.evaluate(({ ingress, intent, hold, fail }) => {
    window.__case.type = "general-system-design";
    window.__case.hold = hold; window.__case.fail = fail;
    const displayTarget = window.__s63.observed.adviseDisplay.target;
    const menu = window.__s63.meeting.readManualCorrectionMenu("general-system-design", displayTarget);
    const option = menu.options.find(item => item.id === intent || item.intent.kind === intent);
    if (!option) throw Error("Missing correction option: " + intent);
    window.__case.correction = window.__s63.meeting.correctActiveQuestionType("general-system-design", "normal-mode",
      { displayTarget, correctionTarget: menu.target, correctionIntent: option.intent, ingressSource: ingress });
  }, { ingress, intent, hold, fail });
  if (hold) await page.waitForFunction(() => Boolean(window.__case.release));
  else await page.evaluate(() => window.__case.correction);
}
const lifecycle = state => state.events.filter(event => event.fact === "lifecycle-committed" &&
  ["create-parent", "replace-parent", "attach-child", "resume-parent", "set-phase"].includes(event.refs.transition));

test("CB174 committed Correction Plan through generation consumers", { timeout: 180000, skip: browserTestSkip }, async t => {
  const bundle = await browserBundle([observer]);
  const browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.JARVIS_CHROMIUM_EXECUTABLE });
  async function run(name, execute, source = "voice", initial = {}) {
    await t.test(name, async child => {
      const host = await mount(child, bundle, browser, source, initial);
      try {
        const before = await snapshot(host.page);
        assert.ok(before.parent && before.display.stable, "initial source creates an owner and a visible Stable Answer");
        await execute(host.page, before);
        assert.deepEqual(host.failures, []);
        assert.deepEqual(await host.page.evaluate(() => window.__s63.unexpected), []);
      } finally {
        await host.page.evaluate(async () => { window.__case.release?.(); await window.__s63.meeting.stopRuntimeRegressionRun(); });
        await host.context.close();
      }
    });
  }
  try {
    for (const source of ["voice", "screen"]) for (const ingress of ["ui", "replay"]) {
      await run(`${source}/${ingress}: one same-ID retype, stable origin, new visible answer and one Next`, async (page, before) => {
        const mark = before.events.length;
        await correct(page, { ingress });
        const after = await snapshot(page);
        assert.equal(after.error, null);
        assert.equal(after.parent.id, before.parent.id);
        assert.equal(after.parent.stableKind, "general-system-design");
        assert.equal(after.parent.sourceQuestionUnitId, before.parent.sourceQuestionUnitId);
        assert.equal(after.settlement.relation, "new-parent");
        assert.equal(after.parent.playbookPhase, "requirement_clarification");
        assert.deepEqual(lifecycle({ events: after.events.slice(mark) }).map(event => event.refs.transition), ["replace-parent"]);
        const generation = after.traces.find(trace => trace.metadata?.manualCorrectionCommittedPlanId && trace.metadata.advisorStablePublicationCommitted);
        assert.ok(generation, "the replacement answer is really published, not just a corrected Type");
        assert.equal(after.display.target.traceId, generation.id);
        assert.equal(generation.metadata.settledExecutionPlanPostMutationParentId, before.parent.id);
        assert.equal(generation.metadata.taskBoundaryCommittedBeforeAdvisor, undefined);
        assert.equal(generation.metadata.settledExecutionPlanTaskMutationCommittedBeforeAdvisor, true);
        assert.equal(generation.metadata.taskLifecycleParentAfterRevision, generation.metadata.taskLifecycleParentBeforeRevision + 1);
        assert.equal(after.requests.slice(before.requests.length).filter(request => ["type", "affinity", "canonical", "ro"].includes(request.kind)).length, 0);
        if (source === "screen") {
          assert.ok(after.sources.length);
          assert.deepEqual(after.sources.at(-1).sourceObservationIds, before.sources.at(-1).sourceObservationIds);
          assert.ok(after.requests.slice(before.requests.length).find(request => request.kind === "advisor").user.includes("data:image/png;base64,"));
        }
        if (ingress === "replay") assert.equal(after.calls.filter(call => call.name === "evaluation_store_append").length, 0);
        const phaseMark = after.events.length;
        await page.evaluate(() => window.__s63.meeting.applyResponseAction("next-phase", { uiSurface: "normal-mode" }));
        const next = await snapshot(page);
        assert.equal(next.error, null);
        assert.equal(next.parent.id, before.parent.id);
        assert.equal(next.parent.playbookPhase, "design_framing");
        assert.deepEqual(lifecycle({ events: next.events.slice(phaseMark) }).map(event => event.refs.transition), ["set-phase"]);
      }, source);
    }
    await run("independent intent creates exactly one new owner", async (page, before) => {
      await correct(page, { intent: "independent" });
      const after = await snapshot(page);
      assert.equal(after.error, null);
      assert.notEqual(after.parent.id, before.parent.id);
      assert.equal(after.parent.stableKind, "general-system-design");
      assert.equal(lifecycle({ events: after.events.slice(before.events.length) }).length, 1);
      assert.ok(after.traces.some(trace => trace.metadata?.manualCorrectionCommittedPlanId && trace.metadata.advisorStablePublicationCommitted));
    });
    await run("Term Correction re-infers and regenerates through its committed Plan", async (page, before) => {
      await page.evaluate(async () => {
        window.__case.type = "ai-ml-system-design";
        window.__case.question = "RAG";
        await window.__s63.meeting.submitSpeechCorrection("RAG not car-sharing");
      });
      const after = await snapshot(page);
      assert.equal(after.error, null);
      assert.equal(after.parent.id, before.parent.id);
      assert.equal(after.parent.stableKind, "ai-ml-system-design");
      assert.deepEqual(lifecycle({ events: after.events.slice(before.events.length) }).map(event => event.refs.transition), ["replace-parent"]);
      const generation = after.traces.find(trace => trace.metadata?.manualTermCorrectionId && trace.metadata.advisorStablePublicationCommitted);
      assert.ok(generation);
      assert.equal(after.display.target.traceId, generation.id);
      assert.equal(generation.metadata.settledExecutionPlanTaskMutationCommittedBeforeAdvisor, true);
    }, "voice", { question: "Design a car-sharing system.", type: "general-system-design" });
    await run("generation failure keeps corrected task and previous Stable Answer", async (page, before) => {
      await correct(page, { fail: true });
      const after = await snapshot(page);
      assert.ok(after.error);
      assert.equal(after.parent.id, before.parent.id);
      assert.equal(after.parent.stableKind, "general-system-design");
      assert.equal(after.display.stable.suggestion.id, before.display.stable.suggestion.id);
      assert.deepEqual(lifecycle({ events: after.events.slice(before.events.length) }).map(event => event.refs.transition), ["replace-parent"]);
    });
    for (const replacement of [false, true]) await run(`Clear while generation is held; replacement=${replacement}`, async (page, before) => {
      await correct(page, { hold: true });
      const committed = await snapshot(page);
      assert.equal(committed.parent.id, before.parent.id);
      assert.equal(committed.parent.stableKind, "general-system-design");
      const generation = committed.traces.find(trace => trace.metadata?.manualCorrectionCommittedPlanId && trace.id !== trace.metadata.taskLifecycleOperationId);
      assert.ok(generation);
      await page.evaluate(() => window.__s63.meeting.clearActiveTask());
      if (replacement) await page.evaluate(async () => {
        window.__case.hold = false; window.__case.type = "coding";
        window.__case.question = "Implement a stack with push and pop.";
        await window.__s63.meeting.submitRuntimeRegressionText(window.__case.question);
      });
      const safe = await snapshot(page);
      await page.evaluate(async () => { window.__case.release(); await window.__case.correction; });
      const after = await snapshot(page);
      assert.equal(after.parent?.id, safe.parent?.id);
      assert.equal(after.display.stable?.suggestion.id, safe.display.stable?.suggestion.id);
      assert.notEqual(after.traces.find(trace => trace.id === generation.id)?.metadata.advisorStablePublicationCommitted, true);
      assert.equal(lifecycle({ events: after.events.slice(safe.events.length) }).length, 0);
      if (replacement) assert.notEqual(after.parent.id, before.parent.id);
    });
  } finally { await browser.close(); }
});
