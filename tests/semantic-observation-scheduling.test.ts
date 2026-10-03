import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { runSemanticScheduling, semanticSchedulingHook } from "./helpers/semantic-observation-hook.js";
import { SemanticTaxonomyRuntime, type SemanticTaxonomyWorkerLike } from "../src/lib/meeting/semantic-taxonomy-runtime.js";
import type { SemanticTaxonomyWorkerRequest, SemanticTaxonomyWorkerResponse } from "../src/lib/meeting/semantic-taxonomy-runtime.protocol.js";
import * as sufficiency from "../src/lib/meeting/answer-sufficiency.js";
import * as sufficiencySemantic from "../src/lib/meeting/answer-sufficiency-semantic-resolver.js";
import { parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";

const source = readFileSync("src/hooks/useMeetingAssistant.ts", "utf8");
for (const embeddingStatus of ["success", "timeout", "error", "unavailable"]) {
  for (const parent of [false, true]) {
    test(`formal handles remain independent of ${embeddingStatus} observation; parent=${parent}`, async () => {
      // 178/168 PC: the embedding observation is admitted by Runtime Cross-checks.
      const result = await runSemanticScheduling(source, { embeddingStatus, parent, runtimeCrossChecks: true });
      const stages = result.events.map((event: any[]) => event[0]);
      assert.equal(stages.filter((stage: string) => stage === "type").length, 1);
      assert.equal(stages.filter((stage: string) => stage === "relation").length, 1);
      assert.ok(stages.indexOf("pin") < stages.indexOf("type"));
      assert.ok(stages.indexOf("type") < stages.indexOf("relation"));
      assert.ok(stages.indexOf("relation") < stages.indexOf("embed"));
      assert.equal(result.lateAuthorization.authorized, false);
      assert.ok(stages.includes("taxonomy"));
    });
  }
}
test("ineligible observation leaves formal inference running; stale observation cannot produce authority", async () => {
  const skipped = await runSemanticScheduling(source, { eligible: false, runtimeCrossChecks: true });
  assert.equal(skipped.events.some((event: any[]) => event[0] === "embed"), false);
  assert.equal(skipped.events.filter((event: any[]) => event[0] === "type" || event[0] === "relation").length, 2);
  const stale = await runSemanticScheduling(source, { stale: true, runtimeCrossChecks: true });
  assert.ok(stale.events.some((event: any[]) => event[0] === "finish" && event[3] === "cancelled"));
});
test("three actual callers use the formal scheduler and the observer returns no product handle", () => {
  assert.equal((source.match(/scheduleQuestionRuntime\(\{/g) ?? []).length, 3);
  assert.doesNotMatch(source, /scheduleSemanticTaxonomyShadow/);
  const observer = source.slice(source.indexOf("const prepareSemanticTaxonomyObservation"), source.indexOf("const scheduleQuestionRuntime"));
  assert.doesNotMatch(observer, /scheduleQuestionTypeAdjudication|scheduleTaskRelationAdjudication|RuntimeAdjudicationScheduleHandle/);
  const linkage = source.slice(source.indexOf("const scheduleSourceLinkageAdjudication"), source.indexOf("const scheduleWhiteboardSyntaxRepairShadow"));
  assert.doesNotMatch(linkage, /runtimeReleaseRequested|evaluationActive|debugModeRef|sessionRecordingManagerRef\.current\?\.getState/);
});

// ---------------------------------------------------------------------------
// 178/168 PC: the Semantic Type / Interviewer Intent embedding is an observation
// admitted by Runtime Cross-checks. Formal Type and Relation scheduling, the
// session pin, Answer Sufficiency and the shared runtime are not behind it.
// ---------------------------------------------------------------------------

const stagesOf = (result: any) => result.events.map((event: any[]) => event[0]) as string[];
const traceUpdatesOf = (result: any) => result.events.filter((event: any[]) => event[0] === "metadata").map((event: any[]) => event[2]);
const decisionsOf = (result: any, kind: "taxonomy" | "intent") =>
  result.events.filter((event: any[]) => event[0] === kind).map((event: any[]) => event[1].metadata);
const interviewerIntentEmbeds = (result: any) =>
  result.events.filter((event: any[]) => event[0] === "embed" && event[2].consumer === "interviewer-intent");

// PC2, Semantic family: the original eligibility is fixed (an accepted interviewer
// turn of three or more word-equivalents), Debug x Recording x Cross-checks are crossed.
for (const debug of [false, true]) for (const recording of [false, true]) for (const runtimeCrossChecks of [false, true]) {
  test(`PC2 PC5 Semantic Type / Interviewer Intent observation debug=${debug} recording=${recording} crossChecks=${runtimeCrossChecks}`, async () => {
    for (const parent of [false, true]) {
      const result = await runSemanticScheduling(source, { parent, debug, recording, runtimeCrossChecks });
      const stages = stagesOf(result);
      // Formal Type and Relation are scheduled exactly once, before any embedding, whatever the switches say.
      assert.equal(stages.filter((stage) => stage === "type").length, 1);
      assert.equal(stages.filter((stage) => stage === "relation").length, 1);
      assert.ok(stages.indexOf("pin") >= 0 && stages.indexOf("pin") < stages.indexOf("type"), "the session pin is not behind the switch");
      assert.ok(stages.indexOf("type") < stages.indexOf("relation"));
      assert.equal(result.lateAuthorization.authorized, false);
      // Counted per consumer: this consumer's embedding requests.
      assert.equal(interviewerIntentEmbeds(result).length, runtimeCrossChecks ? 1 : 0, "interviewer-intent embedding requests");
      assert.equal(result.embeddingRevision, runtimeCrossChecks ? 1 : 0, "embedding revision bumps");
      const updates = traceUpdatesOf(result);
      const final = Object.assign({}, ...updates);
      assert.equal(final.taxonomySemanticEligible, true, "the turn is eligible in every cell");
      assert.equal(final.taxonomySemanticRescueApplied, false);
      assert.equal(final.taxonomySemanticBehaviorMutationBlocked, true);
      assert.equal(final.taxonomyHybridEffectiveType, final.taxonomyKeywordType);
      if (runtimeCrossChecks) {
        // On: observation only. One request yields the Type score, the hybrid comparison and the Intent score.
        assert.ok(stages.indexOf("relation") < stages.indexOf("embed"));
        assert.equal(interviewerIntentEmbeds(result)[0][1].texts.length, parent ? 2 : 1);
        assert.equal(updates.length, 2);
        assert.equal(final.taxonomySemanticObservationTrigger, "runtime-cross-checks");
        assert.equal(updates[0].taxonomySemanticObservationTrigger, "runtime-cross-checks", "recorded at the start");
        assert.equal(final.taxonomySemanticObservationSkipReason, undefined);
        assert.equal(final.taxonomySemanticEmbeddingStatus, "success");
        assert.equal(final.interviewerIntentSemanticEmbeddingStatus, "success");
        assert.notEqual(final.taxonomyHybridReason, "runtime-cross-checks-off");
        assert.ok(Object.keys(final.taxonomySemanticPerTypeScores).length > 0, "Type scored");
        assert.ok(final.interviewerIntentSemanticSpeechActTopCandidate, "Intent scored");
        assert.equal(stages.filter((stage) => stage === "start" || stage === "finish").length, 2);
      } else {
        // Off: no embedding, no step, no score, no hybrid comparison; the skip is named and is
        // neither a failed, a successful nor an ineligible embedding.
        assert.equal(stages.includes("embed"), false);
        assert.equal(stages.includes("start"), false);
        assert.equal(stages.includes("finish"), false);
        assert.equal(updates.length, 1);
        assert.equal(final.taxonomySemanticObservationSkipReason, "runtime-cross-checks-off");
        assert.equal(final.taxonomyHybridReason, "runtime-cross-checks-off");
        assert.equal(final.taxonomySemanticObservationTrigger, undefined);
        assert.equal(final.taxonomySemanticEmbeddingStatus, "not-requested");
        assert.equal(final.interviewerIntentSemanticEmbeddingStatus, "not-requested");
        assert.equal(final.taxonomySemanticEmbeddingReason, undefined);
        assert.equal(final.taxonomySemanticTimeout, false);
        assert.deepEqual(final.taxonomySemanticPerTypeScores, {});
        assert.equal(final.taxonomySemanticCandidateType, undefined);
        assert.equal(final.taxonomySemanticAccepted, false);
        assert.equal(final.taxonomyHybridRecommendedType, undefined);
        assert.equal(final.taxonomyHybridWouldRescue, false);
        assert.equal(final.interviewerIntentSemanticSpeechActTopCandidate, undefined);
        assert.equal(final.interviewerIntentSemanticSpeechActAccepted, false);
        // The in-memory carrier the Advisor reads holds the same skip, not a model result.
        assert.deepEqual(result.evidence[0][1].metadata, updates[0]);
      }
      // Recording decides only whether the decision is written.
      for (const kind of ["taxonomy", "intent"] as const) {
        assert.equal(decisionsOf(result, kind).length, recording ? 1 : 0, `${kind} decisions recorded`);
        if (recording) assert.deepEqual(decisionsOf(result, kind)[0], updates.at(-1));
      }
    }
    // On or off, the original eligibility still decides: a short turn is ineligible and is not a skip.
    const ineligible = await runSemanticScheduling(source, { eligible: false, debug, recording, runtimeCrossChecks });
    const short = Object.assign({}, ...traceUpdatesOf(ineligible));
    assert.equal(interviewerIntentEmbeds(ineligible).length, 0);
    assert.deepEqual([short.taxonomySemanticEligible, short.taxonomySemanticEligibilityReason, short.taxonomyHybridReason,
      short.taxonomySemanticObservationSkipReason, short.taxonomySemanticObservationTrigger],
    [false, "turn-too-short", "turn-too-short", undefined, undefined]);
    assert.equal(stagesOf(ineligible).filter((stage) => stage === "type" || stage === "relation").length, 2);
  });
}

test("PC5 an observation admitted while Cross-checks was on completes after it is switched off; a turn scheduled while off is never embedded later", async () => {
  // In flight when the switch goes off: the request is not cancelled and its result is recorded as observed.
  const admitted = semanticSchedulingHook(source, { parent: true, runtimeCrossChecks: true });
  admitted.schedule();
  admitted.env.runtimeCrossChecksEnabledRef.current = false;
  admitted.completeEmbedding()({ status: "success", embeddings: [Array(384).fill(0), Array(384).fill(0)],
    telemetry: {}, cacheHit: false, reason: "fixture", durationMs: 5 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const completed = admitted.events.filter((event: any[]) => event[0] === "taxonomy").map((event: any[]) => event[1].metadata);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].taxonomySemanticEmbeddingStatus, "success");
  assert.equal(completed[0].taxonomySemanticObservationTrigger, "runtime-cross-checks", "the start-time configuration is kept");
  // Scheduled while off: turning the switch on afterwards does not go back for it.
  const skipped = semanticSchedulingHook(source, { parent: true, runtimeCrossChecks: false });
  skipped.schedule();
  skipped.env.runtimeCrossChecksEnabledRef.current = true;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(skipped.events.some((event: any[]) => event[0] === "embed"), false);
  assert.equal(skipped.completeEmbedding(), undefined);
});

// The per-turn evidence carrier the Advisor reads keeps the latest 32 turns. A
// turn that never embeds (Cross-checks off, or an ineligible turn) must not let
// it grow for the rest of the session.
const SEMANTIC_EVIDENCE_TURNS = 32;
for (const [name, input] of [
  ["Cross-checks off", { runtimeCrossChecks: false }],
  ["Cross-checks on", { runtimeCrossChecks: true }],
  ["Cross-checks off and ineligible turns", { runtimeCrossChecks: false, eligible: false }],
  ["Cross-checks on and ineligible turns", { runtimeCrossChecks: true, eligible: false }],
] as const) {
  test(`PC5 the per-turn semantic evidence carrier keeps the latest ${SEMANTIC_EVIDENCE_TURNS} turns with ${name}`, async () => {
    const h = semanticSchedulingHook(source, input);
    const evidence = h.env.semanticTaxonomyEvidenceByTurnRef.current as Map<string, { turnId: string; metadata: Record<string, unknown> }>;
    const turnIds = Array.from({ length: 100 }, (_unused, index) => `turn-${index}`);
    let embeddings = 0;
    for (const turnId of turnIds) {
      h.turn.id = turnId;
      const previous = h.completeEmbedding();
      h.schedule();
      const complete = h.completeEmbedding();
      if (complete && complete !== previous) {
        embeddings += 1;
        complete({ status: "success", embeddings: [Array(384).fill(0)], telemetry: {}, cacheHit: false, reason: "fixture", durationMs: 5 });
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.equal(evidence.size <= SEMANTIC_EVIDENCE_TURNS, true, `evidence turns kept after ${turnId}: ${evidence.size}`);
      // The turn the Advisor is about to read is always there.
      assert.equal(evidence.get(turnId)?.turnId, turnId);
    }
    assert.equal(embeddings, input.runtimeCrossChecks && !("eligible" in input) ? turnIds.length : 0, "embedding requests");
    assert.deepEqual([...evidence.keys()], turnIds.slice(-SEMANTIC_EVIDENCE_TURNS), "the latest turns, oldest first");
  });
}

test("PC5 an embedding that completes after its turn left the evidence carrier puts that turn back and the carrier is pruned to the cap again", async () => {
  const completions: Array<(value: unknown) => void> = [];
  const h = semanticSchedulingHook(source, { runtimeCrossChecks: true, runtime: {
    pinSession: () => undefined, getSnapshot: () => ({ readiness: "ready", modelVersion: "fixture" }),
    embed: () => new Promise((resolve) => { completions.push(resolve); }) } });
  const evidence = h.env.semanticTaxonomyEvidenceByTurnRef.current as Map<string, { turnId: string; metadata: Record<string, unknown> }>;
  // Forty turns are scheduled while every embedding is still in flight. Each has
  // its own turn object, so a completion writes under the turn it was scheduled for.
  for (let index = 0; index < 40; index += 1) h.schedule({ ...h.turn, id: `turn-${index}` });
  assert.equal(completions.length, 40);
  assert.equal(evidence.size, SEMANTIC_EVIDENCE_TURNS);
  assert.equal(evidence.has("turn-0"), false, "the oldest turn was evicted while its embedding was in flight");
  assert.equal(evidence.has("turn-8"), true);
  // The oldest turn's embedding now completes: that turn is written again.
  completions[0]!({ status: "success", embeddings: [Array(384).fill(0)], telemetry: {}, cacheHit: false, reason: "fixture", durationMs: 5 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(evidence.get("turn-0")?.metadata.taxonomySemanticEmbeddingStatus, "success", "the evicted turn is back with its completed evidence");
  // The completion path prunes too: the carrier is at the cap, the newest turn is kept
  // and the turn that is now the oldest made room.
  assert.equal(evidence.size, SEMANTIC_EVIDENCE_TURNS);
  assert.equal(evidence.has("turn-39"), true, "the newest turn is still present");
  assert.equal(evidence.has("turn-8"), false);
});

// A worker that answers every request, as the real one does, and counts what it was asked.
class CountingSemanticWorker implements SemanticTaxonomyWorkerLike {
  onmessage: ((event: MessageEvent<SemanticTaxonomyWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  disposeRequests = 0;
  embeds: Array<{ turnId: string; texts: string[] }> = [];
  held: Array<() => void> = [];
  hold = false;
  postMessage(message: SemanticTaxonomyWorkerRequest) {
    const emit = (response: SemanticTaxonomyWorkerResponse) =>
      this.onmessage?.({ data: response } as MessageEvent<SemanticTaxonomyWorkerResponse>);
    if (message.type === "initialize") {
      queueMicrotask(() => emit({ type: "ready", requestId: message.requestId, modelVersion: "test-model", durationMs: 1 }));
      return;
    }
    if (message.type === "dispose") {
      this.disposeRequests += 1;
      queueMicrotask(() => emit({ type: "disposed", requestId: message.requestId }));
      return;
    }
    this.embeds.push({ turnId: message.input.turnId, texts: message.input.texts });
    const answer = () => emit({ type: "embedding", requestId: message.requestId, input: message.input,
      embeddings: message.input.texts.map(() => Array(384).fill(0)), durationMs: 1 });
    if (this.hold) this.held.push(answer);
    else queueMicrotask(answer);
  }
  terminate() { this.terminated = true; }
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

// The Hook's real Answer Sufficiency scheduler, the real observer and the real
// shared runtime, with only the worker substituted.
function sharedRuntimeHarness(runtimeCrossChecks: boolean) {
  const worker = new CountingSemanticWorker();
  const runtime = new SemanticTaxonomyRuntime({ workerFactory: () => worker });
  const lifecycle: string[] = [];
  for (const method of ["dispose", "releaseSession"] as const) {
    const original = (runtime as any)[method].bind(runtime);
    (runtime as any)[method] = (...args: unknown[]) => { lifecycle.push(method); return original(...args); };
  }
  const hook = semanticSchedulingHook(source, { parent: true, runtimeCrossChecks, runtime });
  const sufficiencyDecisions: any[] = [];
  Object.assign(hook.env, { ...sufficiency, ...sufficiencySemantic,
    answerRevisionByQuestionRef: { current: new Map([["question", 1]]) } });
  hook.env.sessionRecordingManagerRef.current.recordAnswerSufficiencyDecision = (value: any) => sufficiencyDecisions.push(value.decision);
  const scheduleSufficiency = hook.loadCallback("scheduleAnswerSufficiencySemanticShadow");
  const parsedAnswer = parseMeetingAnswer("Answer: Use a bounded queue with backpressure and a worker pool.");
  const decision = { operationId: "answer-sufficiency:trace", questionId: "question", logicalQuestionUnitId: "q",
    logicalQuestionUnitRevision: 1, answerRevision: 1, answerStatus: "sufficient" };
  return { worker, runtime, lifecycle, hook, sufficiencyDecisions,
    sufficiency: (overrides: Record<string, unknown> = {}) => scheduleSufficiency({ traceId: "trace", taskId: "task",
      questionText: hook.turn.text, parsedAnswer, decision: { ...decision, ...overrides } }) };
}

test("PC5 the shared runtime stays up with Cross-checks off: Answer Sufficiency embeds and settles the same, and nothing is disposed, released or cleared", async () => {
  const outcomes: Record<string, any> = {};
  for (const runtimeCrossChecks of [false, true]) {
    const h = sharedRuntimeHarness(runtimeCrossChecks);
    h.hook.schedule();
    await settle();
    // Counted per consumer at the real worker.
    assert.equal(h.worker.embeds.filter((embed) => embed.turnId === "t").length, runtimeCrossChecks ? 1 : 0,
      "interviewer-intent embeddings computed");
    assert.equal(h.runtime.getSnapshot().pinnedReason, "accepted-latest-interviewer-turn", "the session pin does not depend on the switch");
    // Answer Sufficiency: current answer revision, then a superseded one.
    h.sufficiency();
    await settle();
    h.hook.env.answerRevisionByQuestionRef.current.set("question", 2);
    h.sufficiency();
    await settle();
    const sufficiencyEmbeds = h.worker.embeds.filter((embed) => embed.turnId === "q:answer:1");
    assert.equal(sufficiencyEmbeds.length >= 1, true, "Answer Sufficiency embedded");
    assert.equal(h.sufficiencyDecisions.length, 2);
    assert.notEqual(h.sufficiencyDecisions[0].semanticDisposition, "stale");
    assert.equal(h.sufficiencyDecisions[1].semanticDisposition, "stale", "a superseded answer revision is still dropped");
    assert.deepEqual(h.lifecycle, [], "dispose and releaseSession calls");
    assert.deepEqual([h.worker.disposeRequests, h.worker.terminated, h.runtime.getSnapshot().readiness], [0, false, "ready"]);
    // Plain data: the decisions were built in the Hook callbacks' own realm.
    outcomes[String(runtimeCrossChecks)] = JSON.parse(JSON.stringify({ texts: sufficiencyEmbeds[0]!.texts,
      decisions: h.sufficiencyDecisions.map(({ semanticDurationMs: _duration, ...decision }) => decision) }));
    await h.runtime.dispose("test-complete");
  }
  // The Sufficiency request and its settled decisions do not depend on the switch.
  assert.deepEqual(outcomes.false, outcomes.true);
});

test("PC5 switching Cross-checks off does not clear the shared queue: a queued Answer Sufficiency request and an in-flight observation both complete", async () => {
  const h = sharedRuntimeHarness(true);
  await h.runtime.prewarm();
  h.worker.hold = true;
  h.hook.schedule();
  h.sufficiency();
  await settle();
  // One compute runs at a time: the observation is at the worker, Sufficiency waits in the queue.
  assert.deepEqual(h.worker.embeds.map((embed) => embed.turnId), ["t"]);
  // The Hook's own setter turns the switch off.
  const setter = h.hook.loadCallback("setRuntimeCrossChecksEnabled");
  const lifecycleRecords: any[] = [];
  h.hook.env.updateSettings = () => undefined;
  h.hook.env.sessionRecordingManagerRef.current.recordCaptureLifecycle = (value: unknown) => lifecycleRecords.push(value);
  setter(false);
  assert.deepEqual(JSON.parse(JSON.stringify(lifecycleRecords)), [{ stage: "runtime-cross-checks-updated",
    runtimeCrossChecksEnabled: false, previousRuntimeCrossChecksEnabled: true }]);
  assert.equal(h.hook.env.runtimeCrossChecksEnabledRef.current, false);
  await settle();
  assert.deepEqual(h.lifecycle, [], "dispose and releaseSession calls");
  h.worker.hold = false;
  for (const answer of h.worker.held.splice(0)) answer();
  await settle();
  await settle();
  assert.deepEqual(h.worker.embeds.map((embed) => embed.turnId), ["t", "q:answer:1"], "both requests reached the worker");
  assert.equal(h.sufficiencyDecisions.length, 1);
  assert.notEqual(h.sufficiencyDecisions[0].semanticDisposition, "stale");
  const observed = h.hook.events.filter((event: any[]) => event[0] === "taxonomy").map((event: any[]) => event[1].metadata);
  assert.deepEqual(observed.map((metadata: any) => [metadata.taxonomySemanticEmbeddingStatus, metadata.taxonomySemanticObservationTrigger]),
    [["success", "runtime-cross-checks"]]);
  assert.deepEqual([h.worker.disposeRequests, h.worker.terminated, h.runtime.getSnapshot().readiness], [0, false, "ready"]);
  await h.runtime.dispose("test-complete");
});

// PC4 / PC5: who reads the switch. The four observation admission points, the
// follow-up Canonical, the setter and the sync effect, and nothing else: not the
// formal Type, Relation, Response Opportunity, Source Linkage, Answer Resolution,
// Advisor, Fact Risk Review or Answer Sufficiency paths, and not scheduleQuestionRuntime.
test("PC4 PC5 only the four observation admission points, the follow-up Canonical and the setter read Runtime Cross-checks", () => {
  const ast = ts.createSourceFile("hook.ts", source, ts.ScriptTarget.Latest, true);
  const readers: Record<string, number> = {};
  const owner = (node: ts.Node) => {
    // The named callback, or the effect, whose body contains the access.
    let named: string | undefined;
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
      if (ts.isVariableDeclaration(current) && current.parent.parent.parent &&
        ts.isBlock(current.parent.parent.parent) && ts.isFunctionDeclaration(current.parent.parent.parent.parent)) {
        named = current.name.getText(ast);
      }
      if (ts.isCallExpression(current) && current.expression.getText(ast) === "useEffect" && !named) named = "useEffect";
    }
    return named ?? "useMeetingAssistant";
  };
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "current" &&
      node.expression.getText(ast) === "runtimeCrossChecksEnabledRef") {
      const name = owner(node);
      readers[name] = (readers[name] ?? 0) + 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.deepEqual(readers, {
    scheduleWhiteboardSyntaxRepairShadow: 1,
    scheduleMeetingMetadataInference: 1,
    // Once at the start of an operation and once, live, before the automatic follow-up Canonical.
    scheduleTaskRelationSplitRuntime: 2,
    prepareSemanticTaxonomyObservation: 1,
    // The setter reads the previous value and assigns the new one; the effect keeps the ref in sync.
    setRuntimeCrossChecksEnabled: 2,
    useEffect: 1,
  });
  // The setting itself is read by name only where it is stored, loaded, synced and held constant in the reuse inputs.
  const scheduleQuestionRuntime = source.slice(source.indexOf("const scheduleQuestionRuntime"),
    source.indexOf("const scheduleAdvisorAfterQuestionTypeWindow"));
  assert.doesNotMatch(scheduleQuestionRuntime, /runtimeCrossChecks/);
  const sufficiencyAndPrewarm = source.slice(source.indexOf("const prewarmSemanticTaxonomyRuntime"),
    source.indexOf("const finishRunningAdvisorJobTrace"));
  assert.doesNotMatch(sufficiencyAndPrewarm, /runtimeCrossChecks/);
  assert.doesNotMatch(source, /previewMode/);
  // Debug no longer admits any of the four families.
  for (const [from, to] of [
    ["const scheduleWhiteboardSyntaxRepairShadow", "const repairCandidateWhiteboard"],
    ["const scheduleMeetingMetadataInference", "const request = buildMeetingMetadataInferenceRequest"],
    ["const scheduleTaskRelationSplitRuntime", "const splitRecordingManager"],
    ["const prepareSemanticTaxonomyObservation", "const scheduleQuestionRuntime"],
  ]) {
    const start = source.indexOf(from);
    const end = source.indexOf(to, start);
    assert.ok(start >= 0 && end > start, `${from} admission region`);
    assert.doesNotMatch(source.slice(start, end), /debugModeRef|getState\(\)\.active/, `${from} admission`);
  }
});
