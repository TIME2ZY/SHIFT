/**
 * Message-type contract shared by the React UI (Phase E).
 * Must stay aligned with src/storage/message-repository.js MESSAGE_TYPES
 * and Phase B-3 write rules (assistant-final vs assistant-callback).
 */

export const MESSAGE_TYPES = Object.freeze({
  USER: "user",
  ASSISTANT_FINAL: "assistant-final",
  ASSISTANT_CALLBACK: "assistant-callback",
  A2A_ROUTE: "a2a-route",
  A2A_SKIPPED: "a2a-skipped",
  A2A_PHASE_REJECTED: "a2a-phase-rejected",
  HANDOFF_REPAIR_NEEDED: "handoff-repair-needed",
  MEMORY_NOTICE: "memory-notice",
  SYSTEM_NOTICE: "system-notice",
} as const);

export type MessageType = (typeof MESSAGE_TYPES)[keyof typeof MESSAGE_TYPES];

export function isAssistantCallbackMessage(message: {
  messageType?: string | null;
}): boolean {
  return message.messageType === MESSAGE_TYPES.ASSISTANT_CALLBACK;
}

export function isAssistantFinalMessage(message: {
  messageType?: string | null;
}): boolean {
  return message.messageType === MESSAGE_TYPES.ASSISTANT_FINAL;
}

/** Process/live UI attaches only to final host bubbles, never callbacks. */
export function isProcessHostMessageType(messageType: string | null | undefined): boolean {
  if (!messageType) return false;
  return messageType === MESSAGE_TYPES.ASSISTANT_FINAL;
}
