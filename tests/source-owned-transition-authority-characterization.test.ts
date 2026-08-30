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
  commitSourceOwnedTransitionToRuntime,
  sourceOwnedDurableTransitionSurvivesModelOutcome,
  sourceOwnedTransitionDurableMutationApplied,
  sourceOwnedTransitionDurablySatisfied,
} from "../src/lib/meeting/source-owned-transition-runtime.js";
import { createSourceOwnedTransitionCandidate } from "../src/lib/meeting/source-owned-transition-transaction.js";
import type {
  ActiveInterviewParent,
} from "../src/lib/meeting/types.js";
import { setTestTaskRuntime } from "./helpers/meeting-task-runtime.js";

const now = Date.now();

test("rejects a stale no-parent Screen preparation against the canonical runtime", () => {
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
  const receipt = commitThroughRuntime({
    manager,
    candidate,
    expectedTaskRuntimeRevision: 0,
    currentSessionId: sessionId,
    currentRuntimeEpoch: 3,
    reason: "screen-source-transition-committed",
    now: now + 2,
  });

  assert.equal(receipt.sourceResult.candidate.state, "rejected");
  assert.equal(receipt.runtimeResult, undefined);
  assert.equal(receipt.reason, "task-runtime-revision-mismatch");
  assert.equal(manager.getTaskRuntimeState().parent?.id, liveParent.id);
});

test("rejects stale Parent A instead of replacing the newer live Parent B", () => {
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
  const receipt = commitThroughRuntime({
    manager,
    candidate,
    expectedTaskRuntimeRevision: manager.getTaskRuntimeState().revision,
    currentSessionId: sessionId,
    currentRuntimeEpoch: 3,
    reason: "screen-source-transition-committed",
    now: now + 2,
  });

  assert.equal(candidate.expectedParentId, staleParent.id);
  assert.equal(receipt.sourceResult.candidate.state, "rejected");
  assert.equal(receipt.sourceResult.reason, "parent-id-mismatch");
  assert.equal(receipt.runtimeResult, undefined);
  assert.equal(manager.getTaskRuntimeState().parent?.id, liveParent.id);
  assert.equal(
    manager.getTaskRuntimeState().parent?.stableKind,
    "project-deep-dive"
  );
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
  const firstReceipt = commitThroughRuntime({
    manager,
    candidate: firstCandidate,
    expectedTaskRuntimeRevision: manager.getTaskRuntimeState().revision,
    currentSessionId: sessionId,
    currentRuntimeEpoch: 3,
    reason: "screen-source-transition-committed",
    now: now + 2,
  });
  assert.equal(sourceOwnedTransitionDurableMutationApplied(firstReceipt), true);
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
  const repeatedReceipt = commitThroughRuntime({
    manager,
    candidate: repeatedCandidate,
    expectedTaskRuntimeRevision: manager.getTaskRuntimeState().revision,
    currentSessionId: sessionId,
    currentRuntimeEpoch: 3,
    reason: "screen-source-transition-committed",
    now: now + 4,
  });

  assert.equal(repeatedReceipt.sourceResult.candidate.state, "committed");
  assert.equal(repeatedReceipt.sourceResult.mutationApplied, false);
  assert.equal(repeatedReceipt.sourceResult.reason, "already-applied");
  assert.equal(sourceOwnedTransitionDurablySatisfied(repeatedReceipt), true);
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
  const receipt = commitThroughRuntime({
    manager,
    candidate,
    expectedTaskRuntimeRevision: manager.getTaskRuntimeState().revision,
    currentSessionId: sessionId,
    currentRuntimeEpoch: 3,
    reason: "source-owned-transition-committed",
    now: now + 2,
  });

  assert.equal(sourceOwnedTransitionDurableMutationApplied(receipt), true);
  assert.equal(
    sourceOwnedDurableTransitionSurvivesModelOutcome(receipt, "error"),
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

test("prevents intermediate and post-model topology authority recurrence", async () => {
  const hookSource = await readFile(
    `${process.cwd()}/src/hooks/useMeetingAssistant.ts`,
    "utf8"
  );
  assert.match(
    hookSource,
    /const screenDurableTransitionSatisfiedBeforeModel =\s+sourceOwnedTransitionDurablySatisfied/
  );
  assert.equal(hookSource.includes("commitSourceOwnedTransition({"), false);
  assert.equal(
    hookSource.includes("screenSourceTransitionCommittedBeforeModel"),
    false
  );
  assert.equal(hookSource.includes("screenCandidateStartedNewParent"), false);
  assert.equal(hookSource.includes("phase-screen-"), false);
  assert.equal(
    hookSource.match(/authorizePostModelTaskRuntimeTransition\(/g)?.length,
    2
  );
  assert.equal(
    hookSource.includes("sourceOwnedTransitionResult?.candidate.state"),
    false
  );
  assert.equal(
    hookSource.includes("sourceOwnedTransitionResult.candidate.state"),
    false
  );
});

function commitThroughRuntime(input: {
  manager: MeetingContextManager;
  candidate: NonNullable<
    ReturnType<typeof createSourceOwnedTransitionCandidate>
  >;
  expectedTaskRuntimeRevision: number;
  currentSessionId: string;
  currentRuntimeEpoch: number;
  reason: string;
  now?: number;
}) {
  const runtimeBefore = input.manager.getTaskRuntimeState();
  return commitSourceOwnedTransitionToRuntime({
    candidate: input.candidate,
    runtimeBefore,
    expectedTaskRuntimeRevision: input.expectedTaskRuntimeRevision,
    currentSessionId: input.currentSessionId,
    currentRuntimeEpoch: input.currentRuntimeEpoch,
    now: input.now,
    commitRuntime: ({
      sourceResult,
      runtimeBefore: committedRuntimeBefore,
      expectedTaskRuntimeRevision,
    }) => {
      const runtimeTransition: MeetingTaskRuntimeTransitionKind =
        sourceResult.candidate.kind === "child-probe"
          ? "attach-child"
          : sourceResult.candidate.kind === "resume-parent"
            ? "resume-parent"
            : sourceResult.candidate.kind === "phase-progress"
              ? "advance-phase"
              : committedRuntimeBefore.parent
                ? "replace-parent"
                : "create-parent";
      const runtimeResult = input.manager.commitTaskRuntimeTransition({
        id: `characterization-${sourceResult.candidate.id}`,
        transition: runtimeTransition,
        reason: input.reason,
        expectedRevision: expectedTaskRuntimeRevision,
        screenAttachment:
          sourceResult.candidate.kind === "new-parent" ||
          sourceResult.candidate.kind === "reseed-parent"
            ? null
            : committedRuntimeBefore.screenAttachment,
        parent: sourceResult.task ?? null,
      });
      return { runtimeResult, runtimeTransition };
    },
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
