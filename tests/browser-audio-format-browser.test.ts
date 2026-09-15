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

test("BM-F1: native browser MediaRecorder bytes flow through Chat into the actual STT multipart", {
  skip: !playwright && "Set JARVIS_PLAYWRIGHT_MODULE to the host's playwright package",
}, async () => {
  const mocks: Record<string, string> = {
    "@/lib": `export { fetchSTT } from ${JSON.stringify(path.join(root, "src/lib/functions/stt.function.ts"))};
      export const shouldUseManagedAPI = async () => false;`,
    "@/contexts": `export const useApp = () => ({
      selectedAudioDevices: { input: { id: 'synthetic-microphone' } },
      selectedSttProvider: { provider: 'stub', variables: {} },
      allSttProviders: [{ id: 'stub', responseContentPath: 'text',
        curl: "curl -X POST 'https://stt.invalid/transcribe' -F 'file=@audio' -F 'model=fixture'" }],
    });`,
    "@/components": `export const Button = ({size, variant, children, ...props}) => <button {...props}>{children}</button>;`,
    "@tauri-apps/plugin-http": `export const fetch = () => { throw new Error('Unexpected native request'); };`,
  };
  const bundle = await build({
    entryPoints: [path.join(root, "tests/fixtures/task-128-audio-format.tsx")],
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"test"' },
    plugins: [{ name: "audio-boundaries", setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => {
        if (Object.hasOwn(mocks, args.path)) return { path: args.path, namespace: "fixture" };
      });
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
        contents: mocks[args.path], loader: "tsx", resolveDir: root,
      }));
    } }],
  });
  const browser = await playwright.chromium.launch({
    headless: true, executablePath: process.env.JARVIS_CHROMIUM_EXECUTABLE,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.route("**/*", (route: any) => route.request().url() === "http://task128-format.fixture/"
      ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
      : route.abort());
    await page.goto("http://task128-format.fixture/");
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.waitForFunction(() => (window as any).__audioFormat.chunks.length > 0);
    await page.getByTitle("Send to AI", { exact: true }).click();
    await page.waitForFunction(() => Boolean((window as any).__audioFormat.transcript));
    const result = await page.evaluate(() => {
      const f = (window as any).__audioFormat;
      return { requests: f.requests, constraints: f.constraints, actualMime: f.actualMime,
        chunks: f.chunks.length, checked: f.checked, error: f.error, transcript: f.transcript };
    });
    assert.deepEqual(errors, []); assert.equal(result.error, "");
    assert.equal(result.requests.length, 1);
    const request = result.requests[0];
    assert.equal(request.type, result.actualMime);
    assert.equal(request.name, "audio.webm");
    assert.deepEqual(request.bytes, request.capturedBytes);
    assert.deepEqual(request.bytes.slice(0, 4), [0x1a, 0x45, 0xdf, 0xa3]);
    assert.ok(result.chunks >= 2, "the final stop chunk must be included");
    assert.equal(request.stopped, true);
    assert.deepEqual(result.constraints, [{ audio: { deviceId: { exact: "synthetic-microphone" } } }]);
    assert.equal(result.transcript, "synthetic recording transcript");
  } finally { await browser.close(); }
});
