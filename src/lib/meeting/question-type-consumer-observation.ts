import {
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";

export type QuestionTypePriorSource =
  | "interview-brief"
  | "preparation-snapshot";

export type QuestionTypePriorAdapterDisposition =
  | "empty"
  | "canonical"
  | "canonical-and-policy"
  | "policy-only"
  | "unsupported-values";

export interface QuestionTypePriorObservation {
  source: QuestionTypePriorSource;
  sourceId?: string;
  rawTypes: string[];
  canonicalTypes: Exclude<CanonicalQuestionType, "unknown">[];
  policyOnlyTypes: string[];
  unsupportedTypes: string[];
  expectedTypePolicy?: "advisory" | "restricted";
  adapterDisposition: QuestionTypePriorAdapterDisposition;
  legacyInterviewBriefTypes: string[];
}

export type QuestionTypePriorCompatibility =
  | "compatible"
  | "conflict"
  | "not-applicable"
  | "unresolved";

export interface QuestionTypeConsumerObservation {
  prior?: QuestionTypePriorObservation;
  committedCurrentQuestionType: CanonicalQuestionType;
  responseOwnerQuestionType: CanonicalQuestionType;
  responsePlaybookQuestionType?: CanonicalQuestionType;
  parentTrajectoryPlaybookQuestionType?: CanonicalQuestionType;
  parentTrajectoryReadOnly: boolean;
  kmbPolicyQuestionType: CanonicalQuestionType;
  kmbPolicyFamilies: string[];
  factAnchorPolicyQuestionType: CanonicalQuestionType;
  modelRouteQuestionType: CanonicalQuestionType;
  answerProfileQuestionType: CanonicalQuestionType;
  artifactPolicyQuestionType: CanonicalQuestionType;
  promptContractQuestionType: CanonicalQuestionType;
  priorCompatibility: QuestionTypePriorCompatibility;
  priorUsedAsExecutionGate: boolean;
  conflicts: string[];
  coherent: boolean;
}

const CANONICAL_PREPARATION_TYPES = new Set([
  "behavioral",
  "coding",
  "general-system-design",
  "ai-ml-system-design",
  "project-deep-dive",
  "field-knowledge",
]);

export function adaptQuestionTypePrior(input: {
  source: QuestionTypePriorSource;
  sourceId?: string;
  types: readonly unknown[];
  expectedTypePolicy?: unknown;
}): QuestionTypePriorObservation {
  const rawTypes = uniqueStrings(input.types);
  const canonicalTypes: Exclude<CanonicalQuestionType, "unknown">[] = [];
  const policyOnlyTypes: string[] = [];
  const unsupportedTypes: string[] = [];
  const legacyInterviewBriefTypes: string[] = [];

  for (const rawType of rawTypes) {
    const normalized =
      rawType === "system-design" ? "general-system-design" : rawType;
    if (CANONICAL_PREPARATION_TYPES.has(normalized)) {
      canonicalTypes.push(
        normalized as Exclude<CanonicalQuestionType, "unknown">
      );
      if (normalized === "general-system-design") {
        legacyInterviewBriefTypes.push("system-design");
      } else if (normalized !== "field-knowledge") {
        legacyInterviewBriefTypes.push(normalized);
      }
      continue;
    }
    if (normalized === "personal-logistics") {
      policyOnlyTypes.push(normalized);
      continue;
    }
    unsupportedTypes.push(rawType);
  }

  const expectedTypePolicy =
    input.expectedTypePolicy === "advisory" ||
    input.expectedTypePolicy === "restricted"
      ? input.expectedTypePolicy
      : undefined;
  const adapterDisposition: QuestionTypePriorAdapterDisposition =
    unsupportedTypes.length > 0
      ? "unsupported-values"
      : canonicalTypes.length > 0 && policyOnlyTypes.length > 0
        ? "canonical-and-policy"
        : canonicalTypes.length > 0
          ? "canonical"
          : policyOnlyTypes.length > 0
            ? "policy-only"
            : "empty";

  return {
    source: input.source,
    sourceId: input.sourceId,
    rawTypes,
    canonicalTypes: uniqueCanonicalTypes(canonicalTypes),
    policyOnlyTypes: uniqueStrings(policyOnlyTypes),
    unsupportedTypes: uniqueStrings(unsupportedTypes),
    expectedTypePolicy,
    adapterDisposition,
    legacyInterviewBriefTypes: uniqueStrings(legacyInterviewBriefTypes),
  };
}

export function buildQuestionTypeConsumerObservation(input: {
  prior?: QuestionTypePriorObservation;
  committedCurrentQuestionType: unknown;
  responseOwnerQuestionType: unknown;
  responsePlaybookQuestionType?: unknown;
  parentTrajectoryPlaybookQuestionType?: unknown;
  parentTrajectoryReadOnly?: boolean;
  kmbPolicyQuestionType: unknown;
  kmbPolicyFamilies?: readonly string[];
  factAnchorPolicyQuestionType: unknown;
  modelRouteQuestionType: unknown;
  answerProfileQuestionType: unknown;
  artifactPolicyQuestionType: unknown;
  promptContractQuestionType: unknown;
  priorUsedAsExecutionGate?: boolean;
}): QuestionTypeConsumerObservation {
  const committedCurrentQuestionType = normalizeType(
    input.committedCurrentQuestionType
  );
  const responseOwnerQuestionType = normalizeType(
    input.responseOwnerQuestionType
  );
  const responsePlaybookQuestionType = normalizeOptionalType(
    input.responsePlaybookQuestionType
  );
  const parentTrajectoryPlaybookQuestionType = normalizeOptionalType(
    input.parentTrajectoryPlaybookQuestionType
  );
  const kmbPolicyQuestionType = normalizeType(input.kmbPolicyQuestionType);
  const factAnchorPolicyQuestionType = normalizeType(
    input.factAnchorPolicyQuestionType
  );
  const modelRouteQuestionType = normalizeType(input.modelRouteQuestionType);
  const answerProfileQuestionType = normalizeType(
    input.answerProfileQuestionType
  );
  const artifactPolicyQuestionType = normalizeType(
    input.artifactPolicyQuestionType
  );
  const promptContractQuestionType = normalizeType(
    input.promptContractQuestionType
  );
  const parentTrajectoryReadOnly = Boolean(
    input.parentTrajectoryReadOnly && parentTrajectoryPlaybookQuestionType
  );
  const priorCompatibility = resolvePriorCompatibility(
    input.prior,
    committedCurrentQuestionType
  );
  const conflicts: string[] = [];
  const priorUsedAsExecutionGate = Boolean(
    input.priorUsedAsExecutionGate
  );

  if (priorCompatibility === "conflict") {
    conflicts.push("prior-vs-committed");
  }
  if (priorUsedAsExecutionGate) {
    conflicts.push("prior-used-as-execution-gate");
  }
  addConsumerConflict(
    conflicts,
    "settlement-vs-response-owner",
    committedCurrentQuestionType,
    responseOwnerQuestionType
  );
  if (responsePlaybookQuestionType) {
    addConsumerConflict(
      conflicts,
      "response-playbook-vs-owner",
      responsePlaybookQuestionType,
      responseOwnerQuestionType
    );
  } else if (responseOwnerQuestionType !== "unknown") {
    conflicts.push("response-playbook-missing");
  }
  addConsumerConflict(
    conflicts,
    "kmb-policy-vs-owner",
    kmbPolicyQuestionType,
    responseOwnerQuestionType
  );
  addConsumerConflict(
    conflicts,
    "fact-anchor-vs-owner",
    factAnchorPolicyQuestionType,
    responseOwnerQuestionType
  );
  addConsumerConflict(
    conflicts,
    "model-route-vs-owner",
    modelRouteQuestionType,
    responseOwnerQuestionType
  );
  addConsumerConflict(
    conflicts,
    "answer-profile-vs-owner",
    answerProfileQuestionType,
    responseOwnerQuestionType
  );
  addConsumerConflict(
    conflicts,
    "artifact-policy-vs-owner",
    artifactPolicyQuestionType,
    responseOwnerQuestionType
  );
  addConsumerConflict(
    conflicts,
    "prompt-contract-vs-owner",
    promptContractQuestionType,
    responseOwnerQuestionType
  );
  if (
    parentTrajectoryPlaybookQuestionType &&
    !parentTrajectoryReadOnly
  ) {
    addConsumerConflict(
      conflicts,
      "parent-trajectory-playbook-has-write-authority",
      parentTrajectoryPlaybookQuestionType,
      responseOwnerQuestionType
    );
  }

  return {
    prior: input.prior ? cloneQuestionTypePrior(input.prior) : undefined,
    committedCurrentQuestionType,
    responseOwnerQuestionType,
    responsePlaybookQuestionType,
    parentTrajectoryPlaybookQuestionType,
    parentTrajectoryReadOnly,
    kmbPolicyQuestionType,
    kmbPolicyFamilies: uniqueStrings(input.kmbPolicyFamilies ?? []),
    factAnchorPolicyQuestionType,
    modelRouteQuestionType,
    answerProfileQuestionType,
    artifactPolicyQuestionType,
    promptContractQuestionType,
    priorCompatibility,
    priorUsedAsExecutionGate,
    conflicts: uniqueStrings(conflicts),
    coherent: conflicts.length === 0,
  };
}

export function projectQuestionTypeConsumerObservationFromTrace(
  metadata: Record<string, unknown>
): QuestionTypeConsumerObservation | undefined {
  const committedCurrentQuestionType = normalizeCanonicalQuestionType(
    metadata.committedCurrentQuestionType
  );
  const responseOwnerQuestionType = normalizeCanonicalQuestionType(
    metadata.responseOwnerQuestionType
  );
  if (!committedCurrentQuestionType || !responseOwnerQuestionType) {
    return undefined;
  }

  const priorSource = readPriorSource(metadata.questionTypePriorSource);
  const priorRawTypes = readStringArray(metadata.questionTypePriorRawTypes);
  const prior = priorSource
    ? adaptQuestionTypePrior({
        source: priorSource,
        sourceId: readOptionalString(metadata.questionTypePriorSourceId),
        types: priorRawTypes,
        expectedTypePolicy:
          metadata.questionTypePriorExpectedTypePolicy,
      })
    : undefined;

  return buildQuestionTypeConsumerObservation({
    prior,
    committedCurrentQuestionType,
    responseOwnerQuestionType,
    responsePlaybookQuestionType:
      metadata.responsePlaybookQuestionType,
    parentTrajectoryPlaybookQuestionType:
      metadata.parentTrajectoryPlaybookQuestionType,
    parentTrajectoryReadOnly:
      metadata.parentTrajectoryPlaybookReadOnly === true,
    kmbPolicyQuestionType: metadata.kmbPolicyQuestionType,
    kmbPolicyFamilies: readStringArray(metadata.kmbPolicyFamilies),
    factAnchorPolicyQuestionType:
      metadata.factAnchorPolicyQuestionType,
    modelRouteQuestionType: metadata.modelRouteQuestionType,
    answerProfileQuestionType:
      metadata.answerProfileQuestionType,
    artifactPolicyQuestionType:
      metadata.artifactPolicyQuestionType,
    promptContractQuestionType:
      metadata.promptContractQuestionType,
    priorUsedAsExecutionGate:
      metadata.priorUsedAsExecutionGate === true,
  });
}

export function formatQuestionTypeConsumerObservationForTrace(
  observation: QuestionTypeConsumerObservation | undefined
): Record<string, unknown> {
  if (!observation) return {};
  const prior = observation.prior;
  return {
    questionTypePriorTypes: prior?.canonicalTypes ?? [],
    questionTypePriorRawTypes: prior?.rawTypes ?? [],
    questionTypePriorPolicyOnlyTypes: prior?.policyOnlyTypes ?? [],
    questionTypePriorUnsupportedTypes: prior?.unsupportedTypes ?? [],
    questionTypePriorSource: prior?.source,
    questionTypePriorSourceId: prior?.sourceId,
    questionTypePriorExpectedTypePolicy: prior?.expectedTypePolicy,
    questionTypePriorAdapterDisposition: prior?.adapterDisposition,
    priorCompatibility: observation.priorCompatibility,
    priorUsedAsExecutionGate: observation.priorUsedAsExecutionGate,
    committedCurrentQuestionType:
      observation.committedCurrentQuestionType,
    responseOwnerQuestionType: observation.responseOwnerQuestionType,
    responsePlaybookQuestionType:
      observation.responsePlaybookQuestionType,
    parentTrajectoryPlaybookQuestionType:
      observation.parentTrajectoryPlaybookQuestionType,
    parentTrajectoryPlaybookReadOnly:
      observation.parentTrajectoryReadOnly,
    kmbPolicyQuestionType: observation.kmbPolicyQuestionType,
    kmbPolicyFamilies: observation.kmbPolicyFamilies,
    factAnchorPolicyQuestionType:
      observation.factAnchorPolicyQuestionType,
    modelRouteQuestionType: observation.modelRouteQuestionType,
    answerProfileQuestionType:
      observation.answerProfileQuestionType,
    artifactPolicyQuestionType:
      observation.artifactPolicyQuestionType,
    promptContractQuestionType:
      observation.promptContractQuestionType,
    questionTypeConsumerConflicts: observation.conflicts,
    questionTypeConsumerCoherent: observation.coherent,
  };
}

function resolvePriorCompatibility(
  prior: QuestionTypePriorObservation | undefined,
  committedQuestionType: CanonicalQuestionType
): QuestionTypePriorCompatibility {
  if (!prior || prior.canonicalTypes.length === 0) return "not-applicable";
  if (committedQuestionType === "unknown") return "unresolved";
  return prior.canonicalTypes.includes(committedQuestionType)
    ? "compatible"
    : "conflict";
}

function addConsumerConflict(
  conflicts: string[],
  reason: string,
  actual: CanonicalQuestionType,
  expected: CanonicalQuestionType
) {
  if (actual !== expected) conflicts.push(reason);
}

function normalizeType(value: unknown): CanonicalQuestionType {
  return normalizeCanonicalQuestionType(value) ?? "unknown";
}

function normalizeOptionalType(
  value: unknown
): CanonicalQuestionType | undefined {
  return value === undefined
    ? undefined
    : normalizeCanonicalQuestionType(value) ?? "unknown";
}

function uniqueStrings(values: readonly unknown[]): string[] {
  return Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    )
  );
}

function uniqueCanonicalTypes(
  values: readonly Exclude<CanonicalQuestionType, "unknown">[]
) {
  return Array.from(new Set(values));
}

function cloneQuestionTypePrior(
  prior: QuestionTypePriorObservation
): QuestionTypePriorObservation {
  return {
    ...prior,
    rawTypes: [...prior.rawTypes],
    canonicalTypes: [...prior.canonicalTypes],
    policyOnlyTypes: [...prior.policyOnlyTypes],
    unsupportedTypes: [...prior.unsupportedTypes],
    legacyInterviewBriefTypes: [...prior.legacyInterviewBriefTypes],
  };
}

function readPriorSource(value: unknown): QuestionTypePriorSource | undefined {
  return value === "interview-brief" || value === "preparation-snapshot"
    ? value
    : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? uniqueStrings(value) : [];
}
