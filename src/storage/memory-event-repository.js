/**
 * Durable memory lifecycle telemetry (PR-1).
 * Events prove system actions; they do not prove the agent "used" a memory.
 */

const EVENT_TYPES = Object.freeze([
  "memory_written",
  "memory_injected",
  "memory_searched",
  "memory_opened",
  "memory_superseded",
  "decision_language_detected",
]);

function createMemoryEventRepository(db) {
  const insert = db.prepare(`
    INSERT INTO memory_events
      (event_type, thread_id, project_key, memory_id, invocation_id, agent_id, payload_json, created_at)
    VALUES
      (@eventType, @threadId, @projectKey, @memoryId, @invocationId, @agentId, @payloadJson, @createdAt)
  `);
  const listByThread = db.prepare(`
    SELECT * FROM memory_events
    WHERE thread_id = ?
    ORDER BY id DESC
    LIMIT ?
  `);
  const listByType = db.prepare(`
    SELECT * FROM memory_events
    WHERE event_type = ?
    ORDER BY id DESC
    LIMIT ?
  `);
  const countByTypeForThread = db.prepare(`
    SELECT event_type, COUNT(*) AS count
    FROM memory_events
    WHERE thread_id = ?
    GROUP BY event_type
  `);

  return {
    record(input = {}) {
      const eventType = requiredEventType(input.eventType || input.type);
      const createdAt = input.createdAt || new Date().toISOString();
      const info = insert.run({
        eventType,
        threadId: nullableString(input.threadId),
        projectKey: nullableString(input.projectKey),
        memoryId: nullableString(input.memoryId),
        invocationId: nullableString(input.invocationId),
        agentId: nullableString(input.agentId),
        payloadJson: serializePayload(input.payload),
        createdAt,
      });
      return {
        id: Number(info.lastInsertRowid),
        eventType,
        threadId: nullableString(input.threadId),
        projectKey: nullableString(input.projectKey),
        memoryId: nullableString(input.memoryId),
        invocationId: nullableString(input.invocationId),
        agentId: nullableString(input.agentId),
        payload: input.payload && typeof input.payload === "object" ? input.payload : null,
        createdAt,
      };
    },

    /**
     * Best-effort record: never throws to callers (telemetry must not break paths).
     */
    recordSafe(input, logger = console) {
      try {
        return this.record(input);
      } catch (error) {
        logger.error?.(`[memory-events] record failed: ${error.message}`);
        return null;
      }
    },

    listForThread(threadId, options = {}) {
      if (!threadId) return [];
      return listByThread.all(threadId, normalizeLimit(options.limit, 100)).map(mapEvent);
    },

    listByType(eventType, options = {}) {
      return listByType.all(eventType, normalizeLimit(options.limit, 100)).map(mapEvent);
    },

    countsForThread(threadId) {
      if (!threadId) return {};
      const out = {};
      for (const row of countByTypeForThread.all(threadId)) {
        out[row.event_type] = Number(row.count) || 0;
      }
      return out;
    },
  };
}

function mapEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventType: row.event_type,
    threadId: row.thread_id,
    projectKey: row.project_key,
    memoryId: row.memory_id,
    invocationId: row.invocation_id,
    agentId: row.agent_id,
    payload: parsePayload(row.payload_json),
    createdAt: row.created_at,
  };
}

function requiredEventType(value) {
  if (!EVENT_TYPES.includes(value)) {
    throw new Error(`Unknown memory event type: ${value}`);
  }
  return value;
}

function serializePayload(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function parsePayload(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeLimit(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.min(Math.floor(number), 1000));
}

function nullableString(value) {
  return typeof value === "string" && value ? value : null;
}

module.exports = {
  EVENT_TYPES,
  createMemoryEventRepository,
};
