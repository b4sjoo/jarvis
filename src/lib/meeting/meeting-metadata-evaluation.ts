import { normalizeInterviewBriefCompany } from "./interview-company.js";

export type MeetingMetadataEvaluationErrorKind =
  | "missed-target-company"
  | "wrong-target-company"
  | "comparison-as-target"
  | "candidate-history-as-target"
  | "location-as-target"
  | "product-as-target"
  | "locked-brief-overridden"
  | "other";

export type MeetingMetadataMutationDisposition =
  | "commit"
  | "preserve"
  | "abstain";

export interface MeetingMetadataEvaluationObservation {
  operationObserved: boolean;
  operationId?: string;
  mode?: string;
  disposition?: string;
  mutationDisposition?: string;
  mutationOutcome: MeetingMetadataMutationDisposition;
  proposalCompany?: string;
  committedCompany?: string;
  authoritativeCompany?: string;
  effectiveCompany?: string;
  authoritySource?: string;
  comparisonDisposition?: string;
  staleReason?: string;
  appliedToRuntime?: boolean;
  overrideOccurred: boolean;
}

export function projectMeetingMetadataEvaluationObservation(
  metadata: Record<string, unknown>
): MeetingMetadataEvaluationObservation {
  const operationId = readString(
    metadata.meetingMetadataInferenceOperationId
  );
  const mode = readString(metadata.meetingMetadataInferenceMode);
  const disposition = readString(
    metadata.meetingMetadataInferenceDisposition
  );
  const mutationDisposition = readString(
    metadata.meetingMetadataInferenceMutationDisposition
  );
  const proposalCompany = readString(
    metadata.meetingMetadataInferenceProposalCompany
  );
  const committedCompany = readString(
    metadata.meetingMetadataInferenceCommittedCompany
  );
  const authoritativeCompany = readString(
    metadata.meetingMetadataInferenceAuthoritativeCompany
  );
  const fallbackCompany =
    readString(metadata.targetCompany) ??
    readString(metadata.screenTargetCompany);
  const effectiveCompany =
    committedCompany ?? authoritativeCompany ?? fallbackCompany;
  const authoritySource =
    readString(metadata.meetingMetadataInferenceCommittedSource) ??
    readString(metadata.meetingMetadataInferenceAuthoritativeSource) ??
    readString(metadata.targetCompanySource);
  const appliedToRuntime = readBoolean(
    metadata.meetingMetadataInferenceAppliedToRuntime
  );
  const operationObserved = Boolean(
    operationId ||
      mode ||
      disposition ||
      proposalCompany ||
      committedCompany ||
      authoritativeCompany ||
      readBoolean(metadata.meetingMetadataInferenceEligible) !== undefined
  );
  const overrideOccurred = Boolean(
    committedCompany &&
      authoritativeCompany &&
      !meetingCompanyLabelsEqual(committedCompany, authoritativeCompany)
  );

  return {
    operationObserved,
    operationId,
    mode,
    disposition,
    mutationDisposition,
    mutationOutcome: resolveMeetingMetadataMutationDisposition({
      mutationDisposition,
      proposalCompany,
      committedCompany,
      appliedToRuntime,
    }),
    proposalCompany,
    committedCompany,
    authoritativeCompany,
    effectiveCompany,
    authoritySource,
    comparisonDisposition: readString(
      metadata.meetingMetadataInferenceComparisonDisposition
    ),
    staleReason: readString(
      metadata.meetingMetadataInferenceStaleReason
    ),
    appliedToRuntime,
    overrideOccurred,
  };
}

export function resolveMeetingMetadataMutationDisposition(input: {
  mutationDisposition?: string;
  proposalCompany?: string;
  committedCompany?: string;
  appliedToRuntime?: boolean;
}): MeetingMetadataMutationDisposition {
  if (
    input.appliedToRuntime === true ||
    Boolean(input.committedCompany) ||
    input.mutationDisposition?.startsWith("committed-")
  ) {
    return "commit";
  }
  return input.proposalCompany ? "preserve" : "abstain";
}

export function meetingCompanyLabelsEqual(
  left: string | null | undefined,
  right: string | null | undefined
) {
  return (
    normalizeMeetingCompanyLabel(left) === normalizeMeetingCompanyLabel(right)
  );
}

export function normalizeMeetingCompanyLabel(
  value: string | null | undefined
) {
  if (value == null || !value.trim()) return null;
  return (
    normalizeInterviewBriefCompany(value)?.normalized ??
    value.trim().toLocaleLowerCase().replace(/\s+/g, "-")
  );
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function readBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}
