import assert from "node:assert/strict";
import test from "node:test";
import { createSttFixture, fixtureSttProvider } from "./helpers/browser-stt-fixture.js";

const params = (audio: Blob, curl = fixtureSttProvider.curl) => ({
  audio, provider: { ...fixtureSttProvider, curl }, selectedProvider: { provider: "stub", variables: {} },
});

test("BM-F1: true PCM WAV retains its bytes, MIME and filename", async () => {
  const f = createSttFixture();
  const buffer = new ArrayBuffer(48), view = new DataView(buffer);
  for (const [offset, text] of [[0, "RIFF"], [8, "WAVEfmt "], [36, "data"]] as const) {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  }
  view.setUint32(4, 40, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, 4, true);
  view.setInt16(44, 5000, true); view.setInt16(46, -5000, true);
  await f.fetchSTT(params(new Blob([buffer], { type: "audio/wav" })));
  const file = (f.requests[0].body as FormData).get("file") as File;
  assert.equal(file.name, "audio.wav"); assert.equal(file.type, "audio/wav");
  assert.deepEqual(await file.arrayBuffer(), buffer);
});

test("BM-F1: unknown multipart MIME fails without sending or guessing from an input filename", async () => {
  const f = createSttFixture();
  for (const type of ["", "application/octet-stream", "audio/unknown", "constructor"]) {
    await assert.rejects(f.fetchSTT(params(new File(["bytes"], "looks-like.wav", { type }))), /Unsupported audio format/);
  }
  assert.equal(f.requests.length, 0);
});

test("BM-F1: binary and base64 transport branches retain their existing payloads", async () => {
  const f = createSttFixture(), audio = new Blob([new Uint8Array([0, 1, 254, 255])], { type: "application/octet-stream" });
  await f.fetchSTT(params(audio, "curl -X POST 'https://stt.invalid/transcribe' --data-binary '@audio'"));
  const binary = f.requests[0].body as Blob;
  assert.equal(binary.type, audio.type); assert.deepEqual(await binary.arrayBuffer(), await audio.arrayBuffer());
  await f.fetchSTT(params(audio, `curl -X POST 'https://stt.invalid/transcribe' -H 'Content-Type: application/json' -d '{"audio":"{{AUDIO}}"}'`));
  assert.deepEqual(JSON.parse(f.requests[1].body as string), { audio: "AAH+/w==" });
});
