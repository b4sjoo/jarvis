import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAutomaticTitle,
  createPreparationConversationService,
} from "../src/lib/preparation/conversation-service.js";
import type {
  PreparationConversation,
  PreparationConversationRepository,
  PreparationMessage,
} from "../src/lib/preparation/conversation-types.js";
import type {
  InterviewProcess,
  InterviewProcessRepository,
  InterviewRound,
} from "../src/lib/preparation/interview-types.js";

test("supports multiple isolated preparation sessions in the same round", async () => {
  const harness = createHarness();
  const service = createPreparationConversationService(harness.dependencies);
  const scope = { kind: "round" as const, roundId: "round-1" };
  const first = await service.create({ processId: "process-1", scope });
  const second = await service.create({ processId: "process-1", scope });
  const lease = await service.beginRequest({
    processId: "process-1",
    conversationId: first.id,
    content: "Help me prepare the project introduction in a concise way.",
  });
  await service.commitAssistant({
    lease,
    content: "Lead with the user problem and measurable impact.",
    modelExecutionRef: "model-1",
    contextSnapshot: snapshot(lease.operationId, lease.expectedRevision, scope),
  });

  assert.equal((await service.list("process-1")).length, 2);
  assert.equal(
    (await service.load("process-1", first.id)).conversation.title,
    "Help me prepare the project introduction in a concise way"
  );
  assert.deepEqual(
    (await service.load("process-1", first.id)).messages.map(
      (message) => message.role
    ),
    ["user", "assistant"]
  );
  assert.deepEqual(
    (await service.load("process-1", second.id)).messages,
    []
  );
  assert.equal(await service.countForRound("process-1", "round-1"), 2);
});

test("editing a user message branches history and drops the old generation", async () => {
  const harness = createHarness();
  const service = createPreparationConversationService(harness.dependencies);
  const scope = { kind: "round" as const, roundId: "round-1" };
  const conversation = await service.create({
    processId: "process-1",
    scope,
  });
  const first = await service.beginRequest({
    processId: "process-1",
    conversationId: conversation.id,
    content: "Explain project alpha.",
  });
  await service.commitAssistant({
    lease: first,
    content: "Original explanation.",
    modelExecutionRef: "model-1",
    contextSnapshot: snapshot(first.operationId, first.expectedRevision, scope),
  });
  const beforeEdit = await service.load("process-1", conversation.id);
  const second = await service.beginRequest({
    processId: "process-1",
    conversationId: conversation.id,
    content: "Add implementation details.",
  });
  const edited = await service.beginEditRequest({
    processId: "process-1",
    conversationId: conversation.id,
    messageId: beforeEdit.messages[0].id,
    content: "Explain project beta instead.",
  });

  const stale = await service.commitAssistant({
    lease: second,
    content: "Late alpha details.",
    modelExecutionRef: "model-old",
    contextSnapshot: snapshot(second.operationId, second.expectedRevision, scope),
  });
  const current = await service.commitAssistant({
    lease: edited,
    content: "Beta explanation.",
    modelExecutionRef: "model-new",
    contextSnapshot: snapshot(edited.operationId, edited.expectedRevision, scope),
  });

  assert.equal(stale.committed, false);
  assert.equal(current.committed, true);
  assert.deepEqual(
    (await service.load("process-1", conversation.id)).messages.map(
      (message) => message.content
    ),
    ["Explain project beta instead.", "Beta explanation."]
  );
});

test("keeps archived preparation processes read-only", async () => {
  const harness = createHarness({ archived: true });
  const service = createPreparationConversationService(harness.dependencies);

  await assert.rejects(
    service.create({ processId: "process-1", scope: { kind: "process" } }),
    /read-only/
  );
});

test("automatic titles use the first sentence and at most ten words", () => {
  assert.equal(
    buildAutomaticTitle(
      "One two three four five six seven eight nine ten eleven twelve. Ignored."
    ),
    "One two three four five six seven eight nine ten"
  );
});

function createHarness(options: { archived?: boolean } = {}) {
  const conversations = new Map<string, PreparationConversation>();
  const messages = new Map<string, PreparationMessage[]>();
  const process: InterviewProcess = {
    id: "process-1",
    workspaceId: "process-1",
    title: "Interview",
    status: options.archived ? "archived" : "active",
    activeRoundId: "round-1",
    createdAt: 1,
    updatedAt: 1,
  };
  const round: InterviewRound = {
    id: "round-1",
    processId: process.id,
    title: "Technical",
    stage: "mixed",
    expectedInterviewTypes: [],
    expectedTypePolicy: "advisory",
    createdAt: 1,
    updatedAt: 1,
  };
  let id = 0;
  let timestamp = 1_000;

  const repository: PreparationConversationRepository = {
    async getById(conversationId) {
      const conversation = conversations.get(conversationId);
      return conversation ? { ...conversation } : undefined;
    },
    async listForProcess(processId) {
      return [...conversations.values()]
        .filter((conversation) => conversation.processId === processId)
        .map((conversation) => ({ ...conversation }));
    },
    async insert(conversation) {
      conversations.set(conversation.id, { ...conversation });
      messages.set(conversation.id, []);
    },
    async updateMetadata(input) {
      const conversation = conversations.get(input.conversationId);
      if (
        !conversation ||
        conversation.processId !== input.processId ||
        conversation.activeOperationId
      ) {
        return false;
      }
      conversations.set(conversation.id, {
        ...conversation,
        title: input.title,
        titleSource: input.titleSource,
        scope: input.scope,
        revision: conversation.revision + 1,
        updatedAt: input.updatedAt,
      });
      return true;
    },
    async deleteConversation(processId, conversationId) {
      const conversation = conversations.get(conversationId);
      if (
        !conversation ||
        conversation.processId !== processId ||
        conversation.activeOperationId
      ) {
        return false;
      }
      messages.delete(conversationId);
      return conversations.delete(conversationId);
    },
    async listMessages(conversationId) {
      const conversation = conversations.get(conversationId);
      const allMessages = messages.get(conversationId) ?? [];
      const byId = new Map(allMessages.map((message) => [message.id, message]));
      const branch: PreparationMessage[] = [];
      let currentId = conversation?.headMessageId;
      while (currentId) {
        const message = byId.get(currentId);
        if (!message) break;
        branch.unshift({ ...message });
        currentId = message.parentMessageId;
      }
      return branch;
    },
    async beginRequest(input) {
      const conversation = conversations.get(input.conversationId);
      if (!conversation || conversation.revision !== input.expectedRevision) {
        return false;
      }
      conversations.set(conversation.id, {
        ...conversation,
        title:
          input.autoTitle && conversation.titleSource !== "manual"
            ? input.autoTitle
            : conversation.title,
        titleSource:
          input.autoTitle && conversation.titleSource !== "manual"
            ? "automatic"
            : conversation.titleSource,
        revision: conversation.revision + 1,
        activeOperationId: input.operationId,
        headMessageId: input.userMessage.id,
        rollingSummary: input.resetSummary
          ? undefined
          : conversation.rollingSummary,
        summaryThroughMessageId: input.resetSummary
          ? undefined
          : conversation.summaryThroughMessageId,
        updatedAt: input.updatedAt,
      });
      messages.get(conversation.id)?.push({ ...input.userMessage });
      return true;
    },
    async commitAssistant(input) {
      const conversation = conversations.get(input.conversationId);
      if (
        !conversation ||
        conversation.revision !== input.expectedRevision ||
        conversation.activeOperationId !== input.operationId
      ) {
        return false;
      }
      conversations.set(conversation.id, {
        ...conversation,
        revision: conversation.revision + 1,
        activeOperationId: undefined,
        headMessageId: input.assistantMessage.id,
        updatedAt: input.updatedAt,
      });
      messages.get(conversation.id)?.push({ ...input.assistantMessage });
      return true;
    },
    async cancelRequest(input) {
      const conversation = conversations.get(input.conversationId);
      if (
        !conversation ||
        conversation.revision !== input.expectedRevision ||
        conversation.activeOperationId !== input.operationId
      ) {
        return false;
      }
      conversations.set(conversation.id, {
        ...conversation,
        revision: conversation.revision + 1,
        activeOperationId: undefined,
        updatedAt: input.updatedAt,
      });
      return true;
    },
    async updateSummary(input) {
      const conversation = conversations.get(input.conversationId);
      if (
        !conversation ||
        conversation.revision !== input.expectedRevision ||
        conversation.activeOperationId !== input.operationId
      ) {
        return false;
      }
      conversations.set(conversation.id, {
        ...conversation,
        rollingSummary: input.rollingSummary,
        summaryRevision: input.summaryRevision,
        summaryThroughMessageId: input.summaryThroughMessageId,
      });
      return true;
    },
    async countForRound(processId, roundId) {
      return [...conversations.values()].filter(
        (conversation) =>
          conversation.processId === processId &&
          conversation.scope.kind === "round" &&
          conversation.scope.roundId === roundId
      ).length;
    },
  };

  const interviewProcesses: InterviewProcessRepository = {
    async getProcess(processId) {
      return processId === process.id ? process : undefined;
    },
    async getRound(roundId) {
      return roundId === round.id ? round : undefined;
    },
    async listRounds() {
      return [round];
    },
    async listProcesses() {
      return [process];
    },
    async insertProcess() {},
    async updateProcess() {},
    async insertRound() {},
    async updateRound() {},
    async deleteRound() {},
    async setActiveRound() {},
  };

  return {
    dependencies: {
      repository,
      interviewProcesses,
      now: () => ++timestamp,
      createId: () => `id-${++id}`,
    },
  };
}

function emptyBudget() {
  return {
    totalChars: 0,
    maxChars: 30_000,
    processMetadataChars: 0,
    rollingSummaryChars: 0,
    recentMessageChars: 0,
    materialChars: 0,
    kmbChars: 0,
    selectedMaterialChunks: 0,
    selectedKmbEntries: 0,
    omittedMaterialChunks: 0,
    omittedKmbEntries: 0,
    truncationReasons: [],
  };
}

function snapshot(
  operationId: string,
  conversationRevision: number,
  scope: { kind: "round"; roundId: string }
) {
  return {
    providerId: "provider",
    operationId,
    conversationRevision,
    scope,
    sourceRefs: [],
    budget: emptyBudget(),
    createdAt: 1,
  };
}
