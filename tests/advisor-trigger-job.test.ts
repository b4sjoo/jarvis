import assert from "node:assert/strict";
import test from "node:test";
import {
  createAdvisorTriggerJob,
  decideAdvisorJobCommit,
  formatAdvisorTriggerJobForTrace,
} from "../src/lib/meeting/advisor-trigger-job.js";
import type { AdvisorPromptContext } from "../src/lib/meeting/types.js";

function buildPromptContext(): AdvisorPromptContext {
  return {
    transcript: "Them: Design a cache",
    screenContext: "",
    rollingSummary: "",
    userProfileContext: "",
    glossaryText: "",
    latestTurn: {
      id: "turn-a",
      speaker: "them",
      source: "system-audio",
      text: "Design a cache",
      startedAt: 10,
      endedAt: 20,
      isFinal: true,
    },
  };
}

test("freezes the prompt inputs owned by an advisor job", () => {
  const promptContext = buildPromptContext();
  const job = createAdvisorTriggerJob({
    source: "live-turn",
    mode: "live",
    promptContext,
    sessionId: "session-a",
    snapshotTurnCount: 1,
    taskMutationAuthority: "input-evidence",
  });

  promptContext.transcript = "Them: A newer question";
  if (promptContext.latestTurn) {
    promptContext.latestTurn.text = "A newer question";
  }

  assert.equal(job.promptContextSnapshot.transcript, "Them: Design a cache");
  assert.equal(job.promptContextSnapshot.latestTurn?.text, "Design a cache");
});

test("rejects a replaced job and a job from an old meeting session", () => {
  const job = createAdvisorTriggerJob({
    source: "live-turn",
    mode: "live",
    promptContext: buildPromptContext(),
    sessionId: "session-a",
    snapshotTurnCount: 1,
    taskMutationAuthority: "input-evidence",
  });

  assert.deepEqual(
    decideAdvisorJobCommit({
      job,
      activeJobId: "newer-job",
      currentSessionId: "session-a",
    }),
    { authorized: false, reason: "active-job-mismatch" }
  );
  assert.deepEqual(
    decideAdvisorJobCommit({
      job,
      activeJobId: job.id,
      currentSessionId: "session-b",
    }),
    { authorized: false, reason: "session-mismatch" }
  );
});

test("emits the job identity needed to reconstruct ownership", () => {
  const job = createAdvisorTriggerJob({
    source: "live-turn",
    mode: "live",
    traceId: "trace-a",
    triggerTurnId: "turn-a",
    promptContext: buildPromptContext(),
    sessionId: "session-a",
    snapshotTurnCount: 3,
    taskMutationAuthority: "input-evidence",
  });

  assert.deepEqual(
    formatAdvisorTriggerJobForTrace(job, "stale-commit-rejected", {
      commitAuthorized: false,
      commitAuthorizationReason: "active-job-mismatch",
    }),
    {
      advisorJobId: job.id,
      advisorJobSource: "live-turn",
      advisorJobTriggerTurnId: "turn-a",
      advisorJobExpectedSessionId: "session-a",
      advisorJobExpectedParentId: undefined,
      advisorJobExpectedParentRevision: undefined,
      advisorJobMutationAuthority: "input-evidence",
      advisorJobSnapshotTurnCount: 3,
      advisorJobSnapshotLatestTurnId: "turn-a",
      advisorJobOutcome: "stale-commit-rejected",
      advisorJobCancellationReason: undefined,
      advisorJobCommitAuthorized: false,
      advisorJobCommitAuthorizationReason: "active-job-mismatch",
    }
  );
});
