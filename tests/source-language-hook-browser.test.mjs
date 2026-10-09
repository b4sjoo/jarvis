import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { browserBundle, openProjectSelectionBrowserHost, playwright, browserTestSkip, fixtures } from "./project-selection-hook-browser.test.mjs";

const observer = { name: "language-source-read-only-observer", setup(builder) {
  builder.onLoad({ filter: /useMeetingAssistant\.ts$/ }, args => {
    const text = readFileSync(args.path, "utf8");
    const file = ts.createSourceFile(args.path, text, ts.ScriptTarget.Latest, true);
    const hook = file.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "useMeetingAssistant");
    const returns = hook.body.statements.filter(ts.isReturnStatement);assert.equal(returns.length, 1);
    const at = returns[0].getStart(file);
    return { loader: "ts", resolveDir: path.dirname(args.path), contents: text.slice(0, at) + `
      window.__language = {
        context: () => contextManagerRef.current.getState(), raw: () => contextManagerRef.current.getDisplayTranscriptTurns(),
        unit: () => logicalQuestionUnitRef.current, policy: () => languagePolicyRef.current,
        setup: () => latestSourceOwnedSetupRef.current, section: () => pendingInterviewSectionHintRef.current,
        observation: () => sessionLanguageObservationRef.current,
      };
    ` + text.slice(at) };
  });
} };

test("LA135 browser: real Hook excludes all context consumers, preserves raw, restores only Force target, and checks a term revision before mutation", { skip: browserTestSkip }, async t => {
  const bundle = await browserBundle([observer]);
  const browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.JARVIS_CHROMIUM_EXECUTABLE });
  try {
    const { page, context, failures } = await openProjectSelectionBrowserHost(t, bundle, browser,
      { source: "voice", surface: "normal" }, { mountOnly: true, memory: [], settings: { useMemory: false, runtimeCrossChecksEnabled: false } });
    try {
      await page.evaluate(() => {
        window.__s63.app.selectedDecisionsProvider = { provider: "openai-decisions", variables: { api_key: "synthetic-openai" } };
        window.__languageChoice = "other";window.__languageRequests = [];
        const original = window.fetch;
        window.fetch = async (url, init) => {
          if (String(url) !== "https://api.openai.com/v1/decisions") return original(url, init);
          const body = JSON.parse(init.body);window.__languageRequests.push(body);
          return new Response(JSON.stringify({ answers: [{ name: "input_language", type: "choice", choice: window.__languageChoice, confidence: .8 }] }));
        };
        window.__s63.meeting.startRuntimeRegressionRun();
      });
      await page.waitForFunction(() => window.__language.policy().provider.provider === "openai-decisions");
      for (const text of ["これは前の質問です。", "これは別の質問です。"]) {
        assert.equal(await page.evaluate(text => window.__s63.meeting.submitRuntimeRegressionText(text), text), true);
      }
      const rejected = await page.evaluate(() => ({ raw: window.__language.raw(), context: window.__language.context(),
        lqu: window.__language.unit(), setup: window.__language.setup(), section: window.__language.section(),
        requests: window.__s63.requests, languageRequests: window.__languageRequests }));
      assert.equal(rejected.raw.length, 2);assert.equal(rejected.context.transcriptTurns.length, 0);
      assert.equal(rejected.lqu, undefined);assert.equal(rejected.setup, undefined);assert.equal(rejected.section, undefined);
      assert.equal(rejected.context.taskRuntime.parent, undefined);assert.equal(rejected.requests.length, 0);
      assert.equal(rejected.languageRequests.length, 2);
      await page.evaluate(() => window.__s63.meeting.forceAdviseLatestTurn());
      const forced = await page.evaluate(() => ({ context: window.__language.context(), raw: window.__language.raw(),
        target: window.__s63.meeting.latestInterviewerTurnCandidate, requests: window.__s63.requests,
        languageRequests: window.__languageRequests }));
      assert.deepEqual(forced.context.transcriptTurns.map(t => t.text), ["これは別の質問です。"]);
      assert.equal(forced.raw[0].languageAdmission.manualOverride, undefined);
      assert.equal(forced.raw[1].languageAdmission.manualOverride, "force-advise");
      assert.equal(forced.languageRequests.length, 2);
      assert.ok(forced.requests.some(r => r.system.startsWith("You are a live meeting co-pilot") || r.system.startsWith("You are Jarvis, a private live meeting assistant")));
      await page.evaluate(() => { window.__languageChoice = "en"; });
      assert.equal(await page.evaluate(text => window.__s63.meeting.submitRuntimeRegressionText(text), fixtures.S63_SOURCE_QUESTION), true);
      const before = await page.evaluate(() => ({ unit: window.__language.unit(), runtime: window.__language.context().taskRuntime,
        observation: window.__language.observation() }));
      assert.ok(before.unit);assert.ok(before.runtime.parent);
      assert.ok(before.observation, JSON.stringify({ receipt: before.unit.sourceLanguageAdmission,
        parentSourceIds: before.runtime.parent.canonicalQuestionSourceTurnIds, parentId: before.runtime.parent.id }));
      assert.equal(before.observation.language, "en");assert.equal(before.observation.parentId, before.runtime.parent.id);
      await page.evaluate(() => { window.__languageChoice = "other"; });
      assert.equal(await page.evaluate(() => window.__s63.meeting.submitRuntimeRegressionText("これは新しい質問です。")), true);
      const preserved = await page.evaluate(() => ({ unit: window.__language.unit(), runtime: window.__language.context().taskRuntime,
        observation: window.__language.observation() }));
      assert.deepEqual(preserved, before);
      await page.evaluate(async () => { window.__languageChoice = "other";await window.__s63.meeting.submitSpeechCorrection("system not project"); });
      const after = await page.evaluate(() => ({ unit: window.__language.unit(), runtime: window.__language.context().taskRuntime,
        requests: window.__languageRequests, error: window.__s63.meeting.error }));
      assert.deepEqual(after.unit, before.unit);assert.deepEqual(after.runtime, before.runtime);
      assert.match(after.error, /outside Meeting Input Languages/);
      assert.equal(after.requests.length, 5);assert.deepEqual(failures, []);
    } finally { await context.close(); }
  } finally { await browser.close(); }
});
