/**
 * Repair tool spans left open when the SHIFT process died mid-run.
 *
 * `tool.started` events are only ever closed by the in-process worklist
 * (toolLifecycle.closeOpenTools) or by the provider itself. When the process
 * is killed while a tool is running, the invocation is force-terminated on the
 * next reconcile — and since forceTerminalInvocation now closes dangling spans
 * in the same transaction, this repair only exists for databases written by
 * older builds. On a current build it reports zero candidates.
 *
 * The appended events are synthetic tool.finished rows, marked
 * `syntheticTerminal: true` so audits can tell a reconciled finish from a
 * provider-reported one. The payload mirrors the in-process closure path, so
 * trace-span projection and the UI render them identically.
 */

const { createDurableRecorder } = require("../durable-recorder");

const TOOL_SPAN_QUERY = `
  SELECT i.id AS invocation_id, i.agent_id, i.state, i.thread_id, i.trace_id,
         i.started_at, i.ended_at,
         e.sequence_no, e.kind, e.payload_json, e.created_at
  FROM invocations i
  LEFT JOIN invocation_events e
    ON e.invocation_id = i.id AND e.kind IN ('tool.started', 'tool.finished')
  WHERE i.state <> 'active'
  ORDER BY i.started_at ASC, i.id ASC, e.sequence_no ASC
`;

function parsePayload(value) {
  try {
    const parsed = value ? JSON.parse(value) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toolIdOf(payload) {
  return payload.toolId || payload.tool_id || null;
}

/**
 * Terminal invocations that still carry an unpaired tool.started — the rows
 * behind the `span_missing_end` health alert.
 *
 * @returns {Array<{invocationId, agentId, state, threadId, traceId, endedAt, tools}>}
 */
function listDanglingToolSpans(storage) {
  if (!storage) return [];
  const db = storage.db || storage;
  if (typeof db.prepare !== "function") return [];

  const rows = db.prepare(TOOL_SPAN_QUERY).all();
  const byInvocation = new Map();
  for (const row of rows) {
    let entry = byInvocation.get(row.invocation_id);
    if (!entry) {
      entry = {
        invocationId: row.invocation_id,
        agentId: row.agent_id,
        state: row.state,
        threadId: row.thread_id,
        traceId: row.trace_id,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        open: new Map(),
      };
      byInvocation.set(row.invocation_id, entry);
    }
    if (!row.kind) continue;
    const payload = parsePayload(row.payload_json);
    const toolId = toolIdOf(payload);
    if (!toolId) continue;
    if (row.kind === "tool.started") {
      entry.open.set(toolId, { toolId, toolName: payload.toolName, startedAt: row.created_at });
    } else if (row.kind === "tool.finished") {
      entry.open.delete(toolId);
    }
  }

  const candidates = [];
  for (const entry of byInvocation.values()) {
    if (entry.open.size === 0) continue;
    candidates.push({
      invocationId: entry.invocationId,
      agentId: entry.agentId,
      state: entry.state,
      threadId: entry.threadId,
      traceId: entry.traceId,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      tools: [...entry.open.values()],
    });
  }
  return candidates;
}

/**
 * Append a synthetic tool.finished for every dangling span.
 *
 * @param {{storage, dryRun?: boolean, logger?: object}} input
 * @returns {{ok: boolean, dryRun: boolean, candidateCount: number, repaired: Array, candidates: Array}}
 */
function repairDanglingToolSpans({ storage, dryRun = true, logger = console } = {}) {
  if (!storage) throw new Error("SQLite storage is required.");

  const candidates = listDanglingToolSpans(storage);
  if (candidates.length === 0 || dryRun) {
    return {
      ok: true,
      dryRun: candidates.length > 0 || dryRun,
      candidateCount: candidates.length,
      repaired: [],
      candidates,
    };
  }

  const durable = createDurableRecorder({ storage, logger });
  const repaired = [];
  try {
    for (const candidate of candidates) {
      const record = storage.invocations.get(candidate.invocationId);
      if (!record) continue;
      const closed = durable.closeDanglingToolSpans(candidate.invocationId, record, {
        cancelled: candidate.state === "aborted",
        endedAt: candidate.endedAt || undefined,
        error: "SHIFT process ended while the tool was still running.",
      });
      if (closed > 0) {
        repaired.push({ invocationId: candidate.invocationId, closed });
      }
    }
  } finally {
    durable.close();
  }

  const remaining = listDanglingToolSpans(storage);
  return {
    ok: remaining.length === 0,
    dryRun: false,
    candidateCount: candidates.length,
    repaired,
    candidates,
    remaining: remaining.length,
  };
}

module.exports = { listDanglingToolSpans, repairDanglingToolSpans, TOOL_SPAN_QUERY };
