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
  assert.equal(res.body.storage.epoch.epochId, "epoch-1");
  assert.equal(res.body.storage.outbox.pending, 2);
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
