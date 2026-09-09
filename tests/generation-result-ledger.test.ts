import assert from "node:assert/strict";
import test from "node:test";
import type { AIResponseTerminalOutcome } from "../src/lib/functions/ai-response-events.js";
import type {
  AnswerGenerationLease,
  AnswerGenerationLeaseSnapshot,
} from "../src/lib/meeting/answer-generation-lease.js";
import { authorizeAnswerGenerationLease } from "../src/lib/meeting/answer-generation-lease.js";
import {
  authorizePostModelTaskRuntimeTransition,
  buildGenerationAuthorizationRejection,
  GenerationDerivedCommitCoordinator,
  GenerationResultLedger,
  formatGenerationResultLedgerForTrace,
} from "../src/lib/meeting/generation-result-ledger.js";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import type { ActiveInterviewParent } from "../src/lib/meeting/types.js";
import { setTestTaskRuntime } from "./helpers/meeting-task-runtime.js";

function lease(
  overrides: Partial<AnswerGenerationLease> = {}
): AnswerGenerationLease {
  return {
    id: "lease-1",
    sessionId: "session-1",
    runtimeEpoch: 2,
    preparationContextRevision: 3,
    taskId: "parent-1",
    taskRevision: 4,
    logicalQuestionUnitId: "question-1",
    logicalQuestionRevision: 5,
    baseVisibleAnswerRevision: 6,
    sourceTurnIds: ["turn-1"],
    manualCorrectionRevision: 7,
    responseActionRevision: 8,
    modelRoute: "advisor:provider-1",
    artifactOwnerId: "parent-1",
    requestedArtifacts: ["answer"],
    startedAt: 100,
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<AnswerGenerationLeaseSnapshot> = {}
): AnswerGenerationLeaseSnapshot {
  return {
    sessionId: "session-1",
    runtimeEpoch: 2,
    preparationContextRevision: 3,
    taskId: "parent-1",
    taskRevision: 4,
    logicalQuestionUnitId: "question-1",
    logicalQuestionRevision: 5,
    visibleAnswerRevision: 6,
    manualCorrectionRevision: 7,
    responseActionRevision: 8,
    artifactOwnerId: "parent-1",
    authorizedArtifacts: ["answer"],
    ...overrides,
  };
}

function outcome(
  overrides: Partial<AIResponseTerminalOutcome> = {}
): AIResponseTerminalOutcome {
  return {
    requestId: "request-1",
    attemptId: "attempt-1",
    executionPlanId: "plan-1",
    modelId: "model-1",
    sessionId: "session-1",
    runtimeEpoch: 2,
    logicalQuestionUnitId: "question-1",
    logicalQuestionRevision: 5,
    attemptNumber: 1,
    maxAttempts: 1,
    final: true,
    disposition: "accepted",
    status: "success",
    retryable: false,
    providerId: "provider-1",
    startedAt: 100,
    firstContentAt: 120,
    lastContentAt: 130,
    finishedAt: 140,
    chunkCount: 2,
    observedContentChars: 44,
    observedContentHash: "abc12345",
    completionSignal: "openai-done",
    text: "model text must not be copied to the ledger",
    ...overrides,
  };
}

test("allows only same-owner context updates after model execution", () => {
  assert.deepEqual(authorizePostModelTaskRuntimeTransition(undefined), {
    authorized: true,
    reason: "same-owner-context-only",
  });
  assert.deepEqual(
    authorizePostModelTaskRuntimeTransition("update-parent-context"),
    {
      authorized: true,
      reason: "same-owner-context-only",
    }
  );
  for (const transition of [
    "create-parent",
    "replace-parent",
    "attach-child",
    "resume-parent",
    "set-phase",
    "update-source-attachment",
  ] as const) {
    assert.deepEqual(authorizePostModelTaskRuntimeTransition(transition), {
      authorized: false,
      reason: `post-model-topology-mutation:${transition}`,
    });
  }
});

test("stores bounded safe generation attempts without model text", () => {
  const ledger = new GenerationResultLedger(2);
  const first = lease();
  ledger.begin({ lease: first, traceId: "trace-1", now: 101 });
  ledger.recordProviderAttempt(first, outcome(), 141);

  const stored = ledger.getEntry(first.id);
  assert.ok(stored);
  assert.equal(stored.providerAttempts.length, 1);
  assert.equal(stored.terminalOutcome?.status, "success");
  assert.equal(stored.providerAttempts[0]?.chunkCount, 2);
  assert.equal(stored.providerAttempts[0]?.lastContentAt, 130);
  assert.equal(stored.providerAttempts[0]?.observedContentChars, 44);
  assert.equal(stored.providerAttempts[0]?.observedContentHash, "abc12345");
  assert.equal(stored.providerAttempts[0]?.completionSignal, "openai-done");
  assert.equal("text" in stored.providerAttempts[0], false);
  assert.doesNotMatch(
    JSON.stringify(formatGenerationResultLedgerForTrace(stored)),
    /model text must not be copied/
  );

  ledger.begin({
    lease: lease({ id: "lease-2", logicalQuestionUnitId: "question-2" }),
  });
  ledger.begin({
    lease: lease({ id: "lease-3", logicalQuestionUnitId: "question-3" }),
  });
  assert.deepEqual(
    ledger.listEntries().map((entry) => entry.generationLeaseId),
    ["lease-2", "lease-3"]
  );
});

test("commits one accepted generation and projects its visible result", () => {
  const ledger = new GenerationResultLedger();
  const coordinator = new GenerationDerivedCommitCoordinator(ledger);
  const currentLease = lease();
  ledger.begin({ lease: currentLease });
  ledger.recordCandidateValidation({
    lease: currentLease,
    disposition: "accepted",
    reason: "candidate-valid",
  });

  let mutations = 0;
  const committed = coordinator.commit({
    lease: currentLease,
    leaseAuthorization: authorizeAnswerGenerationLease(
      currentLease,
      snapshot()
    ),
    expectedTaskRuntimeRevision: 10,
    currentTaskRuntimeRevision: 10,
    candidateAccepted: true,
    visibleAnswerRevision: 7,
    apply: () => {
      mutations += 1;
      return "committed";
    },
  });
  assert.equal(committed.committed, true);
  assert.equal(committed.value, "committed");
  assert.equal(mutations, 1);
  assert.equal(
    ledger.project({
      sessionId: "session-1",
      runtimeEpoch: 2,
      logicalQuestionUnitId: "question-1",
      logicalQuestionRevision: 5,
      visibleAnswerRevision: 7,
    }).disposition,
    "current-visible"
  );

  const duplicate = coordinator.commit({
    lease: currentLease,
    leaseAuthorization: authorizeAnswerGenerationLease(
      currentLease,
      snapshot({ visibleAnswerRevision: 6 })
    ),
    expectedTaskRuntimeRevision: 10,
    currentTaskRuntimeRevision: 10,
    candidateAccepted: true,
    visibleAnswerRevision: 7,
    apply: () => {
      mutations += 1;
    },
  });
  assert.equal(duplicate.committed, false);
  assert.equal(duplicate.reason, "duplicate-generation-commit");
  assert.equal(mutations, 1);
});

test("rejects stale or invalid generations before any mutation", () => {
  const cases = [
    {
      name: "stale-session",
      current: snapshot({ sessionId: "session-2" }),
      expectedTaskRuntimeRevision: 10,
      currentTaskRuntimeRevision: 10,
      candidateAccepted: true,
      reason: "session-mismatch",
    },
    {
      name: "runtime-revision-drift",
      current: snapshot(),
      expectedTaskRuntimeRevision: 10,
      currentTaskRuntimeRevision: 11,
      candidateAccepted: true,
      reason: "task-runtime-revision-mismatch",
    },
    {
      name: "invalid-candidate",
      current: snapshot(),
      expectedTaskRuntimeRevision: 10,
      currentTaskRuntimeRevision: 10,
      candidateAccepted: false,
      reason: "candidate-not-accepted",
    },
  ] as const;

  for (const currentCase of cases) {
    const ledger = new GenerationResultLedger();
    const coordinator = new GenerationDerivedCommitCoordinator(ledger);
    const currentLease = lease({ id: `lease-${currentCase.name}` });
    ledger.begin({ lease: currentLease });
    let mutated = false;
    const result = coordinator.commit({
      lease: currentLease,
      leaseAuthorization: authorizeAnswerGenerationLease(
        currentLease,
        currentCase.current
      ),
      expectedTaskRuntimeRevision: currentCase.expectedTaskRuntimeRevision,
      currentTaskRuntimeRevision: currentCase.currentTaskRuntimeRevision,
      candidateAccepted: currentCase.candidateAccepted,
      visibleAnswerRevision: 7,
      apply: () => {
        mutated = true;
      },
    });
    assert.equal(result.committed, false, currentCase.name);
    assert.equal(result.reason, currentCase.reason, currentCase.name);
    assert.equal(mutated, false, currentCase.name);
  }
});

test("records a typed task-transition rejection without publishing", () => {
  const ledger = new GenerationResultLedger();
  const coordinator = new GenerationDerivedCommitCoordinator(ledger);
  const currentLease = lease({ id: "lease-transition-rejection" });
  ledger.begin({ lease: currentLease });
  let published = false;

  const result = coordinator.commitStaged({
    lease: currentLease,
    leaseAuthorization: authorizeAnswerGenerationLease(
      currentLease,
      snapshot()
    ),
    expectedTaskRuntimeRevision: 10,
    currentTaskRuntimeRevision: 10,
    candidateAccepted: true,
    visibleAnswerRevision: 7,
    transition: {
      kind: "update-parent-context",
      prepare: () => ({
        authorized: false,
        reason: "revision-mismatch",
        value: "unused",
      }),
      install: () => ({ authorized: true, reason: "committed" }),
      rollback: () => true,
    },
    publication: {
      prepare: () => {
        published = true;
        return "prepared";
      },
      install: () => undefined,
      rollback: () => true,
    },
  });

  assert.equal(result.committed, false);
  assert.equal(
    result.reason,
    "task-transition-rejected:revision-mismatch"
  );
  assert.equal(published, false);
  assert.deepEqual(result.entry.applyFailure, {
    stage: "task-transition",
    reason: "task-transition-rejected:revision-mismatch",
    transitionKind: "update-parent-context",
    expectedTaskRuntimeRevision: 10,
    currentTaskRuntimeRevision: 10,
  });
});

test("rejects a publication preparation exception before task mutation", () => {
  const ledger = new GenerationResultLedger();
  const coordinator = new GenerationDerivedCommitCoordinator(ledger);
  const currentLease = lease({ id: "lease-publication-exception" });
  ledger.begin({ lease: currentLease });
  let taskMutated = false;

  const result = coordinator.commitStaged({
    lease: currentLease,
    leaseAuthorization: authorizeAnswerGenerationLease(
      currentLease,
      snapshot()
    ),
    expectedTaskRuntimeRevision: 12,
    currentTaskRuntimeRevision: 12,
    candidateAccepted: true,
    visibleAnswerRevision: 7,
    transition: {
      kind: "update-parent-context",
      prepare: () => ({
        authorized: true,
        reason: "prepared",
        value: "prepared-transition",
      }),
      install: () => {
        taskMutated = true;
        return { authorized: true, reason: "committed" };
      },
      rollback: () => {
        taskMutated = false;
        return true;
      },
    },
    publication: {
      prepare: () => {
        throw new TypeError(
          "publication state unavailable\nprivate detail omitted"
        );
      },
      install: () => undefined,
      rollback: () => true,
    },
  });

  assert.equal(result.committed, false);
  assert.equal(
    result.reason,
    "stable-answer-publication-prepare-exception"
  );
  assert.equal(taskMutated, false);
  assert.equal(result.entry.applyFailure?.stage, "stable-answer-publication");
  assert.equal(result.entry.applyFailure?.errorClass, "TypeError");
  assert.equal(
    result.entry.applyFailure?.safeErrorSummary,
    "publication state unavailable private detail omitted"
  );
});

test("rolls back prepared task and publication state after an install exception", () => {
  const ledger = new GenerationResultLedger();
  const coordinator = new GenerationDerivedCommitCoordinator(ledger);
  const currentLease = lease({ id: "lease-install-exception" });
  ledger.begin({ lease: currentLease });
  let taskState = "before";
  let publicationState = "before";

  const result = coordinator.commitStaged({
    lease: currentLease,
    leaseAuthorization: authorizeAnswerGenerationLease(
      currentLease,
      snapshot()
    ),
    expectedTaskRuntimeRevision: 12,
    currentTaskRuntimeRevision: 12,
    candidateAccepted: true,
    visibleAnswerRevision: 7,
    transition: {
      kind: "update-parent-context",
      prepare: () => ({
        authorized: true,
        reason: "prepared",
        value: "after",
      }),
      install: (prepared) => {
        taskState = prepared;
        return { authorized: true, reason: "committed" };
      },
      rollback: () => {
        taskState = "before";
        return true;
      },
    },
    publication: {
      prepare: () => "after",
      install: (prepared) => {
        publicationState = prepared;
        throw new Error("visible state install failed");
      },
      rollback: () => {
        publicationState = "before";
        return true;
      },
    },
  });

  assert.equal(result.committed, false);
  assert.equal(
    result.reason,
    "stable-answer-publication-install-exception"
  );
  assert.equal(taskState, "before");
  assert.equal(publicationState, "before");
  assert.equal(result.entry.applyFailure?.rollbackAttempted, true);
  assert.equal(result.entry.applyFailure?.rollbackSucceeded, true);
});

test("commits source-backed context or output-only publication through each prepared consumer shape", async (t) => {
  const consumerCases = [
    { name: "voice", commitsTask: true },
    { name: "screen", commitsTask: true },
    { name: "regenerate", commitsTask: false },
    { name: "pending-delivery", commitsTask: true },
  ] as const;

  for (const consumerCase of consumerCases) {
    await t.test(consumerCase.name, () => {
      const manager = new MeetingContextManager();
      const parent = generationConsumerParent(consumerCase.name);
      setTestTaskRuntime(manager, { parent });
      const before = manager.getTaskRuntimeState();
      const ledger = new GenerationResultLedger();
      const coordinator = new GenerationDerivedCommitCoordinator(ledger);
      const currentLease = lease({ id: `lease-${consumerCase.name}` });
      ledger.begin({ lease: currentLease });
      let visiblePublication = "before";
      let previousVisiblePublication = visiblePublication;

      const result = coordinator.commitStaged({
        lease: currentLease,
        leaseAuthorization: authorizeAnswerGenerationLease(
          currentLease,
          snapshot()
        ),
        expectedTaskRuntimeRevision: before.revision,
        currentTaskRuntimeRevision: before.revision,
        candidateAccepted: true,
        visibleAnswerRevision: 7,
        transition: consumerCase.commitsTask
          ? {
              kind: "update-parent-context",
              prepare: () => {
                const prepared = manager.prepareTaskRuntimeTransition({
                  id: `transition-${consumerCase.name}`,
                  transition: "update-parent-context",
                  reason: `generation-${consumerCase.name}`,
                  expectedRevision: before.revision,
                  parent: {
                    ...parent,
                    supportedFactAnchors: [`source-fact-${consumerCase.name}`],
                    revisions: parent.revisions + 1,
                  },
                });
                return {
                  authorized: prepared.result.authorized,
                  reason: prepared.result.reason,
                  value: prepared,
                };
              },
              install: (prepared) =>
                manager.commitPreparedTaskRuntimeTransition(prepared),
              rollback: (prepared) =>
                manager.rollbackPreparedTaskRuntimeTransition(prepared),
            }
          : undefined,
        publication: {
          prepare: () => {
            previousVisiblePublication = visiblePublication;
            return `${consumerCase.name}-visible`;
          },
          install: (prepared) => {
            visiblePublication = prepared;
            return prepared;
          },
          rollback: () => {
            visiblePublication = previousVisiblePublication;
            return true;
          },
        },
      });

      assert.equal(result.committed, true);
      assert.equal(visiblePublication, `${consumerCase.name}-visible`);
      if (consumerCase.commitsTask) {
        assert.deepEqual(
          manager.getTaskRuntimeState().parent?.supportedFactAnchors,
          [`source-fact-${consumerCase.name}`]
        );
        assert.equal(
          manager.getTaskRuntimeState().revision,
          before.revision + 1
        );
      } else {
        assert.deepEqual(manager.getTaskRuntimeState(), before);
      }
      assert.equal("latestUsefulAnswer" in manager.getTaskRuntimeState().parent!, false);
      assert.equal(result.entry.commitDisposition, "committed");
      assert.ok((result.entry.prepareDurationMs ?? -1) >= 0);
      assert.ok((result.entry.installDurationMs ?? -1) >= 0);
    });
  }
});

test("projects pending and historical entries without deleting origin results", () => {
  const ledger = new GenerationResultLedger();
  const first = lease();
  ledger.begin({ lease: first });
  ledger.recordCommitDisposition({
    lease: first,
    disposition: "pending",
    reason: "delivery-lock",
  });
  assert.equal(
    ledger.project({
      sessionId: "session-1",
      runtimeEpoch: 2,
      logicalQuestionUnitId: "question-1",
      logicalQuestionRevision: 5,
      visibleAnswerRevision: 6,
    }).disposition,
    "pending"
  );

  ledger.recordCommitDisposition({
    lease: first,
    disposition: "committed",
    reason: "authorized",
    visibleAnswerRevision: 7,
  });
  assert.equal(
    ledger.project({
      sessionId: "session-1",
      runtimeEpoch: 2,
      logicalQuestionUnitId: "question-2",
      logicalQuestionRevision: 1,
      visibleAnswerRevision: 7,
    }).disposition,
    "historical"
  );
  assert.equal(ledger.listEntries().length, 1);
});

function generationConsumerParent(
  consumerName: string
): ActiveInterviewParent {
  return {
    id: "parent-1",
    source: consumerName === "screen" ? "screen" : "voice",
    stableKind: "coding",
    topic: "Implement an LRU cache",
    playbookPhase: "implementation_validation",
    phaseProgress: {
      baseline_reasoning: true,
      optimized_pseudocode: true,
      implementation_validation: true,
    },
    supportedFactAnchors: [],
    createdAt: 100,
    updatedAt: 101,
    revisions: 2,
  };
}

test("terminalizes cancelled and superseded generations exactly once", () => {
  const ledger = new GenerationResultLedger();
  const currentLease = lease();
  ledger.begin({ lease: currentLease });
  ledger.recordCommitDisposition({
    lease: currentLease,
    disposition: "pending",
    reason: "awaiting-visible-delivery",
  });

  const terminal = ledger.terminalize({
    generationLeaseId: currentLease.id,
    disposition: "superseded",
    reason: "manual-screen-capture-succeeded",
    source: "manual-screen",
    authority: "human-explicit-capture",
    targetLogicalQuestionRevision: 6,
  });
  assert.equal(terminal?.commitDisposition, "superseded");
  assert.deepEqual(terminal?.terminalization, {
    disposition: "superseded",
    reason: "manual-screen-capture-succeeded",
    source: "manual-screen",
    authority: "human-explicit-capture",
    targetLogicalQuestionRevision: 6,
    candidateFormed: false,
    terminalizedAt: terminal?.terminalization?.terminalizedAt,
  });
  assert.equal(
    ledger.project({
      sessionId: "session-1",
      runtimeEpoch: 2,
      logicalQuestionUnitId: "question-1",
      logicalQuestionRevision: 5,
      visibleAnswerRevision: 6,
    }).disposition,
    "historical"
  );

  ledger.recordCommitDisposition({
    lease: currentLease,
    disposition: "committed",
    reason: "late-provider-completion",
    visibleAnswerRevision: 7,
  });
  assert.equal(
    ledger.getEntry(currentLease.id)?.commitDisposition,
    "superseded"
  );
});

test("maps upstream authorization rejection to one generation terminal state", () => {
  const ledger = new GenerationResultLedger();
  const currentLease = lease();
  ledger.begin({ lease: currentLease });
  const rejection = buildGenerationAuthorizationRejection({
    lease: currentLease,
    reason: "logical-question-id-mismatch",
    source: "logical-question-lease-authorization",
    authority: "logical-question-lease",
    targetLogicalQuestionRevision: 6,
  });
  assert.ok(rejection);

  const terminal = ledger.terminalize({
    generationLeaseId: rejection.lease.id,
    disposition: rejection.disposition,
    reason: rejection.reason,
    source: rejection.source,
    authority: rejection.authority,
    targetLogicalQuestionRevision:
      rejection.targetLogicalQuestionRevision,
    candidateFormed: rejection.candidateFormed,
    now: 150,
  });
  assert.equal(terminal?.commitDisposition, "rejected");
  assert.deepEqual(terminal?.terminalization, {
    disposition: "rejected",
    reason: "logical-question-id-mismatch",
    source: "logical-question-lease-authorization",
    authority: "logical-question-lease",
    targetLogicalQuestionRevision: 6,
    candidateFormed: false,
    terminalizedAt: 150,
  });

  ledger.terminalize({
    generationLeaseId: currentLease.id,
    disposition: "committed",
    reason: "late-provider-completion",
    source: "provider",
    authority: "provider-result",
    now: 160,
  });
  assert.equal(
    ledger.getEntry(currentLease.id)?.commitDisposition,
    "rejected"
  );
});

test("does not fabricate a terminalization before a generation lease exists", () => {
  assert.equal(
    buildGenerationAuthorizationRejection({
      lease: undefined,
      reason: "runtime-epoch-mismatch",
      source: "runtime-commit-authorization",
      authority: "runtime-commit-token",
    }),
    undefined
  );
});

test("a terminalized generation cannot run its derived commit", () => {
  const ledger = new GenerationResultLedger();
  const coordinator = new GenerationDerivedCommitCoordinator(ledger);
  const currentLease = lease();
  ledger.begin({ lease: currentLease });
  ledger.terminalize({
    generationLeaseId: currentLease.id,
    disposition: "cancelled",
    reason: "runtime-boundary",
    source: "meeting-runtime",
    authority: "runtime-epoch",
  });
  let mutated = false;

  const result = coordinator.commit({
    lease: currentLease,
    leaseAuthorization: authorizeAnswerGenerationLease(
      currentLease,
      snapshot()
    ),
    expectedTaskRuntimeRevision: 10,
    currentTaskRuntimeRevision: 10,
    candidateAccepted: true,
    visibleAnswerRevision: 7,
    apply: () => {
      mutated = true;
    },
  });

  assert.equal(result.committed, false);
  assert.equal(result.reason, "generation-already-terminal:cancelled");
  assert.equal(mutated, false);
});
