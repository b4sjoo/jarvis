import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { spawnSync } from "node:child_process";

const tool = await import(pathToFileURL(resolve("scripts/calibrate-question-type.mjs")).href);
const secret = "fixture-private-key-DO-NOT-RECORD";
const config = {
  provider: { id: "fixture", streaming: false, responseContentPath: "choices[0].message.content",
    curl: `curl https://fixture.invalid/chat/completions -H 'Authorization: Bearer {{API_KEY}}' -d '{"model":"{{MODEL}}","messages":[{"role":"system","content":"{{SYSTEM_PROMPT}}"},{"role":"user","content":"{{TEXT}}"}]}'` },
  selectedProvider: { provider: "fixture", variables: { api_key: secret, model: "fixture-model" } },
};
const valid = JSON.stringify({ v: 1, t: "field-knowledge", c: 0.95, e: "HNSW" });
const response = (content = valid) => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 } }), { headers: { "content-type": "application/json" } });

test("frozen plan has eight inputs, 24 alternating pairs, 48 operations and no expected payload", () => {
  const plan = tool.createPlan(config);
  assert.equal(plan.operations.length, 48);
  assert.equal(plan.maxAttempts, 96);
  assert.equal(plan.deadlineMs, 4000);
  assert.equal(plan.inputs.length, 8);
  for (let i = 0; i < 24; i++) {
    assert.deepEqual(plan.operations.slice(i * 2, i * 2 + 2).map((x: any) => x.cap), i % 2 ? [1024, 512] : [512, 1024]);
  }
  assert.ok(!JSON.stringify(plan).includes(secret));
  for (const input of plan.inputs) {
    assert.ok(!input.prompts.userMessage.includes("expected"));
    assert.ok(!input.prompts.userMessage.includes(input.id));
  }
  const runtime = tool.createProductionRuntime({ cap: 512 });
  const source = tool.frozenInputs[2];
  assert.deepEqual(runtime.prompts(runtime.makeRequest(source)), runtime.prompts(runtime.makeRequest({ ...source, expected: "NEVER_SEND_THIS_LABEL", category: "NEVER_SEND_THIS_CATEGORY" })));
  assert.equal(tool.createPlan(config).configHash, plan.configHash);
});

test("production request, body construction, parser and coordinator recover once with remaining budget", async () => {
  const calls: any[] = [];
  let now = 1000;
  const runtime = tool.createProductionRuntime({ cap: 1024, now: () => now, fetchImpl: async (_url: string, init: any) => {
    calls.push(JSON.parse(init.body));
    now += 600;
    return calls.length === 1 ? new Response("unavailable", { status: 503 }) : response();
  } });
  const request = runtime.makeRequest(tool.frozenInputs[2]);
  const result = await runtime.run({ config, request, operationId: "fixture-op" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].max_completion_tokens, 1024);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(result.parsed.ok, true);
  assert.equal(result.providerAttempts.length, 2);
  assert.equal(result.providerAttempts[0].statusCode, 503);
  assert.notEqual(result.providerAttempts[0].attemptId, result.providerAttempts[1].attemptId);
  assert.equal(runtime.requests[0].timeoutMs, 4000);
  assert.equal(runtime.requests[1].timeoutMs, 3400);
  assert.equal(result.providerAttempts[1].nativeFinishReason, "stop");
  assert.equal(result.providerAttempts[1].tokenUsage.outputTokens, 12);
  assert.equal(result.providerAttempts[0].nativeFinishReason, undefined);
});

test("malformed JSON retries, semantic mismatch/auth/rate-limit/evidence mismatch do not reroll", async () => {
  for (const first of ["malformed", "wrong-type", "evidence", 401, 429]) {
    let calls = 0;
    const runtime = tool.createProductionRuntime({ cap: 512, fetchImpl: async () => {
      calls++;
      if (calls > 1) return response();
      if (typeof first === "number") return new Response("rejected", { status: first });
      return response(first === "malformed" ? '{"v":1' : JSON.stringify({ v: 1, t: "coding", c: 0.9, e: first === "evidence" ? "absent evidence" : "HNSW" }));
    } });
    await runtime.run({ config, request: runtime.makeRequest(tool.frozenInputs[2]), operationId: String(first) });
    assert.equal(calls, first === "malformed" ? 2 : 1);
  }
});

test("deadline expires without a fresh retry window; late valid output is not on-time", async () => {
  let now = 1000;
  let calls = 0;
  const runtime = tool.createProductionRuntime({ cap: 512, now: () => now, fetchImpl: async () => {
    calls++;
    now += 4100;
    return response();
  } });
  const result = await runtime.run({ config, request: runtime.makeRequest(tool.frozenInputs[2]), operationId: "late" });
  assert.equal(calls, 1);
  assert.equal(result.onTimeStrictValid, false);
});

test("dry-run never fetches; exclusive manifest and claim prevent duplicate execution across output paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "type-calibration-"));
  try {
    const options = { config, outputDir: join(dir, "out"), ledgerDir: join(dir, "ledger"), mode: "dry-run", fetchImpl: () => { throw new Error("must not fetch"); } };
    await tool.runExperiment(options);
    assert.equal(JSON.parse(readFileSync(join(dir, "out", "manifest.json"), "utf8")).mode, "dry-run");
    await assert.rejects(tool.runExperiment(options));
    const live = { ...options, mode: "fixture", outputDir: join(dir, "fixture"), fetchImpl: async () => response(JSON.stringify({ v: 1, t: "field-knowledge", c: 0.9, e: "HNSW", r: secret })) };
    const result = await tool.runExperiment(live);
    assert.equal(result.actualOperations, 48);
    assert.ok(result.actualAttempts <= 96);
    await assert.rejects(tool.runExperiment({ ...live, outputDir: join(dir, "other") }));
    assert.ok(!readFileSync(join(dir, "fixture", "operations.jsonl"), "utf8").includes(secret));
    const journal = readFileSync(join(dir, "fixture", "attempts.jsonl"), "utf8");
    assert.ok(!journal.includes(secret));
    assert.equal(journal.trim().split("\n").map(line => JSON.parse(line)).filter(row => row.event === "http-start").length, 48);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI accepts read-only env config for dry-run and does not log secrets on failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "type-calibration-cli-"));
  try {
    const command = [resolve("scripts/calibrate-question-type.mjs"), "--output", join(dir, "out")];
    const env = { ...process.env, JARVIS_TYPE_CALIBRATION_CONFIG: "", JARVIS_TYPE_CALIBRATION_CONFIG_JSON: JSON.stringify(config) };
    const result = spawnSync(process.execPath, command, { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).mode, "dry-run");
    assert.equal(JSON.parse(result.stdout).attempts, 0);
    const failed = spawnSync(process.execPath, command, { env: { ...env, JARVIS_TYPE_CALIBRATION_CONFIG_JSON: secret }, encoding: "utf8" });
    assert.equal(failed.status, 1);
    assert.ok(!(failed.stdout + failed.stderr).includes(secret));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("all malformed outputs consume exactly 48 operations / 96 HTTP calls with zero valid results", async () => {
  const dir = mkdtempSync(join(tmpdir(), "type-calibration-ceiling-"));
  let calls = 0;
  try {
    const result = await tool.runExperiment({ config, outputDir: join(dir, "out"), ledgerDir: join(dir, "claims"), mode: "fixture",
      fetchImpl: async () => { calls++; return response('{"v":1'); } });
    assert.equal(calls, 96);
    assert.equal(result.actualProviderCalls, 96);
    assert.equal(result.actualOperations, 48);
    assert.equal(result.byCap[512].onTimeStrictValid, 0);
    assert.equal(result.byCap[1024].successfulOutputDenominator, 0);
    assert.equal(result.byCap[512].operations, 24);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("streaming production decoder keeps native metadata and honest missing metadata", async () => {
  for (const metadata of [true, false]) {
    const runtime = tool.createProductionRuntime({ cap: 512, fetchImpl: async () => {
      const frames = [`data: ${JSON.stringify({ choices: [{ delta: { content: valid } }] })}\n\n`];
      if (metadata) frames.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }], usage: { completion_tokens: 512, completion_tokens_details: { reasoning_tokens: 490 } } })}\n\n`);
      frames.push("data: [DONE]\n\n");
      return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
    } });
    const result = await runtime.run({ config: { ...config, provider: { ...config.provider, streaming: true } }, request: runtime.makeRequest(tool.frozenInputs[2]), operationId: `stream-${metadata}` });
    assert.equal(result.parsed.ok, true);
    assert.equal(result.providerAttempts.length, 1);
    assert.equal(result.providerOutcome.nativeFinishReason, metadata ? "length" : undefined);
    assert.equal(result.providerOutcome.tokenUsage?.reasoningTokens, metadata ? 490 : undefined);
  }
});

test("current builtin Gemini config composes real body, caps and parser using fixture-only credentials", async () => {
  const selectedProvider = { provider: "gemini", variables: { api_key: secret, model: "gemini-3.8-flash" } };
  const builtin = tool.resolveBuiltinProviderConfig(selectedProvider);
  const bodies: any[] = [];
  for (const cap of [512, 1024]) {
    const runtime = tool.createProductionRuntime({ cap, fetchImpl: async (url: string, init: any) => {
      assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
      bodies.push(JSON.parse(init.body));
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: valid }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    } });
    const result = await runtime.run({ config: builtin, request: runtime.makeRequest(tool.frozenInputs[2]), operationId: `gemini-${cap}` });
    assert.equal(result.parsed.ok, true);
    assert.equal(bodies.at(-1).max_tokens, cap);
    assert.equal(bodies.at(-1).model, selectedProvider.variables.model);
    assert.equal(bodies.at(-1).stream, true);
  }
  assert.deepEqual(bodies[0].messages, bodies[1].messages);
  assert.equal(tool.createPlan({ selectedProvider }).config.model, "gemini-3.8-flash");
});

test("original deadline prevents recovery on a late first failure", async () => {
  let now = 1000;
  let calls = 0;
  const runtime = tool.createProductionRuntime({ cap: 512, now: () => now, fetchImpl: async () => {
    calls++; now += 4001; return new Response("unavailable", { status: 503 });
  } });
  const result = await runtime.run({ config, request: runtime.makeRequest(tool.frozenInputs[2]), operationId: "expired" });
  assert.equal(calls, 1);
  assert.equal(result.onTimeStrictValid, false);
});

test("live API refuses a run without the reviewed manifest hash before any call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "type-calibration-review-"));
  try {
    await assert.rejects(tool.runExperiment({ config, outputDir: dir, mode: "live" }), /Reviewed manifest hash required/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("configuration or authentication failure stops the finite experiment without a reroll", async () => {
  const dir = mkdtempSync(join(tmpdir(), "type-calibration-auth-"));
  let calls = 0;
  try {
    const result = await tool.runExperiment({ config, outputDir: join(dir, "out"), ledgerDir: join(dir, "claims"), mode: "fixture",
      fetchImpl: async () => { calls++; return new Response("unauthorized", { status: 401 }); } });
    assert.equal(calls, 1);
    assert.equal(result.actualOperations, 1);
    assert.equal(result.status, "stopped");
    assert.equal(result.stopReason, "provider-configuration-or-authentication-failed");
    assert.equal(result.byCap[512].onTimeStrictValid, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("artifacts redact echoed credentials while retaining results and separate denominators", async () => {
  const redacted = tool.redact({ nested: { text: `echo ${secret}` }, safe: "stop" }, config);
  assert.ok(!JSON.stringify(redacted).includes(secret));
  const summary = tool.summarize([
    { cap: 512, strictValidOutput: true, onTimeStrictValid: true, semanticCorrect: false, durationMs: 10, attempts: [{ strictValid: true }] },
    { cap: 512, onTimeStrictValid: false, semanticCorrect: false, durationMs: 4001, attempts: [{ strictValid: false }] },
  ]);
  assert.equal(summary.byCap[512].operations, 2);
  assert.equal(summary.byCap[512].onTimeStrictValid, 1);
  assert.equal(summary.byCap[512].semanticCorrectAllLabeled, 0);
  assert.equal(summary.byCap[512].successfulOutputDenominator, 1);
});
