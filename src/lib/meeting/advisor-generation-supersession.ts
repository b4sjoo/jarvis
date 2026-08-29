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
  if (input.incomingJob.refreshAuthority.kind === "runtime-type-adjudication-output-only") {
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

export interface ManualScreenAdvisorSupersessionCandidate {
  candidateId: string;
  advisorJobId?: string;
  generationLeaseId?: string;
  source: string;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId?: string | null;
  logicalQuestionRevision?: number | null;
}

export interface ManualScreenAdvisorSupersessionDecision {
  disposition: "supersede-automatic-voice" | "preserve";
  reason:
    | "capture-not-successful"
    | "no-voice-generation-candidate"
    | "candidate-no-longer-current"
    | "candidate-is-not-automatic-voice"
    | "session-mismatch"
    | "runtime-epoch-mismatch"
    | "missing-recovery-target"
    | "logical-question-mismatch"
    | "same-recovery-target";
  candidate?: ManualScreenAdvisorSupersessionCandidate;
}

/**
 * Manual Screen authority is deliberately evidence-only. A successful capture
 * can supersede the current automatic Voice generation for the exact recovery
 * target; it never guesses whether two questions are semantically equivalent.
 */
export function decideManualScreenAdvisorSupersession(input: {
  captureSuccessful: boolean;
  candidate?: ManualScreenAdvisorSupersessionCandidate;
  candidateStillCurrent: boolean;
  currentSessionId: string;
  currentRuntimeEpoch: number;
  recoveryTarget?: {
    logicalQuestionUnitId: string;
    logicalQuestionRevision: number;
  };
}): ManualScreenAdvisorSupersessionDecision {
  const candidate = input.candidate;
  if (!input.captureSuccessful) {
    return {
      disposition: "preserve",
      reason: "capture-not-successful",
      candidate,
    };
  }
  if (!candidate) {
    return {
      disposition: "preserve",
      reason: "no-voice-generation-candidate",
    };
  }
  if (!input.candidateStillCurrent) {
    return {
      disposition: "preserve",
      reason: "candidate-no-longer-current",
      candidate,
    };
  }
  if (candidate.source !== "live-turn") {
    return {
      disposition: "preserve",
      reason: "candidate-is-not-automatic-voice",
      candidate,
    };
  }
  if (candidate.sessionId !== input.currentSessionId) {
    return {
      disposition: "preserve",
      reason: "session-mismatch",
      candidate,
    };
  }
  if (candidate.runtimeEpoch !== input.currentRuntimeEpoch) {
    return {
      disposition: "preserve",
      reason: "runtime-epoch-mismatch",
      candidate,
    };
  }
  if (!input.recoveryTarget) {
    return {
      disposition: "preserve",
      reason: "missing-recovery-target",
      candidate,
    };
  }
  if (
    candidate.logicalQuestionUnitId !==
      input.recoveryTarget.logicalQuestionUnitId ||
    candidate.logicalQuestionRevision !==
      input.recoveryTarget.logicalQuestionRevision
  ) {
    return {
      disposition: "preserve",
      reason: "logical-question-mismatch",
      candidate,
    };
  }
  return {
    disposition: "supersede-automatic-voice",
    reason: "same-recovery-target",
    candidate,
  };
}

export function formatManualScreenAdvisorSupersessionForTrace(
  decision: ManualScreenAdvisorSupersessionDecision
) {
  return {
    manualScreenSupersessionDisposition: decision.disposition,
    manualScreenSupersessionReason: decision.reason,
    manualScreenSupersessionCandidateId: decision.candidate?.candidateId,
    manualScreenSupersessionAdvisorJobId: decision.candidate?.advisorJobId,
    manualScreenSupersessionGenerationLeaseId:
      decision.candidate?.generationLeaseId,
    manualScreenSupersessionSource: decision.candidate?.source,
    manualScreenSupersessionLogicalQuestionUnitId:
      decision.candidate?.logicalQuestionUnitId,
    manualScreenSupersessionLogicalQuestionRevision:
      decision.candidate?.logicalQuestionRevision,
  };
}
