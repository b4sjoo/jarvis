import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { authorizeAnswerGenerationLease } from "../src/lib/meeting/answer-generation-lease.js";
import type { MeetingTaskRuntimeTransitionKind } from "../src/lib/meeting/active-meeting-task.js";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import {
  GenerationDerivedCommitCoordinator,
  GenerationResultLedger,
} from "../src/lib/meeting/generation-result-ledger.js";
import {
  commitSourceOwnedTransition,
  createSourceOwnedTransitionCandidate,
  sourceOwnedTransitionSurvivesModelOutcome,
} from "../src/lib/meeting/source-owned-transition-transaction.js";
import type {
  ActiveInterviewParent,
} from "../src/lib/meeting/types.js";
import { setTestTaskRuntime } from "./helpers/meeting-task-runtime.js";

const now = Date.now();

test("characterizes a stale no-parent Screen preparation that the canonical writer rejects", () => {
  const manager = new MeetingContextManager();
  const liveParent = makeParent("parent-live", "behavioral");
  setTestTaskRuntime(manager, { parent: liveParent });
  const sessionId = manager.getState().sessionId;
  const candidate = createSourceOwnedTransitionCandidate({
    sessionId,
    runtimeEpoch: 3,
    source: "screen",
    sourceObservationIds: ["screen-stale-no-parent"],
    relation: "new-parent",
    authoritySource: "screen-preflight",
    mutationAuthorized: true,
    questionType: "coding",
    question: "Implement an LRU cache.",
    now: now + 1,
  });
  assert.ok(candidate);
  const sourceResult = commitSourceOwnedTransition({
    candidate,
    currentSessionId: sessionId,
    currentRuntimeEpoch: 3,
    now: now + 2,
  });
  const durableResult = commitLikeCurrentHook({
    manager,
    transition: "create-parent",
    parent: sourceResult.task,
  });

  assert.equal(sourceResult.candidate.state, "committed");
  assert.equal(sourceResult.mutationApplied, true);
  assert.equal(durableResult.authorized, false);
  assert.equal(durableResult.reason, "invalid-transition");
  assert.equal(manager.getTaskRuntimeState().parent?.id, liveParent.id);
});

test("characterizes stale Parent A replacing the newer live Parent B", () => {
  const manager = new MeetingContextManager();
  const staleParent = makeParent("parent-a", "behavioral");
  const liveParent = makeParent("parent-b", "project-deep-dive");
  setTestTaskRuntime(manager, { parent: liveParent });
  const sessionId = manager.getState().sessionId;
  const candidate = createSourceOwnedTransitionCandidate({
    sessionId,
    runtimeEpoch: 3,
    source: "screen",
    sourceObservationIds: ["screen-stale-parent"],
    existingTask: staleParent,
    relation: "new-parent",
    authoritySource: "screen-preflight",
    mutationAuthorized: true,
    questionType: "coding",
    question: "Implement an LRU cache.",
    now: now + 1,
  });
  assert.ok(candidate);
  const sourceResult = commitSourceOwnedTransition({
    candidate,
    currentTask: staleParent,
    currentSessionId: sessionId,
    currentRuntimeEpoch: 3,
    now: now + 2,
  });
  const durableResult = commitLikeCurrentHook({
    manager,
    transition: "replace-parent",
    parent: sourceResult.task,
  });

  assert.equal(candidate.expectedParentId, staleParent.id);
  assert.equal(sourceResult.candidate.state, "committed");
  assert.equal(durableResult.authorized, true);
  assert.equal(durableResult.mutationApplied, true);
  assert.notEqual(manager.getTaskRuntimeState().parent?.id, liveParent.id);
  assert.equal(manager.getTaskRuntimeState().parent?.stableKind, "coding");
});

test("characterizes an idempotent Screen observation as a durable preserve", () => {
  const manager = new MeetingContextManager();
  const sessionId = manager.getState().sessionId;
  const firstCandidate = createSourceOwnedTransitionCandidate({
    sessionId,
    runtimeEpoch: 3,
    source: "screen",
    sourceObservationIds: ["screen-idempotent"],
    relation: "new-parent",
    authoritySource: "screen-preflight",
    mutationAuthorized: true,
    questionType: "general-system-design",
    question: "Design a URL shortener.",
    now: now + 1,
  });
  assert.ok(firstCandidate);
  const firstSource = commitSourceOwnedTransition({
    candidate: firstCandidate,
    currentSessionId: sessionId,
    currentRuntimeEpoch: 3,
    now: now + 2,
  });
  const firstDurable = commitLikeCurrentHook({
    manager,
    transition: "create-parent",
    parent: firstSource.task,
  });
  assert.equal(firstDurable.mutationApplied, true);
  const revisionAfterFirst = manager.getTaskRuntimeState().revision;

  const repeatedCandidate = createSourceOwnedTransitionCandidate({
    sessionId,
    runtimeEpoch: 3,
    source: "screen",
    sourceObservationIds: ["screen-idempotent"],
    existingTask: manager.getTaskRuntimeState().parent,
    relation: "new-parent",
    authoritySource: "screen-preflight",
    mutationAuthorized: true,
    questionType: "general-system-design",
    question: "Design a URL shortener.",
    now: now + 3,
  });
  assert.ok(repeatedCandidate);
  const repeatedSource = commitSourceOwnedTransition({
    candidate: repeatedCandidate,
    currentTask: manager.getTaskRuntimeState().parent,
    currentSessionId: sessionId,
    currentRuntimeEpoch: 3,
    now: now + 4,
  });

  assert.equal(repeatedSource.candidate.state, "committed");
  assert.equal(repeatedSource.mutationApplied, false);
  assert.equal(repeatedSource.reason, "already-applied");
  assert.equal(manager.getTaskRuntimeState().revision, revisionAfterFirst);
});

test("keeps a pre-model lifecycle commit after provider failure", () => {
  const manager = new MeetingContextManager();
  const sessionId = manager.getState().sessionId;
  const candidate = createSourceOwnedTransitionCandidate({
    sessionId,
    runtimeEpoch: 3,
    source: "voice",
    sourceTurnIds: ["turn-provider-failure"],
    relation: "new-parent",
    authoritySource: "committed-settlement",
    mutationAuthorized: true,
    questionType: "coding",
    question: "Implement an LRU cache.",
    now: now + 1,
  });
  assert.ok(candidate);
  const sourceResult = commitSourceOwnedTransition({
    candidate,
    currentSessionId: sessionId,
    currentRuntimeEpoch: 3,
    now: now + 2,
  });
  const durableResult = commitLikeCurrentHook({
    manager,
    transition: "create-parent",
    parent: sourceResult.task,
  });

  assert.equal(durableResult.mutationApplied, true);
  assert.equal(
    sourceOwnedTransitionSurvivesModelOutcome(sourceResult, "error"),
    true
  );
  assert.equal(manager.getTaskRuntimeState().parent?.stableKind, "coding");
});

test("does not roll back a pre-model lifecycle after publication preparation fails", () => {
  const manager = new MeetingContextManager();
  const parent = makeParent("parent-publication", "coding");
  setTestTaskRuntime(manager, { parent });
  const revisionBeforePublication = manager.getTaskRuntimeState().revision;
  const ledger = new GenerationResultLedger();
  const coordinator = new GenerationDerivedCommitCoordinator(ledger);
  const lease = {
    id: "lease-publication-failure",
    sessionId: "session-publication",
    runtimeEpoch: 3,
    preparationContextRevision: 0,
    taskId: parent.id,
    taskRevision: parent.revisions,
    logicalQuestionUnitId: "lqu-publication",
    logicalQuestionRevision: 1,
    baseVisibleAnswerRevision: 0,
    sourceTurnIds: ["turn-publication"],
    manualCorrectionRevision: 0,
    responseActionRevision: 0,
    modelRoute: "advisor:test",
    artifactOwnerId: parent.id,
    requestedArtifacts: ["answer" as const],
    startedAt: now,
  };
  ledger.begin({ lease });
  const result = coordinator.commitStaged({
    lease,
    leaseAuthorization: authorizeAnswerGenerationLease(lease, {
      sessionId: lease.sessionId,
      runtimeEpoch: lease.runtimeEpoch,
      preparationContextRevision: lease.preparationContextRevision,
      taskId: lease.taskId,
      taskRevision: lease.taskRevision,
      logicalQuestionUnitId: lease.logicalQuestionUnitId,
      logicalQuestionRevision: lease.logicalQuestionRevision,
      visibleAnswerRevision: lease.baseVisibleAnswerRevision,
      manualCorrectionRevision: lease.manualCorrectionRevision,
      responseActionRevision: lease.responseActionRevision,
      artifactOwnerId: lease.artifactOwnerId,
      authorizedArtifacts: ["answer"],
    }),
    expectedTaskRuntimeRevision: revisionBeforePublication,
    currentTaskRuntimeRevision: revisionBeforePublication,
    candidateAccepted: true,
    visibleAnswerRevision: 1,
    publication: {
      prepare: () => {
        throw new Error("publication preparation failed");
      },
      install: () => undefined,
      rollback: () => true,
    },
  });

  assert.equal(result.committed, false);
  assert.equal(result.reason, "stable-answer-publication-prepare-exception");
  assert.equal(manager.getTaskRuntimeState().revision, revisionBeforePublication);
  assert.equal(manager.getTaskRuntimeState().parent?.id, parent.id);
});

test("freezes the current intermediate authority consumer inventory", async () => {
  const hookSource = await readFile(
    `${process.cwd()}/src/hooks/useMeetingAssistant.ts`,
    "utf8"
  );
  assert.equal(
    hookSource.match(/screenSourceTransitionCommittedBeforeModel/g)?.length,
    16
  );
  for (const productConsumer of [
    "screenSourceTransitionAllowsTaskMutation",
    "screenStartedNewInterviewParent",
    "taskBoundaryCommitted:\n              screenSourceTransitionCommittedBeforeModel",
    "sourceTransitionPrecommitted:\n              screenSourceTransitionCommittedBeforeModel",
    "screenTaskContextCommitted =\n          screenTaskResultCommitted ||\n          screenSourceTransitionCommittedBeforeModel",
  ]) {
    assert.equal(hookSource.includes(productConsumer), true, productConsumer);
  }
});

function commitLikeCurrentHook(input: {
  manager: MeetingContextManager;
  transition: MeetingTaskRuntimeTransitionKind;
  parent?: ActiveInterviewParent;
}) {
  return input.manager.commitTaskRuntimeTransition({
    id: `characterization-${input.transition}-${Date.now()}`,
    transition: input.transition,
    reason: "source-owned-transition-committed",
    expectedRevision: input.manager.getTaskRuntimeState().revision,
    parent: input.parent ?? null,
  });
}

function makeParent(
  id: string,
  stableKind: ActiveInterviewParent["stableKind"]
): ActiveInterviewParent {
  return {
    id,
    source: "voice",
    stableKind,
    topic: id,
    playbookPhase:
      stableKind === "coding"
        ? "implementation_validation"
        : stableKind === "project-deep-dive"
          ? "project_narrative"
          : "story_selection",
    phaseProgress: {},
    supportedFactAnchors: [],
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 60_000,
    revisions: 1,
  };
}
