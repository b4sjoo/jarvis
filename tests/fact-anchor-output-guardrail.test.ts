import assert from "node:assert/strict";
import test from "node:test";
import {
  enforceFactAnchorOutput,
  formatFactAnchorOutputDecisionForTrace,
  projectFactAnchorStreamingPartial,
  shouldBufferFactAnchorStreaming,
} from "../src/lib/meeting/fact-anchor-output-guardrail.js";
import { parseMeetingAnswer, resolveMeetingAnswerProfile } from "../src/lib/meeting/meeting-answer.js";
import { buildFactAnchorDecision } from "../src/lib/meeting/fact-anchor-guardrail.js";
import type { FactAnchorDecision } from "../src/lib/meeting/types.js";

function makeDecision(overrides: Partial<FactAnchorDecision> = {}): FactAnchorDecision {
  return {
    state: "strong-anchor", requiredFor: "project-deep-dive",
    supportedAnchorIds: ["mem_parser"], supportedAnchorTitles: ["Parser"],
    selectedAnchorId: "mem_parser", action: "answer-with-anchor",
    personalEvidence: {
      requirement: "autobiographical-project", confidence: 1, confidenceTier: "high",
      signals: [], counterSignals: [], allowedEvidenceSources: [],
      mode: "enforcement", enforced: true,
    },
    selectedPersonalEvidenceSources: [], unsupportedClaimRisk: "guarded",
    claimSupportDecisions: [{
      claimId: "claim:parser", predicateFamily: "architecture-decision",
      anchorId: "mem_parser", projectCompatible: true, predicateCompatible: true,
      supportSpanPresent: true, supportSpan: "We used NDJSON request framing and reported failures per item.",
      conflictFree: true, decision: "allow", reason: "test-evidence",
    }],
    ...overrides,
  };
}

for (const requiredFor of ["project-deep-dive", "behavioral"] as const) {
  test(`${requiredFor}: preserves natural-language paraphrases and local evidence limits`, () => {
    const parsed = parseMeetingAnswer(`中文思路: 材料支持逐项错误处理，但没有这次追问的延迟指标。
Answer: With line-delimited requests, a failed item remains distinguishable from successful work. I would measure latency before quantifying any improvement.
Approach: Explain the failure boundary, then distinguish a proposed measurement from an observed result.
Answer disposition: bounded-with-caveat
Supporting anchor IDs: mem_parser`);
    const result = enforceFactAnchorOutput({ decision: makeDecision({ requiredFor }), parsedAnswer: parsed });
    assert.equal(result.effectiveContent, parsed.rawContent);
    assert.deepEqual(result.effectiveAnswer.sections, parsed.sections);
    assert.equal(result.reason, "citation-contract-checked");
    assert.equal(result.sanitizedClaimCount, 0);
    assert.equal(result.visibleNotice, undefined);
    assert.equal(result.bilingualClaimSetCoherent, undefined);
    const trace = formatFactAnchorOutputDecisionForTrace(result);
    assert.equal(trace.factAnchorSemanticVerificationPerformed, false);
    assert.equal(trace.wholeAnswerReplacementCount, 0);
    assert.equal(trace.unsupportedFirstPersonHardClaimCount, undefined);
    assert.equal(trace.unsupportedAssertiveFactClaimCount, undefined);
    assert.equal(trace.sanitizedHardClaimCount, undefined);
  });
}

test("filters disallowed citations without rewriting sections or claiming a caveat was added", () => {
  for (const ids of ["mem_parser, mem_old_project, mem_guidance", "mem_old_project"]) {
    const parsed = parseMeetingAnswer(`Answer: The item-level boundary makes the partial failure actionable.
Approach: Discuss the boundary.
Answer disposition: factual-with-anchor
Supporting anchor IDs: ${ids}`);
    const result = enforceFactAnchorOutput({ decision: makeDecision(), parsedAnswer: parsed });
    assert.equal(result.commitSource, "sanitized-model-output");
    assert.equal(result.reason, "unsupported-anchor-id");
    assert.deepEqual(result.effectiveAnswer.sections, parsed.sections);
    assert.equal(result.effectiveAnswer.answerDisposition, parsed.answerDisposition);
    assert.deepEqual(result.effectiveAnswer.supportingAnchorIds, ids.startsWith("mem_parser") ? ["mem_parser"] : []);
    assert.doesNotMatch(result.effectiveContent, /mem_old_project|mem_guidance/);
    assert.equal(result.effectiveAnswer.rawContent, result.effectiveContent);
    assert.equal(result.sanitizedClaimCount, 0);
    assert.deepEqual(result.sanitizedSections, ["supportingAnchorIds"]);
    const trace = formatFactAnchorOutputDecisionForTrace(result);
    assert.equal(trace.factAnchorClaimSanitizationApplied, false);
    assert.equal(trace.factAnchorRemovedCitationCount, result.unsupportedAnchorIds.length);
    assert.equal(trace.boundedSynthesisCommitCount, 0);
    assert.equal(trace.wholeAnswerReplacementCount, 0);
    assert.equal(trace.factAnchorSemanticVerificationPerformed, false);
  }
});

test("no project evidence preserves a necessary clarification without inventing an answer", () => {
  const decision = buildFactAnchorDecision({
    questionType: "project-deep-dive", questionText: "Choose a project and describe your personal contributions.",
    personalEvidenceGuardrailMode: "enforcement",
  });
  assert.equal(decision.state, "no-anchor");
  const parsed = parseMeetingAnswer(`Clarifying question: Which actual project should we discuss?
Answer disposition: clarification
Supporting anchor IDs: -`);
  const result = enforceFactAnchorOutput({ decision, parsedAnswer: parsed });
  assert.equal(result.effectiveContent, parsed.rawContent);
  assert.equal(result.effectiveAnswer.sections.answer, undefined);
  assert.equal(result.visibleNotice, undefined);
  assert.equal(result.fallbackMode, undefined);
});

test("missing output metadata does not authorize a replacement project introduction", () => {
  const parsed = parseMeetingAnswer("Answer: Isolating per-item errors lets us identify which records need attention.");
  const result = enforceFactAnchorOutput({ decision: makeDecision(), parsedAnswer: parsed });
  assert.equal(result.effectiveContent, parsed.rawContent);
  assert.equal(result.effectiveAnswer.answerDisposition, undefined);
  assert.doesNotMatch(result.effectiveContent, /We used NDJSON request framing/);
});

test("does not use a model clarification label or wording as an evidence authority", () => {
  const parsed = parseMeetingAnswer(`Answer: We implemented a retry pipeline.
Clarifying question: Should we discuss this pipeline or its dead-letter queue?
Clarifying options: Retry pipeline | Dead-letter queue
Answer disposition: clarification
Supporting anchor IDs: mem_old_project`);
  const result = enforceFactAnchorOutput({ decision: makeDecision(), parsedAnswer: parsed });
  assert.deepEqual(result.effectiveAnswer.sections, parsed.sections);
  assert.deepEqual(result.effectiveAnswer.supportingAnchorIds, []);
  assert.equal(result.visibleNotice, undefined);
  assert.equal(formatFactAnchorOutputDecisionForTrace(result).factAnchorSemanticVerificationPerformed, false);
  // Actual project-choice authority still belongs to the separate trusted directory/selector.
});

// These remain negative semantic examples. Passing here proves only the removal
// of lexical rewriting, never that the unsupported statements became factual.
const semanticRiskCases = [
  { name: "unsupported retry mechanism", text: "We implemented exponential backoff with jitter, rebatching, and a dead-letter queue." },
  { name: "unsupported measured result", text: "I reduced latency by 40% for our first customer." },
  { name: "evidence-of-absence error", text: "We never measured latency and had no commercial customers." },
  { name: "absolute guarantee", text: "The persisted data is never lost and every request succeeds." },
  { name: "unsupported teammate stance", text: "My teammate wanted to skip testing, but I pushed for manual sampling." },
  { name: "unrequested hypothetical experience", text: "As a hypothetical project, my team built a high-concurrency backend service." },
];
for (const { name, text } of semanticRiskCases) {
  test(`quality risk remains observable, not certified: ${name}`, () => {
    for (const requiredFor of ["project-deep-dive", "behavioral"] as const) {
      const parsed = parseMeetingAnswer(`Answer: ${text}\nAnswer disposition: factual-with-anchor\nSupporting anchor IDs: mem_parser`);
      const result = enforceFactAnchorOutput({ decision: makeDecision({ requiredFor }), parsedAnswer: parsed });
      assert.equal(result.effectiveContent, parsed.rawContent);
      assert.equal(formatFactAnchorOutputDecisionForTrace(result).factAnchorSemanticVerificationPerformed, false);
      assert.equal(result.bilingualClaimSetCoherent, undefined);
    }
  });
}

test("explicit negative evidence is preserved without claiming automatic entailment proof", () => {
  const decision = makeDecision();
  decision.claimSupportDecisions[0].supportSpan = "We did not deploy the optional retry queue.";
  const parsed = parseMeetingAnswer(`中文思路: 材料明确说明未部署可选重试队列。
Answer: We did not deploy the optional retry queue.
Answer disposition: factual-with-anchor
Supporting anchor IDs: mem_parser`);
  const result = enforceFactAnchorOutput({ decision, parsedAnswer: parsed });
  assert.equal(result.effectiveContent, parsed.rawContent);
  assert.equal(result.boundaryClaimPreservedCount, undefined);
});

test("empty and partial generation stay with the generation contract", () => {
  for (const value of ["-", "中文思路: 先确认问题。\nAnswer:"]) {
    const parsed = parseMeetingAnswer(value, { expectedProfile: resolveMeetingAnswerProfile("project-deep-dive") });
    assert.ok(parsed.parseStatus === "empty" || parsed.parseStatus === "partial");
    const result = enforceFactAnchorOutput({ decision: makeDecision(), parsedAnswer: parsed });
    assert.equal(result.reason, "generation-contract-deferred");
    assert.equal(result.effectiveContent, parsed.rawContent);
    assert.equal(result.fallbackMode, undefined);
    assert.equal(formatFactAnchorOutputDecisionForTrace(result).wholeAnswerReplacementCount, 0);
  }
});

test("non-fact-dependent output has no new restrictions", () => {
  const parsed = parseMeetingAnswer("Answer: A hash map gives expected constant-time lookup.");
  for (const decision of [undefined, makeDecision({ requiredFor: "none", state: "not-required" })]) {
    const result = enforceFactAnchorOutput({ decision, parsedAnswer: parsed });
    assert.equal(result.reason, "fact-anchor-not-required");
    assert.equal(result.effectiveContent, parsed.rawContent);
  }
});

test("narrative streaming preserves complete prose and holds artifacts and citation metadata", () => {
  for (const requiredFor of ["project-deep-dive", "behavioral"] as const) {
    const decision = makeDecision({ requiredFor });
    const body = "Answer: With line-delimited requests, each item keeps its own failure status. I would benchmark the improvement.\n";
    for (const tail of ["Code:\npartial", "Supporting anchor IDs: mem_old_project", "Answer disposition: factual-with-anchor"]) {
      const partial = projectFactAnchorStreamingPartial({ decision, content: body + tail });
      assert.equal(shouldBufferFactAnchorStreaming(decision), true);
      assert.equal(partial.visibleContent, body.trimEnd());
      assert.equal(partial.sanitizedClaimCount, 0);
      assert.equal(partial.artifactBoundaryHeld, tail.startsWith("Code:"));
      assert.doesNotMatch(partial.visibleContent, /mem_old_project|Code:|Answer disposition:/);
      const parsed = parseMeetingAnswer(body + "Answer disposition: bounded-with-caveat\nSupporting anchor IDs: mem_parser");
      const final = enforceFactAnchorOutput({ decision, parsedAnswer: parsed });
      assert.ok(partial.visibleContent.includes(final.effectiveAnswer.sections.answer!));
    }
    const unfinished = projectFactAnchorStreamingPartial({ decision, content: "Answer: An unfinished" });
    assert.equal(unfinished.visibleContent, "");
    assert.equal(unfinished.heldTrailingChars, "Answer: An unfinished".length);
  }
});

test("Shadow remains observational, including invalid citations", () => {
  const decision = makeDecision();
  decision.personalEvidence.mode = "shadow";
  const parsed = parseMeetingAnswer("Answer: We improved latency by 40%.\nSupporting anchor IDs: mem_old_project");
  const result = enforceFactAnchorOutput({ decision, parsedAnswer: parsed });
  assert.equal(result.reason, "shadow-observed");
  assert.equal(result.effectiveContent, parsed.rawContent);
  assert.equal(result.shadowWouldCommitSource, "sanitized-model-output");
  assert.deepEqual(result.unsupportedAnchorIds, ["mem_old_project"]);
  const trace = formatFactAnchorOutputDecisionForTrace(result);
  assert.equal(trace.factAnchorOutputObservationOnly, true);
  assert.equal(trace.factAnchorRemovedCitationCount, 0);
  assert.equal(trace.wholeAnswerReplacementCount, 0);
  const partial = projectFactAnchorStreamingPartial({ decision, content: parsed.rawContent });
  assert.equal(partial.visibleContent, parsed.rawContent);
  assert.equal(partial.bufferingEnabled, false);
});

test("personal-status unknowns retain their prior output and streaming protection", () => {
  const decision = buildFactAnchorDecision({
    questionType: "unknown", questionText: "Are you authorized to work in the United States?",
    personalEvidenceGuardrailMode: "enforcement",
  });
  assert.equal(decision.requiredFor, "personal-logistics");
  const parsed = parseMeetingAnswer("Answer: I require a $300,000 salary. I have no health restrictions.\nAnswer disposition: factual-with-anchor");
  const result = enforceFactAnchorOutput({ decision, parsedAnswer: parsed });
  assert.doesNotMatch(result.effectiveContent, /300,000|health restrictions/);
  assert.ok(result.sanitizedClaimCount > 0);
  assert.ok(result.fallbackMode);
  const trace = formatFactAnchorOutputDecisionForTrace(result);
  assert.equal(trace.wholeAnswerReplacementCount, 1);
  assert.equal(trace.factAnchorLegacyLexicalRemovedUnitCount, result.sanitizedClaimCount);
  assert.equal(trace.factAnchorSemanticVerificationPerformed, false);
  const partial = projectFactAnchorStreamingPartial({ decision, content: parsed.rawContent });
  assert.doesNotMatch(partial.visibleContent, /300,000|health restrictions/);
  assert.ok(partial.sanitizedClaimCount > 0);
  decision.personalEvidence.mode = "shadow";
  const shadow = enforceFactAnchorOutput({ decision, parsedAnswer: parsed });
  assert.equal(shadow.effectiveContent, parsed.rawContent);
  assert.equal(formatFactAnchorOutputDecisionForTrace(shadow).wholeAnswerReplacementCount, 0);
});

test("personal-status necessary clarification and empty support decisions stay protected", () => {
  const decision = makeDecision({
    requiredFor: "personal-logistics", claimPredicateFamily: "personal-status",
    supportedAnchorIds: ["profile_work_authorization"], supportedAnchorTitles: ["US work authorization"],
    selectedAnchorId: "profile_work_authorization", claimSupportDecisions: [],
  });
  const parsed = parseMeetingAnswer("Clarifying question: Could you clarify your availability?\nAnswer disposition: clarification");
  assert.equal(enforceFactAnchorOutput({ decision, parsedAnswer: parsed }).effectiveContent, parsed.rawContent);
  const unsafe = enforceFactAnchorOutput({
    decision, parsedAnswer: parseMeetingAnswer("Answer: I am authorized to work in the US. I have no health restrictions and I require a $300,000 salary.\nSupporting anchor IDs: profile_work_authorization"),
  });
  assert.doesNotMatch(unsafe.effectiveContent, /health restrictions|300,000/);
});
