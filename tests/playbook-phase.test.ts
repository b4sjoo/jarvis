import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPlaybookPhaseDecisionToProgress,
  decideManualNextPhaseTransition,
  decidePlaybookPhaseProgression,
  formatPlaybookPhaseDecisionForPrompt,
  formatPlaybookPhaseDecisionForTrace,
} from "../src/lib/meeting/playbook-phase.js";

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

  assert.equal(decision.phase, "project_narrative");
  assert.ok(decision.flags.includes("hard_problem"));
  assert.ok(decision.flags.includes("tradeoff_decision"));
  assert.ok(decision.flags.includes("tradeoffs_wrapup"));
});

test("manual next deterministically advances general system design to whiteboard", () => {
  const decision = decideManualNextPhaseTransition({
    id: "task_1",
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
