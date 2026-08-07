/**
 * Online message write contract (Phase B-3 / architecture-map §3.3).
 *
 * Physical insert: only this module's `appendMessage` may call
 * `storage.messages.append` on the hot path. Offline migrate tools may use
 * the repository directly; server/agents must not.
 *
 * Use-case entry points (two rivers, one physical write):
 * | Case | Entry | messageType |
 * |------|-------|-------------|
 * | User / system (incl. A2A notices) | sqlite-session-service.appendToSession | user, a2a-*, system-notice, … |
 * | Assistant final + invocation end | durableRecorder.completeInvocation({ message }) | assistant-final |
 * | Mid-run agent callback | appendToSession with source=callback | assistant-callback |
 *
 * Rules:
 * - Callback fragments must use messageType `assistant-callback` (never final).
 * - Only one assistant-final per successful invocation finish transaction.
 * - Do not insert messages from routes without going through these entries.
 */
const { MESSAGE_TYPES } = require("./message-repository");

const MESSAGE_METADATA_FIELDS = new Set([
  "id",
  "role",
  "agent",
  "content",
  "createdAt",
  "messageType",
  "clientTurnId",
]);

function durableMessageMetadata(message) {
  const metadata = {};
  for (const [key, value] of Object.entries(message || {})) {
    if (!MESSAGE_METADATA_FIELDS.has(key)) metadata[key] = value;
  }
  return Object.keys(metadata).length > 0 ? metadata : null;
}

function appendMessage(storage, input, options = {}) {
  const message = storage.messages.append(input);
  if (options.projectRecall !== false) upsertMessageRecall(storage, message);
  return message;
}

function upsertMessageRecall(storage, message) {
  if (!storage.recall) return null;
  return storage.recall.upsert({
    threadId: message.threadId,
    windowId: message.windowId,
    sourceKind: "message",
    sourceId: message.id,
    title: `${message.role}${message.agentId ? `:${message.agentId}` : ""}`,
    content: message.content,
    agentId: message.agentId,
    createdAt: message.createdAt,
    metadata: {
      invocationId: message.invocationId,
      sequenceNo: message.sequenceNo,
      role: message.role,
      messageType: message.messageType,
    },
  });
}

module.exports = {
  appendMessage,
  durableMessageMetadata,
  upsertMessageRecall,
  MESSAGE_TYPES,
};
