const assert = require("node:assert/strict");
const test = require("node:test");

const { createStorage } = require("../../src/storage");

function seed(storage) {
  storage.threads.upsert({ id: "thread-1", title: "Observability", projectDir: "C:/repo" });
  const window = storage.windows.create({
    id: "window-1",
    threadId: "thread-1",
    agentId: "codex",
    providerKey: "codex:gpt",
    workspaceKey: "base:C:/repo",
    generation: 1,
    capacityTokens: 1000,
  });
  storage.traces.start({
    id: "trace-1",
    threadId: "thread-1",
    startedAt: "2026-08-01T00:00:00.000Z",
  });
  storage.invocations.start({
    id: "source-1",
    threadId: "thread-1",
    traceId: "trace-1",
    windowId: window.id,
    agentId: "codex",
    startedAt: "2026-08-01T00:00:01.000Z",
  });
  return window;
}

test("observability health exposes authoritative completeness checks", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    seed(storage);
    const health = storage.observability.health({ now: "2026-08-02T00:00:00.000Z" });
    assert.equal(health.state, "available");
    assert.equal(health.checks.missing_trace_id, 0);
    assert.equal(health.checks.terminal_invocation_missing_end_event, 0);
    assert.equal(health.checks.metric_projection_lag, 0);
    assert.equal(health.checks.span_missing_end, 0);
    assert.equal(health.checks.telemetry_write_failure, 0);
    assert.deepEqual(health.alerts, []);
    assert.equal(health.capabilities.span_missing_end, "derived_from_canonical_events");
  } finally {
    storage.close();
  }
});

test("observability health excludes pre-contract invocations without inventing traces", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    storage.threads.upsert({ id: "legacy-thread", title: "Legacy", projectDir: "C:/legacy" });
    const window = storage.windows.create({
      id: "legacy-window",
      threadId: "legacy-thread",
      agentId: "codex",
      providerKey: "codex:gpt",
      workspaceKey: "base:C:/legacy",
      generation: 1,
      capacityTokens: 1000,
    });
    const cutoff = storage.db
      .prepare("SELECT applied_at FROM schema_migrations WHERE version = 24")
      .get().applied_at;
    storage.db
      .prepare(
        `INSERT INTO invocations
          (id, thread_id, window_id, agent_id, state, started_at)
         VALUES (?, ?, ?, ?, 'completed', ?)`
      )
      .run("legacy-invocation", "legacy-thread", window.id, "codex", "2000-01-01T00:00:00.000Z");
    storage.db
      .prepare(
        `INSERT INTO invocation_events
          (invocation_id, sequence_no, kind, payload_json, created_at)
         VALUES (?, 0, 'invocation-end', '{}', ?)`
      )
      .run("legacy-invocation", "2000-01-01T00:00:01.000Z");

    const health = storage.observability.health();
    assert.equal(health.checks.missing_trace_id, 0);
    assert.equal(health.historical.invocation_missing_trace_before_contract, 1);
    assert.equal(health.applicability.traceContractAppliedAt, cutoff);
    assert.equal(
      storage.db.prepare("SELECT trace_id FROM invocations WHERE id = ?").get("legacy-invocation")
        .trace_id,
      null
    );
  } finally {
    storage.close();
  }
});

test("observability health alerts when pending outbox exceeds threshold", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    seed(storage);
    storage.outbox.enqueue({
      id: "outbox-1",
      threadId: "thread-1",
      invocationId: "source-1",
      sequenceNo: 0,
      kind: "text",
      payload: {},
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const health = storage.observability.health({ now: "2026-08-01T00:10:00.000Z" });
    assert.ok(health.alerts.some((alert) => alert.code === "outbox_pending_age"));
    assert.equal(health.state, "degraded");
  } finally {
    storage.close();
  }
});

test("observability health degrades on terminal invocation without durable end event", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    seed(storage);
    storage.invocations.finish("source-1", { state: "failed", terminalReason: "test" });
    const health = storage.observability.health();
    assert.equal(health.state, "degraded");
    assert.equal(health.checks.terminal_invocation_missing_end_event, 1);
    const trace = storage.observability.inspectTrace("trace-1");
    assert.equal(trace.complete.ok, false);
    assert.ok(trace.complete.issues.includes("terminal_invocation_missing_end_event"));
  } finally {
    storage.close();
  }
});

test("handoff metrics classify eligible pending and excluded samples", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    const window = seed(storage);
    const first = storage.handoffs.accept({
      id: "handoff-ok",
      sourceInvocationId: "source-1",
      targetAgentId: "grok",
      contentHash: "ok",
      createdAt: "2026-08-01T01:00:00.000Z",
    });
    storage.invocations.start({
      id: "target-ok",
      threadId: "thread-1",
      traceId: "trace-1",
      windowId: window.id,
      agentId: "grok",
      startedAt: "2026-08-01T01:00:01.000Z",
    });
    storage.handoffs.bindTargetInvocation(first.record.handoffId, "target-ok");
    storage.invocations.finish("target-ok", {
      state: "completed",
      terminalReason: "assistant-final",
    });
    storage.handoffs.completeByTargetInvocation("target-ok", storage.invocations.get("target-ok"));
    storage.handoffs.accept({
      id: "handoff-pending",
      sourceInvocationId: "source-1",
      targetAgentId: "gemini",
      contentHash: "pending",
      createdAt: "2026-08-01T02:00:00.000Z",
    });
    storage.handoffs.accept({
      id: "handoff-duplicate",
      sourceInvocationId: "source-1",
      targetAgentId: "grok",
      contentHash: "different",
      createdAt: "2026-08-01T03:00:00.000Z",
    });
    const metrics = storage.observability.metrics({
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
    });
    assert.equal(metrics.handoff.endToEnd.numerator, 1);
    assert.equal(metrics.handoff.endToEnd.denominator, 1);
    assert.equal(metrics.handoff.endToEnd.pending, 1);
    assert.equal(metrics.handoff.endToEnd.excluded, 1);
    assert.equal(metrics.handoff.semantics.businessOutcome, null);
  } finally {
    storage.close();
  }
});

test("memory observability reports hit rate without claiming strict Recall", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    seed(storage);
    storage.memoryEvents.record({
      eventType: "memory_injected",
      threadId: "thread-1",
      createdAt: "2026-08-01T01:00:00.000Z",
      payload: { count: 2, availability: { state: "available" } },
    });
    storage.memoryEvents.record({
      eventType: "memory_injected",
      threadId: "thread-1",
      createdAt: "2026-08-01T02:00:00.000Z",
      payload: { count: 0, availability: { state: "degraded" } },
    });
    const metrics = storage.observability.metrics({
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
    });
    assert.equal(metrics.memory.hitRate.numerator, 1);
    assert.equal(metrics.memory.hitRate.denominator, 2);
    assert.equal(metrics.memory.hitRate.value, 0.5);
    assert.equal(metrics.memory.strictRecallAtK, null);
    assert.equal(metrics.memory.usedRate, null);
    assert.equal(metrics.memory.correctRate, null);
    assert.equal(metrics.memory.completeness, "best_effort");
  } finally {
    storage.close();
  }
});

test("metrics compare equal windows and fail closed on small samples", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    seed(storage);
    for (let index = 0; index < 5; index += 1) {
      storage.memoryEvents.record({
        eventType: "memory_injected",
        threadId: "thread-1",
        createdAt: `2026-08-${index < 4 ? "01" : "02"}T0${index}:00:00.000Z`,
        payload: { count: index < 4 ? 1 : 0, availability: { state: "available" } },
      });
    }
    const metrics = storage.observability.metrics({
      from: "2026-08-02T00:00:00.000Z",
      to: "2026-08-03T00:00:00.000Z",
      regressionMinSamples: 1,
    });
    const memory = metrics.comparison.indicators.find(
      (indicator) => indicator.metric === "memory.hitRate"
    );
    assert.equal(metrics.comparison.baselineWindow.from, "2026-08-01T00:00:00.000Z");
    assert.equal(memory.state, "regressed");
    assert.equal(memory.current.denominator, 1);
    assert.equal(memory.baseline.denominator, 4);
    assert.equal(memory.delta, -1);
    assert.equal(
      storage.observability
        .metrics({ from: "2026-08-02T00:00:00.000Z", to: "2026-08-03T00:00:00.000Z" })
        .comparison.indicators.find((indicator) => indicator.metric === "memory.hitRate").state,
      "unknown"
    );
  } finally {
    storage.close();
  }
});
