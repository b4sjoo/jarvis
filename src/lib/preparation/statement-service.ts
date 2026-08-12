import {
  getChatProvider,
  loadModelRouteSettings,
  loadProviderSecret,
  requestChatCompletion,
  sha256,
} from "../calling/index.js";
import {
  decodeJson,
  encodeJson,
  loadPreparationDatabase,
  type SqlDatabase,
  withTransaction,
} from "./database.js";
import { serializePreparationContext } from "./conversation-service.js";
import { composePreparationContext } from "./preparation-context.js";
import { inspectStatementSourceAuthority } from "./source-authority.js";
import {
  requireExpectedRevision,
  requireStatementConfirmation,
  requireTransition,
  STATEMENT_REVIEW_TRANSITIONS,
} from "./state-machines.js";
import type {
  CaseParty,
  CaseRevision,
  CaseSourceRef,
  CaseStatement,
  CaseStatementKind,
  ClaimState,
  CommitmentDetail,
  DeadlineDetail,
  PreparationConversation,
  StatementReviewState,
} from "./types.js";

const STATEMENT_KINDS = new Set<CaseStatementKind>([
  "objective", "fact", "claim", "unknown", "risk", "commitment",
  "deadline", "reference-number", "action",
]);
const CLAIM_STATES = new Set<ClaimState>([
  "asserted", "supported", "disputed", "unknown", "stale",
]);
const HIGH_IMPACT_KINDS = new Set<CaseStatementKind>([
  "claim", "commitment", "deadline", "reference-number",
]);

const PROPOSAL_SYSTEM_PROMPT = `You propose reviewable Case Statements for MOSS.
Return only JSON with this shape:
{"statements":[{"kind":"fact|claim|unknown|risk|commitment|deadline|reference-number|action|objective","content":"...","claimState":"asserted|supported|disputed|unknown|stale","sourceMessageIds":["..."],"sourceChunkIds":["..."],"allowedUses":["call-preparation"],"allowedWording":"optional","jurisdiction":"optional","commitmentDetail":{"promisorPartyId":"...","beneficiaryPartyId":"optional","action":"...","conditions":["..."],"certainty":"explicit|conditional|ambiguous","lifecycle":"pending-confirmation|active|fulfilled|missed|disputed|superseded|cancelled"},"deadlineDetail":{"linkedStatementId":"...","originalPhrase":"...","precision":"exact|range|relative|unknown","dayKind":"calendar|business|unspecified","timezone":"optional","anchorDate":"optional ISO date","resolvedDate":"optional ISO date"}}]}
Keep source roles separate. A user message can support what the user asserted; an assistant message is never evidence. Material chunk IDs must exactly match the supplied identifiers. Do not confirm proposals or invent source IDs. Preserve conditions, speaker attribution, original relative dates, uncertainty, and reference numbers in the statement text.`;

interface StatementRow {
  id: string;
  case_id: string;
  revision: number;
  kind: CaseStatementKind;
  content: string;
  subject_party_id: string | null;
  speaker_party_id: string | null;
  review_state: StatementReviewState;
  claim_state: ClaimState;
  jurisdiction: string | null;
  valid_from: number | null;
  valid_until: number | null;
  allowed_uses_json: string;
  allowed_wording: string | null;
  source_status: CaseStatement["sourceStatus"];
  source_stale_reasons_json: string;
  commitment_detail_json: string | null;
  deadline_detail_json: string | null;
  supersedes_id: string | null;
  created_by: CaseStatement["createdBy"];
  created_at: number;
  updated_at: number;
}

interface SourceRow {
  id: string;
  statement_id: string;
  source_kind: CaseSourceRef["sourceKind"];
  source_id: string;
  source_revision: number | null;
  content_hash: string;
  page_number: number | null;
  quoted_text: string | null;
}

interface PartyRow {
  id: string;
  case_id: string;
  display_name: string;
  role: CaseParty["role"];
  organization: string | null;
  review_state: StatementReviewState;
  source_refs_json: string;
  row_revision: number;
  created_at: number;
  updated_at: number;
}

export interface StatementProposalDraft {
  kind: CaseStatementKind;
  content: string;
  claimState: ClaimState;
  sourceMessageIds: string[];
  sourceChunkIds: string[];
  allowedUses: string[];
  allowedWording?: string;
  jurisdiction?: string;
  commitmentDetail?: CommitmentDetail;
  deadlineDetail?: DeadlineDetail;
}

export const isHighImpactStatement = (kind: CaseStatementKind) =>
  HIGH_IMPACT_KINDS.has(kind);

export function requireStructuredStatementDetails(input: {
  kind: CaseStatementKind;
  commitmentDetail?: CommitmentDetail;
  deadlineDetail?: DeadlineDetail;
}) {
  if (input.kind === "commitment" && !input.commitmentDetail) {
    throw new Error("Commitment details are required before confirmation.");
  }
  if (input.kind === "deadline" && !input.deadlineDetail) {
    throw new Error("Deadline details are required before confirmation.");
  }
}

const cleanJson = (value: string) => value
  .trim()
  .replace(/^```(?:json)?\s*/i, "")
  .replace(/\s*```$/, "")
  .trim();

const COMMITMENT_CERTAINTIES = new Set<CommitmentDetail["certainty"]>([
  "explicit", "conditional", "ambiguous",
]);
const COMMITMENT_LIFECYCLES = new Set<CommitmentDetail["lifecycle"]>([
  "pending-confirmation", "active", "fulfilled", "missed", "disputed",
  "superseded", "cancelled",
]);
const DEADLINE_PRECISIONS = new Set<DeadlineDetail["precision"]>([
  "exact", "range", "relative", "unknown",
]);
const DEADLINE_DAY_KINDS = new Set<NonNullable<DeadlineDetail["dayKind"]>>([
  "calendar", "business", "unspecified",
]);

const optionalText = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export const parseCommitmentDetail = (
  value: unknown,
  index: number
): CommitmentDetail | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const promisorPartyId = optionalText(record.promisorPartyId);
  const action = optionalText(record.action);
  const certainty = record.certainty as CommitmentDetail["certainty"];
  const lifecycle = record.lifecycle as CommitmentDetail["lifecycle"];
  if (
    !promisorPartyId ||
    !action ||
    !COMMITMENT_CERTAINTIES.has(certainty) ||
    !COMMITMENT_LIFECYCLES.has(lifecycle)
  ) {
    throw new Error(`Statement proposal ${index + 1} has invalid commitment details.`);
  }
  return {
    promisorPartyId,
    beneficiaryPartyId: optionalText(record.beneficiaryPartyId),
    action,
    conditions: Array.isArray(record.conditions)
      ? record.conditions.filter((item): item is string => typeof item === "string")
          .map((item) => item.trim()).filter(Boolean)
      : [],
    certainty,
    lifecycle,
  };
};

export const parseDeadlineDetail = (
  value: unknown,
  index: number
): DeadlineDetail | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const linkedStatementId = optionalText(record.linkedStatementId);
  const originalPhrase = optionalText(record.originalPhrase);
  const precision = record.precision as DeadlineDetail["precision"];
  const dayKind = optionalText(record.dayKind) as DeadlineDetail["dayKind"];
  if (
    !linkedStatementId ||
    !originalPhrase ||
    !DEADLINE_PRECISIONS.has(precision) ||
    (dayKind && !DEADLINE_DAY_KINDS.has(dayKind))
  ) {
    throw new Error(`Statement proposal ${index + 1} has invalid deadline details.`);
  }
  return {
    linkedStatementId,
    originalPhrase,
    precision,
    dayKind,
    timezone: optionalText(record.timezone),
    anchorDate: optionalText(record.anchorDate),
    resolvedDate: optionalText(record.resolvedDate),
  };
};

export function parseStatementProposalResponse(value: string): StatementProposalDraft[] {
  const parsed = JSON.parse(cleanJson(value)) as { statements?: unknown[] };
  if (!Array.isArray(parsed.statements)) throw new Error("Statement proposal response is missing statements.");
  return parsed.statements.map((item, index) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
    if (!STATEMENT_KINDS.has(record.kind as CaseStatementKind)) {
      throw new Error(`Statement proposal ${index + 1} has an unknown kind.`);
    }
    if (!CLAIM_STATES.has(record.claimState as ClaimState)) {
      throw new Error(`Statement proposal ${index + 1} has an unknown claim state.`);
    }
    const content = typeof record.content === "string" ? record.content.trim() : "";
    if (!content) throw new Error(`Statement proposal ${index + 1} is empty.`);
    const strings = (candidate: unknown) => Array.isArray(candidate)
      ? candidate.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())).map((entry) => entry.trim())
      : [];
    return {
      kind: record.kind as CaseStatementKind,
      content,
      claimState: record.claimState as ClaimState,
      sourceMessageIds: strings(record.sourceMessageIds),
      sourceChunkIds: strings(record.sourceChunkIds),
      allowedUses: strings(record.allowedUses),
      allowedWording: typeof record.allowedWording === "string" && record.allowedWording.trim() ? record.allowedWording.trim() : undefined,
      jurisdiction: typeof record.jurisdiction === "string" && record.jurisdiction.trim() ? record.jurisdiction.trim() : undefined,
      commitmentDetail: parseCommitmentDetail(record.commitmentDetail, index),
      deadlineDetail: parseDeadlineDetail(record.deadlineDetail, index),
    };
  });
}

export async function requireStructuredStatementReferences(
  database: SqlDatabase,
  statement: CaseStatement
) {
  if (statement.commitmentDetail) {
    const partyIds = [
      statement.commitmentDetail.promisorPartyId,
      statement.commitmentDetail.beneficiaryPartyId,
    ].filter((value): value is string => Boolean(value));
    const placeholders = partyIds.map(() => "?").join(",");
    const rows = partyIds.length
      ? await database.select<Array<{ id: string }>>(
        `SELECT id FROM case_parties WHERE case_id = ?
         AND review_state = 'confirmed' AND id IN (${placeholders})`,
        [statement.caseId, ...partyIds]
      )
      : [];
    if (new Set(rows.map((row) => row.id)).size !== new Set(partyIds).size) {
      throw new Error("Commitment parties must be confirmed parties in this Case.");
    }
  }
  if (statement.deadlineDetail) {
    if (statement.deadlineDetail.linkedStatementId === statement.id) {
      throw new Error("A deadline cannot link to itself.");
    }
    const rows = await database.select<Array<{
      id: string;
      kind: CaseStatementKind;
      review_state: StatementReviewState;
    }>>(
      `SELECT id, kind, review_state FROM case_statements
       WHERE id = ? AND case_id = ?`,
      [statement.deadlineDetail.linkedStatementId, statement.caseId]
    );
    const linked = rows[0];
    if (
      !linked ||
      linked.review_state !== "confirmed" ||
      !["commitment", "action"].includes(linked.kind)
    ) {
      throw new Error("A deadline must link to a confirmed commitment or action in this Case.");
    }
  }
}

const mapSource = (row: SourceRow): CaseSourceRef => ({
  id: row.id,
  sourceKind: row.source_kind,
  sourceId: row.source_id,
  sourceRevision: row.source_revision ?? undefined,
  contentHash: row.content_hash,
  pageNumber: row.page_number ?? undefined,
  quotedText: row.quoted_text ?? undefined,
});

const mapStatement = (row: StatementRow, sources: CaseSourceRef[]): CaseStatement => ({
  id: row.id,
  caseId: row.case_id,
  revision: row.revision,
  kind: row.kind,
  content: row.content,
  subjectPartyId: row.subject_party_id ?? undefined,
  speakerPartyId: row.speaker_party_id ?? undefined,
  sourceRefs: sources,
  reviewState: row.review_state,
  claimState: row.claim_state,
  sourceStatus: row.source_status,
  sourceStaleReasons: decodeJson<string[]>(row.source_stale_reasons_json, []),
  jurisdiction: row.jurisdiction ?? undefined,
  validFrom: row.valid_from ?? undefined,
  validUntil: row.valid_until ?? undefined,
  allowedUses: decodeJson(row.allowed_uses_json, []),
  allowedWording: row.allowed_wording ?? undefined,
  commitmentDetail: row.commitment_detail_json
    ? decodeJson<CommitmentDetail | undefined>(row.commitment_detail_json, undefined)
    : undefined,
  deadlineDetail: row.deadline_detail_json
    ? decodeJson<DeadlineDetail | undefined>(row.deadline_detail_json, undefined)
    : undefined,
  supersedesId: row.supersedes_id ?? undefined,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapParty = (row: PartyRow): CaseParty => ({
  id: row.id,
  caseId: row.case_id,
  displayName: row.display_name,
  role: row.role,
  organization: row.organization ?? undefined,
  reviewState: row.review_state,
  sourceRefs: decodeJson(row.source_refs_json, []),
  rowRevision: row.row_revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class ReviewedCaseStateService {
  constructor(private readonly database: SqlDatabase) {}

  static async open() {
    return new ReviewedCaseStateService(await loadPreparationDatabase());
  }

  async listStatements(caseId: string) {
    const rows = await this.database.select<StatementRow[]>(
      "SELECT * FROM case_statements WHERE case_id = ? ORDER BY updated_at DESC",
      [caseId]
    );
    if (!rows.length) return [];
    const sources = await this.database.select<SourceRow[]>(
      `SELECT source.* FROM case_statement_sources source
       JOIN case_statements statement ON statement.id = source.statement_id
       WHERE statement.case_id = ? ORDER BY source.created_at ASC`,
      [caseId]
    );
    return rows.map((row) => mapStatement(
      row,
      sources.filter((source) => source.statement_id === row.id).map(mapSource)
    ));
  }

  async listParties(caseId: string) {
    const rows = await this.database.select<PartyRow[]>(
      "SELECT * FROM case_parties WHERE case_id = ? ORDER BY updated_at DESC",
      [caseId]
    );
    return rows.map(mapParty);
  }

  async createParty(input: {
    caseId: string;
    displayName: string;
    role: CaseParty["role"];
    organization?: string;
  }) {
    const displayName = input.displayName.trim();
    if (!displayName) throw new Error("Party name is required.");
    const now = Date.now();
    const sourceText = [displayName, input.organization].filter(Boolean).join(" at ");
    const sourceRef: CaseSourceRef = {
      id: `source_${crypto.randomUUID()}`,
      sourceKind: "user",
      sourceId: `user_entry_${crypto.randomUUID()}`,
      contentHash: await sha256(sourceText),
      quotedText: sourceText,
    };
    const party: CaseParty = {
      id: `party_${crypto.randomUUID()}`,
      caseId: input.caseId,
      displayName,
      role: input.role,
      organization: input.organization?.trim() || undefined,
      reviewState: "confirmed",
      sourceRefs: [sourceRef],
      rowRevision: 1,
      createdAt: now,
      updatedAt: now,
    };
    await withTransaction(this.database, async (transaction) => {
      await transaction.execute(
        `INSERT INTO case_parties (id, case_id, display_name, role, organization, review_state,
          source_refs_json, row_revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'confirmed', ?, 1, ?, ?)`,
        [party.id, party.caseId, party.displayName, party.role, party.organization ?? null, encodeJson(party.sourceRefs), now, now]
      );
      await this.commitCaseRevision(
        { caseId: input.caseId, partyId: party.id, commandId: `party_command_${crypto.randomUUID()}` },
        transaction
      );
    });
    return party;
  }

  async createManualStatement(input: {
    caseId: string;
    kind: CaseStatementKind;
    content: string;
    claimState: ClaimState;
    allowedUses?: string[];
    allowedWording?: string;
    jurisdiction?: string;
    commitmentDetail?: CommitmentDetail;
    deadlineDetail?: DeadlineDetail;
  }) {
    const content = input.content.trim();
    if (!content) throw new Error("Statement content is required.");
    const source: CaseSourceRef = {
      id: `statement_source_${crypto.randomUUID()}`,
      sourceKind: "user",
      sourceId: `user_entry_${crypto.randomUUID()}`,
      contentHash: await sha256(content),
      quotedText: content,
    };
    return this.insertProposal({
      caseId: input.caseId,
      kind: input.kind,
      content,
      claimState: input.claimState,
      sourceRefs: [source],
      allowedUses: input.allowedUses ?? ["call-preparation"],
      allowedWording: input.allowedWording,
      jurisdiction: input.jurisdiction,
      commitmentDetail: input.commitmentDetail,
      deadlineDetail: input.deadlineDetail,
      createdBy: "user",
    });
  }

  async proposeFromConversation(conversation: PreparationConversation) {
    const context = await composePreparationContext({
      database: this.database,
      conversationId: conversation.id,
      caseId: conversation.caseId,
      callPlanId: conversation.callPlanId,
      currentRequest: "Propose distinct reviewable Case Statements from the current preparation conversation and cited material.",
    });
    const route = loadModelRouteSettings().chat.complex;
    const provider = getChatProvider(route.provider);
    const apiKey = provider.requiresApiKey ? await loadProviderSecret("complex") : "";
    if (provider.requiresApiKey && !apiKey) throw new Error("Configure the Complex Task model before extracting reviewed state.");
    const operationId = `statement_proposal_${crypto.randomUUID()}`;
    const prompt = serializePreparationContext(context);
    await this.recordOperation(conversation.caseId, conversation.callPlanId, operationId, "statement-proposal", "dispatched", {
      provider: route.provider,
      model: route.model,
      contextHash: context.manifest.contextHash,
    });
    try {
      const response = await requestChatCompletion({
        route,
        apiKey,
        messages: [
          { role: "system", content: PROPOSAL_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
      });
      const drafts = parseStatementProposalResponse(response);
      const validMessages = await this.database.select<Array<{ id: string; revision: number; content: string }>>(
        "SELECT id, revision, content FROM preparation_messages WHERE conversation_id = ? AND role = 'user' AND status = 'committed'",
        [conversation.id]
      );
      const validChunks = await this.database.select<Array<{ id: string; content_hash: string; page_number: number | null; content: string }>>(
        `SELECT id, content_hash, page_number, content FROM extraction_chunks
         WHERE id IN (${context.manifest.extractionChunkIds.map(() => "?").join(",") || "NULL"})`,
        context.manifest.extractionChunkIds
      );
      const proposals: CaseStatement[] = [];
      for (const draft of drafts) {
        const messageSources: CaseSourceRef[] = draft.sourceMessageIds.flatMap((messageId) => {
          const message = validMessages.find((item) => item.id === messageId);
          return message ? [{
            id: `statement_source_${crypto.randomUUID()}`,
            sourceKind: "conversation" as const,
            sourceId: message.id,
            sourceRevision: message.revision,
            contentHash: "",
            quotedText: message.content.slice(0, 500),
          }] : [];
        });
        for (const source of messageSources) {
          const message = validMessages.find((item) => item.id === source.sourceId);
          source.contentHash = await sha256(message?.content ?? "");
        }
        const chunkSources: CaseSourceRef[] = draft.sourceChunkIds.flatMap((chunkId) => {
          const chunk = validChunks.find((item) => item.id === chunkId);
          return chunk ? [{
            id: `statement_source_${crypto.randomUUID()}`,
            sourceKind: "material" as const,
            sourceId: chunk.id,
            contentHash: chunk.content_hash,
            pageNumber: chunk.page_number ?? undefined,
            quotedText: chunk.content.slice(0, 500),
          }] : [];
        });
        proposals.push(await this.insertProposal({
          caseId: conversation.caseId,
          ...draft,
          sourceRefs: [...messageSources, ...chunkSources],
          createdBy: "complex-model-proposal",
        }));
      }
      await this.recordOperation(conversation.caseId, conversation.callPlanId, operationId, "statement-proposal", "committed", { proposalIds: proposals.map((item) => item.id) });
      return proposals;
    } catch (error) {
      await this.recordOperation(conversation.caseId, conversation.callPlanId, operationId, "statement-proposal", "failed", { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async editStatement(input: {
    statementId: string;
    expectedRevision: number;
    content: string;
    kind: CaseStatementKind;
    claimState: ClaimState;
    allowedUses: string[];
    allowedWording?: string;
    jurisdiction?: string;
    commitmentDetail?: CommitmentDetail;
    deadlineDetail?: DeadlineDetail;
  }) {
    const current = await this.getStatement(input.statementId);
    requireExpectedRevision({ entity: "CaseStatement", expected: input.expectedRevision, actual: current.revision });
    if (current.reviewState === "superseded") throw new Error("A superseded statement cannot be revised.");
    const content = input.content.trim();
    if (!content) throw new Error("Statement content is required.");
    const now = Date.now();
    const editSource: CaseSourceRef = {
      id: `statement_source_${crypto.randomUUID()}`,
      sourceKind: "user",
      sourceId: `user_edit_${crypto.randomUUID()}`,
      contentHash: await sha256(content),
      quotedText: content,
    };
    const replacement: CaseStatement = {
      ...current,
      id: `statement_${crypto.randomUUID()}`,
      revision: current.revision + 1,
      kind: input.kind,
      content,
      sourceRefs: [editSource],
      reviewState: "proposed",
      claimState: input.claimState,
      sourceStatus: "current",
      sourceStaleReasons: [],
      allowedUses: input.allowedUses,
      allowedWording: input.allowedWording?.trim() || undefined,
      jurisdiction: input.jurisdiction?.trim() || undefined,
      commitmentDetail: input.commitmentDetail,
      deadlineDetail: input.deadlineDetail,
      supersedesId: current.id,
      createdBy: "user",
      createdAt: now,
      updatedAt: now,
    };
    await withTransaction(this.database, async (transaction) => {
      await this.insertStatement(replacement, transaction);
      if (current.reviewState !== "confirmed") {
        const changed = await transaction.execute(
          `UPDATE case_statements SET review_state = 'superseded', updated_at = ?
           WHERE id = ? AND revision = ? AND review_state = ?`,
          [now, current.id, input.expectedRevision, current.reviewState]
        );
        if (changed.rowsAffected !== 1) throw new Error("CaseStatement revision conflict.");
        await this.insertStatementEvent({
          caseId: current.caseId,
          statementId: current.id,
          eventType: "review-transition",
          revision: current.revision,
          fromStatementId: current.id,
          toStatementId: replacement.id,
          fromState: current.reviewState,
          toState: "superseded",
        }, transaction);
      }
      await this.insertStatementEvent({
        caseId: current.caseId,
        statementId: replacement.id,
        eventType: "edited",
        revision: replacement.revision,
        fromStatementId: current.id,
        toStatementId: replacement.id,
        fromState: current.reviewState,
        toState: "proposed",
      }, transaction);
    });
    if (current.createdBy === "complex-model-proposal") {
      await this.recordDerivedEvaluation(current.caseId, current.id, "needs-edit");
    }
    return replacement;
  }

  async confirmStatement(statementId: string, expectedRevision: number) {
    const current = await this.getStatement(statementId);
    requireExpectedRevision({ entity: "CaseStatement", expected: expectedRevision, actual: current.revision });
    requireStatementConfirmation({
      reviewState: current.reviewState,
      sourceCount: current.sourceRefs.length,
      highImpact: isHighImpactStatement(current.kind),
    });
    requireStructuredStatementDetails(current);
    await requireStructuredStatementReferences(this.database, current);
    const authority = await inspectStatementSourceAuthority(this.database, current.id);
    if (authority.status !== "current") {
      throw new Error(`Statement sources changed: ${authority.reasons.join(", ")}`);
    }
    await withTransaction(this.database, async (transaction) => {
      let replacedConfirmedId: string | undefined;
      if (current.supersedesId) {
        const replaced = await transaction.select<Array<{ review_state: StatementReviewState }>>(
          "SELECT review_state FROM case_statements WHERE id = ? AND case_id = ?",
          [current.supersedesId, current.caseId]
        );
        if (replaced[0]?.review_state === "confirmed") {
          const superseded = await transaction.execute(
            `UPDATE case_statements SET review_state = 'superseded', updated_at = ?
             WHERE id = ? AND case_id = ? AND review_state = 'confirmed'`,
            [Date.now(), current.supersedesId, current.caseId]
          );
          if (superseded.rowsAffected !== 1) throw new Error("Superseded statement changed before confirmation.");
          replacedConfirmedId = current.supersedesId;
          await this.insertStatementEvent({
            caseId: current.caseId,
            statementId: current.supersedesId,
            eventType: "review-transition",
            revision: Math.max(1, current.revision - 1),
            fromState: "confirmed",
            toState: "superseded",
            toStatementId: current.id,
          }, transaction);
        }
      }
      const changed = await transaction.execute(
        `UPDATE case_statements SET review_state = 'confirmed', updated_at = ?
         WHERE id = ? AND revision = ? AND review_state IN ('proposed', 'rejected')`,
        [Date.now(), current.id, expectedRevision]
      );
      if (changed.rowsAffected !== 1) throw new Error("CaseStatement revision conflict.");
      await this.commitCaseRevision(
        {
          caseId: current.caseId,
          statement: { ...current, reviewState: "confirmed" },
          removeStatementId: replacedConfirmedId,
          commandId: `confirm_statement_${crypto.randomUUID()}`,
        },
        transaction
      );
      await this.insertStatementEvent({
        caseId: current.caseId,
        statementId: current.id,
        eventType: "review-transition",
        revision: current.revision,
        fromState: current.reviewState,
        toState: "confirmed",
      }, transaction);
    });
    await this.recordReviewEvent(current.caseId, current.id, "confirmed", expectedRevision);
    if (current.createdBy === "complex-model-proposal") {
      await this.recordDerivedEvaluation(current.caseId, current.id, "correct");
    }
  }

  async rejectStatement(statementId: string, expectedRevision: number) {
    return this.transitionStatement(statementId, expectedRevision, "rejected");
  }

  async supersedeStatement(statementId: string, expectedRevision: number) {
    const current = await this.getStatement(statementId);
    requireExpectedRevision({ entity: "CaseStatement", expected: expectedRevision, actual: current.revision });
    requireTransition({ entity: "CaseStatement", from: current.reviewState, to: "superseded", allowed: STATEMENT_REVIEW_TRANSITIONS });
    await withTransaction(this.database, async (transaction) => {
      const changed = await transaction.execute(
        "UPDATE case_statements SET review_state = 'superseded', updated_at = ? WHERE id = ? AND revision = ? AND review_state = ?",
        [Date.now(), current.id, expectedRevision, current.reviewState]
      );
      if (changed.rowsAffected !== 1) throw new Error("CaseStatement revision conflict.");
      if (current.reviewState === "confirmed") {
        await this.commitCaseRevision(
          { caseId: current.caseId, removeStatementId: current.id, commandId: `supersede_statement_${crypto.randomUUID()}` },
          transaction
        );
      }
      await this.insertStatementEvent({
        caseId: current.caseId,
        statementId: current.id,
        eventType: "review-transition",
        revision: current.revision,
        fromState: current.reviewState,
        toState: "superseded",
      }, transaction);
    });
    await this.recordReviewEvent(current.caseId, current.id, "superseded", expectedRevision);
  }

  private async transitionStatement(statementId: string, expectedRevision: number, state: StatementReviewState) {
    const current = await this.getStatement(statementId);
    requireExpectedRevision({ entity: "CaseStatement", expected: expectedRevision, actual: current.revision });
    requireTransition({ entity: "CaseStatement", from: current.reviewState, to: state, allowed: STATEMENT_REVIEW_TRANSITIONS });
    const changed = await this.database.execute(
      "UPDATE case_statements SET review_state = ?, updated_at = ? WHERE id = ? AND revision = ? AND review_state = ?",
      [state, Date.now(), current.id, expectedRevision, current.reviewState]
    );
    if (changed.rowsAffected !== 1) throw new Error("CaseStatement revision conflict.");
    await this.insertStatementEvent({
      caseId: current.caseId,
      statementId: current.id,
      eventType: "review-transition",
      revision: current.revision,
      fromState: current.reviewState,
      toState: state,
    });
    await this.recordReviewEvent(current.caseId, current.id, state, expectedRevision);
  }

  private async getStatement(statementId: string) {
    const rows = await this.database.select<StatementRow[]>("SELECT * FROM case_statements WHERE id = ?", [statementId]);
    if (!rows[0]) throw new Error("CaseStatement was not found.");
    const sourceRows = await this.database.select<SourceRow[]>("SELECT * FROM case_statement_sources WHERE statement_id = ? ORDER BY created_at ASC", [statementId]);
    return mapStatement(rows[0], sourceRows.map(mapSource));
  }

  private async insertProposal(input: {
    caseId: string;
    kind: CaseStatementKind;
    content: string;
    claimState: ClaimState;
    sourceRefs: CaseSourceRef[];
    allowedUses: string[];
    allowedWording?: string;
    jurisdiction?: string;
    commitmentDetail?: CommitmentDetail;
    deadlineDetail?: DeadlineDetail;
    createdBy: CaseStatement["createdBy"];
  }) {
    const now = Date.now();
    const statement: CaseStatement = {
      id: `statement_${crypto.randomUUID()}`,
      caseId: input.caseId,
      revision: 1,
      kind: input.kind,
      content: input.content.trim(),
      sourceRefs: input.sourceRefs,
      reviewState: "proposed",
      claimState: input.claimState,
      sourceStatus: "current",
      sourceStaleReasons: [],
      jurisdiction: input.jurisdiction,
      allowedUses: input.allowedUses,
      allowedWording: input.allowedWording,
      commitmentDetail: input.commitmentDetail,
      deadlineDetail: input.deadlineDetail,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    await withTransaction(this.database, async (transaction) => {
      await this.insertStatement(statement, transaction);
      await this.insertStatementEvent({
        caseId: statement.caseId,
        statementId: statement.id,
        eventType: "created",
        revision: statement.revision,
        toStatementId: statement.id,
        toState: statement.reviewState,
      }, transaction);
    });
    return statement;
  }

  private async insertStatement(
    statement: CaseStatement,
    database: SqlDatabase = this.database
  ) {
    await database.execute(
      `INSERT INTO case_statements (
        id, case_id, revision, kind, content, subject_party_id, speaker_party_id,
        review_state, claim_state, jurisdiction, valid_from, valid_until,
        allowed_uses_json, allowed_wording, supersedes_id, created_by, created_at,
        updated_at, source_status, source_stale_reasons_json,
        commitment_detail_json, deadline_detail_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        statement.id,
        statement.caseId,
        statement.revision,
        statement.kind,
        statement.content,
        statement.subjectPartyId ?? null,
        statement.speakerPartyId ?? null,
        statement.reviewState,
        statement.claimState,
        statement.jurisdiction ?? null,
        statement.validFrom ?? null,
        statement.validUntil ?? null,
        encodeJson(statement.allowedUses),
        statement.allowedWording ?? null,
        statement.supersedesId ?? null,
        statement.createdBy,
        statement.createdAt,
        statement.updatedAt,
        statement.sourceStatus,
        encodeJson(statement.sourceStaleReasons),
        statement.commitmentDetail ? encodeJson(statement.commitmentDetail) : null,
        statement.deadlineDetail ? encodeJson(statement.deadlineDetail) : null,
      ]
    );
    for (const source of statement.sourceRefs) {
      await database.execute(
        `INSERT INTO case_statement_sources (
          id, statement_id, source_kind, source_id, source_revision,
          content_hash, page_number, quoted_text, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          source.id,
          statement.id,
          source.sourceKind,
          source.sourceId,
          source.sourceRevision ?? null,
          source.contentHash,
          source.pageNumber ?? null,
          source.quotedText ?? null,
          statement.createdAt,
        ]
      );
    }
  }

  private async insertStatementEvent(input: {
    caseId: string;
    statementId: string;
    eventType: "created" | "edited" | "review-transition";
    revision: number;
    fromStatementId?: string;
    toStatementId?: string;
    fromState?: StatementReviewState;
    toState?: StatementReviewState;
    payload?: unknown;
  }, database: SqlDatabase = this.database) {
    await database.execute(
      `INSERT INTO case_statement_events (
        id, case_id, statement_id, event_type, from_statement_id,
        to_statement_id, from_state, to_state, statement_revision,
        payload_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `statement_event_${crypto.randomUUID()}`,
        input.caseId,
        input.statementId,
        input.eventType,
        input.fromStatementId ?? null,
        input.toStatementId ?? null,
        input.fromState ?? null,
        input.toState ?? null,
        input.revision,
        encodeJson(input.payload ?? {}),
        Date.now(),
      ]
    );
  }

  private async commitCaseRevision(input: {
    caseId: string;
    statement?: CaseStatement;
    partyId?: string;
    removeStatementId?: string;
    commandId: string;
  }, database: SqlDatabase = this.database) {
    const rows = await database.select<Array<{
      row_revision: number;
      current_revision_id: string;
      id: string;
      revision: number;
      primary_objective: string;
      acceptable_fallbacks_json: string;
      party_ids_json: string;
      statement_ids_json: string;
      next_action_ids_json: string;
    }>>(
      `SELECT item.row_revision, item.current_revision_id, revision.*
       FROM cases item JOIN case_revisions revision ON revision.id = item.current_revision_id
       WHERE item.id = ? AND revision.case_id = item.id`,
      [input.caseId]
    );
    const current = rows[0];
    if (!current) throw new Error("Current CaseRevision was not found.");
    const statementIds = decodeJson<string[]>(current.statement_ids_json, [])
      .filter((id) => id !== input.removeStatementId);
    if (input.statement && !statementIds.includes(input.statement.id)) statementIds.push(input.statement.id);
    const partyIds = decodeJson<string[]>(current.party_ids_json, []);
    if (input.partyId && !partyIds.includes(input.partyId)) partyIds.push(input.partyId);
    const nextActionIds = decodeJson<string[]>(current.next_action_ids_json, [])
      .filter((id) => id !== input.removeStatementId);
    if (input.statement?.kind === "action" && !nextActionIds.includes(input.statement.id)) nextActionIds.push(input.statement.id);
    const revision: CaseRevision = {
      id: `case_revision_${crypto.randomUUID()}`,
      caseId: input.caseId,
      revision: current.revision + 1,
      parentRevisionId: current.id,
      primaryObjective: input.statement?.kind === "objective" ? input.statement.content : current.primary_objective,
      acceptableFallbacks: decodeJson(current.acceptable_fallbacks_json, []),
      partyIds,
      statementIds,
      nextActionIds,
      sourceCommandId: input.commandId,
      createdAt: Date.now(),
    };
    await database.execute(
      `INSERT INTO case_revisions (
        id, case_id, revision, parent_revision_id, primary_objective, acceptable_fallbacks_json,
        party_ids_json, statement_ids_json, next_action_ids_json, source_command_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [revision.id, revision.caseId, revision.revision, revision.parentRevisionId, revision.primaryObjective, encodeJson(revision.acceptableFallbacks), encodeJson(revision.partyIds), encodeJson(revision.statementIds), encodeJson(revision.nextActionIds), revision.sourceCommandId, revision.createdAt]
    );
    const changed = await database.execute(
      `UPDATE cases SET current_revision_id = ?, row_revision = row_revision + 1, updated_at = ?
       WHERE id = ? AND current_revision_id = ? AND row_revision = ?`,
      [revision.id, revision.createdAt, input.caseId, current.current_revision_id, current.row_revision]
    );
    if (changed.rowsAffected !== 1) throw new Error("CaseRevision commit conflict.");
  }

  private async recordReviewEvent(caseId: string, statementId: string, status: string, revision: number) {
    await this.recordOperation(caseId, undefined, `statement_review_${crypto.randomUUID()}`, "statement-review", status, { statementId, revision });
  }

  private async recordDerivedEvaluation(
    caseId: string,
    statementId: string,
    label: "correct" | "needs-edit"
  ) {
    await this.database.execute(
      `INSERT INTO preparation_human_evaluations (
        id, case_id, call_session_id, snapshot_id, subject_kind,
        subject_id, label, note, source, occurred_at
      ) VALUES (?, ?, NULL, NULL, 'statement-proposal', ?, ?, NULL, 'derived', ?)`,
      [`preparation_evaluation_${crypto.randomUUID()}`, caseId, statementId, label, Date.now()]
    );
  }

  private async recordOperation(caseId: string, callPlanId: string | undefined, operationId: string, kind: string, status: string, payload: unknown) {
    await this.database.execute(
      `INSERT INTO preparation_operation_events (
        id, case_id, call_plan_id, operation_id, operation_kind, status, payload_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [`preparation_event_${crypto.randomUUID()}`, caseId, callPlanId ?? null, operationId, kind, status, encodeJson(payload), Date.now()]
    );
  }
}
