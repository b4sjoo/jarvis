import assert from "node:assert/strict";
import test from "node:test";
import {
  createScreenPreflightDeadlineArbiter,
  formatScreenPreflightDeadlineDecisionForTrace,
} from "../src/lib/meeting/screen-preflight-deadline.js";
import { buildCompactTraceSummary } from "../src/lib/meeting/session-recording.js";
import type { MeetingTrace } from "../src/lib/meeting/types.js";

function createHarness(nowValue = 1_000) {
  let now = nowValue;
  let scheduled: (() => void) | undefined;
  let cancelled = false;
  const lateResults: unknown[] = [];
  const arbiter = createScreenPreflightDeadlineArbiter<{
    questionType: string;
  }>({
    operationId: "screen-op-1",
    leaseRevision: 1,
    startedAt: 1_000,
    timeoutMs: 10_000,
    now: () => now,
    schedule: (callback) => {
      scheduled = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    cancelSchedule: () => {
      cancelled = true;
    },
    onLateResult: (observation) => lateResults.push(observation),
  });
  return {
    arbiter,
    setNow: (value: number) => {
      now = value;
    },
    fireDeadline: () => scheduled?.(),
    wasCancelled: () => cancelled,
    lateResults,
  };
}

test("commits a parsed result completed before the deadline", async () => {
  const harness = createHarness();
  harness.setNow(8_500);
  assert.equal(
    harness.arbiter.observeParsedResult({
      result: { questionType: "behavioral" },
      providerCompletedAt: 8_300,
      parseCompletedAt: 8_400,
      canonicalQuestionType: "behavioral",
      confidence: 1,
    }),
    true
  );

  const resolution = await harness.arbiter.waitForDecision();
  assert.equal(resolution.decision.outcome, "valid-result");
  assert.equal(resolution.result?.questionType, "behavioral");
  assert.equal(harness.wasCancelled(), true);
});

test("parse completion wins even when later bookkeeping crosses the deadline", async () => {
  const harness = createHarness();
  harness.setNow(10_990);
  harness.arbiter.observeParsedResult({
    result: { questionType: "general_system_design" },
    providerCompletedAt: 10_900,
    parseCompletedAt: 10_990,
    canonicalQuestionType: "general-system-design",
  });
  harness.setNow(11_500);
  harness.fireDeadline();

  const resolution = await harness.arbiter.waitForDecision();
  assert.equal(resolution.decision.outcome, "valid-result");
  assert.equal(resolution.decision.parseCompletedAt, 10_990);
});

test("provider completion before the deadline cannot authorize a late parse", async () => {
  const harness = createHarness();
  harness.arbiter.observeProviderCompletion(10_900);
  harness.setNow(11_100);
  harness.arbiter.observeParsedResult({
    result: { questionType: "behavioral" },
    providerCompletedAt: 10_900,
    parseCompletedAt: 11_050,
    canonicalQuestionType: "behavioral",
  });

  const resolution = await harness.arbiter.waitForDecision();
  assert.equal(resolution.decision.outcome, "fallback");
  assert.equal(resolution.decision.fallbackReason, "timeout");
  assert.equal(harness.lateResults.length, 1);
});

test("commits one timeout fallback and records a later result without mutation", async () => {
  const harness = createHarness();
  harness.setNow(11_000);
  harness.fireDeadline();
  const resolution = await harness.arbiter.waitForDecision();

  harness.setNow(11_500);
  assert.equal(
    harness.arbiter.observeParsedResult({
      result: { questionType: "coding" },
      providerCompletedAt: 11_300,
      parseCompletedAt: 11_400,
      canonicalQuestionType: "coding",
      confidence: 0.98,
    }),
    false
  );
  assert.equal(resolution.decision.outcome, "fallback");
  assert.equal(harness.arbiter.readDecision(), resolution.decision);
  assert.equal(harness.lateResults.length, 1);
});

test("commits provider, parse, and abort failures without waiting for timeout", async () => {
  for (const reason of [
    "provider-failure",
    "parse-failure",
    "aborted",
  ] as const) {
    const harness = createHarness();
    harness.setNow(2_000);
    assert.equal(harness.arbiter.observeFailure(reason), true);
    const resolution = await harness.arbiter.waitForDecision();
    assert.equal(resolution.decision.fallbackReason, reason);
  }
});

test("formats one bounded committed decision for trace consumers", async () => {
  const harness = createHarness();
  harness.setNow(3_000);
  harness.arbiter.observeParsedResult({
    result: { questionType: "behavioral" },
    providerCompletedAt: 2_800,
    parseCompletedAt: 2_900,
    canonicalQuestionType: "behavioral",
  });
  const resolution = await harness.arbiter.waitForDecision();
  const trace = formatScreenPreflightDeadlineDecisionForTrace(
    resolution.decision
  );

  assert.equal(trace.screenPreflightDeadlineOutcome, "valid-result");
  assert.equal(trace.screenPreflightParsedBeforeDeadline, true);
  assert.equal(trace.screenPreflightCommittedQuestionType, "behavioral");
});

test("persists deadline and late-result evidence in the compact recording summary", () => {
  const trace: MeetingTrace = {
    id: "screen-trace-1",
    kind: "screen",
    status: "success",
    startedAt: 1_000,
    endedAt: 12_000,
    durationMs: 11_000,
    steps: [],
    inputs: [],
    outputs: [],
    metadata: {
      screenPreflightOperationId: "screen-op-1",
      screenPreflightLeaseRevision: 1,
      screenPreflightStartedAt: 1_000,
      screenPreflightDeadlineAt: 11_000,
      screenPreflightProviderCompletedAt: 10_900,
      screenPreflightCommittedAt: 11_000,
      screenPreflightDeadlineOutcome: "fallback",
      screenPreflightFallbackReason: "timeout",
      screenPreflightParsedBeforeDeadline: false,
      screenPreflightLateResultObserved: true,
      screenPreflightLateQuestionType: "behavioral",
      screenPreflightLateConfidence: 1,
      screenPreflightConsumerCoherent: true,
      screenPreflightConsumerConflicts: [],
    },
  };

  const summary = buildCompactTraceSummary({
    sessionId: "session-1",
    trace,
    trigger: "manual",
    traceExportPath: "traces/screen-trace-1/trace.json",
    summaryPath: "traces/screen-trace-1/summary.json",
  });

  assert.deepEqual(summary.screenPreflightDeadline, {
    operationId: "screen-op-1",
    leaseRevision: 1,
    startedAt: 1_000,
    deadlineAt: 11_000,
    providerCompletedAt: 10_900,
    parseCompletedAt: undefined,
    committedAt: 11_000,
    outcome: "fallback",
    fallbackReason: "timeout",
    parsedBeforeDeadline: false,
    committedQuestionType: undefined,
    consumerCoherent: true,
    consumerConflicts: [],
    lateResultObserved: true,
    lateQuestionType: "behavioral",
    lateConfidence: 1,
  });
});
