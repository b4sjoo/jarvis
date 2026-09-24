import { createMeetingId } from "./meeting-id.js";

import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import { type CanonicalQuestionType } from "./task-taxonomy.js";

export const TAXONOMY_ADJUDICATION_MAX_INPUT_CHARS = 1_200;

export interface TaxonomyAdjudicationSourceTurn {
  turnId: string;
  text: string;
}

export interface TaxonomyAdjudicationProjection {
  text: string;
  sourceTurns: TaxonomyAdjudicationSourceTurn[];
  sourceTurnIds: string[];
  omittedSourceTurnIds: string[];
  originalChars: number;
  projectedChars: number;
  projectionReason: "within-limit" | "anchor-switch-latest-constraint";
  safe: boolean;
}

export interface TaxonomyAdjudicationLease {
  operationId: string;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  sourceTurnIdsHash: string;
  sourceSettlementId?: string;
  questionSourceHash?: string;
  taskBoundaryEpoch: number;
  manualCorrectionRevision: number;
  expectedParentId?: string;
  expectedParentRevision?: number;
  requestedAt: number;
}

export type TaxonomyAdjudicationLeaseRejectionReason =
  | "current-operation-mismatch"
  | "session-mismatch"
  | "runtime-epoch-mismatch"
  | "logical-unit-missing"
  | "logical-unit-id-mismatch"
  | "logical-unit-revision-mismatch"
  | "source-turn-hash-mismatch"
  | "source-settlement-mismatch"
  | "task-boundary-epoch-mismatch"
  | "manual-correction-revision-mismatch"
  | "expected-parent-mismatch"
  | "expected-parent-revision-mismatch"
  | "logical-unit-closed"
  | "self-healing-budget-consumed";

export interface TaxonomyAdjudicationLeaseSnapshot {
  currentOperationId?: string;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnit?: LogicalQuestionUnit;
  taskBoundaryEpoch: number;
  sourceSettlementId?: string;
  questionSourceHash?: string;
  manualCorrectionRevision: number;
  activeParentId?: string;
  activeParentRevision?: number;
  logicalUnitClosed: boolean;
  selfHealingBudgetConsumed: boolean;
}

export function projectLogicalQuestionForAdjudication(
  unit: LogicalQuestionUnit,
  maxChars = TAXONOMY_ADJUDICATION_MAX_INPUT_CHARS
): TaxonomyAdjudicationProjection {
  const sources = normalizeAdjudicationSourceTurns(unit);
  const original = joinAdjudicationSourceTurns(sources);
  if (original.length <= maxChars) {
    const sourceTurnIds = sources.map((source) => source.turnId);
    return {
      text: original,
      sourceTurns: sources,
      sourceTurnIds,
      omittedSourceTurnIds: unit.sourceTurnIds.filter(
        (turnId) => !sourceTurnIds.includes(turnId)
      ),
      originalChars: original.length,
      projectedChars: original.length,
      projectionReason: "within-limit",
      safe: Boolean(original && sourceTurnIds.length),
    };
  }

  const first = sources[0];
  const latest = sources[sources.length - 1];
  const switchSpans = sources.flatMap((source) =>
    splitSentences(source.text)
      .filter((sentence) => TASK_SWITCH_PATTERN.test(sentence))
      .map((text) => ({ turnId: source.turnId, text }))
  );
  const constraintSpans = sources.flatMap((source) =>
    splitSentences(source.text)
      .filter((sentence) => CURRENT_CONSTRAINT_PATTERN.test(sentence))
      .map((text) => ({ turnId: source.turnId, text }))
  );
  const selected = dedupeSourceSegments([
    {
      turnId: first?.turnId ?? "",
      text: clipSourceText(
        first?.text ?? "",
        Math.floor(maxChars * 0.42),
        "start"
      ),
    },
    ...switchSpans,
    ...constraintSpans.slice(-2),
    {
      turnId: latest?.turnId ?? "",
      text: clipSourceText(
        latest?.text ?? "",
        Math.floor(maxChars * 0.42),
        "end"
      ),
    },
  ]);
  const sourceTurns = fitSourceSegments(selected, maxChars);
  const text = joinAdjudicationSourceTurns(sourceTurns);
  const sourceTurnIds = sourceTurns.map((source) => source.turnId);
  const safe = Boolean(
    first?.text &&
      latest?.text &&
      text &&
      sourceTurnIds.includes(first.turnId) &&
      sourceTurnIds.includes(latest.turnId)
  );

  return {
    text,
    sourceTurns,
    sourceTurnIds,
    omittedSourceTurnIds: unit.sourceTurnIds.filter(
      (turnId) => !sourceTurnIds.includes(turnId)
    ),
    originalChars: original.length,
    projectedChars: text.length,
    projectionReason: "anchor-switch-latest-constraint",
    safe,
  };
}

export function createTaxonomyAdjudicationLease(input: {
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnit: LogicalQuestionUnit;
  taskBoundaryEpoch: number;
  manualCorrectionRevision: number;
  sourceSettlementId?: string;
  questionSourceHash?: string;
  expectedParentId?: string;
  expectedParentRevision?: number;
  operationId?: string;
  requestedAt?: number;
}): TaxonomyAdjudicationLease {
  return {
    operationId: input.operationId ?? createMeetingId("taxonomy_adjudication"),
    sessionId: input.sessionId,
    runtimeEpoch: input.runtimeEpoch,
    logicalQuestionUnitId: input.logicalQuestionUnit.id,
    logicalQuestionUnitRevision: input.logicalQuestionUnit.revision,
    sourceTurnIdsHash: hashTaxonomySourceTurnIds(
      input.logicalQuestionUnit.sourceTurnIds
    ),
    sourceSettlementId: input.sourceSettlementId,
    questionSourceHash: input.questionSourceHash,
    taskBoundaryEpoch: input.taskBoundaryEpoch,
    manualCorrectionRevision: input.manualCorrectionRevision,
    expectedParentId: input.expectedParentId,
    expectedParentRevision: input.expectedParentRevision,
    requestedAt: input.requestedAt ?? Date.now(),
  };
}

export function authorizeTaxonomyAdjudicationLease(
  lease: TaxonomyAdjudicationLease,
  current: TaxonomyAdjudicationLeaseSnapshot
):
  | { authorized: true }
  | { authorized: false; reason: TaxonomyAdjudicationLeaseRejectionReason } {
  const reject = (reason: TaxonomyAdjudicationLeaseRejectionReason) => ({
    authorized: false as const,
    reason,
  });
  if (lease.operationId !== current.currentOperationId) {
    return reject("current-operation-mismatch");
  }
  if (lease.sessionId !== current.sessionId) return reject("session-mismatch");
  if (lease.runtimeEpoch !== current.runtimeEpoch) {
    return reject("runtime-epoch-mismatch");
  }
  const unit = current.logicalQuestionUnit;
  if (!unit) return reject("logical-unit-missing");
  if (lease.logicalQuestionUnitId !== unit.id) {
    return reject("logical-unit-id-mismatch");
  }
  if (lease.logicalQuestionUnitRevision !== unit.revision) {
    return reject("logical-unit-revision-mismatch");
  }
  if (lease.sourceTurnIdsHash !== hashTaxonomySourceTurnIds(unit.sourceTurnIds)) {
    return reject("source-turn-hash-mismatch");
  }
  if (
    lease.sourceSettlementId !== undefined &&
    lease.sourceSettlementId !== current.sourceSettlementId
  ) {
    return reject("source-settlement-mismatch");
  }
  if (lease.taskBoundaryEpoch !== current.taskBoundaryEpoch) {
    return reject("task-boundary-epoch-mismatch");
  }
  if (lease.manualCorrectionRevision !== current.manualCorrectionRevision) {
    return reject("manual-correction-revision-mismatch");
  }
  if (lease.expectedParentId !== current.activeParentId) {
    return reject("expected-parent-mismatch");
  }
  if (lease.expectedParentRevision !== current.activeParentRevision) {
    return reject("expected-parent-revision-mismatch");
  }
  if (current.logicalUnitClosed) return reject("logical-unit-closed");
  if (current.selfHealingBudgetConsumed) {
    return reject("self-healing-budget-consumed");
  }
  return { authorized: true };
}

export function hashTaxonomySourceTurnIds(sourceTurnIds: string[]) {
  let hash = 2_166_136_261;
  for (const character of sourceTurnIds.join("\u001f")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function hashTaxonomyTaskBoundary(input: {
  parentId?: string;
  questionType?: CanonicalQuestionType;
  relation?: string;
}) {
  return Number.parseInt(
    hashTaxonomySourceTurnIds([
      input.parentId ?? "none",
      input.questionType ?? "unknown",
      input.relation ?? "unknown",
    ]),
    16
  );
}

function splitSentences(value: string) {
  return value
    .split(/(?<=[.!?。！？])\s+|\n+/u)
    .map(normalizeSpace)
    .filter(Boolean);
}

function normalizeAdjudicationSourceTurns(
  unit: LogicalQuestionUnit
): TaxonomyAdjudicationSourceTurn[] {
  const correctionApplied = Boolean(
    unit.termCorrectionOverlays?.length ||
      unit.sources.some(
        (source) => source.appliedSpeechCorrectionIds?.length
      )
  );
  const effectiveSources = correctionApplied
    ? [
        {
          turnId: unit.currentTurnId,
          text:
            unit.primaryAskProjection?.semanticEvidenceText ??
            unit.normalizedText,
        },
      ]
    : unit.sources;
  const sources = effectiveSources
    .map((source) => ({
      turnId: source.turnId,
      text: normalizeSpace(source.text),
    }))
    .filter((source) => source.turnId && source.text);
  if (sources.length) return sources;
  const fallbackText = normalizeSpace(unit.normalizedText);
  const fallbackTurnId = unit.currentTurnId || unit.sourceTurnIds[0];
  return fallbackText && fallbackTurnId
    ? [{ turnId: fallbackTurnId, text: fallbackText }]
    : [];
}

function joinAdjudicationSourceTurns(
  sources: TaxonomyAdjudicationSourceTurn[]
) {
  return sources.map((source) => source.text).join("\n");
}

function fitSourceSegments(
  segments: TaxonomyAdjudicationSourceTurn[],
  maxChars: number
) {
  const fitted: TaxonomyAdjudicationSourceTurn[] = [];
  let remaining = maxChars;
  for (const segment of segments) {
    const separatorChars = fitted.length ? 1 : 0;
    if (remaining <= separatorChars) break;
    const text = clipSourceText(
      segment.text,
      remaining - separatorChars,
      "start"
    );
    if (!segment.turnId || !text) continue;
    fitted.push({ turnId: segment.turnId, text });
    remaining -= text.length + separatorChars;
  }

  const grouped = new Map<string, string[]>();
  for (const segment of fitted) {
    const values = grouped.get(segment.turnId) ?? [];
    values.push(segment.text);
    grouped.set(segment.turnId, values);
  }
  return [...grouped].map(([turnId, values]) => ({
    turnId,
    text: values.join("\n"),
  }));
}

function clipSourceText(
  value: string,
  maxChars: number,
  side: "start" | "end"
) {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  return side === "start"
    ? value.slice(0, maxChars).trimEnd()
    : value.slice(-maxChars).trimStart();
}

function dedupeSourceSegments(values: TaxonomyAdjudicationSourceTurn[]) {
  const seen = new Set<string>();
  const result: TaxonomyAdjudicationSourceTurn[] = [];
  for (const value of values) {
    const text = normalizeSpace(value.text);
    const key = `${value.turnId}\u001f${text.toLocaleLowerCase()}`;
    if (!value.turnId || !text || seen.has(key)) continue;
    seen.add(key);
    result.push({ turnId: value.turnId, text });
  }
  return result;
}

function normalizeSpace(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

const TASK_SWITCH_PATTERN =
  /\b(?:instead|now|next|switch|different|new question|separate question|move on|rather than)\b|(?:换一道|下一个|改成|另外一个|新问题)/iu;

const CURRENT_CONSTRAINT_PATTERN =
  /\b(?:use|without|with|in (?:python|java|javascript|typescript|go|rust|c\+\+)|scale|qps|latency|throughput|complexity|requirement|constraint|metric|evaluate|implement|write|code)\b|(?:使用|不用|改用|规模|并发|复杂度|约束|指标|实现|写代码)/iu;
