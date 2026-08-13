const assert = require("node:assert/strict");
const test = require("node:test");

const callbackRoutes = require("../../src/server/callback-routes.js");
const { createStorage } = require("../../src/storage");

function createCallbackRoutes(options) {
  return callbackRoutes.createCallbackRoutes({
    recallService: {},
    ...options,
  });
}

function makeReq(method, headers = {}) {
  return { method, headers };
}

function makeRes() {
  return { statusCode: 0, body: null };
}

function makeSendJson(res) {
  return (response, status, value) => {
    assert.equal(response, res);
    res.statusCode = status;
    res.body = value;
  };
}

test("createCallbackRoutes requires SQLite recallService", () => {
  assert.throws(
    () => callbackRoutes.createCallbackRoutes({ callbacks: {} }),
    /recallService is required/
  );
});

function makeMemoryHandle(storage, extras = {}) {
  const sseEvents = [];
  const tokens = new Map([
    ["i1", { agentId: "codex", callbackToken: "tok", createdAt: Date.now() }],
  ]);
  return {
    sseEvents,
    handle: createCallbackRoutes({
      callbacks: {
        validateToken: () => true,
        getThread: () => ({
          res: { destroyed: false, writableEnded: false, write() {} },
          tokens,
        }),
        sendSse: (_res, event, data) => {
          sseEvents.push({ event, data });
          return true;
        },
      },
      appendToSession() {},
      getSession: () => ({ id: "s1" }),
      sendJson: extras.sendJson,
      readJsonBody: extras.readJsonBody,
      memoryService: storage.memory,
      storage,
      eventStore: extras.eventStore || {
        append() {},
      },
      logger: { error() {} },
    }),
  };
}

test("handleCallbackRoutes posts callback messages after token validation", async () => {
  const res = makeRes();
  let appended = null;
  const handle = createCallbackRoutes({
    callbacks: {
      validateToken: () => true,
      postMessage: (sessionId, invocationId, content, options) => {
        appended = { sessionId, invocationId, content, optionsKeys: Object.keys(options) };
        return {
          ok: true,
          messagePosted: true,
          handoff: {
            status: "repair_required",
            detected: true,
            accepted: false,
            repairRequired: true,
            queuedAgents: [],
          },
        };
      },
    },
    appendToSession() {},
    getSession: () => null,
    sendJson: makeSendJson(res),
    readJsonBody: async () => ({
      sessionId: "s1",
      invocationId: "i1",
      callbackToken: "tok",
      content: "hello",
    }),
  });

  const handled = await handle(
    makeReq("POST"),
    res,
    new URL("http://127.0.0.1/api/callbacks/post-message")
  );
  assert.equal(handled, true);
  assert.deepEqual(appended, {
    sessionId: "s1",
    invocationId: "i1",
    content: "hello",
    optionsKeys: ["appendToSession"],
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.messagePosted, true);
  assert.equal(res.body.handoff.status, "repair_required");
});

test("handleCallbackRoutes lists invocations for a session", async () => {
  const res = makeRes();
  const handle = createCallbackRoutes({
    callbacks: {
      validateToken: () => true,
      postMessage: () => true,
    },
    recallService: {
      listInvocationsWithMeta: async () => [{ invocationId: "i1" }],
    },
    appendToSession() {},
    getSession: () => null,
    sendJson: makeSendJson(res),
    readJsonBody: async () => ({}),
  });

  const handled = await handle(
    makeReq("GET"),
    res,
    new URL("http://127.0.0.1/api/callbacks/list-invocations?sessionId=s1")
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { invocations: [{ invocationId: "i1" }] });
});

test("recall-search requires callback authentication and forwards only trusted context", async () => {
  const res = makeRes();
  const calls = [];
  const handle = createCallbackRoutes({
    callbacks: {
      validateToken: (sessionId, invocationId, token) =>
        sessionId === "s1" && invocationId === "i1" && token === "tok",
    },
    recallService: {
      searchForAgent: async (context, query) => {
        calls.push({ context, query });
        return { version: 2, query: query.query, hits: [] };
      },
    },
    appendToSession() {},
    getSession: () => null,
    sendJson: makeSendJson(res),
    readJsonBody: async () => ({
      sessionId: "s1",
      invocationId: "i1",
      operationId: "op-recall-1",
      query: "previous decision",
      layers: ["memory", "evidence"],
      limit: 6,
    }),
  });

  const handled = await handle(
    makeReq("POST", { "x-callback-token": "tok" }),
    res,
    new URL("http://127.0.0.1/api/callbacks/recall-search")
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.version, 2);
  assert.deepEqual(calls, [
    {
      context: {
        threadId: "s1",
        invocationId: "i1",
        agentId: "agent",
        operationKey: "recall:i1:op-recall-1",
        caller: "mcp",
      },
      query: {
        query: "previous decision",
        layers: ["memory", "evidence"],
        limit: 6,
      },
    },
  ]);
});

test("recall-search rejects missing tokens and agent-controlled scope fields", async () => {
  const missingTokenRes = makeRes();
  const missingTokenHandle = createCallbackRoutes({
    callbacks: { validateToken: () => true },
    recallService: { searchForAgent: async () => ({ hits: [] }) },
    sendJson: makeSendJson(missingTokenRes),
    readJsonBody: async () => ({
      sessionId: "s1",
      invocationId: "i1",
      operationId: "op-recall-missing-token",
      query: "previous decision",
    }),
  });
  await missingTokenHandle(
    makeReq("POST"),
    missingTokenRes,
    new URL("http://127.0.0.1/api/callbacks/recall-search")
  );
  assert.equal(missingTokenRes.statusCode, 400);

  const scopeRes = makeRes();
  const scopeHandle = createCallbackRoutes({
    callbacks: { validateToken: () => true },
    recallService: { searchForAgent: async () => ({ hits: [] }) },
    sendJson: makeSendJson(scopeRes),
    readJsonBody: async () => ({
      sessionId: "s1",
      invocationId: "i1",
      operationId: "op-recall-scope",
      query: "previous decision",
      projectKey: "other-project",
    }),
  });
  await scopeHandle(
    makeReq("POST", { "x-callback-token": "tok" }),
    scopeRes,
    new URL("http://127.0.0.1/api/callbacks/recall-search")
  );
  assert.equal(scopeRes.statusCode, 400);
  assert.match(scopeRes.body.error, /Unknown recall-search fields/);
});

test("handleCallbackRoutes returns 404 when invocation replay is missing", async () => {
  const res = makeRes();
  const handle = createCallbackRoutes({
    callbacks: {
      validateToken: () => true,
      postMessage: () => true,
    },
    recallService: {
      readInvocationPage: async () => ({ total: 0, events: [], from: 0, limit: 200 }),
    },
    appendToSession() {},
    getSession: () => null,
    sendJson: makeSendJson(res),
    readJsonBody: async () => ({}),
  });

  const handled = await handle(
    makeReq("GET"),
    res,
    new URL(
      "http://127.0.0.1/api/callbacks/read-invocation?sessionId=s1&targetInvocationId=missing"
    )
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: "Invocation not found." });
});

test("handleCallbackRoutes lists only successful current-invocation memory evidence", async () => {
  const res = makeRes();
  const reads = [];
  const handle = createCallbackRoutes({
    callbacks: {
      validateToken: (sessionId, invocationId, token) =>
        sessionId === "s1" && invocationId === "i1" && token === "tok",
    },
    recallService: {
      readInvocationPage: async (_threadId, _invocationId, options) => {
        reads.push(options);
        if (options.limit === 1) {
          return { total: 4, from: 0, limit: 1, events: [] };
        }
        return {
          total: 4,
          from: 0,
          limit: 4,
          events: [
            {
              eventNo: 1,
              kind: "tool.finished",
              payload: { toolName: "tests", result: "944 passed", status: "ok" },
              ts: "2026-07-29T00:00:00.000Z",
            },
            {
              eventNo: 2,
              kind: "tool.finished",
              payload: { toolName: "lint", status: "error" },
            },
            {
              eventNo: 3,
              kind: "text.delta",
              payload: { text: "assistant prose" },
            },
            {
              eventNo: 4,
              kind: "tool_result",
              payload: { result: "build ok" },
            },
          ],
        };
      },
    },
    appendToSession() {},
    getSession: () => null,
    sendJson: makeSendJson(res),
    readJsonBody: async () => ({}),
  });

  const handled = await handle(
    makeReq("GET", { "x-callback-token": "tok" }),
    res,
    new URL(
      "http://127.0.0.1/api/callbacks/memory-evidence" + "?sessionId=s1&invocationId=i1&limit=10"
    )
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.invocationId, "i1");
  assert.deepEqual(
    res.body.events.map((event) => event.eventNo),
    [1, 4]
  );
  assert.match(res.body.events[0].summary, /944 passed/);
  assert.equal(res.body.hasMore, false);
  assert.deepEqual(reads, [
    { from: 0, limit: 1 },
    { from: 0, limit: 4 },
  ]);
});

test("handleCallbackRoutes memory-write is the single product-memory HTTP bridge", async () => {
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "s1" });
  try {
    const res = makeRes();
    const { handle, sseEvents } = makeMemoryHandle(storage, {
      sendJson: makeSendJson(res),
      readJsonBody: async () => ({
        sessionId: "s1",
        invocationId: "i1",
        operationId: "op-write-1",
        callbackToken: "tok",
        kind: "decision",
        topic: "storage-primary",
        content: "SQLite is the single online write path.",
      }),
    });

    assert.equal(
      await handle(makeReq("POST"), res, new URL("http://127.0.0.1/api/callbacks/memory-write")),
      true
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.created, true);
    assert.equal(res.body.outcome, "created");
    assert.equal(res.body.memoryId, res.body.memory.id);
    assert.equal(res.body.topic, "storage-primary");
    assert.equal(res.body.memory.kind, "decision");
    assert.equal(res.body.memory.createdBy, "codex");
    // Invocation may not be mirrored to SQLite yet; metadata still records the callback id.
    assert.equal(res.body.memory.metadata?.callbackInvocationId, "i1");
    const memoryEvents = sseEvents.filter((item) => item.event === "memory");
    assert.equal(memoryEvents.length, 1);
    assert.equal(memoryEvents[0].data.action, "upsert");
    assert.ok(sseEvents.some((item) => item.event === "memory-metrics"));

    // Same topic supersedes previous active entry.
    const res2 = makeRes();
    const second = makeMemoryHandle(storage, {
      sendJson: makeSendJson(res2),
      readJsonBody: async () => ({
        sessionId: "s1",
        invocationId: "i1",
        operationId: "op-write-2",
        callbackToken: "tok",
        kind: "decision",
        topic: "storage-primary",
        content: "SQLite remains primary after migrate tooling.",
      }),
    });
    await second.handle(
      makeReq("POST"),
      res2,
      new URL("http://127.0.0.1/api/callbacks/memory-write")
    );
    assert.equal(res2.statusCode, 200);
    assert.equal(res2.body.created, true);
    assert.equal(res2.body.superseded.length, 1);
    assert.equal(storage.memory.listActive("s1").length, 1);
  } finally {
    storage.close();
  }
});
test("handleCallbackRoutes memory-write validates topic and availability", async () => {
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "s1" });
  try {
    const missingTopic = makeRes();
    const { handle } = makeMemoryHandle(storage, {
      sendJson: makeSendJson(missingTopic),
      readJsonBody: async () => ({
        sessionId: "s1",
        invocationId: "i1",
        operationId: "op-write-missing-topic",
        callbackToken: "tok",
        kind: "fact",
        content: "no topic",
      }),
    });
    await handle(
      makeReq("POST"),
      missingTopic,
      new URL("http://127.0.0.1/api/callbacks/memory-write")
    );
    assert.equal(missingTopic.statusCode, 400);
    assert.match(missingTopic.body.error, /topic/i);
    const rejected = storage.db
      .prepare("SELECT * FROM memory_events WHERE event_type = 'memory_write_completed'")
      .get();
    assert.equal(rejected.operation_key, "memory-write:i1:op-write-missing-topic");
    assert.equal(JSON.parse(rejected.payload_json).outcome, "rejected");
    assert.equal(JSON.parse(rejected.payload_json).reasonCode, "missing_topic");

    const unavailable = makeRes();
    const noService = createCallbackRoutes({
      callbacks: { validateToken: () => true },
      appendToSession() {},
      getSession: () => ({ id: "s1" }),
      sendJson: makeSendJson(unavailable),
      readJsonBody: async () => ({
        sessionId: "s1",
        invocationId: "i1",
        operationId: "op-write-unavailable",
        callbackToken: "tok",
        kind: "fact",
        topic: "x",
        content: "y",
      }),
      memoryService: null,
    });
    await noService(
      makeReq("POST"),
      unavailable,
      new URL("http://127.0.0.1/api/callbacks/memory-write")
    );
    assert.equal(unavailable.statusCode, 503);
  } finally {
    storage.close();
  }
});
