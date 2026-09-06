import assert from "node:assert/strict";
import test from "node:test";
import {
  applyInterviewChildProbeTransition,
  commitVisibleUsefulAnswerToParent,
  decideInterviewTaskContinuityBranch,
  mergeGeneratedChildContinuity,
} from "../src/lib/meeting/interview-task-continuity.js";
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
  const next = applyInterviewChildProbeTransition({
    parent,
    child,
    supportedFactAnchors: ["agentic-memory"],
    whiteboardArtifact: parent.whiteboardArtifact,
    now: 2_000,
    expiresAt: 20_000,
  });

  assert.equal(next.id, parent.id);
  assert.equal(next.stableKind, "ai-ml-system-design");
  assert.equal(next.playbookPhase, "design_framing");
  assert.equal(next.projectBinding, parent.projectBinding);
  assert.equal(next.whiteboardArtifact, parent.whiteboardArtifact);
  assert.equal(next.child, child);
  assert.equal(next.revisions, parent.revisions + 1);
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
  const generatedChild: ActiveInterviewChild = {
    ...makeChild(),
    id: "generated-child",
    questionType: "field-knowledge",
    question: "Generated answer should not replace this source question.",
    basedOnTurnIds: ["generated-turn"],
    basedOnObservationIds: ["generated-screen"],
    compactSummary: "Generated answer summary",
  };

  const merged = mergeGeneratedChildContinuity({
    sourceOwnedChild,
    generatedChild,
    now: 3_000,
  });

  assert.equal(merged.id, "child-1");
  assert.equal(merged.questionType, "coding");
  assert.equal(merged.question, "Implement the loss function");
  assert.deepEqual(merged.basedOnTurnIds, ["turn-1"]);
  assert.deepEqual(merged.basedOnObservationIds, []);
  assert.equal(merged.latestScreenObservationId, "screen-source");
  assert.equal(merged.returnCapsule, sourceOwnedChild.returnCapsule);
  assert.equal(merged.phaseState, sourceOwnedChild.phaseState);
  assert.equal(merged.compactSummary, "Generated answer summary");
  assert.equal(merged.updatedAt, 3_000);
});

test("updates durable useful-answer history only from a visible commit", () => {
  const parent = {
    ...makeParent(),
    latestUsefulAnswer: "Previous visible answer",
  };
  const result = commitVisibleUsefulAnswerToParent({
    parent,
    taskId: parent.id,
    summary: "New visible answer",
    committedAt: 3_000,
  });

  assert.equal(result.committed, true);
  assert.equal(result.parent?.latestUsefulAnswer, "New visible answer");
  assert.equal(result.parent?.previousUsefulAnswer, "Previous visible answer");
  assert.equal(result.parent?.updatedAt, 3_000);
});

test("does not update useful-answer history for the wrong task or empty output", () => {
  const parent = makeParent();
  assert.equal(
    commitVisibleUsefulAnswerToParent({
      parent,
      taskId: "other-parent",
      summary: "Hidden candidate",
      committedAt: 3_000,
    }).committed,
    false
  );
  assert.equal(
    commitVisibleUsefulAnswerToParent({
      parent,
      taskId: parent.id,
      summary: "  ",
      committedAt: 3_000,
    }).committed,
    false
  );
});

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
