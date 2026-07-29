function createMessageRepository(db) {
  const allocateThreadSequence = db.prepare(`
    UPDATE threads
    SET next_message_sequence = next_message_sequence + 1
    WHERE id = ? AND deleted_at IS NULL
    RETURNING next_message_sequence - 1 AS sequence_no
  `);
  const advanceThreadSequence = db.prepare(`
    UPDATE threads
    SET next_message_sequence = MAX(next_message_sequence, ?)
    WHERE id = ? AND deleted_at IS NULL
  `);
  // Idempotent upsert: replaying an offline migration must not create
  // duplicate message rows (PRIMARY KEY id + UNIQUE thread/sequence).
  const insert = db.prepare(`
    INSERT INTO messages
      (id, thread_id, window_id, invocation_id, sequence_no, role,
       agent_id, content, metadata_json, created_at, message_type)
    VALUES
      (@id, @threadId, @windowId, @invocationId, @sequenceNo, @role,
       @agentId, @content, @metadataJson, @createdAt, @messageType)
    ON CONFLICT(id) DO UPDATE SET
      thread_id = excluded.thread_id,
      window_id = excluded.window_id,
      invocation_id = excluded.invocation_id,
      sequence_no = excluded.sequence_no,
      role = excluded.role,
      agent_id = excluded.agent_id,
      content = excluded.content,
      metadata_json = excluded.metadata_json,
      created_at = excluded.created_at,
      message_type = excluded.message_type
  `);
  const findById = db.prepare("SELECT * FROM messages WHERE id = ?");
  const listByThread = db.prepare(`
    SELECT * FROM messages WHERE thread_id = ? ORDER BY sequence_no ASC
  `);
  const appendTransaction = db.transaction((input) => {
    const id = requiredString(input.id, "message id");
    const threadId = requiredString(input.threadId, "thread id");
    const existing = findById.get(id);
    if (existing && input.sequenceNo === undefined) return mapMessage(existing);

    const sequenceNo =
      input.sequenceNo === undefined
        ? allocateSequence(allocateThreadSequence, threadId, "message")
        : nonNegativeInteger(input.sequenceNo, "message sequence");
    if (input.sequenceNo !== undefined) {
      assertThreadExists(advanceThreadSequence.run(sequenceNo + 1, threadId), "message", threadId);
    }
    const metadataJson = input.metadata === undefined ? null : JSON.stringify(input.metadata);
    const role = requiredString(input.role, "message role");
    insert.run({
      id,
      threadId,
      windowId: nullableString(input.windowId),
      invocationId: nullableString(input.invocationId),
      sequenceNo,
      role,
      agentId: nullableString(input.agentId),
      content: stringValue(input.content, "message content"),
      metadataJson,
      createdAt: input.createdAt || new Date().toISOString(),
      messageType: normalizeMessageType(input.messageType, role, input.metadata),
    });
    return mapMessage(findById.get(id));
  });

  return {
    append(input) {
      return appendTransaction(input);
    },

    get(id) {
      return mapMessage(findById.get(id));
    },

    listForThread(threadId) {
      return listByThread.all(threadId).map(mapMessage);
    },
  };
}

function mapMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    threadId: row.thread_id,
    windowId: row.window_id,
    invocationId: row.invocation_id,
    sequenceNo: row.sequence_no,
    role: row.role,
    messageType: row.message_type,
    agentId: row.agent_id,
    content: row.content,
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at,
  };
}

const MESSAGE_TYPES = new Set([
  "user",
  "assistant-final",
  "assistant-callback",
  "a2a-route",
  "a2a-skipped",
  "a2a-phase-rejected",
  "handoff-repair-needed",
  "memory-notice",
  "system-notice",
]);

function normalizeMessageType(value, role, metadata) {
  if (value !== undefined && value !== null) {
    if (typeof value !== "string" || !MESSAGE_TYPES.has(value)) {
      throw new Error(`Unsupported message type "${value}".`);
    }
    assertMessageTypeMatchesRole(value, role);
    return value;
  }
  if (role === "user") return "user";
  if (role === "assistant") {
    return metadata?.source === "callback" ? "assistant-callback" : "assistant-final";
  }
  if (role === "system" && MESSAGE_TYPES.has(metadata?.kind)) return metadata.kind;
  return "system-notice";
}

function assertMessageTypeMatchesRole(messageType, role) {
  const allowed =
    role === "user"
      ? new Set(["user"])
      : role === "assistant"
        ? new Set(["assistant-final", "assistant-callback"])
        : role === "system"
          ? new Set([
              "a2a-route",
              "a2a-skipped",
              "a2a-phase-rejected",
              "handoff-repair-needed",
              "memory-notice",
              "system-notice",
            ])
          : new Set();
  if (!allowed.has(messageType)) {
    throw new Error(`Message type "${messageType}" is not valid for role "${role}".`);
  }
}

function allocateSequence(statement, id, label) {
  const row = statement.get(id);
  if (!row) throw new Error(`${label} thread ${id} does not exist.`);
  return row.sequence_no;
}

function assertThreadExists(result, label, threadId) {
  if (result.changes === 0) throw new Error(`${label} thread ${threadId} does not exist.`);
}

function parseJson(value) {
  if (!value) return null;
  return JSON.parse(value);
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required.`);
  return value;
}

function stringValue(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  return value;
}

function nullableString(value) {
  return typeof value === "string" && value ? value : null;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

module.exports = { MESSAGE_TYPES, createMessageRepository };
