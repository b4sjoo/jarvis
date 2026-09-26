import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  authorizeAnswerGenerationLease,
  type AnswerGenerationLease,
  type AnswerGenerationLeaseSnapshot,
} from "../src/lib/meeting/answer-generation-lease.js";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import type { ActiveInterviewParent } from "../src/lib/meeting/types.js";
import {
  MeetingOrchestrationHarness,
  replayOrchestrationSteps,
  type OrchestrationCommitResult,
} from "./helpers/meeting-orchestration-harness.js";
import { setTestActiveParent } from "./helpers/meeting-task-runtime.js";

interface ReplayBaseline {
  schemaVersion: 2;
  scenario: string;
  expectedPayload: unknown;
  expectedFinalAnswer: string;
  expectedOutcomes: Record<string, OrchestrationCommitResult>;
}

test("replays out-of-order answer completion against fixed canonical state and journal", async () => {
  const baseline = loadBaseline();
  const first = await runOutOfOrderAnswerReplay();
  const second = await runOutOfOrderAnswerReplay();

  assert.equal(first.replay.canonicalPayload, second.replay.canonicalPayload);
  assert.deepEqual(JSON.parse(first.replay.canonicalPayload), baseline.expectedPayload);
  assert.equal(first.finalAnswer, baseline.expectedFinalAnswer);
  assert.deepEqual(first.outcomes, baseline.expectedOutcomes);
});

test("D196: equal final Answers cannot hide changed intermediate state or event order", async () => {
  const actual = await runOutOfOrderAnswerReplay();
  const baseline = loadBaseline();
  assert.equal(actual.finalAnswer, baseline.expectedFinalAnswer);
  for (const change of [
    (payload: any) => payload.journal.reverse(),
    (payload: any) => { payload.journal[0].state.parentRevision += 1; },
    (payload: any) => { payload.journal[0].state.generationOwnerId = "other-owner"; },
    (payload: any) => { payload.journal[4].event = "rejected"; },
    (payload: any) => { payload.journal[4].operationId = "other-operation"; },
  ]) {
    const payload = JSON.parse(actual.replay.canonicalPayload);
    change(payload);
    assert.throws(() => assert.deepEqual(payload, baseline.expectedPayload));
  }
});

test("D196: canonical replay retains session alias and object-key normalization", () => {
  const first = new MeetingOrchestrationHarness();
  const second = new MeetingOrchestrationHarness();
  const original = second.getStateDigest.bind(second);
  second.getStateDigest = () => Object.fromEntries(Object.entries({ ...original(), sessionId: "another-session" }).reverse()) as unknown as ReturnType<typeof original>;
  first.recordCheckpoint("same"); second.recordCheckpoint("same");
  assert.equal(first.getCanonicalReplay().canonicalPayload, second.getCanonicalReplay().canonicalPayload);
});

test("rejects replay steps that move the manual clock backward", async () => {
  const harness = new MeetingOrchestrationHarness();
  harness.scheduler.advanceBy(10);
  await assert.rejects(
    replayOrchestrationSteps(harness, [
      { id: "past", atMs: 9, run: () => undefined },
    ]),
    /invalid time/
  );
});

async function runOutOfOrderAnswerReplay() {
  const manager = new MeetingContextManager();
  setTestActiveParent(manager, makeParent());
  const taskBefore = manager.getTaskRuntimeState();
  const harness = new MeetingOrchestrationHarness(manager);
  let visibleAnswerRevision = 0;
  let visibleAnswer = "initial answer";
  const outcomes: Record<string, OrchestrationCommitResult> = {};
  const oldLease = makeLease("generation-old", manager, harness);
  const newLease = makeLease("generation-new", manager, harness);
  harness.setGenerationOwner(newLease.id, visibleAnswerRevision);

  const oldOperation = harness.startOperation<string>({
    id: oldLease.id,
    kind: "advisor",
    commit: ({ value, contextManager }) =>
      commitAnswer(oldLease, value, contextManager),
  });
  const newOperation = harness.startOperation<string>({
    id: newLease.id,
    kind: "advisor",
    commit: ({ value, contextManager }) =>
      commitAnswer(newLease, value, contextManager),
  });

  function commitAnswer(
    lease: AnswerGenerationLease,
    value: string,
    contextManager: MeetingContextManager
  ): OrchestrationCommitResult {
    const authorization = authorizeAnswerGenerationLease(
      lease,
      currentLeaseSnapshot(contextManager)
    );
    if (!authorization.authorized) {
      return { outcome: "rejected", reason: authorization.reason };
    }
    visibleAnswer = value;
    visibleAnswerRevision += 1;
    harness.setGenerationOwner(lease.id, visibleAnswerRevision);
    return { outcome: "committed", reason: authorization.reason };
  }

  function currentLeaseSnapshot(
    contextManager: MeetingContextManager
  ): AnswerGenerationLeaseSnapshot {
    const state = contextManager.getState();
    return {
      sessionId: state.sessionId,
      runtimeEpoch: harness.getRuntimeEpoch(),
      preparationContextRevision: 0,
      taskId: state.activeMeetingTask?.parent.id ?? null,
      taskRevision: state.activeMeetingTask?.parent.revisions ?? null,
      logicalQuestionUnitId: "question-1",
      logicalQuestionRevision: 1,
      visibleAnswerRevision,
      manualCorrectionRevision: 0,
      responseActionRevision: 0,
      artifactOwnerId: state.activeMeetingTask?.parent.id ?? null,
      authorizedArtifacts: ["answer"],
    };
  }

  const replay = await replayOrchestrationSteps(harness, [
    {
      id: "resolve-newer-generation",
      atMs: 10,
      run: async () => {
        newOperation.resolve("newer answer");
        outcomes[newLease.id] = await newOperation.completion;
      },
    },
    {
      id: "resolve-stale-generation",
      atMs: 20,
      run: async () => {
        oldOperation.resolve("stale answer");
        outcomes[oldLease.id] = await oldOperation.completion;
      },
    },
  ]);
  assert.deepEqual(manager.getTaskRuntimeState(), taskBefore);
  assert.equal(visibleAnswerRevision, 1);
  assert.equal("latestUsefulAnswer" in manager.getTaskRuntimeState().parent!, false);

  return {
    replay,
    outcomes,
    finalAnswer: visibleAnswer,
  };
}

function makeLease(
  id: string,
  manager: MeetingContextManager,
  harness: MeetingOrchestrationHarness
): AnswerGenerationLease {
  const state = manager.getState();
  return {
    id,
    sessionId: state.sessionId,
    runtimeEpoch: harness.getRuntimeEpoch(),
    preparationContextRevision: 0,
    taskId: state.activeMeetingTask?.parent.id ?? null,
    taskRevision: state.activeMeetingTask?.parent.revisions ?? null,
    logicalQuestionUnitId: "question-1",
    logicalQuestionRevision: 1,
    baseVisibleAnswerRevision: 0,
    sourceTurnIds: [id === "generation-new" ? "turn-2" : "turn-1"],
    manualCorrectionRevision: 0,
    responseActionRevision: 0,
    modelRoute: "main",
    artifactOwnerId: state.activeMeetingTask?.parent.id ?? null,
    requestedArtifacts: ["answer"],
    startedAt: id === "generation-new" ? 2 : 1,
  };
}

function makeParent(): ActiveInterviewParent {
  return {
    id: "parent-1",
    source: "voice",
    stableKind: "general-system-design",
    topic: "Design a ticket service",
    playbookPhase: "requirement_clarification",
    phaseProgress: {},
    supportedFactAnchors: [],
    createdAt: 100,
    updatedAt: 110,
    revisions: 1,
  };
}

function loadBaseline(): ReplayBaseline {
  const baseline = JSON.parse(
    fs.readFileSync(
      path.resolve(
        process.cwd(),
        "architecture",
        "orchestration-replay-baseline.json"
      ),
      "utf8"
    )
  ) as ReplayBaseline;
  assert.equal(baseline.schemaVersion, 2);
  return baseline;
}
