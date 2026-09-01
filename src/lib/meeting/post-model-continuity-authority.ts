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
}): PostModelContinuityAuthority {
  if (!input.lifecycleCommittedBeforeAdvisor || !input.command) {
    return {
      owner: "settled-relation",
      lifecycleCommittedBeforeAdvisor: false,
      reason: "no-precommitted-lifecycle",
    };
  }
  if (
    input.command === "attach-child" ||
    (input.command === "update-source-attachment" && input.activeChild)
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
