const { projectTraceSpans } = require("./trace-span-projection");

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
  const findRequestByTurn = db.prepare(`
    SELECT m.id, m.content, m.created_at, m.sequence_no,
      (SELECT COUNT(DISTINCT COALESCE(prior.client_turn_id, prior.id))
       FROM messages prior
       WHERE prior.thread_id = m.thread_id AND prior.role = 'user'
         AND prior.sequence_no <= m.sequence_no) AS turn_number
    FROM messages m
    WHERE m.thread_id = @threadId AND m.role = 'user' AND m.client_turn_id = @clientTurnId
    ORDER BY m.sequence_no LIMIT 1
  `);
  const findRequestByTrigger = db.prepare(`
    SELECT m.id, m.content, m.created_at, m.sequence_no,
      (SELECT COUNT(DISTINCT COALESCE(prior.client_turn_id, prior.id))
       FROM messages prior
       WHERE prior.thread_id = m.thread_id AND prior.role = 'user'
         AND prior.sequence_no <= m.sequence_no) AS turn_number
    FROM messages m JOIN invocations i ON i.trigger_message_id = m.id
    WHERE i.id = @rootInvocationId AND m.thread_id = @threadId AND m.role = 'user'
    LIMIT 1
  `);
  const findAuditThread = db.prepare(`
    SELECT id, title, project_dir, project_key, last_agent_id, created_at, updated_at
    FROM threads WHERE id = ? AND deleted_at IS NULL
  `);
  const countAuditMessages = db.prepare(`
    SELECT COUNT(*) AS messages,
      COUNT(DISTINCT CASE WHEN role = 'user' THEN COALESCE(client_turn_id, id) END) AS user_turns
    FROM messages WHERE thread_id = ?
  `);
  const countAuditTraces = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN state = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN state = 'aborted' THEN 1 ELSE 0 END) AS aborted,
      SUM(CASE WHEN request_attempt > 1 THEN 1 ELSE 0 END) AS retries,
      SUM(CASE WHEN ended_at IS NOT NULL
        THEN MAX(0, CAST((julianday(ended_at) - julianday(started_at)) * 86400000 AS INTEGER))
        ELSE 0 END) AS duration_ms,
      MIN(started_at) AS first_started_at,
      MAX(COALESCE(ended_at, started_at)) AS last_activity_at
    FROM trace_runs WHERE thread_id = ?
  `);
  const latestAuditTrace = db.prepare(`
    SELECT id, state, terminal_reason, failure_stage, error_code, started_at, ended_at
    FROM trace_runs WHERE thread_id = ? ORDER BY started_at DESC, id DESC LIMIT 1
  `);
  const countAuditInvocations = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN state = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN state = 'aborted' THEN 1 ELSE 0 END) AS aborted
    FROM invocations WHERE thread_id = ?
  `);
  const countAuditHandoffs = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN route_status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
      MAX(depth) AS max_depth
    FROM handoffs WHERE thread_id = ?
  `);
  const listAuditAgents = db.prepare(`
    SELECT agent_id, MIN(started_at) AS first_started_at
    FROM invocations WHERE thread_id = ?
    GROUP BY agent_id ORDER BY first_started_at, agent_id
  `);
  const countAuditTools = db.prepare(`
    WITH tool_events AS (
      SELECT e.invocation_id,
        COALESCE(
          json_extract(e.payload_json, '$.toolId'),
          json_extract(e.payload_json, '$.tool_id')
        ) AS tool_id,
        e.kind,
        json_extract(e.payload_json, '$.status') AS status
      FROM invocation_events e JOIN invocations i ON i.id = e.invocation_id
      WHERE i.thread_id = ? AND e.kind IN ('tool.started', 'tool.finished')
    ), lifecycles AS (
      SELECT invocation_id, tool_id,
        SUM(CASE WHEN kind = 'tool.started' THEN 1 ELSE 0 END) AS starts,
        SUM(CASE WHEN kind = 'tool.finished' THEN 1 ELSE 0 END) AS finishes,
        MAX(CASE WHEN kind = 'tool.finished' AND status IN ('error', 'failed') THEN 1 ELSE 0 END)
          AS failed
      FROM tool_events WHERE tool_id IS NOT NULL
      GROUP BY invocation_id, tool_id
    )
    SELECT
      SUM(CASE WHEN starts > 0 THEN 1 ELSE 0 END) AS calls,
      SUM(CASE WHEN starts > 0 AND finishes > 0 AND failed = 0 THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN starts > 0 AND finishes > 0 AND failed = 1 THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN starts > 0 AND finishes = 0 THEN 1 ELSE 0 END) AS incomplete,
      SUM(CASE WHEN starts = 0 AND finishes > 0 THEN 1 ELSE 0 END) AS orphan_finishes
    FROM lifecycles
  `);
  const countAuditMemory = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM memory_events WHERE thread_id = @threadId
        AND event_type = 'memory_searched') AS searches,
      (SELECT COUNT(*) FROM memory_events WHERE thread_id = @threadId
        AND event_type = 'memory_injected') AS injections,
      (SELECT COUNT(*) FROM memory_events WHERE thread_id = @threadId
        AND event_type = 'memory_write_completed') AS writes,
      (SELECT COUNT(*) FROM memory_entries WHERE status = 'active'
        AND (owner_thread_id = @threadId OR origin_thread_id = @threadId)) AS active
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
      request: traceRequest(row),
      outcome: outcome(row),
      invocationCounts: numericCounts(countInvocations.get(row.id)),
      handoffCounts: numericCounts(countHandoffs.get(row.id)),
      invocations: invocationRows.map(invocationSummary),
      handoffs: handoffRows.map(handoffSummary),
    };
  }

  function traceRequest(row) {
    const params = {
      threadId: row.thread_id,
      clientTurnId: row.client_turn_id,
      rootInvocationId: row.root_invocation_id,
    };
    const request = row.client_turn_id
      ? findRequestByTurn.get(params)
      : row.root_invocation_id
        ? findRequestByTrigger.get(params)
        : null;
    if (!request) return null;
    return {
      messageId: request.id,
      turnNumber: Number(request.turn_number || 0),
      preview: previewText(request.content, 180),
      createdAt: request.created_at,
    };
  }

  return {
    auditSummary(threadId) {
      if (!threadId) return null;
      const thread = findAuditThread.get(threadId);
      if (!thread) return null;
      const messages = numericCounts(countAuditMessages.get(threadId));
      const traceRow = countAuditTraces.get(threadId) || {};
      const traces = numericCounts({
        total: traceRow.total,
        active: traceRow.active,
        completed: traceRow.completed,
        failed: traceRow.failed,
        aborted: traceRow.aborted,
        retries: traceRow.retries,
        duration_ms: traceRow.duration_ms,
      });
      const invocations = numericCounts(countAuditInvocations.get(threadId));
      const handoffs = numericCounts(countAuditHandoffs.get(threadId));
      const toolRows = numericCounts(countAuditTools.get(threadId));
      const latest = latestAuditTrace.get(threadId);
      return {
        session: {
          id: thread.id,
          title: thread.title,
          projectKey: thread.project_key,
          projectDir: thread.project_dir,
          createdAt: thread.created_at,
          updatedAt: thread.updated_at,
        },
        volume: {
          userTurns: messages.user_turns,
          messages: messages.messages,
          traces: traces.total,
          invocations: invocations.total,
        },
        execution: {
          traces: stateCounts(traces),
          invocations: stateCounts(invocations),
          retries: traces.retries,
          terminalDurationMs: traces.duration_ms,
          firstStartedAt: traceRow.first_started_at || null,
          lastActivityAt: traceRow.last_activity_at || thread.updated_at,
          latestTrace: latest
            ? {
                traceId: latest.id,
                state: latest.state,
                terminalReason: latest.terminal_reason,
                failureStage: latest.failure_stage,
                errorCode: latest.error_code,
                startedAt: latest.started_at,
                endedAt: latest.ended_at,
              }
            : null,
        },
        collaboration: {
          agentIds: listAuditAgents.all(threadId).map((row) => row.agent_id),
          handoffs: handoffs.total,
          acceptedHandoffs: handoffs.accepted,
          maxHandoffDepth: handoffs.max_depth,
        },
        tools: {
          calls: toolRows.calls,
          completed: toolRows.completed,
          failed: toolRows.failed,
          incomplete: toolRows.incomplete,
          orphanFinishes: toolRows.orphan_finishes,
        },
        memory: numericCounts(countAuditMemory.get({ threadId })),
      };
    },
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
      return { ...traceSummary(trace), invocations, handoffs, ...projectTraceSpans(db, traceId) };
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
          request: detail.request
            ? {
                messageId: detail.request.messageId,
                turnNumber: detail.request.turnNumber,
                createdAt: detail.request.createdAt,
              }
            : null,
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

function stateCounts(row) {
  return {
    active: Number(row.active || 0),
    completed: Number(row.completed || 0),
    failed: Number(row.failed || 0),
    aborted: Number(row.aborted || 0),
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

function previewText(value, max) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function optionalDate(value, name) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Trace ${name} is invalid.`);
  return date.toISOString();
}

function boundedInteger(value, fallback, min, max) {
  if (value == null || value === "") return fallback;
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
