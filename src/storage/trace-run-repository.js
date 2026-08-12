const crypto = require("node:crypto");

const TRACE_STATES = new Set(["active", "completed", "failed", "aborted"]);

function createTraceRunRepository(db) {
  const insert = db.prepare(`
    INSERT INTO trace_runs (
      id, thread_id, client_turn_id, request_attempt, state, started_at,
      terminal_reason, failure_stage, error_code, retryable, metadata_json
    ) VALUES (
      @id, @threadId, @clientTurnId, @requestAttempt, 'active', @startedAt,
      NULL, NULL, NULL, NULL, @metadataJson
    )
  `);
  const findById = db.prepare("SELECT * FROM trace_runs WHERE id = ?");
  const nextAttempt = db.prepare(`
    SELECT COALESCE(MAX(request_attempt), 0) + 1 AS attempt
    FROM trace_runs
    WHERE thread_id = ?
      AND ((client_turn_id = ?) OR (client_turn_id IS NULL AND ? IS NULL))
  `);
  const bindRoot = db.prepare(`
    UPDATE trace_runs
    SET root_invocation_id = COALESCE(root_invocation_id, @invocationId)
    WHERE id = @traceId
      AND state = 'active'
      AND EXISTS (
        SELECT 1 FROM invocations i
        WHERE i.id = @invocationId AND i.trace_id = @traceId
      )
  `);
  const finish = db.prepare(`
    UPDATE trace_runs
    SET state = @state,
        ended_at = @endedAt,
        terminal_reason = @terminalReason,
        failure_stage = @failureStage,
        error_code = @errorCode,
        retryable = @retryable
    WHERE id = @id AND state = 'active'
  `);
  const countActiveInvocations = db.prepare(`
    SELECT COUNT(*) AS count
    FROM invocations
    WHERE trace_id = ? AND state = 'active'
  `);
  const countPendingHandoffs = db.prepare(`
    SELECT COUNT(*) AS count FROM handoffs
    WHERE trace_id = ? AND complete_status = 'pending'
  `);
  const findDurableSuccess = db.prepare(`
    SELECT i.id
    FROM trace_runs t
    JOIN invocations i ON i.trace_id = t.id
    JOIN messages m ON m.invocation_id = i.id AND m.message_type = 'assistant-final'
    WHERE t.id = ?
      AND t.root_invocation_id IS NOT NULL
      AND i.state = 'completed'
    LIMIT 1
  `);

  const startTransaction = db.transaction((input) => {
    const requestAttempt = Number.isInteger(input.requestAttempt)
      ? positiveInteger(input.requestAttempt, "request attempt")
      : Number(nextAttempt.get(input.threadId, input.clientTurnId, input.clientTurnId).attempt);
    insert.run({ ...input, requestAttempt });
    return mapTrace(findById.get(input.id));
  });

  return {
    start(input = {}) {
      const threadId = requiredString(input.threadId, "thread id");
      const clientTurnId = nullableString(input.clientTurnId);
      const id = nullableString(input.id) || `trace_${crypto.randomUUID().replace(/-/g, "")}`;
      return startTransaction({
        id,
        threadId,
        clientTurnId,
        requestAttempt: input.requestAttempt,
        startedAt: input.startedAt || new Date().toISOString(),
        metadataJson: serializeMetadata(input.metadata),
      });
    },

    get(id) {
      return mapTrace(findById.get(id));
    },

    bindRootInvocation(traceId, invocationId) {
      if (!traceId || !invocationId) return null;
      bindRoot.run({ traceId, invocationId });
      return this.get(traceId);
    },

    finish(id, outcome = {}) {
      const state = requiredTraceState(outcome.state);
      if (state === "active") throw new Error("Trace finish requires a terminal state.");
      const active = Number(countActiveInvocations.get(id).count) || 0;
      if (active > 0) {
        throw new Error(`Trace ${id} cannot finish with ${active} active invocation(s).`);
      }
      const pendingHandoffs = Number(countPendingHandoffs.get(id).count) || 0;
      if (pendingHandoffs > 0) {
        throw new Error(`Trace ${id} cannot finish with ${pendingHandoffs} pending handoff(s).`);
      }
      if (state === "completed") {
        if (!findDurableSuccess.get(id)) {
          throw new Error(`Trace ${id} cannot complete without a successful invocation.`);
        }
      }
      const changed = finish.run({
        id: requiredString(id, "trace id"),
        state,
        endedAt: outcome.endedAt || new Date().toISOString(),
        terminalReason: nullableString(outcome.terminalReason),
        failureStage: nullableString(outcome.failureStage),
        errorCode: nullableString(outcome.errorCode),
        retryable:
          outcome.retryable === undefined || outcome.retryable === null
            ? null
            : outcome.retryable
              ? 1
              : 0,
      }).changes;
      return changed > 0 ? this.get(id) : null;
    },
  };
}

function mapTrace(row) {
  if (!row) return null;
  return {
    id: row.id,
    threadId: row.thread_id,
    clientTurnId: row.client_turn_id,
    requestAttempt: row.request_attempt,
    state: row.state,
    rootInvocationId: row.root_invocation_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    terminalReason: row.terminal_reason,
    failureStage: row.failure_stage,
    errorCode: row.error_code,
    retryable: row.retryable === null ? null : row.retryable === 1,
    metadata: parseMetadata(row.metadata_json),
  };
}

function requiredTraceState(value) {
  const state = String(value || "");
  if (!TRACE_STATES.has(state)) throw new Error(`Unsupported trace state: ${value}`);
  return state;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required.`);
  return value;
}

function nullableString(value) {
  return typeof value === "string" && value ? value : null;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be positive.`);
  return value;
}

function serializeMetadata(value) {
  return value && typeof value === "object" ? JSON.stringify(value) : null;
}

function parseMetadata(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

module.exports = { TRACE_STATES, createTraceRunRepository };
