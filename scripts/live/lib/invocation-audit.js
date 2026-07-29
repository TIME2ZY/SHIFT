/**
 * Audit invocation lifecycle integrity inside one or more SSE turns.
 *
 * A completed live turn must not hide a started invocation that never emitted
 * agent-exit. Keep this independent from HTTP status and assistant text.
 */

function auditInvocationLifecycle(agentStarts = [], agentExits = []) {
  const startsById = groupByInvocationId(agentStarts);
  const exitsById = groupByInvocationId(agentExits);
  const invocationIds = new Set([...startsById.keys(), ...exitsById.keys()]);
  const invocations = [];
  const violations = [];

  for (const invocationId of invocationIds) {
    const starts = startsById.get(invocationId) || [];
    const exits = exitsById.get(invocationId) || [];
    const start = starts[0] || null;
    const exit = exits[0] || null;
    const itemViolations = [];

    if (starts.length === 0) itemViolations.push("exit-without-start");
    if (starts.length > 1) itemViolations.push("duplicate-start");
    if (exits.length === 0) itemViolations.push("missing-agent-exit");
    if (exits.length > 1) itemViolations.push("duplicate-agent-exit");
    if (start?.agent && exit?.agent && start.agent !== exit.agent) {
      itemViolations.push("agent-mismatch");
    }

    for (const code of itemViolations) {
      violations.push({ invocationId, code });
    }
    invocations.push({
      invocationId,
      agent: start?.agent || exit?.agent || "",
      started: starts.length === 1,
      exited: exits.length === 1,
      exitCode: exit?.code ?? null,
      signal: exit?.signal ?? null,
      closed: itemViolations.length === 0,
      violations: itemViolations,
    });
  }

  return {
    invocations,
    violations,
    started: agentStarts.length,
    exited: agentExits.length,
    closed: invocations.filter((item) => item.closed).length,
    orphanInvocationIds: invocations
      .filter((item) => item.started && !item.exited)
      .map((item) => item.invocationId),
    lifecycleClosed: violations.length === 0,
  };
}

function aggregateInvocationAudits(turns = []) {
  const violations = [];
  const orphanInvocationIds = [];
  let started = 0;
  let exited = 0;
  let closed = 0;

  for (const turn of turns) {
    const audit =
      turn.invocationAudit ||
      auditInvocationLifecycle(turn.agentStarts || [], turn.agentExits || []);
    started += audit.started;
    exited += audit.exited;
    closed += audit.closed;
    for (const violation of audit.violations || []) {
      violations.push({ turnId: turn.turnId || "", ...violation });
    }
    orphanInvocationIds.push(...(audit.orphanInvocationIds || []));
  }

  return {
    started,
    exited,
    closed,
    violations,
    orphanInvocationIds: [...new Set(orphanInvocationIds)],
    lifecycleClosed: violations.length === 0,
  };
}

function groupByInvocationId(items) {
  const grouped = new Map();
  for (const item of items || []) {
    const invocationId = String(item?.invocationId || "");
    if (!invocationId) {
      const missing = grouped.get("") || [];
      missing.push(item || {});
      grouped.set("", missing);
      continue;
    }
    const bucket = grouped.get(invocationId) || [];
    bucket.push(item);
    grouped.set(invocationId, bucket);
  }
  return grouped;
}

module.exports = {
  auditInvocationLifecycle,
  aggregateInvocationAudits,
};
