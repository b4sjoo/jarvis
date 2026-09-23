import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHumanEvaluationSelectionSnapshot,
  captureHumanGroundTruthEvaluationTarget,
  resolveSettledAttemptEvaluationTarget,
  type CurrentQuestionEvaluationIdentity,
} from "../src/lib/meeting/human-evaluation.js";
import {
  resolveHumanEvaluationAttemptRevisionV2,
  validateHumanEvaluationAttemptSubjectV2,
} from "../src/lib/meeting/human-evaluation-attempt.js";
import {
  appendHumanGroundTruthEventV2,
  buildHumanGroundTruthSubjectV2,
  createHumanGroundTruthEventV2,
  deriveHumanEvaluationProjectionV2,
} from "../src/lib/meeting/human-ground-truth-v2.js";
import {
  ManualAdviseDisplay,
  type AdviseDisplaySnapshot,
} from "../src/lib/meeting/manual-advise-display.js";
import { buildMeetingAnswerDisplayModel } from "../src/lib/meeting/meeting-answer-display.js";
import { parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";
import { commitStableAnswerRevision } from "../src/lib/meeting/stable-answer.js";
import {
  composeCanonicalTurnCandidate,
  formatLogicalQuestionUnitForTrace,
} from "../src/lib/meeting/logical-question-unit.js";
import {
  createProvisionalCurrentQuestion,
  formatCurrentQuestionSettlementForTrace,
  settleCurrentQuestion,
} from "../src/lib/meeting/current-question-settlement.js";
import {
  buildEffectiveAdvisorSettlementView,
  formatEffectiveAdvisorSettlementViewForTrace,
} from "../src/lib/meeting/settled-advisor-execution-plan.js";
import type { ActiveMeetingTask } from "../src/lib/meeting/meeting-task-contracts.js";
import type { AdvisorSuggestion, MeetingTrace } from "../src/lib/meeting/types.js";

// Identity-only extract from session-2026-09-23T08-51-17-332Z_fnslm0,
// the four trace JSON files used by /tmp/jarvis-b-evaluation-readonly.cjs.
// No prompts, transcript, answer bodies, or saved human labels are copied.
const sessionId = "meeting_1790153477305_qr5xy1";
const parentId = "interview_parent_1790153481999_my6wkf";
const questionA = "logical_question_1790153481331_yk871h";
const questionB = "logical_question_1790153516102_n06ni9";
const currentQuestion: CurrentQuestionEvaluationIdentity = {
  sessionId, logicalQuestionUnitId: questionB, logicalQuestionRevision: 1,
};
const recordedAttempts = [
  { id: "voice_trace_1790153481312_ycktj7", startedAt: 1790153481312, endedAt: 1790153487238,
    logicalQuestionUnitId: questionA, taskRuntimeRevision: 0, stableRevision: 1,
    settlementId: "question_settlement_1nzwvtf", sourceHash: "question_source_5uktz7",
    sourceTurnId: "turn_1790153481317_gxru6l" },
  { id: "voice_trace_1790153516086_mckiir", startedAt: 1790153516086, endedAt: 1790153529150,
    logicalQuestionUnitId: questionB, taskRuntimeRevision: 1, stableRevision: 2,
    settlementId: "question_settlement_99cmxc", sourceHash: "question_source_133lir8",
    sourceTurnId: "turn_1790153516089_oo08n2" },
  { id: "voice_trace_1790153541120_ctftdc", startedAt: 1790153541120, endedAt: 1790153548563,
    logicalQuestionUnitId: questionA, taskRuntimeRevision: 0, stableRevision: 3,
    settlementId: "question_settlement_1nzwvtf", sourceHash: "question_source_5uktz7",
    sourceTurnId: "turn_1790153481317_gxru6l" },
  { id: "voice_trace_1790153571020_v1036c", startedAt: 1790153571020, endedAt: 1790153575202,
    logicalQuestionUnitId: questionA, taskRuntimeRevision: 0, stableRevision: 4,
    settlementId: "question_settlement_1nzwvtf", sourceHash: "question_source_5uktz7",
    sourceTurnId: "turn_1790153481317_gxru6l" },
];

function tracesFromRecording(): MeetingTrace[] {
  return recordedAttempts.map((entry) => ({
    id: entry.id, kind: "voice", status: "success",
    startedAt: entry.startedAt, endedAt: entry.endedAt,
    steps: [], inputs: [], outputs: [],
    metadata: {
      effectiveCurrentQuestionSettlementSessionId: sessionId,
      effectiveCurrentQuestionSettlementUnitId: entry.logicalQuestionUnitId,
      effectiveCurrentQuestionSettlementRevision: entry.taskRuntimeRevision,
      effectiveCurrentQuestionSettlementUnitRevision: 1,
      effectiveCurrentQuestionSettlementId: entry.settlementId,
      effectiveCurrentQuestionSettlementSourceHash: entry.sourceHash,
      currentQuestionSettlementRevision: 1,
      logicalQuestionUnitRevision: 1,
      questionInstanceId: `trace:${entry.logicalQuestionUnitId === questionA
        ? recordedAttempts[0].id : entry.id}`,
      activeMeetingTaskId: parentId,
      logicalQuestionSourceTurnIds: [entry.sourceTurnId],
      stableAnswerRevision: entry.stableRevision,
    },
  }));
}

function suggestion(trace: MeetingTrace): AdvisorSuggestion {
  return {
    id: `suggestion:${trace.id}`, sourceTraceId: trace.id, kind: "answer",
    content: "Answer: Synthetic answer body.", createdAt: trace.endedAt ?? trace.startedAt,
    basedOnTurnIds: [], basedOnObservationIds: [], confidence: "medium",
  };
}

function displaySnapshot(trace: MeetingTrace): AdviseDisplaySnapshot {
  const value = suggestion(trace);
  const logicalQuestionUnitId = trace.metadata!.effectiveCurrentQuestionSettlementUnitId as string;
  const revision = trace.metadata!.stableAnswerRevision as number;
  const stable = commitStableAnswerRevision({
    sessionId, revision, logicalQuestionUnitId, logicalQuestionRevision: 1,
    candidate: { ...value, meetingAnswer: parseMeetingAnswer(value.content) },
    taskId: parentId, authorizedArtifacts: ["answer"], committedAt: trace.endedAt,
  });
  assert.ok(stable);
  return {
    target: { sessionId, logicalQuestionUnitId, logicalQuestionRevision: 1,
      traceId: trace.id, suggestionId: value.id, generationId: value.id, stableRevision: revision },
    stable,
    streaming: false,
    sections: buildMeetingAnswerDisplayModel({ content: value.content }),
  };
}

test("recorded B identities keep B selected after later same-parent Regenerate and Enhance A", () => {
  const [a, b, regenerate, enhance] = tracesFromRecording();
  for (const traces of [[b, a], [regenerate, b, a], [enhance, regenerate, b, a]]) {
    assert.deepEqual(resolveSettledAttemptEvaluationTarget({
      suggestion: suggestion(b), traces, currentSessionId: sessionId, currentQuestion,
    }), { status: "ready", traceId: b.id, reason: "visible-answer-source" });
  }
  assert.equal(a.metadata!.activeMeetingTaskId, b.metadata!.activeMeetingTaskId);
  assert.ok(enhance.endedAt! > b.endedAt!);
});

test("recorded display lock evaluates the actual A attempt; unlocking evaluates current B", () => {
  const [a, b, regenerate, enhance] = tracesFromRecording();
  const traces = [enhance, regenerate, b, a];
  const display = new ManualAdviseDisplay();
  const aDisplay = displaySnapshot(a), bDisplay = displaySnapshot(b);
  display.select(aDisplay, aDisplay);
  display.toggle();
  display.select(bDisplay, bDisplay);
  display.complete(displaySnapshot(regenerate));
  display.select(bDisplay, bDisplay);
  display.complete(displaySnapshot(enhance));
  const locked = display.select(bDisplay, bDisplay);
  assert.equal(locked.target.traceId, enhance.id);
  const lockedTarget = resolveSettledAttemptEvaluationTarget({
    suggestion: suggestion(b), traces, currentSessionId: sessionId, currentQuestion,
    pinnedDisplay: { suggestion: locked.stable!.suggestion, streaming: locked.streaming, traceId: locked.target.traceId },
  });
  assert.equal(lockedTarget.traceId, enhance.id);
  const lockedCapture = captureHumanGroundTruthEvaluationTarget({ trace: enhance, frozenAt: 100 });
  assert.equal(lockedCapture.attemptId, enhance.id);
  assert.equal(lockedCapture.logicalQuestionUnitRevision, 1);

  display.toggle(locked.target);
  const unlocked = display.select(bDisplay, bDisplay);
  assert.equal(unlocked.target.traceId, b.id);
  const unlockedTarget = resolveSettledAttemptEvaluationTarget({
    suggestion: unlocked.stable!.suggestion, traces, currentSessionId: sessionId, currentQuestion,
  });
  assert.equal(unlockedTarget.traceId, b.id);
  assert.equal(captureHumanGroundTruthEvaluationTarget({ trace: b, frozenAt: 101 }).attemptId, b.id);
  assert.equal(lockedCapture.attemptId, enhance.id);
});

for (const kind of ["voice", "screen"] as const) {
  for (const status of ["running", "error", "cancelled", "success"] as const) {
    test(`current ${kind} ${status} attempt remains eligible before any B answer`, () => {
      const [a, b, , enhance] = tracesFromRecording();
      b.kind = kind;
      b.status = status;
      delete b.endedAt;
      delete b.metadata!.stableAnswerRevision;
      const target = resolveSettledAttemptEvaluationTarget({
        suggestion: suggestion(a), traces: [enhance, b, a], currentSessionId: sessionId, currentQuestion,
      });
      assert.deepEqual(target, {
        status: status === "running" ? "pending" : "trace-only", traceId: b.id,
        reason: status === "running" ? "settled-attempt-in-progress" : "latest-settled-attempt",
      });
    });
  }
}

test("filters session, LQU and source revision before existing latest-qualified ordering", () => {
  const [a, b] = tracesFromRecording();
  const staleRevision = structuredClone(b);
  staleRevision.id = "old-revision-later-completion";
  staleRevision.endedAt = b.endedAt! + 100;
  staleRevision.metadata!.effectiveCurrentQuestionSettlementUnitRevision = 0;
  staleRevision.metadata!.currentQuestionSettlementRevision = 0;
  staleRevision.metadata!.logicalQuestionUnitRevision = 0;
  const otherSession = structuredClone(b);
  otherSession.id = "other-session";
  otherSession.metadata!.effectiveCurrentQuestionSettlementSessionId = "other-session";
  const unqualified = { ...b, id: "unqualified", metadata: {} };
  const older = { ...b, id: "older-qualified", endedAt: b.endedAt! + 200 };
  assert.equal(resolveSettledAttemptEvaluationTarget({
    suggestion: null, currentQuestion,
    traces: [a, staleRevision, otherSession, unqualified, b, older],
  }).traceId, b.id);
});

test("missing or mismatched current identity never falls back to global latest or visible A", () => {
  const [a, b, , enhance] = tracesFromRecording();
  const unavailableIdentities = [
    undefined,
    { ...currentQuestion, logicalQuestionUnitId: "new-question" },
    { ...currentQuestion, logicalQuestionRevision: 2 },
  ];
  for (const identity of unavailableIdentities) {
    for (const answerInProgress of [false, true]) {
      assert.deepEqual(resolveSettledAttemptEvaluationTarget({
        suggestion: suggestion(a), answerInProgress, currentQuestion: identity,
        traces: [enhance, b, a], currentSessionId: sessionId,
      }), answerInProgress
        ? { status: "pending", reason: "partial-answer-in-progress" }
        : { status: "unavailable", reason: "no-evaluation-target" });
    }
  }
  assert.deepEqual(resolveSettledAttemptEvaluationTarget({
    suggestion: suggestion(b), currentQuestion, traces: [],
  }), { status: "unavailable", reason: "no-evaluation-target" });
});

test("explicit pinned display retains priority with absent current identity and missing trace", () => {
  const [a, b] = tracesFromRecording();
  const pinnedDisplay = { suggestion: suggestion(a), streaming: false, traceId: a.id };
  assert.deepEqual(resolveSettledAttemptEvaluationTarget({
    suggestion: suggestion(b), traces: [b, a], pinnedDisplay,
  }), { status: "ready", traceId: a.id, reason: "visible-answer-source" });
  assert.deepEqual(resolveSettledAttemptEvaluationTarget({
    suggestion: null, traces: [b], pinnedDisplay,
  }), { status: "unavailable", traceId: a.id, reason: "suggestion-source-trace-missing" });
  assert.deepEqual(resolveSettledAttemptEvaluationTarget({
    suggestion: suggestion(b), traces: [b, a], currentQuestion,
    pinnedDisplay: { ...pinnedDisplay, streaming: true },
  }), { status: "pending", traceId: a.id, reason: "partial-answer-in-progress" });
});

test("initial/Clear sessions stay empty even when old eligible traces remain", () => {
  for (const traces of [[], tracesFromRecording().reverse()]) {
    for (const currentSessionId of [sessionId, "new-session"]) {
      assert.deepEqual(resolveSettledAttemptEvaluationTarget({
        suggestion: null, traces, currentSessionId,
      }), { status: "none", reason: "no-evaluation-target" });
      assert.deepEqual(resolveSettledAttemptEvaluationTarget({
        suggestion: null, traces, currentSessionId, answerInProgress: true,
      }), { status: "pending", reason: "partial-answer-in-progress" });
    }
  }
});

test("provided source without a qualified attempt stays pending/unavailable", () => {
  const [a] = tracesFromRecording();
  for (const answerInProgress of [true, false]) {
    assert.deepEqual(resolveSettledAttemptEvaluationTarget({
      suggestion: null, traces: [a], currentQuestion, answerInProgress,
    }), answerInProgress
      ? { status: "pending", reason: "partial-answer-in-progress" }
      : { status: "unavailable", reason: "no-evaluation-target" });
  }
});

test("explicitly invalid current identity stays unavailable even with progress or eligible old traces", () => {
  for (const identity of [
    { ...currentQuestion, sessionId: "new-session" },
    { ...currentQuestion, sessionId: " " },
    { ...currentQuestion, logicalQuestionRevision: NaN },
    { ...currentQuestion, logicalQuestionRevision: -1 },
    { ...currentQuestion, logicalQuestionRevision: 0.5 },
    { ...currentQuestion, logicalQuestionUnitId: " " },
  ]) {
    for (const answerInProgress of [false, true]) {
      assert.deepEqual(resolveSettledAttemptEvaluationTarget({
        suggestion: null, traces: tracesFromRecording().reverse(), currentSessionId: sessionId,
        currentQuestion: identity, answerInProgress,
      }), { status: "unavailable", reason: "no-evaluation-target" });
    }
  }
});

test("revision reads preserve LQU zero and fallback order without using task runtime revision", () => {
  for (const [metadata, expected] of [
    [{ effectiveCurrentQuestionSettlementRevision: 9, effectiveCurrentQuestionSettlementUnitRevision: 0, currentQuestionSettlementRevision: 1, logicalQuestionUnitRevision: 2 }, 0],
    [{ effectiveCurrentQuestionSettlementRevision: 9, currentQuestionSettlementRevision: 1, logicalQuestionUnitRevision: 2 }, 1],
    [{ effectiveCurrentQuestionSettlementRevision: 9, logicalQuestionUnitRevision: 2 }, 2],
    [{ effectiveCurrentQuestionSettlementRevision: 1 }, undefined],
    [{}, undefined],
    [{ effectiveCurrentQuestionSettlementRevision: "1", logicalQuestionUnitRevision: 1 }, 1],
    [{ effectiveCurrentQuestionSettlementUnitRevision: "1", logicalQuestionUnitRevision: 1 }, undefined],
    [{ currentQuestionSettlementRevision: -1 }, undefined],
    [{ logicalQuestionUnitRevision: Infinity }, undefined],
    [{ logicalQuestionUnitRevision: 0.5 }, undefined],
  ] as const) {
    assert.equal(resolveHumanEvaluationAttemptRevisionV2({ id: "trace", metadata }), expected);
  }
  const [, b] = tracesFromRecording();
  delete b.metadata!.effectiveCurrentQuestionSettlementUnitRevision;
  delete b.metadata!.currentQuestionSettlementRevision;
  delete b.metadata!.logicalQuestionUnitRevision;
  assert.deepEqual(resolveSettledAttemptEvaluationTarget({
    suggestion: suggestion(b), traces: [b], currentQuestion,
  }), { status: "unavailable", reason: "no-evaluation-target" });
});

for (const sourceKind of ["voice", "screen"] as const) {
  test(`${sourceKind} producer formatters keep child LQU revision 1 independent of task runtime revisions`, () => {
    const unit = composeCanonicalTurnCandidate({
      sessionId, runtimeEpoch: 4,
      currentTurn: { id: "child-turn", text: "Implement the queue operation.", speaker: "them",
        source: "system-audio", isFinal: true, startedAt: 100, endedAt: 110 },
    });
    const current = createProvisionalCurrentQuestion({ logicalQuestionUnit: unit, sourceKind });
    assert.equal(current.revision, 1);
    const task: ActiveMeetingTask = {
      id: parentId, runtimeRevision: 2, source: sourceKind,
      parent: { id: parentId, questionType: "general-system-design", topic: "Queue service",
        playbookPhase: "requirement_clarification", phaseProgress: {}, supportedFactAnchors: [],
        createdAt: 1, updatedAt: 2, revisions: 3 },
      child: { id: "child-code", questionType: "coding", relation: "child-probe", intent: "implementation-probe",
        question: "Implement the queue operation.", createdAt: 100, updatedAt: 110,
        basedOnTurnIds: ["child-turn"], basedOnObservationIds: [] },
    };
    const settled = settleCurrentQuestion({
      currentQuestion: current, activeParentId: parentId, activeParentRevision: task.parent.revisions,
      manualCorrectionRevision: 0,
      deterministicProposal: { source: "deterministic-fast-path", sessionId, runtimeEpoch: current.runtimeEpoch,
        logicalQuestionUnitId: current.logicalQuestionUnitId, revision: current.revision, sourceHash: current.sourceHash,
        questionType: "coding", typeEvidenceAuthorized: true, relation: "child-probe", relationEvidenceAuthorized: true,
        action: "answer", actionEvidenceAuthorized: true },
      policy: { runtimeMutationAuthorized: true, questionComplete: true, commitParent: false },
    });
    for (const taskRuntimeRevision of [0, 2, 7]) {
      const view = buildEffectiveAdvisorSettlementView({ settlement: settled,
        activeMeetingTask: { ...task, runtimeRevision: taskRuntimeRevision }, taskRuntimeRevision,
        fallback: { questionType: "coding", relation: "child-probe" } });
      assert.equal(view.effectiveSettlement!.effectiveChildId, "child-code");
      const metadata = {
        ...formatLogicalQuestionUnitForTrace(unit),
        ...formatCurrentQuestionSettlementForTrace(settled),
        ...formatEffectiveAdvisorSettlementViewForTrace(view),
      };
      assert.equal(metadata.effectiveCurrentQuestionSettlementRevision, taskRuntimeRevision);
      assert.equal(metadata.effectiveCurrentQuestionSettlementUnitRevision, 1);
      assert.equal(metadata.currentQuestionSettlementRevision, 1);
      assert.equal(metadata.logicalQuestionUnitRevision, 1);
      const currentIdentity = { sessionId: view.effectiveSettlement!.sessionId,
        logicalQuestionUnitId: view.effectiveSettlement!.logicalQuestionUnitId,
        logicalQuestionRevision: view.effectiveSettlement!.revision };
      for (const status of ["running", "error", "cancelled", "success"] as const) {
        const trace: MeetingTrace = { id: "child-attempt", kind: sourceKind, status, startedAt: 100,
          steps: [], inputs: [], outputs: [], metadata };
        const target = resolveSettledAttemptEvaluationTarget({
          suggestion: null, traces: [trace], currentSessionId: sessionId, currentQuestion: currentIdentity,
        });
        assert.equal(target.traceId, trace.id);
        assert.equal(target.status, status === "running" ? "pending" : "trace-only");
        assert.equal(captureHumanGroundTruthEvaluationTarget({ trace, frozenAt: 120 }).logicalQuestionUnitRevision, 1);
        assert.equal(buildHumanEvaluationSelectionSnapshot({ target, currentQuestion: currentIdentity,
          locked: false, displayTarget: { sessionId }, trace }).attempt!.logicalQuestionRevision, 1);
        assert.deepEqual(resolveSettledAttemptEvaluationTarget({
          suggestion: null, traces: [trace], currentQuestion: { ...currentIdentity, logicalQuestionRevision: taskRuntimeRevision },
        }), { status: "unavailable", reason: "no-evaluation-target" });
      }
    }
  });
}

test("selection snapshots are detached identity-only values stable across text/token/render changes", () => {
  const [a, b] = tracesFromRecording();
  const target = resolveSettledAttemptEvaluationTarget({ suggestion: suggestion(b), traces: [b, a], currentQuestion });
  const input = { target, currentSessionId: sessionId, currentQuestion: { ...currentQuestion },
    locked: false, displayTarget: displaySnapshot(b).target, trace: b };
  const snapshot = buildHumanEvaluationSelectionSnapshot(input);
  const key = JSON.stringify(snapshot);
  b.metadata!.currentQuestionPreview = "PRIVATE TEXT";
  b.metadata!.tokenCount = 100;
  b.endedAt = 999;
  Object.assign(input.target, { text: "PRIVATE TEXT" });
  Object.assign(input.currentQuestion, { text: "PRIVATE TEXT" });
  Object.assign(input.displayTarget, { content: "PRIVATE TEXT" });
  assert.equal(JSON.stringify(buildHumanEvaluationSelectionSnapshot(input)), key);
  assert.equal(key.includes("PRIVATE TEXT"), false);
  assert.deepEqual(snapshot.attempt, {
    attemptId: b.id, sessionId, logicalQuestionUnitId: questionB, logicalQuestionRevision: 1, status: "success",
  });
  input.currentQuestion.logicalQuestionUnitId = questionA;
  input.displayTarget.traceId = a.id;
  input.target.traceId = a.id;
  assert.equal(JSON.stringify(snapshot), key);
  assert.equal(buildHumanEvaluationSelectionSnapshot(input).attempt, undefined);
});

test("semantic snapshot key changes on lock, current, display, attempt status, or selection reason", () => {
  const [a, b] = tracesFromRecording();
  const target = resolveSettledAttemptEvaluationTarget({ suggestion: null, traces: [b, a], currentQuestion });
  const input = { target, currentSessionId: sessionId, currentQuestion, locked: false,
    displayTarget: displaySnapshot(a).target, trace: b };
  const key = JSON.stringify(buildHumanEvaluationSelectionSnapshot(input));
  for (const changed of [
    { ...input, locked: true },
    { ...input, currentQuestion: { ...currentQuestion, logicalQuestionRevision: 2 } },
    { ...input, currentSessionId: "new-session" },
    { ...input, displayTarget: displaySnapshot(b).target },
    { ...input, trace: { ...b, status: "cancelled" as const } },
    { ...input, target: { ...target, reason: "visible-answer-source" as const } },
    { ...input, target: { ...target, status: "pending" as const } },
  ]) {
    assert.notEqual(JSON.stringify(buildHumanEvaluationSelectionSnapshot(changed)), key);
  }
});

test("captured provenance survives question changes and append/retry/JSON round trip without rewriting old truth", () => {
  const [a, b] = tracesFromRecording();
  const expectedA = createHumanGroundTruthEventV2({
    eventId: "expected-a", sessionId, subject: buildHumanGroundTruthSubjectV2({ trace: a }),
    source: "explicit-ui", sourceTraceId: a.id,
    fact: { kind: "expected-question-type", expectedQuestionType: "coding" }, now: 50,
  });
  const original = JSON.stringify(expectedA);
  b.metadata!.logicalQuestionCurrentTurnId = "turn-b";
  const captured = captureHumanGroundTruthEvaluationTarget({ trace: b, frozenAt: 100 });
  assert.equal(captured.logicalQuestionUnitId, questionB);
  assert.equal(captured.sourceTraceId, b.id);
  assert.equal(captured.currentTurnId, "turn-b");
  b.metadata!.logicalQuestionSourceTurnIds = ["later-turn"];
  b.metadata!.effectiveCurrentQuestionSettlementUnitId = "question-c";
  assert.deepEqual(captured.sourceTurnIds, ["turn_1790153516089_oo08n2"]);
  const subject = { attemptId: captured.attemptId, questionId: captured.questionId, taskId: captured.taskId,
    traceIds: [captured.sourceTraceId!], sourceTurnIds: [...captured.sourceTurnIds] };
  assert.deepEqual(validateHumanEvaluationAttemptSubjectV2({ subject, sourceTraceId: b.id }), { valid: true });
  assert.equal(validateHumanEvaluationAttemptSubjectV2({ subject, sourceTraceId: a.id }).valid, false);
  const event = createHumanGroundTruthEventV2({
    eventId: "answer-b", actionId: "label-b", sessionId, subject, source: "explicit-ui", sourceTraceId: b.id,
    evaluationTarget: captured, uiSurface: "normal-debug-evaluation",
    fact: { kind: "answer-quality", outcome: "useful", failureReasons: [], expectedContextTurnIds: [] }, now: 200,
  });
  const events = appendHumanGroundTruthEventV2([expectedA], event);
  assert.equal(appendHumanGroundTruthEventV2(events, { ...event, eventId: "retry" }), events);
  const restored = JSON.parse(JSON.stringify(events)) as typeof events;
  assert.equal(JSON.stringify(restored[0]), original);
  assert.equal(restored[1].provenance.evaluationTarget!.frozenAt, 100);
  assert.equal(restored[1].provenance.evaluationTarget!.logicalQuestionUnitId, questionB);
  assert.equal(restored[1].subject.attemptId, captured.attemptId);
  const projection = deriveHumanEvaluationProjectionV2({ sessionId, subject: expectedA.subject, events: restored, now: 300 });
  assert.deepEqual(projection.activeFacts["expected-question-type"]?.fact, expectedA.fact);
});
