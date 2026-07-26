const assert = require("node:assert/strict");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const { createMemoryRoutes } = require("../../src/server/memory-routes");

function makeRes() {
  return { statusCode: 0, body: null };
}

function makeSendJson(res) {
  return (_response, status, value) => {
    res.statusCode = status;
    res.body = value;
  };
}

function createHandle(storage, extras = {}) {
  return createMemoryRoutes({
    memoryService: storage.memory,
    suggestionService: storage.suggestionService,
    storage,
    getSession: () => ({ id: "thread-1" }),
    sessionsFile: "sessions.json",
    sendJson: extras.sendJson,
    readJsonBody: extras.readJsonBody || (async () => ({})),
    eventStore: extras.eventStore || null,
    logger: { error() {} },
  });
}

test("memory routes list create confirm and invalidate", async () => {
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "thread-1" });
  try {
    const res = makeRes();
    const handle = createHandle(storage, {
      sendJson: makeSendJson(res),
      readJsonBody: async () => ({
        sessionId: "thread-1",
        kind: "constraint",
        topic: "chat-fail-open",
        content: "Chat should fail open on dual-write errors.",
      }),
    });

    assert.equal(
      await handle(
        { method: "POST" },
        res,
        new URL("http://127.0.0.1/api/memories")
      ),
      true
    );
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.memory.kind, "constraint");
    assert.equal(res.body.supersessionKey, "constraint:chat-fail-open");
    const memoryId = res.body.memory.id;

    const listRes = makeRes();
    const listHandle = createHandle(storage, { sendJson: makeSendJson(listRes) });
    await listHandle(
      { method: "GET" },
      listRes,
      new URL("http://127.0.0.1/api/memories?sessionId=thread-1")
    );
    assert.equal(listRes.statusCode, 200);
    assert.equal(listRes.body.memories.length, 1);

    const confirmRes = makeRes();
    const confirmHandle = createHandle(storage, {
      sendJson: makeSendJson(confirmRes),
      readJsonBody: async () => ({ confirmedBy: "user" }),
    });
    await confirmHandle(
      { method: "POST" },
      confirmRes,
      new URL(`http://127.0.0.1/api/memories/${memoryId}/confirm`)
    );
    assert.equal(confirmRes.statusCode, 200);
    assert.equal(confirmRes.body.memory.status, "confirmed");

    const invalidateRes = makeRes();
    const invalidateHandle = createHandle(storage, {
      sendJson: makeSendJson(invalidateRes),
      readJsonBody: async () => ({ reason: "policy changed" }),
    });
    await invalidateHandle(
      { method: "POST" },
      invalidateRes,
      new URL(`http://127.0.0.1/api/memories/${memoryId}/invalidate`)
    );
    assert.equal(invalidateRes.statusCode, 200);
    assert.equal(invalidateRes.body.memory.status, "invalidated");
  } finally {
    storage.close();
  }
});

test("memory routes return a restart-hydratable context snapshot", async () => {
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "thread-1" });
  try {
    storage.memory.capture({
      id: "handoff-1",
      threadId: "thread-1",
      kind: "handoff",
      content: "结论：先修复 README，再继续 cutover。",
      captureKey: "handoff:restart:opencode:0",
      createdBy: "opencode",
      metadata: { source: "handoff", toAgent: "grok" },
    });
    storage.suggestions.create({
      id: "suggestion-1",
      originThreadId: "thread-1",
      proposedKind: "decision",
      proposedScope: "thread",
      topic: "sqlite-bootstrap",
      content: "快速开始必须创建 clean epoch。",
      confidence: 0.4,
      anchors: [{ type: "invocation", ref: "invocation-1" }],
    });
    storage.digests.upsert({
      threadId: "thread-1",
      summary: "当前阻塞：README 缺少 SQLite 初始化。",
      durableCandidates: [],
      topics: ["sqlite-bootstrap"],
      messageCount: 2,
    });

    const res = makeRes();
    const handle = createHandle(storage, { sendJson: makeSendJson(res) });
    await handle(
      { method: "GET" },
      res,
      new URL("http://127.0.0.1/api/memories?sessionId=thread-1&includeRetired=false")
    );

    assert.equal(res.statusCode, 200);
    assert.match(res.body.context.digest.summary, /README/);
    assert.equal(res.body.context.handoffs.length, 1);
    assert.match(res.body.context.handoffs[0].content, /先修复 README/);
    assert.equal(res.body.context.pendingSuggestions.length, 1);
    assert.match(res.body.context.pendingSuggestions[0].content, /clean epoch/);
  } finally {
    storage.close();
  }
});

test("memory routes return 503 without memory service", async () => {
  const res = makeRes();
  const handle = createMemoryRoutes({
    memoryService: null,
    sendJson: makeSendJson(res),
    readJsonBody: async () => ({}),
  });
  assert.equal(
    await handle({ method: "GET" }, res, new URL("http://127.0.0.1/api/memories?sessionId=t1")),
    true
  );
  assert.equal(res.statusCode, 503);
});

test("memory routes ignore unrelated paths", async () => {
  const res = makeRes();
  const handle = createMemoryRoutes({
    memoryService: {},
    sendJson: makeSendJson(res),
    readJsonBody: async () => ({}),
  });
  assert.equal(
    await handle({ method: "GET" }, res, new URL("http://127.0.0.1/api/sessions")),
    false
  );
});
