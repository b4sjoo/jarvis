import { STORAGE_KEYS } from "@/config";
import { safeLocalStorage } from "@/lib";
import type {
  HumanEvalQuestionType,
  MeetingTraceKind,
  TraceHumanEvaluation,
} from "./types";
import {
  fromHumanEvalQuestionType,
  normalizeQuestionTypeAlias,
  toHumanEvalQuestionType,
} from "./task-taxonomy";

const MAX_HUMAN_EVALUATIONS = 500;

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
    taskQuality: candidate.taskQuality,
    failureReasons: Array.isArray(candidate.failureReasons)
      ? candidate.failureReasons
      : [],
    notes: candidate.notes,
  };
}

function normalizeHumanEvalQuestionType(
  questionType: HumanEvalQuestionType | undefined
): HumanEvalQuestionType | undefined {
  const canonical = fromHumanEvalQuestionType(questionType);
  return canonical ? toHumanEvalQuestionType(canonical) : undefined;
}

function createHumanEvalId() {
  return `human_eval_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}
