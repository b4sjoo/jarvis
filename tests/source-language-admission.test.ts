import assert from "node:assert/strict";
import test from "node:test";
import { readMeetingInputLanguages, isMeetingInputLanguageSet } from "../src/config/meeting-input-languages.js";
import { readDecisionsProviderConfiguration } from "../src/config/decisions.constants.js";
import { requestSourceLanguageAdmission, buildSourceLanguageQuestion } from "../src/lib/meeting/source-language-admission.js";
import { deriveFirstParentLanguage, sourceLanguageAdmissionMatches, type SourceLanguageAdmission } from "../src/lib/meeting/source-language-contract.js";
import { RuntimeInferenceProviderAdmissionCoordinator } from "../src/lib/meeting/runtime-inference-provider-admission.js";
import { createProviderConfigFingerprint } from "../src/lib/meeting/meeting-model-route.js";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import type { TranscriptTurn } from "../src/lib/meeting/types.js";

const selection = { provider: "openai-decisions", variables: { api_key: "synthetic-secret", model: "gpt-6-luna" } };
const configuration = readDecisionsProviderConfiguration(selection).snapshot!;
const identity = { requestId: "language-1", executionPlanId: "language-1", modelId: "gpt-6-luna", sessionId: "session",
  runtimeEpoch: 1, logicalQuestionUnitId: "unscoped", logicalQuestionRevision: 0 };
const input = () => ({ sessionId: "session", runtimeEpoch: 1, turnId: "turn", text: "Explain the cache.",
  allowedLanguages: ["en", "zh"] as const, configuration, admission: new RuntimeInferenceProviderAdmissionCoordinator(),
  signal: new AbortController().signal, executionIdentity: identity });
const output = (choice = "en", extra: Record<string, unknown> = {}) => JSON.stringify({ answers: [{
  type: "choice", name: "input_language", choice, confidence: .1, probabilities: [{ value: choice, probability: .2 }], ...extra,
}] });
const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test("LP203: upgrade defaults, invalid policy, and bounded choices preserve the admitted-language contract", () => {
  assert.deepEqual(readMeetingInputLanguages(null), ["en", "zh"]);
  for (const value of ["null", "[]", "[\"en\",\"en\"]", "[\"ja\"]", "{"]) assert.deepEqual(readMeetingInputLanguages(value), []);
  assert.equal(isMeetingInputLanguageSet(["zh"]), true);
  assert.deepEqual(buildSourceLanguageQuestion(["en"]).choices.map(c => c.value), ["en", "other"]);
  assert.deepEqual(buildSourceLanguageQuestion(["en", "zh"]).choices.map(c => c.value), ["en", "zh", "other"]);
  assert.match(buildSourceLanguageQuestion(["en", "zh"]).instructions, /combination/);
});

test("LA135: timely known choices admit or exclude without a score threshold and with exactly one Decisions call", async t => {
  let calls = 0;let choice = "en";
  t.mock.method(globalThis, "fetch", async (_url: any, init: RequestInit) => {
    calls++;const body = JSON.parse(String(init.body));assert.equal(body.input, "Explain the cache.");
    assert.equal(body.questions.length, 1);assert.equal(body.questions[0].name, "input_language");
    return new Response(output(choice));
  });
  for (choice of ["en", "zh", "other"]) {
    const result = await requestSourceLanguageAdmission(input());
    assert.equal(result.disposition, choice === "other" ? "excluded" : "admitted");
    assert.equal(result.language, choice === "other" ? undefined : choice);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
  }
  assert.equal(calls, 3);
});

test("LA135: refusal, invalid/empty contract, HTTP/configuration/transport failures admit without inventing a language", async t => {
  const variants = ["", "{", output("outside"), output("en", { type: "refusal" }),
    output("en", { confidence: null, probabilities: [] }), ...[401, 403, 429, 500], new Error("transport")];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    const variant = variants[calls++];if (variant instanceof Error) throw variant;
    return typeof variant === "number" ? new Response("secret", { status: variant }) : new Response(variant);
  });
  for (let i = 0; i < variants.length; i++) {
    const result = await requestSourceLanguageAdmission(input());
    assert.equal(result.disposition, "fallback-admitted");assert.equal(result.language, undefined);
  }
  const absent = await requestSourceLanguageAdmission({ ...input(), configuration: undefined });
  const invalid = await requestSourceLanguageAdmission({ ...input(), allowedLanguages: [] });
  assert.equal(absent.disposition, "fallback-admitted");assert.equal(invalid.reason, "language-policy-configuration-error");
  assert.equal(calls, variants.length);
});

test("LA135: one 1500ms deadline includes provider queue; a queued expiry cannot dispatch later", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const admission = new RuntimeInferenceProviderAdmissionCoordinator(1, 0);
  let release!: () => void;let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++;return new Response(output()); });
  const blocker = admission.run({ operationId: "blocker", lane: "critical", signal: new AbortController().signal,
    providerConfigFingerprint: createProviderConfigFingerprint({ provider: undefined, selectedProvider: selection }),
    execute: () => new Promise<void>(resolve => { release = resolve; }) });
  await drain();
  const pending = requestSourceLanguageAdmission({ ...input(), admission });
  await drain();t.mock.timers.tick(1499);await drain();assert.equal(requests, 0);
  t.mock.timers.tick(1);await drain();
  const result = await pending;assert.equal(result.disposition, "fallback-admitted");assert.equal(result.reason, "deadline");
  assert.equal(result.completedAt - result.startedAt, 1500);
  release();await blocker;await drain();assert.equal(requests, 0);
});

test("LA135: active deadline ignores late other; external cancellation never becomes fail-open", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  let release!: (response: Response) => void;
  t.mock.method(globalThis, "fetch", async () => new Promise<Response>(resolve => { release = resolve; }));
  const pending = requestSourceLanguageAdmission(input());await drain();
  t.mock.timers.tick(1500);await drain();
  const result = await pending;assert.equal(result.disposition, "fallback-admitted");
  release(new Response(output("other")));await drain();assert.equal(result.disposition, "fallback-admitted");
  const controller = new AbortController();
  const cancelled = requestSourceLanguageAdmission({ ...input(), signal: controller.signal });await drain();
  controller.abort();await assert.rejects(cancelled, { name: "AbortError" });
});

test("LA135: context state, Advisor prompt and latestTurn exclude the same source while raw display remains; Force restores only its exact version", () => {
  const manager = new MeetingContextManager();manager.reset({ sessionId: "session" });
  const turn = (id: string, text: string, disposition: SourceLanguageAdmission["disposition"]): TranscriptTurn => ({
    id, text, speaker: "them", source: "system-audio", startedAt: Date.now(), endedAt: Date.now(), isFinal: true,
    contextPromptEligible: disposition !== "excluded",
    languageAdmission: { sessionId: "session", runtimeEpoch: 1, turnId: id, sourceText: text, allowedLanguages: ["en", "zh"],
      disposition, reason: "fixture", startedAt: 1, completedAt: 2 },
  });
  manager.addTranscriptTurn(turn("a", "A useful setup statement.", "admitted"));
  manager.addTranscriptTurn(turn("b", "Rejected source B.", "excluded"));
  manager.addTranscriptTurn(turn("c", "Rejected source C.", "excluded"));
  assert.deepEqual(manager.getDisplayTranscriptTurns().map(t => t.id), ["a", "b", "c"]);
  assert.deepEqual(manager.getState().transcriptTurns.map(t => t.id), ["a"]);
  assert.equal(manager.buildAdvisorPromptContext().latestTurn?.id, "a");
  assert.doesNotMatch(manager.buildAdvisorPromptContext().transcript, /Rejected/);
  const restore = { sessionId: "session", runtimeEpoch: 1, turnId: "b", text: "Rejected source B." };
  for (const changed of [{ sessionId: "new" }, { runtimeEpoch: 2 }, { text: "revised" }, { turnId: "missing" }]) {
    assert.equal(manager.restoreLanguageAdmission({ ...restore, ...changed }), false);
  }
  assert.equal(manager.restoreLanguageAdmission(restore), true);
  assert.deepEqual(manager.getState().transcriptTurns.map(t => t.id), ["a", "b"]);
  assert.match(manager.buildAdvisorPromptContext().transcript, /Rejected source B/);
  assert.doesNotMatch(manager.buildAdvisorPromptContext().transcript, /Rejected source C/);
  const old = manager.getDisplayTranscriptTurns()[2].languageAdmission;
  assert.equal(sourceLanguageAdmissionMatches(old, { ...restore, turnId: "c", text: "Corrected source C." }), false);
  manager.reset({ sessionId: "new" });assert.equal(manager.restoreLanguageAdmission(restore), false);
});

test("LP203: first actual new-parent uses its creation source, not the newest transcript; observation is session-once", () => {
  const turns = ["a", "b"].map((id, index) => ({ id, text: id, speaker: "them", languageAdmission: {
    sessionId: "session", runtimeEpoch: 1, turnId: id, sourceText: id, allowedLanguages: ["en", "zh"],
    disposition: "admitted", language: index ? "zh" : "en", reason: "allowed", startedAt: 0, completedAt: 1,
  } as SourceLanguageAdmission }));
  const input = { sessionId: "session", runtimeEpoch: 1, authorized: true, mutationApplied: true,
    transition: "create-parent", parent: { id: "parent-a", canonicalQuestionSourceTurnIds: ["a"] }, source: turns[0].languageAdmission, now: 2 };
  const observation = deriveFirstParentLanguage(input)!;
  assert.equal(observation.turnId, "a");assert.equal(observation.language, "en");
  for (const changed of [{ authorized: false }, { mutationApplied: false }, { transition: "resume-parent" },
    { transition: "replace-parent", previousParentId: "parent-a" }, { runtimeEpoch: 2 },
    { parent: { id: "screen-only" } }, { parent: undefined }, { previous: observation }]) {
    assert.equal(deriveFirstParentLanguage({ ...input, ...changed }), undefined);
  }
  for (const disposition of ["excluded", "fallback-admitted"] as const) {
    const copy = structuredClone(turns);copy[0].languageAdmission.disposition = disposition;
    assert.equal(deriveFirstParentLanguage({ ...input, source: copy[0].languageAdmission }), undefined);
  }
  const newSessionTurns = turns.map(t => ({ ...t, languageAdmission: { ...t.languageAdmission, sessionId: "new" } }));
  assert.equal(deriveFirstParentLanguage({ ...input, previous: observation, sessionId: "new", source: newSessionTurns[0].languageAdmission })?.sessionId, "new");
  assert.equal(deriveFirstParentLanguage({ ...input, source: turns[1].languageAdmission }), undefined);
});
