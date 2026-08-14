export type RuntimeSemanticAxis =
  | "response-opportunity"
  | "question-type"
  | "task-relation"
  | "artifact-intent";

export interface RuntimeAxisProposal<TValue extends string = string> {
  source: string;
  value?: TValue;
  eligible: boolean;
  productionEligible: boolean;
}

export interface RuntimeAxisConflictDecision<
  TValue extends string = string,
> {
  axis: RuntimeSemanticAxis;
  conflict: boolean;
  reason:
    | "eligible-proposals-disagree"
    | "eligible-proposals-agree"
    | "insufficient-eligible-proposals";
  eligibleProposalCount: number;
  sources: string[];
  values: TValue[];
}

export function detectRuntimeAxisConflict<
  TValue extends string,
>(input: {
  axis: RuntimeSemanticAxis;
  proposals: RuntimeAxisProposal<TValue>[];
}): RuntimeAxisConflictDecision<TValue> {
  const eligible = input.proposals.filter(
    (proposal): proposal is RuntimeAxisProposal<TValue> & {
      value: TValue;
    } =>
      proposal.eligible &&
      proposal.productionEligible &&
      Boolean(proposal.value)
  );
  const values = Array.from(
    new Set(eligible.map((proposal) => proposal.value))
  );

  return {
    axis: input.axis,
    conflict: values.length > 1,
    reason:
      eligible.length < 2
        ? "insufficient-eligible-proposals"
        : values.length > 1
          ? "eligible-proposals-disagree"
          : "eligible-proposals-agree",
    eligibleProposalCount: eligible.length,
    sources: eligible.map((proposal) => proposal.source),
    values,
  };
}

export function formatRuntimeAxisConflictForTrace(
  decision: RuntimeAxisConflictDecision | undefined,
  prefix = "runtimeAxis"
): Record<string, unknown> {
  if (!decision) return {};
  return {
    [`${prefix}ConflictAxis`]: decision.axis,
    [`${prefix}ConflictDetected`]: decision.conflict,
    [`${prefix}ConflictReason`]: decision.reason,
    [`${prefix}ConflictEligibleProposalCount`]:
      decision.eligibleProposalCount,
    [`${prefix}ConflictSources`]: decision.sources,
    [`${prefix}ConflictValues`]: decision.values,
  };
}
