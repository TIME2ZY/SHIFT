const MESSAGE_METADATA_FIELDS = new Set([
  "id",
  "role",
  "agent",
  "content",
  "createdAt",
  "messageType",
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

module.exports = { appendMessage, durableMessageMetadata, upsertMessageRecall };
