import assert from "node:assert/strict";
import test from "node:test";
import { createFixedProviderServer } from "../scripts/nsd-fixed-provider-server.mjs";

const first = "What does LRU stand for and how does an LRU cache work?";
const second = "What happens when an LRU cache reaches capacity?";

test("fixed Provider serves bounded STT and current-question Advisor output without external fallback", async () => {
  const server = createFixedProviderServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const stt1 = await fetch(`${base}/stt`, { method: "POST" });
    const stt2 = await fetch(`${base}/stt`, { method: "POST" });
    assert.equal((await stt1.json()).text, first);
    assert.equal((await stt2.json()).text, second);

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
    await fetch(`${base}/reset`, { method: "POST" });
    assert.equal((await (await fetch(`${base}/stt`, { method: "POST" })).json()).text, first);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
