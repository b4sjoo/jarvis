import assert from "node:assert/strict";
import test from "node:test";
import {
  formatInterviewPlaybookForPrompt,
  selectInterviewPlaybook,
  withInterviewPlaybookPhase,
} from "../src/lib/meeting/interview-playbook.js";

test("selects the spoken baseline as the initial coding phase", () => {
  const playbook = selectInterviewPlaybook({
    query: "Find the maximum value in every sliding window.",
    questionType: "coding",
  });

  assert.equal(playbook?.id, "coding_algorithm");
  assert.equal(playbook?.phase, "baseline_reasoning");
  assert.match(
    formatInterviewPlaybookForPrompt(playbook),
    /requiredArtifacts: answer, code, complexity/
  );
  assert.match(
    formatInterviewPlaybookForPrompt(playbook),
    /do not optimize prematurely/i
  );
});

test("selects the concept playbook for a standalone Field Knowledge parent", () => {
  const playbook = selectInterviewPlaybook({
    query: "How does HNSW efSearch affect recall and latency?",
    questionType: "field-knowledge",
  });

  assert.equal(playbook?.id, "aiml_field_knowledge");
  assert.equal(playbook?.phase, "concept_explanation");
});

test("changes the coding output contract with the committed phase", () => {
  const baseline = selectInterviewPlaybook({
    query: "Implement insertion sort for a linked list.",
    questionType: "coding",
  });
  const optimized = withInterviewPlaybookPhase(
    baseline,
    "optimized_pseudocode"
  );
  const implementation = withInterviewPlaybookPhase(
    baseline,
    "implementation_validation"
  );

  assert.match(
    formatInterviewPlaybookForPrompt(optimized),
    /Preserve the existing baseline Code artifact/
  );
  assert.match(
    formatInterviewPlaybookForPrompt(implementation),
    /requiredArtifacts: answer, code, complexity/
  );
  assert.match(
    formatInterviewPlaybookForPrompt(implementation),
    /complete runnable implementation/
  );
});

test("changes project deep-dive guidance with the committed phase", () => {
  const narrative = selectInterviewPlaybook({
    query: "Tell me about your Agentic Memory project.",
    questionType: "project-deep-dive",
  });
  const architecture = withInterviewPlaybookPhase(
    narrative,
    "architecture_decision"
  );
  const validation = withInterviewPlaybookPhase(
    narrative,
    "validation_reliability"
  );
  const impact = withInterviewPlaybookPhase(narrative, "impact_lessons");

  assert.match(
    formatInterviewPlaybookForPrompt(narrative),
    /30-45 second spoken introduction/
  );
  assert.match(
    formatInterviewPlaybookForPrompt(architecture),
    /viable alternatives/
  );
  assert.match(
    formatInterviewPlaybookForPrompt(validation),
    /tests, traces, rollout checks/
  );
  assert.match(
    formatInterviewPlaybookForPrompt(impact),
    /known limitations/
  );
});

test("an explicit unknown settlement cannot be reclassified by query or Brief", () => {
  const playbook = selectInterviewPlaybook({
    query: "Please implement a queue.",
    questionType: "unknown",
    interviewSessionBrief: {
      targetCompany: "",
      companyLocked: false,
      interviewTypes: ["coding"],
    },
  });

  assert.equal(playbook, undefined);
});

test("a compatible active Playbook keeps its committed phase", () => {
  const initial = selectInterviewPlaybook({
    questionType: "general-system-design",
  });
  const advanced = withInterviewPlaybookPhase(initial, "design_framing");
  const selected = selectInterviewPlaybook({
    questionType: "general-system-design",
    activeTaskPlaybook: advanced,
  });

  assert.equal(selected?.id, "general_system_design");
  assert.equal(selected?.phase, "design_framing");
});
