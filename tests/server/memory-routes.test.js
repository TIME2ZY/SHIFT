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
      await handle(
        { method: "POST" },
        mutation,
        new URL("http://127.0.0.1/api/memories")
      ),
      false
    );
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
