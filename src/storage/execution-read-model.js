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
  };
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
