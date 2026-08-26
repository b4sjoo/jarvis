import assert from "node:assert/strict";
import test from "node:test";
import { didRuntimeInferenceProviderTimeOut } from "../src/lib/meeting/runtime-inference-response.js";

test("uses typed provider timeout before compatibility error text", () => {
  assert.equal(
    didRuntimeInferenceProviderTimeOut({
      outcome: { status: "timed-out" },
    }),
    true
  );
  assert.equal(
    didRuntimeInferenceProviderTimeOut({
      outcome: { status: "failed" },
      error: new Error("provider timeout"),
    }),
    true
  );
  assert.equal(
    didRuntimeInferenceProviderTimeOut({
      outcome: { status: "failed" },
      error: new Error("invalid output"),
    }),
    false
  );
});
