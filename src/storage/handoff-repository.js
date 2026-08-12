const crypto = require("node:crypto");

function createHandoffRepository(db) {
  const findById = db.prepare("SELECT * FROM handoffs WHERE id = ?");
  const findByTarget = db.prepare("SELECT * FROM handoffs WHERE target_invocation_id = ?");
  const findAcceptedFlight = db.prepare(`
    SELECT * FROM handoffs
    WHERE source_invocation_id = ? AND target_agent_id = ? AND route_status = 'accepted'
    LIMIT 1
  `);
  const findCompletedContent = db.prepare(`
    SELECT * FROM handoffs
    WHERE thread_id = ? AND target_agent_id = ? AND content_hash = ?
      AND route_status = 'accepted' AND complete_status = 'completed'
    ORDER BY completed_at DESC LIMIT 1
  `);
  const findInvocation = db.prepare(
    "SELECT id, thread_id, trace_id, agent_id, state FROM invocations WHERE id = ?"
  );
  const insert = db.prepare(`
    INSERT INTO handoffs (
      id, thread_id, trace_id, source_invocation_id, source_agent_id, target_agent_id,
      parse_status, route_status, receive_status, complete_status, reason, depth,
      content_hash, duplicate_of, repair_of, phase_id, policy, source,
      created_at, enqueued_at, completed_at, terminal_reason, failure_stage,
      error_code, retryable, metadata_json
    ) VALUES (
      @id, @threadId, @traceId, @sourceInvocationId, @sourceAgentId, @targetAgentId,
      @parseStatus, @routeStatus, @receiveStatus, @completeStatus, @reason, @depth,
      @contentHash, @duplicateOf, @repairOf, @phaseId, @policy, @source,
      @createdAt, @enqueuedAt, @completedAt, @terminalReason, @failureStage,
      @errorCode, @retryable, @metadataJson
    )
  `);
  const bindTarget = db.prepare(`
    UPDATE handoffs SET target_invocation_id = @targetInvocationId,
      receive_status = 'started', started_at = @startedAt
    WHERE id = @id AND route_status = 'accepted' AND receive_status = 'pending'
      AND complete_status = 'pending' AND target_invocation_id IS NULL
  `);
  const markEnqueued = db.prepare(`
    UPDATE handoffs SET enqueued_at = @enqueuedAt
    WHERE id = @id AND route_status = 'accepted' AND enqueued_at IS NULL
      AND receive_status = 'pending' AND complete_status = 'pending'
  `);
  const finishTarget = db.prepare(`
    UPDATE handoffs SET complete_status = @completeStatus, completed_at = @completedAt,
      terminal_reason = @terminalReason, failure_stage = @failureStage,
      error_code = @errorCode, retryable = @retryable
    WHERE target_invocation_id = @targetInvocationId AND complete_status = 'pending'
  `);
  const reconcilePending = db.prepare(`
    UPDATE handoffs SET
      receive_status = CASE WHEN target_invocation_id IS NULL THEN 'not_started' ELSE receive_status END,
      complete_status = 'failed', completed_at = @completedAt,
      terminal_reason = 'restart-reconcile', failure_stage = 'reconcile',
       error_code = CASE
         WHEN enqueued_at IS NULL THEN 'handoff_target_not_enqueued'
         WHEN target_invocation_id IS NULL THEN 'handoff_target_not_started'
         ELSE 'handoff_target_not_terminal'
       END,
      retryable = 1
    WHERE complete_status = 'pending'
  `);
  const reconcileTracePending = db.prepare(`
    UPDATE handoffs SET
      receive_status = CASE WHEN target_invocation_id IS NULL THEN 'not_started' ELSE receive_status END,
      complete_status = 'failed', completed_at = @completedAt,
      terminal_reason = 'request-reconcile', failure_stage = 'reconcile',
       error_code = CASE
         WHEN enqueued_at IS NULL THEN 'handoff_target_not_enqueued'
         WHEN target_invocation_id IS NULL THEN 'handoff_target_not_started'
         ELSE 'handoff_target_not_terminal'
       END,
      retryable = 1
    WHERE trace_id = @traceId AND complete_status = 'pending'
  `);
  const listByTrace = db.prepare(
    "SELECT * FROM handoffs WHERE trace_id = ? ORDER BY created_at, id"
  );

  const acceptTransaction = db.transaction((input) => {
    const source = findInvocation.get(
      requiredString(input.sourceInvocationId, "source invocation id")
    );
    if (!source) throw new Error("Source invocation does not exist.");
    if (!source.trace_id) throw new Error("Source invocation must belong to a Trace.");
    if (input.threadId && input.threadId !== source.thread_id) {
      throw new Error("Source invocation belongs to another thread.");
    }
    let prior = findCompletedContent.get(source.thread_id, input.targetAgentId, input.contentHash);
    let routeStatus = "accepted";
    if (prior) routeStatus = "already_completed";
    if (!prior) {
      prior = findAcceptedFlight.get(source.id, input.targetAgentId);
      if (prior)
        routeStatus = prior.complete_status === "completed" ? "already_completed" : "duplicate";
    }
    const id = input.id || `handoff_${crypto.randomUUID().replace(/-/g, "")}`;
    const accepted = routeStatus === "accepted";
    const repairOf = input.repairOf ? findById.get(input.repairOf) : null;
    if (input.repairOf && (!repairOf || repairOf.thread_id !== source.thread_id)) {
      throw new Error("repair_of must reference a Handoff on the same Thread.");
    }
    insert.run({
      id,
      threadId: source.thread_id,
      traceId: source.trace_id,
      sourceInvocationId: source.id,
      sourceAgentId: input.sourceAgentId || source.agent_id,
      targetAgentId: requiredString(input.targetAgentId, "target agent id"),
      parseStatus: input.parseStatus || "parsed",
      routeStatus,
      receiveStatus: accepted ? "pending" : "not_started",
      completeStatus: accepted ? "pending" : "failed",
      reason: input.reason || "a2a-route",
      depth: Math.max(0, Number(input.depth) || 0),
      contentHash: requiredString(input.contentHash, "content hash"),
      duplicateOf: prior?.id || null,
      repairOf: repairOf?.id || null,
      phaseId: input.phaseId || null,
      policy: input.policy || null,
      source: input.source || "chat",
      createdAt: input.createdAt || new Date().toISOString(),
      enqueuedAt: null,
      completedAt: accepted ? null : input.createdAt || new Date().toISOString(),
      terminalReason: accepted ? null : routeStatus,
      failureStage: accepted ? null : "handoff_route",
      errorCode: accepted ? null : `handoff_${routeStatus}`,
      retryable: accepted ? null : 0,
      metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
    });
    return { accepted, status: routeStatus, record: mapHandoff(findById.get(id)) };
  });

  return {
    accept(input = {}) {
      return acceptTransaction(input);
    },
    get(id) {
      return mapHandoff(findById.get(id));
    },
    getByTargetInvocation(id) {
      return mapHandoff(findByTarget.get(id));
    },
    listForTrace(traceId) {
      return listByTrace.all(traceId).map(mapHandoff);
    },
    markEnqueued(id, enqueuedAt = new Date().toISOString()) {
      const changed = markEnqueued.run({
        id: requiredString(id, "handoff id"),
        enqueuedAt,
      }).changes;
      const handoff = mapHandoff(findById.get(id));
      if (!handoff || (!changed && !handoff.enqueuedAt)) return null;
      return handoff;
    },
    bindTargetInvocation(id, targetInvocationId, startedAt) {
      const handoff = findById.get(id);
      const target = findInvocation.get(targetInvocationId);
      if (!handoff || !target) return null;
      if (handoff.thread_id !== target.thread_id || handoff.trace_id !== target.trace_id) {
        throw new Error("Handoff target invocation must belong to the same Thread and Trace.");
      }
      if (handoff.target_agent_id !== target.agent_id) {
        throw new Error("Handoff target invocation agent does not match.");
      }
      bindTarget.run({ id, targetInvocationId, startedAt: startedAt || new Date().toISOString() });
      return mapHandoff(findById.get(id));
    },
    completeByTargetInvocation(targetInvocationId, outcome = {}) {
      const completeStatus =
        outcome.state === "completed"
          ? "completed"
          : outcome.state === "aborted"
            ? "aborted"
            : "failed";
      finishTarget.run({
        targetInvocationId,
        completeStatus,
        completedAt: outcome.endedAt || new Date().toISOString(),
        terminalReason: outcome.terminalReason || "target-terminal",
        failureStage:
          completeStatus === "completed" ? null : outcome.failureStage || "handoff_target",
        errorCode:
          completeStatus === "completed" ? null : outcome.errorCode || "handoff_target_failed",
        retryable: completeStatus === "completed" ? null : outcome.retryable === true ? 1 : 0,
      });
      return mapHandoff(findByTarget.get(targetInvocationId));
    },
    reconcilePending(at = new Date().toISOString()) {
      return reconcilePending.run({ completedAt: at }).changes;
    },
    reconcileTracePending(traceId, at = new Date().toISOString()) {
      return reconcileTracePending.run({ traceId, completedAt: at }).changes;
    },
  };
}

function mapHandoff(row) {
  if (!row) return null;
  return {
    handoffId: row.id,
    id: row.id,
    threadId: row.thread_id,
    traceId: row.trace_id,
    sourceInvocationId: row.source_invocation_id,
    sourceAgent: row.source_agent_id,
    targetAgent: row.target_agent_id,
    targetInvocationId: row.target_invocation_id,
    parseStatus: row.parse_status,
    routeStatus: row.route_status,
    receiveStatus: row.receive_status,
    completeStatus: row.complete_status,
    reason: row.reason,
    depth: row.depth,
    contentHash: row.content_hash,
    duplicateOf: row.duplicate_of,
    repairOf: row.repair_of,
    phaseId: row.phase_id,
    policy: row.policy,
    source: row.source,
    createdAt: row.created_at,
    enqueuedAt: row.enqueued_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    terminalReason: row.terminal_reason,
    failureStage: row.failure_stage,
    errorCode: row.error_code,
    retryable: row.retryable == null ? null : row.retryable === 1,
  };
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required.`);
  return value;
}

module.exports = { createHandoffRepository };
