import { createPreparationConversationExecutionService } from "../../src/lib/preparation/conversation-execution";

const process = { id: "process-1", workspaceId: "process-1", title: "Interview fixture", status: "active", activeRoundId: "round-1", createdAt: 1, updatedAt: 1 };
const rounds = Array.from({ length: 8 }, (_, i) => ({ id: `round-${i + 1}`, processId: process.id, title: `Round ${i + 1}`, stage: "coding", expectedInterviewTypes: ["coding"], createdAt: 1, updatedAt: 1 }));
const conversation = { id: "conversation-1", processId: process.id, scope: { kind: "process" }, title: "Preparation fixture", status: "active", revision: 1, summaryRevision: 0, createdAt: 1, updatedAt: 1 };
const materials = Array.from({ length: 6 }, (_, i) => ({ id: `material-${i}`, workspaceId: process.id, scope: { kind: "workspace" }, displayName: `Material ${i} ${"long filename ".repeat(8)}.txt`, mimeType: "text/plain", status: "ready", createdAt: 1, updatedAt: 1 }));
const sourceRefs = [
  { kind: "material", id: "material-source", title: "Reviewed material", materialId: "material-0", selectedChars: 20, truncated: false },
  { kind: "kmb", id: "kmb-source", title: "Personal experience", selectedChars: 20, truncated: false },
];
const budget = { totalChars: 40, maxChars: 30000, processMetadataChars: 0, rollingSummaryChars: 0, recentMessageChars: 0, materialChars: 20, kmbChars: 20, selectedMaterialChunks: 1, selectedKmbEntries: 1, omittedMaterialChunks: 0, omittedKmbEntries: 0, truncationReasons: [] };
let messages = [
  { id: "user-initial", conversationId: conversation.id, logicalTurnId: "turn-initial", role: "user", content: "Explain the tradeoffs.\n".repeat(35), materialRefs: [], sourceRefs: [], createdAt: 1 },
  { id: "answer-initial", conversationId: conversation.id, logicalTurnId: "turn-initial", role: "assistant", content: "Existing preparation paragraph with enough content for scrollback.\n\n".repeat(80), materialRefs: [], sourceRefs, contextSnapshot: { sourceRefs, budget }, createdAt: 2 },
];
const copy = (value) => structuredClone(value);
const empty = async () => [];
const noop = async () => undefined;
const state = {
  requests: [], compositions: [], cancellations: [], commits: [], events: [],
  push(chunk) { state.requests.at(-1).deliver({ value: chunk, done: false }); },
  finish() { state.requests.at(-1).deliver({ done: true }); },
  get messages() { return copy(messages); },
};

export const interviewPreparationConversationService = {
  list: async () => [copy(conversation)],
  load: async () => ({ conversation: copy(conversation), messages: copy(messages) }),
  async beginRequest(input) {
    const operationId = `operation-${++conversation.revision}`;
    conversation.activeOperationId = operationId;
    const userMessage = { id: `user-${operationId}`, conversationId: conversation.id, logicalTurnId: operationId, role: "user", content: input.content, materialRefs: input.materialRefs ?? [], sourceRefs: [], operationId, createdAt: Date.now() };
    messages.push(userMessage);
    return { conversation: copy(conversation), userMessage, operationId, logicalTurnId: operationId, expectedRevision: conversation.revision };
  },
  async beginEditRequest(input) {
    messages = messages.slice(0, messages.findIndex((message) => message.id === input.messageId));
    return this.beginRequest(input);
  },
  updateSummary: async () => true,
  async cancelRequest(lease) { state.cancellations.push(lease.operationId); return true; },
  async commitAssistant(input) {
    state.commits.push(copy(input));
    const assistantMessage = { id: `answer-${input.lease.operationId}`, conversationId: conversation.id, logicalTurnId: input.lease.logicalTurnId, role: "assistant", content: input.content, sourceRefs: input.contextSnapshot.sourceRefs, materialRefs: [], contextSnapshot: input.contextSnapshot, createdAt: Date.now() };
    messages.push(assistantMessage);
    return { committed: true, assistantMessage };
  },
};
export const interviewPreparationService = {
  list: async () => [copy(process)],
  get: async () => ({ process: copy(process), rounds: copy(rounds) }),
};
export const interviewPreparationMaterialService = { list: async () => copy(materials) };
export const interviewPreparationMaterialExtractionService = { resumeWorkspace: noop };
export const interviewPreparationStatementService = { list: empty, listEvents: empty };
export const interviewPreparationCompositionService = { getLatestProfile: noop, listNarratives: empty };
export const interviewPreparationSnapshotService = { getCurrentContext: async () => ({ revision: 0, updatedAt: 0 }), getCurrentSnapshot: noop, list: empty };
export const context = { allAiProviders: [{ id: "fixture-model", name: "Fixture model", curl: "{{TEXT}} {{IMAGE}}" }], selectedPreparationAIProvider: { provider: "fixture-model", variables: {} } };
export const interviewPreparationConversationExecutionService = createPreparationConversationExecutionService({
  conversations: interviewPreparationConversationService,
  interviewProcesses: { getProcess: async () => copy(process), getRound: async (id) => copy(rounds.find((round) => round.id === id)) },
  materials: { get: async (id) => copy(materials.find((material) => material.id === id)) },
  materialExtraction: {}, imageGateway: {},
  contextComposer: { async compose(input) {
    state.compositions.push(input.lease.operationId);
    return { systemContext: "Fixture material and KMB context", recentHistory: [], sourceRefs, budget };
  } },
  async *fetchResponse(input) {
    const queue = [];
    let receive;
    const request = { signal: input.signal, prompt: input.userMessage, deliver(value) {
      if (receive) { const next = receive; receive = undefined; next(value); }
      else queue.push(value);
    } };
    state.requests.push(request);
    // Deliberately ignores abort: the production execution owner must reject late output.
    while (true) {
      const next = queue.length ? queue.shift() : await new Promise((resolve) => { receive = resolve; });
      if (next.done) return;
      yield next.value;
    }
  },
  onEvent: (event) => state.events.push(event),
});
window.__prep = { ...state, get messages() { return state.messages; }, service: interviewPreparationConversationExecutionService };
