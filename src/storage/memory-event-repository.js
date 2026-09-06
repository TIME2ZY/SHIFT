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
  "memory_write_completed",
  "decision_language_detected",
]);

function createMemoryEventRepository(db) {
  const insert = db.prepare(`
    INSERT INTO memory_events
      (event_type, thread_id, project_key, memory_id, invocation_id, agent_id,
       operation_key, payload_version, payload_json, created_at)
    VALUES
      (@eventType, @threadId, @projectKey, @memoryId, @invocationId, @agentId,
       @operationKey, @payloadVersion, @payloadJson, @createdAt)
    ON CONFLICT DO NOTHING
  `);
  const listByThread = db.prepare(`
    SELECT * FROM memory_events
    WHERE thread_id = ?
    ORDER BY id DESC
    LIMIT ?
  `);
  const listUsageByThread = db.prepare(`
    SELECT event_type, payload_json FROM memory_events
    WHERE thread_id = ? AND event_type IN ('memory_searched', 'memory_injected')
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
  const recordAttempt = db.prepare(`
    UPDATE telemetry_sink_health
    SET attempted = attempted + 1, last_attempt_at = @at
    WHERE sink = 'memory_events'
  `);
  const recordSuccess = db.prepare(`
    UPDATE telemetry_sink_health
    SET succeeded = succeeded + 1, last_success_at = @at, last_error = NULL
    WHERE sink = 'memory_events'
  `);
  const recordFailure = db.prepare(`
    UPDATE telemetry_sink_health
    SET failed = failed + 1, last_failure_at = @at, last_error = @error
    WHERE sink = 'memory_events'
  `);
  const insertFailure = db.prepare(`
    INSERT INTO telemetry_write_failures (sink, error, occurred_at)
    VALUES ('memory_events', @error, @at)
  `);
  const deleteExpired = db.prepare(`
    DELETE FROM memory_events WHERE id IN (
      SELECT id FROM memory_events WHERE created_at < @before ORDER BY id LIMIT @limit
    )
  `);
  const deleteExpiredFailures = db.prepare(`
    DELETE FROM telemetry_write_failures WHERE id IN (
      SELECT id FROM telemetry_write_failures WHERE occurred_at < @before ORDER BY id LIMIT @limit
    )
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
        operationKey: nullableString(input.operationKey),
        payloadVersion: positiveIntegerOrNull(input.payloadVersion),
        payloadJson: serializePayload(input.payload),
        createdAt,
      });
      return {
        duplicate: info.changes === 0,
        id: Number(info.lastInsertRowid),
        eventType,
        threadId: nullableString(input.threadId),
        projectKey: nullableString(input.projectKey),
        memoryId: nullableString(input.memoryId),
        invocationId: nullableString(input.invocationId),
        agentId: nullableString(input.agentId),
        operationKey: nullableString(input.operationKey),
        payloadVersion: positiveIntegerOrNull(input.payloadVersion),
        payload: input.payload && typeof input.payload === "object" ? input.payload : null,
        createdAt,
      };
    },

    /**
     * Best-effort record: never throws to callers (telemetry must not break paths).
     */
    recordSafe(input, logger = console) {
      const at = new Date().toISOString();
      try {
        recordAttempt.run({ at });
        const result = this.record(input);
        recordSuccess.run({ at });
        return result;
      } catch (error) {
        try {
          const serializedError = truncateError(error);
          db.transaction(() => {
            recordFailure.run({ at, error: serializedError });
            insertFailure.run({ at, error: serializedError });
          })();
        } catch {
          // The telemetry database itself may be unavailable; never mask the original failure.
        }
        logger.error?.(`[memory-events] record failed: ${error.message}`);
        return null;
      }
    },

    listForThread(threadId, options = {}) {
      if (!threadId) return [];
      return listByThread.all(threadId, normalizeLimit(options.limit, 100)).map(mapEvent);
    },

    /**
     * Aggregate per-memory usage evidence from search/inject telemetry.
     * memoryIds live in the event payload (one event covers many memories);
     * the memory_id column is only set for single-memory lifecycle rows.
     */
    usageForThread(threadId, options = {}) {
      if (!threadId) return {};
      const usage = {};
      for (const row of listUsageByThread.all(threadId, normalizeLimit(options.limit, 1000))) {
        const payload = parsePayload(row.payload_json);
        if (row.event_type === "memory_searched") {
          addUsageIds(usage, payload?.memoryIds, "searched");
          continue;
        }
        const deliveredIds = Array.isArray(payload?.deliveredIds)
          ? payload.deliveredIds
          : payload?.memoryIds;
        addUsageIds(usage, payload?.selectedIds, "selected");
        addUsageIds(usage, deliveredIds, "injected");
        addUsageIds(usage, payload?.droppedIds, "dropped");
      }
      return usage;
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

    cleanupExpired(options = {}) {
      const before = requiredDate(options.before);
      const limit = normalizeLimit(options.limit, 1000);
      return db.transaction(() => ({
        events: deleteExpired.run({ before, limit }).changes,
        failures: deleteExpiredFailures.run({ before, limit }).changes,
      }))();
    },
  };
}

function addUsageIds(usage, ids, field) {
  if (!Array.isArray(ids)) return;
  for (const memoryId of ids) {
    if (typeof memoryId !== "string" || !memoryId) continue;
    usage[memoryId] = usage[memoryId] || { searched: 0, injected: 0, selected: 0, dropped: 0 };
    usage[memoryId][field] += 1;
  }
}

function requiredDate(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) throw new Error("Retention cutoff is invalid.");
  return date.toISOString();
}

function truncateError(error) {
  return String(error?.message || error || "unknown telemetry failure").slice(0, 500);
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
    operationKey: row.operation_key,
    payloadVersion: row.payload_version,
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

function positiveIntegerOrNull(value) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error("payloadVersion must be positive.");
  return number;
}

module.exports = {
  EVENT_TYPES,
  createMemoryEventRepository,
};
