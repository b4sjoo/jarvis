import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildAdvisorSystemPrompt } from "../src/lib/meeting/advisor-prompt.js";
import {
  buildFactAnchorDecision,
  formatFactAnchorDecisionForPrompt,
  PROJECT_FACT_RESPONSE_BOUNDARY,
} from "../src/lib/meeting/fact-anchor-guardrail.js";

test("PD7 prompt separates actual experience from independent analysis", () => {
  const prompt = buildAdvisorSystemPrompt();
  assert.ok(prompt.includes(PROJECT_FACT_RESPONSE_BOUNDARY));
  assert.match(prompt, /Never replace a requested real experience with a hypothetical project/);
  assert.match(prompt, /Missing retrieved evidence does not prove the candidate did not do the work/);
  assert.match(prompt, /Answer independent product-sense, tradeoff and hypothetical questions directly/);
  assert.match(prompt, /Project selection proves identity, not every claim/);
  assert.match(prompt, /Only explicit evidence of absence supports a negative factual claim/);
  assert.match(prompt, /an empty candidate list does not authorize inventing projects/);
  assert.match(prompt, /Evidence limits take priority over Summary duration/);
  assert.match(prompt, /cite only the listed supported anchor IDs/);
});

test("narrative evidence metadata cannot command the whole answer while personal-status authority is preserved", () => {
  for (const questionType of ["project-deep-dive", "behavioral"] as const) {
    const decision = buildFactAnchorDecision({
      questionType, questionText: "Tell me about your own work and responsibilities.",
      personalEvidenceGuardrailMode: "enforcement",
    });
    assert.doesNotMatch(formatFactAnchorDecisionForPrompt(decision), /Classifier-independent rule: enforce Action/);
  }
  const personal = buildFactAnchorDecision({
    questionType: "unknown", questionText: "Are you authorized to work in the United States?",
    personalEvidenceGuardrailMode: "enforcement",
  });
  assert.equal(personal.requiredFor, "personal-logistics");
  assert.match(formatFactAnchorDecisionForPrompt(personal), /Classifier-independent rule: enforce Action/);
});

test("PD7 missing PDD facts carry the same bounded response contract without changing enforcement", () => {
  for (const mode of ["shadow", "enforcement"] as const) {
    const decision = buildFactAnchorDecision({
      questionType: "project-deep-dive",
      questionText: "Tell me about your project and your personal contributions.",
      personalEvidenceGuardrailMode: mode,
    });
    assert.equal(decision.requiredFor, "project-deep-dive");
    assert.equal(decision.state, "no-anchor");
    assert.equal(decision.action, "answer-with-caveats");
    assert.equal(decision.personalEvidence.mode, mode);
    assert.ok(formatFactAnchorDecisionForPrompt(decision).includes(PROJECT_FACT_RESPONSE_BOUNDARY));
  }
});

test("Screen consumes the same project fact boundary constant", () => {
  const source = readFileSync("src/lib/meeting/screen-observation.service.ts", "utf8");
  assert.match(source, /import \{[^}]*PROJECT_FACT_RESPONSE_BOUNDARY[^}]*\} from "\.\/fact-anchor-guardrail"/);
  assert.match(source, /exclusive source identity[\s\S]*?PROJECT_FACT_RESPONSE_BOUNDARY,/);
});
