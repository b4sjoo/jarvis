import { buildHumanEvaluationObservedSnapshotV2, type HumanEvaluationObservedSnapshotV2 } from "./human-ground-truth-v2.js";
import type { MeetingTrace } from "./types.js";
import type { RuntimeRegressionCompletion } from "./runtime-regression-completion.js";
import { assertRuntimeRegressionPreconditions, compareRuntimeRegressionExpected, type RuntimeRegressionAssertion, type RuntimeRegressionEnvironment, type RuntimeRegressionScenario, type RuntimeRegressionSourceInput } from "./runtime-regression-scenario.js";

export interface RuntimeRegressionStepResult {
  runtimeSessionId: string;
  scenarioRunId: string;
  scenarioStepId: string;
  startedAt: number;
  endedAt: number;
  completion: RuntimeRegressionCompletion;
  observed?: HumanEvaluationObservedSnapshotV2;
  requestedArtifacts?: string[];
  committedArtifacts?: string[];
}
export interface RuntimeRegressionScenarioReport {
  schemaVersion: 1;
  scenarioId: string;
  scenarioRevision: number;
  procedureDigest: string;
  purpose: "regression" | "practice";
  scenarioRunId: string;
  runtimeSessionId: string;
  environment: RuntimeRegressionEnvironment;
  status: "running" | "passed" | "failed" | "unevaluated" | "stopped";
  startedAt: number;
  endedAt?: number;
  currentStepId?: string;
  firstDivergence?: { stepId: string; reason: string };
  steps: Array<{ procedureStepId: string; result: RuntimeRegressionStepResult; assertions: RuntimeRegressionAssertion[] }>;
}

export function buildRuntimeRegressionStepResult(input: Omit<RuntimeRegressionStepResult, "observed" | "requestedArtifacts" | "committedArtifacts" | "endedAt"> & {
  trace?: MeetingTrace;
  endedAt?: number;
}): RuntimeRegressionStepResult {
  const { trace, ...result } = input;
  const requested = trace?.metadata?.settledExecutionPlanRequestedArtifacts;
  return { ...result, endedAt: input.endedAt ?? Date.now(),
    observed: trace ? buildHumanEvaluationObservedSnapshotV2(trace) : undefined,
    requestedArtifacts: trace?.metadata?.settledExecutionPlanAuthorized === true && Array.isArray(requested) && requested.every(value => typeof value === "string") ? [...requested] : undefined,
    committedArtifacts: [...new Set(input.completion.facts.filter(event => event.fact === "artifact-committed" && event.refs.traceId === input.completion.traceId)
      .flatMap(event => event.refs.artifact ? [event.refs.artifact] : []))],
  };
}

// One sequential test loop. All business input goes through execute; there are
// no task/source writers, provider calls, timers or private semantic projections.
export async function executeRuntimeRegressionScenario(input: {
  scenario: RuntimeRegressionScenario;
  environment: () => RuntimeRegressionEnvironment;
  start: () => Promise<{ scenarioRunId: string; runtimeSessionId: string }>;
  execute: (value: RuntimeRegressionSourceInput, procedureStepId: string) => Promise<RuntimeRegressionStepResult>;
  stop: (report: RuntimeRegressionScenarioReport) => Promise<void>;
  progress: (report: RuntimeRegressionScenarioReport) => void;
  signal: AbortSignal;
}): Promise<RuntimeRegressionScenarioReport> {
  assertRuntimeRegressionPreconditions(input.scenario.manifest.review.preconditions, input.environment());
  if (input.signal.aborted) throw new Error("Replay was stopped before it started.");
  const run = await input.start();
  const report: RuntimeRegressionScenarioReport = {
    schemaVersion: 1, scenarioId: input.scenario.manifest.id, scenarioRevision: input.scenario.manifest.revision,
    procedureDigest: input.scenario.manifest.procedure.sha256, purpose: input.scenario.manifest.review.purpose,
    ...run, environment: input.environment(), status: "running", startedAt: Date.now(), steps: [],
  };
  const identities = new Map<string, string>();
  try {
    for (const [index, value] of input.scenario.inputs.entries()) {
      if (input.signal.aborted) { report.status = "stopped"; break; }
      const step = input.scenario.procedure.steps[index];
      report.currentStepId = step.id;
      assertRuntimeRegressionPreconditions(input.scenario.manifest.review.preconditions, input.environment());
      input.progress({ ...report, steps: report.steps.slice() });
      const result = await input.execute(value, step.id);
      if (result.scenarioRunId !== run.scenarioRunId || result.runtimeSessionId !== run.runtimeSessionId) throw new Error("Replay result belongs to another run.");
      const assertions = compareRuntimeRegressionExpected(step.expected, result.observed, identities, result);
      report.steps.push({ procedureStepId: step.id, result, assertions });
      const unexpectedFailure = ["error", "rejected", "cancelled", "stale"].includes(result.completion.disposition) &&
        step.expected?.terminalDisposition !== result.completion.disposition;
      const mismatch = assertions.find(item => item.verdict === "fail");
      const missing = assertions.length === 0 || assertions.some(item => item.verdict === "unevaluated");
      if (input.signal.aborted) { report.status = "stopped"; break; }
      if (unexpectedFailure || mismatch || (report.purpose === "regression" && missing)) {
        report.status = unexpectedFailure || mismatch ? "failed" : "unevaluated";
        report.firstDivergence = { stepId: step.id, reason: unexpectedFailure ? result.completion.reason ?? result.completion.disposition
          : mismatch ? `Expected/Observed mismatch: ${mismatch.field}.` : "Required comparison evidence is unavailable." };
        break;
      }
      input.progress({ ...report, steps: report.steps.slice() });
    }
    if (report.status === "running") report.status = report.purpose === "practice" ? "unevaluated" : "passed";
  } catch (error) {
    report.status = input.signal.aborted ? "stopped" : "failed";
    report.firstDivergence = { stepId: report.currentStepId ?? "preflight", reason: error instanceof Error ? error.message : "Replay execution failed." };
  } finally {
    report.endedAt = Date.now();
    input.progress({ ...report, steps: report.steps.slice() });
    await input.stop(report);
  }
  return report;
}
