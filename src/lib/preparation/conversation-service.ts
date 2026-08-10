import type {
  PreparationConversation,
  PreparationConversationDetail,
  PreparationConversationRepository,
  PreparationConversationRequestLease,
  PreparationConversationScope,
  PreparationMessage,
  PreparationMessageContextSnapshot,
} from "./conversation-types.js";
import type { InterviewProcessRepository } from "./interview-types.js";

const MAX_USER_MESSAGE_CHARS = 20_000;
const MAX_ASSISTANT_MESSAGE_CHARS = 60_000;
const MAX_CONVERSATION_TITLE_CHARS = 120;
const DEFAULT_CONVERSATION_TITLE = "New preparation chat";

export interface PreparationConversationServiceDependencies {
  repository: PreparationConversationRepository;
  interviewProcesses: InterviewProcessRepository;
  now?: () => number;
  createId?: () => string;
}

export function createPreparationConversationService(
  dependencies: PreparationConversationServiceDependencies
) {
  const now = dependencies.now ?? Date.now;
  const createId = dependencies.createId ?? (() => crypto.randomUUID());

  const validateScope = async (
    processId: string,
    scope: PreparationConversationScope
  ) => {
    const process = await dependencies.interviewProcesses.getProcess(processId);
    if (!process) throw new Error("Interview process not found.");
    if (scope.kind === "round") {
      const round = await dependencies.interviewProcesses.getRound(scope.roundId);
      if (!round || round.processId !== processId || round.archivedAt) {
        throw new Error("Interview round does not belong to this process.");
      }
      return { process, round };
    }
    return { process, round: undefined };
  };

  const getConversation = async (processId: string, conversationId: string) => {
    const conversation = await dependencies.repository.getById(conversationId);
    if (!conversation || conversation.processId !== processId) {
      throw new Error("Preparation conversation not found.");
    }
    const domain = await validateScope(processId, conversation.scope);
    return { conversation, ...domain };
  };

  const begin = async (input: {
    processId: string;
    conversationId: string;
    content: string;
    materialRefs?: string[];
    requestMetadata?: PreparationMessage["requestMetadata"];
    editMessageId?: string;
  }): Promise<PreparationConversationRequestLease> => {
    const content = normalizeMessage(
      input.content,
      "Preparation message",
      MAX_USER_MESSAGE_CHARS
    );
    const materialRefs = normalizeRefs(input.materialRefs);
    let domain = await getConversation(input.processId, input.conversationId);
    if (domain.process.status !== "active") {
      throw new Error("Archived interview processes are read-only.");
    }

    const visibleMessages = input.editMessageId
      ? await dependencies.repository.listMessages(domain.conversation.id)
      : [];
    const editTarget = input.editMessageId
      ? visibleMessages.find(
          (message) =>
            message.id === input.editMessageId && message.role === "user"
        )
      : undefined;
    if (input.editMessageId && !editTarget) {
      throw new Error("The preparation message is no longer on this conversation branch.");
    }
    if (
      editTarget?.requestMetadata?.image ||
      editTarget?.requestMetadata?.recovery
    ) {
      throw new Error("File-recovery requests cannot be edited in place; send a new request.");
    }

    const operationId = createId();
    const logicalTurnId = createId();
    const maxAttempts = editTarget ? 1 : 2;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const timestamp = now();
      const expectedRevision = domain.conversation.revision;
      const parentMessageId = editTarget
        ? editTarget.parentMessageId
        : domain.conversation.headMessageId;
      const userMessage: PreparationMessage = {
        id: createId(),
        conversationId: domain.conversation.id,
        logicalTurnId,
        role: "user",
        content,
        materialRefs: editTarget?.materialRefs ?? materialRefs,
        sourceRefs: [],
        requestMetadata: editTarget?.requestMetadata ?? input.requestMetadata,
        operationId,
        parentMessageId,
        supersedesMessageId: editTarget?.id,
        createdAt: timestamp,
        committedAt: timestamp,
      };
      const autoTitle = parentMessageId ? undefined : buildAutomaticTitle(content);
      const claimed = await dependencies.repository.beginRequest({
        conversationId: domain.conversation.id,
        operationId,
        logicalTurnId,
        expectedRevision,
        userMessage,
        autoTitle,
        resetSummary: Boolean(editTarget),
        updatedAt: timestamp,
      });
      if (claimed) {
        return {
          conversation: {
            ...domain.conversation,
            title:
              autoTitle && domain.conversation.titleSource !== "manual"
                ? autoTitle
                : domain.conversation.title,
            titleSource:
              autoTitle && domain.conversation.titleSource !== "manual"
                ? "automatic"
                : domain.conversation.titleSource,
            revision: expectedRevision + 1,
            activeOperationId: operationId,
            headMessageId: userMessage.id,
            rollingSummary: editTarget
              ? undefined
              : domain.conversation.rollingSummary,
            summaryThroughMessageId: editTarget
              ? undefined
              : domain.conversation.summaryThroughMessageId,
            updatedAt: timestamp,
          },
          userMessage,
          operationId,
          logicalTurnId,
          expectedRevision: expectedRevision + 1,
        };
      }
      domain = await getConversation(input.processId, input.conversationId);
    }
    throw new Error("Preparation conversation changed; retry the request.");
  };

  return {
    async create(input: {
      processId: string;
      scope: PreparationConversationScope;
      title?: string;
    }) {
      const domain = await validateScope(input.processId, input.scope);
      if (domain.process.status !== "active") {
        throw new Error("Archived interview processes are read-only.");
      }
      const timestamp = now();
      const manualTitle = input.title?.trim()
        ? normalizeTitle(input.title)
        : undefined;
      const conversation: PreparationConversation = {
        id: createId(),
        processId: input.processId,
        scope: input.scope,
        title: manualTitle ?? DEFAULT_CONVERSATION_TITLE,
        titleSource: manualTitle ? "manual" : "placeholder",
        status: "active",
        revision: 0,
        summaryRevision: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await dependencies.repository.insert(conversation);
      return conversation;
    },

    async list(processId: string) {
      await validateScope(processId, { kind: "process" });
      return dependencies.repository.listForProcess(processId);
    },

    async load(
      processId: string,
      conversationId: string
    ): Promise<PreparationConversationDetail> {
      const { conversation } = await getConversation(processId, conversationId);
      return {
        conversation,
        messages: await dependencies.repository.listMessages(conversation.id),
      };
    },

    async updateMetadata(input: {
      processId: string;
      conversationId: string;
      title: string;
      scope: PreparationConversationScope;
    }) {
      const domain = await getConversation(input.processId, input.conversationId);
      if (domain.process.status !== "active") {
        throw new Error("Archived interview processes are read-only.");
      }
      await validateScope(input.processId, input.scope);
      const title = normalizeTitle(input.title);
      const updated = await dependencies.repository.updateMetadata({
        conversationId: input.conversationId,
        processId: input.processId,
        title,
        titleSource: "manual",
        scope: input.scope,
        updatedAt: now(),
      });
      if (!updated) {
        throw new Error("Preparation conversation changed; retry the edit.");
      }
    },

    async delete(processId: string, conversationId: string) {
      const domain = await getConversation(processId, conversationId);
      if (domain.process.status !== "active") {
        throw new Error("Archived interview processes are read-only.");
      }
      if (!(await dependencies.repository.deleteConversation(processId, conversationId))) {
        throw new Error("Preparation conversation is busy; retry deletion.");
      }
    },

    beginRequest(input: {
      processId: string;
      conversationId: string;
      content: string;
      materialRefs?: string[];
      requestMetadata?: PreparationMessage["requestMetadata"];
    }) {
      return begin(input);
    },

    beginEditRequest(input: {
      processId: string;
      conversationId: string;
      messageId: string;
      content: string;
    }) {
      return begin({ ...input, editMessageId: input.messageId });
    },

    async commitAssistant(input: {
      lease: PreparationConversationRequestLease;
      content: string;
      modelExecutionRef: string;
      contextSnapshot: PreparationMessageContextSnapshot;
    }) {
      const content = normalizeMessage(
        input.content,
        "Preparation response",
        MAX_ASSISTANT_MESSAGE_CHARS
      );
      const timestamp = now();
      const assistantMessage: PreparationMessage = {
        id: createId(),
        conversationId: input.lease.conversation.id,
        logicalTurnId: input.lease.logicalTurnId,
        role: "assistant",
        content,
        materialRefs: input.contextSnapshot.sourceRefs
          .map((source) => source.materialId)
          .filter((id): id is string => Boolean(id)),
        sourceRefs: input.contextSnapshot.sourceRefs,
        modelExecutionRef: input.modelExecutionRef,
        contextSnapshot: input.contextSnapshot,
        operationId: input.lease.operationId,
        parentMessageId: input.lease.userMessage.id,
        createdAt: timestamp,
        committedAt: timestamp,
      };
      const committed = await dependencies.repository.commitAssistant({
        conversationId: input.lease.conversation.id,
        operationId: input.lease.operationId,
        expectedRevision: input.lease.expectedRevision,
        assistantMessage,
        updatedAt: timestamp,
      });
      return {
        committed,
        assistantMessage: committed ? assistantMessage : undefined,
      };
    },

    cancelRequest(lease: PreparationConversationRequestLease) {
      return dependencies.repository.cancelRequest({
        conversationId: lease.conversation.id,
        operationId: lease.operationId,
        expectedRevision: lease.expectedRevision,
        updatedAt: now(),
      });
    },

    updateSummary(input: {
      lease: PreparationConversationRequestLease;
      rollingSummary?: string;
      summaryRevision: number;
      summaryThroughMessageId?: string;
    }) {
      return dependencies.repository.updateSummary({
        conversationId: input.lease.conversation.id,
        operationId: input.lease.operationId,
        expectedRevision: input.lease.expectedRevision,
        rollingSummary: input.rollingSummary,
        summaryRevision: input.summaryRevision,
        summaryThroughMessageId: input.summaryThroughMessageId,
        updatedAt: now(),
      });
    },

    countForRound: dependencies.repository.countForRound.bind(
      dependencies.repository
    ),
  };
}

function normalizeMessage(value: string, label: string, maxChars: number) {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > maxChars) {
    throw new Error(
      `${label} must be ${maxChars.toLocaleString()} characters or fewer.`
    );
  }
  return normalized;
}

function normalizeTitle(value: string) {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) throw new Error("Conversation title is required.");
  if (normalized.length > MAX_CONVERSATION_TITLE_CHARS) {
    throw new Error(
      `Conversation title must be ${MAX_CONVERSATION_TITLE_CHARS} characters or fewer.`
    );
  }
  return normalized;
}

export function buildAutomaticTitle(content: string) {
  const firstSentence = content
    .replace(/\r\n/g, "\n")
    .split(/[.!?。！？\n]/u)[0]
    ?.replace(/\s+/gu, " ")
    .trim();
  const source = firstSentence || content.trim();
  const words = source.split(/\s+/u).filter(Boolean);
  if (words.length > 1) return words.slice(0, 10).join(" ");
  return source.slice(0, 40);
}

function normalizeRefs(refs: string[] | undefined) {
  return [...new Set((refs ?? []).map((ref) => ref.trim()).filter(Boolean))].slice(
    0,
    12
  );
}
