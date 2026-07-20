import assert from "node:assert/strict";
import test from "node:test";
import {
  createAdvisorTriggerJob,
  decideAdvisorJobCommit,
  decideAdvisorPhaseMutation,
  decideAdvisorTaskMutation,
} from "../src/lib/meeting/advisor-trigger-job.js";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import type {
  ActiveInterviewParent,
  AdvisorPromptContext,
  TranscriptTurn,
} from "../src/lib/meeting/types.js";
import {
  MeetingOrchestrationHarness,
  type ControlledOrchestrationOperation,
  type OrchestrationCommitResult,
} from "./helpers/meeting-orchestration-harness.js";

test("resolves advisor jobs out of order without letting the replaced job mutate state", async () => {
  const manager = new MeetingContextManager();
  manager.setActiveInterviewTask(makeParent());
  const harness = new MeetingOrchestrationHarness(manager);
  const sessionId = manager.getState().sessionId;
  const jobA = createAdvisorTriggerJob({
    source: "live-turn",
    mode: "live",
    promptContext: manager.buildAdvisorPromptContext(),
    sessionId,
    snapshotTurnCount: 0,
    taskMutationAuthority: "input-evidence",
  });
  harness.activateAdvisorJob(jobA.id);
  const operationA = createAdvisorCompletion(harness, jobA, "advisor-a");

  const jobB = createAdvisorTriggerJob({
    source: "live-turn",
    mode: "live",
    promptContext: manager.buildAdvisorPromptContext(),
    sessionId,
    snapshotTurnCount: 0,
    taskMutationAuthority: "input-evidence",
  });
  harness.activateAdvisorJob(jobB.id);
  const operationB = createAdvisorCompletion(harness, jobB, "advisor-b");

  operationB.resolve("newer answer");
  assert.deepEqual(await operationB.completion, {
    outcome: "committed",
    reason: "active-job-and-session-match",
  });
  operationA.resolve("stale answer");
  assert.deepEqual(await operationA.completion, {
    outcome: "rejected",
    reason: "active-job-mismatch",
  });

  const parent = manager.getState().activeInterviewTask;
  assert.equal(parent?.latestUsefulAnswer, "newer answer");
  assert.equal(parent?.revisions, 2);
  assert.deepEqual(
    harness.getOperationEvents("advisor-a").map((entry) => entry.event),
    ["started", "resolved", "rejected"]
  );
  assert.deepEqual(
    harness.getOperationEvents("advisor-b").map((entry) => entry.event),
    ["started", "resolved", "committed"]
  );
});

test("rejects an advisor completion from the previous meeting session", async () => {
  const manager = new MeetingContextManager();
  manager.setActiveInterviewTask(makeParent());
  const harness = new MeetingOrchestrationHarness(manager);
  const job = createAdvisorTriggerJob({
    source: "live-turn",
    mode: "live",
    promptContext: manager.buildAdvisorPromptContext(),
    sessionId: manager.getState().sessionId,
    snapshotTurnCount: 0,
    taskMutationAuthority: "input-evidence",
  });
  harness.activateAdvisorJob(job.id);
  const operation = createAdvisorCompletion(harness, job, "advisor-old-session");

  manager.reset();
  operation.resolve("late answer");

  assert.deepEqual(await operation.completion, {
    outcome: "rejected",
    reason: "session-mismatch",
  });
  assert.equal(manager.getState().activeMeetingTask, undefined);
  assert.notEqual(manager.getState().sessionId, operation.startedFrom.sessionId);
});

test("keeps a trigger-owned question stable when a later informational turn arrives", async () => {
  const manager = new MeetingContextManager();
  const triggerTurn = makeTurn("turn-a", "Design a distributed cache", 10);
  manager.addTranscriptTurn(triggerTurn);
  const harness = new MeetingOrchestrationHarness(manager);
  const job = createAdvisorTriggerJob({
    source: "live-turn",
    mode: "live",
    triggerTurnId: triggerTurn.id,
    promptContext: manager.buildAdvisorPromptContext(),
    sessionId: manager.getState().sessionId,
    snapshotTurnCount: 1,
    taskMutationAuthority: "input-evidence",
  });
  harness.activateAdvisorJob(job.id);
  const operations: ControlledOrchestrationOperation<string>[] = [];
  harness.scheduler.schedule(750, () => {
    operations.push(
      harness.startOperation<string>({
        id: "advisor-trigger-owned",
        kind: "advisor",
        commit: ({ value, contextManager, harness: currentHarness }) => {
          const decision = decideAdvisorJobCommit({
            job,
            activeJobId: currentHarness.getActiveAdvisorJobId(),
            currentSessionId: contextManager.getState().sessionId,
          });
          if (!decision.authorized) {
            return rejected(decision.reason);
          }
          contextManager.setActiveInterviewTask(
            makeParent({
              topic: job.promptContextSnapshot.latestTurn?.text ?? "missing",
              latestUsefulAnswer: value,
            })
          );
          currentHarness.releaseAdvisorJob(job.id);
          return committed(decision.reason);
        },
      })
    );
  });

  manager.addTranscriptTurn(
    makeTurn("turn-b", "I can provide more details later", 30)
  );
  harness.scheduler.advanceBy(749);
  assert.equal(operations.length, 0);
  harness.scheduler.advanceBy(1);
  assert.equal(operations.length, 1);
  const operation = operations[0];
  assert.ok(operation);
  operation.resolve("Use sharding and replication.");
  await operation.completion;

  assert.equal(job.promptContextSnapshot.latestTurn?.id, "turn-a");
  assert.equal(
    manager.getState().activeInterviewTask?.topic,
    "Design a distributed cache"
  );
  assert.equal(manager.getState().transcriptTurns.length, 2);
});

test("manual next advances phase without replacing the active parent", async () => {
  const manager = new MeetingContextManager();
  manager.setActiveInterviewTask(
    makeParent({ playbookPhase: "requirement_clarification" })
  );
  const harness = new MeetingOrchestrationHarness(manager);
  const before = harness.getStateDigest();
  const operation = harness.startOperation<void>({
    id: "manual-next",
    kind: "advisor",
    commit: ({ contextManager }) => {
      const current = contextManager.getState().activeInterviewTask;
      assert.ok(current);
      const taskMutation = decideAdvisorTaskMutation({
        authority: "preserve-parent",
        resolvedRelation: "followup-parent",
        hasActiveParent: true,
        hasActiveChild: false,
      });
      const phaseDecision = decideAdvisorPhaseMutation({
        authority: "preserve-parent",
        manualPhaseAdvance: true,
        currentPhase: current.playbookPhase,
        hasActiveChild: false,
        automaticDecision: {
          phase: "requirement_clarification",
          flags: [],
          action: "stay",
          reason: "automatic-stay",
        },
        manualDecision: {
          phase: "design_framing",
          flags: ["architecture"],
          action: "advance",
          reason: "manual-next",
          source: "manual-next",
        },
      });
      contextManager.setActiveInterviewTask({
        ...current,
        playbookPhase: phaseDecision.phase,
        revisions: current.revisions + 1,
      });
      return committed(taskMutation.reason);
    },
  });

  operation.resolve(undefined);
  await operation.completion;
  const after = harness.getStateDigest();

  assert.equal(after.parentId, before.parentId);
  assert.equal(after.parentQuestionType, before.parentQuestionType);
  assert.equal(after.playbookPhase, "design_framing");
  assert.equal(after.parentRevision, (before.parentRevision ?? 0) + 1);
});

function createAdvisorCompletion(
  harness: MeetingOrchestrationHarness,
  job: ReturnType<typeof createAdvisorTriggerJob>,
  id: string
) {
  return harness.startOperation<string>({
    id,
    kind: "advisor",
    commit: ({ value, contextManager, harness: currentHarness }) => {
      const decision = decideAdvisorJobCommit({
        job,
        activeJobId: currentHarness.getActiveAdvisorJobId(),
        currentSessionId: contextManager.getState().sessionId,
      });
      if (!decision.authorized) {
        return rejected(decision.reason);
      }

      const current = contextManager.getState().activeInterviewTask;
      assert.ok(current);
      contextManager.setActiveInterviewTask({
        ...current,
        latestUsefulAnswer: value,
        updatedAt: current.updatedAt + 1,
        revisions: current.revisions + 1,
      });
      currentHarness.releaseAdvisorJob(job.id);
      return committed(decision.reason);
    },
  });
}

function makeParent(
  overrides: Partial<ActiveInterviewParent> = {}
): ActiveInterviewParent {
  return {
    id: "parent-1",
    source: "voice",
    stableKind: "general-system-design",
    topic: "Design a ticket service",
    playbookPhase: "requirement_clarification",
    phaseProgress: {},
    supportedFactAnchors: [],
    latestUsefulAnswer: "Clarify scale and consistency.",
    createdAt: 100,
    updatedAt: 110,
    revisions: 1,
    ...overrides,
  };
}

function makeTurn(id: string, text: string, startedAt: number): TranscriptTurn {
  return {
    id,
    speaker: "them",
    source: "system-audio",
    text,
    startedAt,
    endedAt: startedAt + 10,
    isFinal: true,
  };
}

function committed(reason: string): OrchestrationCommitResult {
  return { outcome: "committed", reason };
}

function rejected(reason: string): OrchestrationCommitResult {
  return { outcome: "rejected", reason };
}
