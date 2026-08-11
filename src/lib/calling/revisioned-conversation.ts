export interface RevisionedMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export interface RevisionedConversation {
  id: string;
  revision: number;
  messages: RevisionedMessage[];
}

export function appendConversationMessage(input: {
  conversation: RevisionedConversation;
  expectedRevision: number;
  message: RevisionedMessage;
}): RevisionedConversation {
  if (input.conversation.revision !== input.expectedRevision) {
    throw new Error("Conversation revision conflict.");
  }
  if (input.conversation.messages.some((message) => message.id === input.message.id)) {
    throw new Error("Conversation message id already exists.");
  }
  return {
    ...input.conversation,
    revision: input.conversation.revision + 1,
    messages: [...input.conversation.messages, { ...input.message }],
  };
}

export function editConversationMessage(input: {
  conversation: RevisionedConversation;
  expectedRevision: number;
  messageId: string;
  content: string;
}): RevisionedConversation {
  if (input.conversation.revision !== input.expectedRevision) {
    throw new Error("Conversation revision conflict.");
  }
  const index = input.conversation.messages.findIndex(
    (message) => message.id === input.messageId
  );
  if (index < 0) throw new Error("Conversation message does not exist.");
  const edited = { ...input.conversation.messages[index], content: input.content };
  return {
    ...input.conversation,
    revision: input.conversation.revision + 1,
    messages: [...input.conversation.messages.slice(0, index), edited],
  };
}
