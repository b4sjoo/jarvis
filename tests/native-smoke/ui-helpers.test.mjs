import test from "node:test";
import assert from "node:assert/strict";
import { elementIndex, assertStatusIdentity, createSmokeChecks } from "./ui-helpers.mjs";

test("selectors require exactly one currently observed element", () => {
  assert.equal(elementIndex("  12 button Focus\n13 button Normal", "button Focus"), 12);
  assert.throws(() => elementIndex("12 button Focus\n13 button Focus", "button Focus"));
  assert.throws(() => elementIndex("12 button Other", "button Focus"));
});

test("an edited native field retains its placeholder-based locator", () => {
  const field = "text field (settable) Correction: RAG not rec / Glean";
  assert.equal(elementIndex(`14 ${field}`, field), 14);
  const filled = "14 text field (settable) Value: RAG not rec, Placeholder: Correction: RAG not rec / Glean";
  assert.equal(elementIndex(filled, field), 14);
  assert.throws(() => elementIndex(`${filled}\n15 ${field}`, field));
});

test("old identity, missing readiness and observer errors cannot pass", () => {
  const state = JSON.stringify({frontend:{buildId:"new",statusViewMounted:true},native:{buildId:"new"}},null,2)
    .split("\n").map((line,index)=>`${index+1} text ${line}`).join("\n");
  assert.doesNotThrow(() => assertStatusIdentity(state, "new"));
  assert.throws(() => assertStatusIdentity(state, "old"));
  assert.throws(() => assertStatusIdentity(state.replace('"statusViewMounted": true', '"statusViewMounted": false'), "new"));
  assert.throws(() => assertStatusIdentity(state + " BUILD ID MISMATCH", "new"));
});

test("connection failure stops further actions but allows cleanup", async () => {
  const saved = [];
  const checks = createSmokeChecks({ save: async steps => saved.push(structuredClone(steps)) });
  await assert.rejects(checks.step("connect", async () => { throw new Error("unavailable"); }));
  await assert.rejects(checks.step("click", async () => assert.fail("must not execute")));
  await checks.step("quit", async () => {}, { cleanup: true });
  assert.deepEqual(saved.at(-1).map(step => step.status), ["failed", "passed"]);
});

test("tool overhead exceeding the frozen budget is not reported as a pass", async () => {
  let time = 0;
  const checks = createSmokeChecks({ now: () => time });
  await assert.rejects(checks.step("slow", async () => { time = 11000; }));
  assert.equal(checks.steps[0].elapsedMs, 11000);
  assert.equal(checks.steps[0].status, "failed");
});

test("missing evidence cannot leave a passed step or allow more ordinary actions", async () => {
  const checks = createSmokeChecks({ save: async () => { throw new Error("unwritable evidence"); } });
  await assert.rejects(checks.step("read", async () => {}));
  assert.equal(checks.steps[0].status,"failed");
  await assert.rejects(checks.step("next", async () => assert.fail("must not execute")));
});
