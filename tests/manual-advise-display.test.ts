import assert from "node:assert/strict";
import test from "node:test";
import { ManualAdviseDisplay, type AdviseDisplaySnapshot } from "../src/lib/meeting/manual-advise-display.js";
import { buildMeetingAnswerDisplayModel } from "../src/lib/meeting/meeting-answer-display.js";
import { commitStableAnswerRevision } from "../src/lib/meeting/stable-answer.js";
import { parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";
import { resolveSettledAttemptEvaluationTarget } from "../src/lib/meeting/human-evaluation.js";
import type { MeetingTrace } from "../src/lib/meeting/types.js";

function snapshot(id: string, revision = 1, streaming = false): AdviseDisplaySnapshot {
  const content = `Answer: Answer ${id}\n\nApproach: Approach ${id}\n\nCode:\n\`\`\`ts\n${id}()\n\`\`\`\n\nComplexity: O(n)\n\nWhiteboard: diagram ${id}`;
  const parsed = parseMeetingAnswer(content);
  const stable = commitStableAnswerRevision({
    candidate: { id, content, meetingAnswer: parsed, sourceTraceId: `trace-${id}`,
      kind: "answer", createdAt: 1, basedOnTurnIds: [], basedOnObservationIds: [], confidence: "high" },
    taskId: "parent", logicalQuestionUnitId: id, logicalQuestionRevision: 1,
    authorizedArtifacts: ["answer", "code", "complexity", "whiteboard"],
    sessionId: "session", runtimeEpoch: 1, revision,
  });
  assert.ok(stable);
  return { target: { sessionId: "session", traceId: `trace-${id}`, generationId: id,
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

test("ML4 streaming completion requires the original session, generation and trace", () => {
  const display = new ManualAdviseDisplay(), a = snapshot("A", 1, true);
  display.select(a, null); display.toggle();
  for (const changed of [{sessionId:"other-session"},{generationId:"other-generation"},{traceId:"other-trace"}]) {
    const completion = snapshot("A");
    completion.target = {...completion.target,...changed};
    display.complete(completion);
    assert.equal(display.select(a, completion).streaming, true);
  }
  display.complete(snapshot("A"));
  assert.equal(display.select(a, null).streaming, false);
});
