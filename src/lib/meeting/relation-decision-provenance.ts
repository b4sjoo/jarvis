export type OrderedTaskRelationResolutionStage =
  | "runtime-matrix"
  | "canonical-relation"
  | "source-topology-null-hypothesis";

export interface OrderedRelationProvenance {
  operationId?: string;
  stage: OrderedTaskRelationResolutionStage;
  reason: string;
  relation: string;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  revision: number;
  sourceHash: string;
}

type RelationSourceIdentity = Pick<OrderedRelationProvenance,
  "sessionId" | "runtimeEpoch" | "logicalQuestionUnitId" | "revision" | "sourceHash">;

export function createOrderedRelationProvenance(
  question: RelationSourceIdentity,
  decision: { status: "resolved" | "unresolved"; stage?: OrderedTaskRelationResolutionStage; reason: string; relation?: string } | undefined,
  operationId?: string
): OrderedRelationProvenance | undefined {
  if (decision?.status !== "resolved" || !decision.stage) return;
  return { operationId, stage: decision.stage, reason: decision.reason, relation: decision.relation ?? "none",
    sessionId: question.sessionId, runtimeEpoch: question.runtimeEpoch,
    logicalQuestionUnitId: question.logicalQuestionUnitId, revision: question.revision, sourceHash: question.sourceHash };
}

/** Called only after the existing selector has chosen a proposal. No decision authority. */
export function adoptedOrderedRelationProvenance(
  proposal: { source: string; relation?: string; orderedRelationProvenance?: OrderedRelationProvenance } | undefined,
  question: RelationSourceIdentity
): OrderedRelationProvenance | undefined {
  const evidence = proposal?.orderedRelationProvenance;
  if (!evidence || proposal.source === "manual-correction" || evidence.relation !== proposal.relation ||
      evidence.sessionId !== question.sessionId || evidence.runtimeEpoch !== question.runtimeEpoch ||
      evidence.logicalQuestionUnitId !== question.logicalQuestionUnitId || evidence.revision !== question.revision ||
      evidence.sourceHash !== question.sourceHash) return;
  return { ...evidence };
}

export interface RelationDecisionProvenanceObservation {
  derivationVersion: "task152-relation-provenance-v1";
  executionSource?: string;
  ordered?: OrderedRelationProvenance;
}

/** Read one coherent metadata record; never join same-valued proposals across steps. */
export function observeRelationDecisionProvenance(metadata: Record<string, unknown> = {}): RelationDecisionProvenanceObservation {
  const observation: RelationDecisionProvenanceObservation = {
    derivationVersion: "task152-relation-provenance-v1",
    executionSource: typeof metadata.currentQuestionSettlementRelationAuthoritySource === "string"
      ? metadata.currentQuestionSettlementRelationAuthoritySource : undefined,
  };
  const raw = metadata.currentQuestionSettlementOrderedRelationProvenance;
  if (metadata.effectiveCurrentQuestionSettlementMaterialized !== true) return observation;
  if (!raw || typeof raw !== "object") return observation;
  const p = raw as OrderedRelationProvenance;
  if (!["runtime-matrix", "canonical-relation", "source-topology-null-hypothesis"].includes(p.stage) ||
      typeof p.reason !== "string" || !p.reason ||
      ![p.sessionId, p.logicalQuestionUnitId, p.sourceHash, p.relation].every(value => typeof value === "string" && value.length > 0) ||
      !Number.isSafeInteger(p.runtimeEpoch) || !Number.isSafeInteger(p.revision) ||
      p.sessionId !== metadata.currentQuestionSettlementSessionId ||
      p.runtimeEpoch !== metadata.currentQuestionSettlementRuntimeEpoch ||
      p.logicalQuestionUnitId !== metadata.currentQuestionSettlementUnitId ||
      p.revision !== metadata.currentQuestionSettlementRevision ||
      p.sourceHash !== metadata.currentQuestionSettlementSourceHash ||
      p.relation !== metadata.currentQuestionSettlementRelation) return observation;
  if (metadata.effectiveCurrentQuestionSettlementMaterialized === true && (
    metadata.effectiveCurrentQuestionSettlementId !== metadata.currentQuestionSettlementId ||
    metadata.effectiveCurrentQuestionSettlementSessionId !== p.sessionId ||
    metadata.effectiveCurrentQuestionSettlementUnitId !== p.logicalQuestionUnitId ||
    metadata.effectiveCurrentQuestionSettlementUnitRevision !== p.revision ||
    metadata.effectiveCurrentQuestionSettlementSourceHash !== p.sourceHash ||
    metadata.effectiveCurrentQuestionSettlementRelation !== p.relation)) return observation;
  return { ...observation, ordered: { ...p } };
}
