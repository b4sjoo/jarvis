import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPlaybookPhaseDecisionToProgress,
  composeScreenPlaybookPhaseAfterLifecycle,
  composeScreenPlaybookPhaseInput,
  decideInterviewerAssumptionAuthorization,
  decideManualNextPhaseTransition,
  decidePlaybookPhaseProgression,
  formatCodingPlaybookPhaseContract,
  formatPlaybookPhaseDecisionForPrompt,
  formatPlaybookPhaseDecisionForTrace,
  resolvePlaybookState,
} from "../src/lib/meeting/playbook-phase.js";

test("authorizes a source-owned assumption signal only at a design requirement boundary", () => {
  const authorized = decideInterviewerAssumptionAuthorization({
    text: "You can make the hypothesis by yourself.",
    speaker: "them",
    activeQuestionType: "general-system-design",
    currentPhase: "requirement_clarification",
    sourceTurnId: "turn-assumption",
  });

  assert.equal(authorized.state, "authorized");
  assert.equal(authorized.phaseControl?.signal, "assumption-authorized");
  assert.equal(authorized.phaseBefore, "requirement_clarification");
  assert.equal(authorized.phaseAfter, "design_framing");
  assert.equal(authorized.whiteboardRevisionRequested, true);

  for (const decision of [
    decideInterviewerAssumptionAuthorization({
      text: "You can make reasonable assumptions.",
      speaker: "me",
      activeQuestionType: "general-system-design",
      currentPhase: "requirement_clarification",
    }),
    decideInterviewerAssumptionAuthorization({
      text: "You can make reasonable assumptions.",
      speaker: "them",
      activeQuestionType: "coding",
      currentPhase: "requirement_clarification",
    }),
    decideInterviewerAssumptionAuthorization({
      text: "You can make reasonable assumptions.",
      speaker: "them",
      activeQuestionType: "ai-ml-system-design",
      currentPhase: "design_framing",
    }),
    decideInterviewerAssumptionAuthorization({
      text: "You can make reasonable assumptions.",
      speaker: "them",
      activeQuestionType: "ai-ml-system-design",
      currentPhase: "requirement_clarification",
      hasActiveChild: true,
    }),
  ]) {
    assert.equal(decision.state, "context-only");
    assert.equal(decision.whiteboardRevisionRequested, false);
  }

  assert.equal(
    decideInterviewerAssumptionAuthorization({
      text: "Please do not make any assumptions.",
      speaker: "them",
      activeQuestionType: "general-system-design",
      currentPhase: "requirement_clarification",
    }).state,
    "not-detected"
  );

  const blockedAfterSettlement = decidePlaybookPhaseProgression({
    questionType: "ai-ml-system-design",
    playbookId: "aiml_system_design",
    currentPhase: "requirement_clarification",
    phaseProgress: {},
    latestTurnText: "You can make reasonable assumptions.",
    relation: "followup-parent",
    phaseControlSettled: true,
  });
  assert.equal(
    blockedAfterSettlement.phase,
    "requirement_clarification"
  );
  assert.equal(blockedAfterSettlement.requirementsReady, false);
});

test("uses settled phase-control evidence instead of reparsing the advisor text", () => {
  const phaseControl = decideInterviewerAssumptionAuthorization({
    text: "You can make the hypothesis by yourself.",
    speaker: "them",
    activeQuestionType: "general-system-design",
    currentPhase: "requirement_clarification",
    sourceTurnId: "turn-assumption",
  }).phaseControl;
  assert.ok(phaseControl);

  const decision = decidePlaybookPhaseProgression({
    questionType: "general-system-design",
    playbookId: "general_system_design",
    currentPhase: "requirement_clarification",
    phaseProgress: {},
    latestTurnText: "Please continue.",
    relation: "followup-parent",
    phaseControl,
  });

  assert.equal(decision.phase, "design_framing");
  assert.equal(decision.action, "advance");
  assert.equal(decision.phaseCompletionSource, "explicit-assumptions");
  assert.ok(decision.requiredArtifacts.includes("whiteboard"));
  assert.equal(decision.phaseControl?.sourceTurnId, "turn-assumption");
});

test("routes general system design whiteboard requests to design framing", () => {
  const decision = decidePlaybookPhaseProgression({
    questionType: "general-system-design",
    playbookId: "general_system_design",
    currentPhase: "requirement_clarification",
    phaseProgress: { requirements: true },
    latestTurnText: "Can you write it down and show me the architecture layers?",
    relation: "followup-parent",
  });

  assert.equal(decision.phase, "design_framing");
  assert.equal(decision.phaseFrom, "requirement_clarification");
  assert.equal(decision.action, "advance");
  assert.ok(decision.flags.includes("whiteboard"));
  assert.ok(decision.flags.includes("architecture"));
  assert.match(formatPlaybookPhaseDecisionForPrompt(decision, undefined), /Whiteboard/);
});

test("does not treat a design request as completed requirement clarification", () => {
  const decision = decidePlaybookPhaseProgression({
    questionType: "general-system-design",
    playbookId: "general_system_design",
    currentPhase: "requirement_clarification",
    phaseProgress: {},
    latestTurnText: "Let's move into the high level architecture.",
    relation: "new-parent",
  });
  const progress = applyPlaybookPhaseDecisionToProgress(
    {},
    decision,
    decision.phase
  );

  assert.equal(decision.phase, "requirement_clarification");
  assert.equal(decision.phaseFrom, "requirement_clarification");
  assert.equal(decision.requirementsReady, false);
  assert.equal(decision.whiteboardProvisional, true);
  assert.equal(progress.requirement_clarification, undefined);
  assert.equal(progress.design_framing, undefined);
  assert.equal(progress.architecture, undefined);
  assert.equal(
    formatPlaybookPhaseDecisionForTrace(decision).playbookPhaseDecisionFrom,
    "requirement_clarification"
  );
});

test("advances general system design only with source-backed readiness", () => {
  const decision = decidePlaybookPhaseProgression({
    questionType: "general-system-design",
    playbookId: "general_system_design",
    currentPhase: "requirement_clarification",
    phaseProgress: {},
    latestTurnText:
      "Design a ticket booking app for 10 million daily users. Seats must never be double booked and p95 latency should stay under 300 ms.",
    relation: "new-parent",
    askFrame: "hypothetical-design",
  });
  const progress = applyPlaybookPhaseDecisionToProgress(
    {},
    decision,
    decision.phase
  );

  assert.equal(decision.phase, "design_framing");
  assert.equal(decision.requirementsReady, true);
  assert.equal(decision.phaseCompletionSource, "observed-evidence");
  assert.ok(
    decision.observedRequirementCategories?.includes("functional_scope")
  );
  assert.ok(decision.observedRequirementCategories?.includes("scale_qps"));
  assert.ok(
    decision.observedRequirementCategories?.includes("consistency_invariant")
  );
  assert.equal(progress.requirements, true);
  assert.equal(progress.requirement_clarification, true);
  assert.equal(progress.architecture, undefined);
});

test("advances AI/ML design when the interviewer authorizes assumptions", () => {
  const decision = decidePlaybookPhaseProgression({
    questionType: "ai-ml-system-design",
    playbookId: "aiml_system_design",
    currentPhase: "requirement_clarification",
    phaseProgress: {},
    latestTurnText:
      "Design a RAG assistant. Make reasonable assumptions and proceed.",
    relation: "new-parent",
    askFrame: "hypothetical-design",
  });

  assert.equal(decision.phase, "design_framing");
  assert.equal(decision.requirementsReady, true);
  assert.equal(decision.phaseCompletionSource, "explicit-assumptions");
  assert.equal(decision.whiteboardProvisional, false);
});

test("generated answer text cannot satisfy requirement readiness", () => {
  const decision = decidePlaybookPhaseProgression({
    questionType: "general-system-design",
    playbookId: "general_system_design",
    currentPhase: "requirement_clarification",
    phaseProgress: {},
    latestTurnText: "Design a food delivery app.",
    currentAnswer:
      "Assume 10 million users, strong consistency, and p95 under 200 ms.",
    relation: "new-parent",
    askFrame: "hypothetical-design",
  });

  assert.equal(decision.phase, "requirement_clarification");
  assert.equal(decision.requirementsReady, false);
  assert.deepEqual(decision.observedRequirementCategories, [
    "functional_scope",
  ]);
});

test("marks AI/ML metrics follow-up as evaluation metrics", () => {
  const decision = decidePlaybookPhaseProgression({
    questionType: "ai-ml-system-design",
    playbookId: "aiml_system_design",
    currentPhase: "design_framing",
    phaseProgress: { requirements: true, design_framing: true },
    latestTurnText:
      "What metrics and logs would you use to know whether the RAG system improved?",
    relation: "followup-parent",
  });

  assert.equal(decision.phase, "design_framing");
  assert.ok(decision.flags.includes("evaluation_metrics"));
  assert.ok(decision.flags.includes("data_retrieval_model_path"));
  assert.equal(
    formatPlaybookPhaseDecisionForTrace(decision).playbookPhaseDecisionAction,
    "advance"
  );
});

test("does not keep repeating requirements once requirements are complete", () => {
  const decision = decidePlaybookPhaseProgression({
    questionType: "general-system-design",
    playbookId: "general_system_design",
    currentPhase: "requirement_clarification",
    phaseProgress: { requirements: true },
    latestTurnText: "Let's discuss the matching service architecture.",
    relation: "resume-parent",
  });

  assert.equal(decision.phase, "design_framing");
  assert.equal(decision.action, "resume-parent");
});

test("child probes preserve the parent phase", () => {
  const decision = decidePlaybookPhaseProgression({
    questionType: "ai-ml-system-design",
    playbookId: "aiml_system_design",
    currentPhase: "design_framing",
    phaseProgress: { requirements: true, design_framing: true },
    latestTurnText: "Can you quickly explain HNSW?",
    relation: "child-probe",
    subtaskIntent: "concept-probe",
  });

  assert.equal(decision.phase, "design_framing");
  assert.equal(decision.action, "child-probe");

  const progress = applyPlaybookPhaseDecisionToProgress(
    { requirements: true, design_framing: true },
    decision,
    "design_framing"
  );
  assert.deepEqual(progress, { requirements: true, design_framing: true });
});

test("project deep dive records hard problem and tradeoff progress", () => {
  const decision = decidePlaybookPhaseProgression({
    questionType: "project-deep-dive",
    playbookId: "project_deep_dive",
    currentPhase: "project_narrative",
    phaseProgress: { project_narrative: true, project_context: true },
    latestTurnText:
      "What was the hardest technical challenge, and why did you choose that design alternative?",
    relation: "followup-parent",
  });

  assert.equal(decision.phase, "architecture_decision");
  assert.ok(decision.flags.includes("hard_problem"));
  assert.ok(decision.flags.includes("tradeoff_decision"));
  assert.equal(decision.flags.includes("tradeoffs_wrapup"), false);
});

test("keeps broad project words as evidence without advancing the phase", () => {
  for (const latestTurnText of [
    "What service did the project use?",
    "What problem did the customer describe?",
    "Why was this useful?",
  ]) {
    const decision = decidePlaybookPhaseProgression({
      questionType: "project-deep-dive",
      playbookId: "project_deep_dive",
      currentPhase: "project_narrative",
      phaseProgress: { project_narrative: true, project_context: true },
      latestTurnText,
      relation: "followup-parent",
    });

    assert.equal(decision.phase, "project_narrative", latestTurnText);
    assert.equal(decision.action, "stay", latestTurnText);
  }
});

test("project deep dive advances through evidence-led phases without regressing", () => {
  const validation = decidePlaybookPhaseProgression({
    questionType: "project-deep-dive",
    playbookId: "project_deep_dive",
    currentPhase: "architecture_decision",
    phaseProgress: {
      project_narrative: true,
      architecture_decision: true,
    },
    latestTurnText:
      "What failed during rollout, and how did you debug and validate the recovery?",
    relation: "followup-parent",
  });
  const nonRegressing = decidePlaybookPhaseProgression({
    questionType: "project-deep-dive",
    playbookId: "project_deep_dive",
    currentPhase: "validation_reliability",
    phaseProgress: {
      project_narrative: true,
      architecture_decision: true,
      validation_reliability: true,
    },
    latestTurnText: "Why did you choose that architecture?",
    relation: "followup-parent",
  });
  const impact = decidePlaybookPhaseProgression({
    questionType: "project-deep-dive",
    playbookId: "project_deep_dive",
    currentPhase: "validation_reliability",
    phaseProgress: {
      project_narrative: true,
      architecture_decision: true,
      validation_reliability: true,
    },
    latestTurnText:
      "What was the impact, what did you learn, and what would you improve next?",
    relation: "followup-parent",
  });

  assert.equal(validation.phase, "validation_reliability");
  assert.equal(nonRegressing.phase, "validation_reliability");
  assert.equal(impact.phase, "impact_lessons");
});

test("manual next walks project deep dive through four coarse phases", () => {
  const makeTask = (
    phase:
      | "project_narrative"
      | "architecture_decision"
      | "validation_reliability"
      | "impact_lessons"
  ) => ({
    id: "task-project",
    runtimeRevision: 1,
    source: "voice" as const,
    parent: {
      id: "parent-project",
      questionType: "project-deep-dive" as const,
      topic: "Agentic Memory",
      playbookPhase: phase,
      phaseProgress: { [phase]: true },
      supportedFactAnchors: [],
      createdAt: 1,
      updatedAt: 1,
    },
  });

  const architecture = decideManualNextPhaseTransition(
    makeTask("project_narrative")
  );
  const validation = decideManualNextPhaseTransition(
    makeTask("architecture_decision")
  );
  const impact = decideManualNextPhaseTransition(
    makeTask("validation_reliability")
  );
  const terminal = decideManualNextPhaseTransition(
    makeTask("impact_lessons")
  );

  assert.equal(architecture.phase, "architecture_decision");
  assert.ok(architecture.flags.includes("tradeoff_decision"));
  assert.equal(validation.phase, "validation_reliability");
  assert.ok(validation.flags.includes("validation_debugging"));
  assert.equal(impact.phase, "impact_lessons");
  assert.ok(impact.flags.includes("impact_lesson"));
  assert.equal(terminal.phase, "impact_lessons");
});

test("manual next deterministically advances general system design to whiteboard", () => {
  const decision = decideManualNextPhaseTransition({
    id: "task_1",
    runtimeRevision: 1,
    source: "voice",
    parent: {
      id: "parent_1",
      questionType: "general-system-design",
      topic: "Design an Uber-like app",
      playbookPhase: "requirement_clarification",
      phaseProgress: { requirements: true },
      supportedFactAnchors: [],
      createdAt: 1,
      updatedAt: 1,
    },
  });

  assert.equal(decision.source, "manual-next");
  assert.equal(decision.action, "advance");
  assert.equal(decision.phase, "design_framing");
  assert.equal(decision.targetArtifact, "whiteboard");
  assert.equal(decision.manualPhaseFrom, "requirement_clarification");
  assert.equal(decision.manualPhaseTo, "design_framing");
  assert.ok(decision.flags.includes("whiteboard"));
  assert.ok(decision.flags.includes("scale_qps"));
  assert.match(
    formatPlaybookPhaseDecisionForPrompt(decision, undefined),
    /manual-next/
  );
});

test("manual next advances AI/ML design without restarting requirements", () => {
  const decision = decideManualNextPhaseTransition({
    id: "task_2",
    runtimeRevision: 1,
    source: "mixed",
    parent: {
      id: "parent_2",
      questionType: "ai-ml-system-design",
      topic: "RAG trip planner",
      playbookPhase: "design_framing",
      phaseProgress: {
        requirements: true,
        design_framing: true,
        data_retrieval_model_path: true,
      },
      supportedFactAnchors: [],
      createdAt: 1,
      updatedAt: 1,
    },
  });

  assert.equal(decision.phase, "design_framing");
  assert.equal(decision.targetArtifact, "whiteboard");
  assert.ok(decision.flags.includes("evaluation_metrics"));
  assert.ok(decision.flags.includes("latency_cost_safety"));
  assert.deepEqual(
    formatPlaybookPhaseDecisionForTrace(decision).manualPhaseGuardStatus,
    "advanced"
  );
});

test("manual next is blocked without an active task", () => {
  const decision = decideManualNextPhaseTransition(undefined);

  assert.equal(decision.action, "stay");
  assert.equal(decision.guardStatus, "blocked-no-parent");
  assert.equal(decision.targetArtifact, "none");
});

test("starts a coding parent with a novice-facing answer-only baseline", () => {
  const decision = decidePlaybookPhaseProgression({
    questionType: "coding",
    playbookId: "coding_algorithm",
    latestTurnText:
      "Given an array of integers, return the maximum sum of a contiguous subarray.",
    relation: "new-parent",
    freshParentCreated: true,
  });

  assert.equal(decision.phase, "baseline_reasoning");
  assert.equal(decision.action, "advance");
  assert.ok(decision.flags.includes("baseline_solution"));
  assert.deepEqual(decision.requiredArtifacts, ["answer"]);
  assert.match(
    formatPlaybookPhaseDecisionForPrompt(decision, undefined),
    /no programming background/i
  );
});

test("generic implement wording cannot skip a new coding parent baseline", () => {
  const decision = decidePlaybookPhaseProgression({
    questionType: "coding",
    playbookId: "coding_algorithm",
    latestTurnText: "Implement Dasher Payout Calculation.",
    currentQuestion: "Implement Dasher Payout Calculation.",
    relation: "new-parent",
    subtaskIntent: "implementation-probe",
    freshParentCreated: true,
  });

  assert.equal(decision.phase, "baseline_reasoning");
  assert.equal(decision.action, "advance");
  assert.ok(decision.flags.includes("baseline_solution"));
  assert.ok(!decision.flags.includes("implementation"));
  assert.deepEqual(decision.requiredArtifacts, ["answer"]);
  assert.match(decision.reason, /initial-coding-parent-baseline-authority/);
});

test("retains an implementation phase for a revision-stable coding origin", () => {
  const state = resolvePlaybookState({
    questionType: "coding",
    playbookId: "coding_algorithm",
    phase: "implementation_validation",
  });
  const decision = decidePlaybookPhaseProgression({
    questionType: "coding",
    playbookId: "coding_algorithm",
    currentPhase: state.phase,
    phaseProgress: {
      baseline_reasoning: true,
      optimized_pseudocode: true,
      implementation_validation: true,
    },
    latestTurnText: "Use OrderedDict instead of OrderDict in the implementation.",
    currentQuestion: "Use OrderedDict instead of OrderDict in the implementation.",
    relation: "new-parent",
    subtaskIntent: "implementation-probe",
    freshParentCreated: false,
  });

  assert.equal(state.initializedFromStart, false);
  assert.equal(state.phaseCompatible, true);
  assert.equal(decision.phase, "implementation_validation");
  assert.ok(decision.flags.includes("implementation"));
  assert.ok(!decision.flags.includes("baseline_solution"));
  assert.equal(
    formatPlaybookPhaseDecisionForTrace(decision)
      .playbookFreshParentCreated,
    false
  );
});

test("composes Screen phase from lifecycle authority instead of topology relation", () => {
  const retained = composeScreenPlaybookPhaseInput({
    catalogPhase: "baseline_reasoning",
    committedPhase: "implementation_validation",
    committedProgress: {
      baseline_reasoning: true,
      optimized_pseudocode: true,
    },
    freshParentCreated: false,
    currentOnly: false,
  });
  assert.deepEqual(retained, {
    currentPhase: "implementation_validation",
    phaseProgress: {
      baseline_reasoning: true,
      optimized_pseudocode: true,
    },
    freshParentCreated: false,
  });

  const created = composeScreenPlaybookPhaseInput({
    catalogPhase: "baseline_reasoning",
    committedPhase: "implementation_validation",
    committedProgress: { baseline_reasoning: true },
    freshParentCreated: true,
    currentOnly: false,
  });
  assert.deepEqual(created, {
    currentPhase: "baseline_reasoning",
    phaseProgress: undefined,
    freshParentCreated: true,
  });

  const currentOnly = composeScreenPlaybookPhaseInput({
    catalogPhase: "requirement_clarification",
    committedPhase: "implementation_validation",
    committedProgress: { implementation_validation: true },
    freshParentCreated: false,
    currentOnly: true,
  });
  assert.deepEqual(currentOnly, {
    currentPhase: "requirement_clarification",
    phaseProgress: undefined,
    freshParentCreated: false,
  });
});

test("reuses a committed Screen transition decision without advancing twice", () => {
  const committed = composeScreenPlaybookPhaseAfterLifecycle({
    catalogPhase: "requirement_clarification",
    committedPhase: "design_framing",
    committedProgress: {
      requirement_clarification: true,
      requirements: true,
    },
    transitionSeedPhase: "requirement_clarification",
    transitionSeedProgress: { requirement_clarification: true },
    freshParentCreated: false,
    currentOnly: false,
    taskRuntimeTransitionCommitted: true,
  });
  assert.deepEqual(committed, {
    currentPhase: "design_framing",
    phaseProgress: {
      requirement_clarification: true,
      requirements: true,
    },
    freshParentCreated: false,
    reuseTransitionSeedDecision: true,
  });

  const currentOnly = composeScreenPlaybookPhaseAfterLifecycle({
    catalogPhase: "requirement_clarification",
    committedPhase: "implementation_validation",
    committedProgress: { implementation_validation: true },
    transitionSeedPhase: "implementation_validation",
    freshParentCreated: false,
    currentOnly: true,
    taskRuntimeTransitionCommitted: false,
  });
  assert.deepEqual(currentOnly, {
    currentPhase: "requirement_clarification",
    phaseProgress: undefined,
    freshParentCreated: false,
    reuseTransitionSeedDecision: false,
  });
});

test("initializes a playbook from the catalog only when phase is absent", () => {
  const initialized = resolvePlaybookState({
    questionType: "coding",
    playbookId: "coding_algorithm",
  });
  const retained = resolvePlaybookState({
    questionType: "project-deep-dive",
    playbookId: "project_deep_dive",
    phase: "validation_reliability",
  });

  assert.deepEqual(initialized, {
    phase: "baseline_reasoning",
    initializedFromStart: true,
    phaseCompatible: true,
  });
  assert.deepEqual(retained, {
    phase: "validation_reliability",
    initializedFromStart: false,
    phaseCompatible: true,
  });
});

test("fails closed when a committed phase belongs to another playbook", () => {
  const state = resolvePlaybookState({
    questionType: "coding",
    playbookId: "coding_algorithm",
    phase: "design_framing",
  });
  const decision = decidePlaybookPhaseProgression({
    questionType: "coding",
    playbookId: "coding_algorithm",
    currentPhase: state.phase,
    latestTurnText: "Continue with the implementation.",
    relation: "followup-parent",
  });

  assert.equal(state.phaseCompatible, false);
  assert.equal(decision.phase, "design_framing");
  assert.equal(decision.action, "stay");
  assert.deepEqual(decision.flags, []);
  assert.equal(
    decision.phaseAdvanceBlockedReason,
    "incompatible-committed-phase"
  );
  assert.equal(
    formatPlaybookPhaseDecisionForTrace(decision)
      .playbookPhaseStateCompatible,
    false
  );
});

test("coding baseline clarifies callable contracts without adding a question subtype", () => {
  const contract = formatCodingPlaybookPhaseContract("baseline_reasoning");

  assert.match(contract, /up to three high-yield clarification questions/);
  assert.match(contract, /input\/output shape/);
  assert.match(contract, /request, response, status\/error behavior/);
  assert.match(contract, /without treating them as a separate question type/);
  assert.match(contract, /no programming or algorithm background/);
  assert.match(contract, /Do not emit Code or Complexity/);
  assert.match(contract, /state concise, revisable assumptions/);
});

test("keeps optimized pseudocode in Approach without granting Code authority", () => {
  const contract = formatCodingPlaybookPhaseContract("optimized_pseudocode");

  assert.match(contract, /pseudocode in Approach/);
  assert.match(contract, /fenced text block or ordered steps/);
  assert.match(contract, /Do not emit Code/);
});

test("advances coding from baseline to optimized pseudocode on an optimization ask", () => {
  const decision = decidePlaybookPhaseProgression({
    questionType: "coding",
    playbookId: "coding_algorithm",
    currentPhase: "baseline_reasoning",
    phaseProgress: { baseline_reasoning: true },
    latestTurnText:
      "Can you optimize this to improve the time complexity and dry run it?",
    relation: "followup-parent",
    subtaskIntent: "complexity-probe",
  });

  assert.equal(decision.phase, "optimized_pseudocode");
  assert.equal(decision.action, "advance");
  assert.ok(decision.flags.includes("optimized_algorithm"));
  assert.ok(decision.flags.includes("pseudocode_dry_run"));
  assert.deepEqual(decision.requiredArtifacts, ["answer", "complexity"]);
});

test("advances coding to implementation only on an explicit implementation ask", () => {
  const decision = decidePlaybookPhaseProgression({
    questionType: "coding",
    playbookId: "coding_algorithm",
    currentPhase: "optimized_pseudocode",
    phaseProgress: {
      baseline_reasoning: true,
      optimized_pseudocode: true,
    },
    latestTurnText: "Now implement the complete solution in Java.",
    relation: "followup-parent",
    subtaskIntent: "implementation-probe",
  });

  assert.equal(decision.phase, "implementation_validation");
  assert.equal(decision.action, "advance");
  assert.ok(decision.flags.includes("implementation"));
  assert.deepEqual(decision.requiredArtifacts, [
    "answer",
    "code",
    "complexity",
  ]);
});

test("manual next walks coding through three coarse stages without a fourth phase", () => {
  const baseline = decideManualNextPhaseTransition({
    id: "task-coding",
    runtimeRevision: 1,
    source: "voice",
    parent: {
      id: "parent-coding",
      questionType: "coding",
      topic: "Sliding window maximum",
      playbookPhase: "baseline_reasoning",
      phaseProgress: { baseline_reasoning: true },
      supportedFactAnchors: [],
      createdAt: 1,
      updatedAt: 1,
    },
  });
  const optimized = decideManualNextPhaseTransition({
    id: "task-coding",
    runtimeRevision: 2,
    source: "voice",
    parent: {
      id: "parent-coding",
      questionType: "coding",
      topic: "Sliding window maximum",
      playbookPhase: "optimized_pseudocode",
      phaseProgress: {
        baseline_reasoning: true,
        optimized_pseudocode: true,
      },
      supportedFactAnchors: [],
      createdAt: 1,
      updatedAt: 2,
    },
  });
  const implementation = decideManualNextPhaseTransition({
    id: "task-coding",
    runtimeRevision: 3,
    source: "voice",
    parent: {
      id: "parent-coding",
      questionType: "coding",
      topic: "Sliding window maximum",
      playbookPhase: "implementation_validation",
      phaseProgress: {
        baseline_reasoning: true,
        optimized_pseudocode: true,
        implementation_validation: true,
      },
      supportedFactAnchors: [],
      createdAt: 1,
      updatedAt: 3,
    },
  });

  assert.equal(baseline.phase, "optimized_pseudocode");
  assert.equal(baseline.targetArtifact, "answer");
  assert.equal(optimized.phase, "implementation_validation");
  assert.equal(optimized.targetArtifact, "code");
  assert.equal(implementation.phase, "implementation_validation");
  assert.equal(implementation.targetArtifact, "code");
});

test("coding child probes preserve the parent coding phase", () => {
  const decision = decidePlaybookPhaseProgression({
    questionType: "coding",
    playbookId: "coding_algorithm",
    currentPhase: "optimized_pseudocode",
    phaseProgress: {
      baseline_reasoning: true,
      optimized_pseudocode: true,
    },
    latestTurnText: "What is the space complexity of the deque?",
    relation: "child-probe",
    subtaskIntent: "complexity-probe",
  });

  assert.equal(decision.phase, "optimized_pseudocode");
  assert.equal(decision.action, "child-probe");
  assert.deepEqual(decision.requiredArtifacts, ["answer", "complexity"]);
});
