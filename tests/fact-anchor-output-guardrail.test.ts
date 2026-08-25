import assert from "node:assert/strict";
import test from "node:test";
import {
  enforceFactAnchorOutput,
  formatFactAnchorOutputDecisionForTrace,
  projectFactAnchorStreamingPartial,
  shouldBufferFactAnchorStreaming,
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
      claimSupportDecisions: [
        {
          claimId: "claim:behavioral:mem_story_aos_cleanup",
          predicateFamily: "behavioral-story",
          anchorId: "mem_story_aos_cleanup",
          projectCompatible: true,
          predicateCompatible: true,
          supportSpanPresent: true,
          supportSpan: "I led the AOS cleanup.",
          conflictFree: true,
          decision: "allow",
          reason: "test-support",
        },
      ],
    }),
    parsedAnswer: output,
  });

  assert.equal(result.modelOutputAuthorized, true);
  assert.equal(result.commitSource, "model-output");
  assert.equal(result.effectiveContent, output.rawContent);
});

test("does not let an empty personal claim decision authorize unrelated claims", () => {
  const result = enforceFactAnchorOutput({
    decision: makeDecision({
      state: "strong-anchor",
      requiredFor: "personal-logistics",
      supportedAnchorIds: ["profile_work_authorization"],
      supportedAnchorTitles: ["US work authorization"],
      selectedAnchorId: "profile_work_authorization",
      claimPredicateFamily: "personal-status",
      claimSupportDecisions: [],
    }),
    parsedAnswer: parseMeetingAnswer(`Answer: I am authorized to work in the US. I have no health restrictions and I require a $300,000 salary.
Answer disposition: factual-with-anchor
Supporting anchor IDs: profile_work_authorization`),
  });

  assert.equal(result.modelOutputAuthorized, false);
  assert.equal(result.commitSource, "sanitized-model-output");
  assert.doesNotMatch(result.effectiveContent, /health restrictions/i);
  assert.doesNotMatch(result.effectiveContent, /\$300,000/i);
  assert.ok(result.sanitizedClaimCount > 0);
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
  assert.equal(result.sanitizedClaimCount, 3);
  const trace = formatFactAnchorOutputDecisionForTrace(result);
  assert.equal(trace.unsupportedFirstPersonHardClaimCount, 3);
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

test("preserves a supported negative boundary in both language sections", () => {
  const result = enforceFactAnchorOutput({
    decision: makeDecision({
      state: "strong-anchor",
      requiredFor: "project-deep-dive",
      supportedAnchorIds: ["mem_oasis_bulk"],
      claimSupportDecisions: [
        {
          claimId: "claim:oasis:implementation",
          predicateFamily: "architecture-decision",
          anchorId: "mem_oasis_bulk",
          projectCompatible: true,
          predicateCompatible: true,
          supportSpanPresent: true,
          supportSpan:
            "The verified Oasis implementation generated NDJSON and preserved per-item Bulk API failures.",
          conflictFree: true,
          decision: "allow",
          reason: "test-support",
        },
      ],
    }),
    parsedAnswer: parseMeetingAnswer(`中文思路: 我们没有实现 retry queue 或 DLQ；已验证范围是 NDJSON 与逐项失败解析。
Answer: I did not implement a retry queue or DLQ; the verified scope was NDJSON generation and per-item failure parsing.
Answer disposition: factual-with-anchor
Supporting anchor IDs: mem_oasis_bulk`),
  });

  assert.match(result.effectiveContent, /did not implement/i);
  assert.match(result.effectiveContent, /没有实现/u);
  assert.equal(result.bilingualClaimSetCoherent, true);
  assert.ok(result.boundaryClaimPreservedCount >= 2);
  assert.equal(result.hypotheticalOnlyAfterSanitize, false);
});

test("keeps model-owned bilingual wording when sanitation leaves a safe hypothetical offer", () => {
  const result = enforceFactAnchorOutput({
    decision: makeDecision({
      state: "strong-anchor",
      requiredFor: "project-deep-dive",
      supportedAnchorIds: ["mem_oasis_bulk"],
      claimSupportDecisions: [
        {
          claimId: "claim:oasis:implementation",
          predicateFamily: "architecture-decision",
          anchorId: "mem_oasis_bulk",
          projectCompatible: true,
          predicateCompatible: true,
          supportSpanPresent: true,
          supportSpan:
            "The verified Oasis implementation generated NDJSON and preserved per-item Bulk API failures.",
          conflictFree: true,
          decision: "allow",
          reason: "test-support",
        },
      ],
    }),
    parsedAnswer: parseMeetingAnswer(`中文思路: 我们没有实现 retry queue 或 DLQ。
Answer: I would add retry queues, jitter, and a DLQ as future improvements.
Answer disposition: factual-with-anchor
Supporting anchor IDs: mem_oasis_bulk`),
  });

  assert.equal(result.hypotheticalOnlyAfterSanitize, true);
  assert.equal(result.bilingualClaimSetCoherent, false);
  assert.match(result.effectiveContent, /I would add retry queues/i);
  assert.match(result.effectiveContent, /没有实现 retry queue/u);
  assert.doesNotMatch(result.effectiveContent, /verified implementation scope/i);
  assert.doesNotMatch(result.effectiveContent, /已验证的实现范围/u);
  assert.equal(result.visibleNotice, undefined);
});

test("removes unsupported clarification choices before they become runtime context", () => {
  const result = enforceFactAnchorOutput({
    decision: makeDecision({
      state: "strong-anchor",
      requiredFor: "project-deep-dive",
      supportedAnchorIds: ["mem_oasis_bulk"],
      claimSupportDecisions: [
        {
          claimId: "claim:oasis:implementation",
          predicateFamily: "architecture-decision",
          anchorId: "mem_oasis_bulk",
          projectCompatible: true,
          predicateCompatible: true,
          supportSpanPresent: true,
          supportSpan:
            "The Oasis implementation parsed Bulk API responses and preserved per-item failure details.",
          conflictFree: true,
          decision: "allow",
          reason: "test-support",
        },
      ],
    }),
    parsedAnswer: parseMeetingAnswer(`Answer: The Oasis implementation parsed Bulk API responses and preserved per-item failure details.
Clarifying question: Would you like me to focus on how we handled per-item failure detection in Oasis, or the end-to-end retry and DLQ pipeline design?
Clarifying options: Per-item failure parsing in Oasis | Downstream retry and DLQ architecture | Both at high level
Answer disposition: factual-with-anchor
Supporting anchor IDs: mem_oasis_bulk`),
  });

  assert.equal(result.commitSource, "sanitized-model-output");
  assert.match(result.effectiveContent, /per-item failure details/i);
  assert.equal(result.effectiveAnswer.sections.clarifyingQuestion, undefined);
  assert.deepEqual(result.effectiveAnswer.sections.clarifyingOptions, []);
  assert.doesNotMatch(result.effectiveContent, /DLQ/i);
  assert.ok(result.sanitizedSections.includes("clarifyingQuestion"));
  assert.ok(result.sanitizedSections.includes("clarifyingOptions"));
  const trace = formatFactAnchorOutputDecisionForTrace(result);
  assert.equal(trace.factAnchorClarifyingQuestionSanitized, true);
  assert.equal(trace.factAnchorClarifyingOptionsSanitized, true);
  assert.equal(trace.factAnchorEffectiveClarifyingOptionCount, 0);
});

test("keeps generic source-selection clarification without fact leakage", () => {
  const result = enforceFactAnchorOutput({
    decision: makeDecision({
      state: "no-anchor",
      requiredFor: "project-deep-dive",
      action: "ask-clarification",
    }),
    parsedAnswer: parseMeetingAnswer(`Clarifying question: Which project should I use?
Answer disposition: clarification
Supporting anchor IDs: -`),
  });

  assert.equal(result.commitSource, "model-output");
  assert.equal(
    result.effectiveAnswer.sections.clarifyingQuestion,
    "Which project should I use?"
  );
});

test("audits passive and non-first-person project claims against the same support spans", () => {
  const result = enforceFactAnchorOutput({
    decision: makeDecision({
      state: "strong-anchor",
      requiredFor: "project-deep-dive",
      supportedAnchorIds: ["mem_oasis_bulk"],
      claimSupportDecisions: [
        {
          claimId: "claim:oasis:implementation",
          predicateFamily: "architecture-decision",
          anchorId: "mem_oasis_bulk",
          projectCompatible: true,
          predicateCompatible: true,
          supportSpanPresent: true,
          supportSpan:
            "The Oasis implementation used NDJSON request framing and reported Bulk API failures per item.",
          conflictFree: true,
          decision: "allow",
          reason: "test-support",
        },
      ],
    }),
    parsedAnswer: parseMeetingAnswer(`中文思路: 该项目已经把失败消息移入重试 DLQ 并重新批处理。可以把 DLQ 明确表述为后续改进方案。
Answer: The Oasis implementation used NDJSON request framing and reported Bulk API failures per item, but failed messages were routed to a retry DLQ and rebatched. Throughput improved and the drop rate decreased.
Answer disposition: factual-with-anchor
Supporting anchor IDs: mem_oasis_bulk`),
  });

  assert.equal(result.commitSource, "sanitized-model-output");
  assert.match(result.effectiveContent, /NDJSON request framing/i);
  assert.doesNotMatch(result.effectiveContent, /retry DLQ/i);
  assert.doesNotMatch(result.effectiveContent, /Throughput improved/i);
  assert.doesNotMatch(result.effectiveContent, /已经把失败消息/u);
  assert.match(result.effectiveContent, /后续改进方案/u);
  assert.ok(result.sanitizedClaimCount >= 3);
  const trace = formatFactAnchorOutputDecisionForTrace(result);
  assert.equal(
    trace.unsupportedAssertiveFactClaimCount,
    result.sanitizedClaimCount
  );
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
  assert.equal(
    result.visibleNotice?.kind,
    "rebuilt-from-supported-evidence"
  );
});

test("deduplicates overlapping evidence without truncating the fallback claim", () => {
  const result = enforceFactAnchorOutput({
    decision: makeDecision({
      state: "strong-anchor",
      requiredFor: "project-deep-dive",
      supportedAnchorIds: ["mem_oasis_bulk"],
      claimSupportDecisions: [
        {
          claimId: "claim:oasis:short",
          predicateFamily: "architecture-decision",
          anchorId: "mem_oasis_bulk",
          projectCompatible: true,
          predicateCompatible: true,
          supportSpanPresent: true,
          supportSpan: "The Oasis implementation generated NDJSON.",
          conflictFree: true,
          decision: "allow",
          reason: "test-support",
        },
        {
          claimId: "claim:oasis:complete",
          predicateFamily: "architecture-decision",
          anchorId: "mem_oasis_bulk",
          projectCompatible: true,
          predicateCompatible: true,
          supportSpanPresent: true,
          supportSpan:
            "The Oasis implementation generated NDJSON and preserved per-item Bulk API failures.",
          conflictFree: true,
          decision: "allow",
          reason: "test-support",
        },
      ],
    }),
    parsedAnswer: parseMeetingAnswer(`Answer: I implemented retries, jitter, and a DLQ with zero failures.
Answer disposition: factual-with-anchor
Supporting anchor IDs: mem_oasis_bulk`),
  });

  const answer = result.effectiveAnswer.sections.answer ?? "";
  assert.equal(answer.match(/generated NDJSON/gi)?.length, 1);
  assert.match(answer, /per-item Bulk API failures\./);
  assert.equal(result.visibleNotice?.kind, "rebuilt-from-supported-evidence");
});

test("sanitizes a fact-bound answer that omits authority metadata without refusing", () => {
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
  assert.equal(result.reason, "bounded-output-sanitized");
  assert.equal(result.commitSource, "sanitized-model-output");
  assert.ok(result.effectiveAnswer.sections.answer);
  assert.doesNotMatch(result.effectiveContent, /Answer: -/);
  assert.equal(
    result.visibleNotice?.kind,
    "generic-hypothetical-fallback"
  );
});

test("filters an unknown or old-parent anchor id without refusing", () => {
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
  assert.equal(result.reason, "bounded-output-sanitized");
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
  assert.equal(result.reason, "bounded-output-sanitized");
  assert.doesNotMatch(result.effectiveContent, /fictional MCP/);
  assert.ok(result.effectiveAnswer.sections.answer);
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
  assert.equal(claimed.reason, "bounded-output-sanitized");
  assert.ok(claimed.effectiveAnswer.sections.answer);
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
  assert.deepEqual(invented.effectiveAnswer.sections.clarifyingOptions, []);
  assert.ok(invented.effectiveAnswer.sections.answer);
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

test("leaves an empty provider output to the generation contract", () => {
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

  assert.equal(result.reason, "generation-contract-deferred");
  assert.equal(result.commitSource, "model-output");
  assert.equal(trace.factAnchorSafeReplacement, false);
  assert.equal(trace.wholeAnswerReplacementCount, 0);
  assert.equal(trace.factAnchorPartialOutputHeld, true);
});

test("keeps Shadow output byte-for-byte while recording the potential sanitation", () => {
  const decision = makeDecision({
    state: "no-anchor",
    action: "ask-clarification",
    supportedAnchorIds: [],
  });
  decision.personalEvidence = {
    ...decision.personalEvidence,
    mode: "shadow",
    enforced: false,
  };
  const output = parseMeetingAnswer(
    "Answer: I personally implemented an unsupported retry system."
  );
  const result = enforceFactAnchorOutput({
    decision,
    parsedAnswer: output,
  });

  assert.equal(result.commitSource, "model-output");
  assert.equal(result.effectiveContent, output.rawContent);
  assert.equal(result.reason, "shadow-observed");
  assert.equal(result.shadowWouldCommitSource, "sanitized-model-output");
  assert.ok(result.sanitizedClaimCount > 0);
  assert.equal(result.visibleNotice, undefined);
});

test("streams completed supported sentences while keeping artifacts atomic", () => {
  const decision = makeDecision({
    state: "strong-anchor",
    requiredFor: "project-deep-dive",
    supportedAnchorIds: ["mem_oasis_bulk"],
    selectedAnchorId: "mem_oasis_bulk",
    claimSupportDecisions: [
      {
        claimId: "claim:oasis:span-1",
        predicateFamily: "architecture-decision",
        supportScope: "anchor-evidence",
        anchorId: "mem_oasis_bulk",
        projectCompatible: true,
        predicateCompatible: false,
        supportSpanPresent: true,
        supportSpan:
          "We used NDJSON request framing and reported Bulk API failures per item.",
        conflictFree: true,
        decision: "allow",
        reason: "project-compatible-anchor-evidence-span",
      },
    ],
  });
  const partial = projectFactAnchorStreamingPartial({
    decision,
    content: `Answer: We used NDJSON request framing and reported failures per item. We implemented retries with jitter.\nCode:\npartial`,
  });

  assert.equal(shouldBufferFactAnchorStreaming(decision), true);
  assert.match(partial.visibleContent, /NDJSON request framing/i);
  assert.doesNotMatch(partial.visibleContent, /retries with jitter/i);
  assert.doesNotMatch(partial.visibleContent, /Code:/i);
  assert.equal(partial.sanitizedClaimCount, 1);
  assert.equal(partial.artifactBoundaryHeld, true);
});

test("never buffers or changes Shadow streaming output", () => {
  const decision = makeDecision({
    state: "strong-anchor",
    supportedAnchorIds: ["mem_oasis_bulk"],
  });
  decision.personalEvidence = {
    ...decision.personalEvidence,
    mode: "shadow",
    enforced: false,
  };
  const content = "Answer: We implemented retries with jitter";
  const partial = projectFactAnchorStreamingPartial({ decision, content });

  assert.equal(shouldBufferFactAnchorStreaming(decision), false);
  assert.equal(partial.visibleContent, content);
  assert.equal(partial.bufferingEnabled, false);
  assert.equal(partial.heldTrailingChars, 0);
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
