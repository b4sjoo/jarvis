import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { discoverArchitecture } from "../scripts/lib/architecture-analysis.mjs";

const root = process.cwd();
const read = (file) => readFileSync(path.join(root, file), "utf8");
const retiredCommands = ["start_system_audio_capture", "manual_stop_continuous",
  "request_system_audio_access", "get_vad_config", "update_vad_config"];

test("S128-D3: production IPC inventory retires only exclusive entry commands", () => {
  const analysis = discoverArchitecture(root);
  for (const name of retiredCommands) {
    assert.ok(!analysis.ipc.registeredCommands.includes(name), name);
    assert.ok(!analysis.ipc.staticFrontendInvokes.includes(name), name);
    assert.doesNotMatch(read("src-tauri/src/speaker/commands.rs"), new RegExp(`fn ${name}\\b`));
  }
  for (const name of ["start_meeting_audio_session", "stop_meeting_audio_session",
    "stop_system_audio_capture", "check_system_audio_access", "get_meeting_audio_status"]) {
    assert.ok(analysis.ipc.registeredCommands.includes(name), name);
    assert.ok(analysis.ipc.staticFrontendInvokes.includes(name), name);
  }
  assert.ok(!analysis.ipc.staticFrontendInvokes.includes("capture_screenshot"));
  assert.ok(analysis.ipc.staticFrontendInvokes.includes("capture_to_base64"));
  for (const event of ["audio-encoding-error", "continuous-recording-start",
    "continuous-recording-stopped", "recording-progress", "speech-discarded"]) {
    assert.ok(!analysis.ipc.nativeEmittedEvents.includes(event), event);
  }
});

test("S128-D1/D2: exclusive files, exports and configuration are gone; shared visualizer remains", () => {
  for (const file of ["src/hooks/useSystemAudio.ts", ...["Header", "ModeSwitcher", "PermissionFlow",
    "QuickActions", "RecordingPanel", "ResultsSection", "SettingsPanel", "StatusIndicator", "Warning", "index"]
    .map((name) => `src/pages/app/components/speech/${name}.tsx`)]) {
    assert.equal(existsSync(path.join(root, file)), false, file);
  }
  for (const file of ["src/hooks/index.ts", "src/hooks/useApp.ts", "src/pages/app/index.tsx",
    "src/pages/app/components/index.ts", "src/config/constants.ts"]) {
    assert.doesNotMatch(read(file), /useSystemAudio|SystemAudio|SYSTEM_AUDIO_CONTEXT|SYSTEM_AUDIO_QUICK_ACTIONS|DEFAULT_QUICK_ACTIONS|["']vad_config["']/);
  }
  assert.ok(existsSync(path.join(root, "src/pages/app/components/speech/audio-visualizer.tsx")));
});

let playwright;
try {
  playwright = createRequire(import.meta.url)(process.env.JARVIS_PLAYWRIGHT_MODULE ?? "playwright");
} catch {
  // Browser dependencies are supplied by the test host, never added to the product.
}

test("S128-D1/D2/D4: real React App mount and Chat audio/image consumer preservation", {
  skip: !playwright && "Set JARVIS_PLAYWRIGHT_MODULE to the host's playwright package",
}, async () => {
  const mocks = {
    "@/hooks": `export { useApp } from ${JSON.stringify(path.join(root, "src/hooks/useApp.ts"))};
      export const useTitles = () => { window.__audioRetirement.titles++; };`,
    "@/contexts": "export const useApp = () => window.__audioRetirement.context;",
    "@/lib/storage": "export const getShortcutsConfig = () => ({ screenshot: 'fixture-shortcut' });",
    "@/lib": `export const getPlatform = () => 'macos';
      export const shouldUseManagedAPI = async () => window.__audioRetirement.managed;
      export const fetchSTT = async ({audio, ...options}) => {
        const fixture = window.__audioRetirement;
        fixture.stt.push({...options, type: audio.type, text: await audio.text()});
        if (fixture.failStt) throw new Error('fixture STT failure');
        return 'fixture transcript';
      };`,
    "@tauri-apps/api/core": "export const invoke = async (...args) => { window.__audioRetirement.calls.push(args); };",
    "@tauri-apps/api/event": `export const listen = async (name) => {
      window.__audioRetirement.listeners.push(name);
      return () => window.__audioRetirement.unlistened.push(name);
    };`,
    "@/components": `export const Card = ({children, ...props}) => <div {...props}>{children}</div>;
      export const Button = ({size, variant, children, ...props}) => <button {...props}>{children}</button>;
      export const DragButton = () => <button title="Drag fixture">Drag</button>;
      export const CustomCursor = () => <span data-cursor />;
      export const Popover = ({children}) => <>{children}</>;
      export const PopoverTrigger = ({children}) => children;
      export const PopoverContent = () => null;`,
    "@/layouts": "export const ErrorLayout = () => <div data-error>App failed</div>;",
    // App's unchanged sibling owners are controlled boundaries, not replacements
    // for their own Meeting lifecycle and Completion behavior tests.
    "app-children": `export const Completion = ({isHidden}) => <input aria-label="Completion fixture" disabled={isHidden}/>;
      export const MeetingAssistant = ({onFocusModeActiveChange}) => <div data-meeting>
        <button onClick={() => onFocusModeActiveChange(true)}>Focus fixture</button>
        <button onClick={() => onFocusModeActiveChange(false)}>Unfocus fixture</button>
      </div>;`,
  };
  const bundle = await build({
    entryPoints: [path.join(root, "tests/fixtures/task-128-audio-retirement.tsx")],
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"test"' },
    plugins: [{ name: "controlled-product-boundaries", setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => {
        const key = args.path === "./components" && args.importer === path.join(root, "src/pages/app/index.tsx")
          ? "app-children" : args.path;
        if (Object.hasOwn(mocks, key)) return { path: key, namespace: "fixture" };
      });
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
        contents: mocks[args.path], loader: "tsx", resolveDir: root,
      }));
    } }],
  });
  const browser = await playwright.chromium.launch({
    headless: true,
    executablePath: process.env.JARVIS_CHROMIUM_EXECUTABLE,
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => route.fulfill({
      contentType: "text/html", body: '<div id="root"></div>',
    }));
    await page.goto("http://task128.fixture/");
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.waitForFunction(() => window.__audioRetirement?.calls.length === 1);
    const snapshot = () => page.evaluate(() => {
      const f = window.__audioRetirement;
      return { ...f, storageAfter: JSON.stringify({ ...localStorage }) };
    });
    let state = await snapshot();
    assert.deepEqual(state.calls, [["update_shortcuts", { config: { screenshot: "fixture-shortcut" } }]]);
    assert.deepEqual(state.listeners, ["toggle-window-visibility"]);
    assert.deepEqual(state.storageCalls, []);
    assert.equal(state.storageBefore, state.storageAfter);
    assert.equal(state.titles, 1);
    assert.equal(state.intervals, 0);
    assert.equal(state.timeouts, 0);
    assert.deepEqual(state.constraints, []);
    assert.deepEqual(state.stt, []);
    assert.equal(await page.locator('[data-error]').count(), 0);
    assert.equal(await page.getByTitle(/system audio/i).count(), 0);
    await page.getByLabel("Completion fixture").fill("ordinary input");
    await page.getByTitle("Open Dev Space").click();
    assert.equal((await snapshot()).calls.at(-1)[0], "open_dashboard");
    await page.getByText("Focus fixture", { exact: true }).click();
    assert.equal(await page.getByLabel("Completion fixture").count(), 0);
    assert.equal(await page.getByTitle("Drag fixture").count(), 0);
    assert.equal(await page.locator("[data-meeting]").count(), 1);
    await page.getByText("Unfocus fixture", { exact: true }).click();
    assert.equal(await page.getByLabel("Completion fixture").count(), 1);
    assert.equal(await page.getByTitle("Drag fixture").count(), 1);

    await page.evaluate(() => window.__audioRetirement.showChat());
    await page.waitForFunction(() => window.__audioRetirement.unlistened.length === 1);
    await page.getByLabel("Chat text").fill("ordinary chat");
    await page.getByTitle("Screenshot mode (manual) - 0/6 files").click();
    assert.equal((await snapshot()).screenshots, 1);
    for (const managed of [false, true]) {
      await page.evaluate((value) => { window.__audioRetirement.managed = value; }, managed);
      await page.getByTitle("Voice input", { exact: true }).click();
      await page.waitForFunction(() => {
        const canvas = document.querySelector("canvas");
        if (!canvas || !canvas.width || !canvas.height) return false;
        const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        return data.some((value, index) => index % 4 === 3 && value > 0);
      });
      await page.getByTitle("Send to AI", { exact: true }).click();
      await page.waitForFunction((count) => window.__audioRetirement.stt.length === count, managed ? 2 : 1);
      assert.equal(await page.getByLabel("Chat text").inputValue(), "fixture transcript");
      state = await snapshot();
      const request = state.stt.at(-1);
      assert.equal(request.provider?.id, managed ? undefined : "fixture-stt");
      assert.deepEqual(request.selectedProvider, state.context.selectedSttProvider);
      assert.equal(request.type, "audio/webm");
      assert.equal(request.text, "fixture audio");
      assert.deepEqual(state.constraints.at(-1), { audio: { deviceId: { exact: "fixture-microphone" } } });
      assert.ok(state.tracksStopped > 0 && state.contextsClosed > 0);
    }
    await page.getByTitle("Voice input", { exact: true }).click();
    await page.getByTitle("Stop recording", { exact: true }).click();
    assert.equal((await snapshot()).cancellations, 1);
    assert.equal((await snapshot()).stt.length, 2);
    await page.evaluate(() => { window.__audioRetirement.failStt = true; });
    await page.getByTitle("Voice input", { exact: true }).click();
    await page.waitForFunction(() => !!document.querySelector("canvas"));
    await page.getByTitle("Send to AI", { exact: true }).click();
    await page.waitForFunction(() => window.__audioRetirement.cancellations === 2);
    await page.evaluate(() => window.__audioRetirement.unmount());
    state = await snapshot();
    assert.deepEqual(state.unlistened, ["toggle-window-visibility"]);
    assert.deepEqual(state.storageCalls, []);
    assert.equal(state.storageAfter, state.storageBefore);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
