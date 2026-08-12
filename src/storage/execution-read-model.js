function createExecutionReadModel(db) {
  const listTraces = db.prepare(
    "SELECT * FROM trace_runs WHERE thread_id = ? ORDER BY started_at DESC, id DESC"
  );
  const findTrace = db.prepare("SELECT * FROM trace_runs WHERE id = ? AND thread_id = ?");
  const listInvocations = db.prepare(
    "SELECT * FROM invocations WHERE trace_id = ? ORDER BY started_at, id"
  );
  const listHandoffs = db.prepare(
    "SELECT * FROM handoffs WHERE trace_id = ? ORDER BY created_at, id"
  );
  const listInvocationEvents = db.prepare(`
    SELECT kind, payload_json, created_at, sequence_no
    FROM invocation_events WHERE invocation_id = ? ORDER BY sequence_no
  `);
  const countInvocations = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END) AS active
    FROM invocations WHERE trace_id = ?
  `);
  const countHandoffs = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN route_status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN complete_status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN complete_status = 'pending' THEN 1 ELSE 0 END) AS pending
    FROM handoffs WHERE trace_id = ?
  `);

  function traceSummary(row) {
    const invocationRows = listInvocations.all(row.id);
    const handoffRows = listHandoffs.all(row.id);
    return {
      traceId: row.id,
      threadId: row.thread_id,
      clientTurnId: row.client_turn_id,
      requestAttempt: row.request_attempt,
      state: row.state,
      rootInvocationId: row.root_invocation_id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      outcome: outcome(row),
      invocationCounts: numericCounts(countInvocations.get(row.id)),
      handoffCounts: numericCounts(countHandoffs.get(row.id)),
      invocations: invocationRows.map(invocationSummary),
      handoffs: handoffRows.map(handoffSummary),
    };
  }

  return {
    listForThread(threadId) {
      return threadId ? listTraces.all(threadId).map(traceSummary) : [];
    },
    searchForThread(threadId, options = {}) {
      if (!threadId) return { traces: [], page: { offset: 0, limit: 20, total: 0 } };
      const filters = normalizeSearchOptions(options);
      const where = ["t.thread_id = @threadId"];
      if (filters.state) where.push("t.state = @state");
      if (filters.agentId) {
        where.push(
          "EXISTS (SELECT 1 FROM invocations i WHERE i.trace_id = t.id AND i.agent_id = @agentId)"
        );
      }
      if (filters.from) where.push("t.started_at >= @from");
      if (filters.to) where.push("t.started_at < @to");
      if (filters.failuresOnly) {
        where.push(
          "(t.state = 'failed' OR t.error_code IS NOT NULL OR EXISTS (SELECT 1 FROM invocations i WHERE i.trace_id = t.id AND i.state = 'failed'))"
        );
      }
      if (filters.query) {
        where.push(`(
          t.id LIKE @query OR t.error_code LIKE @query OR t.failure_stage LIKE @query
          OR t.terminal_reason LIKE @query
          OR EXISTS (SELECT 1 FROM invocations i WHERE i.trace_id = t.id
            AND (i.agent_id LIKE @query OR i.error_code LIKE @query))
        )`);
      }
      const params = { threadId, ...filters, query: `%${filters.query}%` };
      const clause = where.join(" AND ");
      const total = Number(
        db.prepare(`SELECT COUNT(*) AS count FROM trace_runs t WHERE ${clause}`).get(params)
          ?.count || 0
      );
      const rows = db
        .prepare(
          `SELECT t.* FROM trace_runs t WHERE ${clause}
           ORDER BY t.started_at DESC, t.id DESC LIMIT @limit OFFSET @offset`
        )
        .all(params);
      return {
        traces: rows.map(traceSummary),
        page: { offset: filters.offset, limit: filters.limit, total },
      };
    },
    inspect(threadId, traceId) {
      if (!threadId || !traceId) return null;
      const trace = findTrace.get(traceId, threadId);
      if (!trace) return null;
      const invocations = listInvocations.all(traceId).map((row) => ({
        ...invocationSummary(row),
        events: listInvocationEvents.all(row.id).map((event) => ({
          kind: event.kind,
          payload: parseJson(event.payload_json),
          createdAt: event.created_at,
          sequenceNo: event.sequence_no,
        })),
      }));
      const handoffs = listHandoffs.all(traceId).map(handoffSummary);
      return { ...traceSummary(trace), invocations, handoffs };
    },
    export(threadId, traceId) {
      const detail = this.inspect(threadId, traceId);
      if (!detail) return null;
      return {
        format: "shift-trace-export",
        version: 1,
        capturePolicy: "structural-metadata-v1",
        exportedAt: new Date().toISOString(),
        trace: {
          ...detail,
          invocations: detail.invocations.map((invocation) => ({
            ...invocation,
            events: invocation.events.map((event) => ({
              kind: event.kind,
              createdAt: event.createdAt,
              sequenceNo: event.sequenceNo,
              payload: structuralPayload(event.payload),
            })),
          })),
        },
      };
    },
  };
}

function normalizeSearchOptions(options) {
  const state = options.state || null;
  if (state && !["active", "completed", "failed", "aborted"].includes(state)) {
    throw new Error("Trace state is invalid.");
  }
  return {
    state,
    agentId: cleanString(options.agentId, 80),
    query: cleanString(options.query, 120),
    from: optionalDate(options.from, "from"),
    to: optionalDate(options.to, "to"),
    failuresOnly: options.failuresOnly === true || options.failuresOnly === "1",
    limit: boundedInteger(options.limit, 20, 1, 100),
    offset: boundedInteger(options.offset, 0, 0, 100_000),
  };
}

function structuralPayload(payload) {
  if (!payload || typeof payload !== "object") return {};
  const allowed = [
    "state",
    "status",
    "code",
    "signal",
    "reason",
    "failureStage",
    "terminalReason",
    "retryable",
    "toolKind",
  ];
  return Object.fromEntries(
    allowed.filter((key) => payload[key] != null).map((key) => [key, payload[key]])
  );
}

function cleanString(value, max) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function optionalDate(value, name) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Trace ${name} is invalid.`);
  return date.toISOString();
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(min, Math.min(number, max)) : fallback;
}

function invocationSummary(row) {
  return {
    invocationId: row.id,
    traceId: row.trace_id,
    agentId: row.agent_id,
    state: row.state,
    parentInvocationId: row.parent_invocation_id,
    triggerMessageId: row.trigger_message_id,
    triggerType: row.trigger_type,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    exitCode: row.exit_code,
    signal: row.signal,
    outcome: outcome(row),
  };
}

function handoffSummary(row) {
  return {
    handoffId: row.id,
    sourceInvocationId: row.source_invocation_id,
    targetInvocationId: row.target_invocation_id,
    sourceAgent: row.source_agent_id,
    targetAgent: row.target_agent_id,
    parseStatus: row.parse_status,
    routeStatus: row.route_status,
    receiveStatus: row.receive_status,
    completeStatus: row.complete_status,
    reason: row.reason,
    depth: row.depth,
    duplicateOf: row.duplicate_of,
    repairOf: row.repair_of,
    phaseId: row.phase_id,
    policy: row.policy,
    createdAt: row.created_at,
    enqueuedAt: row.enqueued_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    outcome: outcome(row),
  };
}

function outcome(row) {
  return {
    terminalReason: row.terminal_reason || null,
    failureStage: row.failure_stage || null,
    errorCode: row.error_code || null,
    retryable: row.retryable == null ? null : row.retryable === 1,
  };
}

function numericCounts(row = {}) {
  return Object.fromEntries(
    Object.entries(row || {}).map(([key, value]) => [key, Number(value || 0)])
  );
}

function parseJson(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

module.exports = { createExecutionReadModel };
