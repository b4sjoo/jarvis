import assert from "node:assert/strict";
import test from "node:test";
import {
  meetingCompanyLabelsEqual,
  projectMeetingMetadataEvaluationObservation,
} from "../src/lib/meeting/meeting-metadata-evaluation.js";

test("projects proposal, authoritative state, and final authority separately", () => {
  const observation = projectMeetingMetadataEvaluationObservation({
    meetingMetadataInferenceOperationId: "metadata_1",
    meetingMetadataInferenceMode: "shadow",
    meetingMetadataInferenceDisposition: "shadow-observed",
    meetingMetadataInferenceProposalCompany: "Google",
    meetingMetadataInferenceAuthoritativeCompany: "Amazon",
    meetingMetadataInferenceAuthoritativeSource: "brief",
    meetingMetadataInferenceComparisonDisposition: "conflict",
    meetingMetadataInferenceAppliedToRuntime: false,
  });

  assert.deepEqual(observation, {
    operationObserved: true,
    operationId: "metadata_1",
    mode: "shadow",
    disposition: "shadow-observed",
    mutationDisposition: undefined,
    mutationOutcome: "preserve",
    proposalCompany: "Google",
    committedCompany: undefined,
    authoritativeCompany: "Amazon",
    effectiveCompany: "Amazon",
    authoritySource: "brief",
    comparisonDisposition: "conflict",
    staleReason: undefined,
    appliedToRuntime: false,
    overrideOccurred: false,
  });
});

test("recognizes a forbidden override without confusing aliases", () => {
  assert.equal(meetingCompanyLabelsEqual("AWS", "Amazon"), true);
  assert.equal(meetingCompanyLabelsEqual(undefined, null), true);

  const observation = projectMeetingMetadataEvaluationObservation({
    meetingMetadataInferenceCommittedCompany: "Google",
    meetingMetadataInferenceCommittedSource: "runtime-inference",
    meetingMetadataInferenceAuthoritativeCompany: "Amazon",
    meetingMetadataInferenceAppliedToRuntime: true,
  });
  assert.equal(observation.effectiveCompany, "Google");
  assert.equal(observation.overrideOccurred, true);
  assert.equal(observation.mutationOutcome, "commit");
});
