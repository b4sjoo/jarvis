import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPlaybookPhaseDecisionToProgress,
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
  assert.equal(decision.action, "advance");
  assert.ok(decision.flags.includes("whiteboard"));
  assert.ok(decision.flags.includes("architecture"));
  assert.match(formatPlaybookPhaseDecisionForPrompt(decision, undefined), /Whiteboard/);
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
