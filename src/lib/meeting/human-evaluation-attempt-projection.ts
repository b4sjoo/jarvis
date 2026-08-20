import { resolveHumanEvaluationAttemptIdentityV2 } from "./human-evaluation-attempt.js";
import {
  buildHumanEvaluationProjectionMaterializationRevisionV2,
} from "./human-evaluation-projection-materialization.js";
import {
  buildHumanEvaluationObservedSnapshotV2,
  buildHumanGroundTruthSubjectV2,
  deriveHumanEvaluationProjectionV2,
  upsertHumanEvaluationProjectionV2,
  type HumanEvaluationProjectionV2,
  type HumanGroundTruthEventV2,
} from "./human-ground-truth-v2.js";
import type { MeetingTrace } from "./types.js";

export function materializeHumanEvaluationAttemptProjectionV2(input: {
  trace: MeetingTrace;
  currentSessionId: string;
  events: HumanGroundTruthEventV2[];
  projections: HumanEvaluationProjectionV2[];
  now?: number;
}) {
  const identity = resolveHumanEvaluationAttemptIdentityV2(input.trace);
  if (!identity || identity.sessionId !== input.currentSessionId) {
    return {
      changed: false,
      projections: input.projections,
      projection: undefined,
      reason: identity ? "session-mismatch" : "settlement-incomplete",
    } as const;
  }

  const subject = buildHumanGroundTruthSubjectV2({ trace: input.trace });
  const projection = deriveHumanEvaluationProjectionV2({
    sessionId: identity.sessionId,
    subject,
    events: input.events,
    observed: buildHumanEvaluationObservedSnapshotV2(input.trace),
    now: input.now,
  });
  const existing = input.projections.find(
    (candidate) => candidate.subject.attemptId === identity.attemptId
  );
  if (
    existing &&
    buildHumanEvaluationProjectionMaterializationRevisionV2(existing) ===
      buildHumanEvaluationProjectionMaterializationRevisionV2(projection)
  ) {
    return {
      changed: false,
      projections: input.projections,
      projection: existing,
      reason: "unchanged",
    } as const;
  }

  return {
    changed: true,
    projections: upsertHumanEvaluationProjectionV2(
      input.projections,
      projection
    ),
    projection,
    reason: existing ? "refreshed" : "created",
  } as const;
}
