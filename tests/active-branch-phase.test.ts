import assert from "node:assert/strict";
import test from "node:test";
import {
  createCodingChildPhaseState,
  preserveOrCreateCodingChildPhaseState,
  resolveEffectiveBranchPhase,
} from "../src/lib/meeting/active-branch-phase.js";
import type {
  ActiveInterviewParent,
  InterviewPlaybookId,
  InterviewPlaybookPhase,
  SelectedInterviewPlaybook,
} from "../src/lib/meeting/types.js";

test("resolves the current active branch instead of falling back to parent", () => {
  const parent = makeParent();
  const parentResolution = resolveEffectiveBranchPhase(parent);
  assert.equal(parentResolution.status, "resolved");
  if (parentResolution.status === "resolved") {
    assert.equal(parentResolution.view.ownerKind, "parent");
    assert.equal(parentResolution.view.ownerId, "parent-1");
  }

  parent.child = {
    id: "child-field",
    createdAt: 20,
    updatedAt: 20,
    questionType: "field-knowledge",
    relation: "child-probe",
    intent: "concept-probe",
    question: "What is HNSW?",
    basedOnTurnIds: ["turn-child"],
    basedOnObservationIds: [],
  };
  assert.deepEqual(resolveEffectiveBranchPhase(parent), {
    status: "unavailable",
    reason: "active-child-phase-unavailable",
    ownerKind: "child",
    ownerId: "child-field",
    parentId: "parent-1",
  });
});

test("initializes a Coding child directly at implementation validation", () => {
  const codingPlaybook = makePlaybook(
    "coding_algorithm",
    "coding",
    "baseline_reasoning"
  );
  const phaseState = createCodingChildPhaseState({
    questionType: "coding",
    playbook: codingPlaybook,
  });
  assert.equal(phaseState?.phase, "implementation_validation");
  assert.equal(phaseState?.playbook.phase, "implementation_validation");
  assert.deepEqual(phaseState?.phaseProgress, {
    implementation_validation: true,
  });
  assert.equal(phaseState?.revision, 1);

  const parent = makeParent({
    child: {
      id: "child-coding",
      createdAt: 20,
      updatedAt: 20,
      questionType: "coding",
      relation: "child-probe",
      intent: "implementation-probe",
      question: "Implement the reranker.",
      basedOnTurnIds: ["turn-code"],
      basedOnObservationIds: [],
      phaseState,
    },
  });
  const resolution = resolveEffectiveBranchPhase(parent);
  assert.equal(resolution.status, "resolved");
  if (resolution.status === "resolved") {
    assert.equal(resolution.view.ownerKind, "child");
    assert.equal(resolution.view.ownerId, "child-coding");
    assert.equal(resolution.view.phase, "implementation_validation");
    assert.equal(resolution.view.questionType, "coding");
  }
  assert.equal(parent.playbookPhase, "design_framing");
});

test("preserves an existing Coding child phase and removes it after retype", () => {
  const existing = createCodingChildPhaseState({
    questionType: "coding",
    playbook: makePlaybook(
      "coding_algorithm",
      "coding",
      "baseline_reasoning"
    ),
  });
  assert.ok(existing);
  existing.revision = 3;

  const preserved = preserveOrCreateCodingChildPhaseState({
    questionType: "coding",
    existing,
  });
  assert.equal(preserved?.revision, 3);
  assert.notEqual(preserved, existing);
  assert.equal(
    preserveOrCreateCodingChildPhaseState({
      questionType: "field-knowledge",
      existing,
    }),
    undefined
  );
});

function makeParent(
  patch: Partial<ActiveInterviewParent> = {}
): ActiveInterviewParent {
  return {
    id: "parent-1",
    source: "voice",
    stableKind: "ai-ml-system-design",
    topic: "Design a RAG system",
    playbook: makePlaybook(
      "aiml_system_design",
      "ai-ml-system-design",
      "design_framing"
    ),
    playbookPhase: "design_framing",
    phaseProgress: { design_framing: true },
    supportedFactAnchors: [],
    createdAt: 10,
    updatedAt: 10,
    revisions: 2,
    ...patch,
  };
}

function makePlaybook(
  id: InterviewPlaybookId,
  questionType: SelectedInterviewPlaybook["questionType"],
  phase: InterviewPlaybookPhase
): SelectedInterviewPlaybook {
  return {
    id,
    label: "Test playbook",
    phase,
    questionType,
    confidence: 1,
    reason: "test",
    memoryPolicy: { id: "test" },
    firstMove: "test",
    clarifyingStrategy: "test",
    outputContract: "test",
    followUpPolicy: "test",
  };
}
