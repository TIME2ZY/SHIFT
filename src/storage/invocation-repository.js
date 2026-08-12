const { withTransaction } = require("./database");
const {
  fromDbInvocationState,
  isTerminalInvocationState,
  toDbInvocationState,
} = require("../shared/collab-contracts");

function createInvocationRepository(db) {
  const insertInvocation = db.prepare(`
    INSERT INTO invocations
      (id, thread_id, window_id, agent_id, state, started_at,
       parent_invocation_id, trigger_message_id, trigger_type, trace_id)
    VALUES
      (@id, @threadId, @windowId, @agentId, 'active', @startedAt,
       @parentInvocationId, @triggerMessageId, @triggerType, @traceId)
  `);
  const findById = db.prepare("SELECT * FROM invocations WHERE id = ?");
  const findMessageOwner = db.prepare("SELECT thread_id FROM messages WHERE id = ?");
  const listByThread = db.prepare(`
    SELECT * FROM invocations WHERE thread_id = ? ORDER BY started_at ASC
  `);
  const listActiveByThread = db.prepare(`
    SELECT * FROM invocations
    WHERE thread_id = ? AND state = 'active'
    ORDER BY started_at ASC
  `);
  const listActive = db.prepare(`
    SELECT * FROM invocations WHERE state = 'active' ORDER BY started_at ASC
  `);
  const allocateEventSequence = db.prepare(`
    UPDATE invocations
    SET next_event_sequence = next_event_sequence + 1
    WHERE id = ?
    RETURNING next_event_sequence - 1 AS sequence_no
  `);
  const advanceEventSequence = db.prepare(`
    UPDATE invocations
    SET next_event_sequence = MAX(next_event_sequence, ?)
    WHERE id = ?
  `);
  const insertEvent = db.prepare(`
    INSERT INTO invocation_events
      (invocation_id, sequence_no, kind, payload_json, created_at)
    VALUES
      (@invocationId, @sequenceNo, @kind, @payloadJson, @createdAt)
  `);
  const findEvent = db.prepare(`
    SELECT * FROM invocation_events
    WHERE invocation_id = ? AND sequence_no = ?
  `);
  const listEvents = db.prepare(`
    SELECT * FROM invocation_events
    WHERE invocation_id = ?
    ORDER BY sequence_no ASC
  `);
  const countEvents = db.prepare(
    "SELECT COUNT(*) AS count FROM invocation_events WHERE invocation_id = ?"
  );
  const readEventsPage = db.prepare(`
    SELECT * FROM invocation_events
    WHERE invocation_id = ?
    ORDER BY sequence_no ASC
    LIMIT ? OFFSET ?
  `);
  const listWithMeta = db.prepare(`
    SELECT i.*, COUNT(e.id) AS event_count
    FROM invocations i
    LEFT JOIN invocation_events e ON e.invocation_id = i.id
    WHERE i.thread_id = ?
    GROUP BY i.id
    ORDER BY i.started_at ASC
  `);
  const finalize = db.prepare(`
    UPDATE invocations
    SET state = @state,
        exit_code = @exitCode,
        signal = @signal,
        ended_at = @endedAt,
        terminal_reason = @terminalReason,
        failure_stage = @failureStage,
        error_code = @errorCode,
        retryable = @retryable
    WHERE id = @id AND state = 'active'
  `);
  const appendEventTransaction = db.transaction((input) => {
    const invocationId = requiredString(input.invocationId, "invocation id");
    const sequenceNo =
      input.sequenceNo === undefined
        ? allocateSequence(allocateEventSequence, invocationId)
        : nonNegativeInteger(input.sequenceNo, "event sequence");
    if (input.sequenceNo !== undefined) {
      assertInvocationExists(advanceEventSequence.run(sequenceNo + 1, invocationId), invocationId);
    }
    insertEvent.run({
      invocationId,
      sequenceNo,
      kind: requiredString(input.kind, "event kind"),
      payloadJson: JSON.stringify(input.payload || {}),
      createdAt: input.createdAt || new Date().toISOString(),
    });
    return mapEvent(findEvent.get(invocationId, sequenceNo));
  });

  return {
    start(input) {
      const threadId = requiredString(input.threadId, "thread id");
      const parentInvocationId = nullableString(input.parentInvocationId);
      const triggerMessageId = nullableString(input.triggerMessageId);
      const traceId = nullableString(input.traceId);
      assertCausalOwner(findById, parentInvocationId, threadId, "parent invocation");
      assertCausalOwner(findMessageOwner, triggerMessageId, threadId, "trigger message");
      assertCausalOwner(
        db.prepare("SELECT thread_id FROM trace_runs WHERE id = ?"),
        traceId,
        threadId,
        "trace"
      );
      insertInvocation.run({
        id: requiredString(input.id, "invocation id"),
        threadId,
        windowId: requiredString(input.windowId, "window id"),
        agentId: requiredString(input.agentId, "agent id"),
        startedAt: input.startedAt || new Date().toISOString(),
        parentInvocationId,
        triggerMessageId,
        triggerType: normalizeTriggerType(input.triggerType),
        traceId,
      });
      return this.get(input.id);
    },

    get(id) {
      return mapInvocation(findById.get(id));
    },

    listForThread(threadId) {
      return listByThread.all(threadId).map(mapInvocation);
    },

    /** Open (DB state=active) invocations for a thread — candidates for orphan reconcile. */
    listActiveForThread(threadId) {
      return listActiveByThread.all(threadId).map(mapInvocation);
    },

    listActive() {
      return listActive.all().map(mapInvocation);
    },

    listForThreadWithMeta(threadId) {
      return listWithMeta.all(threadId).map((row) => ({
        ...mapInvocation(row),
        eventCount: row.event_count,
      }));
    },

    appendEvent(input) {
      return appendEventTransaction(input);
    },

    getEvent(invocationId, sequenceNo) {
      if (!invocationId || !Number.isInteger(sequenceNo) || sequenceNo < 0) return null;
      const row = findEvent.get(invocationId, sequenceNo);
      return row ? mapEvent(row) : null;
    },

    listEvents(invocationId) {
      return listEvents.all(invocationId).map(mapEvent);
    },

    readEventsPage(invocationId, { from = 0, limit = 200 } = {}) {
      const start = Math.max(0, Number(from) || 0);
      const size = Math.max(1, Math.min(Number(limit) || 200, 2000));
      return {
        events: readEventsPage.all(invocationId, size, start).map(mapEvent),
        total: countEvents.get(invocationId).count,
        from: start,
        limit: size,
      };
    },

    finish(id, outcome) {
      const state = normalizeTerminalState(outcome.state);
      return withTransaction(db, () => {
        const changed = finalize.run({
          id,
          state,
          exitCode: Number.isInteger(outcome.exitCode) ? outcome.exitCode : null,
          signal: nullableString(outcome.signal),
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
        return changed > 0 ? mapInvocation(findById.get(id)) : null;
      });
    },
  };
}

function mapInvocation(row) {
  if (!row) return null;
  const state = row.state;
  let canonicalState;
  try {
    canonicalState = fromDbInvocationState(state);
  } catch {
    canonicalState = state;
  }
  return {
    id: row.id,
    threadId: row.thread_id,
    windowId: row.window_id,
    agentId: row.agent_id,
    state,
    /** Canonical lifecycle state (collab-contracts); DB may still say active/aborted. */
    canonicalState,
    isTerminal: isTerminalInvocationState(canonicalState) || isTerminalInvocationState(state),
    isOpen: state === "active" || !row.ended_at,
    exitCode: row.exit_code,
    signal: row.signal,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    parentInvocationId: row.parent_invocation_id,
    triggerMessageId: row.trigger_message_id,
    triggerType: row.trigger_type,
    traceId: row.trace_id,
    terminalReason: row.terminal_reason,
    failureStage: row.failure_stage,
    errorCode: row.error_code,
    retryable: row.retryable === null || row.retryable === undefined ? null : row.retryable === 1,
    nextEventSequence: row.next_event_sequence,
  };
}

function mapEvent(row) {
  return {
    id: row.id,
    invocationId: row.invocation_id,
    sequenceNo: row.sequence_no,
    kind: row.kind,
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at,
  };
}

/**
 * Accept DB terminal states or canonical (cancelled→aborted, sealed→completed).
 */
function normalizeTerminalState(state) {
  const raw = String(state || "");
  if (["completed", "failed", "aborted"].includes(raw)) return raw;
  try {
    const dbState = toDbInvocationState(raw);
    if (["completed", "failed", "aborted"].includes(dbState)) return dbState;
  } catch {
    // fall through
  }
  throw new Error("Invocation terminal state must be completed, failed, or aborted.");
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required.`);
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

const TRIGGER_TYPES = new Set([
  "user-message",
  "a2a-handoff",
  "callback",
  "retry",
  "window-rotation",
]);

function normalizeTriggerType(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !TRIGGER_TYPES.has(value)) {
    throw new Error(`Unsupported invocation trigger type "${value}".`);
  }
  return value;
}

function assertCausalOwner(statement, id, threadId, label) {
  if (!id) return;
  const owner = statement.get(id);
  if (!owner) throw new Error(`${label} ${id} does not exist.`);
  const ownerThreadId = owner.thread_id || owner.threadId;
  if (ownerThreadId !== threadId) {
    throw new Error(`${label} ${id} belongs to another thread.`);
  }
}

function allocateSequence(statement, invocationId) {
  const row = statement.get(invocationId);
  if (!row) throw new Error(`invocation ${invocationId} does not exist.`);
  return row.sequence_no;
}

function assertInvocationExists(result, invocationId) {
  if (result.changes === 0) throw new Error(`invocation ${invocationId} does not exist.`);
}

module.exports = { TRIGGER_TYPES, createInvocationRepository };
