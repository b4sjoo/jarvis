import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHumanEvaluationObservedSnapshotV2,
  createHumanGroundTruthEventV2,
  deriveHumanEvaluationProjectionV2,
  type HumanEvaluationProjectionV2,
} from "../src/lib/meeting/human-ground-truth-v2.js";
import { buildCompactTraceSummary } from "../src/lib/meeting/session-recording.js";
import { buildSessionLongitudinalEvaluationReport } from "../src/lib/meeting/session-longitudinal-evaluation.js";
import type { MeetingTrace } from "../src/lib/meeting/types.js";
import { PROJECT_TRAJECTORY_EXPERTISE_REPLAY } from "./fixtures/project-trajectory-expertise-session.js";

test("replays a sanitized project trajectory with joined evaluation evidence", () => {
  const projections: HumanEvaluationProjectionV2[] = [];
  const summaries = PROJECT_TRAJECTORY_EXPERTISE_REPLAY.turns.map(
    (turn, index) => {
      const trace = makeTrace(turn.id, turn.metadata, index);
      const summary = buildCompactTraceSummary({
        sessionId: "session-sanitized-expertise",
        trace,
        trigger: "manual",
        traceExportPath: `traces/${trace.id}/trace.json`,
        summaryPath: `traces/${trace.id}/summary.json`,
      });

      if (!turn.expected) {
        assert.equal(summary.projectTrajectory, undefined);
        return summary;
      }

      assert.equal(
        summary.projectTrajectory?.projectId,
        turn.expected.projectId
      );
      assert.equal(
        summary.projectTrajectory?.phase,
        turn.expected.phase
      );
      assert.equal(
        summary.projectTrajectory?.factAnchorState,
        turn.expected.factAnchorState
      );
      assert.match(
        summary.projectTrajectory?.joinKey ?? "",
        new RegExp(`${trace.id}:parent-sanitized-project:1$`)
      );

      const observed = buildHumanEvaluationObservedSnapshotV2(trace);
      const event = createHumanGroundTruthEventV2({
        sessionId: "session-sanitized-expertise",
        subject: {
          questionId: `question:${turn.id}`,
          taskId: PROJECT_TRAJECTORY_EXPERTISE_REPLAY.parentId,
          traceIds: [trace.id],
          sourceTurnIds: [`turn:${turn.id}`],
        },
        fact: {
          kind: "expected-project-trajectory",
          expectedProjectId: turn.expected.projectId,
          expectedProjectName: turn.expected.projectName,
          expectedPhase: turn.expected.phase,
          expectedFactAnchorState: turn.expected.factAnchorState,
          expectedChildContinuity: turn.expected.childContinuity,
          unsupportedFirstPersonClaim: false,
        },
        source: "explicit-ui",
        now: 10_000 + index,
      });
      const projection = deriveHumanEvaluationProjectionV2({
        sessionId: "session-sanitized-expertise",
        subject: event.subject,
        events: [event],
        observed,
        now: 20_000 + index,
      });

      assert.equal(projection.verdicts.projectCorrect, true);
      assert.equal(projection.verdicts.playbookPhaseCorrect, true);
      assert.equal(projection.verdicts.factSupportCorrect, true);
      assert.equal(projection.verdicts.childContinuityCorrect, true);
      assert.equal(
        projection.verdicts.unsupportedFirstPersonClaim,
        false
      );
      projections.push(projection);
      return summary;
    }
  );

  assert.deepEqual(
    summaries
      .map((summary) => summary.projectTrajectory?.phase)
      .filter(Boolean),
    [
      "project_narrative",
      "architecture_decision",
      "architecture_decision",
      "architecture_decision",
      "validation_reliability",
      "impact_lessons",
    ]
  );
  assert.equal(
    summaries[3].projectTrajectory?.returnPhase,
    "architecture_decision"
  );
  assert.equal(
    summaries[4].projectTrajectory?.transitionKind,
    "resume-parent"
  );
  assert.equal(
    summaries[5].projectTrajectory?.claimSupportRejectCount,
    1
  );
  assert.equal(
    summaries[5].projectTrajectory?.claimSupportClarificationCount,
    1
  );

  const serialized = JSON.stringify(summaries);
  assert.equal(serialized.includes("memoryContext"), false);
  assert.equal(serialized.includes("contextText"), false);
  assert.equal(serialized.includes("supportSpan"), false);

  const scorecard = buildSessionLongitudinalEvaluationReport([
    {
      directory: "/sanitized/session",
      manifest: { sessionId: "session-sanitized-expertise" },
      transcriptTurns: [],
      traceSummaries: summaries,
      questionEvaluations: [],
      humanEvaluationProjectionsV2: projections,
    },
  ]);
  assert.equal(scorecard.projectTrajectoryFunnel.observedTraces, 6);
  assert.equal(scorecard.projectTrajectoryFunnel.humanLabeled, 6);
  assert.equal(scorecard.projectTrajectoryFunnel.projectAgreement.rate, 1);
  assert.equal(scorecard.projectTrajectoryFunnel.phaseAgreement.rate, 1);
  assert.equal(scorecard.projectTrajectoryFunnel.factSupportAgreement.rate, 1);
  assert.equal(
    scorecard.projectTrajectoryFunnel.childContinuityAgreement.rate,
    1
  );
  assert.equal(scorecard.projectTrajectoryFunnel.phaseRestartCount, 0);
  assert.equal(scorecard.projectTrajectoryFunnel.childResumeObserved, 1);
  assert.equal(scorecard.projectTrajectoryFunnel.childResumeSuccessRate.rate, 1);
});

function makeTrace(
  id: string,
  metadata: Record<string, unknown>,
  index: number
): MeetingTrace {
  return {
    id: `trace:${id}`,
    kind: "voice",
    status: "success",
    startedAt: 1_000 + index * 100,
    endedAt: 1_050 + index * 100,
    durationMs: 50,
    steps: [],
    inputs: [],
    outputs: [],
    metadata,
  };
}
