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
  assert.match(prompt, /never replace a real experience with generic first-person claims/);
  assert.match(prompt, /Missing retrieved evidence does not prove the candidate did not do the work/);
  assert.match(prompt, /Answer independent product-sense, tradeoff and hypothetical questions directly/);
  assert.match(prompt, /Project selection proves identity, not every claim/);
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
