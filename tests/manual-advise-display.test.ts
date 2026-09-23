import assert from "node:assert/strict";
import test from "node:test";
import { ManualAdviseDisplay, sameAdviseDisplayTarget, type AdviseDisplaySnapshot } from "../src/lib/meeting/manual-advise-display.js";
import { buildMeetingAnswerDisplayModel } from "../src/lib/meeting/meeting-answer-display.js";
import { commitStableAnswerRevision } from "../src/lib/meeting/stable-answer.js";
import { parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";
import { resolveSettledAttemptEvaluationTarget } from "../src/lib/meeting/human-evaluation.js";
import type { MeetingTrace } from "../src/lib/meeting/types.js";

function snapshot(id: string, revision = 1, streaming = false, question = {
  logicalQuestionUnitId: id, logicalQuestionRevision: 1,
}): AdviseDisplaySnapshot {
  const content = `Answer: Answer ${id}\n\nApproach: Approach ${id}\n\nCode:\n\`\`\`ts\n${id}()\n\`\`\`\n\nComplexity: O(n)\n\nWhiteboard: diagram ${id}`;
  const parsed = parseMeetingAnswer(content);
  const stable = commitStableAnswerRevision({
    candidate: { id, content, meetingAnswer: parsed, sourceTraceId: `trace-${id}`,
      kind: "answer", createdAt: 1, basedOnTurnIds: [], basedOnObservationIds: [], confidence: "high" },
    taskId: "parent", ...question,
    authorizedArtifacts: ["answer", "code", "complexity", "whiteboard"],
    sessionId: "session", runtimeEpoch: 1, revision,
  });
  assert.ok(stable);
  return { target: { sessionId: "session", traceId: `trace-${id}`, generationId: id, ...question,
    ...(streaming ? {} : { suggestionId: id, stableRevision: revision }) },
    sections: buildMeetingAnswerDisplayModel({ content, parsedAnswer: parsed }),
    streaming, stable: streaming ? null : stable };
}

test("ML2/3/5 entire A remains across latest B, failed C, D and arbitrary elapsed time", () => {
  const display = new ManualAdviseDisplay();
  const a = snapshot("A"), b = snapshot("B", 2), d = snapshot("D", 3);
  display.select(a, a);
  assert.equal(display.toggle(a.target).accepted, true);
  for (const latest of [b, b, d]) {
    assert.deepEqual(display.select(latest, latest).sections, a.sections);
    assert.equal(display.capture()?.stable?.suggestion.id, "A");
  }
  assert.equal(display.toggle(a.target).reason, "manual-unlock");
  for (let render = 0; render < 5; render++) assert.deepEqual(display.select(snapshot("E", 4, true), d), d);
  display.acknowledgeApplied(a.target);
  assert.deepEqual(display.select(snapshot("E", 4, true), d), d);
  display.acknowledgeApplied(d.target);
  assert.equal(display.select(snapshot("E", 4, true), d).streaming, true);
});

test("ML2/4 only the pinned stream can fill or complete; cancellation revokes partial", () => {
  const display = new ManualAdviseDisplay();
  const a = snapshot("A", 1, true), b = snapshot("B", 2);
  display.select(a, null); display.toggle();
  const continuing = { ...a, sections: { ...a.sections, primaryAnswer: "more A" } };
  assert.equal(display.select(continuing, null).sections.primaryAnswer, "more A");
  assert.equal(display.select(snapshot("B", 2, true), null).target.traceId, "trace-A");
  assert.equal(display.revokeIncomplete("trace-B"), false);
  assert.equal(display.revokeIncomplete("trace-A"), true);
  assert.equal(display.select(snapshot("C", 3, true), b).stable?.suggestion.id, "B");
  display.acknowledgeApplied(b.target);
  display.select(a, b); display.toggle();
  display.complete(snapshot("A"));
  assert.equal(display.revokeIncomplete("trace-A"), false);
  assert.equal(display.select(b, b).stable?.suggestion.id, "A");
});

test("ML6/7 stale Focus identity never retargets, clear/session releases, Pause is inert", () => {
  const display = new ManualAdviseDisplay(), a = snapshot("A"), b = snapshot("B", 2);
  display.select(a, a); display.toggle();
  assert.equal(display.capture(b.target), null);
  assert.equal(display.toggle(b.target).accepted, false);
  assert.equal(display.locked, true);
  display.select({ ...b, target: { ...b.target, sessionId: "new-session" } }, null);
  assert.equal(display.locked, false);
  display.clear(); assert.equal(display.current, null);
  assert.equal(display.toggle().accepted, false);
});

test("ML7 pinned evaluation uses A, pending or unavailable, never newest B", () => {
  const a = snapshot("A");
  const traces = [{ id: "trace-B", status: "success" }, { id: "trace-A", status: "success" }] as MeetingTrace[];
  const pinnedDisplay = { suggestion: a.stable!.suggestion, streaming: false, traceId: "trace-A" };
  assert.equal(resolveSettledAttemptEvaluationTarget({ suggestion: snapshot("B").stable!.suggestion, traces, pinnedDisplay }).traceId, "trace-A");
  assert.equal(resolveSettledAttemptEvaluationTarget({ suggestion: null, traces, pinnedDisplay: { ...pinnedDisplay, streaming: true } }).status, "pending");
  const absent = resolveSettledAttemptEvaluationTarget({ suggestion: null, traces: traces.slice(0, 1), pinnedDisplay });
  assert.equal(absent.status, "unavailable"); assert.equal(absent.traceId, "trace-A");
});

test("B-C1 streaming completion requires selected session and LQU, not original generation", () => {
  const display = new ManualAdviseDisplay(), a = snapshot("A", 1, true);
  display.select(a, null); display.toggle();
  for (const changed of [{sessionId:"other-session"},{logicalQuestionUnitId:"B"},
    {logicalQuestionUnitId:undefined},{logicalQuestionRevision:undefined}]) {
    const completion = snapshot("A");
    completion.target = {...completion.target,...changed};
    display.complete(completion);
    assert.equal(display.select(a, completion).streaming, true);
  }
  const replacement = snapshot("A-prime", 2, false, {
    logicalQuestionUnitId: "A", logicalQuestionRevision: 1,
  });
  display.complete(replacement);
  assert.deepEqual(display.select(snapshot("B"), null), replacement);
});

test("B-C1 selected A accepts a new-generation preview and completion while B stays hidden", () => {
  const display = new ManualAdviseDisplay();
  const a = snapshot("A", 1, true), b = snapshot("B", 2);
  display.select(a, null);
  display.toggle(a.target);
  const question = { logicalQuestionUnitId: "A", logicalQuestionRevision: 1 };
  const preview = snapshot("A-prime", 3, true, question);
  const completed = snapshot("A-prime", 3, false, question);
  assert.deepEqual(display.select(preview, b), preview);
  assert.equal(display.selectedTarget?.generationId, "A-prime");
  assert.equal(display.selectedStable, null);
  assert.deepEqual(display.select(snapshot("B", 2, true), b), preview);
  display.complete(b);
  assert.deepEqual(display.select(b, b), preview);
  display.complete(completed);
  assert.equal(display.selectedStable, completed.stable);
  assert.deepEqual(display.select(preview, b), completed);
  assert.equal(display.locked, true);
});

for (const order of ["B-first", "A-prime-first"]) {
  test(`B-C2/4 ${order}: A-prime replaces completed A without consuming latest B`, () => {
    const display = new ManualAdviseDisplay();
    const a = snapshot("A"), b = snapshot("B", 2);
    const replacement = snapshot("A-prime", 3, false, {
      logicalQuestionUnitId: "A", logicalQuestionRevision: 1,
    });
    display.select(a, a);
    display.toggle();
    if (order === "B-first") assert.deepEqual(display.select(b, b), a);
    display.complete(replacement);
    display.complete(b);
    assert.equal(display.selectedStable, replacement.stable);
    assert.deepEqual(display.select(b, b), replacement);
    assert.equal(display.toggle(replacement.target).reason, "manual-unlock");
    assert.equal(display.selectedStable, null);
    assert.equal(display.selectedTarget, null);
    assert.equal(display.select(snapshot("C", 4, true), b), b);
  });
}

test("B-C1/3 advancing the selected revision rejects older completions and partials", () => {
  const display = new ManualAdviseDisplay();
  const a = snapshot("A"), b = snapshot("B", 2);
  const revisedQuestion = { logicalQuestionUnitId: "A", logicalQuestionRevision: 2 };
  const revised = snapshot("A-revised", 3, false, revisedQuestion);
  display.select(a, a);
  display.toggle();
  display.complete(revised);
  assert.equal(display.selectedStable, revised.stable);
  for (const streaming of [false, true]) {
    const older = snapshot("A-late", 100, streaming, {
      logicalQuestionUnitId: "A", logicalQuestionRevision: 1,
    });
    display.complete(older);
    assert.deepEqual(display.select(older, streaming ? b : older), revised);
    assert.equal(display.selectedTarget?.logicalQuestionRevision, 2);
  }
  assert.deepEqual(display.select(b, b), revised);
});

test("B-C1 stream continuity follows LQU revision even when render generation IDs match", () => {
  const display = new ManualAdviseDisplay();
  const a = snapshot("A"), b = snapshot("B", 2);
  display.select(a, a);
  display.toggle();
  const otherQuestion = { ...snapshot("B", 2, true), target: {
    ...a.target, logicalQuestionUnitId: "B",
  } };
  assert.deepEqual(display.select(otherQuestion, b), a);
  const revisedQuestion = { logicalQuestionUnitId: "A", logicalQuestionRevision: 2 };
  const preview = snapshot("A", 3, true, revisedQuestion);
  assert.deepEqual(display.select(preview, b), preview);
  const revised = snapshot("A", 3, false, revisedQuestion);
  display.complete(revised);
  assert.deepEqual(display.select(preview, b), revised);
  assert.equal(display.selectedStable, revised.stable);
});

test("B-C5 a failed replacement restores completed A without reviving an earlier revision", () => {
  const display = new ManualAdviseDisplay();
  const a = snapshot("A"), b = snapshot("B", 2);
  display.select(a, a);
  display.toggle();
  const revisedQuestion = { logicalQuestionUnitId: "A", logicalQuestionRevision: 2 };
  const preview = snapshot("A-prime", 3, true, revisedQuestion);
  assert.deepEqual(display.select(preview, b), preview);
  assert.equal(display.selectedStable, a.stable);
  assert.equal(display.revokeIncomplete("trace-B"), false);
  assert.equal(display.revokeIncomplete(preview.target.traceId), true);
  assert.equal(display.locked, true);
  assert.deepEqual(display.select(b, b), a);
  assert.equal(display.selectedTarget?.logicalQuestionRevision, 2);
  const late = snapshot("A-late", 100, false, {
    logicalQuestionUnitId: "A", logicalQuestionRevision: 1,
  });
  display.complete(late);
  assert.deepEqual(display.select(late, late), a);
  assert.deepEqual(display.select({ ...late, streaming: true, stable: null }, b), a);
  const recovered = snapshot("A-recovered", 4, false, revisedQuestion);
  display.complete(recovered);
  assert.deepEqual(display.select(b, b), recovered);
  assert.equal(display.selectedStable, recovered.stable);
});

test("B-C1/4 same-LQU latest updates share the accepted stable reference", () => {
  const display = new ManualAdviseDisplay();
  const a = snapshot("A");
  display.select(a, a);
  display.toggle();
  assert.equal(display.selectedStable, a.stable);
  const question = { logicalQuestionUnitId: "A", logicalQuestionRevision: 1 };
  const replacement = snapshot("A-prime", 2, false, question);
  assert.deepEqual(display.select(replacement, replacement), replacement);
  assert.equal(display.selectedStable, replacement.stable);
  display.complete(replacement);
  assert.equal(display.selectedStable, replacement.stable);
  assert.deepEqual(display.select(a, a), replacement);
  const later = snapshot("A-again", 3, false, question);
  assert.deepEqual(display.select(a, later), later);
  assert.equal(display.selectedStable, later.stable);
  display.toggle(later.target);
  assert.equal(display.select(a, later), later);
});

test("B-C3 captured targets remain exact across generation, revision and render changes", () => {
  const display = new ManualAdviseDisplay();
  const a = snapshot("A"), b = snapshot("B", 2);
  display.select(a, a);
  display.toggle();
  const captured = display.capture(a.target)!;
  const replacement = snapshot("A-prime", 3, false, {
    logicalQuestionUnitId: "A", logicalQuestionRevision: 1,
  });
  display.complete(replacement);
  display.select(b, b);
  assert.equal(display.capture(captured.target), null);
  assert.equal(display.toggle(captured.target).reason, "display-target-changed");
  assert.equal(display.locked, true);
  assert.deepEqual(display.capture(replacement.target), replacement);
  for (const change of [
    { sessionId: "other-session" }, { logicalQuestionUnitId: "B" },
    { logicalQuestionRevision: 2 }, { generationId: "other-generation" },
    { suggestionId: "other-suggestion" }, { traceId: "other-trace" }, { stableRevision: 99 },
  ]) {
    const stale = { ...replacement.target, ...change };
    assert.equal(sameAdviseDisplayTarget(stale, replacement.target), false);
    assert.equal(display.capture(stale), null);
    assert.equal(display.toggle(stale).accepted, false);
  }
  assert.equal(sameAdviseDisplayTarget({ ...replacement.target }, replacement.target), true);
  assert.equal(sameAdviseDisplayTarget(undefined, undefined), false);
});

test("B-C1/5 missing LQU identity cannot lock or adopt a generation from another LQU", () => {
  for (const missing of [
    { logicalQuestionUnitId: undefined }, { logicalQuestionRevision: undefined },
    { logicalQuestionUnitId: "" }, { logicalQuestionRevision: NaN },
  ]) {
    for (const streaming of [false, true]) {
      const display = new ManualAdviseDisplay();
      const legacy = snapshot("A", 1, streaming);
      legacy.target = { ...legacy.target, ...missing };
      display.select(legacy, streaming ? null : legacy);
      assert.equal(display.toggle().reason, "no-visible-answer");
      assert.equal(display.locked, false);
    }
  }
  const display = new ManualAdviseDisplay();
  const a = snapshot("A"), b = snapshot("B", 2);
  display.select(a, a);
  display.toggle();
  const impostor = { ...b, target: { ...b.target, ...a.target } };
  display.complete(impostor);
  assert.deepEqual(display.select(impostor, b), a);
  const legacy = { ...snapshot("B", 2, true), target: {
    sessionId: "session", generationId: a.target.generationId, traceId: a.target.traceId,
  } };
  assert.deepEqual(display.select(legacy, b), a);
});

test("B-C4 unlock, clear, new session and relock cannot accept a late different selection", () => {
  const display = new ManualAdviseDisplay();
  const a = snapshot("A"), b = snapshot("B", 2);
  const replacement = snapshot("A-prime", 3, false, {
    logicalQuestionUnitId: "A", logicalQuestionRevision: 1,
  });
  display.select(a, a);
  display.toggle();
  display.toggle();
  display.complete(replacement);
  assert.equal(display.locked, false);
  assert.equal(display.select(b, b), b);
  display.toggle(b.target);
  display.complete(replacement);
  assert.deepEqual(display.select(replacement, b), b);
  display.clear();
  display.complete(replacement);
  assert.equal(display.current, null);
  assert.equal(display.selectedTarget, null);
  assert.equal(display.selectedStable, null);
  const newSession = { ...snapshot("C", 4, true), target: {
    ...snapshot("C", 4, true).target, sessionId: "new-session",
  } };
  assert.equal(display.select(newSession, b), newSession);
  assert.equal(display.toggle().accepted, true);
  display.complete(replacement);
  assert.deepEqual(display.select(newSession, b), newSession);
  assert.deepEqual(display.selectedTarget, newSession.target);
});

test("B-C6 unlock awaits exact latest completed ACK and new session clears that wait", () => {
  const display = new ManualAdviseDisplay();
  const a = snapshot("A"), b = snapshot("B", 2), c = snapshot("C", 3, true);
  display.select(a, a);
  display.toggle();
  display.select(b, b);
  display.toggle(a.target);
  assert.equal(display.select(c, b), b);
  assert.equal(display.awaitingApplication(b.target), true);
  display.acknowledgeApplied({ ...b.target, logicalQuestionRevision: 2 });
  assert.equal(display.select(c, b), b);
  display.acknowledgeApplied(b.target);
  assert.equal(display.select(c, b), c);
  display.toggle();
  display.toggle();
  display.select(c, b);
  const nextSession = { ...c, target: { ...c.target, sessionId: "next-session" } };
  assert.equal(display.select(nextSession, b), nextSession);
  assert.equal(display.awaitingApplication(b.target), false);
  assert.equal(display.locked, false);
});

test("B-C5/8 independent sections and stable provenance survive A updates and unlock to B", () => {
  const display = new ManualAdviseDisplay();
  const a = snapshot("A"), b = snapshot("B", 2);
  const replacement = snapshot("A-prime", 3, false, {
    logicalQuestionUnitId: "A", logicalQuestionRevision: 1,
  });
  b.stable!.sections.code.sourceSuggestionId = "B-prior-artifact";
  b.stable!.sections.code.phase = "implementation_validation";
  const originals = structuredClone([a, b, replacement]);
  Object.freeze(a.stable);
  Object.freeze(b.stable);
  Object.freeze(replacement.stable);
  display.select(a, a);
  display.toggle();
  display.select(b, b);
  display.complete(replacement);
  assert.equal(display.selectedStable, replacement.stable);
  const selected = display.select(b, b);
  assert.deepEqual(selected.sections, replacement.sections);
  assert.equal(selected.stable, replacement.stable);
  const captured = display.capture()!;
  captured.sections.code = "mutated captured code";
  captured.stable!.sections.code.sourceSuggestionId = "mutated captured owner";
  const selectedTarget = display.selectedTarget!;
  Object.assign(selectedTarget, { logicalQuestionUnitId: "B" });
  assert.deepEqual(display.capture(), replacement);
  display.toggle(replacement.target);
  const unlocked = display.select(snapshot("C", 4, true), b);
  assert.equal(unlocked, b);
  assert.equal(unlocked.stable, b.stable);
  assert.deepEqual(unlocked.sections, originals[1].sections);
  assert.deepEqual(unlocked.stable!.sections, originals[1].stable!.sections);
  assert.deepEqual([a, b, replacement], originals);
});
