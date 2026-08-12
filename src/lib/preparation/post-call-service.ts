import {
  canonicalize,
  getChatProvider,
  loadModelRouteSettings,
  loadProviderSecret,
  requestChatCompletion,
  sha256,
  type CallTranscriptTurn,
} from "../calling/index.js";
import {
  decodeJson,
  encodeJson,
  loadPreparationDatabase,
  type SqlDatabase,
  withTransaction,
} from "./database.js";
import {
  parseCommitmentDetail,
  parseDeadlineDetail,
  requireStructuredStatementDetails,
  requireStructuredStatementReferences,
} from "./statement-service.js";
import type {
  CallPlan,
  CallPreparationSnapshotBundle,
  CaseRevision,
  CaseSourceRef,
  CaseStatement,
  CaseStatementKind,
  CommitmentDetail,
  DeadlineDetail,
  PendingCaseUpdate,
} from "./types.js";

const POST_CALL_KINDS = new Set<PendingCaseUpdate["kind"]>([
  "claim",
  "commitment",
  "deadline",
  "reference-number",
  "action",
]);

const POST_CALL_SYSTEM_PROMPT = `You propose post-call updates for MOSS from one bounded, completed CallSession.
Return JSON only:
{"updates":[{"kind":"claim|commitment|deadline|reference-number|action","content":"...","sourceTurnIds":["exact-turn-id"],"dateTime":"optional ISO-8601","commitmentDetail":{"promisorPartyId":"exact-party-id","beneficiaryPartyId":"optional exact-party-id","action":"...","conditions":["..."],"certainty":"explicit|conditional|ambiguous","lifecycle":"pending-confirmation|active|fulfilled|missed|disputed|superseded|cancelled"},"deadlineDetail":{"linkedStatementId":"exact existing commitment-or-action statement id","originalPhrase":"...","precision":"exact|range|relative|unknown","dayKind":"calendar|business|unspecified","timezone":"optional","anchorDate":"optional ISO date","resolvedDate":"optional ISO date"}}]}
Every update must cite one or more exact supplied turn IDs. Commitment updates require commitmentDetail and deadline updates require deadlineDetail. Use only supplied exact party and statement IDs. Preserve the speaker, conditions, uncertainty, dates, time zones, amounts, and reference numbers in content. Do not treat the preparation snapshot as proof that something happened during the call. Do not mutate prior case state, resolve conflicts, or invent IDs. Omit acknowledgements and duplicate statements.`;

interface PendingRow {
  id: string;
  case_id: string;
  call_session_id: string;
  kind: PendingCaseUpdate["kind"];
  proposed_statement_json: string;
  source_turn_ids_json: string;
  review_state: PendingCaseUpdate["reviewState"];
  row_revision: number;
  created_at: number;
  updated_at: number;
}

interface PostCallDraft {
  kind: PendingCaseUpdate["kind"];
  content: string;
  sourceTurnIds: string[];
  dateTime?: string;
  commitmentDetail?: CommitmentDetail;
  deadlineDetail?: DeadlineDetail;
}

export interface LinkedCallSession {
  callSessionId: string;
  caseId: string;
  callPlanId: string;
  callPlanTitle: string;
  snapshotId: string;
  snapshotContentHash: string;
  state: string;
  startedAt?: number;
  closedAt?: number;
}

const cleanJson = (value: string) => value
  .trim()
  .replace(/^```(?:json)?\s*/i, "")
  .replace(/\s*```$/, "")
  .trim();

const cleanStrings = (value: unknown) => Array.isArray(value)
  ? [...new Set(value.filter((item): item is string => typeof item === "string")
      .map((item) => item.trim()).filter(Boolean))]
  : [];

export function parsePostCallProposalResponse(value: string): PostCallDraft[] {
  const parsed = JSON.parse(cleanJson(value)) as { updates?: unknown[] };
  if (!Array.isArray(parsed.updates)) {
    throw new Error("Post-call response is missing updates.");
  }
  return parsed.updates.slice(0, 30).map((item, index) => {
    const record = item && typeof item === "object"
      ? item as Record<string, unknown>
      : {};
    const kind = record.kind as PendingCaseUpdate["kind"];
    if (!POST_CALL_KINDS.has(kind)) {
      throw new Error(`Post-call update ${index + 1} has an unknown kind.`);
    }
    const content = typeof record.content === "string" ? record.content.trim() : "";
    const sourceTurnIds = cleanStrings(record.sourceTurnIds);
    if (!content || !sourceTurnIds.length) {
      throw new Error(`Post-call update ${index + 1} needs content and source turns.`);
    }
    const dateTime = typeof record.dateTime === "string" && record.dateTime.trim()
      ? record.dateTime.trim()
      : undefined;
    if (dateTime && !Number.isFinite(Date.parse(dateTime))) {
      throw new Error(`Post-call update ${index + 1} has an invalid dateTime.`);
    }
    const commitmentDetail = parseCommitmentDetail(record.commitmentDetail, index);
    const deadlineDetail = parseDeadlineDetail(record.deadlineDetail, index);
    requireStructuredStatementDetails({ kind, commitmentDetail, deadlineDetail });
    return { kind, content, sourceTurnIds, dateTime, commitmentDetail, deadlineDetail };
  });
}

const mapPending = (row: PendingRow): PendingCaseUpdate => ({
  id: row.id,
  caseId: row.case_id,
  callSessionId: row.call_session_id,
  kind: row.kind,
  proposedStatement: decodeJson(
    row.proposed_statement_json,
    {} as PendingCaseUpdate["proposedStatement"]
  ),
  sourceTurnIds: decodeJson(row.source_turn_ids_json, []),
  reviewState: row.review_state,
  rowRevision: row.row_revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const boundedTranscript = (turns: CallTranscriptTurn[], maxChars = 18_000) => {
  const selected: CallTranscriptTurn[] = [];
  let chars = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (selected.length && chars + turn.text.length > maxChars) break;
    selected.unshift(turn);
    chars += turn.text.length;
  }
  return selected;
};

export class PostCallReviewService {
  constructor(private readonly database: SqlDatabase) {}

  static async open() {
    return new PostCallReviewService(await loadPreparationDatabase());
  }

  async listLinkedSessions(caseId: string): Promise<LinkedCallSession[]> {
    const rows = await this.database.select<Array<{
      call_session_id: string;
      case_id: string;
      call_plan_id: string;
      call_plan_title: string;
      snapshot_id: string;
      snapshot_content_hash: string;
      state: string;
      started_at: number | null;
      closed_at: number | null;
    }>>(
      `SELECT binding.call_session_id, binding.case_id, binding.call_plan_id,
       plan.title AS call_plan_title, binding.snapshot_id, binding.snapshot_content_hash,
       session.state, session.started_at, session.closed_at
       FROM call_session_preparation_bindings binding
       JOIN call_runtime_sessions session ON session.id = binding.call_session_id
       JOIN call_plans plan ON plan.id = binding.call_plan_id AND plan.case_id = binding.case_id
       WHERE binding.case_id = ? AND binding.mode = 'prepared'
       ORDER BY COALESCE(session.closed_at, session.started_at, binding.bound_at) DESC`,
      [caseId]
    );
    return rows.map((row) => ({
      callSessionId: row.call_session_id,
      caseId: row.case_id,
      callPlanId: row.call_plan_id,
      callPlanTitle: row.call_plan_title,
      snapshotId: row.snapshot_id,
      snapshotContentHash: row.snapshot_content_hash,
      state: row.state,
      startedAt: row.started_at ?? undefined,
      closedAt: row.closed_at ?? undefined,
    }));
  }

  async listPending(caseId: string, callSessionId?: string) {
    const rows = await this.database.select<PendingRow[]>(
      `SELECT * FROM pending_case_updates WHERE case_id = ?
       ${callSessionId ? "AND call_session_id = ?" : ""}
       ORDER BY created_at ASC`,
      callSessionId ? [caseId, callSessionId] : [caseId]
    );
    return rows.map(mapPending);
  }

  async propose(callSessionId: string) {
    const binding = await this.requireClosedPreparedSession(callSessionId);
    const existing = await this.listPending(binding.caseId, callSessionId);
    if (existing.some((item) => item.reviewState === "pending")) return existing;
    const turns = await this.loadTranscript(callSessionId);
    if (!turns.length) throw new Error("The CallSession has no persisted transcript turns.");
    const snapshotRows = await this.database.select<Array<{ bundle_json: string; content_hash: string }>>(
      "SELECT bundle_json, content_hash FROM call_preparation_snapshots WHERE id = ? AND case_id = ?",
      [binding.snapshotId, binding.caseId]
    );
    if (!snapshotRows[0] || snapshotRows[0].content_hash !== binding.snapshotContentHash) {
      throw new Error("The bound preparation snapshot is unavailable or changed.");
    }
    const snapshot = decodeJson<CallPreparationSnapshotBundle>(
      snapshotRows[0].bundle_json,
      {} as CallPreparationSnapshotBundle
    );
    const context = {
      callSessionId,
      transcript: boundedTranscript(turns),
      preparation: {
        callBrief: snapshot.callBrief,
        caseSnapshot: snapshot.caseSnapshot,
        evidenceIndex: snapshot.evidenceIndex,
        safetyConstraints: snapshot.safetyConstraints,
      },
      structuredReferences: await this.loadStructuredReferenceOptions(binding.caseId),
    };
    const route = loadModelRouteSettings().chat.complex;
    const provider = getChatProvider(route.provider);
    const apiKey = provider.requiresApiKey ? await loadProviderSecret("complex") : "";
    if (provider.requiresApiKey && !apiKey) {
      throw new Error("Configure the Complex Task model before post-call review.");
    }
    const operationId = `post_call_${crypto.randomUUID()}`;
    await this.recordOperation(binding.caseId, binding.callPlanId, operationId, "post-call-proposal", "dispatched", {
      callSessionId,
      contextHash: await sha256(canonicalize(context)),
      transcriptTurnCount: context.transcript.length,
      provider: route.provider,
      model: route.model,
    });
    await this.recordArtifactStage(binding, operationId, "selected");
    await this.recordArtifactStage(binding, operationId, "dispatched");
    try {
      const raw = await requestChatCompletion({
        route,
        apiKey,
        messages: [
          { role: "system", content: POST_CALL_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(context) },
        ],
      });
      await this.recordArtifactStage(binding, operationId, "provider-returned");
      const drafts = parsePostCallProposalResponse(raw);
      const turnById = new Map(turns.map((turn) => [turn.id, turn]));
      const now = Date.now();
      const proposals: PendingCaseUpdate[] = [];
      await withTransaction(this.database, async (transaction) => {
        for (const draft of drafts) {
          const sourceTurns = draft.sourceTurnIds.map((turnId) => {
            const turn = turnById.get(turnId);
            if (!turn) throw new Error("The model cited a turn outside this CallSession.");
            return turn;
          });
          const sourceRefs: CaseSourceRef[] = [];
          for (const turn of sourceTurns) {
            sourceRefs.push({
              id: `call_source_${crypto.randomUUID()}`,
              sourceKind: "call-turn",
              sourceId: turn.id,
              contentHash: await sha256(turn.text),
              quotedText: turn.text.slice(0, 700),
            });
          }
          const proposedStatement: PendingCaseUpdate["proposedStatement"] = {
            caseId: binding.caseId,
            kind: draft.kind as CaseStatementKind,
            content: draft.content,
            sourceRefs,
            claimState: "asserted",
            sourceStatus: "current",
            sourceStaleReasons: [],
            validUntil: draft.dateTime ? Date.parse(draft.dateTime) : undefined,
            allowedUses: ["call-preparation", "advisor-grounding"],
            commitmentDetail: draft.commitmentDetail,
            deadlineDetail: draft.deadlineDetail,
            createdBy: "complex-model-proposal",
          };
          const proposal: PendingCaseUpdate = {
            id: `pending_case_update_${crypto.randomUUID()}`,
            caseId: binding.caseId,
            callSessionId,
            kind: draft.kind,
            proposedStatement,
            sourceTurnIds: draft.sourceTurnIds,
            reviewState: "pending",
            rowRevision: 1,
            createdAt: now,
            updatedAt: now,
          };
          await transaction.execute(
            `INSERT INTO pending_case_updates (
              id, case_id, call_session_id, kind, proposed_statement_json,
              source_turn_ids_json, review_state, row_revision, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)`,
            [proposal.id, proposal.caseId, proposal.callSessionId, proposal.kind, encodeJson(proposedStatement), encodeJson(proposal.sourceTurnIds), now, now]
          );
          proposals.push(proposal);
        }
      });
      await this.recordArtifactStage(binding, operationId, "commit-authorized");
      await this.recordArtifactStage(binding, operationId, "visible");
      await this.recordOperation(binding.caseId, binding.callPlanId, operationId, "post-call-proposal", "committed", {
        callSessionId,
        proposalIds: proposals.map((item) => item.id),
      });
      return proposals;
    } catch (error) {
      await this.recordArtifactStage(binding, operationId, "failed", error instanceof Error ? error.message : String(error));
      await this.recordOperation(binding.caseId, binding.callPlanId, operationId, "post-call-proposal", "failed", {
        callSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async review(input: {
    updateId: string;
    expectedRevision: number;
    action: "accept" | "edit" | "reject";
    editedContent?: string;
  }) {
    const rows = await this.database.select<PendingRow[]>(
      "SELECT * FROM pending_case_updates WHERE id = ?",
      [input.updateId]
    );
    if (!rows[0]) throw new Error("Pending Case Update was not found.");
    const pending = mapPending(rows[0]);
    if (pending.rowRevision !== input.expectedRevision) {
      throw new Error("Pending Case Update revision conflict.");
    }
    if (pending.reviewState !== "pending") {
      throw new Error("Only a pending Case Update can be reviewed.");
    }
    if (input.action === "reject") {
      await this.updateReviewState(pending, "rejected");
      return;
    }
    const content = input.action === "edit"
      ? input.editedContent?.trim() ?? ""
      : pending.proposedStatement.content.trim();
    if (!content) throw new Error("Reviewed update content is required.");
    const sourceTurns = await this.loadTranscript(pending.callSessionId);
    const sourceById = new Map(sourceTurns.map((turn) => [turn.id, turn]));
    if (!pending.sourceTurnIds.length || pending.sourceTurnIds.some((id) => !sourceById.has(id))) {
      throw new Error("Pending Case Update lost its exact CallSession source turns.");
    }
    for (const source of pending.proposedStatement.sourceRefs) {
      const turn = sourceById.get(source.sourceId);
      if (!turn || await sha256(turn.text) !== source.contentHash) {
        throw new Error("A CallSession source turn changed before review commit.");
      }
    }
    const now = Date.now();
    const statement: CaseStatement = {
      ...pending.proposedStatement,
      id: `statement_${crypto.randomUUID()}`,
      revision: 1,
      content,
      reviewState: "confirmed",
      createdAt: now,
      updatedAt: now,
    };
    requireStructuredStatementDetails(statement);
    await requireStructuredStatementReferences(this.database, statement);
    await withTransaction(this.database, async (transaction) => {
      const current = await this.currentRevision(pending.caseId, transaction);
      await transaction.execute(
        `INSERT INTO case_statements (
          id, case_id, revision, kind, content, subject_party_id, speaker_party_id,
          review_state, claim_state, jurisdiction, valid_from, valid_until,
          allowed_uses_json, allowed_wording, supersedes_id, created_by, created_at,
          updated_at, source_status, source_stale_reasons_json,
          commitment_detail_json, deadline_detail_json
        ) VALUES (?, ?, 1, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          statement.id, statement.caseId, statement.kind, statement.content,
          statement.subjectPartyId ?? null, statement.speakerPartyId ?? null,
          statement.claimState, statement.jurisdiction ?? null,
          statement.validFrom ?? null, statement.validUntil ?? null,
          encodeJson(statement.allowedUses), statement.allowedWording ?? null,
          statement.supersedesId ?? null, statement.createdBy, now, now,
          statement.sourceStatus, encodeJson(statement.sourceStaleReasons),
          statement.commitmentDetail ? encodeJson(statement.commitmentDetail) : null,
          statement.deadlineDetail ? encodeJson(statement.deadlineDetail) : null,
        ]
      );
      for (const source of statement.sourceRefs) {
        await transaction.execute(
          `INSERT INTO case_statement_sources (
            id, statement_id, source_kind, source_id, source_revision,
            content_hash, page_number, quoted_text, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [source.id, statement.id, source.sourceKind, source.sourceId, source.sourceRevision ?? null, source.contentHash, source.pageNumber ?? null, source.quotedText ?? null, now]
        );
      }
      await transaction.execute(
        `INSERT INTO case_statement_events (
          id, case_id, statement_id, event_type, to_statement_id, to_state,
          statement_revision, payload_json, occurred_at
        ) VALUES (?, ?, ?, 'created', ?, 'confirmed', 1, '{}', ?)`,
        [
          `statement_event_${crypto.randomUUID()}`,
          statement.caseId,
          statement.id,
          statement.id,
          now,
        ]
      );
      const statementIds = [...current.statementIds, statement.id];
      const nextActionIds = statement.kind === "action"
        ? [...current.nextActionIds, statement.id]
        : current.nextActionIds;
      const revision: CaseRevision = {
        id: `case_revision_${crypto.randomUUID()}`,
        caseId: pending.caseId,
        revision: current.revision + 1,
        parentRevisionId: current.id,
        primaryObjective: current.primaryObjective,
        acceptableFallbacks: current.acceptableFallbacks,
        partyIds: current.partyIds,
        statementIds,
        nextActionIds,
        sourceCommandId: `post_call_review_${crypto.randomUUID()}`,
        createdAt: now,
      };
      await this.insertRevision(revision, transaction);
      const changedCase = await transaction.execute(
        `UPDATE cases SET current_revision_id = ?, row_revision = row_revision + 1, updated_at = ?
         WHERE id = ? AND current_revision_id = ?`,
        [revision.id, now, pending.caseId, current.id]
      );
      if (changedCase.rowsAffected !== 1) throw new Error("CaseRevision commit conflict.");
      const changedPending = await transaction.execute(
        `UPDATE pending_case_updates SET proposed_statement_json = ?, review_state = ?,
         row_revision = row_revision + 1, updated_at = ?
         WHERE id = ? AND row_revision = ? AND review_state = 'pending'`,
        [
          encodeJson({ ...pending.proposedStatement, content }),
          input.action === "edit" ? "edited" : "accepted",
          now,
          pending.id,
          pending.rowRevision,
        ]
      );
      if (changedPending.rowsAffected !== 1) throw new Error("Pending Case Update revision conflict.");
    });
    await this.recordOperation(pending.caseId, undefined, `post_call_review_${crypto.randomUUID()}`, "post-call-review", input.action, {
      updateId: pending.id,
      statementId: statement.id,
      callSessionId: pending.callSessionId,
    });
    if (input.action === "accept") {
      await this.database.execute(
        `INSERT INTO preparation_human_evaluations (
          id, case_id, call_session_id, snapshot_id, subject_kind,
          subject_id, label, note, source, occurred_at
        ) VALUES (?, ?, ?, NULL, 'post-call-update', ?, 'correct', NULL, 'derived', ?)`,
        [
          `preparation_evaluation_${crypto.randomUUID()}`,
          pending.caseId,
          pending.callSessionId,
          pending.id,
          Date.now(),
        ]
      );
    }
  }

  async createFollowUpPlan(callSessionId: string): Promise<CallPlan> {
    const binding = await this.requirePreparedSession(callSessionId);
    const updates = (await this.listPending(binding.caseId, callSessionId))
      .filter((item) => ["accepted", "edited"].includes(item.reviewState));
    if (!updates.length) {
      throw new Error("Review at least one post-call update before creating a follow-up plan.");
    }
    const now = Date.now();
    const sourcePlanRows = await this.database.select<Array<{ title: string; objective: string }>>(
      "SELECT title, objective FROM call_plans WHERE id = ? AND case_id = ?",
      [binding.callPlanId, binding.caseId]
    );
    if (!sourcePlanRows[0]) throw new Error("The source CallPlan was not found.");
    const plan: CallPlan = {
      id: `call_plan_${crypto.randomUUID()}`,
      caseId: binding.caseId,
      title: `Follow-up: ${sourcePlanRows[0].title} · ${callSessionId.slice(-8)}`,
      state: "draft",
      objective: `Follow up on ${updates.map((item) => item.proposedStatement.content).join("; ")}`,
      counterpartyIds: [],
      acceptableOutcomes: [],
      questionsToAsk: updates.map((item) => `Confirm: ${item.proposedStatement.content}`),
      knownRisks: [],
      rowRevision: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.database.execute(
      `INSERT INTO call_plans (
        id, case_id, title, state, objective, counterparty_ids_json,
        acceptable_outcomes_json, questions_to_ask_json, known_risks_json,
        scheduled_at, row_revision, created_at, updated_at
      ) VALUES (?, ?, ?, 'draft', ?, '[]', '[]', ?, '[]', NULL, 1, ?, ?)`,
      [plan.id, plan.caseId, plan.title, plan.objective, encodeJson(plan.questionsToAsk), now, now]
    );
    await this.recordOperation(binding.caseId, binding.callPlanId, `follow_up_plan_${crypto.randomUUID()}`, "follow-up-plan", "committed", {
      callSessionId,
      callPlanId: plan.id,
      sourceUpdateIds: updates.map((item) => item.id),
    });
    return plan;
  }

  private async updateReviewState(pending: PendingCaseUpdate, state: "rejected") {
    const changed = await this.database.execute(
      `UPDATE pending_case_updates SET review_state = ?, row_revision = row_revision + 1,
       updated_at = ? WHERE id = ? AND row_revision = ? AND review_state = 'pending'`,
      [state, Date.now(), pending.id, pending.rowRevision]
    );
    if (changed.rowsAffected !== 1) throw new Error("Pending Case Update revision conflict.");
    await this.recordOperation(pending.caseId, undefined, `post_call_review_${crypto.randomUUID()}`, "post-call-review", state, {
      updateId: pending.id,
      callSessionId: pending.callSessionId,
    });
  }

  private async loadStructuredReferenceOptions(caseId: string) {
    const [parties, statements] = await Promise.all([
      this.database.select<Array<{
        id: string;
        display_name: string;
        role: string;
      }>>(
        `SELECT id, display_name, role FROM case_parties
         WHERE case_id = ? AND review_state = 'confirmed' ORDER BY created_at`,
        [caseId]
      ),
      this.database.select<Array<{
        id: string;
        kind: CaseStatementKind;
        content: string;
      }>>(
        `SELECT id, kind, content FROM case_statements
         WHERE case_id = ? AND review_state = 'confirmed'
         AND source_status = 'current' AND kind IN ('commitment', 'action')
         ORDER BY created_at`,
        [caseId]
      ),
    ]);
    return {
      parties: parties.map((party) => ({
        partyId: party.id,
        displayName: party.display_name,
        role: party.role,
      })),
      linkableStatements: statements.map((statement) => ({
        statementId: statement.id,
        kind: statement.kind,
        content: statement.content,
      })),
    };
  }

  private async currentRevision(
    caseId: string,
    database: SqlDatabase = this.database
  ): Promise<CaseRevision> {
    const rows = await database.select<Array<{
      id: string;
      case_id: string;
      revision: number;
      parent_revision_id: string | null;
      primary_objective: string;
      acceptable_fallbacks_json: string;
      party_ids_json: string;
      statement_ids_json: string;
      next_action_ids_json: string;
      source_command_id: string;
      created_at: number;
    }>>(
      `SELECT revision.* FROM case_revisions revision
       JOIN cases item ON item.current_revision_id = revision.id
       WHERE item.id = ? AND revision.case_id = item.id`,
      [caseId]
    );
    const row = rows[0];
    if (!row) throw new Error("Current CaseRevision was not found.");
    return {
      id: row.id,
      caseId: row.case_id,
      revision: row.revision,
      parentRevisionId: row.parent_revision_id ?? undefined,
      primaryObjective: row.primary_objective,
      acceptableFallbacks: decodeJson(row.acceptable_fallbacks_json, []),
      partyIds: decodeJson(row.party_ids_json, []),
      statementIds: decodeJson(row.statement_ids_json, []),
      nextActionIds: decodeJson(row.next_action_ids_json, []),
      sourceCommandId: row.source_command_id,
      createdAt: row.created_at,
    };
  }

  private async insertRevision(revision: CaseRevision, database: SqlDatabase = this.database) {
    await database.execute(
      `INSERT INTO case_revisions (
        id, case_id, revision, parent_revision_id, primary_objective,
        acceptable_fallbacks_json, party_ids_json, statement_ids_json,
        next_action_ids_json, source_command_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [revision.id, revision.caseId, revision.revision, revision.parentRevisionId ?? null, revision.primaryObjective, encodeJson(revision.acceptableFallbacks), encodeJson(revision.partyIds), encodeJson(revision.statementIds), encodeJson(revision.nextActionIds), revision.sourceCommandId, revision.createdAt]
    );
  }

  private async loadTranscript(callSessionId: string) {
    const rows = await this.database.select<Array<{ payload_json: string }>>(
      `SELECT payload_json FROM call_runtime_events
       WHERE call_session_id = ? AND event_kind = 'runtime-command'
       ORDER BY sequence ASC`,
      [callSessionId]
    );
    const turns: CallTranscriptTurn[] = [];
    for (const row of rows) {
      const payload = decodeJson<{ command?: { type?: string; turn?: CallTranscriptTurn } }>(row.payload_json, {});
      if (payload.command?.type === "SubmitTranscriptTurn" && payload.command.turn) {
        turns.push(payload.command.turn);
      }
    }
    return turns;
  }

  private async requirePreparedSession(callSessionId: string) {
    const rows = await this.database.select<Array<{
      case_id: string;
      case_revision_id: string;
      call_plan_id: string;
      snapshot_id: string;
      snapshot_content_hash: string;
      mode: string;
      state: string;
    }>>(
      `SELECT binding.*, session.state FROM call_session_preparation_bindings binding
       JOIN call_runtime_sessions session ON session.id = binding.call_session_id
       WHERE binding.call_session_id = ?`,
      [callSessionId]
    );
    const row = rows[0];
    if (!row || row.mode !== "prepared" || !row.case_id || !row.call_plan_id || !row.snapshot_id) {
      throw new Error("Post-call review requires a prepared CallSession.");
    }
    return {
      callSessionId,
      caseId: row.case_id,
      caseRevisionId: row.case_revision_id,
      callPlanId: row.call_plan_id,
      snapshotId: row.snapshot_id,
      snapshotContentHash: row.snapshot_content_hash,
      state: row.state,
    };
  }

  private async requireClosedPreparedSession(callSessionId: string) {
    const binding = await this.requirePreparedSession(callSessionId);
    if (binding.state !== "closed") {
      throw new Error("Post-call proposals require a successfully closed CallSession.");
    }
    return binding;
  }

  private async recordArtifactStage(
    binding: Awaited<ReturnType<PostCallReviewService["requirePreparedSession"]>>,
    operationId: string,
    status: "selected" | "dispatched" | "provider-returned" | "commit-authorized" | "visible" | "failed",
    reason?: string
  ) {
    const artifacts = await this.database.select<Array<{ id: string }>>(
      `SELECT id FROM snapshot_artifacts WHERE snapshot_id = ?
       AND section IN ('caseSnapshot', 'callBrief', 'evidenceIndex', 'safetyConstraints')`,
      [binding.snapshotId]
    );
    const occurredAt = Date.now();
    for (const artifact of artifacts) {
      await this.database.execute(
        `INSERT INTO snapshot_artifact_receipts (
          id, call_session_id, snapshot_id, artifact_id, operation_id,
          target, status, reason, occurred_at
        ) VALUES (?, ?, ?, ?, ?, 'post-call', ?, ?, ?)`,
        [`snapshot_receipt_${crypto.randomUUID()}`, binding.callSessionId, binding.snapshotId, artifact.id, operationId, status, reason ?? null, occurredAt]
      );
    }
  }

  private async recordOperation(
    caseId: string,
    callPlanId: string | undefined,
    operationId: string,
    kind: string,
    status: string,
    payload: unknown
  ) {
    await this.database.execute(
      `INSERT INTO preparation_operation_events (
        id, case_id, call_plan_id, operation_id, operation_kind, status, payload_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [`preparation_event_${crypto.randomUUID()}`, caseId, callPlanId ?? null, operationId, kind, status, encodeJson(payload), Date.now()]
    );
  }
}
