import type { AdvisorPromptContext } from "../src/lib/meeting/meeting-context-contracts.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  decideAdvisorGenerationAdmission,
  decideManualScreenAdvisorSupersession,
} from "../src/lib/meeting/advisor-generation-supersession.js";
import { createAdvisorTriggerJob } from "../src/lib/meeting/advisor-trigger-job.js";


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

test("a settled runtime type adjudication can replace immediately", () => {
  const incoming = job();
  incoming.refreshAuthority = {
    authorized: true,
    kind: "runtime-type-adjudication-output-only",
    reason: "runtime-type-adjudication-output-only",
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

const voiceCandidate = {
  candidateId: "advisor-job-1",
  advisorJobId: "advisor-job-1",
  generationLeaseId: "generation-1",
  source: "live-turn",
  sessionId: "session-a",
  runtimeEpoch: 4,
  logicalQuestionUnitId: "lqu-1",
  logicalQuestionRevision: 3,
};

test("successful manual Screen capture supersedes the matching automatic Voice generation", () => {
  const decision = decideManualScreenAdvisorSupersession({
    captureSuccessful: true,
    candidate: voiceCandidate,
    candidateStillCurrent: true,
    currentSessionId: "session-a",
    currentRuntimeEpoch: 4,
    recoveryTarget: {
      logicalQuestionUnitId: "lqu-1",
      logicalQuestionRevision: 3,
    },
  });

  assert.equal(decision.disposition, "supersede-automatic-voice");
  assert.equal(decision.reason, "same-recovery-target");
});

test("failed capture and a different recovery target preserve Voice generation", () => {
  assert.equal(
    decideManualScreenAdvisorSupersession({
      captureSuccessful: false,
      candidate: voiceCandidate,
      candidateStillCurrent: true,
      currentSessionId: "session-a",
      currentRuntimeEpoch: 4,
      recoveryTarget: {
        logicalQuestionUnitId: "lqu-1",
        logicalQuestionRevision: 3,
      },
    }).reason,
    "capture-not-successful"
  );
  assert.equal(
    decideManualScreenAdvisorSupersession({
      captureSuccessful: true,
      candidate: voiceCandidate,
      candidateStillCurrent: true,
      currentSessionId: "session-a",
      currentRuntimeEpoch: 4,
      recoveryTarget: {
        logicalQuestionUnitId: "lqu-2",
        logicalQuestionRevision: 1,
      },
    }).reason,
    "logical-question-mismatch"
  );
});

test("manual and stale candidates do not receive automatic Screen supersession", () => {
  assert.equal(
    decideManualScreenAdvisorSupersession({
      captureSuccessful: true,
      candidate: { ...voiceCandidate, source: "manual-correction" },
      candidateStillCurrent: true,
      currentSessionId: "session-a",
      currentRuntimeEpoch: 4,
      recoveryTarget: {
        logicalQuestionUnitId: "lqu-1",
        logicalQuestionRevision: 3,
      },
    }).reason,
    "candidate-is-not-automatic-voice"
  );
  assert.equal(
    decideManualScreenAdvisorSupersession({
      captureSuccessful: true,
      candidate: voiceCandidate,
      candidateStillCurrent: false,
      currentSessionId: "session-a",
      currentRuntimeEpoch: 4,
      recoveryTarget: {
        logicalQuestionUnitId: "lqu-1",
        logicalQuestionRevision: 3,
      },
    }).reason,
    "candidate-no-longer-current"
  );
});
