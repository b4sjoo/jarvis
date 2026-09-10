import type { ActiveMeetingTask } from "./meeting-task-contracts.js";

import type {
  PersonalEvidenceDecision,
  PersonalEvidenceStatusDomain,
  PersonalStatusDomain,
  TransientPersonalStatusDecision,
} from "./types.js";

const PERSONAL_STATUS_DOMAIN_MAP: Partial<
  Record<PersonalEvidenceStatusDomain, PersonalStatusDomain>
> = {
  "location-relocation": "relocation",
  compensation: "compensation",
  "work-authorization": "work-authorization",
  "availability-start-date": "start-date",
};

export function resolveTransientPersonalStatusDecision(input: {
  personalEvidenceDecision: PersonalEvidenceDecision;
  sourceQuestionUnitId?: string;
  sourceQuestionRevision?: number;
  activeMeetingTask?: ActiveMeetingTask;
  createdAt?: number;
}): TransientPersonalStatusDecision | undefined {
  const evidence = input.personalEvidenceDecision;
  const domain = evidence.statusDomain
    ? PERSONAL_STATUS_DOMAIN_MAP[evidence.statusDomain]
    : undefined;
  if (
    !domain ||
    !input.sourceQuestionUnitId ||
    input.sourceQuestionRevision === undefined ||
    evidence.requirement !== "personal-logistics" ||
    evidence.confidenceTier !== "high" ||
    evidence.confidence < 0.9
  ) {
    return undefined;
  }

  const createdAt = input.createdAt ?? Date.now();
  const preservedParent = input.activeMeetingTask?.parent;
  return deepFreeze({
    id: `personal_status_${hashStableText(
      [
        input.sourceQuestionUnitId,
        input.sourceQuestionRevision,
        domain,
      ].join("|")
    )}`,
    domain,
    sourceQuestionUnitId: input.sourceQuestionUnitId,
    sourceQuestionRevision: input.sourceQuestionRevision,
    responseOwner: "personal-status",
    evidencePolicy: "profile-only",
    disposition: "domain-resolved-unknown",
    confidence: evidence.confidence,
    preserveParentTask: true,
    preserveArtifacts: true,
    preservedParentTaskId: preservedParent?.id,
    preservedParentQuestionType: preservedParent?.questionType,
    preservedPlaybookPhase: preservedParent?.playbookPhase,
    preservedWhiteboardArtifactId:
      preservedParent?.whiteboardArtifact?.id,
    createdAt,
  });
}

export function formatTransientPersonalStatusLabel(
  domain: PersonalStatusDomain
) {
  const label = {
    relocation: "Relocation",
    compensation: "Compensation",
    "work-authorization": "Work Authorization",
    "start-date": "Start Date",
  }[domain];
  return `Personal Status · ${label}`;
}

export function formatTransientPersonalStatusForTrace(
  decision: TransientPersonalStatusDecision | undefined
): Record<string, unknown> {
  if (!decision) {
    return {
      transientPersonalStatusApplied: false,
    };
  }
  return {
    transientPersonalStatusApplied: true,
    transientPersonalStatusDecisionId: decision.id,
    transientPersonalStatusDomain: decision.domain,
    transientPersonalStatusLabel:
      formatTransientPersonalStatusLabel(decision.domain),
    transientPersonalStatusDisposition: decision.disposition,
    transientPersonalStatusConfidence: decision.confidence,
    transientPersonalStatusResponseOwner: decision.responseOwner,
    transientPersonalStatusEvidencePolicy: decision.evidencePolicy,
    transientPersonalStatusParentPreserved:
      decision.preserveParentTask,
    transientPersonalStatusArtifactsPreserved:
      decision.preserveArtifacts,
    transientPersonalStatusPreservedParentTaskId:
      decision.preservedParentTaskId,
    transientPersonalStatusPreservedParentQuestionType:
      decision.preservedParentQuestionType,
    transientPersonalStatusPreservedPlaybookPhase:
      decision.preservedPlaybookPhase,
    transientPersonalStatusPreservedWhiteboardArtifactId:
      decision.preservedWhiteboardArtifactId,
  };
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

function hashStableText(raw: string) {
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
