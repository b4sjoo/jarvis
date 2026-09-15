import type { SettledAdvisorExecutionPlan } from "./settled-advisor-execution-plan.js";

export type PostModelContinuityOwner =
  | "settled-relation"
  | "active-parent"
  | "active-child";

export interface PostModelContinuityAuthority {
  owner: PostModelContinuityOwner;
  lifecycleCommittedBeforeAdvisor: boolean;
  command?: string;
  reason:
    | "no-precommitted-lifecycle"
    | "committed-child-owner"
    | "committed-parent-owner";
}

export function resolvePostModelContinuityAuthority(input: {
  command?: string;
  lifecycleCommittedBeforeAdvisor: boolean;
  activeChild?: boolean;
  phaseOwnerKind?: "parent" | "child";
  validatedPlan?: Pick<SettledAdvisorExecutionPlan,
    "taskMutationPolicy" | "taskSnapshot" | "taskRelation">;
}): PostModelContinuityAuthority {
  if (!input.lifecycleCommittedBeforeAdvisor || !input.command) {
    // A previously committed owner does not need another lifecycle receipt.
    // The caller has already authorized this Plan; read scope is independent.
    const plan = input.validatedPlan;
    if (plan?.taskMutationPolicy.kind === "update-parent-context" &&
        plan.taskSnapshot?.parent &&
        (plan.taskRelation !== "child-probe" || plan.taskSnapshot.child)) {
      const child = plan.taskRelation === "child-probe";
      return {
        owner: child ? "active-child" : "active-parent",
        lifecycleCommittedBeforeAdvisor: false,
        reason: child ? "committed-child-owner" : "committed-parent-owner",
      };
    }
    return {
      owner: "settled-relation",
      lifecycleCommittedBeforeAdvisor: false,
      reason: "no-precommitted-lifecycle",
    };
  }
  if (
    input.command === "attach-child" ||
    (input.command === "update-source-attachment" && input.activeChild) ||
    (input.command === "set-phase" && input.phaseOwnerKind === "child")
  ) {
    return {
      owner: "active-child",
      lifecycleCommittedBeforeAdvisor: true,
      command: input.command,
      reason: "committed-child-owner",
    };
  }
  return {
    owner: "active-parent",
    lifecycleCommittedBeforeAdvisor: true,
    command: input.command,
    reason: "committed-parent-owner",
  };
}

export function formatPostModelContinuityAuthorityForTrace(
  authority: PostModelContinuityAuthority
) {
  return {
    postModelContinuityOwner: authority.owner,
    postModelContinuityLifecycleCommittedBeforeAdvisor:
      authority.lifecycleCommittedBeforeAdvisor,
    postModelContinuityCommand: authority.command,
    postModelContinuityReason: authority.reason,
  };
}
