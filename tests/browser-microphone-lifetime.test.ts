import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createSttFixture, fixtureSttProvider } from "./helpers/browser-stt-fixture.js";

function fixture(options: { supported?: string[]; actualMime?: string; realStt?: boolean; deviceId?: string } = {}) {
  const effects: Array<() => (() => void)> = [], timers = new Map<number, () => void>();
  let timerId = 0, starts = 0, stops = 0, recorder: any;
  let resolveMedia!: (stream: unknown) => void, rejectMedia!: (error: Error) => void;
  const media = new Promise((resolve, reject) => { resolveMedia = resolve; rejectMedia = reject; });
  let resolveTranscription: ((text: string) => void) | undefined;
  const submitted: { text: string; signal: AbortSignal }[] = [], answers: string[] = [], errors: string[] = [];
  const stt = createSttFixture(), checked: string[] = [], selected: string[] = [], constraints: any[] = [];
  const track = { stop() { stops++; }, enabled: true, onended: undefined as (() => void) | undefined };
  const stream = { getTracks: () => [track] };
  class Recorder {
    static isTypeSupported(type: string) { checked.push(type); return (options.supported ?? ["audio/webm"]).includes(type); }
    state = "inactive";
    mimeType = options.actualMime ?? options.supported?.[0] ?? "audio/webm";
    ondataavailable?: (event: { data: Blob }) => void;
    onstop?: () => void;
    constructor(_stream: unknown, config: { mimeType: string }) { selected.push(config.mimeType); recorder = this; }
    start() { this.state = "recording"; starts++; }
    stop() {
      this.state = "inactive";
      queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(["FINAL"]) }); this.onstop?.(); });
    }
  }
  const jsx = (type: any, props: any) => ({ type, props });
  const imports: Record<string, unknown> = {
    react: { useState: (value: any) => [value, () => {}], useRef: (value: any) => ({ current: value }), useCallback: (fn: any) => fn, useEffect: (fn: any) => effects.push(fn) },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@/components": { Button: "Button" },
    "@/pages/app/components/speech/audio-visualizer": { AudioVisualizer: "Visualizer" },
    "@/lib": { shouldUseManagedAPI: async () => false, fetchSTT: async (input: any) => {
      if (options.realStt) return stt.fetchSTT(input);
      submitted.push({ text: await input.audio.text(), signal: input.signal });
      return new Promise<string>((resolve) => { resolveTranscription = resolve; });
    } },
    "@/contexts": { useApp: () => ({ selectedSttProvider: { provider: "stub", variables: {} }, allSttProviders: [fixtureSttProvider], selectedAudioDevices: { input: { id: options.deviceId ?? "default" } } }) },
    "lucide-react": { StopCircle: "StopCircle", Send: "Send" },
  };
  const context = vm.createContext({ exports: {}, require: (id: string) => {
    assert.ok(Object.hasOwn(imports, id), `Unexpected import: ${id}`); return imports[id];
  }, Blob, AbortController, Error, console, Date, MediaRecorder: Recorder, navigator: { mediaDevices: { getUserMedia: (value: unknown) => { constraints.push(value); return media; } } },
    setInterval: (fn: () => void) => { timers.set(++timerId, fn); return timerId; },
    setTimeout: (fn: () => void) => { timers.set(++timerId, fn); return timerId; },
    clearInterval: (id: number) => timers.delete(id), clearTimeout: (id: number) => timers.delete(id),
  });
  const source = readFileSync("src/pages/chats/components/AudioRecorder.tsx", "utf8");
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, context);
  const tree = context.exports.AudioRecorder({ onCancel() {}, onTranscriptionComplete: (text: string) => answers.push(text), onError: (error: string) => errors.push(error) });
  const cleanup = effects.map((effect) => effect());
  function find(node: any, title: string): any {
    if (!node || typeof node !== "object") return;
    if (node.props?.title === title) return node;
    for (const child of [node.props?.children].flat()) { const match = find(child, title); if (match) return match; }
  }
  return { submitted, answers, errors, timers, checked, selected, constraints, requests: stt.requests,
    counts: () => ({ starts, stops }),
    ready: () => resolveMedia(stream), reject: rejectMedia,
    disconnect: () => track.onended?.(),
    unmount: () => cleanup.forEach((fn) => fn?.()),
    head: () => recorder.ondataavailable({ data: new Blob(["HEAD"]) }),
    send: () => find(tree, "Send to AI").props.onClick(),
    complete: (text: string) => resolveTranscription?.(text),
  };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("BM3: delayed getUserMedia after unmount releases the stream without capture or timers", async () => {
  const f = fixture(); f.unmount(); f.ready(); await settle();
  assert.deepEqual(f.counts(), { starts: 0, stops: 1 });
  assert.equal(f.timers.size, 0); assert.equal(f.submitted.length, 0);
});

test("BM-F1: production recorder consumer keeps final bytes and actual MIME through real multipart construction", async () => {
  for (const [supported, actualMime, extension] of [
    ["audio/webm", "audio/webm;codecs=opus", "webm"],
    ["audio/ogg;codecs=opus", "audio/ogg;codecs=opus", "ogg"],
    ["audio/mp4", "audio/mp4;codecs=mp4a.40.2", "mp4"],
  ]) {
    const f = fixture({ supported: [supported], actualMime, realStt: true });
    f.ready(); await settle(); f.head(); await f.send();
    assert.deepEqual(f.selected, [supported]); assert.ok(f.checked.includes(supported));
    assert.equal(f.requests.length, 1);
    const file = (f.requests[0].body as FormData).get("file") as File;
    assert.equal(file.name, `audio.${extension}`); assert.equal(file.type, actualMime);
    assert.equal(await file.text(), "HEADFINAL");
    assert.deepEqual(f.answers, ["fixture transcript"]); f.unmount();
  }
});

test("BM-F1/2: all unsupported recorder candidates and missing device selection fail visibly", async () => {
  const f = fixture({ supported: [], realStt: true }); f.ready(); await settle();
  assert.equal(f.checked.length, 5); assert.equal(f.selected.length, 0);
  assert.match(f.errors[0], /does not support/); assert.equal(f.requests.length, 0);
  assert.ok(f.counts().stops > 0); f.unmount();
  const missing = fixture({ deviceId: "" }); await settle();
  assert.equal(missing.constraints.length, 0); assert.match(missing.errors[0], /Select a microphone/); missing.unmount();
});

test("BM-F2: Chat uses unconstrained explicit Default and exact concrete selection", async () => {
  for (const deviceId of ["default", "selected-chat-mic"]) {
    const f = fixture({ deviceId }); f.ready(); await settle();
    assert.deepEqual(JSON.parse(JSON.stringify(f.constraints[0])), {
      audio: deviceId === "default" ? {} : { deviceId: { exact: deviceId } },
    });
    f.unmount();
  }
});

test("BM-F2/4: Chat device removal is visible, releases capture and does not submit the tail", async () => {
  const f = fixture({ realStt: true }); f.ready(); await settle(); f.head();
  f.disconnect(); await settle(); await f.send();
  assert.deepEqual(f.errors, ["Selected microphone was disconnected."]);
  assert.equal(f.requests.length, 0); assert.ok(f.counts().stops > 0);
  assert.equal(f.timers.size, 0); f.unmount();
});

test("BM4: Send includes final data exactly once; cancellation rejects late transcription", async () => {
  const f = fixture(); f.ready(); await settle(); f.head();
  const send = f.send(); await f.send(); await settle();
  assert.equal(f.submitted.length, 1); assert.equal(f.submitted[0].text, "HEADFINAL");
  assert.equal(f.timers.size, 0);
  f.unmount(); assert.equal(f.submitted[0].signal.aborted, true);
  f.complete("too late"); await send; assert.deepEqual(f.answers, []);
});

test("BM4: successful Send publishes final transcript and permission errors remain visible", async () => {
  const f = fixture(); f.ready(); await settle(); f.head();
  const send = f.send(); await settle(); f.complete("complete transcript"); await send;
  assert.deepEqual(f.answers, ["complete transcript"]); f.unmount();
  const denied = fixture(); denied.reject(new Error("Microphone permission denied")); await settle();
  assert.deepEqual(denied.errors, ["Microphone permission denied"]);
  assert.equal(denied.submitted.length, 0); denied.unmount();
});
