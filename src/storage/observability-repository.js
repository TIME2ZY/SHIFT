const SAMPLE_CLASSES = Object.freeze(["eligible", "pending", "censored", "unknown", "excluded"]);
const { projectTraceSpans } = require("./trace-span-projection");

function createObservabilityRepository(db, dependencies = {}) {
  const scalar = (sql, params = {}) => Number(db.prepare(sql).get(params)?.count || 0);

  return {
    inspectTrace(traceId) {
      if (!traceId) return null;
      const trace = db.prepare("SELECT * FROM trace_runs WHERE id = ?").get(traceId);
      if (!trace) return null;
      const invocations = db
        .prepare(
          `
          SELECT i.*, EXISTS (
            SELECT 1 FROM invocation_events e
            WHERE e.invocation_id = i.id AND e.kind = 'invocation-end'
          ) AS has_end_event
          FROM invocations i WHERE i.trace_id = ? ORDER BY i.started_at, i.id
        `
        )
        .all(traceId);
      const handoffs = db
        .prepare("SELECT * FROM handoffs WHERE trace_id = ? ORDER BY created_at, id")
        .all(traceId);
      return {
        traceId,
        threadId: trace.thread_id,
        state: trace.state,
        complete: traceCompleteness(trace, invocations, handoffs),
        invocationCount: invocations.length,
        handoffCount: handoffs.length,
      };
    },

    health(options = {}) {
      const now = validDate(options.now) || new Date();
      const outboxPendingAlertSeconds = positiveNumber(options.outboxPendingAlertSeconds, 300);
      const traceContractAppliedAt = db
        .prepare("SELECT applied_at FROM schema_migrations WHERE version = 24")
        .get()?.applied_at;
      const oldestPending = db
        .prepare("SELECT MIN(created_at) AS value FROM storage_outbox WHERE status = 'pending'")
        .get()?.value;
      const checks = {
        missing_trace_id: scalar(
          `SELECT COUNT(*) AS count FROM invocations
           WHERE trace_id IS NULL AND started_at >= @traceContractAppliedAt`,
          { traceContractAppliedAt }
        ),
        terminal_invocation_missing_end_event: scalar(`
          SELECT COUNT(*) AS count FROM invocations i
          WHERE i.state <> 'active' AND NOT EXISTS (
            SELECT 1 FROM invocation_events e
            WHERE e.invocation_id = i.id AND e.kind = 'invocation-end'
          )
        `),
        handoff_missing_target: scalar(`
          SELECT COUNT(*) AS count FROM handoffs
          WHERE route_status = 'accepted' AND complete_status <> 'pending'
            AND target_invocation_id IS NULL
        `),
        terminal_target_with_pending_handoff: scalar(`
          SELECT COUNT(*) AS count FROM handoffs h
          JOIN invocations i ON i.id = h.target_invocation_id
          WHERE i.state <> 'active' AND h.complete_status = 'pending'
        `),
        terminal_trace_with_active_invocation: scalar(`
          SELECT COUNT(*) AS count FROM trace_runs t
          WHERE t.state <> 'active' AND EXISTS (
            SELECT 1 FROM invocations i WHERE i.trace_id = t.id AND i.state = 'active'
          )
        `),
      };
      const spanMissingEnd = db
        .prepare("SELECT id FROM trace_runs WHERE state <> 'active' AND started_at >= @cutoff")
        .all({ cutoff: traceContractAppliedAt })
        .reduce(
          (sum, row) =>
            sum + projectTraceSpans(db, row.id).spans.filter((span) => !span.complete).length,
          0
        );
      const authoritativeViolations = Object.values(checks).reduce((sum, value) => sum + value, 0);
      const telemetry = telemetryHealth(db);
      const outboxPendingAge = ageSeconds(oldestPending, now);
      const alerts = [];
      if (authoritativeViolations > 0) {
        alerts.push(
          diagnosticAlert({
            code: "authoritative_completeness_violation",
            severity: "error",
            count: authoritativeViolations,
          })
        );
      }
      if (telemetry.unresolvedFailures > 0) {
        alerts.push(
          diagnosticAlert({
            code: "telemetry_write_failure",
            severity: "warning",
            count: telemetry.unresolvedFailures,
            lastOccurredAt: telemetry.lastFailureAt,
          })
        );
      }
      if (spanMissingEnd > 0) {
        alerts.push(
          diagnosticAlert({ code: "span_missing_end", severity: "warning", count: spanMissingEnd })
        );
      }
      if (outboxPendingAge != null && outboxPendingAge > outboxPendingAlertSeconds) {
        alerts.push(
          diagnosticAlert({
            code: "outbox_pending_age",
            severity: "warning",
            value: outboxPendingAge,
            threshold: outboxPendingAlertSeconds,
          })
        );
      }
      return {
        state: alerts.length > 0 ? "degraded" : "available",
        checkedAt: now.toISOString(),
        authoritativeViolations,
        applicability: { traceContractAppliedAt },
        historical: {
          invocation_missing_trace_before_contract: scalar(
            `SELECT COUNT(*) AS count FROM invocations
             WHERE trace_id IS NULL AND started_at < @traceContractAppliedAt`,
            { traceContractAppliedAt }
          ),
        },
        alerts,
        telemetry,
        checks: {
          ...checks,
          span_missing_end: spanMissingEnd,
          telemetry_write_failure: telemetry.unresolvedFailures,
          metric_projection_lag: 0,
          outbox_pending_age: outboxPendingAge,
        },
        capabilities: {
          span_missing_end: "derived_from_canonical_events",
          telemetry_write_failure: "durable_sink_attempt_counters",
          metric_projection_lag: "live_sql_zero_lag",
        },
      };
    },

    metrics(options = {}) {
      const window = metricWindow(options);
      const current = metricsForWindow(db, dependencies, window);
      const baselineWindow = previousWindow(window);
      const baseline = metricsForWindow(db, dependencies, baselineWindow);
      return {
        ...current,
        comparison: compareMetrics(current, baseline, {
          minSamples: positiveNumber(options.regressionMinSamples, 5),
          dropThreshold: positiveRatio(options.regressionDropThreshold, 0.1),
        }),
      };
    },
  };
}

const ALERT_DIAGNOSTICS = Object.freeze({
  authoritative_completeness_violation: {
    title: "权威执行链不完整",
    action: "打开失败 Trace，核对 Invocation 终态、Handoff target 与 invocation-end。",
  },
  telemetry_write_failure: {
    title: "Memory 遥测写入失败",
    action: "检查 telemetry 最后错误；业务事实仍有效，但相关 Memory 指标不完整。",
  },
  span_missing_end: {
    title: "执行区段缺少结束事件",
    action: "按 Trace 的 incomplete span 定位 tool 或 generation，并核对 Provider 终止路径。",
  },
  outbox_pending_age: {
    title: "审计 Outbox 积压",
    action: "检查审计 sink 与 outbox flusher；不得删除仍为 pending 的事件。",
  },
});

function diagnosticAlert(alert) {
  const diagnostic = ALERT_DIAGNOSTICS[alert.code] || {
    title: alert.code,
    action: "按告警代码检查对应的持久化事实。",
  };
  return { ...alert, diagnostic };
}

function metricsForWindow(db, dependencies, window) {
  const handoffs = db
    .prepare(
      `
          SELECT * FROM handoffs
          WHERE created_at >= @from AND created_at < @to
          ORDER BY created_at, id
        `
    )
    .all(window);
  const memoryContractAppliedAt = db
    .prepare("SELECT applied_at FROM schema_migrations WHERE version = 29")
    .get()?.applied_at;
  const memoryEvents = db
    .prepare(
      `
          SELECT event_type, payload_json FROM memory_events
          WHERE event_type IN ('memory_searched', 'memory_injected', 'memory_write_completed')
            AND payload_version = 1
            AND operation_key IS NOT NULL
            AND invocation_id IS NOT NULL
            AND agent_id IS NOT NULL
            AND created_at >= @from AND created_at < @to
          ORDER BY id
        `
    )
    .all(window);
  return {
    window,
    handoff: handoffMetrics(handoffs),
    memory: memoryMetrics(
      memoryEvents,
      telemetryHealth(db, window),
      dependencies.evidence?.latestRecallEval?.() || null,
      dependencies.evidence?.judgmentMetrics?.(window) || null,
      memoryMetricApplicability(db, memoryContractAppliedAt)
    ),
  };
}

function previousWindow(window) {
  const from = new Date(window.from);
  const duration = new Date(window.to).getTime() - from.getTime();
  return { from: new Date(from.getTime() - duration).toISOString(), to: window.from };
}

function compareMetrics(current, baseline, options) {
  const definitions = [
    ["handoff.endToEnd", current.handoff.endToEnd, baseline.handoff.endToEnd],
    ["memory.searchHitRate", current.memory.search.memoryHitRate, baseline.memory.search.memoryHitRate],
  ];
  return {
    baselineWindow: baseline.window,
    minSamples: options.minSamples,
    dropThreshold: options.dropThreshold,
    indicators: definitions.map(([metric, value, prior]) =>
      compareRate(metric, value, prior, options)
    ),
  };
}

function compareRate(metric, current, baseline, options) {
  const eligible =
    current.denominator >= options.minSamples &&
    baseline.denominator >= options.minSamples &&
    current.value != null &&
    baseline.value != null;
  const delta = eligible ? current.value - baseline.value : null;
  return {
    metric,
    state: !eligible ? "unknown" : delta <= -options.dropThreshold ? "regressed" : "stable",
    delta,
    current: {
      value: current.value,
      numerator: current.numerator,
      denominator: current.denominator,
    },
    baseline: {
      value: baseline.value,
      numerator: baseline.numerator,
      denominator: baseline.denominator,
    },
  };
}

function traceCompleteness(trace, invocations, handoffs) {
  const issues = [];
  if (trace.state !== "active" && !trace.ended_at) issues.push("terminal_trace_missing_ended_at");
  if (trace.state === "completed" && !trace.root_invocation_id)
    issues.push("completed_trace_missing_root");
  if (trace.state !== "active" && invocations.some((row) => row.state === "active")) {
    issues.push("terminal_trace_with_active_invocation");
  }
  if (invocations.some((row) => row.state !== "active" && row.has_end_event !== 1)) {
    issues.push("terminal_invocation_missing_end_event");
  }
  if (trace.state !== "active" && handoffs.some((row) => row.complete_status === "pending")) {
    issues.push("terminal_trace_with_pending_handoff");
  }
  if (
    handoffs.some(
      (row) =>
        row.route_status === "accepted" &&
        row.complete_status !== "pending" &&
        !row.target_invocation_id
    )
  ) {
    issues.push("handoff_missing_target");
  }
  return { ok: issues.length === 0, issues };
}

function handoffMetrics(rows) {
  const classified = rows.map(classifyHandoff);
  const counts = countClasses(classified);
  const eligible = rows.filter((_, index) => classified[index] === "eligible");
  const acceptedEligible = eligible.filter((row) => row.route_status === "accepted");
  return {
    scheduling: rateResult(
      acceptedEligible.filter((row) => row.receive_status === "started").length,
      acceptedEligible.length,
      counts
    ),
    execution: rateResult(
      acceptedEligible.filter((row) => row.complete_status === "completed").length,
      acceptedEligible.length,
      counts
    ),
    endToEnd: rateResult(
      acceptedEligible.filter(
        (row) => row.receive_status === "started" && row.complete_status === "completed"
      ).length,
      acceptedEligible.length,
      counts
    ),
    semantics: {
      scheduling: "accepted Handoffs whose target Invocation durably started",
      execution: "eligible accepted Handoffs whose target completed",
      endToEnd: "eligible accepted Handoffs with target started and completed",
      businessOutcome: null,
    },
  };
}

function classifyHandoff(row) {
  if (["duplicate", "already_completed", "rejected"].includes(row.route_status)) return "excluded";
  if (row.complete_status === "pending") return "pending";
  if (row.complete_status === "aborted") return "censored";
  if (row.route_status !== "accepted" || !row.completed_at) return "unknown";
  if (
    row.complete_status === "completed" &&
    (!row.target_invocation_id || row.receive_status !== "started")
  ) {
    return "unknown";
  }
  return "eligible";
}

function memoryMetrics(rows, telemetry, strictRecallAtK, judgments, applicability) {
  const searchRows = rows.filter((row) => row.event_type === "memory_searched");
  const injectionRows = rows.filter((row) => row.event_type === "memory_injected");
  const writeRows = rows.filter((row) => row.event_type === "memory_write_completed");
  return {
    search: memorySearchMetrics(searchRows),
    injection: memoryInjectionMetrics(injectionRows),
    write: memoryWriteMetrics(writeRows),
    strictRecallAtK,
    usedRate: judgments?.usedRate || null,
    correctRate: judgments?.correctRate || null,
    businessSuccessRate: judgments?.businessSuccessRate || null,
    completeness: telemetry.failed > 0 ? "incomplete" : "best_effort",
    telemetry,
    applicability,
    semantics: "MCP search, delivered injection, and MCP write results are separate online metrics",
  };
}

function memorySearchMetrics(rows) {
  const parsed = rows.map((row) => parseJson(row.payload_json));
  const availability = availabilityCounts(parsed);
  const attempted = parsed.length;
  const available = parsed.filter((payload) => payload?.availability?.state === "available");
  const memoryEligible = available.filter((payload) =>
    Array.isArray(payload.requestedLayers) && payload.requestedLayers.includes("memory")
  );
  const knownAttempts = attempted - availability.unknown;
  const unavailableAttempts = availability.degraded + availability.unavailable;
  const availableWithoutMemory = available.length - memoryEligible.length;
  return {
    availabilityRate: simpleRate(availability.available, knownAttempts, {
      unknown: availability.unknown,
    }),
    memoryHitRate: simpleRate(
      memoryEligible.filter((payload) => Number(payload.memoryHits) > 0).length,
      memoryEligible.length,
      { unknown: unavailableAttempts + availability.unknown, excluded: availableWithoutMemory }
    ),
    totalResultRate: simpleRate(
      available.filter((payload) => Number(payload.totalHits) > 0).length,
      available.length,
      { unknown: unavailableAttempts + availability.unknown }
    ),
    averageMemoryHits:
      memoryEligible.length > 0
        ? memoryEligible.reduce((sum, payload) => sum + Number(payload.memoryHits || 0), 0) /
          memoryEligible.length
        : null,
    availability,
  };
}

function memoryInjectionMetrics(rows) {
  const parsed = rows.map((row) => parseJson(row.payload_json));
  const availability = availabilityCounts(parsed);
  const attempted = parsed.length;
  const available = parsed.filter((payload) => payload?.availability?.state === "available");
  const delivered = available.reduce((sum, payload) => sum + Number(payload.delivered || 0), 0);
  const selected = available.reduce((sum, payload) => sum + Number(payload.selected || 0), 0);
  const budgetDropped = available.reduce(
    (sum, payload) => sum + Math.max(0, Number(payload.selected || 0) - Number(payload.delivered || 0)),
    0
  );
  const knownAttempts = attempted - availability.unknown;
  const unavailableAttempts = availability.degraded + availability.unavailable;
  return {
    availabilityRate: simpleRate(availability.available, knownAttempts, {
      unknown: availability.unknown,
    }),
    coverageRate: simpleRate(
      available.filter((payload) => Number(payload.delivered) > 0).length,
      available.length,
      { unknown: unavailableAttempts + availability.unknown }
    ),
    averageDelivered: available.length > 0 ? delivered / available.length : null,
    budgetDropRate: simpleRate(budgetDropped, selected, 0),
    truncationRate: simpleRate(
      available.filter((payload) => payload.truncated === true).length,
      available.length,
      attempted - available.length
    ),
    availability,
  };
}

function memoryWriteMetrics(rows) {
  const counts = { calls: rows.length, created: 0, unchanged: 0, superseded: 0, rejected: 0 };
  for (const row of rows) {
    const outcome = parseJson(row.payload_json)?.outcome;
    if (Object.hasOwn(counts, outcome)) counts[outcome] += 1;
  }
  return counts;
}

function availabilityCounts(payloads) {
  const counts = { available: 0, degraded: 0, unavailable: 0, unknown: 0 };
  for (const payload of payloads) {
    const state = payload?.availability?.state;
    if (state === "available" || state === "degraded" || state === "unavailable") counts[state] += 1;
    else counts.unknown += 1;
  }
  return counts;
}

function simpleRate(numerator, denominator, classification = {}) {
  return {
    value: denominator > 0 ? numerator / denominator : null,
    numerator,
    denominator,
    pending: 0,
    censored: 0,
    unknown: Number(classification.unknown || 0),
    excluded: Number(classification.excluded || 0),
  };
}

function memoryMetricApplicability(db, appliedAt) {
  return {
    contractAppliedAt: appliedAt || null,
    historicalEventsExcluded: scalarCount(
      db,
      `SELECT COUNT(*) AS count FROM memory_events
       WHERE event_type IN ('memory_searched', 'memory_injected')
         AND (payload_version IS NULL OR operation_key IS NULL OR invocation_id IS NULL OR agent_id IS NULL)`,
      {}
    ),
  };
}

function telemetryHealth(db, window = null) {
  const row = db.prepare("SELECT * FROM telemetry_sink_health WHERE sink = 'memory_events'").get();
  const failures = window
    ? scalarCount(
        db,
        `SELECT COUNT(*) AS count FROM telemetry_write_failures
         WHERE sink = 'memory_events' AND occurred_at >= @from AND occurred_at < @to`,
        window
      )
    : Number(row?.failed || 0);
  return {
    sink: "memory_events",
    attempted: Number(row?.attempted || 0),
    succeeded: Number(row?.succeeded || 0),
    failed: failures,
    unresolvedFailures: unresolvedTelemetryFailures(row),
    lastAttemptAt: row?.last_attempt_at || null,
    lastSuccessAt: row?.last_success_at || null,
    lastFailureAt: row?.last_failure_at || null,
    lastError: row?.last_error || null,
  };
}

function unresolvedTelemetryFailures(row) {
  if (!row?.last_failure_at) return 0;
  if (!row.last_success_at) return 1;
  return Date.parse(row.last_failure_at) > Date.parse(row.last_success_at) ? 1 : 0;
}

function scalarCount(db, sql, params) {
  return Number(db.prepare(sql).get(params)?.count || 0);
}

function countClasses(classes) {
  const result = Object.fromEntries(SAMPLE_CLASSES.map((name) => [name, 0]));
  for (const name of classes) result[name] += 1;
  return result;
}

function rateResult(numerator, denominator, counts) {
  return {
    value: denominator > 0 ? numerator / denominator : null,
    numerator,
    denominator,
    pending: counts.pending,
    censored: counts.censored,
    unknown: counts.unknown,
    excluded: counts.excluded,
  };
}

function metricWindow(options) {
  if (options.to && !validDate(options.to)) throw new Error("Metric window to is invalid.");
  if (options.from && !validDate(options.from)) throw new Error("Metric window from is invalid.");
  const toDate = validDate(options.to) || new Date();
  const fromDate = validDate(options.from) || new Date(toDate.getTime() - 24 * 60 * 60 * 1000);
  if (fromDate >= toDate) throw new Error("Metric window requires from < to.");
  return { from: fromDate.toISOString(), to: toDate.toISOString() };
}

function validDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function ageSeconds(value, now) {
  const date = validDate(value);
  return date ? Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000)) : null;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function positiveRatio(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 1 ? number : fallback;
}

function parseJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

module.exports = { createObservabilityRepository, classifyHandoff };
