const SAMPLE_CLASSES = Object.freeze(["eligible", "pending", "censored", "unknown", "excluded"]);
const { projectTraceSpans } = require("./trace-span-projection");

function createObservabilityRepository(db) {
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
        alerts.push({
          code: "authoritative_completeness_violation",
          severity: "error",
          count: authoritativeViolations,
        });
      }
      if (telemetry.unresolvedFailures > 0) {
        alerts.push({
          code: "telemetry_write_failure",
          severity: "warning",
          count: telemetry.unresolvedFailures,
          lastOccurredAt: telemetry.lastFailureAt,
        });
      }
      if (spanMissingEnd > 0) {
        alerts.push({ code: "span_missing_end", severity: "warning", count: spanMissingEnd });
      }
      if (outboxPendingAge != null && outboxPendingAge > outboxPendingAlertSeconds) {
        alerts.push({
          code: "outbox_pending_age",
          severity: "warning",
          value: outboxPendingAge,
          threshold: outboxPendingAlertSeconds,
        });
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
      const handoffs = db
        .prepare(
          `
          SELECT * FROM handoffs
          WHERE created_at >= @from AND created_at < @to
          ORDER BY created_at, id
        `
        )
        .all(window);
      const memoryEvents = db
        .prepare(
          `
          SELECT payload_json FROM memory_events
          WHERE event_type = 'memory_injected' AND created_at >= @from AND created_at < @to
          ORDER BY id
        `
        )
        .all(window);
      return {
        window,
        handoff: handoffMetrics(handoffs),
        memory: memoryHitMetrics(memoryEvents, telemetryHealth(db, window)),
      };
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

function memoryHitMetrics(rows, telemetry) {
  const counts = { eligible: 0, pending: 0, censored: 0, unknown: 0, excluded: 0 };
  let hits = 0;
  const availability = { available: 0, degraded: 0, unavailable: 0, unknown: 0 };
  for (const row of rows) {
    const payload = parseJson(row.payload_json);
    const state = payload?.availability?.state;
    if (!payload || !["available", "degraded", "unavailable"].includes(state)) {
      counts.unknown += 1;
      availability.unknown += 1;
      continue;
    }
    availability[state] += 1;
    counts.eligible += 1;
    if (Number(payload.count) > 0) hits += 1;
  }
  return {
    hitRate: rateResult(hits, counts.eligible, counts),
    availability,
    strictRecallAtK: null,
    usedRate: null,
    correctRate: null,
    completeness: telemetry.failed > 0 ? "incomplete" : "best_effort",
    telemetry,
    semantics: "non-empty delivered Memory result rate; not labeled Recall@K",
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

function parseJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

module.exports = { createObservabilityRepository, classifyHandoff };
