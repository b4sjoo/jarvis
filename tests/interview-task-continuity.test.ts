import assert from "node:assert/strict";
import test from "node:test";
import {
  decideInterviewTaskContinuityBranch,
} from "../src/lib/meeting/interview-task-continuity.js";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import { createSourceOwnedTransitionCandidate } from "../src/lib/meeting/source-owned-transition-transaction.js";
import {
  commitSourceOwnedTransitionToRuntime,
  resolveSourceOwnedRuntimeTransition,
} from "../src/lib/meeting/source-owned-transition-runtime.js";
import {
  prepareBoundedGeneratedContinuity,
  readBoundedGeneratedContinuity,
  type BoundedGeneratedContinuityOwner,
} from "../src/lib/meeting/bounded-recent-history.js";
import { parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";
import { commitStableAnswerRevision } from "../src/lib/meeting/stable-answer.js";
import { setTestActiveParent } from "./helpers/meeting-task-runtime.js";
import type {
  ActiveInterviewChild,
  ActiveInterviewParent,
} from "../src/lib/meeting/types.js";

test("keeps a coding probe as a child of a system-design parent", () => {
  assert.deepEqual(
    decideInterviewTaskContinuityBranch({
      hasExistingParent: true,
      existingParentQuestionType: "general-system-design",
      candidateQuestionType: "coding",
      relation: "child-probe",
    }),
    {
      branch: "child-probe",
      reason: "authoritative-child-relation-precedes-parent-eligibility",
    }
  );
});

test("keeps a coding probe under a project parent and preserves resume authority", () => {
  assert.equal(
    decideInterviewTaskContinuityBranch({
      hasExistingParent: true,
      existingParentQuestionType: "project-deep-dive",
      candidateQuestionType: "coding",
      relation: "child-probe",
    }).branch,
    "child-probe"
  );
  assert.equal(
    decideInterviewTaskContinuityBranch({
      hasExistingParent: true,
      existingParentQuestionType: "ai-ml-system-design",
      candidateQuestionType: "field-knowledge",
      relation: "resume-parent",
    }).branch,
    "continue-parent"
  );
});

test("allows an explicit new coding problem to replace the parent", () => {
  assert.deepEqual(
    decideInterviewTaskContinuityBranch({
      hasExistingParent: true,
      existingParentQuestionType: "general-system-design",
      candidateQuestionType: "coding",
      relation: "new-parent",
    }),
    {
      branch: "new-parent",
      reason: "relation-new-parent",
    }
  );
});

test("preserves the parent when relation evidence is unresolved", () => {
  assert.deepEqual(
    decideInterviewTaskContinuityBranch({
      hasExistingParent: true,
      existingParentQuestionType: "general-system-design",
      candidateQuestionType: "coding",
      relation: "unknown",
    }),
    {
      branch: "preserve",
      reason: "unresolved-relation-unknown",
    }
  );
});

test("does not continue an incompatible parent from a follow-up label alone", () => {
  assert.deepEqual(
    decideInterviewTaskContinuityBranch({
      hasExistingParent: true,
      existingParentQuestionType: "general-system-design",
      candidateQuestionType: "coding",
      relation: "followup-parent",
    }),
    {
      branch: "preserve",
      reason: "incompatible-type-without-new-parent-authority",
    }
  );
});

test("does not create a parent from an unscoped field-knowledge child", () => {
  assert.equal(
    decideInterviewTaskContinuityBranch({
      hasExistingParent: false,
      candidateQuestionType: "field-knowledge",
      relation: "child-probe",
    }).branch,
    "preserve"
  );
});

test("applies a child probe without replacing parent trajectory state", () => {
  const parent = makeParent();
  const child = makeChild();
  const manager = new MeetingContextManager();
  setTestActiveParent(manager, parent);
  const snapshot = manager.getTaskRuntimeState();
  const candidate = createSourceOwnedTransitionCandidate({
    sessionId: "session-1",
    runtimeEpoch: 1,
    existingTask: snapshot.parent,
    source: "voice",
    sourceTurnIds: child.basedOnTurnIds,
    relation: "child-probe",
    authoritySource: "accepted-transcript",
    mutationAuthorized: true,
    questionType: child.questionType,
    question: child.question,
    subtaskIntent: child.intent,
    playbook: codingPlaybook(),
    now: 2_000,
  });
  assert.ok(candidate);
  const result = commitSourceOwnedTransitionToRuntime({
    candidate,
    runtimeBefore: snapshot,
    expectedTaskRuntimeRevision: snapshot.revision,
    currentSessionId: "session-1",
    currentRuntimeEpoch: 1,
    now: 2_000,
    commitRuntime(input) {
      const transition = resolveSourceOwnedRuntimeTransition(input);
      return {
        runtimeTransition: transition,
        runtimeResult: manager.commitTaskRuntimeTransition({
          id: candidate.id,
          transition,
          expectedRevision: input.expectedTaskRuntimeRevision,
          reason: "source-child-committed",
          parent: input.sourceResult.task,
        }),
      };
    },
  });
  assert.equal(result.runtimeResult?.authorized, true);
  assert.equal(result.runtimeResult?.mutationApplied, true);
  assert.equal(result.runtimeTransition, "attach-child");
  const next = manager.getTaskRuntimeState().parent;
  assert.ok(next);

  assert.equal(next.id, parent.id);
  assert.equal(next.stableKind, "ai-ml-system-design");
  assert.equal(next.playbookPhase, "design_framing");
  assert.deepEqual(next.projectBinding, parent.projectBinding);
  assert.deepEqual(next.whiteboardArtifact, parent.whiteboardArtifact);
  assert.equal(next.child?.question, child.question);
  assert.equal(next.child?.questionType, child.questionType);
  assert.deepEqual(next.child?.basedOnTurnIds, child.basedOnTurnIds);
  assert.equal(next.child?.returnCapsule?.parentId, parent.id);
  assert.equal(next.child?.phaseState?.phase, "implementation_validation");
  assert.equal(next.revisions, parent.revisions + 1);
  assert.equal(manager.getTaskRuntimeState().revision, snapshot.revision + 1);
  assert.equal("latestUsefulAnswer" in next, false);
  assert.equal("compactSummary" in next.child!, false);
});

test("keeps source-owned child identity and return capsule when generation refreshes continuity", () => {
  const sourceOwnedChild: ActiveInterviewChild = {
    ...makeChild(),
    returnCapsule: {
      parentId: "parent-1",
      parentRevisionAtAttach: 2,
      createdAt: 2_000,
      parentPhase: "design_framing",
      topicCapsule: "Design a RAG system",
      allowedFactAnchorIds: ["agentic-memory"],
      artifactCompatibility: {
        policy: "preserve-parent-artifacts",
        whiteboardArtifactId: "whiteboard-1",
      },
    },
    phaseState: {
      phase: "implementation_validation",
      revision: 4,
      phaseProgress: { implementation_validation: true },
      playbook: {
        id: "coding_algorithm",
        label: "Coding Algorithm",
        questionType: "coding",
        phase: "implementation_validation",
        confidence: 1,
        reason: "test",
        memoryPolicy: { id: "test" },
        firstMove: "test",
        clarifyingStrategy: "test",
        outputContract: "test",
        followUpPolicy: "test",
      },
    },
    latestScreenObservationId: "screen-source",
  };
  const manager = new MeetingContextManager();
  setTestActiveParent(manager, { ...makeParent(), child: sourceOwnedChild });
  const snapshot = manager.getTaskRuntimeState();
  const currentOwner = { ...parentOwner, childTaskId: sourceOwnedChild.id };
  const output = prepareBoundedGeneratedContinuity({
    state: { recentCapsules: [] },
    currentOwner,
    stable: visibleAnswer(currentOwner),
    parentRevision: snapshot.parent!.revisions,
    parentSummaryAllowed: false,
    childSummary: "Generated answer summary",
  });
  const merged = manager.getTaskRuntimeState().parent!.child!;

  assert.equal(merged.id, "child-1");
  assert.equal(merged.questionType, "coding");
  assert.equal(merged.question, "Implement the loss function");
  assert.deepEqual(merged.basedOnTurnIds, ["turn-1"]);
  assert.deepEqual(merged.basedOnObservationIds, []);
  assert.equal(merged.latestScreenObservationId, "screen-source");
  assert.deepEqual(merged.returnCapsule, sourceOwnedChild.returnCapsule);
  assert.deepEqual(merged.phaseState, sourceOwnedChild.phaseState);
  assert.equal("compactSummary" in merged, false);
  assert.equal(merged.updatedAt, sourceOwnedChild.updatedAt);
  assert.equal(readBoundedGeneratedContinuity({ state: output, currentOwner }).childCompactSummary, "Generated answer summary");
  assert.deepEqual(manager.getTaskRuntimeState(), snapshot);
  assert.equal(prepareBoundedGeneratedContinuity({
    state: output,
    currentOwner,
    stable: visibleAnswer({ ...currentOwner, childTaskId: "generated-child" }),
    parentRevision: snapshot.parent!.revisions,
    parentSummaryAllowed: false,
    childSummary: "Wrong child summary",
  }), output);
});

test("prepares useful-answer history from visible output without changing task fields", () => {
  const manager = new MeetingContextManager();
  setTestActiveParent(manager, makeParent());
  const snapshot = manager.getTaskRuntimeState();
  const previous = prepareBoundedGeneratedContinuity({
    state: { recentCapsules: [] },
    currentOwner: parentOwner,
    stable: visibleAnswer(parentOwner, 1),
    parentRevision: snapshot.parent!.revisions,
    parentSummaryAllowed: true,
    parentSummary: "Previous visible answer",
  });
  const result = prepareBoundedGeneratedContinuity({
    state: previous,
    currentOwner: parentOwner,
    stable: visibleAnswer(parentOwner, 2),
    parentRevision: snapshot.parent!.revisions,
    parentSummaryAllowed: true,
    parentSummary: "New visible answer",
  });

  assert.equal(result.latestUsefulAnswer, "New visible answer");
  assert.equal(result.previousUsefulAnswer, "Previous visible answer");
  assert.equal(previous.latestUsefulAnswer, "Previous visible answer");
  assert.equal(previous.previousUsefulAnswer, undefined);
  assert.deepEqual(manager.getTaskRuntimeState(), snapshot);
  assert.equal("latestUsefulAnswer" in snapshot.parent!, false);
  assert.equal("previousUsefulAnswer" in snapshot.parent!, false);
});

test("does not update useful-answer history for the wrong task or empty output", () => {
  const state = prepareBoundedGeneratedContinuity({
    state: { recentCapsules: [] },
    currentOwner: parentOwner,
    stable: visibleAnswer(parentOwner),
    parentRevision: 2,
    parentSummaryAllowed: true,
    parentSummary: "Previous visible answer",
  });
  const wrongOwner = prepareBoundedGeneratedContinuity({
    state,
    currentOwner: parentOwner,
    stable: visibleAnswer({ ...parentOwner, parentTaskId: "other-parent" }),
    parentRevision: 2,
    parentSummaryAllowed: true,
    parentSummary: "Hidden candidate",
  });
  assert.equal(wrongOwner, state);
  const empty = prepareBoundedGeneratedContinuity({
    state,
    currentOwner: parentOwner,
    stable: visibleAnswer(parentOwner, 2),
    parentRevision: 2,
    parentSummaryAllowed: true,
    parentSummary: "  ",
  });
  assert.equal(empty.latestUsefulAnswer, "Previous visible answer");
  assert.equal(empty.previousUsefulAnswer, undefined);
});

const parentOwner: BoundedGeneratedContinuityOwner = {
  sessionId: "session-1",
  runtimeEpoch: 1,
  parentTaskId: "parent-1",
};

function visibleAnswer(owner: BoundedGeneratedContinuityOwner, revision = 1) {
  const content = "Answer: Use a bounded cache.\nApproach: Compare eviction policies.";
  const stable = commitStableAnswerRevision({
    candidate: {
      id: `answer-${revision}`,
      kind: "answer",
      content,
      meetingAnswer: parseMeetingAnswer(content),
      createdAt: 3_000,
      basedOnTurnIds: ["turn-1"],
      basedOnObservationIds: [],
      confidence: "high",
    },
    authorizedArtifacts: ["answer"],
    sessionId: owner.sessionId,
    runtimeEpoch: owner.runtimeEpoch,
    taskId: owner.parentTaskId,
    sectionOwner: owner.childTaskId
      ? { kind: "active-child", parentId: owner.parentTaskId, childId: owner.childTaskId }
      : { kind: "parent-mainline", parentId: owner.parentTaskId },
    logicalQuestionUnitId: `lqu-${revision}`,
    logicalQuestionRevision: 1,
    committedAt: 3_000,
    revision,
  });
  assert.ok(stable);
  return stable;
}

function codingPlaybook() {
  return {
    id: "coding_algorithm" as const,
    label: "Coding Algorithm",
    questionType: "coding" as const,
    phase: "implementation_validation" as const,
    confidence: 1,
    reason: "test",
    memoryPolicy: { id: "test" },
    firstMove: "test",
    clarifyingStrategy: "test",
    outputContract: "test",
    followUpPolicy: "test",
  };
}

function makeParent(): ActiveInterviewParent {
  return {
    id: "parent-1",
    source: "voice",
    stableKind: "ai-ml-system-design",
    topic: "Design a RAG system",
    playbookPhase: "design_framing",
    phaseProgress: { design_framing: true },
    projectBinding: {
      projectId: "agentic-memory",
      projectName: "Agentic Memory",
      primaryEntryId: "memory-1",
      evidenceEntryIds: ["memory-1"],
      source: "memory",
      confidence: 1,
      lockedAt: 1_000,
      revision: 1,
      reason: "test",
    },
    supportedFactAnchors: ["agentic-memory"],
    whiteboardArtifact: {
      id: "whiteboard-1",
      parentTaskId: "parent-1",
      domainTrack: "ml_sd",
      archetypeIds: [],
      selectedOverlayIds: [],
      currentPhase: "design_framing",
      title: "RAG architecture",
      content: "Query -> Retriever -> LLM",
      summary: "RAG architecture",
      revision: 1,
      updateSource: "model-output",
      updatedAt: 1_000,
      createdAt: 1_000,
    },
    createdAt: 1_000,
    updatedAt: 1_000,
    revisions: 2,
  };
}

function makeChild(): ActiveInterviewChild {
  return {
    id: "child-1",
    createdAt: 2_000,
    updatedAt: 2_000,
    questionType: "coding",
    relation: "child-probe",
    intent: "implementation-probe",
    question: "Implement the loss function",
    basedOnTurnIds: ["turn-1"],
    basedOnObservationIds: [],
  };
}
