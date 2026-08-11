import type {
  CallPlanState,
  CaseState,
  SnapshotState,
  StatementReviewState,
} from "./types.js";

const transitions = <T extends string>(entries: Record<T, readonly T[]>) =>
  entries;

export const CASE_TRANSITIONS = transitions<CaseState>({
  open: ["waiting", "resolved", "archived"],
  waiting: ["open", "resolved", "archived"],
  resolved: ["open", "archived"],
  archived: ["open"],
});

export const CALL_PLAN_TRANSITIONS = transitions<CallPlanState>({
  draft: ["ready", "superseded"],
  ready: ["draft", "used", "superseded"],
  used: ["superseded"],
  superseded: [],
});

export const SNAPSHOT_TRANSITIONS = transitions<SnapshotState>({
  draft: ["ready", "invalidated"],
  ready: ["superseded", "invalidated"],
  superseded: ["invalidated"],
  invalidated: [],
});

export const STATEMENT_REVIEW_TRANSITIONS =
  transitions<StatementReviewState>({
    proposed: ["confirmed", "rejected", "superseded"],
    confirmed: ["superseded"],
    rejected: ["proposed", "superseded"],
    superseded: [],
  });

export function requireTransition<T extends string>(input: {
  entity: string;
  from: T;
  to: T;
  allowed: Record<T, readonly T[]>;
}) {
  if (input.from === input.to) return;
  if (!input.allowed[input.from].includes(input.to)) {
    throw new Error(
      `${input.entity} cannot transition from ${input.from} to ${input.to}.`
    );
  }
}

export function requireCaseScope(input: {
  expectedCaseId: string;
  actualCaseId: string;
  entity: string;
}) {
  if (input.expectedCaseId !== input.actualCaseId) {
    throw new Error(`${input.entity} belongs to a different case.`);
  }
}

export function requireExpectedRevision(input: {
  entity: string;
  expected: number;
  actual: number;
}) {
  if (input.expected !== input.actual) {
    throw new Error(
      `${input.entity} revision conflict: expected ${input.expected}, current ${input.actual}.`
    );
  }
}

export function requireStatementConfirmation(input: {
  reviewState: StatementReviewState;
  sourceCount: number;
  highImpact: boolean;
}) {
  if (input.reviewState !== "proposed" && input.reviewState !== "rejected") {
    throw new Error("Only a proposed or rejected statement can be confirmed.");
  }
  if (input.highImpact && input.sourceCount === 0) {
    throw new Error("High-impact statements require a source before confirmation.");
  }
}
