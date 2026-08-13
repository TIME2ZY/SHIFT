function evaluateObservabilitySnapshot(input = {}) {
  const traces = Array.isArray(input.traces) ? input.traces : [];
  const health = input.health?.storage?.observability || input.health?.observability || null;
  const expectedInvocationIds = new Set(input.expectedInvocationIds || []);
  const assertions = [];

  assertions.push(
    assertion("O1-TRACE-PRESENT", traces.length > 0, `${traces.length} durable trace(s)`)
  );
  const active = traces.filter((trace) => trace.state === "active");
  assertions.push(
    assertion(
      "O2-NO-ACTIVE",
      active.length === 0,
      active.length
        ? `active traces: ${active.map((trace) => trace.traceId).join(", ")}`
        : "all traces terminal"
    )
  );

  const invocations = traces.flatMap((trace) => trace.invocations || []);
  const durableIds = new Set(invocations.map((item) => item.invocationId));
  const missing = [...expectedInvocationIds].filter((id) => !durableIds.has(id));
  assertions.push(
    assertion(
      "O3-SSE-DURABLE-CAUSALITY",
      missing.length === 0,
      missing.length
        ? `missing invocation(s): ${missing.join(", ")}`
        : `${expectedInvocationIds.size} SSE invocation(s) found durably`
    )
  );

  const incompleteInvocations = invocations.filter(
    (item) =>
      item.state === "active" || (item.state !== "completed" && !item.outcome?.terminalReason)
  );
  assertions.push(
    assertion(
      "O4-INVOCATION-OUTCOME",
      incompleteInvocations.length === 0,
      incompleteInvocations.length
        ? `incomplete invocation outcome(s): ${incompleteInvocations.map((item) => item.invocationId).join(", ")}`
        : "terminal invocations expose outcomes"
    )
  );

  const acceptedHandoffs = traces
    .flatMap((trace) => trace.handoffs || [])
    .filter((item) => item.routeStatus === "accepted");
  const incompleteHandoffs = acceptedHandoffs.filter(
    (item) =>
      !item.targetInvocationId ||
      item.receiveStatus !== "started" ||
      item.completeStatus === "pending"
  );
  assertions.push(
    assertion(
      "O5-HANDOFF-DURABLE",
      !input.requireHandoff || (acceptedHandoffs.length > 0 && incompleteHandoffs.length === 0),
      !input.requireHandoff
        ? `handoff optional; accepted=${acceptedHandoffs.length}`
        : `accepted=${acceptedHandoffs.length} incomplete=${incompleteHandoffs.length}`
    )
  );

  assertions.push(
    assertion(
      "O6-HEALTH",
      health?.state === "available" && Number(health.authoritativeViolations || 0) === 0,
      health
        ? `state=${health.state} violations=${health.authoritativeViolations || 0}`
        : "observability health missing"
    )
  );

  return {
    passed: assertions.every((item) => item.ok),
    assertions,
    traceIds: traces.map((trace) => trace.traceId),
    invocationIds: [...durableIds],
    acceptedHandoffIds: acceptedHandoffs.map((item) => item.handoffId),
  };
}

function compareRestartSnapshots(before, after) {
  const beforeTraceIds = new Set(before?.traceIds || []);
  const afterTraceIds = new Set(after?.traceIds || []);
  const missingTraces = [...beforeTraceIds].filter((id) => !afterTraceIds.has(id));
  const beforeInvocationIds = new Set(before?.invocationIds || []);
  const afterInvocationIds = new Set(after?.invocationIds || []);
  const missingInvocations = [...beforeInvocationIds].filter((id) => !afterInvocationIds.has(id));
  const assertions = [
    assertion(
      "O7-RESTART-TRACES",
      missingTraces.length === 0,
      missingTraces.length
        ? `lost traces: ${missingTraces.join(", ")}`
        : `${beforeTraceIds.size} trace(s) restored`
    ),
    assertion(
      "O8-RESTART-INVOCATIONS",
      missingInvocations.length === 0,
      missingInvocations.length
        ? `lost invocations: ${missingInvocations.join(", ")}`
        : `${beforeInvocationIds.size} invocation(s) restored`
    ),
    assertion(
      "O9-RESTART-HEALTH",
      after?.passed === true,
      after?.passed
        ? "post-restart observability checks passed"
        : "post-restart observability checks failed"
    ),
  ];
  return { passed: assertions.every((item) => item.ok), assertions };
}

function assertion(id, ok, message) {
  return { id, ok: Boolean(ok), message };
}

module.exports = { evaluateObservabilitySnapshot, compareRestartSnapshots };
