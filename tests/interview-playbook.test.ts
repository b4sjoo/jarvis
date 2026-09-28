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
    /requiredArtifacts: answer/
  );
  assert.match(
    formatInterviewPlaybookForPrompt(playbook),
    /no programming or algorithm background/i
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
    /Do not emit Code in this phase/i
  );
  assert.match(
    formatInterviewPlaybookForPrompt(implementation),
    /requiredArtifacts: answer, code, complexity/
  );
  assert.match(
    formatInterviewPlaybookForPrompt(implementation),
    /complete runnable implementation/
  );
  assert.match(
    formatInterviewPlaybookForPrompt(implementation),
    /Scope rule: distinguish current required behavior from optional extensions/i
  );
  assert.match(
    formatInterviewPlaybookForPrompt(implementation),
    /Do not add concurrency, locks, retries, caching/i
  );
  assert.match(
    formatInterviewPlaybookForPrompt(implementation),
    /single-file answer self-contained/i
  );
  assert.match(
    formatInterviewPlaybookForPrompt(implementation),
    /implementation as the test target/i
  );
  assert.match(
    formatInterviewPlaybookForPrompt(implementation),
    /Do not silently change the implementation or expected result/i
  );
  assert.match(
    formatInterviewPlaybookForPrompt(implementation),
    /explicitly asks to debug, repair, or satisfy a changed constraint/i
  );
  assert.match(
    formatInterviewPlaybookForPrompt(implementation),
    /Derive each supplied example from its exact input, operation order, and state/i
  );
});

test("changes project deep-dive guidance with the committed phase", () => {
  const summary = selectInterviewPlaybook({
    query: "Tell me about your Agentic Memory project.",
    questionType: "project-deep-dive",
  });
  const qa = withInterviewPlaybookPhase(summary, "project_QA");

  assert.equal(summary?.phase, "project_summary");
  assert.match(
    formatInterviewPlaybookForPrompt(summary),
    /speakable 3-5 minute project introduction/
  );
  assert.match(
    formatInterviewPlaybookForPrompt(summary),
    /four parts inside the existing Answer section/i
  );
  assert.match(
    formatInterviewPlaybookForPrompt(summary),
    /explicit technical question directly, even on the first LQU/i
  );
  assert.match(
    formatInterviewPlaybookForPrompt(qa),
    /In project_QA, directly answer the current question/
  );
  assert.match(
    formatInterviewPlaybookForPrompt(qa),
    /explicitly requested overview or retrospective is still a valid current answer/i
  );
  assert.match(
    formatInterviewPlaybookForPrompt(qa),
    /Manual Next\/Back phase-continuation intent takes priority/
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
