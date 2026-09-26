import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

async function loadRequests() {
  const result = await build({
    stdin: {
      contents: 'export * from "./src/lib/functions/ai-response.function.ts"; export * from "./src/lib/functions/stt.function.ts";',
      resolveDir: process.cwd(),
    },
    bundle: true, write: false, platform: "node", format: "cjs",
  });
  const module = { exports: {} as any };
  new Function("require", "module", "exports", result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return module.exports;
}
const requests = loadRequests();
const provider = {
  id: "fixture", streaming: false, responseContentPath: "choices[0].message.content",
  curl: `curl -X POST https://provider.invalid/chat -H 'Authorization: Bearer {{KEY}}' -d '{"model":"fixture","messages":[{"role":"user","content":[{"type":"text","text":"{{TEXT}}"},{"type":"image_url","image_url":{"url":"{{IMAGE}}"}}]}]}'`,
};
const input = { provider, selectedProvider: { provider: "fixture", variables: { key: "synthetic-key" } }, userMessage: "Explain the cache", applyResponseSettings: false };

test("W199: HTTP plugin dependencies, registration and capabilities are retired", () => {
  const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  assert.equal(manifest.dependencies["@tauri-apps/plugin-http"], undefined);
  assert.equal(lock.packages[""]?.dependencies["@tauri-apps/plugin-http"], undefined);
  assert.equal(lock.packages["node_modules/@tauri-apps/plugin-http"], undefined);
  for (const file of ["src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/src/lib.rs"]) {
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /tauri[-_]plugin[-_]http/);
  }
  for (const name of ["default", "cross-platform"]) {
    const capability = JSON.parse(fs.readFileSync(`src-tauri/capabilities/${name}.json`, "utf8"));
    assert.equal(capability.permissions.some((p: any) => String(typeof p === "string" ? p : p.identifier).startsWith("http:")), false);
  }
  for (const name of ["ai-response", "stt"]) {
    const source = fs.readFileSync(path.join("src/lib/functions", `${name}.function.ts`), "utf8");
    assert.doesNotMatch(source, /tauriFetch|fetchFunction|plugin-http/);
    assert.match(source, /await fetch\(url,/);
  }
});

test("W199: actual AI builders retain JSON, images, browser redirect defaults and typed content", async (t) => {
  const api = await requests;
  const sent: RequestInit[] = [];
  t.mock.method(globalThis, "fetch", async (url: any, options: RequestInit) => {
    assert.equal(String(url), "https://provider.invalid/chat");
    sent.push(options);
    return Response.json({ choices: [{ message: { content: "answer" } }] });
  });
  const events = [];
  for await (const event of api.fetchAIResponseEvents({ ...input, signal: new AbortController().signal, imagesBase64: ["data:image/png;base64,AQID"] })) events.push(event);
  assert.equal(sent.length, 1, JSON.stringify(events));
  assert.equal(sent[0].method, "POST");
  assert.equal(new Headers(sent[0].headers).get("authorization"), "Bearer synthetic-key");
  assert.equal(sent[0].redirect, undefined);
  assert.ok(sent[0].signal instanceof AbortSignal);
  assert.match(String(sent[0].body), /data:image\/png;base64,AQID/);
  assert.equal(events[0].content, "answer");
  assert.equal(events.at(-1).outcome.status, "success");
});

test("W199: actual streaming, HTTP failure and abort keep their existing outcomes", async (t) => {
  const api = await requests;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return calls === 1
      ? new Response('data: {"choices":[{"delta":{"content":"stream"}}]}\n\ndata: [DONE]\n\n')
      : new Response("denied", { status: 401 });
  });
  const collect = async (params: any) => { const result = []; for await (const event of api.fetchAIResponseEvents(params)) result.push(event); return result; };
  const streamed = await collect({ ...input, provider: { ...provider, streaming: true, responseContentPath: "choices[0].delta.content" } });
  assert.equal(streamed[0].content, "stream", JSON.stringify(streamed));
  assert.equal(streamed.at(-1).outcome.completionSignal, "openai-done");
  const failed = await collect(input);
  assert.equal(failed.at(-1).outcome.failureClass, "authentication");
  const controller = new AbortController(); controller.abort();
  assert.equal((await collect({ ...input, signal: controller.signal })).at(-1).outcome.status, "aborted");
  assert.equal(calls, 2);
});

test("W199: actual STT keeps multipart, binary and JSON audio on browser fetch", async (t) => {
  const api = await requests;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "FileReader");
  Object.defineProperty(globalThis, "FileReader", { configurable: true, value: class {
    result = ""; onloadend?: () => void;
    readAsDataURL(blob: Blob) { void blob.arrayBuffer().then(buffer => { this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`; this.onloadend?.(); }); }
  } });
  t.after(() => previous ? Object.defineProperty(globalThis, "FileReader", previous) : Reflect.deleteProperty(globalThis, "FileReader"));
  const bodies: any[] = [];
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (_url: any, options: RequestInit) => {
    assert.equal(options.signal, controller.signal);
    assert.equal(options.redirect, undefined);
    bodies.push(options.body);
    return Response.json({ text: "transcript" });
  });
  const audio = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" });
  for (const data of ["-F 'file=@audio' -F 'model=fixture'", "--data-binary @audio", `-d '{"audio":{"content":"{{AUDIO}}"}}'`]) {
    assert.equal(await api.fetchSTT({ audio, signal: controller.signal, selectedProvider: input.selectedProvider,
      provider: { id: "fixture", responseContentPath: "text", curl: `curl -X POST https://stt.invalid/transcribe ${data}` } }), "transcript");
  }
  const file = bodies[0].get("file");
  assert.equal(file.name, "audio.wav");
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array([1, 2, 3]));
  assert.deepEqual(new Uint8Array(await bodies[1].arrayBuffer()), new Uint8Array([1, 2, 3]));
  assert.equal(JSON.parse(bodies[2]).audio.content, "AQID");
  controller.abort();
  await assert.rejects(api.fetchSTT({ audio, signal: controller.signal, selectedProvider: input.selectedProvider,
    provider: { id: "fixture", curl: "curl -X POST https://stt.invalid/transcribe -F 'file=@audio'" } }), { name: "AbortError" });
  assert.equal(bodies.length, 3);
});
