function projectTraceSpans(db, traceId) {
  const invocations = db
    .prepare(
      `SELECT i.*, w.generation FROM invocations i
       LEFT JOIN context_windows w ON w.id = i.window_id
       WHERE i.trace_id = ? ORDER BY i.started_at, i.id`
    )
    .all(traceId);
  const spans = [];
  const links = [];
  for (const invocation of invocations) {
    spans.push({
      spanId: `generation:${invocation.id}`,
      traceId,
      invocationId: invocation.id,
      parentSpanId: null,
      kind: "generation",
      name: `${invocation.agent_id} generation ${invocation.generation || "?"}`,
      state: invocation.state,
      startedAt: invocation.started_at,
      endedAt: invocation.ended_at,
      complete: invocation.state !== "active" && Boolean(invocation.ended_at),
      attributes: { agentId: invocation.agent_id, generation: invocation.generation || null },
    });
    const events = db
      .prepare("SELECT * FROM invocation_events WHERE invocation_id = ? ORDER BY sequence_no")
      .all(invocation.id);
    spans.push(...projectToolSpans(traceId, invocation, events));
    const recalls = db
      .prepare(
        `SELECT id, event_type, payload_json, created_at FROM memory_events
         WHERE invocation_id = ? AND event_type IN ('memory_searched', 'memory_injected')
         ORDER BY id`
      )
      .all(invocation.id);
    spans.push(
      ...recalls.map((row) => ({
        spanId: `recall:${row.id}`,
        traceId,
        invocationId: invocation.id,
        parentSpanId: `generation:${invocation.id}`,
        kind: "recall",
        name: row.event_type,
        state: "completed",
        startedAt: row.created_at,
        endedAt: row.created_at,
        complete: true,
        attributes: recallAttributes(parseJson(row.payload_json)),
      }))
    );
  }
  const handoffs = db.prepare("SELECT * FROM handoffs WHERE trace_id = ?").all(traceId);
  for (const row of handoffs) {
    if (!row.target_invocation_id) continue;
    links.push({
      linkId: `handoff:${row.id}`,
      kind: "handoff",
      sourceSpanId: `generation:${row.source_invocation_id}`,
      targetSpanId: `generation:${row.target_invocation_id}`,
      attributes: {
        handoffId: row.id,
        routeStatus: row.route_status,
        completeStatus: row.complete_status,
      },
    });
  }
  return { spans, links, complete: spans.every((span) => span.complete) };
}

function projectToolSpans(traceId, invocation, events) {
  const open = new Map();
  const result = [];
  for (const row of events) {
    const payload = parseJson(row.payload_json);
    const toolId = payload.toolId || payload.tool_id;
    if (!toolId) continue;
    if (row.kind === "tool.started") open.set(toolId, row);
    if (row.kind === "tool.finished") {
      const started = open.get(toolId);
      result.push(toolSpan(traceId, invocation.id, toolId, started, row, payload));
      open.delete(toolId);
    }
  }
  for (const [toolId, started] of open) {
    result.push(
      toolSpan(traceId, invocation.id, toolId, started, null, parseJson(started.payload_json))
    );
  }
  return result;
}

function toolSpan(traceId, invocationId, toolId, started, finished, payload) {
  return {
    spanId: `tool:${invocationId}:${toolId}`,
    traceId,
    invocationId,
    parentSpanId: `generation:${invocationId}`,
    kind: "tool",
    name: payload.toolName || payload.tool_name || "tool",
    state: finished ? (payload.status === "error" ? "failed" : "completed") : "active",
    startedAt: started?.created_at || finished?.created_at || null,
    endedAt: finished?.created_at || null,
    complete: Boolean(finished),
    attributes: { toolId, toolKind: payload.toolKind || null, status: payload.status || null },
  };
}

function recallAttributes(payload) {
  return {
    count: Number(payload?.count || payload?.items?.length || 0),
    availability: payload?.availability?.state || null,
    mode: payload?.stats?.mode || null,
  };
}

function parseJson(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

module.exports = { projectTraceSpans };
