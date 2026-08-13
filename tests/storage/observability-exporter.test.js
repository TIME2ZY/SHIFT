const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createObservabilityExporter,
  structuralSnapshot,
} = require("../../src/storage/observability-exporter");

test("exporter is disabled by default and sends only structural aggregates", async () => {
  const disabled = createObservabilityExporter({ env: {} });
  assert.deepEqual(disabled.health(), {
    enabled: false,
    protocol: "otlp-http",
    state: "disabled",
    attempted: 0,
    succeeded: 0,
    failed: 0,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
  });

  const snapshot = structuralSnapshot(
    {
      state: "degraded",
      authoritativeViolations: 1,
      alerts: [{ code: "span_missing_end", severity: "warning", count: 1, query: "secret" }],
    },
    {
      window: { from: "a", to: "b" },
      handoff: { endToEnd: { value: 0.5, numerator: 1, denominator: 2 } },
      memory: { hitRate: { value: 1, numerator: 2, denominator: 2 } },
      comparison: { indicators: [{ metric: "memory.hitRate", state: "stable", delta: 0 }] },
      prompt: "secret",
    }
  );
  const text = JSON.stringify(snapshot);
  assert.match(text, /span_missing_end/);
  assert.doesNotMatch(text, /secret|prompt|query/);
});

test("export failure degrades only exporter health", async () => {
  const exporter = createObservabilityExporter({
    endpoint: "https://example.invalid/v1/logs",
    env: {},
    fetch: async () => ({ ok: false, status: 503 }),
    readHealth: () => ({ state: "available", alerts: [] }),
    readMetrics: () => ({}),
    logger: { warn() {} },
  });
  const result = await exporter.flush();
  assert.equal(result.state, "degraded");
  assert.equal(result.failed, 1);
  assert.match(result.lastError, /HTTP 503/);
});

test("sentry-compatible export emits one envelope without identifiers", async () => {
  let request;
  const exporter = createObservabilityExporter({
    endpoint: "https://example.invalid/envelope",
    protocol: "sentry-envelope",
    env: {},
    fetch: async (_url, input) => {
      request = input;
      return { ok: true, status: 200 };
    },
    readHealth: () => ({ state: "available", alerts: [] }),
    readMetrics: () => ({}),
  });
  const result = await exporter.flush();
  assert.equal(result.state, "available");
  assert.equal(request.headers["content-type"], "application/x-sentry-envelope");
  assert.doesNotMatch(request.body, /traceId|threadId|invocationId/);
});
