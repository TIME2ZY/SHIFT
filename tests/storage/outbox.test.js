const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const { createOutboxFlusher } = require("../../src/storage/outbox-flusher");
const { createEventStore } = require("../../src/storage/event-store");

function seed(storage) {
  storage.threads.create({ id: "thread-1" });
  const window = storage.windows.create({
    id: "window-1",
    threadId: "thread-1",
    agentId: "codex",
    providerKey: "codex",
    workspaceKey: "base",
    generation: 1,
    capacityTokens: 1000,
  });
  storage.invocations.start({
    id: "inv-1",
    threadId: "thread-1",
    windowId: window.id,
    agentId: "codex",
  });
}

test("sqlite event and outbox row commit in the same transaction", () => {
  const storage = createStorage({ file: ":memory:" });
  seed(storage);
  const events = createEventStore({ storage, mode: "sqlite" });
  try {
    const result = events.append({
      threadId: "thread-1",
      invocationId: "inv-1",
      kind: "text.delta",
      payload: { text: "durable" },
    });
    assert.equal(result.outbox, true);
    assert.equal(storage.invocations.listEvents("inv-1").length, 1);
    const pending = storage.outbox.listPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, result.outboxId);
    assert.deepEqual(pending[0].payload, { text: "durable" });
  } finally {
    events.close();
    storage.close();
  }
});

test("outbox delivery retries failures and marks rows delivered only after success", async () => {
  const storage = createStorage({ file: ":memory:" });
  seed(storage);
  const events = createEventStore({ storage, mode: "sqlite" });
  events.append({
    threadId: "thread-1",
    invocationId: "inv-1",
    kind: "text.delta",
    payload: { text: "retry me" },
  });
  let attempts = 0;
  const delivered = [];
  const flusher = createOutboxFlusher({
    outbox: storage.outbox,
    transcript: {
      async appendCanonicalEvent(event) {
        attempts += 1;
        if (attempts === 1) throw new Error("disk unavailable");
        delivered.push(event);
      },
    },
    logger: { error() {} },
  });
  try {
    const failed = await flusher.flushOnce();
    assert.equal(failed.failed, 1);
    assert.equal(storage.outbox.health().state, "degraded");
    storage.db
      .prepare("UPDATE storage_outbox SET next_attempt_at = NULL WHERE status = 'pending'")
      .run();

    const recovered = await flusher.flushOnce();
    assert.equal(recovered.delivered, 1);
    assert.equal(delivered.length, 1);
    assert.equal(storage.outbox.health().state, "available");
    assert.equal(storage.outbox.listPending().length, 0);
  } finally {
    await flusher.close();
    events.close();
    storage.close();
  }
});

test("outbox enqueue rolls back with the authoritative event", () => {
  const storage = createStorage({ file: ":memory:" });
  seed(storage);
  const events = createEventStore({ storage, mode: "sqlite" });
  const original = storage.outbox.enqueue;
  storage.outbox.enqueue = () => {
    throw new Error("outbox unavailable");
  };
  try {
    assert.throws(
      () =>
        events.append({
          threadId: "thread-1",
          invocationId: "inv-1",
          kind: "text.delta",
          payload: { text: "must roll back" },
        }),
      /outbox unavailable/
    );
    assert.equal(storage.invocations.listEvents("inv-1").length, 0);
  } finally {
    storage.outbox.enqueue = original;
    events.close();
    storage.close();
  }
});

test("pending outbox rows survive restart and are delivered later", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shift-outbox-restart-"));
  const dbFile = path.join(tmpDir, "memory.sqlite");
  try {
    const first = createStorage({ file: dbFile });
    seed(first);
    const events = createEventStore({ storage: first, mode: "sqlite" });
    events.append({
      threadId: "thread-1",
      invocationId: "inv-1",
      kind: "text.delta",
      payload: { text: "survive restart" },
    });
    events.close();
    first.close();

    const reopened = createStorage({ file: dbFile });
    const delivered = [];
    const flusher = createOutboxFlusher({
      outbox: reopened.outbox,
      transcript: {
        async appendCanonicalEvent(event) {
          delivered.push(event.id);
        },
      },
    });
    try {
      assert.equal(reopened.outbox.health().pending, 1);
      await flusher.flushOnce();
      assert.equal(delivered.length, 1);
      assert.equal(reopened.outbox.health().pending, 0);
    } finally {
      await flusher.close();
      reopened.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("delivered outbox cleanup respects retention boundary, batch limit, and pending rows", () => {
  const storage = createStorage({ file: ":memory:" });
  seed(storage);
  try {
    for (let sequenceNo = 0; sequenceNo < 4; sequenceNo += 1) {
      storage.outbox.enqueue({
        threadId: "thread-1",
        invocationId: "inv-1",
        sequenceNo,
        kind: "text.delta",
        payload: { sequenceNo },
        createdAt: `2026-01-0${sequenceNo + 1}T00:00:00.000Z`,
      });
    }
    const rows = storage.outbox.listPending({ now: "2026-02-01T00:00:00.000Z" });
    storage.outbox.markDelivered(rows[0].id, "2026-01-01T00:00:00.000Z");
    storage.outbox.markDelivered(rows[1].id, "2026-01-02T00:00:00.000Z");
    storage.outbox.markDelivered(rows[2].id, "2026-01-03T00:00:00.000Z");

    assert.equal(
      storage.outbox.cleanupDelivered({
        before: "2026-01-03T00:00:00.000Z",
        limit: 1,
      }),
      1
    );
    assert.equal(
      storage.outbox.cleanupDelivered({
        before: "2026-01-03T00:00:00.000Z",
        limit: 10,
      }),
      1,
      "the exact boundary is retained"
    );
    assert.equal(storage.outbox.listPending().length, 1, "pending rows are never cleaned");
    assert.equal(
      storage.outbox.cleanupDelivered({
        before: "2026-01-03T00:00:00.000Z",
        limit: 10,
      }),
      0,
      "cleanup is idempotent"
    );
  } finally {
    storage.close();
  }
});
