import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import path from "node:path";
import { buildSync } from "esbuild";

const require = createRequire(path.join(process.cwd(), "package.json"));
const compiled = buildSync({ stdin: { contents: `export {AdvisorEngine} from './src/lib/meeting/advisor-engine';
  export {solveScreenAnchoredTask} from './src/lib/meeting/screen-observation.service';`, loader: "ts", resolveDir: process.cwd() },
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent", alias: { "@": path.join(process.cwd(), "src") } });
const module = { exports: {} as any };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(require, module, module.exports);
const { AdvisorEngine, solveScreenAnchoredTask } = module.exports;
const provider = { id: "synthetic", streaming: true, responseContentPath: "choices[0].message.content",
  curl: `curl https://generation.fixture/model -H 'Content-Type: application/json' -d '${JSON.stringify({ model: "fixture", messages: [
    { role: "system", content: "{{SYSTEM_PROMPT}}" },
    { role: "user", content: [{ type: "text", text: "{{TEXT}}" }, { type: "image_url", image_url: { url: "data:image/png;base64,{{IMAGE}}" } }] },
  ] })}'` };
const selectedProvider = { provider: "synthetic", variables: {} };
const response = (content = "Answer: Result.") => new Response('data: '+JSON.stringify({ choices: [{delta: {content}, finish_reason: 'stop'}] })+'\n\ndata: [DONE]\n\n');
const voice = (id: string) => ({ requestId: id, provider, selectedProvider, requestOptions: { retryPolicy: { maxAttempts: 1 } },
  promptContext: { transcript: id, screenContext: "", rollingSummary: "", userProfileContext: "", glossaryText: "", taskRuntime: { revision: 0 } } });
const screen = (signal?: AbortSignal) => ({ provider, selectedProvider, signal, recentTranscript: "SCREEN-ID",
  observation: { id: "screen", capturedAt: 1, imageBase64: "AA==", summary: "SCREEN-ID" },
  requestOptions: { retryPolicy: { maxAttempts: 1 } } });
const collect = async (stream: AsyncIterable<unknown>) => { const events = []; for await (const event of stream) events.push(event); return events; };
async function until(condition: () => boolean) { for (let i = 0; i < 100 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(condition()); }

test("SG common stream keeps Voice cancellation separate from the Screen source", { timeout: 5_000 }, async () => {
  const original = globalThis.fetch;
  const requests: { screen: boolean; aborted: boolean; signal: AbortSignal }[] = [];
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)), signal = init!.signal!;
    const entry = { screen: body.messages.find((message: {role: string}) => message.role === "system").content.startsWith("You are Jarvis,"), aborted: false, signal };
    requests.push(entry);
    if (requests.length === 3) return response();
    return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => {
      entry.aborted = true; reject(new DOMException("Aborted", "AbortError"));
    }, { once: true }));
  }) as typeof fetch;
  try {
    const controller = new AbortController(), engine = new AdvisorEngine();
    const pendingScreen = solveScreenAnchoredTask(screen(controller.signal)).catch((error: Error) => error);
    const a = collect(engine.streamSuggestion(voice("VOICE-A"))).catch(error => error);
    await until(() => requests.length === 2);
    const b = await collect(engine.streamSuggestion(voice("VOICE-B")));
    assert.equal((await a).name, "AbortError");
    assert.equal(requests.find(r => r.screen)!.aborted, false);
    assert.ok(b.some((event: any) => event.type === "candidate"));
    controller.abort();
    assert.equal((await pendingScreen).name, "AbortError");
    assert.equal(requests.find(r => r.screen)!.aborted, true);
    assert.equal(requests.length, 3);
  } finally { globalThis.fetch = original; }
});

test("SG source adapters preserve final-error reset differences without a candidate", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("not authorized", { status: 401 })) as typeof fetch;
  try {
    let resets = 0, candidates = 0, terminals = 0;
    await assert.rejects(solveScreenAnchoredTask({ ...screen(), onPartialReset: () => resets++, onCandidate: () => candidates++,
      trace: { onTerminal: () => terminals++ } }));
    assert.equal(resets, 1);
    assert.equal(candidates, 0);
    assert.equal(terminals, 1);
    const seen: any[] = [];
    await assert.rejects((async () => { for await (const event of new AdvisorEngine().streamSuggestion(voice("VOICE-ERROR"))) seen.push(event); })());
    assert.equal(seen.length, 0, "Voice still leaves error cleanup to its existing owner");
  } finally { globalThis.fetch = original; }
});

test("SG adapters retain empty, dash and retry outcomes", async () => {
  const original = globalThis.fetch;
  try {
    for (const source of ["voice", "screen"]) {
      let requests = 0, resets = 0, candidates = 0;
      const run = async (retry = false) => {
        const requestOptions = { retryPolicy: { maxAttempts: retry ? 2 : 1, retryDelayMs: 0 } };
        if (source === "screen") return solveScreenAnchoredTask({ ...screen(), requestOptions,
          onPartialReset: () => resets++, onCandidate: () => candidates++ });
        const events = await collect(new AdvisorEngine().streamSuggestion({ ...voice("voice"), requestOptions }));
        resets += events.filter((e: any) => e.type === "partial-reset").length;
        candidates += events.filter((e: any) => e.type === "candidate").length;
        return (events.find((e: any) => e.type === "candidate") as any).candidate.content;
      };
      globalThis.fetch = (async () => { requests++; return response(""); }) as typeof fetch;
      await assert.rejects(run());
      assert.equal(requests, 1);
      assert.equal(candidates, 0);
      resets = 0;
      globalThis.fetch = (async () => response("-")) as typeof fetch;
      assert.equal(await run(), source === "screen" ? "" : "-");
      assert.equal(candidates, 1);
      requests = 0; resets = 0; candidates = 0;
      globalThis.fetch = (async () => ++requests === 1 ? new Response("busy", { status: 503 }) : response()) as typeof fetch;
      assert.equal(await run(true), "Answer: Result.");
      assert.equal(requests, 2);
      assert.equal(resets, 1);
      assert.equal(candidates, 1);
    }
  } finally { globalThis.fetch = original; }
});
