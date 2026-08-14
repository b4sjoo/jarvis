export type AdvisorGenerationAdmissionAction =
  | "activate"
  | "replace-before-execution"
  | "replace-with-settled-authority"
  | "hold-supersession-pending";

export interface AdvisorGenerationAdmissionDecision {
  action: AdvisorGenerationAdmissionAction;
  reason:
    | "no-active-generation"
    | "same-generation"
    | "active-generation-not-started"
    | "explicit-hard-override"
    | "settled-runtime-repair"
    | "automatic-candidate-awaits-active-terminal";
  protectActiveGeneration: boolean;
}

interface AdvisorGenerationAdmissionJob {
  id: string;
  refreshAuthority: {
    hardOverride: boolean;
    kind: string;
  };
}

/**
 * Admission is intentionally mechanical. It does not guess whether adjacent
 * transcript text is a replacement, restatement, or lexical repair.
 */
export function decideAdvisorGenerationAdmission(input: {
  activeJob?: AdvisorGenerationAdmissionJob | null;
  incomingJob: AdvisorGenerationAdmissionJob;
  activeJobWaitingForDebounce: boolean;
}): AdvisorGenerationAdmissionDecision {
  const activeJob = input.activeJob;
  if (!activeJob) {
    return {
      action: "activate",
      reason: "no-active-generation",
      protectActiveGeneration: false,
    };
  }
  if (activeJob.id === input.incomingJob.id) {
    return {
      action: "activate",
      reason: "same-generation",
      protectActiveGeneration: false,
    };
  }
  if (input.incomingJob.refreshAuthority.hardOverride) {
    return {
      action: "replace-with-settled-authority",
      reason: "explicit-hard-override",
      protectActiveGeneration: false,
    };
  }
  if (input.incomingJob.refreshAuthority.kind === "runtime-type-repair") {
    return {
      action: "replace-with-settled-authority",
      reason: "settled-runtime-repair",
      protectActiveGeneration: false,
    };
  }
  if (input.activeJobWaitingForDebounce) {
    return {
      action: "replace-before-execution",
      reason: "active-generation-not-started",
      protectActiveGeneration: false,
    };
  }
  return {
    action: "hold-supersession-pending",
    reason: "automatic-candidate-awaits-active-terminal",
    protectActiveGeneration: true,
  };
}

export function formatAdvisorGenerationAdmissionForTrace(
  decision: AdvisorGenerationAdmissionDecision
) {
  return {
    generationSupersessionAdmission: decision.action,
    generationSupersessionAdmissionReason: decision.reason,
    generationSupersessionProtectsActive:
      decision.protectActiveGeneration,
  };
}
