import {
  getChatProvider,
  loadModelRouteSettings,
  loadProviderSecret,
  requestChatCompletionStream,
  sha256,
} from "../calling/index.js";
import {
  decodeJson,
  encodeJson,
  loadPreparationDatabase,
  type SqlDatabase,
  withTransaction,
} from "./database.js";
import {
  composePreparationContext,
  type PreparationModelContext,
} from "./preparation-context.js";
import type {
  PreparationConversation,
  PreparationMessage,
} from "./types.js";

const PREPARATION_SYSTEM_PROMPT = `You are the MOSS Case Preparation model.
Help the user understand one explicitly scoped case and prepare one planned call.
Keep these evidence roles separate: CONFIRMED STATE, SOURCE MATERIAL, COUNTERPARTY CLAIM, MODEL INFERENCE, and UNKNOWN.
Use [MATERIAL:chunkId] or [STATEMENT:id] citations for sourced claims.
Never treat a prior assistant response or rolling summary as evidence.
Do not change case state, confirm facts, create commitments, or claim that a proposal is authoritative.
When evidence is missing, identify the gap and propose a concrete next step.
Write a concise, useful response in plain text.`;

interface ConversationRow {
  id: string;
  case_id: string;
  call_plan_id: string | null;
  title: string;
  status: "active" | "archived";
  head_revision: number;
  generated_summary: string | null;
  generated_summary_hash: string | null;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  revision: number;
  parent_message_id: string | null;
  role: "user" | "assistant";
  content: string;
  material_refs_json: string;
  proposed_artifact_refs_json: string;
  context_manifest_json: string | null;
  status: "committed" | "superseded";
  operation_id: string | null;
  created_at: number;
}

const mapConversation = (row: ConversationRow): PreparationConversation => ({
  id: row.id,
  caseId: row.case_id,
  callPlanId: row.call_plan_id ?? undefined,
  title: row.title,
  status: row.status,
  headRevision: row.head_revision,
  generatedSummary: row.generated_summary ?? undefined,
  generatedSummaryHash: row.generated_summary_hash ?? undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapMessage = (row: MessageRow): PreparationMessage => ({
  id: row.id,
  conversationId: row.conversation_id,
  revision: row.revision,
  parentMessageId: row.parent_message_id ?? undefined,
  role: row.role,
  content: row.content,
  materialRefs: decodeJson(row.material_refs_json, []),
  proposedArtifactRefs: decodeJson(row.proposed_artifact_refs_json, []),
  contextManifest: row.context_manifest_json
    ? decodeJson(row.context_manifest_json, undefined)
    : undefined,
  status: row.status,
  operationId: row.operation_id ?? undefined,
  createdAt: row.created_at,
});

const conversationTitle = (content: string) => {
  const words = content.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 10).join(" ") + (words.length > 10 ? "..." : "");
};

const activeOperations = new Map<string, AbortController>();

export class PreparationConversationService {
  constructor(private readonly database: SqlDatabase) {}

  static async open() {
    return new PreparationConversationService(await loadPreparationDatabase());
  }

  async list(caseId: string) {
    const rows = await this.database.select<ConversationRow[]>(
      "SELECT * FROM preparation_conversations WHERE case_id = ? ORDER BY updated_at DESC",
      [caseId]
    );
    return rows.map(mapConversation);
  }

  async create(input: { caseId: string; callPlanId?: string; title?: string }) {
    if (input.callPlanId) {
      const scoped = await this.database.select<Array<{ id: string }>>(
        "SELECT id FROM call_plans WHERE id = ? AND case_id = ?",
        [input.callPlanId, input.caseId]
      );
      if (!scoped[0]) throw new Error("Call plan belongs to a different case.");
    }
    const now = Date.now();
    const conversation: PreparationConversation = {
      id: `conversation_${crypto.randomUUID()}`,
      caseId: input.caseId,
      callPlanId: input.callPlanId,
      title: input.title?.trim() || "New preparation conversation",
      status: "active",
      headRevision: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.database.execute(
      `INSERT INTO preparation_conversations (
        id, case_id, call_plan_id, title, status, head_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', 0, ?, ?)`,
      [conversation.id, conversation.caseId, conversation.callPlanId ?? null, conversation.title, now, now]
    );
    return conversation;
  }

  async updateMetadata(input: {
    conversation: PreparationConversation;
    title: string;
    callPlanId?: string;
  }) {
    if (input.callPlanId) {
      const scoped = await this.database.select<Array<{ id: string }>>(
        "SELECT id FROM call_plans WHERE id = ? AND case_id = ?",
        [input.callPlanId, input.conversation.caseId]
      );
      if (!scoped[0]) throw new Error("Call plan belongs to a different case.");
    }
    const result = await this.database.execute(
      `UPDATE preparation_conversations SET title = ?, call_plan_id = ?, updated_at = ?
       WHERE id = ? AND case_id = ? AND head_revision = ?`,
      [
        input.title.trim() || "Preparation conversation",
        input.callPlanId ?? null,
        Date.now(),
        input.conversation.id,
        input.conversation.caseId,
        input.conversation.headRevision,
      ]
    );
    if (result.rowsAffected !== 1) throw new Error("Conversation revision conflict.");
  }

  async messages(conversationId: string, includeSuperseded = false) {
    const rows = await this.database.select<MessageRow[]>(
      `SELECT * FROM preparation_messages WHERE conversation_id = ?
       ${includeSuperseded ? "" : "AND status = 'committed'"}
       ORDER BY revision ASC`,
      [conversationId]
    );
    return rows.map(mapMessage);
  }

  cancel(conversationId: string, reason = "cancelled-by-user") {
    const controller = activeOperations.get(conversationId);
    if (!controller) return false;
    controller.abort(reason);
    activeOperations.delete(conversationId);
    return true;
  }

  async send(input: {
    conversation: PreparationConversation;
    content: string;
    materialRefs?: string[];
    onText?: (complete: string) => void;
  }) {
    const content = input.content.trim();
    if (!content) throw new Error("Preparation message cannot be empty.");
    this.cancel(input.conversation.id, "superseded-by-new-message");
    const userMessage = await this.appendUserMessage({
      conversation: input.conversation,
      content,
      materialRefs: input.materialRefs ?? [],
    });
    return this.generateAssistant({
      conversation: { ...input.conversation, headRevision: userMessage.revision },
      request: content,
      parentMessageId: userMessage.id,
      onText: input.onText,
    });
  }

  async editAndRegenerate(input: {
    conversation: PreparationConversation;
    messageId: string;
    content: string;
    onText?: (complete: string) => void;
  }) {
    const content = input.content.trim();
    if (!content) throw new Error("Preparation message cannot be empty.");
    this.cancel(input.conversation.id, "conversation-branch-edited");
    const targets = await this.database.select<MessageRow[]>(
      "SELECT * FROM preparation_messages WHERE id = ? AND conversation_id = ? AND role = 'user' AND status = 'committed'",
      [input.messageId, input.conversation.id]
    );
    if (!targets[0]) throw new Error("Only a committed user message can be edited.");
    const newRevision = input.conversation.headRevision + 1;
    const message: PreparationMessage = {
      id: `message_${crypto.randomUUID()}`,
      conversationId: input.conversation.id,
      revision: newRevision,
      parentMessageId: targets[0].parent_message_id ?? undefined,
      role: "user",
      content,
      materialRefs: decodeJson(targets[0].material_refs_json, []),
      proposedArtifactRefs: [],
      status: "committed",
      createdAt: Date.now(),
    };
    await withTransaction(this.database, async (transaction) => {
      const claimed = await transaction.execute(
        `UPDATE preparation_conversations SET head_revision = ?, updated_at = ?
         WHERE id = ? AND head_revision = ?`,
        [newRevision, message.createdAt, input.conversation.id, input.conversation.headRevision]
      );
      if (claimed.rowsAffected !== 1) throw new Error("Conversation revision conflict.");
      await transaction.execute(
        "UPDATE preparation_messages SET status = 'superseded' WHERE conversation_id = ? AND revision >= ? AND status = 'committed'",
        [input.conversation.id, targets[0].revision]
      );
      await this.insertMessage(message, transaction);
    });
    return this.generateAssistant({
      conversation: { ...input.conversation, headRevision: newRevision },
      request: content,
      parentMessageId: message.id,
      onText: input.onText,
    });
  }

  private async appendUserMessage(input: {
    conversation: PreparationConversation;
    content: string;
    materialRefs: string[];
  }) {
    const now = Date.now();
    const revision = input.conversation.headRevision + 1;
    const existing = await this.messages(input.conversation.id);
    const message: PreparationMessage = {
      id: `message_${crypto.randomUUID()}`,
      conversationId: input.conversation.id,
      revision,
      parentMessageId: existing[existing.length - 1]?.id,
      role: "user",
      content: input.content,
      materialRefs: input.materialRefs,
      proposedArtifactRefs: [],
      status: "committed",
      createdAt: now,
    };
    await withTransaction(this.database, async (transaction) => {
      const claimed = await transaction.execute(
        `UPDATE preparation_conversations SET head_revision = ?, updated_at = ?,
         title = CASE WHEN head_revision = 0 THEN ? ELSE title END
         WHERE id = ? AND case_id = ? AND head_revision = ?`,
        [revision, now, conversationTitle(input.content), input.conversation.id, input.conversation.caseId, input.conversation.headRevision]
      );
      if (claimed.rowsAffected !== 1) throw new Error("Conversation revision conflict.");
      await this.insertMessage(message, transaction);
    });
    return message;
  }

  private async generateAssistant(input: {
    conversation: PreparationConversation;
    request: string;
    parentMessageId: string;
    onText?: (complete: string) => void;
  }) {
    const operationId = `preparation_${crypto.randomUUID()}`;
    const controller = new AbortController();
    activeOperations.set(input.conversation.id, controller);
    const context = await composePreparationContext({
      database: this.database,
      conversationId: input.conversation.id,
      caseId: input.conversation.caseId,
      callPlanId: input.conversation.callPlanId,
      currentRequest: input.request,
    });
    const route = loadModelRouteSettings().chat.complex;
    const provider = getChatProvider(route.provider);
    const apiKey = provider.requiresApiKey ? await loadProviderSecret("complex") : "";
    if (provider.requiresApiKey && !apiKey) {
      activeOperations.delete(input.conversation.id);
      throw new Error("Configure the Complex Task model before using Case Preparation.");
    }
    const userPrompt = serializePreparationContext(context);
    const dispatchedAt = Date.now();
    await this.recordOperation({
      caseId: input.conversation.caseId,
      callPlanId: input.conversation.callPlanId,
      operationId,
      operationKind: "preparation-conversation",
      status: "dispatched",
      payload: { provider: route.provider, model: route.model, contextHash: context.manifest.contextHash, systemPrompt: PREPARATION_SYSTEM_PROMPT, userPrompt },
      occurredAt: dispatchedAt,
    });
    try {
      const content = await requestChatCompletionStream({
        route,
        apiKey,
        messages: [
          { role: "system", content: PREPARATION_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        signal: controller.signal,
        onText: input.onText ?? (() => undefined),
      });
      if (activeOperations.get(input.conversation.id) !== controller) {
        throw new DOMException("Preparation response became stale.", "AbortError");
      }
      const assistant = await this.appendAssistantMessage({
        conversation: input.conversation,
        content,
        operationId,
        parentMessageId: input.parentMessageId,
        context,
      });
      await this.recordOperation({
        caseId: input.conversation.caseId,
        callPlanId: input.conversation.callPlanId,
        operationId,
        operationKind: "preparation-conversation",
        status: "committed",
        payload: { durationMs: Date.now() - dispatchedAt, responseChars: content.length, messageId: assistant.id },
        occurredAt: Date.now(),
      });
      await this.updateRollingSummary(input.conversation.id);
      return assistant;
    } catch (error) {
      await this.recordOperation({
        caseId: input.conversation.caseId,
        callPlanId: input.conversation.callPlanId,
        operationId,
        operationKind: "preparation-conversation",
        status: controller.signal.aborted ? "cancelled" : "failed",
        payload: { error: error instanceof Error ? error.message : String(error) },
        occurredAt: Date.now(),
      });
      throw error;
    } finally {
      if (activeOperations.get(input.conversation.id) === controller) activeOperations.delete(input.conversation.id);
    }
  }

  private async appendAssistantMessage(input: {
    conversation: PreparationConversation;
    content: string;
    operationId: string;
    parentMessageId: string;
    context: PreparationModelContext;
  }) {
    const revision = input.conversation.headRevision + 1;
    const message: PreparationMessage = {
      id: `message_${crypto.randomUUID()}`,
      conversationId: input.conversation.id,
      revision,
      parentMessageId: input.parentMessageId,
      role: "assistant",
      content: input.content,
      materialRefs: input.context.materialEvidence.map((item) => item.materialId),
      proposedArtifactRefs: [],
      contextManifest: input.context.manifest,
      status: "committed",
      operationId: input.operationId,
      createdAt: Date.now(),
    };
    await withTransaction(this.database, async (transaction) => {
      const claimed = await transaction.execute(
        `UPDATE preparation_conversations SET head_revision = ?, updated_at = ?
         WHERE id = ? AND head_revision = ?`,
        [revision, message.createdAt, input.conversation.id, input.conversation.headRevision]
      );
      if (claimed.rowsAffected !== 1) throw new Error("Preparation response became stale.");
      await this.insertMessage(message, transaction);
    });
    return message;
  }

  private async insertMessage(message: PreparationMessage, database: SqlDatabase = this.database) {
    await database.execute(
      `INSERT INTO preparation_messages (
        id, conversation_id, revision, parent_message_id, role, content,
        material_refs_json, proposed_artifact_refs_json, context_manifest_json,
        status, operation_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        message.id,
        message.conversationId,
        message.revision,
        message.parentMessageId ?? null,
        message.role,
        message.content,
        encodeJson(message.materialRefs),
        encodeJson(message.proposedArtifactRefs),
        message.contextManifest ? encodeJson(message.contextManifest) : null,
        message.status,
        message.operationId ?? null,
        message.createdAt,
      ]
    );
  }

  private async updateRollingSummary(conversationId: string) {
    const messages = await this.messages(conversationId);
    if (messages.length < 14) return;
    const summary = messages
      .filter((message) => message.role === "user")
      .slice(-8)
      .map((message) => message.content)
      .join(" | ")
      .slice(0, 1_600);
    await this.database.execute(
      "UPDATE preparation_conversations SET generated_summary = ?, generated_summary_hash = ? WHERE id = ?",
      [summary, await sha256(summary), conversationId]
    );
  }

  private async recordOperation(input: {
    caseId: string;
    callPlanId?: string;
    operationId: string;
    operationKind: string;
    status: string;
    payload: unknown;
    occurredAt: number;
  }) {
    await this.database.execute(
      `INSERT INTO preparation_operation_events (
        id, case_id, call_plan_id, operation_id, operation_kind, status, payload_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [`preparation_event_${crypto.randomUUID()}`, input.caseId, input.callPlanId ?? null, input.operationId, input.operationKind, input.status, encodeJson(input.payload), input.occurredAt]
    );
  }
}

export function serializePreparationContext(context: PreparationModelContext) {
  const statementLines = context.confirmedStatements.map(
    (item) => `[STATEMENT:${item.id}] ${item.kind}/${item.claimState}: ${item.content}`
  );
  const materialLines = context.materialEvidence.map(
    (item) => `[MATERIAL:${item.chunkId}] ${item.materialName}${item.pageNumber ? ` page ${item.pageNumber}` : ""}: ${item.content}`
  );
  const recent = context.recentMessages.map((item) => `[MESSAGE:${item.id}@${item.revision}] ${item.role.toUpperCase()}: ${item.content}`);
  const guidance = context.curatedGuidance.map(
    (item) => `[KMB:${item.id}] ${item.title}: ${item.content}`
  );
  return [
    `CASE: ${context.identity.caseTitle} (${context.identity.caseId})`,
    context.identity.callPlanId ? `CALL PLAN: ${context.identity.callPlanTitle} (${context.identity.callPlanId})` : "SCOPE: Entire case",
    `OBJECTIVE: ${context.identity.objective}`,
    `CURRENT REQUEST: ${context.currentRequest}`,
    context.rollingSummary ? `NON-AUTHORITATIVE ROLLING SUMMARY:\n${context.rollingSummary}` : "",
    `RECENT CONVERSATION:\n${recent.join("\n")}`,
    `CONFIRMED STATE:\n${statementLines.join("\n") || "None"}`,
    `SOURCE MATERIAL:\n${materialLines.join("\n") || "None"}`,
    `CURATED GUIDANCE:\n${guidance.join("\n") || "None"}`,
    `UNRESOLVED RISKS:\n${context.unresolvedRisks.join("\n") || "None"}`,
  ].filter(Boolean).join("\n\n");
}
