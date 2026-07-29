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
    /requiredArtifacts: answer, complexity/
  );
  assert.match(
    formatInterviewPlaybookForPrompt(playbook),
    /Do not optimize prematurely/
  );
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
    /Do not emit a full Code section/
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
