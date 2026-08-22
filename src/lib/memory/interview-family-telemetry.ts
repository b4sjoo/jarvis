import {
  MEMORY_INTERVIEW_FAMILY_RESOLUTION_VERSION,
  type MemoryInterviewFamilyEvidence,
  type MemoryInterviewFamilyGateDecision,
} from "./interview-family.js";
import type {
  MemoryInterviewFamilyResolutionTelemetry,
  MemoryRejectSummary,
} from "./types.js";

export function createMemoryInterviewFamilyResolutionRecorder() {
  const records: Array<{
    entryId: string;
    decision: MemoryInterviewFamilyGateDecision;
  }> = [];

  return {
    record(entryId: string, decision: MemoryInterviewFamilyGateDecision) {
      records.push({ entryId, decision });
    },
    summary(
      selectedEntryIds: string[],
      evaluationMs = 0
    ): MemoryInterviewFamilyResolutionTelemetry {
      const selected = new Set(selectedEntryIds);
      const allowReasons: Record<string, number> = {};
      const rejectReasons: Record<string, number> = {};
      let specificFamilyDominanceCount = 0;
      let genericSubstringSuppressedCount = 0;
      let explicitMultiFamilyEntryCount = 0;
      let independentGenericEvidenceCount = 0;
      let familyPolicyAllowCount = 0;
      let familyPolicyRejectCount = 0;

      for (const record of records) {
        const { decision } = record;
        if (decision.resolution.suppressedEvidence.length) {
          specificFamilyDominanceCount += 1;
        }
        genericSubstringSuppressedCount +=
          decision.resolution.suppressedEvidence.filter(
            (item) => item.family === "system-design"
          ).length;
        if (decision.resolution.resolutionReason === "explicit-multi-family") {
          explicitMultiFamilyEntryCount += 1;
        }
        if (
          decision.resolution.resolutionReason ===
            "independent-inferred-evidence" &&
          decision.resolution.families.includes("ai-ml-system-design") &&
          decision.resolution.families.includes("system-design")
        ) {
          independentGenericEvidenceCount += 1;
        }
        if (decision.rejectReason) {
          familyPolicyRejectCount += 1;
          incrementReason(rejectReasons, decision.rejectReason);
        } else {
          familyPolicyAllowCount += 1;
          incrementReason(allowReasons, decision.disposition);
        }
      }

      const samples = records
        .map(({ entryId, decision }) => ({
          entryId,
          finalFamilies: [...decision.resolution.families],
          source: decision.resolution.source,
          resolutionReason: decision.resolution.resolutionReason,
          disposition: decision.disposition,
          rejectReason: decision.rejectReason,
          selected: selected.has(entryId),
          evidence: decision.resolution.evidenceDetails
            .slice(0, 8)
            .map(toTelemetryEvidence),
          suppressedEvidence: decision.resolution.suppressedEvidence
            .slice(0, 8)
            .map(toTelemetryEvidence),
        }))
        .filter(
          (item) =>
            item.selected ||
            item.suppressedEvidence.length > 0 ||
            item.resolutionReason === "explicit-multi-family" ||
            item.resolutionReason === "independent-inferred-evidence"
        )
        .sort(
          (left, right) =>
            Number(right.selected) - Number(left.selected) ||
            right.suppressedEvidence.length - left.suppressedEvidence.length ||
            left.entryId.localeCompare(right.entryId)
        )
        .slice(0, 20);

      return {
        resolutionVersion: MEMORY_INTERVIEW_FAMILY_RESOLUTION_VERSION,
        evaluationMs,
        specificFamilyDominanceCount,
        genericSubstringSuppressedCount,
        explicitMultiFamilyEntryCount,
        independentGenericEvidenceCount,
        familyPolicyAllowCount,
        familyPolicyRejectCount,
        familyPolicyAllowReasons: allowReasons,
        familyPolicyRejectReasons: rejectReasons,
        samples,
      };
    },
  };
}

export function formatMemoryInterviewFamilyResolutionForTrace(
  telemetry: MemoryInterviewFamilyResolutionTelemetry | undefined
) {
  if (!telemetry) return {};
  return {
    memoryInterviewFamilyResolutionVersion: telemetry.resolutionVersion,
    memoryInterviewFamilyPolicyMs: telemetry.evaluationMs,
    memorySpecificFamilyDominanceCount:
      telemetry.specificFamilyDominanceCount,
    memoryGenericSubstringSuppressedCount:
      telemetry.genericSubstringSuppressedCount,
    memoryExplicitMultiFamilyEntryCount:
      telemetry.explicitMultiFamilyEntryCount,
    memoryIndependentGenericEvidenceCount:
      telemetry.independentGenericEvidenceCount,
    memoryFamilyPolicyAllowCount: telemetry.familyPolicyAllowCount,
    memoryFamilyPolicyRejectCount: telemetry.familyPolicyRejectCount,
    memoryFamilyPolicyAllowReasons: telemetry.familyPolicyAllowReasons,
    memoryFamilyPolicyRejectReasons: telemetry.familyPolicyRejectReasons,
    memoryInterviewFamilyResolutionSamples: telemetry.samples,
  };
}

export function formatMemoryInterviewTypePriorIsolationForTrace(
  rejectSummary: MemoryRejectSummary[]
) {
  const rightFamilyBlockedByPriorCount = rejectSummary
    .filter((item) => item.reason === "brief-interview-type-blocked")
    .reduce((total, item) => total + item.count, 0);
  const unknownSpecializedFamilyBlockedCount = rejectSummary
    .filter(
      (item) => item.reason === "unknown-question-type-family-blocked"
    )
    .reduce((total, item) => total + item.count, 0);

  return {
    rightFamilyBlockedByPriorCount,
    memoryPriorUsedAsExecutionGate: rightFamilyBlockedByPriorCount > 0,
    unknownSpecializedFamilyBlockedCount,
  };
}

function toTelemetryEvidence(item: MemoryInterviewFamilyEvidence) {
  return {
    family: item.family,
    sourceKind: item.sourceKind,
    sourceValueHash: item.sourceValueHash,
    explicit: item.explicit,
    suppressedBySpecificFamily: item.suppressedBySpecificFamily,
  };
}

function incrementReason(target: Record<string, number>, reason: string) {
  target[reason] = (target[reason] ?? 0) + 1;
}
