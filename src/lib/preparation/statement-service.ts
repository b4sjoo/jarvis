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
{"statements":[{"kind":"fact|claim|unknown|risk|commitment|deadline|reference-number|action|objective","content":"...","claimState":"asserted|supported|disputed|unknown|stale","sourceMessageIds":["..."],"sourceChunkIds":["..."],"allowedUses":["call-preparation"],"allowedWording":"optional","jurisdiction":"optional"}]}
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
}

export const isHighImpactStatement = (kind: CaseStatementKind) =>
  HIGH_IMPACT_KINDS.has(kind);

const cleanJson = (value: string) => value
  .trim()
  .replace(/^```(?:json)?\s*/i, "")
  .replace(/\s*```$/, "")
  .trim();

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
    };
  });
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
  jurisdiction: row.jurisdiction ?? undefined,
  validFrom: row.valid_from ?? undefined,
  validUntil: row.valid_until ?? undefined,
  allowedUses: decodeJson(row.allowed_uses_json, []),
  allowedWording: row.allowed_wording ?? undefined,
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
    await withTransaction(this.database, async () => {
      await this.database.execute(
        `INSERT INTO case_parties (id, case_id, display_name, role, organization, review_state,
          source_refs_json, row_revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'confirmed', ?, 1, ?, ?)`,
        [party.id, party.caseId, party.displayName, party.role, party.organization ?? null, encodeJson(party.sourceRefs), now, now]
      );
      await this.commitCaseRevision({ caseId: input.caseId, partyId: party.id, commandId: `party_command_${crypto.randomUUID()}` });
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
        for (const source of messageSources) source.contentHash = await sha256(source.quotedText ?? "");
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
  }) {
    const current = await this.getStatement(input.statementId);
    requireExpectedRevision({ entity: "CaseStatement", expected: input.expectedRevision, actual: current.revision });
    if (current.reviewState !== "proposed" && current.reviewState !== "rejected") {
      throw new Error("Confirmed statements must be superseded rather than edited in place.");
    }
    const content = input.content.trim();
    if (!content) throw new Error("Statement content is required.");
    const result = await this.database.execute(
      `UPDATE case_statements SET content = ?, kind = ?, claim_state = ?, allowed_uses_json = ?,
       allowed_wording = ?, jurisdiction = ?, review_state = 'proposed', revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ?`,
      [content, input.kind, input.claimState, encodeJson(input.allowedUses), input.allowedWording?.trim() || null, input.jurisdiction?.trim() || null, Date.now(), input.statementId, input.expectedRevision]
    );
    if (result.rowsAffected !== 1) throw new Error("CaseStatement revision conflict.");
    await this.recordReviewEvent(current.caseId, current.id, "edited", input.expectedRevision + 1);
    if (current.createdBy === "complex-model-proposal") {
      await this.recordDerivedEvaluation(current.caseId, current.id, "needs-edit");
    }
  }

  async confirmStatement(statementId: string, expectedRevision: number) {
    const current = await this.getStatement(statementId);
    requireExpectedRevision({ entity: "CaseStatement", expected: expectedRevision, actual: current.revision });
    requireStatementConfirmation({
      reviewState: current.reviewState,
      sourceCount: current.sourceRefs.length,
      highImpact: isHighImpactStatement(current.kind),
    });
    await withTransaction(this.database, async () => {
      const changed = await this.database.execute(
        `UPDATE case_statements SET review_state = 'confirmed', revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ? AND review_state IN ('proposed', 'rejected')`,
        [Date.now(), current.id, expectedRevision]
      );
      if (changed.rowsAffected !== 1) throw new Error("CaseStatement revision conflict.");
      await this.commitCaseRevision({ caseId: current.caseId, statement: current, commandId: `confirm_statement_${crypto.randomUUID()}` });
    });
    await this.recordReviewEvent(current.caseId, current.id, "confirmed", expectedRevision + 1);
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
    await withTransaction(this.database, async () => {
      const changed = await this.database.execute(
        "UPDATE case_statements SET review_state = 'superseded', revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?",
        [Date.now(), current.id, expectedRevision]
      );
      if (changed.rowsAffected !== 1) throw new Error("CaseStatement revision conflict.");
      if (current.reviewState === "confirmed") {
        await this.commitCaseRevision({ caseId: current.caseId, removeStatementId: current.id, commandId: `supersede_statement_${crypto.randomUUID()}` });
      }
    });
    await this.recordReviewEvent(current.caseId, current.id, "superseded", expectedRevision + 1);
  }

  private async transitionStatement(statementId: string, expectedRevision: number, state: StatementReviewState) {
    const current = await this.getStatement(statementId);
    requireExpectedRevision({ entity: "CaseStatement", expected: expectedRevision, actual: current.revision });
    requireTransition({ entity: "CaseStatement", from: current.reviewState, to: state, allowed: STATEMENT_REVIEW_TRANSITIONS });
    const changed = await this.database.execute(
      "UPDATE case_statements SET review_state = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?",
      [state, Date.now(), current.id, expectedRevision]
    );
    if (changed.rowsAffected !== 1) throw new Error("CaseStatement revision conflict.");
    await this.recordReviewEvent(current.caseId, current.id, state, expectedRevision + 1);
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
      jurisdiction: input.jurisdiction,
      allowedUses: input.allowedUses,
      allowedWording: input.allowedWording,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    await withTransaction(this.database, async () => {
      await this.database.execute(
        `INSERT INTO case_statements (
          id, case_id, revision, kind, content, subject_party_id, speaker_party_id,
          review_state, claim_state, jurisdiction, valid_from, valid_until,
          allowed_uses_json, allowed_wording, supersedes_id, created_by, created_at, updated_at
        ) VALUES (?, ?, 1, ?, ?, NULL, NULL, 'proposed', ?, ?, NULL, NULL, ?, ?, NULL, ?, ?, ?)`,
        [statement.id, statement.caseId, statement.kind, statement.content, statement.claimState, statement.jurisdiction ?? null, encodeJson(statement.allowedUses), statement.allowedWording ?? null, statement.createdBy, now, now]
      );
      for (const source of statement.sourceRefs) {
        await this.database.execute(
          `INSERT INTO case_statement_sources (
            id, statement_id, source_kind, source_id, source_revision, content_hash, page_number, quoted_text, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [source.id, statement.id, source.sourceKind, source.sourceId, source.sourceRevision ?? null, source.contentHash, source.pageNumber ?? null, source.quotedText ?? null, now]
        );
      }
    });
    return statement;
  }

  private async commitCaseRevision(input: {
    caseId: string;
    statement?: CaseStatement;
    partyId?: string;
    removeStatementId?: string;
    commandId: string;
  }) {
    const rows = await this.database.select<Array<{
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
    await this.database.execute(
      `INSERT INTO case_revisions (
        id, case_id, revision, parent_revision_id, primary_objective, acceptable_fallbacks_json,
        party_ids_json, statement_ids_json, next_action_ids_json, source_command_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [revision.id, revision.caseId, revision.revision, revision.parentRevisionId, revision.primaryObjective, encodeJson(revision.acceptableFallbacks), encodeJson(revision.partyIds), encodeJson(revision.statementIds), encodeJson(revision.nextActionIds), revision.sourceCommandId, revision.createdAt]
    );
    const changed = await this.database.execute(
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
