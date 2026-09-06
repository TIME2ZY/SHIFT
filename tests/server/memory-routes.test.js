const assert = require("node:assert/strict");
const test = require("node:test");

const { createMemoryRoutes } = require("../../src/server/memory-routes");
const { createStorage } = require("../../src/storage");

function response() {
  return { statusCode: 0, body: null };
}

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.body = body;
}

test("memory routes expose active/superseded product Memory as read-only state", async () => {
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "thread-1" });
  try {
    storage.memory.createProduct({
      threadId: "thread-1",
      kind: "decision",
      topic: "storage.authoritative",
      content: "SQLite is authoritative.",
      createdBy: "user",
    });
    storage.memory.createProduct({
      threadId: "thread-1",
      kind: "decision",
      topic: "storage.authoritative",
      content: "SQLite remains authoritative.",
      createdBy: "user",
    });

    const handle = createMemoryRoutes({
      memoryService: storage.memory,
      storage,
      getSession: () => ({ id: "thread-1" }),
      sendJson,
      readJsonBody: async () => ({}),
    });
    const res = response();
    const handled = await handle(
      { method: "GET" },
      res,
      new URL("http://127.0.0.1/api/memories?sessionId=thread-1")
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.kinds, ["decision", "constraint", "fact"]);
    assert.equal(res.body.counts.active, 1);
    assert.equal(res.body.counts.superseded, 1);

    const mutation = response();
    assert.equal(
      await handle({ method: "POST" }, mutation, new URL("http://127.0.0.1/api/memories")),
      false
    );
  } finally {
    storage.close();
  }
});

test("memory routes aggregate per-memory usage evidence from telemetry", async () => {
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "thread-1" });
  try {
    const { memory } = storage.memory.createProduct({
      threadId: "thread-1",
      kind: "decision",
      topic: "storage.authoritative",
      content: "SQLite is authoritative.",
      createdBy: "user",
    });
    storage.memoryEvents.recordSafe({
      eventType: "memory_searched",
      threadId: "thread-1",
      invocationId: "inv-1",
      agentId: "codex",
      payload: { memoryIds: [memory.id, "memory-other"], totalHits: 2 },
    });
    storage.memoryEvents.recordSafe({
      eventType: "memory_searched",
      threadId: "thread-1",
      invocationId: "inv-2",
      agentId: "codex",
      payload: { memoryIds: [memory.id], totalHits: 1 },
    });
    storage.memoryEvents.recordSafe({
      eventType: "memory_injected",
      threadId: "thread-1",
      invocationId: "inv-2",
      agentId: "codex",
      payload: { memoryIds: [memory.id], delivered: 1 },
    });

    const handle = createMemoryRoutes({
      memoryService: storage.memory,
      storage,
      getSession: () => ({ id: "thread-1" }),
      sendJson,
      readJsonBody: async () => ({}),
    });
    const res = response();
    const handled = await handle(
      { method: "GET" },
      res,
      new URL("http://127.0.0.1/api/memories/usage?sessionId=thread-1")
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.usage[memory.id], {
      searched: 2,
      injected: 1,
      selected: 0,
      dropped: 0,
    });
    assert.deepEqual(res.body.usage["memory-other"], {
      searched: 1,
      injected: 0,
      selected: 0,
      dropped: 0,
    });

    const missing = response();
    await handle(
      { method: "GET" },
      missing,
      new URL("http://127.0.0.1/api/memories/usage?sessionId=missing")
    );
    assert.equal(missing.statusCode, 200);
    assert.deepEqual(missing.body.usage, {});
  } finally {
    storage.close();
  }
});

test("memory routes return 503 without durable Memory", async () => {
  const handle = createMemoryRoutes({ sendJson, readJsonBody: async () => ({}) });
  const res = response();
  assert.equal(
    await handle(
      { method: "GET" },
      res,
      new URL("http://127.0.0.1/api/memories?sessionId=thread-1")
    ),
    true
  );
  assert.equal(res.statusCode, 503);
});

test("memory routes ignore unrelated paths", async () => {
  const handle = createMemoryRoutes({ sendJson });
  assert.equal(
    await handle({ method: "GET" }, response(), new URL("http://127.0.0.1/api/health")),
    false
  );
});
