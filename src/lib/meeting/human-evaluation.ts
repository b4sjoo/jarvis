import { STORAGE_KEYS } from "../../config/constants.js";
import { safeLocalStorage } from "../storage/helper.js";
import type {
  HumanEvalQuestionType,
  HumanEvaluationVerdict,
  HumanEvaluationVerdictBlock,
  MemoryEntryEvaluationLabel,
  MissingExpectedMemoryLabel,
  MeetingTraceKind,
  QuestionHumanEvaluation,
  TraceHumanEvaluation,
} from "./types";
import { normalizeMemoryRetrievalEvaluationSnapshot } from "./memory-evaluation.js";
import {
  fromHumanEvalQuestionType,
  normalizeCanonicalQuestionType,
  normalizeQuestionTypeAlias,
  toHumanEvalQuestionType,
} from "./task-taxonomy.js";

const MAX_HUMAN_EVALUATIONS = 500;
const MAX_QUESTION_HUMAN_EVALUATIONS = 500;

const DEFAULT_VERDICT_BLOCK: HumanEvaluationVerdictBlock = {
  verdict: "not_applicable",
  reasons: [],
};

export interface QuestionEvaluationIdentity {
  sessionId?: string;
  questionId?: string;
  traceId: string;
  traceKind: MeetingTraceKind;
  taskId?: string;
  parentTaskId?: string;
  childTaskId?: string;
  taskSource?: "screen" | "voice" | "mixed";
  questionType?: HumanEvalQuestionType;
  company?: string;
  relation?: string;
  playbookId?: string;
  playbookPhase?: string;
  whiteboardArtifactId?: string;
  whiteboardArtifactRevision?: number;
  whiteboardArtifactDomainTrack?: string;
  manualPhaseFrom?: string;
  manualPhaseTo?: string;
  manualPhaseTargetArtifact?: string;
  manualPhaseGuardStatus?: string;
  selectedDiagramOverlayIds?: string[];
  rejectedDiagramOverlayCount?: number;
  memoryRetrievalSnapshot?: QuestionHumanEvaluation["memoryRetrievalSnapshot"];
}

export function readTraceHumanEvaluations(): TraceHumanEvaluation[] {
  const stored = safeLocalStorage.getItem(
    STORAGE_KEYS.MEETING_TRACE_HUMAN_EVALUATIONS
  );
  if (!stored) return [];

  try {
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeTraceHumanEvaluation)
      .filter(Boolean)
      .slice(-MAX_HUMAN_EVALUATIONS) as TraceHumanEvaluation[];
  } catch {
    return [];
  }
}

export function persistTraceHumanEvaluations(
  evaluations: TraceHumanEvaluation[]
) {
  safeLocalStorage.setItem(
    STORAGE_KEYS.MEETING_TRACE_HUMAN_EVALUATIONS,
    JSON.stringify(evaluations.slice(-MAX_HUMAN_EVALUATIONS))
  );
}

export function readQuestionHumanEvaluations(): QuestionHumanEvaluation[] {
  const stored = safeLocalStorage.getItem(
    STORAGE_KEYS.MEETING_QUESTION_HUMAN_EVALUATIONS
  );
  if (!stored) return [];

  try {
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeQuestionHumanEvaluation)
      .filter(Boolean)
      .slice(-MAX_QUESTION_HUMAN_EVALUATIONS) as QuestionHumanEvaluation[];
  } catch {
    return [];
  }
}

export function persistQuestionHumanEvaluations(
  evaluations: QuestionHumanEvaluation[]
) {
  safeLocalStorage.setItem(
    STORAGE_KEYS.MEETING_QUESTION_HUMAN_EVALUATIONS,
    JSON.stringify(evaluations.slice(-MAX_QUESTION_HUMAN_EVALUATIONS))
  );
}

export function upsertTraceHumanEvaluation(
  evaluations: TraceHumanEvaluation[],
  traceId: string,
  traceKind: MeetingTraceKind,
  patch: Partial<TraceHumanEvaluation>
) {
  const now = Date.now();
  const existingIndex = evaluations.findIndex(
    (evaluation) => evaluation.traceId === traceId
  );
  const existing =
    existingIndex >= 0 ? evaluations[existingIndex] : undefined;
  const next: TraceHumanEvaluation = {
    id: existing?.id ?? createHumanEvalId(),
    traceId,
    traceKind,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...existing,
    ...normalizeHumanEvaluationPatch(patch),
    failureReasons: patch.failureReasons ?? existing?.failureReasons ?? [],
  };

  if (existingIndex >= 0) {
    return [
      ...evaluations.slice(0, existingIndex),
      next,
      ...evaluations.slice(existingIndex + 1),
    ].slice(-MAX_HUMAN_EVALUATIONS);
  }

  return [...evaluations, next].slice(-MAX_HUMAN_EVALUATIONS);
}

export function upsertQuestionHumanEvaluation(
  evaluations: QuestionHumanEvaluation[],
  identity: QuestionEvaluationIdentity,
  patch: Partial<QuestionHumanEvaluation>
) {
  const now = Date.now();
  const explicitQuestionId = patch.questionId ?? identity.questionId;
  const legacyTraceMatch = explicitQuestionId
    ? undefined
    : evaluations.find((evaluation) =>
        evaluation.traceIds.includes(identity.traceId)
      );
  const questionId =
    explicitQuestionId ??
    legacyTraceMatch?.questionId ??
    resolveQuestionId(identity);
  const existingIndex = evaluations.findIndex(
    (evaluation) => evaluation.questionId === questionId
  );
  const existing =
    existingIndex >= 0 ? evaluations[existingIndex] : undefined;

  const next: QuestionHumanEvaluation = {
    id: existing?.id ?? createQuestionHumanEvalId(),
    sessionId: patch.sessionId ?? existing?.sessionId ?? identity.sessionId,
    questionId,
    taskId: patch.taskId ?? existing?.taskId ?? identity.taskId,
    parentTaskId:
      patch.parentTaskId ?? existing?.parentTaskId ?? identity.parentTaskId,
    childTaskId:
      patch.childTaskId ?? existing?.childTaskId ?? identity.childTaskId,
    taskSource:
      patch.taskSource ?? existing?.taskSource ?? identity.taskSource,
    traceIds: uniqueStrings([
      ...(existing?.traceIds ?? []),
      identity.traceId,
      ...(patch.traceIds ?? []),
    ]),
    questionType:
      normalizeHumanEvalQuestionType(patch.questionType) ??
      existing?.questionType ??
      normalizeHumanEvalQuestionType(identity.questionType),
    correctedQuestionType:
      normalizeHumanEvalQuestionType(patch.correctedQuestionType) ??
      existing?.correctedQuestionType,
    manualQuestionTypeCorrectionId:
      patch.manualQuestionTypeCorrectionId ??
      existing?.manualQuestionTypeCorrectionId,
    manualQuestionTypeCorrectionTraceId:
      patch.manualQuestionTypeCorrectionTraceId ??
      existing?.manualQuestionTypeCorrectionTraceId,
    manualQuestionTypeRegenerationTraceId:
      patch.manualQuestionTypeRegenerationTraceId ??
      existing?.manualQuestionTypeRegenerationTraceId,
    manualQuestionTypeCorrectionSource:
      patch.manualQuestionTypeCorrectionSource ??
      existing?.manualQuestionTypeCorrectionSource,
    company: patch.company ?? existing?.company ?? identity.company,
    correctedCompany:
      patch.correctedCompany ?? existing?.correctedCompany,
    relation: patch.relation ?? existing?.relation ?? identity.relation,
    correctedRelation:
      patch.correctedRelation ?? existing?.correctedRelation,
    playbookId:
      patch.playbookId ?? existing?.playbookId ?? identity.playbookId,
    detectedPlaybookPhase:
      patch.detectedPlaybookPhase ??
      existing?.detectedPlaybookPhase ??
      identity.playbookPhase,
    correctedPlaybookPhase:
      patch.correctedPlaybookPhase ?? existing?.correctedPlaybookPhase,
    detectedWhiteboardArtifactId:
      patch.detectedWhiteboardArtifactId ??
      existing?.detectedWhiteboardArtifactId ??
      identity.whiteboardArtifactId,
    detectedWhiteboardArtifactRevision:
      patch.detectedWhiteboardArtifactRevision ??
      existing?.detectedWhiteboardArtifactRevision ??
      identity.whiteboardArtifactRevision,
    detectedWhiteboardArtifactDomainTrack:
      patch.detectedWhiteboardArtifactDomainTrack ??
      existing?.detectedWhiteboardArtifactDomainTrack ??
      identity.whiteboardArtifactDomainTrack,
    detectedManualPhaseFrom:
      patch.detectedManualPhaseFrom ??
      existing?.detectedManualPhaseFrom ??
      identity.manualPhaseFrom,
    detectedManualPhaseTo:
      patch.detectedManualPhaseTo ??
      existing?.detectedManualPhaseTo ??
      identity.manualPhaseTo,
    detectedManualPhaseTargetArtifact:
      patch.detectedManualPhaseTargetArtifact ??
      existing?.detectedManualPhaseTargetArtifact ??
      identity.manualPhaseTargetArtifact,
    detectedManualPhaseGuardStatus:
      patch.detectedManualPhaseGuardStatus ??
      existing?.detectedManualPhaseGuardStatus ??
      identity.manualPhaseGuardStatus,
    selectedDiagramOverlayIds: uniqueStrings([
      ...(existing?.selectedDiagramOverlayIds ?? []),
      ...(identity.selectedDiagramOverlayIds ?? []),
      ...(patch.selectedDiagramOverlayIds ?? []),
    ]),
    rejectedDiagramOverlayCount:
      patch.rejectedDiagramOverlayCount ??
      existing?.rejectedDiagramOverlayCount ??
      identity.rejectedDiagramOverlayCount,
    classification: mergeVerdictBlock(
      existing?.classification,
      patch.classification
    ),
    playbook: mergeVerdictBlock(existing?.playbook, patch.playbook),
    playbookPhase: mergeVerdictBlock(
      existing?.playbookPhase,
      patch.playbookPhase
    ),
    memory: mergeVerdictBlock(existing?.memory, patch.memory),
    whiteboard: mergeVerdictBlock(existing?.whiteboard, patch.whiteboard),
    manualPhaseTransition: mergeVerdictBlock(
      existing?.manualPhaseTransition,
      patch.manualPhaseTransition
    ),
    diagramOverlay: mergeVerdictBlock(
      existing?.diagramOverlay,
      patch.diagramOverlay
    ),
    guardrail: mergeVerdictBlock(existing?.guardrail, patch.guardrail),
    answer: mergeVerdictBlock(existing?.answer, patch.answer),
    memoryRetrievalSnapshot:
      normalizeMemoryRetrievalEvaluationSnapshot(
        patch.memoryRetrievalSnapshot
      ) ??
      existing?.memoryRetrievalSnapshot ??
      identity.memoryRetrievalSnapshot,
    memoryEntryLabels: mergeMemoryEntryLabels(
      existing?.memoryEntryLabels ?? [],
      patch.memoryEntryLabels ?? []
    ),
    missingExpectedMemory: mergeMissingExpectedMemory(
      existing?.missingExpectedMemory ?? [],
      patch.missingExpectedMemory ?? []
    ),
    notes: patch.notes ?? existing?.notes,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  if (existingIndex >= 0) {
    return [
      ...evaluations.slice(0, existingIndex),
      next,
      ...evaluations.slice(existingIndex + 1),
    ].slice(-MAX_QUESTION_HUMAN_EVALUATIONS);
  }

  return [...evaluations, next].slice(-MAX_QUESTION_HUMAN_EVALUATIONS);
}

export function buildQuestionEvaluationPatchFromTrace(
  evaluation: TraceHumanEvaluation
): Partial<QuestionHumanEvaluation> {
  const patch: Partial<QuestionHumanEvaluation> = {
    taskId: evaluation.taskId,
    parentTaskId: evaluation.parentTaskId,
    childTaskId: evaluation.childTaskId,
    taskSource: evaluation.taskSource,
    questionType: normalizeToHumanEvalQuestionType(evaluation.questionType),
    correctedQuestionType: evaluation.correctedQuestionType,
    correctedCompany: evaluation.correctedCompany,
    classification: buildClassificationVerdict(evaluation),
    playbook: buildPlaybookVerdict(evaluation),
    playbookPhase: buildPlaybookPhaseVerdict(evaluation),
    memory: buildMemoryVerdict(evaluation),
    answer: buildAnswerVerdict(evaluation),
  };

  return patch;
}

function normalizeHumanEvaluationPatch(
  patch: Partial<TraceHumanEvaluation>
): Partial<TraceHumanEvaluation> {
  const questionType = normalizeQuestionTypeAlias(patch.questionType);
  if (!patch.correctedQuestionType) {
    return {
      ...patch,
      questionType,
    };
  }
  const correctedQuestionType = normalizeHumanEvalQuestionType(
    patch.correctedQuestionType
  );
  return {
    ...patch,
    questionType,
    correctedQuestionType,
  };
}

function normalizeTraceHumanEvaluation(
  value: unknown
): TraceHumanEvaluation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<TraceHumanEvaluation>;
  if (!candidate.traceId || !candidate.traceKind) return undefined;

  return {
    id: typeof candidate.id === "string" ? candidate.id : createHumanEvalId(),
    traceId: candidate.traceId,
    traceKind: candidate.traceKind,
    taskId: typeof candidate.taskId === "string" ? candidate.taskId : undefined,
    parentTaskId:
      typeof candidate.parentTaskId === "string"
        ? candidate.parentTaskId
        : undefined,
    childTaskId:
      typeof candidate.childTaskId === "string"
        ? candidate.childTaskId
        : undefined,
    taskSource:
      candidate.taskSource === "screen" ||
      candidate.taskSource === "voice" ||
      candidate.taskSource === "mixed"
        ? candidate.taskSource
        : undefined,
    questionType: normalizeQuestionTypeAlias(candidate.questionType),
    createdAt:
      typeof candidate.createdAt === "number" ? candidate.createdAt : Date.now(),
    updatedAt:
      typeof candidate.updatedAt === "number" ? candidate.updatedAt : Date.now(),
    correctedQuestionType: normalizeHumanEvalQuestionType(
      candidate.correctedQuestionType
    ),
    correctedCompany: candidate.correctedCompany,
    playbookCorrect: candidate.playbookCorrect,
    playbookWrong: candidate.playbookWrong,
    playbookWrongPhase: candidate.playbookWrongPhase,
    memoryRelevant: candidate.memoryRelevant,
    memoryMissing: candidate.memoryMissing,
    memoryWrong: candidate.memoryWrong,
    advisorGateCorrectlySkipped: candidate.advisorGateCorrectlySkipped,
    advisorGateShouldAdvise: candidate.advisorGateShouldAdvise,
    taskQuality: candidate.taskQuality,
    failureReasons: Array.isArray(candidate.failureReasons)
      ? candidate.failureReasons
      : [],
    notes: candidate.notes,
  };
}

function normalizeQuestionHumanEvaluation(
  value: unknown
): QuestionHumanEvaluation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<QuestionHumanEvaluation>;
  if (!candidate.questionId || !Array.isArray(candidate.traceIds)) {
    return undefined;
  }

  return {
    id: typeof candidate.id === "string" ? candidate.id : createQuestionHumanEvalId(),
    sessionId:
      typeof candidate.sessionId === "string" ? candidate.sessionId : undefined,
    questionId: candidate.questionId,
    taskId: typeof candidate.taskId === "string" ? candidate.taskId : undefined,
    parentTaskId:
      typeof candidate.parentTaskId === "string"
        ? candidate.parentTaskId
        : undefined,
    childTaskId:
      typeof candidate.childTaskId === "string"
        ? candidate.childTaskId
        : undefined,
    taskSource:
      candidate.taskSource === "screen" ||
      candidate.taskSource === "voice" ||
      candidate.taskSource === "mixed"
        ? candidate.taskSource
        : undefined,
    traceIds: uniqueStrings(candidate.traceIds),
    questionType: normalizeHumanEvalQuestionType(candidate.questionType),
    correctedQuestionType: normalizeHumanEvalQuestionType(
      candidate.correctedQuestionType
    ),
    manualQuestionTypeCorrectionId: readOptionalString(
      candidate.manualQuestionTypeCorrectionId
    ),
    manualQuestionTypeCorrectionTraceId: readOptionalString(
      candidate.manualQuestionTypeCorrectionTraceId
    ),
    manualQuestionTypeRegenerationTraceId: readOptionalString(
      candidate.manualQuestionTypeRegenerationTraceId
    ),
    manualQuestionTypeCorrectionSource:
      candidate.manualQuestionTypeCorrectionSource === "focus-mode" ||
      candidate.manualQuestionTypeCorrectionSource === "normal-mode"
        ? candidate.manualQuestionTypeCorrectionSource
        : undefined,
    company: readOptionalString(candidate.company),
    correctedCompany: readOptionalString(candidate.correctedCompany),
    relation: readOptionalString(candidate.relation),
    correctedRelation: readOptionalString(candidate.correctedRelation),
    playbookId: readOptionalString(candidate.playbookId),
    detectedPlaybookPhase: readOptionalString(candidate.detectedPlaybookPhase),
    correctedPlaybookPhase: readOptionalString(candidate.correctedPlaybookPhase),
    detectedWhiteboardArtifactId: readOptionalString(
      candidate.detectedWhiteboardArtifactId
    ),
    detectedWhiteboardArtifactRevision:
      typeof candidate.detectedWhiteboardArtifactRevision === "number"
        ? candidate.detectedWhiteboardArtifactRevision
        : undefined,
    detectedWhiteboardArtifactDomainTrack: readOptionalString(
      candidate.detectedWhiteboardArtifactDomainTrack
    ),
    detectedManualPhaseFrom: readOptionalString(candidate.detectedManualPhaseFrom),
    detectedManualPhaseTo: readOptionalString(candidate.detectedManualPhaseTo),
    detectedManualPhaseTargetArtifact: readOptionalString(
      candidate.detectedManualPhaseTargetArtifact
    ),
    detectedManualPhaseGuardStatus: readOptionalString(
      candidate.detectedManualPhaseGuardStatus
    ),
    selectedDiagramOverlayIds: Array.isArray(candidate.selectedDiagramOverlayIds)
      ? uniqueStrings(candidate.selectedDiagramOverlayIds)
      : [],
    rejectedDiagramOverlayCount:
      typeof candidate.rejectedDiagramOverlayCount === "number"
        ? candidate.rejectedDiagramOverlayCount
        : undefined,
    classification: normalizeVerdictBlock(candidate.classification),
    playbook: normalizeVerdictBlock(candidate.playbook),
    playbookPhase: normalizeVerdictBlock(candidate.playbookPhase),
    memory: normalizeVerdictBlock(candidate.memory),
    whiteboard: normalizeVerdictBlock(candidate.whiteboard),
    manualPhaseTransition: normalizeVerdictBlock(
      candidate.manualPhaseTransition
    ),
    diagramOverlay: normalizeVerdictBlock(candidate.diagramOverlay),
    guardrail: normalizeVerdictBlock(candidate.guardrail),
    answer: normalizeVerdictBlock(candidate.answer),
    memoryRetrievalSnapshot: normalizeMemoryRetrievalEvaluationSnapshot(
      candidate.memoryRetrievalSnapshot
    ),
    memoryEntryLabels: normalizeMemoryEntryLabels(candidate.memoryEntryLabels),
    missingExpectedMemory: normalizeMissingExpectedMemory(
      candidate.missingExpectedMemory
    ),
    notes: readOptionalString(candidate.notes),
    createdAt:
      typeof candidate.createdAt === "number" ? candidate.createdAt : Date.now(),
    updatedAt:
      typeof candidate.updatedAt === "number" ? candidate.updatedAt : Date.now(),
  };
}

function normalizeHumanEvalQuestionType(
  questionType: HumanEvalQuestionType | undefined
): HumanEvalQuestionType | undefined {
  const canonical = fromHumanEvalQuestionType(questionType);
  return canonical ? toHumanEvalQuestionType(canonical) : undefined;
}

function normalizeToHumanEvalQuestionType(
  questionType: unknown
): HumanEvalQuestionType | undefined {
  const canonical = normalizeCanonicalQuestionType(
    normalizeQuestionTypeAlias(questionType)
  );
  return canonical ? toHumanEvalQuestionType(canonical) : undefined;
}

function createHumanEvalId() {
  return `human_eval_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function createQuestionHumanEvalId() {
  return `question_eval_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function resolveQuestionId(
  identity: QuestionEvaluationIdentity
) {
  return `trace:${identity.traceId}`;
}

function buildClassificationVerdict(
  evaluation: TraceHumanEvaluation
): HumanEvaluationVerdictBlock {
  if (evaluation.failureReasons.includes("wrong-question-type")) {
    return makeVerdict("wrong", ["wrong-question-type"]);
  }
  if (evaluation.correctedQuestionType) {
    const detected = normalizeToHumanEvalQuestionType(evaluation.questionType);
    return makeVerdict(
      detected === evaluation.correctedQuestionType ? "ok" : "wrong",
      detected === evaluation.correctedQuestionType ? ["confirmed"] : ["corrected"]
    );
  }
  return DEFAULT_VERDICT_BLOCK;
}

function buildPlaybookVerdict(
  evaluation: TraceHumanEvaluation
): HumanEvaluationVerdictBlock {
  if (evaluation.playbookWrong) return makeVerdict("wrong", ["wrong-playbook"]);
  if (evaluation.failureReasons.includes("wrong-playbook")) {
    return makeVerdict("wrong", ["wrong-playbook"]);
  }
  if (evaluation.playbookCorrect) return makeVerdict("ok", ["confirmed"]);
  return DEFAULT_VERDICT_BLOCK;
}

function buildPlaybookPhaseVerdict(
  evaluation: TraceHumanEvaluation
): HumanEvaluationVerdictBlock {
  if (evaluation.playbookWrongPhase) {
    return makeVerdict("wrong", ["wrong-playbook-phase"]);
  }
  if (evaluation.failureReasons.includes("wrong-playbook-phase")) {
    return makeVerdict("wrong", ["wrong-playbook-phase"]);
  }
  if (evaluation.playbookCorrect) return makeVerdict("ok", ["playbook-ok"]);
  return DEFAULT_VERDICT_BLOCK;
}

function buildMemoryVerdict(
  evaluation: TraceHumanEvaluation
): HumanEvaluationVerdictBlock {
  if (evaluation.memoryWrong) return makeVerdict("forbidden", ["wrong-memory"]);
  if (evaluation.memoryMissing) return makeVerdict("missing", ["missing-memory"]);
  if (evaluation.failureReasons.includes("wrong-memory")) {
    return makeVerdict("forbidden", ["wrong-memory"]);
  }
  if (evaluation.failureReasons.includes("missing-memory")) {
    return makeVerdict("missing", ["missing-memory"]);
  }
  if (evaluation.memoryRelevant) return makeVerdict("ok", ["confirmed"]);
  return DEFAULT_VERDICT_BLOCK;
}

function buildAnswerVerdict(
  evaluation: TraceHumanEvaluation
): HumanEvaluationVerdictBlock {
  if (evaluation.taskQuality === "success") return makeVerdict("ok", ["useful"]);
  if (evaluation.taskQuality === "partial") {
    return makeVerdict("partial", ["partially-useful"]);
  }
  if (evaluation.taskQuality === "fail") return makeVerdict("wrong", ["failed"]);
  if (evaluation.failureReasons.includes("wrong-answer")) {
    return makeVerdict("wrong", ["wrong-answer"]);
  }
  if (evaluation.failureReasons.includes("too-short")) {
    return makeVerdict("partial", ["too-short"]);
  }
  return DEFAULT_VERDICT_BLOCK;
}

function makeVerdict(
  verdict: HumanEvaluationVerdict,
  reasons: string[] = []
): HumanEvaluationVerdictBlock {
  return { verdict, reasons };
}

function mergeVerdictBlock(
  existing: HumanEvaluationVerdictBlock | undefined,
  patch: HumanEvaluationVerdictBlock | undefined
): HumanEvaluationVerdictBlock {
  if (!patch) return existing ?? DEFAULT_VERDICT_BLOCK;
  return {
    verdict: patch.verdict ?? existing?.verdict ?? "not_applicable",
    reasons: patch.reasons ?? existing?.reasons ?? [],
    note: patch.note ?? existing?.note,
  };
}

function normalizeVerdictBlock(
  value: unknown
): HumanEvaluationVerdictBlock {
  if (!value || typeof value !== "object") return DEFAULT_VERDICT_BLOCK;
  const candidate = value as Partial<HumanEvaluationVerdictBlock>;
  return {
    verdict: isHumanEvaluationVerdict(candidate.verdict)
      ? candidate.verdict
      : "not_applicable",
    reasons: Array.isArray(candidate.reasons)
      ? candidate.reasons.filter((reason): reason is string => typeof reason === "string")
      : [],
    note: readOptionalString(candidate.note),
  };
}

function isHumanEvaluationVerdict(
  value: unknown
): value is HumanEvaluationVerdict {
  return (
    value === "ok" ||
    value === "partial" ||
    value === "wrong" ||
    value === "missing" ||
    value === "forbidden" ||
    value === "not_applicable"
  );
}

function mergeMemoryEntryLabels(
  existing: MemoryEntryEvaluationLabel[],
  patch: MemoryEntryEvaluationLabel[]
) {
  if (!patch.length) return existing;
  const byId = new Map(existing.map((item) => [item.memoryId, item]));
  for (const item of normalizeMemoryEntryLabels(patch)) {
    byId.set(item.memoryId, { ...byId.get(item.memoryId), ...item });
  }
  return Array.from(byId.values());
}

function normalizeMemoryEntryLabels(
  value: unknown
): MemoryEntryEvaluationLabel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): MemoryEntryEvaluationLabel[] => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<MemoryEntryEvaluationLabel>;
    if (!candidate.memoryId || !isMemoryEntryLabel(candidate.label)) return [];
    return [
      {
        memoryId: candidate.memoryId,
        title: readOptionalString(candidate.title),
        label: candidate.label,
        reason: readOptionalString(candidate.reason),
      },
    ];
  });
}

function isMemoryEntryLabel(
  value: unknown
): value is MemoryEntryEvaluationLabel["label"] {
  return value === "relevant" || value === "irrelevant" || value === "forbidden";
}

function mergeMissingExpectedMemory(
  existing: MissingExpectedMemoryLabel[],
  patch: MissingExpectedMemoryLabel[]
) {
  const normalized = normalizeMissingExpectedMemory(patch);
  if (!normalized.length) return existing;
  const key = (item: MissingExpectedMemoryLabel) =>
    item.id ? `id:${item.id}` : `note:${item.note ?? ""}`;
  const byKey = new Map(existing.map((item) => [key(item), item]));
  for (const item of normalized) byKey.set(key(item), item);
  return Array.from(byKey.values());
}

function normalizeMissingExpectedMemory(
  value: unknown
): MissingExpectedMemoryLabel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): MissingExpectedMemoryLabel[] => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<MissingExpectedMemoryLabel>;
    const id = readOptionalString(candidate.id);
    const note = readOptionalString(candidate.note);
    if (!id && !note) return [];
    return [{ id, note }];
  });
}

function readOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function uniqueStrings(values: Array<string | undefined>) {
  return Array.from(
    new Set(values.filter((value): value is string => Boolean(value)))
  );
}
