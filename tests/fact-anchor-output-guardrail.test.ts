import assert from "node:assert/strict";
import test from "node:test";
import {
  enforceFactAnchorOutput,
  formatFactAnchorOutputDecisionForTrace,
} from "../src/lib/meeting/fact-anchor-output-guardrail.js";
import { parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";
import type {
  FactAnchorDecision,
  FactAnchorState,
} from "../src/lib/meeting/types.js";

test("commits a fact-bound answer that reports an eligible anchor", () => {
  const output = parseMeetingAnswer(`Answer: I led the AOS cleanup.
Answer disposition: factual-with-anchor
Supporting anchor IDs: mem_story_aos_cleanup`);
  const result = enforceFactAnchorOutput({
    decision: makeDecision({
      state: "strong-anchor",
      supportedAnchorIds: ["mem_story_aos_cleanup"],
    }),
    parsedAnswer: output,
  });

  assert.equal(result.modelOutputAuthorized, true);
  assert.equal(result.commitSource, "model-output");
  assert.equal(result.effectiveContent, output.rawContent);
});

test("sanitizes unsupported hard claims while preserving a supported anchored story", () => {
  const result = enforceFactAnchorOutput({
    decision: makeDecision({
      state: "strong-anchor",
      supportedAnchorIds: ["mem_beaglestone"],
      claimSupportDecisions: [
        {
          claimId: "claim:behavioral:mem_beaglestone",
          predicateFamily: "behavioral-story",
          anchorId: "mem_beaglestone",
          projectCompatible: true,
          predicateCompatible: true,
          supportSpanPresent: true,
          supportSpan:
            "I led the BeagleStone migration under a four-week deadline and used parity testing.",
          conflictFree: true,
          decision: "allow",
          reason: "test-support",
        },
      ],
    }),
    parsedAnswer: parseMeetingAnswer(`Answer: I led the BeagleStone migration under a four-week deadline and used parity testing. My teammate wanted to skip parity testing, but I pushed for manual sampling. We delivered with zero observability downtime.
Answer disposition: factual-with-anchor
Supporting anchor IDs: mem_beaglestone`),
  });

  assert.equal(result.commitSource, "sanitized-model-output");
  assert.match(result.effectiveContent, /four-week deadline/i);
  assert.doesNotMatch(result.effectiveContent, /teammate wanted/i);
  assert.doesNotMatch(result.effectiveContent, /zero observability/i);
  assert.equal(result.sanitizedClaimCount, 2);
  const trace = formatFactAnchorOutputDecisionForTrace(result);
  assert.equal(trace.unsupportedFirstPersonHardClaimCount, 2);
  assert.equal(trace.boundedSynthesisCommitCount, 1);
  assert.equal(trace.wholeAnswerReplacementCount, 0);
});

test("removes invented project mechanisms outside an allowed support span", () => {
  const result = enforceFactAnchorOutput({
    decision: makeDecision({
      state: "strong-anchor",
      requiredFor: "project-deep-dive",
      supportedAnchorIds: ["mem_oasis_bulk"],
      claimSupportDecisions: [
        {
          claimId: "claim:validation:mem_oasis_bulk",
          predicateFamily: "validation-reliability",
          anchorId: "mem_oasis_bulk",
          projectCompatible: true,
          predicateCompatible: true,
          supportSpanPresent: true,
          supportSpan:
            "We used NDJSON request framing and reported Bulk API failures per item.",
          conflictFree: true,
          decision: "allow",
          reason: "test-support",
        },
      ],
    }),
    parsedAnswer: parseMeetingAnswer(`Answer: We used NDJSON request framing and reported Bulk API failures per item. We implemented exponential backoff with jitter, rebatching, and a dead-letter queue.
Answer disposition: factual-with-anchor
Supporting anchor IDs: mem_oasis_bulk`),
  });

  assert.equal(result.commitSource, "sanitized-model-output");
  assert.match(result.effectiveContent, /NDJSON request framing/i);
  assert.doesNotMatch(result.effectiveContent, /exponential backoff/i);
  assert.doesNotMatch(result.effectiveContent, /dead-letter queue/i);
});

test("falls back to verified support instead of refusing the whole anchored answer", () => {
  const result = enforceFactAnchorOutput({
    decision: makeDecision({
      state: "strong-anchor",
      requiredFor: "project-deep-dive",
      supportedAnchorIds: ["mem_parser_fix"],
      claimSupportDecisions: [
        {
          claimId: "claim:validation:mem_parser_fix",
          predicateFamily: "validation-reliability",
          anchorId: "mem_parser_fix",
          projectCompatible: true,
          predicateCompatible: true,
          supportSpanPresent: true,
          supportSpan:
            "I implemented parser-boundary cleanup for fenced JSON output.",
          conflictFree: true,
          decision: "allow",
          reason: "test-support",
        },
      ],
    }),
    parsedAnswer: parseMeetingAnswer(`Answer: I led a 50-person organization and achieved zero errors.
Answer disposition: factual-with-anchor
Supporting anchor IDs: mem_parser_fix`),
  });

  assert.equal(result.commitSource, "sanitized-model-output");
  assert.equal(result.effectiveAnswer.answerDisposition, "factual-with-anchor");
  assert.match(result.effectiveAnswer.sections.answer ?? "", /fenced JSON/i);
  assert.doesNotMatch(result.effectiveContent, /Answer: -/);
  assert.doesNotMatch(result.effectiveContent, /Which verified project/i);
});

test("replaces a fact-bound answer that omits authority metadata", () => {
  const result = enforceFactAnchorOutput({
    decision: makeDecision({
      state: "strong-anchor",
      supportedAnchorIds: ["mem_story_aos_cleanup"],
    }),
    parsedAnswer: parseMeetingAnswer(
      "Answer: I led an unsupported cleanup story."
    ),
  });

  assert.equal(result.modelOutputAuthorized, false);
  assert.equal(result.reason, "missing-answer-disposition");
  assert.equal(result.commitSource, "safe-replacement");
  assert.equal(
    result.effectiveAnswer.answerDisposition,
    "clarification"
  );
  assert.equal(result.effectiveAnswer.sections.answer, undefined);
  assert.match(
    result.effectiveAnswer.sections.clarifyingQuestion ?? "",
    /verified experience/i
  );
});

test("rejects an unknown or old-parent anchor id", () => {
  const result = enforceFactAnchorOutput({
    decision: makeDecision({
      state: "strong-anchor",
      supportedAnchorIds: ["mem_current_project"],
      requiredFor: "project-deep-dive",
    }),
    parsedAnswer: parseMeetingAnswer(`Answer: I implemented the old project.
Answer disposition: factual-with-anchor
Supporting anchor IDs: mem_old_parent_project`),
  });

  assert.equal(result.modelOutputAuthorized, false);
  assert.equal(result.reason, "unsupported-anchor-id");
  assert.deepEqual(result.unsupportedAnchorIds, [
    "mem_old_parent_project",
  ]);
});

test("does not trust a clarification label attached to a substantive story", () => {
  const result = enforceFactAnchorOutput({
    decision: makeDecision({
      state: "no-anchor",
      action: "ask-clarification",
      supportedAnchorIds: [],
    }),
    parsedAnswer: parseMeetingAnswer(`Answer: I built a fictional MCP system.
Clarifying question: Should I continue?
Answer disposition: clarification
Supporting anchor IDs: -`),
  });

  assert.equal(result.modelOutputAuthorized, false);
  assert.equal(result.reason, "unsafe-clarification-shape");
  assert.doesNotMatch(result.effectiveContent, /fictional MCP/);
});

test("allows a no-anchor response that contains only a clarification", () => {
  const output = parseMeetingAnswer(`Answer: -
Clarifying question: Which verified project should I use?
Clarifying options: -
Answer disposition: clarification
Supporting anchor IDs: -`);
  const result = enforceFactAnchorOutput({
    decision: makeDecision({
      state: "no-anchor",
      action: "ask-clarification",
      supportedAnchorIds: [],
      requiredFor: "project-deep-dive",
    }),
    parsedAnswer: output,
  });

  assert.equal(result.modelOutputAuthorized, true);
  assert.equal(result.commitSource, "model-output");
});

test("allows bounded non-personal framing but blocks an unanchored first-person claim", () => {
  const decision = makeDecision({
    state: "weak-anchor",
    action: "answer-with-caveats",
    supportedAnchorIds: [],
  });
  const bounded = enforceFactAnchorOutput({
    decision,
    parsedAnswer: parseMeetingAnswer(`Answer: A safe approach is to clarify the verified story first.
Answer disposition: bounded-with-caveat
Supporting anchor IDs: -`),
  });
  const claimed = enforceFactAnchorOutput({
    decision,
    parsedAnswer: parseMeetingAnswer(`Answer: I personally delivered the unsupported result.
Answer disposition: bounded-with-caveat
Supporting anchor IDs: -`),
  });

  assert.equal(bounded.modelOutputAuthorized, true);
  assert.equal(claimed.modelOutputAuthorized, false);
  assert.equal(
    claimed.reason,
    "unsafe-unanchored-first-person-claim"
  );
});

test("removes an unsupported personal claim while preserving useful bounded guidance", () => {
  const result = enforceFactAnchorOutput({
    decision: makeDecision({
      state: "weak-anchor",
      action: "answer-with-caveats",
      supportedAnchorIds: [],
      requiredFor: "project-deep-dive",
    }),
    parsedAnswer: parseMeetingAnswer(`中文思路: 保留可验证的方法，不编造个人结果。
Answer: I personally validated this system with a production rollout. A reliable validation plan should cover load, fairness, failure injection, and rollback signals.
Approach: I would start with a shadow deployment and compare rejection rate, latency, and recovery behavior.
Answer disposition: bounded-with-caveat
Supporting anchor IDs: -`),
  });

  assert.equal(result.modelOutputAuthorized, false);
  assert.equal(result.commitSource, "sanitized-model-output");
  assert.equal(result.reason, "bounded-output-sanitized");
  assert.doesNotMatch(result.effectiveContent, /personally validated/i);
  assert.match(result.effectiveContent, /reliable validation plan/i);
  assert.match(result.effectiveContent, /I would start/i);
  assert.equal(result.sanitizedClaimCount, 1);
  assert.ok(result.preservedClaimCount >= 2);
  assert.deepEqual(result.sanitizedSections, ["answer"]);

  const trace = formatFactAnchorOutputDecisionForTrace(result);
  assert.equal(trace.factAnchorClaimSanitizationApplied, true);
  assert.equal(trace.factAnchorSanitizedClaimCount, 1);
});

test("allows an explicitly hypothetical first-person recommendation", () => {
  const output = parseMeetingAnswer(`Answer: I would validate the design with shadow traffic and failure injection before rollout.
Answer disposition: bounded-with-caveat
Supporting anchor IDs: -`);
  const result = enforceFactAnchorOutput({
    decision: makeDecision({
      state: "weak-anchor",
      action: "answer-with-caveats",
      supportedAnchorIds: [],
      requiredFor: "project-deep-dive",
    }),
    parsedAnswer: output,
  });

  assert.equal(result.modelOutputAuthorized, true);
  assert.equal(result.commitSource, "model-output");
  assert.equal(result.effectiveContent, output.rawContent);
});

test("uses only verified weak-anchor choices", () => {
  const decision = makeDecision({
    state: "weak-anchor",
    action: "offer-supported-choices",
    supportedAnchorIds: [],
    supportedAnchorTitles: ["Agentic Memory", "AOS cleanup"],
    requiredFor: "project-deep-dive",
  });
  const matching = enforceFactAnchorOutput({
    decision,
    parsedAnswer: parseMeetingAnswer(`Answer: -
Clarifying question: Which project should I use?
Clarifying options: Agentic Memory | AOS cleanup
Answer disposition: supported-choices
Supporting anchor IDs: -`),
  });
  const invented = enforceFactAnchorOutput({
    decision,
    parsedAnswer: parseMeetingAnswer(`Answer: -
Clarifying question: Which project should I use?
Clarifying options: Fictional MCP
Answer disposition: supported-choices
Supporting anchor IDs: -`),
  });

  assert.equal(matching.modelOutputAuthorized, true);
  assert.equal(invented.modelOutputAuthorized, false);
});

test("does not gate non-fact-dependent output", () => {
  const output = parseMeetingAnswer(
    "Answer: Use a deque for the sliding-window maximum."
  );
  const result = enforceFactAnchorOutput({
    decision: makeDecision({
      state: "not-required",
      requiredFor: "none",
      supportedAnchorIds: [],
    }),
    parsedAnswer: output,
  });

  assert.equal(result.modelOutputAuthorized, true);
  assert.equal(result.reason, "fact-anchor-not-required");
  assert.equal(result.effectiveContent, output.rawContent);
});

test("turns an empty provider output into a safe fact-bound clarification", () => {
  const result = enforceFactAnchorOutput({
    decision: makeDecision({
      state: "no-anchor",
      action: "ask-clarification",
      supportedAnchorIds: [],
    }),
    parsedAnswer: parseMeetingAnswer("-"),
  });
  const trace = formatFactAnchorOutputDecisionForTrace(result, {
    partialOutputHeld: true,
  });

  assert.equal(result.reason, "incomplete-model-output");
  assert.equal(result.commitSource, "safe-replacement");
  assert.equal(trace.factAnchorSafeReplacement, true);
  assert.equal(trace.factAnchorPartialOutputHeld, true);
});

function makeDecision(
  overrides: Partial<FactAnchorDecision> & { state: FactAnchorState }
): FactAnchorDecision {
  const { state, ...remainingOverrides } = overrides;
  return {
    state,
    requiredFor: "behavioral",
    supportedAnchorIds: [],
    supportedAnchorTitles: [],
    action:
      state === "strong-anchor"
        ? "answer-with-anchor"
        : state === "weak-anchor"
          ? "answer-with-caveats"
          : "ask-clarification",
    personalEvidence: {
      requirement: "autobiographical-behavioral",
      confidence: 1,
      confidenceTier: "high",
      signals: [],
      counterSignals: [],
      allowedEvidenceSources: [],
      mode: "enforcement",
      enforced: true,
    },
    selectedPersonalEvidenceSources: [],
    unsupportedClaimRisk:
      state === "not-required" ? "none" : "high",
    ...remainingOverrides,
    claimSupportDecisions:
      remainingOverrides.claimSupportDecisions ?? [],
  };
}
