import type {
  PreparationContextSourceRef,
  PreparationConversation,
  PreparationConversationRepository,
  PreparationConversationScope,
  PreparationMessage,
  PreparationMessageContextSnapshot,
} from "@/lib/preparation/conversation-types";
import { getDatabase } from "./config";

interface PreparationConversationRow {
  id: string;
  process_id: string;
  scope_kind: "process" | "round";
  round_id: string | null;
  title: string;
  title_source: "placeholder" | "automatic" | "manual";
  status: "active" | "archived";
  revision: number;
  active_operation_id: string | null;
  head_message_id: string | null;
  rolling_summary: string | null;
  summary_revision: number;
  summary_through_message_id: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

interface PreparationMessageRow {
  id: string;
  conversation_id: string;
  logical_turn_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  material_refs_json: string;
  source_refs_json: string;
  model_execution_ref: string | null;
  context_snapshot_json: string | null;
  request_metadata_json: string;
  operation_id: string | null;
  parent_message_id: string | null;
  supersedes_message_id: string | null;
  created_at: number;
  committed_at: number | null;
}

const CONVERSATION_SELECT = `
  SELECT id, process_id, scope_kind, round_id, title, title_source, status, revision,
         active_operation_id, head_message_id, rolling_summary, summary_revision,
         summary_through_message_id, created_at, updated_at, archived_at
  FROM preparation_conversations`;

export const preparationConversationRepository: PreparationConversationRepository = {
  async getById(conversationId) {
    const db = await getDatabase();
    const rows = await db.select<PreparationConversationRow[]>(
      `${CONVERSATION_SELECT}
       WHERE id = ?
       LIMIT 1`,
      [conversationId]
    );
    return rows[0] ? mapConversation(rows[0]) : undefined;
  },

  async listForProcess(processId) {
    const db = await getDatabase();
    const rows = await db.select<PreparationConversationRow[]>(
      `${CONVERSATION_SELECT}
       WHERE process_id = ?
       ORDER BY updated_at DESC, id DESC`,
      [processId]
    );
    return rows.map(mapConversation);
  },

  async insert(conversation) {
    const db = await getDatabase();
    await db.execute(
      `INSERT INTO preparation_conversations
        (id, process_id, scope_kind, scope_key, round_id, title, title_source,
         status, revision, active_operation_id, head_message_id, rolling_summary,
         summary_revision, summary_through_message_id, created_at, updated_at,
         archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        conversation.id,
        conversation.processId,
        conversation.scope.kind,
        scopeKey(conversation.scope),
        conversation.scope.kind === "round" ? conversation.scope.roundId : null,
        conversation.title,
        conversation.titleSource,
        conversation.status,
        conversation.revision,
        conversation.activeOperationId ?? null,
        conversation.headMessageId ?? null,
        conversation.rollingSummary ?? null,
        conversation.summaryRevision,
        conversation.summaryThroughMessageId ?? null,
        conversation.createdAt,
        conversation.updatedAt,
        conversation.archivedAt ?? null,
      ]
    );
  },

  async updateMetadata(input) {
    const db = await getDatabase();
    const updated = await db.execute(
      `UPDATE preparation_conversations
       SET title = ?, title_source = ?, scope_kind = ?, scope_key = ?, round_id = ?,
           revision = revision + 1, updated_at = ?
       WHERE id = ? AND process_id = ? AND status = 'active'
         AND active_operation_id IS NULL`,
      [
        input.title,
        input.titleSource,
        input.scope.kind,
        scopeKey(input.scope),
        input.scope.kind === "round" ? input.scope.roundId : null,
        input.updatedAt,
        input.conversationId,
        input.processId,
      ]
    );
    return updated.rowsAffected > 0;
  },

  async deleteConversation(processId, conversationId) {
    const db = await getDatabase();
    const deleted = await db.execute(
      `DELETE FROM preparation_conversations
       WHERE id = ? AND process_id = ? AND active_operation_id IS NULL`,
      [conversationId, processId]
    );
    return deleted.rowsAffected > 0;
  },

  async listMessages(conversationId) {
    const db = await getDatabase();
    const rows = await db.select<PreparationMessageRow[]>(
      `WITH RECURSIVE current_branch(id, parent_message_id) AS (
         SELECT message.id, message.parent_message_id
         FROM preparation_messages message
         JOIN preparation_conversations conversation
           ON conversation.head_message_id = message.id
         WHERE conversation.id = ? AND message.status = 'committed'
         UNION ALL
         SELECT parent.id, parent.parent_message_id
         FROM preparation_messages parent
         JOIN current_branch child ON child.parent_message_id = parent.id
         WHERE parent.conversation_id = ? AND parent.status = 'committed'
       )
       SELECT message.id, message.conversation_id, message.logical_turn_id,
              message.role, message.content, message.material_refs_json,
              message.source_refs_json, message.model_execution_ref,
              message.context_snapshot_json, message.request_metadata_json,
              message.operation_id, message.parent_message_id,
              message.supersedes_message_id, message.created_at,
              message.committed_at
       FROM current_branch branch
       JOIN preparation_messages message ON message.id = branch.id
       ORDER BY message.created_at ASC, message.id ASC`,
      [conversationId, conversationId]
    );
    return rows.map(mapMessage);
  },

  async beginRequest(input) {
    const db = await getDatabase();
    await insertMessage(db, input.userMessage, "pending");
    const claimed = await db.execute(
      `UPDATE preparation_conversations
       SET revision = revision + 1,
           active_operation_id = ?,
           head_message_id = ?,
           title = CASE
             WHEN ? IS NOT NULL AND title_source <> 'manual' THEN ?
             ELSE title
           END,
           title_source = CASE
             WHEN ? IS NOT NULL AND title_source <> 'manual' THEN 'automatic'
             ELSE title_source
           END,
           rolling_summary = CASE WHEN ? THEN NULL ELSE rolling_summary END,
           summary_revision = summary_revision + CASE WHEN ? THEN 1 ELSE 0 END,
           summary_through_message_id = CASE
             WHEN ? THEN NULL ELSE summary_through_message_id
           END,
           updated_at = ?
       WHERE id = ? AND status = 'active' AND revision = ?`,
      [
        input.operationId,
        input.userMessage.id,
        input.autoTitle ?? null,
        input.autoTitle ?? null,
        input.autoTitle ?? null,
        input.resetSummary ? 1 : 0,
        input.resetSummary ? 1 : 0,
        input.resetSummary ? 1 : 0,
        input.updatedAt,
        input.conversationId,
        input.expectedRevision,
      ]
    );
    if (claimed.rowsAffected === 0) {
      await db.execute(
        `DELETE FROM preparation_messages WHERE id = ? AND status = 'pending'`,
        [input.userMessage.id]
      );
      return false;
    }

    const committed = await db.execute(
      `UPDATE preparation_messages
       SET status = 'committed', committed_at = ?
       WHERE id = ? AND conversation_id = ? AND status = 'pending'
         AND operation_id = ?`,
      [
        input.updatedAt,
        input.userMessage.id,
        input.conversationId,
        input.operationId,
      ]
    );
    if (committed.rowsAffected === 0) {
      throw new Error("Preparation user message could not be committed.");
    }
    return true;
  },

  async commitAssistant(input) {
    const db = await getDatabase();
    await insertMessage(db, input.assistantMessage, "pending");

    const committed = await db.execute(
      `UPDATE preparation_conversations
       SET revision = revision + 1,
           active_operation_id = NULL,
           head_message_id = ?,
           updated_at = ?
       WHERE id = ? AND status = 'active'
         AND active_operation_id = ? AND revision = ?`,
      [
        input.assistantMessage.id,
        input.updatedAt,
        input.conversationId,
        input.operationId,
        input.expectedRevision,
      ]
    );
    if (committed.rowsAffected === 0) {
      await db.execute(
        `DELETE FROM preparation_messages
         WHERE id = ? AND status = 'pending'`,
        [input.assistantMessage.id]
      );
      return false;
    }

    const messageCommitted = await db.execute(
      `UPDATE preparation_messages
       SET status = 'committed', committed_at = ?
       WHERE id = ? AND conversation_id = ? AND status = 'pending'
         AND operation_id = ?`,
      [
        input.updatedAt,
        input.assistantMessage.id,
        input.conversationId,
        input.operationId,
      ]
    );
    if (messageCommitted.rowsAffected === 0) {
      throw new Error("Preparation assistant message could not be committed.");
    }
    return true;
  },

  async cancelRequest(input) {
    const db = await getDatabase();
    const cancelled = await db.execute(
      `UPDATE preparation_conversations
       SET revision = revision + 1,
           active_operation_id = NULL,
           updated_at = ?
       WHERE id = ? AND active_operation_id = ? AND revision = ?`,
      [
        input.updatedAt,
        input.conversationId,
        input.operationId,
        input.expectedRevision,
      ]
    );
    await db.execute(
      `DELETE FROM preparation_messages
       WHERE conversation_id = ? AND operation_id = ? AND status = 'pending'`,
      [input.conversationId, input.operationId]
    );
    return cancelled.rowsAffected > 0;
  },

  async updateSummary(input) {
    const db = await getDatabase();
    const updated = await db.execute(
      `UPDATE preparation_conversations
       SET rolling_summary = ?,
           summary_revision = ?,
           summary_through_message_id = ?,
           updated_at = ?
       WHERE id = ? AND active_operation_id = ? AND revision = ?`,
      [
        input.rollingSummary ?? null,
        input.summaryRevision,
        input.summaryThroughMessageId ?? null,
        input.updatedAt,
        input.conversationId,
        input.operationId,
        input.expectedRevision,
      ]
    );
    return updated.rowsAffected > 0;
  },

  async countForRound(processId, roundId) {
    const db = await getDatabase();
    const rows = await db.select<Array<{ count: number }>>(
      `SELECT COUNT(*) AS count
       FROM preparation_conversations
       WHERE process_id = ? AND scope_kind = 'round' AND round_id = ?`,
      [processId, roundId]
    );
    return Number(rows[0]?.count ?? 0);
  },
};

async function insertMessage(
  db: Awaited<ReturnType<typeof getDatabase>>,
  message: PreparationMessage,
  status: "pending" | "committed"
) {
  await db.execute(
    `INSERT INTO preparation_messages
      (id, conversation_id, logical_turn_id, role, status, content,
       material_refs_json, source_refs_json, model_execution_ref,
       context_snapshot_json, request_metadata_json, operation_id,
       parent_message_id, supersedes_message_id, created_at, committed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      message.id,
      message.conversationId,
      message.logicalTurnId,
      message.role,
      status,
      message.content,
      JSON.stringify(message.materialRefs),
      JSON.stringify(message.sourceRefs),
      message.modelExecutionRef ?? null,
      message.contextSnapshot ? JSON.stringify(message.contextSnapshot) : null,
      JSON.stringify(message.requestMetadata ?? {}),
      message.operationId ?? null,
      message.parentMessageId ?? null,
      message.supersedesMessageId ?? null,
      message.createdAt,
      status === "committed" ? (message.committedAt ?? message.createdAt) : null,
    ]
  );
}

function scopeKey(scope: PreparationConversationScope) {
  return scope.kind === "process" ? "process" : scope.roundId;
}

function mapConversation(row: PreparationConversationRow): PreparationConversation {
  return {
    id: row.id,
    processId: row.process_id,
    scope:
      row.scope_kind === "round" && row.round_id
        ? { kind: "round", roundId: row.round_id }
        : { kind: "process" },
    title: row.title,
    titleSource: row.title_source,
    status: row.status,
    revision: row.revision,
    activeOperationId: row.active_operation_id ?? undefined,
    headMessageId: row.head_message_id ?? undefined,
    rollingSummary: row.rolling_summary ?? undefined,
    summaryRevision: row.summary_revision,
    summaryThroughMessageId: row.summary_through_message_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? undefined,
  };
}

function mapMessage(row: PreparationMessageRow): PreparationMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    logicalTurnId: row.logical_turn_id,
    role: row.role,
    content: row.content,
    materialRefs: parseStringArray(row.material_refs_json),
    sourceRefs: parseJson<PreparationContextSourceRef[]>(
      row.source_refs_json,
      []
    ),
    modelExecutionRef: row.model_execution_ref ?? undefined,
    contextSnapshot: parseJson<PreparationMessageContextSnapshot | undefined>(
      row.context_snapshot_json,
      undefined
    ),
    requestMetadata: parseJson<PreparationMessage["requestMetadata"]>(
      row.request_metadata_json,
      undefined
    ),
    operationId: row.operation_id ?? undefined,
    parentMessageId: row.parent_message_id ?? undefined,
    supersedesMessageId: row.supersedes_message_id ?? undefined,
    createdAt: row.created_at,
    committedAt: row.committed_at ?? undefined,
  };
}

function parseStringArray(value: string) {
  const parsed = parseJson<unknown>(value, []);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
