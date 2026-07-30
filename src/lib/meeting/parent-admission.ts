import {
  isParentCanonicalQuestionType,
  normalizeCanonicalQuestionType,
} from "./task-taxonomy.js";
import type {
  ActiveInterviewParent,
  InterviewTaskRelation,
  ParentAdmissionAction,
  ParentAdmissionRecord,
} from "./types.js";

export interface ParentAdmissionDecision {
  action: ParentAdmissionAction;
  durable: boolean;
  mutationAuthorized: boolean;
  reason: string;
  invalidatedState: Array<
    | "project-binding"
    | "fact-anchors"
    | "playbook-phase"
    | "child"
    | "artifacts"
  >;
}

export function decideParentAdmission(input: {
  existingParent?: ActiveInterviewParent;
  relation: InterviewTaskRelation;
  questionType?: unknown;
  mutationAuthorized: boolean;
}): ParentAdmissionDecision {
  const questionType = normalizeCanonicalQuestionType(input.questionType);

  if (input.relation === "logistics") {
    return decision("append-only", false, false, "logistics-append-only");
  }
  if (
    input.relation === "unknown" ||
    !questionType ||
    questionType === "unknown"
  ) {
    return decision(
      "provisional",
      false,
      false,
      "question-boundary-unresolved"
    );
  }
  if (!input.mutationAuthorized) {
    return decision(
      "provisional",
      false,
      false,
      "parent-mutation-not-authorized"
    );
  }
  if (
    input.relation !== "new-parent" ||
    !isParentCanonicalQuestionType(questionType)
  ) {
    return decision(
      "preserve-parent",
      Boolean(input.existingParent),
      false,
      "relation-does-not-create-parent"
    );
  }

  if (isProvisionalParent(input.existingParent)) {
    return {
      action: "reseed-parent",
      durable: true,
      mutationAuthorized: true,
      reason: "clear-source-owned-question-reseeds-provisional-parent",
      invalidatedState: [
        "project-binding",
        "fact-anchors",
        "playbook-phase",
        "child",
        "artifacts",
      ],
    };
  }

  return decision(
    "create-parent",
    true,
    true,
    input.existingParent
      ? "clear-source-owned-new-parent"
      : "first-clear-source-owned-parent"
  );
}

export function createParentAdmissionRecord(input: {
  action: "create-parent" | "reseed-parent";
  authoritySource: string;
  sourceTurnIds?: string[];
  sourceObservationIds?: string[];
  reason: string;
  admittedAt: number;
}): ParentAdmissionRecord {
  return {
    durability: "durable",
    action: input.action,
    authoritySource: input.authoritySource,
    sourceTurnIds: uniqueStrings(input.sourceTurnIds ?? []),
    sourceObservationIds: uniqueStrings(input.sourceObservationIds ?? []),
    reason: input.reason,
    admittedAt: input.admittedAt,
  };
}

export function formatParentAdmissionForTrace(
  decision: ParentAdmissionDecision | undefined,
  record?: ParentAdmissionRecord
): Record<string, unknown> {
  if (!decision && !record) return {};
  return {
    parentAdmissionAction: decision?.action ?? record?.action,
    parentAdmissionDurability:
      record?.durability ??
      (decision?.durable ? "durable" : "provisional"),
    parentAdmissionMutationAuthorized: decision?.mutationAuthorized,
    parentAdmissionReason: decision?.reason ?? record?.reason,
    parentAdmissionAuthoritySource: record?.authoritySource,
    parentAdmissionSourceTurnIds: record?.sourceTurnIds,
    parentAdmissionSourceObservationIds: record?.sourceObservationIds,
    parentAdmissionInvalidatedState: decision?.invalidatedState ?? [],
  };
}

function isProvisionalParent(parent: ActiveInterviewParent | undefined) {
  return parent?.admission?.durability === "provisional";
}

function decision(
  action: ParentAdmissionAction,
  durable: boolean,
  mutationAuthorized: boolean,
  reason: string
): ParentAdmissionDecision {
  return {
    action,
    durable,
    mutationAuthorized,
    reason,
    invalidatedState: [],
  };
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}
