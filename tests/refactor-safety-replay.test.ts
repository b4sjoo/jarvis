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
  schemaVersion: 1;
  scenario: string;
  expectedDigest: string;
  expectedFinalAnswer: string;
  expectedOutcomes: Record<string, OrchestrationCommitResult>;
}

test("replays out-of-order answer completion against the canonical digest", async () => {
  const baseline = loadBaseline();
  const first = await runOutOfOrderAnswerReplay();
  const second = await runOutOfOrderAnswerReplay();

  assert.equal(first.digest.hash, second.digest.hash);
  assert.equal(first.digest.canonicalPayload, second.digest.canonicalPayload);
  assert.equal(first.digest.hash, baseline.expectedDigest);
  assert.equal(first.finalAnswer, baseline.expectedFinalAnswer);
  assert.deepEqual(first.outcomes, baseline.expectedOutcomes);
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

  const digest = await replayOrchestrationSteps(harness, [
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
    digest,
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
  return JSON.parse(
    fs.readFileSync(
      path.resolve(
        process.cwd(),
        "architecture",
        "orchestration-replay-baseline.json"
      ),
      "utf8"
    )
  ) as ReplayBaseline;
}
