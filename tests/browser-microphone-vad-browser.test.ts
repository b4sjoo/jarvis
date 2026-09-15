import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

const root = process.cwd();
let playwright: any;
try {
  playwright = createRequire(path.resolve("package.json"))(process.env.JARVIS_PLAYWRIGHT_MODULE ?? "playwright");
} catch { /* Browser runtime is supplied by the host, not the product. */ }

async function withVadFixture(run: (page: any, snapshot: () => Promise<any>) => Promise<void>) {
  const mocks: Record<string, string> = {
    "@/lib": `export const fetchSTT = (request) => new Promise((resolve) => {
      window.__browserVad.stt.push({ request, resolve });
    });`,
    "@/lib/functions/managed-api": `export const shouldUseManagedAPI = async () => false;`,
    "@/contexts": `export const useApp = () => ({
      selectedSttProvider: { provider: 'stub', variables: {} }, allSttProviders: [{ id: 'stub' }],
    });`,
    "@/components": `export const Button = ({size, variant, children, ...props}) => <button {...props}>{children}</button>;`,
    "onnxruntime-web": `export const env = { wasm: {} };`,
    "fixture-model": `export const SileroLegacy = { new: async () => ({
      process: async (frame) => ({ isSpeech: frame[0], notSpeech: 1 - frame[0] }), reset_state() {},
    }) }; export const SileroV5 = SileroLegacy;`,
  };
  const bundle = await build({
    entryPoints: [path.join(root, "tests/fixtures/task-128-browser-vad.tsx")],
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"test"' },
    plugins: [{ name: "browser-vad-boundaries", setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => {
        if (args.path === "./models" && args.importer.includes("@ricky0123/vad-web/dist/")) {
          return { path: "fixture-model", namespace: "fixture" };
        }
        if (Object.hasOwn(mocks, args.path)) return { path: args.path, namespace: "fixture" };
      });
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
        contents: mocks[args.path], loader: "tsx", resolveDir: root,
      }));
    } }],
  });
  const browser = await playwright.chromium.launch({
    headless: true, executablePath: process.env.JARVIS_CHROMIUM_EXECUTABLE,
  });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.route("**/*", (route: any) => route.request().url() === "http://task128-vad.fixture/"
      ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }) : route.abort());
    await page.goto("http://task128-vad.fixture/");
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.waitForFunction(() => (window as any).__browserVad.ready);
    const snapshot = () => page.evaluate(() => {
      const f = (window as any).__browserVad;
      return { constraints: f.constraints, tracks: f.tracks.map((track: any) => track.readyState),
        contexts: f.contexts.map((context: any) => context.state), submissions: f.submissions,
        stt: f.stt.map((entry: any) => ({ type: entry.request.audio.type, aborted: entry.request.signal.aborted })),
        meAudio: f.meAudio, observations: f.observations, error: f.error,
        meCommits: f.meCommits, nativeDrainPending: f.nativeDrainPending };
    });
    await run(page, snapshot);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}

test("BM-F3/4/6: real React hook and Completion use public VAD; generations and consumers remain isolated", {
  skip: !playwright && "Set JARVIS_PLAYWRIGHT_MODULE to the host's playwright package",
}, async () => {
  await withVadFixture(async (page, snapshot) => {
    assert.equal((await snapshot()).constraints.length, 0, "idle mount must never acquire microphone access");
    await page.getByText("Enable top", { exact: true }).click();
    await page.waitForFunction(() => (window as any).__browserVad.contexts[0]?.state === "running");
    await page.evaluate(() => (window as any).__browserVad.speech(0));
    await page.waitForFunction(() => (window as any).__browserVad.stt.length === 1);
    await page.evaluate(() => (window as any).__browserVad.stt[0].resolve("ordinary Completion"));
    await page.waitForFunction(() => (window as any).__browserVad.submissions.length === 1);
    assert.deepEqual((await snapshot()).submissions, ["ordinary Completion"]);
    await page.evaluate(() => (window as any).__browserVad.speech(0));
    await page.waitForFunction(() => (window as any).__browserVad.stt.length === 2);
    await page.getByText("Enable Me", { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-me-listening="true"]'));
    await page.getByText("Replace top device", { exact: true }).click();
    await page.waitForFunction(() => (window as any).__browserVad.contexts[2]?.state === "running");
    await page.evaluate(() => (window as any).__browserVad.stt[1].resolve("stale Completion"));
    await page.evaluate(() => (window as any).__browserVad.speech(0));
    await page.evaluate(() => (window as any).__browserVad.speech(1));
    let result = await snapshot();
    assert.equal(result.stt[1].aborted, true);
    assert.equal(result.stt.length, 2); assert.deepEqual(result.submissions, ["ordinary Completion"]);
    assert.deepEqual(result.meAudio, [11 * 1536]);
    assert.deepEqual(result.contexts, ["closed", "running", "running"]);
    assert.equal(result.constraints[2].audio.deviceId.exact, "replacement-mic");
    assert.ok(result.stt.every((entry: any) => entry.type === "audio/wav"));
    await page.getByText("Disable top", { exact: true }).click();
    await page.getByText("Disable Me", { exact: true }).click();
    await page.waitForFunction(() => (window as any).__browserVad.contexts.every((context: any) => context.state === "closed"));
    result = await snapshot();
    assert.ok(result.tracks.every((state: string) => state === "ended"));
    assert.equal(result.observations.filter((event: any) => event.stage === "first-frame").length, 1);
    assert.equal(result.observations.at(-1).stage, "disposed");
    await page.evaluate(() => { (window as any).__browserVad.delayMedia = true; });
    await page.getByText("Enable top", { exact: true }).click();
    await page.waitForFunction(() => (window as any).__browserVad.deferredMedia.length === 1);
    await page.evaluate(() => (window as any).__browserVad.unmount());
    await page.evaluate(() => (window as any).__browserVad.deferredMedia[0]());
    await page.waitForFunction(() => (window as any).__browserVad.tracks.at(-1).readyState === "ended");
    result = await snapshot();
    assert.equal(result.contexts.length, 3); assert.equal(result.stt.length, 2);
    assert.equal(result.error, "");
  });
});

test("BM-F4: superseding resume replaces a disposed Me instance while enabled and listening status stay true", {
  skip: !playwright && "Set JARVIS_PLAYWRIGHT_MODULE to the host's playwright package",
}, async () => {
  await withVadFixture(async (page, snapshot) => {
    await page.getByText("Enable Me", { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-me-listening="true"]'));
    await page.evaluate(() => (window as any).__browserVad.beginMeDrain());
    await page.waitForFunction(() => document.querySelector('[data-me-listening="false"]'));
    let result = await snapshot();
    const commitBoundary = result.meCommits.length - 1;
    assert.equal(result.nativeDrainPending, true);
    assert.equal(result.constraints.length, 1);
    assert.deepEqual(result.tracks, ["ended"]);
    assert.deepEqual(result.contexts, ["closed"]);

    // An unrelated listening render must not retry the disposed generation.
    await page.evaluate(() => (window as any).__browserVad.resumeMe("audio-session-initial"));
    await page.waitForFunction((count: number) => (window as any).__browserVad.meCommits.length > count, result.meCommits.length);
    assert.equal((await snapshot()).constraints.length, 1);

    // Match startAudioProcessingSession followed by a fresh listening state object.
    await page.evaluate(() => (window as any).__browserVad.resumeMe("audio-session-resumed"));
    await page.waitForFunction(() => (window as any).__browserVad.meCommits.at(-1)?.sessionKey === "audio-session-resumed");
    result = await snapshot();
    assert.equal(result.constraints.length, 2, "a new existing session ID must replace the disposed resource even without enabled=false");
    await page.waitForFunction(() => document.querySelector('[data-me-listening="true"]'));
    await page.evaluate(() => (window as any).__browserVad.speech(0));
    assert.deepEqual((await snapshot()).meAudio, []);
    await page.evaluate(() => (window as any).__browserVad.speech(1));
    result = await snapshot();
    assert.deepEqual(result.meAudio, [11 * 1536]);
    assert.deepEqual(result.contexts, ["closed", "running"]);
    assert.deepEqual(result.tracks, ["ended", "live"]);
    assert.ok(result.meCommits.slice(commitBoundary).every((commit: any) => commit.enabled && commit.status === "listening"));
    assert.equal(result.nativeDrainPending, true);
    assert.equal(result.observations.filter((event: any) => event.stage === "initializing").length, 2);
    await page.evaluate(() => {
      const f = (window as any).__browserVad;
      f.nativeDrainPending = false;
      f.unmount();
    });
    result = await snapshot();
    assert.deepEqual(result.tracks, ["ended", "ended"]);
    assert.deepEqual(result.contexts, ["closed", "closed"]);
  });
});

test("BM-F3/4: session-key replacement releases late initialization without an enabled=false render", {
  skip: !playwright && "Set JARVIS_PLAYWRIGHT_MODULE to the host's playwright package",
}, async () => {
  await withVadFixture(async (page, snapshot) => {
    await page.evaluate(() => { (window as any).__browserVad.delayMedia = true; });
    await page.getByText("Enable Me", { exact: true }).click();
    await page.waitForFunction(() => (window as any).__browserVad.deferredMedia.length === 1);
    await page.evaluate(() => (window as any).__browserVad.beginMeDrain());
    await page.evaluate(() => (window as any).__browserVad.resumeMe("audio-session-resumed"));
    await page.waitForFunction(() => (window as any).__browserVad.deferredMedia.length === 2);
    await page.evaluate(() => (window as any).__browserVad.deferredMedia[1]());
    await page.waitForFunction(() => document.querySelector('[data-me-listening="true"]'));
    await page.evaluate(() => (window as any).__browserVad.deferredMedia[0]());
    await page.waitForFunction(() => (window as any).__browserVad.tracks[0].readyState === "ended");
    let result = await snapshot();
    assert.equal(result.constraints.length, 2);
    assert.deepEqual(result.tracks, ["ended", "live"]);
    assert.deepEqual(result.contexts, ["running"]);
    assert.equal(result.observations.filter((event: any) => event.stage === "started").length, 1);
    await page.evaluate(() => (window as any).__browserVad.speech(0));
    assert.deepEqual((await snapshot()).meAudio, [11 * 1536]);
    await page.evaluate(() => (window as any).__browserVad.unmount());
    result = await snapshot();
    assert.deepEqual(result.tracks, ["ended", "ended"]);
    assert.deepEqual(result.contexts, ["closed"]);
  });
});

test("BM-F3/6: changing an existing session key while disabled stays lazy", {
  skip: !playwright && "Set JARVIS_PLAYWRIGHT_MODULE to the host's playwright package",
}, async () => {
  await withVadFixture(async (page, snapshot) => {
    await page.evaluate(() => (window as any).__browserVad.resumeMe("audio-session-inactive"));
    await page.waitForFunction(() => (window as any).__browserVad.meCommits.at(-1)?.sessionKey === "audio-session-inactive");
    assert.equal((await snapshot()).constraints.length, 0);
    await page.getByText("Enable Me", { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-me-listening="true"]'));
    const commits = (await snapshot()).meCommits.length;
    await page.evaluate(() => (window as any).__browserVad.resumeMe("audio-session-inactive"));
    await page.waitForFunction((count: number) => (window as any).__browserVad.meCommits.length > count, commits);
    assert.equal((await snapshot()).constraints.length, 1, "same-session rerenders must not cause cold initialization");
    await page.evaluate(() => (window as any).__browserVad.unmount());
    assert.deepEqual((await snapshot()).contexts, ["closed"]);
  });
});
