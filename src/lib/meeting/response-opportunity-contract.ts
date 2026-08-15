export const RESPONSE_OPPORTUNITY_SCHEMA_VERSION = 3;
export const RESPONSE_OPPORTUNITY_PROMPT_VERSION =
  "response-opportunity-v3-compact";
export const RESPONSE_OPPORTUNITY_COMPACT_OUTPUT_WORST_CASE =
  JSON.stringify({
    v: RESPONSE_OPPORTUNITY_SCHEMA_VERSION,
    d: "u",
    c: 1,
    e: [0, 1],
    r: "bounded-source-insufficient",
  });
export const RESPONSE_OPPORTUNITY_MAX_OUTPUT_CHARS =
  RESPONSE_OPPORTUNITY_COMPACT_OUTPUT_WORST_CASE.length + 64;
// Runtime providers tokenize JSON differently. Two characters per token plus
// fixed headroom safely contains the worst legal compact response.
export const RESPONSE_OPPORTUNITY_MAX_OUTPUT_TOKENS = Math.max(
  128,
  Math.ceil(RESPONSE_OPPORTUNITY_MAX_OUTPUT_CHARS / 2) + 16
);
