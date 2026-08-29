import {
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";
import {
  normalizeRuntimeAdjudicationAuthorityLabel,
} from "./runtime-adjudication-authority.js";

type ObservedTaskRelation =
  | "new-parent"
  | "followup-parent"
  | "child-probe"
  | "resume-parent"
  | "logistics"
  | "correction"
  | "unknown";

export type DurableQuestionOwnerMissingReason =
  | "no-durable-parent"
  | "durable-parent-type-unknown"
  | "new-parent-type-not-applied";

export interface QuestionTypeObservation {
  observedCurrentQuestionType?: CanonicalQuestionType;
  observedCurrentQuestionTypeAuthority?: string;
  observedParentType?: CanonicalQuestionType;
  observedParentId?: string;
  typeAppliedToResponse?: boolean;
  typeAppliedToSettlement?: boolean;
  typeAppliedToParent?: boolean;
  durableOwnerMissing: boolean;
  durableOwnerMissingReason?: DurableQuestionOwnerMissingReason;
}

export function projectQuestionTypeObservation(input: {
  metadata?: Record<string, unknown>;
  fallbackCurrentQuestionType?: unknown;
  fallbackParentType?: unknown;
  fallbackParentId?: string;
}): QuestionTypeObservation {
  const metadata = input.metadata ?? {};
  const observedCurrentQuestionType = normalizeCanonicalQuestionType(
    readString(
      metadata.effectiveCurrentQuestionSettlementQuestionType ??
        metadata.currentQuestionSettlementType ??
        metadata.settledExecutionPlanQuestionType ??
        metadata.canonicalQuestionType ??
        input.fallbackCurrentQuestionType ??
        metadata.questionType
    )
  );
  const observedParentType = normalizeCanonicalQuestionType(
    readString(
      metadata.currentQuestionSettlementParentAfterType ??
        metadata.activeMeetingParentQuestionType ??
        input.fallbackParentType
    )
  );
  const observedParentId = readString(
    metadata.currentQuestionSettlementParentAfterId ??
      metadata.activeMeetingParentId ??
      input.fallbackParentId
  );
  const typeAppliedToResponse =
    readBoolean(metadata.currentQuestionSettlementAppliedToResponse) ??
    inferResponseApplication(metadata, observedCurrentQuestionType);
  const typeAppliedToSettlement =
    readBoolean(metadata.currentQuestionSettlementAppliedToSettlement) ??
    (readString(metadata.currentQuestionSettlementId) ? true : undefined);
  const typeAppliedToParent = readBoolean(
    metadata.currentQuestionSettlementAppliedToParent
  );
  const relation = readRelation(
    metadata.currentQuestionSettlementRelation ??
      metadata.settledExecutionPlanTaskRelation ??
      metadata.taskRelation
  );
  const durableOwner = resolveDurableOwnerStatus({
    currentQuestionType: observedCurrentQuestionType,
    parentType: observedParentType,
    parentId: observedParentId,
    relation,
    typeAppliedToParent,
  });

  return {
    observedCurrentQuestionType,
    observedCurrentQuestionTypeAuthority:
      normalizeRuntimeAdjudicationAuthorityLabel(
        metadata.currentQuestionSettlementTypeAuthoritySource ??
          metadata.currentQuestionSettlementAuthoritySource
      ),
    observedParentType,
    observedParentId,
    typeAppliedToResponse,
    typeAppliedToSettlement,
    typeAppliedToParent,
    ...durableOwner,
  };
}

function inferResponseApplication(
  metadata: Record<string, unknown>,
  currentQuestionType: CanonicalQuestionType | undefined
) {
  const responseType = normalizeCanonicalQuestionType(
    readString(metadata.settledExecutionPlanQuestionType)
  );
  if (!currentQuestionType || !responseType) return undefined;
  return currentQuestionType === responseType;
}

function resolveDurableOwnerStatus(input: {
  currentQuestionType?: CanonicalQuestionType;
  parentType?: CanonicalQuestionType;
  parentId?: string;
  relation?: ObservedTaskRelation;
  typeAppliedToParent?: boolean;
}): Pick<
  QuestionTypeObservation,
  "durableOwnerMissing" | "durableOwnerMissingReason"
> {
  if (
    !input.currentQuestionType ||
    input.currentQuestionType === "unknown" ||
    input.relation === "child-probe"
  ) {
    return { durableOwnerMissing: false };
  }
  if (!input.parentId) {
    return {
      durableOwnerMissing: true,
      durableOwnerMissingReason: "no-durable-parent",
    };
  }
  if (!input.parentType || input.parentType === "unknown") {
    return {
      durableOwnerMissing: true,
      durableOwnerMissingReason: "durable-parent-type-unknown",
    };
  }
  if (
    input.relation === "new-parent" &&
    input.typeAppliedToParent !== true &&
    input.parentType !== input.currentQuestionType
  ) {
    return {
      durableOwnerMissing: true,
      durableOwnerMissingReason: "new-parent-type-not-applied",
    };
  }
  return { durableOwnerMissing: false };
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function readBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function readRelation(value: unknown): ObservedTaskRelation | undefined {
  return value === "new-parent" ||
    value === "followup-parent" ||
    value === "child-probe" ||
    value === "resume-parent" ||
    value === "logistics" ||
    value === "correction" ||
    value === "unknown"
    ? value
    : undefined;
}
