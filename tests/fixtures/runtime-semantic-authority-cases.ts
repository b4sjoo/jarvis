export type RuntimeSemanticAuthorityCaseId =
  | "transition-substantive-residual"
  | "transition-negation"
  | "strong-anchor-empty-decisions"
  | "generated-answer-screen-source"
  | "released-response-dispatch"
  | "no-mutation-post-generation"
  | "screen-source-transition"
  | "exact-project-before-deictic"
  | "fenced-answer-section-label";

export interface RuntimeSemanticAuthorityCase {
  id: RuntimeSemanticAuthorityCaseId;
  ownerTasks: readonly string[];
  sourceKind:
    | "voice"
    | "screen"
    | "generated-answer"
    | "fact-decision";
  input: string;
  expectedInvariant: string;
  forbiddenEffect: string;
}

export const RUNTIME_SEMANTIC_AUTHORITY_CASES = [
  {
    id: "transition-substantive-residual",
    ownerTasks: ["137", "175"],
    sourceKind: "voice",
    input: "Let's start with the simplest correct solution.",
    expectedInvariant: "substantive residual reaches response opportunity",
    forbiddenEffect: "transition-only early return",
  },
  {
    id: "transition-negation",
    ownerTasks: ["137", "175"],
    sourceKind: "voice",
    input: "Let us not move on to coding questions.",
    expectedInvariant: "negation cannot create positive transition evidence",
    forbiddenEffect: "coding transition authorization",
  },
  {
    id: "strong-anchor-empty-decisions",
    ownerTasks: ["42", "76"],
    sourceKind: "fact-decision",
    input: "A work-authorization anchor must not support health or compensation claims.",
    expectedInvariant: "every retained personal claim has bounded support",
    forbiddenEffect: "whole-answer authorization from an empty claim decision set",
  },
  {
    id: "generated-answer-screen-source",
    ownerTasks: ["168", "151", "176"],
    sourceKind: "generated-answer",
    input: "Advisor output is presentation content, not Screen source evidence.",
    expectedInvariant: "screen source identity and content remain source-owned",
    forbiddenEffect: "generated answer overwrites active screen task content",
  },
  {
    id: "released-response-dispatch",
    ownerTasks: ["137", "175", "153", "176"],
    sourceKind: "voice",
    input: "Tell me about yourself.",
    expectedInvariant: "released output command reaches dispatch or a typed terminal",
    forbiddenEffect: "stale shadow refresh authority suppresses the request",
  },
  {
    id: "no-mutation-post-generation",
    ownerTasks: ["151", "175"],
    sourceKind: "voice",
    input: "A current-only answer may not mutate the active task after generation.",
    expectedInvariant: "task mutation policy remains authoritative through commit",
    forbiddenEffect: "post-generation parent, child, phase, or artifact mutation",
  },
  {
    id: "screen-source-transition",
    ownerTasks: ["36", "44", "61", "151"],
    sourceKind: "screen",
    input: "A matching screenshot supplies evidence for the pending voice question.",
    expectedInvariant: "screen relation transition settles before provider start",
    forbiddenEffect: "output-time continuity invents the source transition",
  },
  {
    id: "exact-project-before-deictic",
    ownerTasks: ["77", "154"],
    sourceKind: "voice",
    input: "I noticed that in Oasis project, you used NDJSON.",
    expectedInvariant: "the exact Oasis alias owns project identity",
    forbiddenEffect: "deictic evidence discards an exact project alias",
  },
  {
    id: "fenced-answer-section-label",
    ownerTasks: ["78", "176"],
    sourceKind: "generated-answer",
    input: "```python\nprint('Answer: still code')\n```",
    expectedInvariant: "section labels inside a code fence remain code",
    forbiddenEffect: "fenced content starts a canonical answer section",
  },
] as const satisfies readonly RuntimeSemanticAuthorityCase[];
