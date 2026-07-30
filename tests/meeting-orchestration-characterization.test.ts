import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeAdvisorOutputCommit,
  authorizeAdvisorTaskMutation,
  createAdvisorTriggerJob,
  decideAdvisorJobCommit,
  decideAdvisorPhaseMutation,
  decideAdvisorTaskMutation,
} from "../src/lib/meeting/advisor-trigger-job.js";
import {
  createAdjacentQuestionScope,
  resolveAdjacentConstraintInheritance,
} from "../src/lib/meeting/adjacent-question-constraint.js";
import { decideAdvisorTurnIntent } from "../src/lib/meeting/advisor-turn-intent.js";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import {
  decideAdvisorScreenScope,
  decideScreenResultScope,
} from "../src/lib/meeting/screen-task-scope.js";
import {
  authorizeRuntimeCommit,
  createRuntimeCommitToken,
  rebaseRuntimeCommitToken,
  rebaseRuntimeCommitTokenAfterOwnedParentMutation,
  type RuntimeCommitSnapshot,
} from "../src/lib/meeting/runtime-commit-authorization.js";
import { createAuthorizedQuestionLineage } from "../src/lib/meeting/question-lineage.js";
import type {
  ActiveInterviewParent,
  ActiveScreenTask,
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
    runtimeEpoch: harness.getRuntimeEpoch(),
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
    runtimeEpoch: harness.getRuntimeEpoch(),
    snapshotTurnCount: 0,
    taskMutationAuthority: "input-evidence",
  });
  harness.activateAdvisorJob(jobB.id);
  const operationB = createAdvisorCompletion(harness, jobB, "advisor-b");

  operationB.resolve("newer answer");
  assert.deepEqual(await operationB.completion, {
    outcome: "committed",
    reason: "authorized",
  });
  operationA.resolve("stale answer");
  assert.deepEqual(await operationA.completion, {
    outcome: "rejected",
    reason: "parent-revision-mismatch",
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
    runtimeEpoch: harness.getRuntimeEpoch(),
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
    runtimeEpoch: harness.getRuntimeEpoch(),
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
            currentRuntime: currentRuntimeSnapshot(currentHarness),
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

test("preserves provisional question lineage when an adjacent constraint replaces its job", () => {
  const manager = new MeetingContextManager();
  const harness = new MeetingOrchestrationHarness(manager);
  const questionTurn = makeTurn(
    "turn-sort",
    "Show me the sort method.",
    1_000
  );
  manager.addTranscriptTurn(questionTurn);
  const questionDecision = decideAdvisorTurnIntent(questionTurn.text, {
    hasActiveTask: false,
  });
  const lineage = createAuthorizedQuestionLineage({
    traceId: "trace-sort",
    triggerTurnId: questionTurn.id,
    sessionId: manager.getState().sessionId,
    runtimeEpoch: harness.getRuntimeEpoch(),
    action: questionDecision.action,
    executionAuthorized: questionDecision.executionAuthorized,
  });
  assert.ok(lineage);
  const scope = createAdjacentQuestionScope({
    lineage,
    questionTurnId: questionTurn.id,
    questionTraceId: "trace-sort",
    questionText: questionTurn.text,
    sessionId: manager.getState().sessionId,
    runtimeEpoch: harness.getRuntimeEpoch(),
    now: 2_000,
  });
  const firstJob = createAdvisorTriggerJob({
    source: "live-turn",
    mode: "live",
    traceId: "trace-sort",
    triggerTurnId: questionTurn.id,
    promptContext: manager.buildAdvisorPromptContext(),
    sessionId: manager.getState().sessionId,
    runtimeEpoch: harness.getRuntimeEpoch(),
    snapshotTurnCount: 1,
    questionLineage: lineage,
    turnIntentDecision: questionDecision,
    taskMutationAuthority: "input-evidence",
  });
  harness.activateAdvisorJob(firstJob.id);

  const constraintTurn = makeTurn("turn-language", "In Python.", 3_000);
  const inheritance = resolveAdjacentConstraintInheritance({
    scope,
    text: constraintTurn.text,
    sessionId: manager.getState().sessionId,
    runtimeEpoch: harness.getRuntimeEpoch(),
    now: 4_000,
  });
  assert.equal(inheritance.inherited, true);
  const constraintDecision = decideAdvisorTurnIntent(constraintTurn.text, {
    hasActiveTask: false,
    hasRecentQuestionContext: inheritance.inherited,
  });
  manager.addTranscriptTurn(constraintTurn);
  const secondJob = createAdvisorTriggerJob({
    source: "live-turn",
    mode: "live",
    traceId: "trace-language",
    triggerTurnId: constraintTurn.id,
    promptContext: manager.buildAdvisorPromptContext(),
    sessionId: manager.getState().sessionId,
    runtimeEpoch: harness.getRuntimeEpoch(),
    snapshotTurnCount: 2,
    questionLineage: inheritance.lineage,
    turnIntentDecision: constraintDecision,
    taskMutationAuthority: "input-evidence",
  });
  harness.activateAdvisorJob(secondJob.id);

  assert.equal(
    decideAdvisorJobCommit({
      job: firstJob,
      activeJobId: harness.getActiveAdvisorJobId(),
      currentRuntime: currentRuntimeSnapshot(harness),
    }).authorized,
    false
  );
  assert.equal(
    secondJob.questionLineage?.questionInstanceId,
    firstJob.questionLineage?.questionInstanceId
  );
  assert.equal(secondJob.promptContextSnapshot.transcript.includes("In Python."), true);
  assert.deepEqual(
    authorizeAdvisorTaskMutation({
      authority: secondJob.taskMutationAuthority,
      turnIntentDecision: constraintDecision,
    }),
    {
      authorized: true,
      reason: "substantive-input-authority",
    }
  );
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
          requiredArtifacts: ["answer", "whiteboard"],
          action: "stay",
          reason: "automatic-stay",
        },
        manualDecision: {
          phase: "design_framing",
          flags: ["architecture"],
          requiredArtifacts: ["answer", "whiteboard"],
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

test("manual next rebases authorization before deferred memory completion", async () => {
  const manager = new MeetingContextManager();
  manager.setActiveInterviewTask(
    makeParent({ playbookPhase: "requirement_clarification" })
  );
  const harness = new MeetingOrchestrationHarness(manager);
  const initialToken = createHarnessToken(
    harness,
    "manual-next-with-memory",
    "advisor"
  );
  harness.activateOperation("advisor", initialToken.operationId);

  const current = manager.getState().activeInterviewTask;
  assert.ok(current);
  manager.setActiveInterviewTask({
    ...current,
    playbookPhase: "design_framing",
    revisions: current.revisions + 1,
  });
  const rebasedToken = rebaseRuntimeCommitToken({
    token: initialToken,
    snapshot: currentRuntimeSnapshot(harness),
  });

  const memoryOperation = harness.startOperation<string>({
    id: initialToken.operationId,
    kind: "memory",
    commit: ({ value, contextManager, harness: currentHarness }) => {
      const decision = authorizeRuntimeCommit({
        token: rebasedToken,
        current: currentRuntimeSnapshot(currentHarness),
        currentOperationId: currentHarness.getActiveOperationId("advisor"),
      });
      if (!decision.authorized) return rejected(decision.reason);
      const parent = contextManager.getState().activeInterviewTask;
      assert.ok(parent);
      contextManager.setActiveInterviewTask({
        ...parent,
        latestUsefulAnswer: value,
      });
      return committed(decision.reason);
    },
  });

  memoryOperation.resolve("Use a write-heavy location pipeline.");
  assert.deepEqual(await memoryOperation.completion, {
    outcome: "committed",
    reason: "authorized",
  });
  assert.equal(
    manager.getState().activeInterviewTask?.latestUsefulAnswer,
    "Use a write-heavy location pipeline."
  );
});

test("clears the old screen when a voice completion commits a new parent", async () => {
  const manager = new MeetingContextManager();
  manager.setActiveMeetingTaskState({
    activeScreenTask: makeScreenTask(),
    activeInterviewTask: makeParent({ source: "screen" }),
  });
  const harness = new MeetingOrchestrationHarness(manager);
  const operation = harness.startOperation<string>({
    id: "voice-new-parent",
    kind: "advisor",
    commit: ({ value, contextManager }) => {
      const state = contextManager.getState();
      const decision = decideAdvisorScreenScope({
        triggerSource: "live-turn",
        relation: "new-parent",
        hasActiveScreenTask: Boolean(state.activeScreenTask),
      });
      contextManager.setActiveMeetingTaskState({
        activeScreenTask:
          decision.action === "clear" ? null : state.activeScreenTask,
        activeInterviewTask: makeParent({
          id: "parent-voice-b",
          source: "voice",
          stableKind: "behavioral",
          topic: "Tell me about a conflict",
          latestUsefulAnswer: value,
        }),
      });
      return committed(decision.reason);
    },
  });

  operation.resolve("Use a concise STAR story.");
  await operation.completion;
  const state = manager.getState();

  assert.equal(state.activeScreenTask, undefined);
  assert.equal(state.activeMeetingTask?.parent.id, "parent-voice-b");
  assert.equal(state.activeMeetingTask?.source, "voice");
  assert.equal(state.activeMeetingTask?.screen, undefined);
});

test("shadow low-value execution preserves output, parent, phase, answer, and whiteboard", async () => {
  const manager = new MeetingContextManager();
  const whiteboard = {
    id: "whiteboard-1",
    parentTaskId: "parent-1",
    domainTrack: "general_sd" as const,
    archetypeIds: [],
    selectedOverlayIds: [],
    currentPhase: "requirement_clarification" as const,
    title: "Ticket service",
    content: "Client -> API -> inventory service",
    summary: "Inventory reservation path",
    revision: 1,
    updateSource: "model-output" as const,
    updatedAt: 110,
    createdAt: 100,
  };
  manager.setActiveMeetingTaskState({
    activeScreenTask: makeScreenTask(),
    activeInterviewTask: makeParent({ whiteboardArtifact: whiteboard }),
  });
  const harness = new MeetingOrchestrationHarness(manager);
  const before = harness.getStateDigest();
  const intent = decideAdvisorTurnIntent("Kubernetes.", {
    hasActiveTask: true,
  });
  const authorization = authorizeAdvisorTaskMutation({
    authority: "input-evidence",
    turnIntentDecision: intent,
  });
  const outputAuthorization = authorizeAdvisorOutputCommit({
    authority: "input-evidence",
    executionAuthorized: intent.executionAuthorized,
    turnIntentDecision: intent,
  });
  let visibleOutput = "";
  const operation = harness.startOperation<string>({
    id: "shadow-low-value",
    kind: "advisor",
    commit: ({ value, contextManager }) => {
      const state = contextManager.getState();
      const taskMutation = decideAdvisorTaskMutation({
        authority: "input-evidence",
        resolvedRelation: "new-parent",
        hasActiveParent: true,
        hasActiveChild: false,
        mutationAuthorized: authorization.authorized,
      });
      const screenScope = decideAdvisorScreenScope({
        triggerSource: "live-turn",
        relation: taskMutation.relation,
        hasActiveScreenTask: Boolean(state.activeScreenTask),
        taskMutationAuthorized: authorization.authorized,
      });
      if (taskMutation.commitParent) {
        contextManager.setActiveMeetingTaskState({
          activeScreenTask:
            screenScope.action === "clear" ? null : state.activeScreenTask,
          activeInterviewTask: makeParent({
            id: "incorrect-replacement",
            latestUsefulAnswer: "incorrect shadow answer",
          }),
        });
      }
      if (outputAuthorization.authorized) {
        visibleOutput = value;
      }
      return committed(taskMutation.reason);
    },
  });

  operation.resolve("shadow model output");
  await operation.completion;
  const after = harness.getStateDigest();
  const state = manager.getState();

  assert.equal(authorization.authorized, false);
  assert.equal(outputAuthorization.authorized, false);
  assert.equal(visibleOutput, "");
  assert.deepEqual(after, before);
  assert.equal(
    state.activeInterviewTask?.latestUsefulAnswer,
    "Clarify scale and consistency."
  );
  assert.deepEqual(state.activeInterviewTask?.whiteboardArtifact, whiteboard);
  assert.equal(state.activeScreenTask?.id, "screen-task-a");
});

test("a late unknown screen result cannot replace a newer voice parent", async () => {
  const manager = new MeetingContextManager();
  manager.setActiveMeetingTaskState({
    activeScreenTask: makeScreenTask(),
    activeInterviewTask: makeParent({ source: "screen" }),
  });
  const harness = new MeetingOrchestrationHarness(manager);
  const screenOperation = harness.startOperation<string>({
    id: "screen-unknown-late",
    kind: "screen",
    commit: ({ contextManager }) => {
      const decision = decideScreenResultScope({
        questionType: "unknown",
        hasAnswer: true,
      });
      if (decision.mutationAuthorized) {
        contextManager.setActiveScreenTask({
          ...makeScreenTask(),
          id: "screen-unknown",
          kind: "unknown",
        });
      }
      return committed(decision.reason);
    },
  });
  const voiceOperation = harness.startOperation<string>({
    id: "voice-new-parent-first",
    kind: "advisor",
    commit: ({ value, contextManager }) => {
      const decision = decideAdvisorScreenScope({
        triggerSource: "live-turn",
        relation: "new-parent",
        hasActiveScreenTask: Boolean(
          contextManager.getState().activeScreenTask
        ),
      });
      contextManager.setActiveMeetingTaskState({
        activeScreenTask: decision.action === "clear" ? null : undefined,
        activeInterviewTask: makeParent({
          id: "parent-voice-new",
          source: "voice",
          stableKind: "ai-ml-system-design",
          topic: "Design a RAG service",
          latestUsefulAnswer: value,
        }),
      });
      return committed(decision.reason);
    },
  });

  voiceOperation.resolve("Clarify corpus size and latency.");
  await voiceOperation.completion;
  screenOperation.resolve("Unclassified screen answer");
  await screenOperation.completion;

  const state = manager.getState();
  assert.equal(state.activeMeetingTask?.parent.id, "parent-voice-new");
  assert.equal(state.activeMeetingTask?.source, "voice");
  assert.equal(state.activeScreenTask, undefined);
  assert.deepEqual(
    harness.getOperationEvents("screen-unknown-late").map((entry) => entry.event),
    ["started", "resolved", "committed"]
  );
});

test("rejects a screen completion from an older runtime epoch", async () => {
  const manager = new MeetingContextManager();
  manager.setActiveInterviewTask(makeParent());
  const harness = new MeetingOrchestrationHarness(manager);
  const token = createHarnessToken(harness, "screen-reset", "screen");
  harness.activateOperation("screen", token.operationId);
  const operation = harness.startOperation<string>({
    id: token.operationId,
    kind: "screen",
    commit: ({ value, contextManager, harness: currentHarness }) => {
      const decision = authorizeRuntimeCommit({
        token,
        current: currentRuntimeSnapshot(currentHarness),
        currentOperationId: currentHarness.getActiveOperationId("screen"),
      });
      if (!decision.authorized) return rejected(decision.reason);
      contextManager.setActiveInterviewTask(
        makeParent({ latestUsefulAnswer: value })
      );
      return committed(decision.reason);
    },
  });

  harness.advanceRuntimeEpoch();
  manager.reset();
  operation.resolve("late screen answer");

  assert.deepEqual(await operation.completion, {
    outcome: "rejected",
    reason: "runtime-epoch-mismatch",
  });
  assert.equal(manager.getState().activeMeetingTask, undefined);
});

test("rejects an advisor completion after parent retype changes revision", async () => {
  const manager = new MeetingContextManager();
  manager.setActiveInterviewTask(makeParent());
  const harness = new MeetingOrchestrationHarness(manager);
  const token = createHarnessToken(harness, "advisor-before-retype", "advisor");
  harness.activateOperation("advisor", token.operationId);
  const operation = harness.startOperation<string>({
    id: token.operationId,
    kind: "advisor",
    commit: ({ value, contextManager, harness: currentHarness }) => {
      const decision = authorizeRuntimeCommit({
        token,
        current: currentRuntimeSnapshot(currentHarness),
        currentOperationId: currentHarness.getActiveOperationId("advisor"),
      });
      if (!decision.authorized) return rejected(decision.reason);
      contextManager.setActiveInterviewTask(
        makeParent({ latestUsefulAnswer: value })
      );
      return committed(decision.reason);
    },
  });

  const current = manager.getState().activeInterviewTask;
  assert.ok(current);
  manager.setActiveInterviewTask({
    ...current,
    stableKind: "behavioral",
    revisions: current.revisions + 1,
  });
  operation.resolve("stale design answer");

  assert.deepEqual(await operation.completion, {
    outcome: "rejected",
    reason: "parent-revision-mismatch",
  });
  assert.equal(manager.getState().activeInterviewTask?.stableKind, "behavioral");
});

test("rejects memory after reset but allows transcript-only runtime changes", async () => {
  const manager = new MeetingContextManager();
  manager.setActiveInterviewTask(makeParent());
  const harness = new MeetingOrchestrationHarness(manager);
  const acceptedToken = createHarnessToken(
    harness,
    "memory-transcript-only",
    "memory"
  );
  harness.activateOperation("memory", acceptedToken.operationId);
  const acceptedOperation = harness.startOperation<string>({
    id: acceptedToken.operationId,
    kind: "memory",
    commit: ({ harness: currentHarness }) => {
      const decision = authorizeRuntimeCommit({
        token: acceptedToken,
        current: currentRuntimeSnapshot(currentHarness),
        currentOperationId: currentHarness.getActiveOperationId("memory"),
      });
      return decision.authorized
        ? committed(decision.reason)
        : rejected(decision.reason);
    },
  });
  manager.addTranscriptTurn(makeTurn("turn-later", "One more detail", 200));
  acceptedOperation.resolve("memory result");
  assert.equal((await acceptedOperation.completion).outcome, "committed");

  const staleToken = createHarnessToken(harness, "memory-reset", "memory");
  harness.activateOperation("memory", staleToken.operationId);
  const staleOperation = harness.startOperation<string>({
    id: staleToken.operationId,
    kind: "memory",
    commit: ({ harness: currentHarness }) => {
      const decision = authorizeRuntimeCommit({
        token: staleToken,
        current: currentRuntimeSnapshot(currentHarness),
        currentOperationId: currentHarness.getActiveOperationId("memory"),
      });
      return decision.authorized
        ? committed(decision.reason)
        : rejected(decision.reason);
    },
  });
  harness.advanceRuntimeEpoch();
  manager.reset();
  staleOperation.resolve("stale memory result");
  assert.equal((await staleOperation.completion).reason, "runtime-epoch-mismatch");
});

test("an exact correction token follows its one owned regeneration mutation", () => {
  const manager = new MeetingContextManager();
  manager.setActiveInterviewTask(makeParent());
  const harness = new MeetingOrchestrationHarness(manager);
  const current = manager.getState().activeInterviewTask;
  assert.ok(current);
  manager.setActiveInterviewTask({
    ...current,
    stableKind: "project-deep-dive",
    revisions: current.revisions + 1,
  });
  const token = createHarnessToken(
    harness,
    "correction-owned-regeneration",
    "correction"
  );
  harness.activateOperation("correction", token.operationId);

  const corrected = manager.getState().activeInterviewTask;
  assert.ok(corrected);
  manager.setActiveInterviewTask({
    ...corrected,
    latestUsefulAnswer: "corrected answer",
    revisions: corrected.revisions + 1,
  });
  const completionToken = rebaseRuntimeCommitTokenAfterOwnedParentMutation({
    token,
    snapshot: currentRuntimeSnapshot(harness),
    expectedRevisionDelta: 1,
  });
  assert.ok(completionToken);
  assert.equal(
    authorizeRuntimeCommit({
      token: completionToken,
      current: currentRuntimeSnapshot(harness),
      currentOperationId: harness.getActiveOperationId("correction"),
    }).reason,
    "authorized"
  );
});

test("rejects correction completion after its corrected parent is replaced", () => {
  const manager = new MeetingContextManager();
  manager.setActiveInterviewTask(makeParent());
  const harness = new MeetingOrchestrationHarness(manager);
  const token = createHarnessToken(
    harness,
    "correction-replaced-parent",
    "correction"
  );
  harness.activateOperation("correction", token.operationId);
  manager.setActiveInterviewTask(makeParent({ id: "replacement-parent" }));

  assert.equal(
    rebaseRuntimeCommitTokenAfterOwnedParentMutation({
      token,
      snapshot: currentRuntimeSnapshot(harness),
      expectedRevisionDelta: 1,
    }),
    undefined
  );
  assert.equal(
    authorizeRuntimeCommit({
      token,
      current: currentRuntimeSnapshot(harness),
      currentOperationId: harness.getActiveOperationId("correction"),
    }).reason,
    "parent-id-mismatch"
  );
});

test("rejects an old correction after a newer correction takes ownership", async () => {
  const manager = new MeetingContextManager();
  manager.setActiveInterviewTask(makeParent());
  const harness = new MeetingOrchestrationHarness(manager);
  const token = createHarnessToken(
    harness,
    "correction-old",
    "correction"
  );
  harness.activateOperation("correction", token.operationId);
  const operation = harness.startOperation<string>({
    id: token.operationId,
    kind: "correction",
    commit: ({ harness: currentHarness }) => {
      const decision = authorizeRuntimeCommit({
        token,
        current: currentRuntimeSnapshot(currentHarness),
        currentOperationId: currentHarness.getActiveOperationId("correction"),
      });
      return decision.authorized
        ? committed(decision.reason)
        : rejected(decision.reason);
    },
  });

  harness.activateOperation("correction", "correction-new");
  operation.resolve("old correction completed");
  assert.equal((await operation.completion).reason, "pipeline-owner-mismatch");
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
        currentRuntime: currentRuntimeSnapshot(currentHarness),
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

function createHarnessToken(
  harness: MeetingOrchestrationHarness,
  operationId: string,
  pipeline: "advisor" | "screen" | "memory" | "correction",
  parentPolicy: "task-bound" | "session-only" = "task-bound"
) {
  return createRuntimeCommitToken({
    operationId,
    pipeline,
    snapshot: currentRuntimeSnapshot(harness),
    parentPolicy,
  });
}

function currentRuntimeSnapshot(
  harness: MeetingOrchestrationHarness
): RuntimeCommitSnapshot {
  const state = harness.getStateDigest();
  return {
    runtimeEpoch: state.runtimeEpoch,
    sessionId: state.sessionId,
    parentId: state.parentId,
    parentRevision: state.parentRevision,
  };
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

function makeScreenTask(): ActiveScreenTask {
  return {
    id: "screen-task-a",
    observationId: "screen-a",
    createdAt: 100,
    updatedAt: 110,
    question: "Design a ticket service",
    kind: "general-system-design",
    content: "Clarify scale and consistency.",
    basedOnTurnIds: [],
    basedOnObservationId: "screen-a",
  };
}

function committed(reason: string): OrchestrationCommitResult {
  return { outcome: "committed", reason };
}

function rejected(reason: string): OrchestrationCommitResult {
  return { outcome: "rejected", reason };
}
