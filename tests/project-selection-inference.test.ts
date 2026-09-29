import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import {
  AIResponseEventBuilder,
  coordinateAIResponseAttempts,
  type AIResponseExecutionIdentity,
  type AIResponseTerminalOutcome,
} from "../src/lib/functions/ai-response-events.js";
import * as runtime from "../src/lib/meeting/runtime-inference.js";
import * as json from "../src/lib/meeting/runtime-json-object.js";
import * as response from "../src/lib/meeting/runtime-inference-response.js";
import type {
  ProjectSelectionInferenceRequest,
} from "../src/lib/meeting/project-selection-inference.js";
import type { RuntimeInferenceRequest } from "../src/lib/meeting/runtime-inference-request.js";

function loadModule<T>(file: string, modules: Record<string, unknown>): T {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, {
    exports, module: { exports }, Error,
    require: (name: string) => {
      assert.ok(name in modules, `uncontrolled import ${name}`);
      return modules[name];
    },
  }, { filename: file });
  return exports as T;
}

function loadInference(requestModule: unknown) {
  return loadModule<typeof import("../src/lib/meeting/project-selection-inference.js")>(
    "src/lib/meeting/project-selection-inference.ts", {
      "./runtime-inference.js": runtime,
      "./runtime-json-object.js": json,
      "./runtime-inference-request.js": requestModule,
    }
  );
}

const inference = loadInference({ requestRuntimeInferenceResponse: () => assert.fail("unexpected request") });
const { buildProjectSelectionInferenceRequest: build, buildProjectSelectionInferencePrompts: prompts,
  parseProjectSelectionInferenceOutput: parse } = inference;
const candidates = [
  { projectId: "project-a", name: "Atlas", aliases: ["A", "Shared alias"] },
  { projectId: "project-b", name: "Beacon", aliases: ["B", "Shared alias"] },
];
function input(meText = "Let's discuss Beacon."): ProjectSelectionInferenceRequest {
  return {
    currentQuestion: "Walk me through a project you built.",
    selectionContext: "Pending choices in display order: Atlas, then Beacon.",
    candidates: structuredClone(candidates),
    meText,
  };
}
const output = (projectId: string | null = "project-b", evidenceSpans = ["Let's discuss Beacon."]) =>
  JSON.stringify({ schemaVersion: 1, projectId, evidenceSpans });
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test("request freezes a semantic-only snapshot without mutating source text or candidate identity", () => {
  const source = input("  Beacon.  ");
  const request = build(source);
  assert.ok(request);
  assert.equal(request.meText, source.meText);
  assert.ok(Object.isFrozen(request));
  assert.ok(Object.isFrozen(request.candidates));
  assert.ok(Object.isFrozen(request.candidates[0]));
  assert.ok(Object.isFrozen(request.candidates[0].aliases));
  assert.notEqual(request.candidates, source.candidates);
  const mutable = source.candidates as typeof candidates;
  mutable[0].aliases.push("late alias");
  mutable[1].projectId = "replacement";
  assert.equal(request.candidates[0].aliases.includes("late alias"), false);
  assert.equal(request.candidates[1].projectId, "project-b");
});

test("prompt projects only bounded semantic fields and reuses payload metadata", () => {
  const source = {
    ...input(), sessionId: "secret-session", currentLQU: { id: "secret-lqu" },
    runtimeEpoch: 9, parentId: "secret-parent", bindingRevision: 4,
    candidates: candidates.map((candidate) => ({ ...candidate, body: "private KMB body", sourceHash: "opaque" })),
  };
  const model = prompts(source);
  const payload = JSON.parse(model.userMessage);
  assert.deepEqual(payload, {
    candidates: candidates.map((candidate) => ({ projectKey: candidate.projectId, name: candidate.name, aliases: candidate.aliases })),
    currentQuestion: source.currentQuestion,
    meText: source.meText,
    selectionContext: source.selectionContext,
  });
  assert.deepEqual(runtime.findRuntimeEnvelopeLeakage(payload), []);
  assert.equal(model.semanticPayloadDigest, runtime.hashRuntimeSemanticPayload(payload));
  assert.equal(model.modelVisibleChars, model.systemPrompt.length + model.userMessage.length);
  assert.doesNotMatch(model.userMessage, /secret-|private KMB|opaque|currentLQU/);
  for (const rule of ["affirmative", "comparison", "negation", "conditional", "brief project name", "single available candidate", "not A, discuss B", "non-unique", "Do not output confidence",
    "Return null for elimination alone", "explicit commitment to discuss the remaining one", "final STT utterance can still be semantically incomplete", "even when only one candidate seems possible"]) {
    assert.ok(model.systemPrompt.includes(rule), rule);
  }
});

const limits = inference.PROJECT_SELECTION_INFERENCE_INPUT_LIMITS;
const invalidInputs: Array<[string, unknown]> = [
  ["absent input", null],
  ["empty question", { ...input(), currentQuestion: " " }],
  ["wrong question type", { ...input(), currentQuestion: 3 }],
  ["question limit", { ...input(), currentQuestion: "q".repeat(limits.currentQuestionChars + 1) }],
  ["context type", { ...input(), selectionContext: [] }],
  ["context limit", { ...input(), selectionContext: "c".repeat(limits.selectionContextChars + 1) }],
  ["empty Me", input("\n ")],
  ["Me limit", input("m".repeat(limits.meTextChars + 1))],
  ["no candidates", { ...input(), candidates: [] }],
  ["wrong candidates type", { ...input(), candidates: {} }],
  ["missing candidate", { ...input(), candidates: [null] }],
  ["candidate limit", { ...input(), candidates: Array.from({ length: limits.candidates + 1 }, (_, i) => ({ ...candidates[0], projectId: `p-${i}` })) }],
  ["duplicate ID", { ...input(), candidates: [candidates[0], candidates[0]] }],
  ["empty ID", { ...input(), candidates: [{ ...candidates[0], projectId: "" }] }],
  ["padded ID", { ...input(), candidates: [{ ...candidates[0], projectId: " project-a " }] }],
  ["ID type", { ...input(), candidates: [{ ...candidates[0], projectId: 7 }] }],
  ["ID limit", { ...input(), candidates: [{ ...candidates[0], projectId: "p".repeat(limits.projectIdChars + 1) }] }],
  ["empty name", { ...input(), candidates: [{ ...candidates[0], name: "" }] }],
  ["name limit", { ...input(), candidates: [{ ...candidates[0], name: "n".repeat(limits.nameChars + 1) }] }],
  ["alias type", { ...input(), candidates: [{ ...candidates[0], aliases: "A" }] }],
  ["alias element type", { ...input(), candidates: [{ ...candidates[0], aliases: [3] }] }],
  ["empty alias", { ...input(), candidates: [{ ...candidates[0], aliases: [" "] }] }],
  ["alias limit", { ...input(), candidates: [{ ...candidates[0], aliases: ["a".repeat(limits.aliasChars + 1)] }] }],
  ["alias count", { ...input(), candidates: [{ ...candidates[0], aliases: Array(limits.aliasesPerCandidate + 1).fill("A") }] }],
  ["total limit", { ...input(), candidates: Array.from({ length: limits.candidates }, (_, i) => ({ projectId: `p-${i}`, name: "n".repeat(limits.nameChars), aliases: ["a".repeat(limits.aliasChars)] })) }],
];
for (const [label, invalid] of invalidInputs) {
  test(`input rejects ${label} without dropping text or candidates`, () => {
    assert.equal(build(invalid as ProjectSelectionInferenceRequest), null);
    assert.throws(() => prompts(invalid as ProjectSelectionInferenceRequest), /Invalid or unbounded/);
    assert.equal(parse(output(), invalid as ProjectSelectionInferenceRequest).ok, false);
  });
}

// Scripted model outputs exercise schema/evidence plumbing, not model recognition quality.
const scriptedChoices: Array<[string, string, string | null]> = [
  ["explicit", "Let's discuss Beacon.", "project-b"],
  ["short name", "Beacon.", "project-b"],
  ["unique alias", "B", "project-b"],
  ["negative then affirmative", "Not Atlas, discuss Beacon.", "project-b"],
  ["Chinese correction", "\u4e0d\u662fA\uff0c\u8bb2B", "project-b"],
  ["contextual reference", "The second one.", "project-b"],
  ["mere experience mention", "I worked on Atlas and Beacon.", null],
  ["comparison", "Atlas was smaller than Beacon.", null],
  ["negation", "Not Beacon.", null],
  ["conditional", "If we discuss reliability, I might choose Atlas.", null],
  ["multiple choices", "Let's discuss both Atlas and Beacon.", null],
  ["ambiguous reference", "That one.", null],
  ["shared alias", "Shared alias", null],
  ["incomplete fragment", "Let's discuss", null],
];
for (const [label, text, projectId] of scriptedChoices) {
  test(`parser preserves scripted ${label} result without claiming semantic validation`, () => {
    const spans = projectId ? [text] : [];
    const parsed = parse(output(projectId, spans), input(text));
    assert.deepEqual(plain(parsed), {
      ok: true, evidenceSpansValid: true,
      value: { schemaVersion: 1, projectId, evidenceSpans: spans },
    });
    assert.equal("authorized" in parsed, false);
  });
}

test("one candidate still requires a supported choice; null is a valid non-selection", () => {
  const request = { ...input("I need a moment."), candidates: [candidates[1]] };
  const parsed = parse(output(null, []), request);
  assert.ok(parsed.ok);
  assert.equal(parsed.value.projectId, null);
  assert.equal(parse(output("project-b", []), request).ok, false);
});

test("parser accepts the common fenced JSON envelope without normalizing evidence", () => {
  const parsed = parse(`\ufeff\n\`\`\`json\n${output()}\n\`\`\``, input());
  assert.ok(parsed.ok);
  assert.equal(parsed.value.projectId, "project-b");
});

test("JSON field cardinality leaves quoted colons and backslashes in evidence intact", () => {
  const text = 'Choice: "Beacon"; label \\B.';
  const parsed = parse(output("project-b", [text]), input(text));
  assert.ok(parsed.ok);
  assert.equal(parsed.value.evidenceSpans[0], text);
});

const invalidOutputs: Array<[string, string]> = [
  ["empty", ""], ["truncated", output().slice(0, -1)],
  ["malformed", "{broken}"], ["array", `[${output()}]`], ["null", "null"],
  ["primitive", "3"], ["prose", `Result: ${output()}`],
  ["two objects", `${output()}\n${output()}`],
  ["duplicate project fields", '{"schemaVersion":1,"projectId":"project-a","projectId":"project-b","evidenceSpans":["Beacon"]}'],
  ["escaped duplicate project field", '{"schemaVersion":1,"projectId":"project-a","project\\u0049d":"project-b","evidenceSpans":["Beacon"]}'],
  ["duplicate schema fields", '{"schemaVersion":2,"schemaVersion":1,"projectId":"project-b","evidenceSpans":["Beacon"]}'],
  ["duplicate evidence fields", '{"schemaVersion":1,"projectId":"project-b","evidenceSpans":["Atlas"],"evidenceSpans":["Beacon"]}'],
  ["output limit", JSON.stringify({ padding: "p".repeat(inference.PROJECT_SELECTION_INFERENCE_MAX_OUTPUT_CHARS) })],
  ...[
    ["unknown ID", { projectId: "new-project" }],
    ["name instead of ID", { projectId: "Beacon" }],
    ["wrong ID case", { projectId: "PROJECT-B" }],
    ["padded ID", { projectId: " project-b " }],
    ["empty ID", { projectId: "" }],
    ["multiple IDs", { projectId: ["project-a", "project-b"] }],
    ["numeric ID", { projectId: 1 }],
    ["object ID", { projectId: { id: "project-b" } }],
    ["boolean ID", { projectId: false }],
    ["wrong version", { schemaVersion: 2 }],
    ["string version", { schemaVersion: "1" }],
    ["missing evidence", { evidenceSpans: [] }],
    ["string evidence", { evidenceSpans: "Beacon" }],
    ["numeric evidence", { evidenceSpans: [3] }],
    ["null evidence", { evidenceSpans: null }],
    ["blank evidence", { evidenceSpans: [" "] }],
    ["duplicate evidence", { evidenceSpans: ["Beacon", "Beacon"] }],
    ["too many spans", { evidenceSpans: ["Let's", "discuss", "Beacon", ".", "Beacon."] }],
    ["long span", { evidenceSpans: ["s".repeat(513)] }],
    ["fabricated span", { evidenceSpans: ["I choose Beacon."] }],
    ["candidate-only evidence", { evidenceSpans: ["Atlas"] }],
    ["question-only evidence", { evidenceSpans: ["Walk me through a project you built."] }],
    ["context-only evidence", { evidenceSpans: ["Pending choices in display order"] }],
    ["non-verbatim case", { evidenceSpans: ["beacon"] }],
    ["non-verbatim whitespace", { evidenceSpans: ["discuss  Beacon"] }],
    ["abstention with evidence", { projectId: null }],
    ["extra choice", { projectIds: ["project-a", "project-b"] }],
    ["extra confidence", { confidence: 0.999 }],
    ["extra semantic dimension", { questionType: "coding" }],
  ].map(([name, extra]) => [name as string, JSON.stringify({ schemaVersion: 1, projectId: "project-b", evidenceSpans: ["Let's discuss Beacon."], ...(extra as object) })] as [string, string]),
];
for (const key of ["schemaVersion", "projectId", "evidenceSpans"]) {
  const value = JSON.parse(output());
  delete value[key];
  invalidOutputs.push([`absent ${key}`, JSON.stringify(value)]);
}
for (const [label, raw] of invalidOutputs) {
  test(`parser rejects ${label} without returning a binding candidate`, () => {
    const parsed = parse(raw, input());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.evidenceSpansValid, false);
    assert.equal("value" in parsed, false);
  });
}

const identity: AIResponseExecutionIdentity = {
  requestId: "request-envelope", executionPlanId: "plan-envelope", modelId: "fast-model",
  sessionId: "session-envelope", runtimeEpoch: 1,
  logicalQuestionUnitId: "lqu-envelope", logicalQuestionRevision: 2,
};
function harness(raw = output(), terminal: Partial<AIResponseTerminalOutcome> = {}, onStart?: () => void) {
  const calls: RuntimeInferenceRequest[] = [];
  let attempts = 0;
  const commonRequest = loadModule("src/lib/meeting/runtime-inference-request.ts", {
    "./runtime-inference-response.js": response,
    "../functions/ai-response.function.js": {
      fetchAIResponseEvents: (params: RuntimeInferenceRequest) => {
        calls.push(params);
        return coordinateAIResponseAttempts({
          identity, providerId: "existing-fast", signal: params.signal,
          retryPolicy: params.requestOptions?.retryPolicy,
          runAttempt: async function* (attemptIdentity) {
            attempts++;
            onStart?.();
            const events = new AIResponseEventBuilder("existing-fast", attemptIdentity);
            if (raw) yield events.content(raw);
            yield events.terminal({ status: raw ? "success" : "empty", retryable: false, ...terminal });
          },
        });
      },
    },
  });
  return { api: loadInference(commonRequest), calls, attempts: () => attempts };
}
function requestInput(request = input()) {
  return {
    request, provider: undefined,
    selectedProvider: { provider: "existing-fast", variables: { MODEL: "fast-model" } },
    signal: new AbortController().signal, executionIdentity: identity,
  };
}

test("request uses common typed collection, caller-supplied provider, exact budget and no retry", async () => {
  const h = harness();
  let firstTokens = 0;
  const params = { ...requestInput(), onFirstToken: () => firstTokens++ };
  const result = await h.api.requestProjectSelectionInference(params);
  assert.equal(h.calls.length, 1);
  assert.equal(h.attempts(), 1);
  const sent = h.calls[0];
  assert.equal(sent.selectedProvider, params.selectedProvider);
  assert.equal(sent.signal, params.signal);
  assert.equal(sent.executionIdentity, identity);
  assert.deepEqual(plain(sent.requestOptions), { timeoutMs: 3_000, maxOutputTokens: 512, retryPolicy: { maxAttempts: 1 } });
  assert.equal((sent as unknown as { applyResponseSettings: boolean }).applyResponseSettings, false);
  assert.equal(sent.userMessage, prompts(params.request).userMessage);
  assert.doesNotMatch(sent.userMessage, /-envelope/);
  assert.equal(result.parsed.ok, true);
  assert.equal(result.parseDisposition, "valid-json");
  assert.equal(result.providerAttempts?.length, 1);
  assert.equal(result.providerOutcome.maxAttempts, 1);
  assert.equal(result.providerOutcome.status, "success");
  assert.equal(firstTokens, 1);
});

test("request parser retains the pre-await source/candidate snapshot", async () => {
  const source = input();
  const h = harness(output(), {}, () => {
    (source as { meText: string }).meText = "Not Beacon.";
    (source.candidates as typeof candidates)[1].projectId = "replacement";
  });
  const result = await h.api.requestProjectSelectionInference(requestInput(source));
  assert.equal(result.parsed.ok, true, "caller must reject a stale lease, not reparse against ambient state");
  assert.equal(JSON.parse(h.calls[0].userMessage).meText, "Let's discuss Beacon.");
});

for (const [label, terminal] of [
  ["timeout", { status: "timed-out", retryable: true, completionSignal: "request-timeout" }],
  ["authentication", { status: "failed", failureClass: "authentication", retryable: false }],
  ["retryable HTTP error", { status: "failed", failureClass: "provider-http", retryable: true, statusCode: 503 }],
] as const) {
  test(`request ignores even valid JSON on ${label} and never retries`, async () => {
    const h = harness(output(), terminal);
    const result = await h.api.requestProjectSelectionInference(requestInput());
    assert.equal(result.parsed.ok, false);
    assert.equal(result.rawOutput, "");
    assert.ok(result.parseDisposition.startsWith("not-run-"));
    assert.equal(result.providerOutcome.status, terminal.status);
    assert.equal(result.providerAttempts?.length, 1);
    assert.equal(h.attempts(), 1);
  });
}

test("empty/invalid output does not retry or fabricate a selection", async () => {
  for (const raw of ["", "{}", output().slice(0, -1), output("unknown")]) {
    const h = harness(raw);
    const result = await h.api.requestProjectSelectionInference(requestInput());
    assert.equal(result.parsed.ok, false);
    assert.equal(h.attempts(), 1);
  }
});

test("aborted and oversized responses never return a parsed choice", async () => {
  const h = harness(output(), { status: "aborted" });
  await assert.rejects(h.api.requestProjectSelectionInference(requestInput()), { name: "AbortError" });
  assert.equal(h.attempts(), 1);
  const cancelled = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(cancelled.api.requestProjectSelectionInference({ ...requestInput(), signal: controller.signal }), { name: "AbortError" });
  assert.equal(cancelled.attempts(), 1, "the typed coordinator enters its initial attempt; transport owns the pre-fetch abort guard");
  const oversized = harness(output() + " ".repeat(inference.PROJECT_SELECTION_INFERENCE_MAX_OUTPUT_CHARS));
  await assert.rejects(oversized.api.requestProjectSelectionInference(requestInput()), /configured limit/);
  assert.equal(oversized.attempts(), 1);
});

test("invalid request is rejected before provider invocation", async () => {
  const h = harness();
  await assert.rejects(h.api.requestProjectSelectionInference(requestInput({ ...input(), candidates: [] })), /Invalid or unbounded/);
  assert.equal(h.calls.length, 0);
});
