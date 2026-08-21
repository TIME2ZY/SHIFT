const assert = require("node:assert/strict");
const test = require("node:test");

const { createStorageRoutes } = require("../../src/server/storage-routes");

function responseCapture() {
  const res = {};
  const sendJson = (_res, status, body) => Object.assign(res, { status, body });
  return { res, sendJson };
}

test("storage health route exposes mode, epoch, and outbox health", async () => {
  const { res, sendJson } = responseCapture();
  const handle = createStorageRoutes({
    storageContext: {
      mode: "sqlite",
      auditTranscript: true,
      storage: {
        metadata: {
          getCurrent: () => ({
            epochId: "epoch-1",
            schemaVersion: 13,
            dataPolicy: "clean",
            isActive: false,
          }),
        },
      },
      outboxHealth: () => ({
        state: "degraded",
        pending: 2,
        oldestPendingAt: "2026-01-01T00:00:00.000Z",
        lastError: "disk unavailable",
      }),
      observabilityHealth: () => ({
        state: "degraded",
        authoritativeViolations: 1,
        checks: { missing_trace_id: 1 },
      }),
    },
    sendJson,
    readJsonBody: async () => ({}),
  });

  assert.equal(
    await handle({ method: "GET" }, res, new URL("http://127.0.0.1/api/storage/health")),
    true
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.storage.mode, "sqlite");
  assert.equal(res.body.storage.auditTranscript, true);
  assert.equal(res.body.storage.epoch.epochId, "epoch-1");
  assert.equal(res.body.storage.outbox.pending, 2);
  assert.equal(res.body.storage.observability.checks.missing_trace_id, 1);
});

test("observability metrics endpoint preserves sample counts and time window", async () => {
  const { res, sendJson } = responseCapture();
  const handle = createStorageRoutes({
    storageContext: {
      mode: "sqlite",
      observabilityMetrics: (window) => ({
        window,
        handoff: {
          completion: { value: 0.5, numerator: 1, denominator: 2, pending: 1, unknown: 0 },
        },
        memory: {
          search: { memoryHitRate: { value: 1, numerator: 2, denominator: 2 } },
          strictRecallAtK: null,
        },
      }),
    },
    sendJson,
    readJsonBody: async () => ({}),
  });
  await handle(
    { method: "GET" },
    res,
    new URL(
      "http://127.0.0.1/api/storage/observability/metrics?from=2026-08-01&to=2026-08-02&threadId=s1"
    )
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.metrics.handoff.completion.denominator, 2);
  assert.equal(res.body.metrics.memory.strictRecallAtK, null);
  assert.equal(res.body.metrics.window.from, "2026-08-01");
  assert.equal(res.body.metrics.window.threadId, "s1");
});

test("observability metrics endpoint rejects invalid windows", async () => {
  const { res, sendJson } = responseCapture();
  const handle = createStorageRoutes({
    storageContext: {
      mode: "sqlite",
      observabilityMetrics() {
        throw new Error("Metric window from is invalid.");
      },
    },
    sendJson,
    readJsonBody: async () => ({}),
  });
  await handle(
    { method: "GET" },
    res,
    new URL("http://127.0.0.1/api/storage/observability/metrics?from=invalid")
  );
  assert.equal(res.status, 400);
});

test("storage cleanup route validates policy and reports deleted delivered rows", async () => {
  const { res, sendJson } = responseCapture();
  let cleanupOptions;
  const handle = createStorageRoutes({
    storageContext: {
      mode: "sqlite",
      storage: null,
      outboxHealth: () => ({ state: "available", pending: 0 }),
      cleanupDeliveredOutbox(options) {
        cleanupOptions = options;
        return {
          available: true,
          deleted: 12,
          retentionDays: options.retentionDays,
          before: "2026-01-01T00:00:00.000Z",
        };
      },
    },
    sendJson,
    readJsonBody: async () => ({ retentionDays: 14, limit: 250 }),
  });

  await handle({ method: "POST" }, res, new URL("http://127.0.0.1/api/storage/outbox/cleanup"));
  assert.deepEqual(cleanupOptions, { retentionDays: 14, limit: 250 });
  assert.equal(res.status, 200);
  assert.equal(res.body.cleanup.deleted, 12);
});

test("storage cleanup route rejects unsafe retention parameters", async () => {
  const { res, sendJson } = responseCapture();
  const handle = createStorageRoutes({
    storageContext: { mode: "files" },
    sendJson,
    readJsonBody: async () => ({ retentionDays: 0, limit: 1000 }),
  });

  await handle({ method: "POST" }, res, new URL("http://127.0.0.1/api/storage/outbox/cleanup"));
  assert.equal(res.status, 400);
});

test("telemetry retention route only delegates best-effort cleanup", async () => {
  const { res, sendJson } = responseCapture();
  let cleanupOptions;
  const handle = createStorageRoutes({
    storageContext: {
      mode: "sqlite",
      cleanupBestEffortTelemetry(options) {
        cleanupOptions = options;
        return { available: true, deleted: 4, retentionDays: options.retentionDays };
      },
    },
    sendJson,
    readJsonBody: async () => ({ retentionDays: 30, limit: 500 }),
  });
  await handle(
    { method: "POST" },
    res,
    new URL("http://127.0.0.1/api/storage/observability/retention")
  );
  assert.deepEqual(cleanupOptions, { retentionDays: 30, limit: 500 });
  assert.equal(res.status, 200);
  assert.equal(res.body.cleanup.deleted, 4);
});

test("observability evidence route delegates the single validated import entry", async () => {
  const { res, sendJson } = responseCapture();
  let imported;
  const body = { id: "eval-1", kind: "labeled_recall_eval" };
  const handle = createStorageRoutes({
    storageContext: {
      mode: "sqlite",
      importObservabilityEvidence(input) {
        imported = input;
        return { imported: true, id: input.id, kind: input.kind };
      },
    },
    sendJson,
    readJsonBody: async () => body,
  });
  await handle(
    { method: "POST" },
    res,
    new URL("http://127.0.0.1/api/storage/observability/evidence")
  );
  assert.equal(res.status, 201);
  assert.deepEqual(imported, body);
});
