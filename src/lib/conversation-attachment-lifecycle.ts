import { MAX_FILES } from "../config/constants.js";

export interface TransientConversationAttachment {
  id: string;
  name: string;
  type: string;
  base64: string;
  size: number;
}

export const CONVERSATION_ATTACHMENT_LIFECYCLE = {
  maxFiles: MAX_FILES,
  acceptedMimePrefix: "image/",
  requestPayload: "base64-images",
  persistence: "request-only",
  durableEvidence: false,
} as const;

export function isTransientImageAttachment(
  attachment: Pick<TransientConversationAttachment, "type">
) {
  return attachment.type.startsWith(
    CONVERSATION_ATTACHMENT_LIFECYCLE.acceptedMimePrefix
  );
}

export function selectTransientImagePayloads(
  attachments: readonly TransientConversationAttachment[]
) {
  return attachments
    .filter(isTransientImageAttachment)
    .slice(0, CONVERSATION_ATTACHMENT_LIFECYCLE.maxFiles)
    .map((attachment) => attachment.base64);
}

export function selectAcceptedTransientImageFiles<T extends { type: string }>(
  files: readonly T[],
  currentCount: number
) {
  const availableSlots = Math.max(
    0,
    CONVERSATION_ATTACHMENT_LIFECYCLE.maxFiles - currentCount
  );
  return files.filter(isTransientImageAttachment).slice(0, availableSlots);
}
