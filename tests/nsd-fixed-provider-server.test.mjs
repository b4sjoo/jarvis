import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:http";
import { setTimeout as wait } from "node:timers/promises";
import { createFixedProviderServer } from "../scripts/nsd-fixed-provider-server.mjs";

const first = "What does LRU stand for and how does an LRU cache work?";
const second = "What happens when an LRU cache reaches capacity?";
const me = "I would clarify the cache capacity before I implement it.";

function wav(rate) {
  const audio = Buffer.alloc(46);
  audio.write("RIFF", 0);
  audio.writeUInt32LE(38, 4);
  audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(rate, 24);
  audio.writeUInt32LE(rate * 2, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(2, 40);
  return audio;
}

function audioForm(audio) {
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/wav" }), "audio.wav");
  return form;
}

test("fixed Provider serves bounded STT and current-question Advisor output without external fallback", async () => {
  const server = createFixedProviderServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const stt1 = await fetch(`${base}/stt`, { method: "POST", body: audioForm(wav(48_000)) });
    const stt2 = await fetch(`${base}/stt`, { method: "POST", body: audioForm(wav(48_000)) });
    assert.equal((await stt1.json()).text, first);
    assert.equal((await stt2.json()).text, second);
    const [meResult, themResult] = await Promise.all([
      fetch(`${base}/stt`, { method: "POST", body: audioForm(wav(16_000)) }),
      fetch(`${base}/stt`, { method: "POST", body: audioForm(wav(48_000)) }),
    ]);
    assert.equal((await meResult.json()).text, me);
    assert.equal((await themResult.json()).text, first);
    const unexpected = await fetch(`${base}/stt`, {
      method: "POST", body: audioForm(wav(44_100)),
    });
    assert.equal(unexpected.status, 422);
    const malformed = await fetch(`${base}/stt`, {
      method: "POST", body: audioForm(Buffer.from("not a wav")),
    });
    assert.equal(malformed.status, 422);

    const response = await fetch(`${base}/ai`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "system", content: "You are a live meeting co-pilot for a non-native English speaker." }, { role: "user", content: `<current_question>text: ${second}</current_question><continuity>${first}</continuity>` }] }),
    });
    assert.equal(response.status, 200);
    const chunks = (await response.text()).split("\n\n").filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"));
    const output = chunks.map((line) => JSON.parse(line.slice(6)).choices[0].delta.content).join("");
    assert.match(output, /Answer: When an LRU cache reaches capacity/);

    const canonical = await fetch(`${base}/ai`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [
        { role: "system", content: "Classify one canonical relationship. Child and Parent Affinity are proposals; an active child may exist." },
        { role: "user", content: second },
      ] }),
    });
    assert.equal(canonical.status, 200);
    const relationContent = (await canonical.text()).split("\n\n")
      .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
      .map((line) => JSON.parse(line.slice(6)).choices[0].delta.content).join("");
    assert.equal(JSON.parse(relationContent).relation, "followup-parent");

    const unknown = await fetch(`${base}/ai`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "system", content: "other" }, { role: "user", content: first }] }),
    });
    assert.equal(unknown.status, 422);
    const cancelled = request(`${base}/ai`, {
      method: "POST", headers: { "Content-Type": "application/json" },
    });
    cancelled.on("error", () => {});
    cancelled.write('{"messages":[');
    await wait(30);
    cancelled.destroy();
    await wait(30);
    await fetch(`${base}/reset`, { method: "POST" });
    assert.equal((await (await fetch(`${base}/stt`, {
      method: "POST", body: audioForm(wav(48_000)),
    })).json()).text, first);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
