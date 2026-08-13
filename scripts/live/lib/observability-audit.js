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

function localizeFailure(trace = {}) {
  const invocations = Array.isArray(trace.invocations) ? trace.invocations : [];
  const handoffs = Array.isArray(trace.handoffs) ? trace.handoffs : [];
  const spans = Array.isArray(trace.spans) ? trace.spans : [];
  const incompleteSpan = spans.find((span) => span.complete === false);
  if (incompleteSpan) {
    return location(
      "span_missing_end",
      incompleteSpan.kind,
      incompleteSpan.invocationId,
      incompleteSpan.spanId
    );
  }
  const handoff = handoffs.find(
    (item) =>
      item.routeStatus === "accepted" &&
      (item.receiveStatus !== "started" || ["failed", "aborted"].includes(item.completeStatus))
  );
  if (handoff) {
    const code =
      handoff.outcome?.errorCode ||
      (handoff.receiveStatus !== "started" ? "handoff_not_started" : "handoff_target_failed");
    return location(
      code,
      "handoff",
      handoff.targetInvocationId || handoff.sourceInvocationId,
      handoff.handoffId
    );
  }
  const invocation = [...invocations].reverse().find((item) => item.state !== "completed");
  if (invocation) {
    return location(
      invocation.outcome?.errorCode || `invocation_${invocation.state}`,
      invocation.outcome?.failureStage || "invocation",
      invocation.invocationId,
      trace.traceId
    );
  }
  if (trace.state && trace.state !== "completed") {
    return location(
      trace.outcome?.errorCode || `trace_${trace.state}`,
      trace.outcome?.failureStage || "request",
      trace.rootInvocationId || null,
      trace.traceId
    );
  }
  return null;
}

function evaluatePhase3Release(input = {}) {
  const metrics = input.metrics?.metrics || input.metrics || null;
  const health = input.health?.storage || input.health || null;
  const exporter = health?.observabilityExporter || null;
  const requests = Array.isArray(input.exportRequests) ? input.exportRequests : [];
  const comparison = metrics?.comparison;
  const snapshot = requests.at(-1)?.json?.snapshot || null;
  const serialized = JSON.stringify(snapshot || {});
  const assertions = [
    assertion(
      "P3-TREND-CONTRACT",
      Array.isArray(comparison?.indicators) && comparison.indicators.length === 2,
      comparison
        ? `${comparison.indicators?.length || 0} comparison indicator(s)`
        : "comparison missing"
    ),
    assertion(
      "P3-ALERT-CONTRACT",
      Array.isArray(health?.observability?.alerts),
      health?.observability
        ? `${health.observability.alerts?.length || 0} active alert(s)`
        : "alerts missing"
    ),
    assertion(
      "P3-EXPORTER-ENABLED",
      exporter?.enabled === true,
      exporter ? `state=${exporter.state}` : "exporter health missing"
    ),
    assertion(
      "P3-EXPORT-DELIVERED",
      requests.length > 0 && snapshot?.schema === "shift-observability-snapshot-v1",
      `${requests.length} receiver request(s)`
    ),
    assertion(
      "P3-EXPORT-REDACTED",
      !/(traceId|threadId|invocationId|memoryId|prompt|response|query|toolOutput|environment)/i.test(
        serialized
      ),
      "snapshot contains structural aggregates only"
    ),
  ];
  return { passed: assertions.every((item) => item.ok), assertions };
}

function location(errorCode, failureStage, invocationId, coordinateId) {
  return {
    errorCode,
    failureStage,
    invocationId: invocationId || null,
    coordinateId: coordinateId || null,
  };
}

function assertion(id, ok, message) {
  return { id, ok: Boolean(ok), message };
}

module.exports = {
  evaluateObservabilitySnapshot,
  compareRestartSnapshots,
  localizeFailure,
  evaluatePhase3Release,
};
