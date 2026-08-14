import assert from "node:assert/strict";
import test from "node:test";
import {
  decideAdvisorGenerationAdmission,
} from "../src/lib/meeting/advisor-generation-supersession.js";
import { createAdvisorTriggerJob } from "../src/lib/meeting/advisor-trigger-job.js";
import type { AdvisorPromptContext } from "../src/lib/meeting/types.js";

function promptContext(): AdvisorPromptContext {
  return {
    transcript: "Them: What is the in-degree?",
    screenContext: "",
    rollingSummary: "",
    userProfileContext: "",
    glossaryText: "",
    taskRuntime: { revision: 0 },
  };
}

function job(source: "live-turn" | "manual-correction" = "live-turn") {
  return createAdvisorTriggerJob({
    source,
    mode: "live",
    promptContext: promptContext(),
    sessionId: "session-a",
    runtimeEpoch: 1,
    snapshotTurnCount: 1,
    taskMutationAuthority:
      source === "manual-correction"
        ? "manual-correction"
        : "input-evidence",
  });
}

test("holds an adjacent automatic candidate behind an executing generation", () => {
  const decision = decideAdvisorGenerationAdmission({
    activeJob: job(),
    incomingJob: job(),
    activeJobWaitingForDebounce: false,
  });

  assert.equal(decision.action, "hold-supersession-pending");
  assert.equal(decision.protectActiveGeneration, true);
});

test("replaces a job that has not started provider execution", () => {
  const decision = decideAdvisorGenerationAdmission({
    activeJob: job(),
    incomingJob: job(),
    activeJobWaitingForDebounce: true,
  });

  assert.equal(decision.action, "replace-before-execution");
  assert.equal(decision.protectActiveGeneration, false);
});

test("manual correction keeps immediate hard-override authority", () => {
  const decision = decideAdvisorGenerationAdmission({
    activeJob: job(),
    incomingJob: job("manual-correction"),
    activeJobWaitingForDebounce: false,
  });

  assert.equal(decision.action, "replace-with-settled-authority");
  assert.equal(decision.reason, "explicit-hard-override");
  assert.equal(decision.protectActiveGeneration, false);
});

test("a settled runtime type repair can replace immediately", () => {
  const incoming = job();
  incoming.refreshAuthority = {
    authorized: true,
    kind: "runtime-type-repair",
    reason: "runtime-type-repair",
    hardOverride: false,
    maySupersedeGeneration: true,
    authorityId: "authority-a",
  };
  const decision = decideAdvisorGenerationAdmission({
    activeJob: job(),
    incomingJob: incoming,
    activeJobWaitingForDebounce: false,
  });

  assert.equal(decision.action, "replace-with-settled-authority");
  assert.equal(decision.reason, "settled-runtime-repair");
});
