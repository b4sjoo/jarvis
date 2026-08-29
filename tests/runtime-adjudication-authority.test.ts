import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeRuntimeAdjudicationAuthorityLabel,
  RUNTIME_ADJUDICATION_AUTHORITY,
  RUNTIME_TYPE_ADJUDICATION_OUTPUT_AUTHORITY_REASON,
  RUNTIME_TYPE_ADJUDICATION_OUTPUT_ONLY_AUTHORITY,
} from "../src/lib/meeting/runtime-adjudication-authority.js";

test("normalizes legacy type-repair authority labels at the recording boundary", () => {
  assert.equal(
    normalizeRuntimeAdjudicationAuthorityLabel("llm-type-repair"),
    RUNTIME_ADJUDICATION_AUTHORITY
  );
  assert.equal(
    normalizeRuntimeAdjudicationAuthorityLabel("runtime-type-repair"),
    RUNTIME_TYPE_ADJUDICATION_OUTPUT_ONLY_AUTHORITY
  );
  assert.equal(
    normalizeRuntimeAdjudicationAuthorityLabel(
      "runtime-type-repair-output-authority"
    ),
    RUNTIME_TYPE_ADJUDICATION_OUTPUT_AUTHORITY_REASON
  );
});

test("preserves current and unrelated authority labels", () => {
  assert.equal(
    normalizeRuntimeAdjudicationAuthorityLabel(
      RUNTIME_ADJUDICATION_AUTHORITY
    ),
    RUNTIME_ADJUDICATION_AUTHORITY
  );
  assert.equal(
    normalizeRuntimeAdjudicationAuthorityLabel("manual-correction"),
    "manual-correction"
  );
  assert.equal(
    normalizeRuntimeAdjudicationAuthorityLabel(undefined),
    undefined
  );
});
