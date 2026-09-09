import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeAnswerGenerationLease,
  type AnswerGenerationLease,
  type AnswerGenerationLeaseSnapshot,
} from "../src/lib/meeting/answer-generation-lease.js";
import { prepareCanonicalWhiteboardRegeneration } from "../src/lib/meeting/artifact-regeneration.js";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import {
  GenerationDerivedCommitCoordinator,
  GenerationResultLedger,
} from "../src/lib/meeting/generation-result-ledger.js";
import { parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";
import {
  commitStableAnswerRevision,
  commitStableArtifactOnlyRevision,
  type StableAnswerRevision,
} from "../src/lib/meeting/stable-answer.js";
import type {
  ActiveInterviewParent,
  AdvisorSuggestion,
} from "../src/lib/meeting/types.js";
import { resolveWhiteboardArtifactDisplay } from "../src/lib/meeting/whiteboard-artifact.js";
import { setTestTaskRuntime } from "./helpers/meeting-task-runtime.js";

function suggestion(id: string, content: string): AdvisorSuggestion {
  return {
    id,
    kind: "answer",
    content,
    meetingAnswer: parseMeetingAnswer(content),
    createdAt: 100,
    basedOnTurnIds: ["turn-1"],
    basedOnObservationIds: [],
    confidence: "high",
  };
}

function stableAnswer() {
  const stable = commitStableAnswerRevision({
    candidate: suggestion(
      "answer-1",
      "Answer: Keep this visible answer.\nWhiteboard:\n```mermaid\ngraph TD\nA-->B\n```"
    ),
    authorizedArtifacts: ["answer", "whiteboard"],
    taskId: "parent-1",
    logicalQuestionUnitId: "question-1",
    logicalQuestionRevision: 1,
    sessionId: "session-1",
    runtimeEpoch: 2,
    settlementId: "settlement-1",
    settlementSnapshot: {
      questionType: "general-system-design",
      relation: "followup-parent",
    },
    committedAt: 100,
  });
  assert.ok(stable);
  return stable;
}

function parent(stable: StableAnswerRevision): ActiveInterviewParent {
  return {
    id: "parent-1",
    source: "voice",
    stableKind: "general-system-design",
    topic: "Design a URL shortener",
    playbookPhase: "design_framing",
    phaseProgress: { requirement_clarification: true },
    supportedFactAnchors: ["fact-1"],
    latestUsefulAnswer: "Keep latest useful answer.",
    previousUsefulAnswer: "Keep previous useful answer.",
    whiteboardArtifact: {
      id: "whiteboard-1",
      parentTaskId: "parent-1",
      domainTrack: "general_sd",
      archetypeIds: [],
      selectedOverlayIds: [],
      currentPhase: "design_framing",
      title: "URL shortener",
      content: stable.suggestion.meetingAnswer!.sections.whiteboard!,
      summary: "Initial diagram",
      revision: 1,
      updateSource: "model-output",
      updatedAt: 100,
      createdAt: 100,
    },
    createdAt: 10,
    updatedAt: 100,
    revisions: 3,
  };
}

function generationLease(): AnswerGenerationLease {
  return {
    id: "lease-1",
    sessionId: "session-1",
    runtimeEpoch: 2,
    preparationContextRevision: 1,
    taskId: "parent-1",
    taskRevision: 3,
    logicalQuestionUnitId: "question-1",
    logicalQuestionRevision: 1,
    baseVisibleAnswerRevision: 1,
    sourceTurnIds: ["turn-1"],
    manualCorrectionRevision: 0,
    responseActionRevision: 1,
    modelRoute: "advisor:provider-1",
    artifactOwnerId: "parent-1",
    requestedArtifacts: ["whiteboard"],
    startedAt: 100,
  };
}

function leaseSnapshot(): AnswerGenerationLeaseSnapshot {
  return {
    sessionId: "session-1",
    runtimeEpoch: 2,
    preparationContextRevision: 1,
    taskId: "parent-1",
    taskRevision: 3,
    logicalQuestionUnitId: "question-1",
    logicalQuestionRevision: 1,
    visibleAnswerRevision: 1,
    manualCorrectionRevision: 0,
    responseActionRevision: 1,
    artifactOwnerId: "parent-1",
    authorizedArtifacts: ["whiteboard"],
    candidateMutatedArtifacts: ["whiteboard"],
  };
}

function prepareFixture() {
  const currentStable = stableAnswer();
  const currentParent = parent(currentStable);
  const candidate = suggestion(
    "answer-2",
    "Answer: This replacement must stay hidden.\nWhiteboard:\n```mermaid\ngraph TD\nA-->B\nB-->C\n```"
  );
  const stableDecision = commitStableArtifactOnlyRevision({
    current: currentStable,
    candidate,
    authorizedArtifacts: ["whiteboard"],
    expectedVisibleAnswerRevision: currentStable.revision,
    expectedTaskId: "parent-1",
    expectedLogicalQuestionUnitId: "question-1",
    expectedLogicalQuestionRevision: 1,
    expectedSettlementId: "settlement-1",
  });
  assert.equal(stableDecision.disposition, "committed");
  const nextStable = stableDecision.stable!;
  const parentDecision = prepareCanonicalWhiteboardRegeneration({
    target: {
      sessionId: "session-1",
      runtimeEpoch: 2,
      visibleAnswerRevision: currentStable.revision,
      logicalQuestionUnitId: "question-1",
      logicalQuestionRevision: 1,
      settlementId: "settlement-1",
      parentId: "parent-1",
      parentRevision: 3,
      questionType: "general-system-design",
      playbookPhase: "design_framing",
      phaseOwnerKind: "parent",
      phaseOwnerId: "parent-1",
      phaseOwnerRevision: 3,
      sectionOwner: { kind: "parent-mainline", parentId: "parent-1" },
      artifactFamilies: ["whiteboard"],
    },
    currentParent,
    candidateWhiteboard: {
      ...currentParent.whiteboardArtifact!,
      content: nextStable.suggestion.meetingAnswer!.sections.whiteboard!,
      summary: "Updated diagram",
      revision: 2,
      updateSource: "manual-artifact-regeneration",
      updatedAt: 200,
    },
  });
  assert.equal(parentDecision.authorized, true);
  return {
    currentStable,
    currentParent,
    nextStable,
    nextParent: parentDecision.parent!,
  };
}

test("co-commits the canonical Whiteboard and Stable Answer section", () => {
  const fixture = prepareFixture();
  const manager = new MeetingContextManager();
  setTestTaskRuntime(manager, { parent: fixture.currentParent });
  const beforeRuntime = manager.getTaskRuntimeState();
  const ledger = new GenerationResultLedger();
  const coordinator = new GenerationDerivedCommitCoordinator(ledger);
  const lease = generationLease();
  ledger.begin({ lease });
  let visibleStable = fixture.currentStable;
  let previousVisible = visibleStable;

  const result = coordinator.commitStaged({
    lease,
    leaseAuthorization: authorizeAnswerGenerationLease(
      lease,
      leaseSnapshot()
    ),
    expectedTaskRuntimeRevision: beforeRuntime.revision,
    currentTaskRuntimeRevision: beforeRuntime.revision,
    candidateAccepted: true,
    visibleAnswerRevision: fixture.nextStable.revision,
    transition: {
      kind: "update-parent-context",
      prepare: () => {
        const prepared = manager.prepareTaskRuntimeTransition({
          id: "artifact-transition",
          transition: "update-parent-context",
          authorizedArtifacts: leaseSnapshot().authorizedArtifacts,
          reason: "manual-artifact-regeneration-atomic-whiteboard",
          expectedRevision: beforeRuntime.revision,
          parent: fixture.nextParent,
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
    },
    publication: {
      prepare: () => {
        previousVisible = visibleStable;
        return fixture.nextStable;
      },
      install: (prepared) => {
        visibleStable = prepared;
        return prepared;
      },
      rollback: () => {
        visibleStable = previousVisible;
        return true;
      },
    },
  });

  assert.equal(result.committed, true);
  const committedParent = manager.getTaskRuntimeState().parent!;
  assert.equal(committedParent.whiteboardArtifact?.revision, 2);
  assert.equal(visibleStable.sections.whiteboard.revision, 2);
  assert.equal(
    committedParent.whiteboardArtifact?.content,
    visibleStable.suggestion.meetingAnswer?.sections.whiteboard
  );
  assert.equal(
    visibleStable.suggestion.meetingAnswer?.sections.answer,
    fixture.currentStable.suggestion.meetingAnswer?.sections.answer
  );
  assert.equal(
    committedParent.latestUsefulAnswer,
    fixture.currentParent.latestUsefulAnswer
  );
  const display = resolveWhiteboardArtifactDisplay({
    activeParentTaskId: committedParent.id,
    activeParentQuestionType: committedParent.stableKind,
    artifact: committedParent.whiteboardArtifact,
    sourceParentTaskId: committedParent.id,
    sourceParentQuestionType: committedParent.stableKind,
  });
  assert.equal(display.whiteboard.kind, "replace");
  assert.equal(
    display.whiteboard.kind === "replace"
      ? display.whiteboard.value
      : undefined,
    visibleStable.suggestion.meetingAnswer?.sections.whiteboard
  );
});

test("rolls the canonical parent back when visible publication fails", () => {
  const fixture = prepareFixture();
  const manager = new MeetingContextManager();
  setTestTaskRuntime(manager, { parent: fixture.currentParent });
  const beforeRuntime = manager.getTaskRuntimeState();
  const ledger = new GenerationResultLedger();
  const coordinator = new GenerationDerivedCommitCoordinator(ledger);
  const lease = generationLease();
  ledger.begin({ lease });
  let visibleStable = fixture.currentStable;

  const result = coordinator.commitStaged({
    lease,
    leaseAuthorization: authorizeAnswerGenerationLease(
      lease,
      leaseSnapshot()
    ),
    expectedTaskRuntimeRevision: beforeRuntime.revision,
    currentTaskRuntimeRevision: beforeRuntime.revision,
    candidateAccepted: true,
    visibleAnswerRevision: fixture.nextStable.revision,
    transition: {
      kind: "update-parent-context",
      prepare: () => {
        const prepared = manager.prepareTaskRuntimeTransition({
          id: "artifact-transition-rollback",
          transition: "update-parent-context",
          authorizedArtifacts: leaseSnapshot().authorizedArtifacts,
          reason: "manual-artifact-regeneration-atomic-whiteboard",
          expectedRevision: beforeRuntime.revision,
          parent: fixture.nextParent,
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
    },
    publication: {
      prepare: () => fixture.nextStable,
      install: (prepared) => {
        visibleStable = prepared;
        throw new Error("simulated visible publication failure");
      },
      rollback: () => {
        visibleStable = fixture.currentStable;
        return true;
      },
    },
  });

  assert.equal(result.committed, false);
  assert.equal(
    result.reason,
    "stable-answer-publication-install-exception"
  );
  assert.deepEqual(manager.getTaskRuntimeState(), beforeRuntime);
  assert.equal(visibleStable.revision, fixture.currentStable.revision);
  assert.equal(result.entry.applyFailure?.rollbackSucceeded, true);
});
