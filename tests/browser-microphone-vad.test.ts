import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture() {
  const media = deferred<any>();
  const model = deferred();
  const worklet = deferred();
  const resume = deferred();
  const frames = { gate: Promise.resolve() };
  const constraints: any[] = [], contexts: any[] = [], nodes: any[] = [];
  const assets: string[] = [], states: any[] = [], events: any[] = [], speech: Float32Array[] = [];
  let stops = 0, closes = 0, disconnects = 0, now = 10, resets = 0;
  class Track extends EventTarget {
    readyState = "live";
    muted = false;
    getSettings() { return { deviceId: "selected-mic" }; }
    stop() { this.readyState = "ended"; stops++; }
  }
  const track = new Track();
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  class Context {
    state = "suspended";
    audioWorklet = { addModule: async (url: string) => { assets.push(url); await worklet.promise; } };
    constructor() { contexts.push(this); }
    createMediaStreamSource(actual: unknown) {
      assert.equal(actual, stream);
      return { connect(node: unknown) { assert.ok(nodes.includes(node)); }, disconnect() { disconnects++; } };
    }
    async resume() { await resume.promise; this.state = "running"; }
    async close() { this.state = "closed"; closes++; }
  }
  class Worklet {
    port = { onmessage: undefined as any, postMessage: (_value: unknown) => {} };
    constructor(_context: unknown, name: string, options: any) {
      assert.equal(name, "vad-helper-worklet");
      assert.equal(options.processorOptions.frameSamples, 1536);
      nodes.push(this);
    }
    disconnect() { disconnects++; }
  }
  const require = createRequire(path.resolve("package.json"));
  const dependencyPath = require.resolve("@ricky0123/vad-web/dist/real-time-vad.js");
  const dependencyRequire = createRequire(dependencyPath);
  // Execute the installed AudioNodeVAD and FrameProcessor, including real setup,
  // receive, start, pause, destroy and segmentation. Only hardware/model loading is fake.
  const dependency = vm.createContext({
    exports: {}, AudioWorkletNode: Worklet, ArrayBuffer, Float32Array, console,
    require: (id: string) => {
      if (id === "onnxruntime-web") return { env: { wasm: {} } };
      if (id === "./default-model-fetcher") return { defaultModelFetcher: async (url: string) => {
        assets.push(url); await model.promise; return new ArrayBuffer(0);
      } };
      if (id === "./models") return { SileroLegacy: { new: async (_ort: unknown, fetcher: () => Promise<unknown>) => {
        await fetcher();
        return { process: async (frame: Float32Array) => {
          await frames.gate; return { isSpeech: frame[0], notSpeech: 1 - frame[0] };
        }, reset_state: () => { resets++; } };
      } } };
      return dependencyRequire(id);
    },
  });
  vm.runInContext(readFileSync(dependencyPath, "utf8"), dependency);
  const context = vm.createContext({
    exports: {}, require: (id: string) => { assert.equal(id, "@ricky0123/vad-web"); return dependency.exports; },
    AudioContext: Context, performance: { now: () => now }, Error, console,
    navigator: { mediaDevices: { getUserMedia: (value: unknown) => { constraints.push(value); return media.promise; } } },
  });
  vm.runInContext(ts.transpileModule(readFileSync("src/lib/browser-microphone-vad.ts", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  const create = (options: any = {}) => context.exports.createBrowserMicrophoneVad({
    deviceId: "selected-mic", onStateChange: (value: unknown) => states.push(value),
    onObservation: (value: unknown) => events.push(value), onSpeechEnd: (audio: Float32Array) => { speech.push(audio); },
    ...options,
  });
  return {
    create, media, model, worklet, resume, frames, constraints, contexts, nodes, assets, states, events, speech, track,
    counts: () => ({ stops, closes, disconnects, resets }),
    grant: () => media.resolve(stream),
    ready: () => { media.resolve(stream); model.resolve(); worklet.resolve(); resume.resolve(); },
    tick: (ms: number) => { now += ms; },
    frame: (probability: number, node = nodes[0]) => node.port.onmessage({ data: {
      message: "AUDIO_FRAME", data: new Float32Array(1536).fill(probability).buffer,
    } }),
  };
}

test("BM-F2/3: lazy selected device reaches getUserMedia; public VAD ready/start/pause/resume/dispose", async () => {
  const f = fixture(), vad = f.create();
  assert.equal(f.constraints.length, 0);
  const started = vad.start();
  assert.equal(vad.start(), started);
  assert.equal(f.constraints.length, 1);
  assert.equal(f.constraints[0].audio.deviceId.exact, "selected-mic");
  for (const key of ["echoCancellation", "autoGainControl", "noiseSuppression"]) assert.equal(f.constraints[0].audio[key], true);
  assert.equal(f.constraints[0].audio.channelCount, 1);
  f.ready(); f.tick(25); await started;
  assert.equal(vad.getState().listening, true);
  assert.equal(f.contexts[0].state, "running");
  assert.deepEqual(f.assets, [
    "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@latest/dist/silero_vad_legacy.onnx",
    "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@latest/dist/vad.worklet.bundle.min.js",
  ]);
  assert.equal(f.events.find((event) => event.stage === "ready").elapsedMs, 25);
  for (let i = 0; i < 3; i++) await f.frame(0.9);
  for (let i = 0; i < 8; i++) await f.frame(0);
  assert.equal(f.speech.length, 1);
  assert.equal(f.speech[0].length, 11 * 1536);
  const statesBefore = f.states.length, eventsBefore = f.events.length;
  for (let i = 0; i < 100; i++) await f.frame(0);
  assert.equal(f.states.length, statesBefore);
  assert.equal(f.events.length, eventsBefore);
  vad.pause();
  await f.frame(0.9);
  assert.equal(vad.getState().listening, false);
  f.contexts[0].state = "suspended";
  await vad.start();
  assert.equal(f.contexts.length, 1);
  assert.equal(f.nodes.length, 1);
  assert.equal(f.constraints.length, 1);
  vad.pause();
  await vad.start();
  assert.equal(vad.getState().listening, true);
  await vad.dispose(); await vad.dispose(); await vad.start();
  assert.equal(f.counts().stops, 1); assert.equal(f.counts().closes, 1);
  assert.equal(f.events.filter((event) => event.stage === "first-frame").length, 1);
  assert.equal(f.events.at(-1).stage, "disposed");
  assert.equal(f.events.at(-1).framesProcessed, 111);
  assert.equal(f.events.at(-1).speechSegments, 1);
  assert.ok(f.events.every((event) => !Object.hasOwn(event, "audio") && !Object.hasOwn(event, "frame")));
});

test("BM-F2: missing selection never captures; explicit Default is the only default request", async () => {
  const missing = fixture(), vad = missing.create({ deviceId: undefined });
  await vad.start(); assert.equal(missing.constraints.length, 0);
  assert.match(vad.getState().errored, /Select a microphone/);
  const f = fixture(), defaultVad = f.create({ deviceId: "default" });
  const start = defaultVad.start(); f.ready(); await start;
  assert.equal(Object.hasOwn(f.constraints[0].audio, "deviceId"), false);
  await defaultVad.dispose();
});

test("BM-F2: denied/removed/mismatched devices surface errors without fallback or retry", async () => {
  const denied = fixture(), a = denied.create();
  const pending = a.start(); denied.media.reject(new Error("Permission denied")); await pending;
  await a.start(); assert.equal(denied.constraints.length, 1); assert.match(a.getState().errored, /Permission denied/);
  const removed = fixture(), b = removed.create();
  const started = b.start(); removed.ready(); await started;
  removed.track.dispatchEvent(new Event("ended")); await settle();
  assert.match(b.getState().errored, /disconnected/);
  assert.equal(removed.counts().stops, 1); assert.equal(removed.counts().closes, 1);
  const mismatch = fixture(), c = mismatch.create({ deviceId: "another-mic" });
  const mismatchStart = c.start(); mismatch.ready(); await mismatchStart;
  assert.match(c.getState().errored, /different microphone/);
  assert.equal(mismatch.counts().stops, 1); assert.equal(mismatch.contexts.length, 0);
});

for (const boundary of ["media", "model", "worklet", "resume"] as const) {
  test(`BM-F3/4: dispose during ${boundary} initialization releases early and late resources`, async () => {
    const f = fixture(), vad = f.create();
    const start = vad.start();
    if (boundary !== "media") { f.grant(); await settle(); }
    if (boundary === "worklet" || boundary === "resume") { f.model.resolve(); await settle(); }
    if (boundary === "resume") { f.worklet.resolve(); await settle(); }
    await vad.dispose();
    if (boundary !== "media") {
      assert.equal(f.counts().stops, 1); assert.equal(f.counts().closes, 1);
    }
    f.ready(); await start;
    assert.equal(f.counts().stops, 1);
    assert.equal(f.counts().closes, boundary === "media" ? 0 : 1);
    assert.equal(vad.getState().listening, false);
    assert.equal(f.events.filter((event) => event.stage === "started").length, 0);
    assert.equal(f.speech.length, 0);
  });
}

test("BM-F3/4: pause while initializing cancels desired enable and releases a late stream", async () => {
  const f = fixture(), vad = f.create(), start = vad.start();
  vad.pause(); f.ready(); await start;
  assert.equal(vad.getState().loading, false);
  assert.equal(vad.getState().listening, false);
  assert.equal(f.counts().stops, 1); assert.equal(f.contexts.length, 0);
});

test("BM-F3/4: an in-flight model callback cannot publish after pause/dispose", async () => {
  for (const action of ["pause", "dispose"] as const) {
    const f = fixture(), vad = f.create(), start = vad.start(); f.ready(); await start;
    for (let i = 0; i < 3; i++) await f.frame(0.9);
    for (let i = 0; i < 7; i++) await f.frame(0);
    const pending = deferred(); f.frames.gate = pending.promise;
    const frame = f.frame(0); await vad[action]();
    const count = f.events.length;
    pending.resolve(); await frame;
    assert.equal(f.events.length, count); assert.equal(f.speech.length, 0);
    await vad.dispose();
  }
});

test("BM-F3/6: separate consumers own resources and observer errors cannot restart capture", async () => {
  const a = fixture(), b = fixture();
  const left = a.create({ onObservation: () => { throw new Error("recorder unavailable"); } }), right = b.create();
  const first = left.start(), second = right.start(); a.ready(); b.ready(); await first; await second;
  await left.dispose(); assert.equal(b.counts().stops, 0); assert.equal(right.getState().listening, true);
  for (let i = 0; i < 3; i++) await b.frame(0.9);
  for (let i = 0; i < 8; i++) await b.frame(0);
  assert.equal(b.speech.length, 1); await right.dispose();
});

test("BM-F3: async consumer callback failures are contained and release the instance", async () => {
  const f = fixture(), vad = f.create({ onSpeechEnd: async () => { throw new Error("callback failed"); } });
  const start = vad.start(); f.ready(); await start;
  for (let i = 0; i < 3; i++) await f.frame(0.9);
  for (let i = 0; i < 8; i++) await f.frame(0);
  await settle(); assert.match(vad.getState().errored, /callback failed/);
  assert.equal(f.counts().stops, 1); assert.equal(f.counts().closes, 1);
});

test("BM-F3: async speech-start and observation callbacks do not leak rejected promises", async () => {
  const f = fixture(), vad = f.create({
    onSpeechStart: async () => { throw new Error("speech-start failed"); },
    onObservation: async () => { throw new Error("optional recording failed"); },
  });
  const start = vad.start(); f.ready(); await start; await f.frame(0.9); await settle();
  assert.match(vad.getState().errored, /speech-start failed/);
  assert.equal(f.counts().stops, 1); assert.equal(f.counts().closes, 1);
  assert.equal(f.constraints.length, 1);
});

test("BM-F3/4: rejected resume from a cancelled start cannot become a current error", async () => {
  const f = fixture(), vad = f.create(), start = vad.start();
  f.grant(); f.model.resolve(); f.worklet.resolve(); await settle();
  vad.pause(); f.resume.reject(new Error("cancelled context resume")); await start;
  assert.equal(vad.getState().errored, false); assert.equal(vad.getState().listening, false);
  await vad.dispose(); assert.equal(f.counts().closes, 1);
});
