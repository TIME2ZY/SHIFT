const assert = require("node:assert/strict");
const test = require("node:test");

const callbackRoutes = require("../../src/server/callback-routes.js");
const { createStorage } = require("../../src/storage");

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

function makeMemoryHandle(storage, extras = {}) {
  const sseEvents = [];
  const tokens = new Map([
    ["i1", { agentId: "codex", callbackToken: "tok", createdAt: Date.now() }],
  ]);
  return {
    sseEvents,
    handle: callbackRoutes.createCallbackRoutes({
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
      transcript: {},
      appendToSession() {},
      getSession: () => ({ id: "s1" }),
      sessionsFile: "sessions.json",
      sendJson: extras.sendJson,
      readJsonBody: extras.readJsonBody,
      memoryService: storage.memory,
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
  const handle = callbackRoutes.createCallbackRoutes({
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
    transcript: {},
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

  const handled = await handle(makeReq("POST"), res, new URL("http://127.0.0.1/api/callbacks/post-message"));
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
  const handle = callbackRoutes.createCallbackRoutes({
    callbacks: {
      validateToken: () => true,
      postMessage: () => true,
    },
    transcript: {
      listInvocationsWithMeta: async () => [{ invocationId: "i1" }],
    },
    appendToSession() {},
    getSession: () => null,
    sendJson: makeSendJson(res),
    readJsonBody: async () => ({}),
  });

  const handled = await handle(makeReq("GET"), res, new URL("http://127.0.0.1/api/callbacks/list-invocations?sessionId=s1"));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { invocations: [{ invocationId: "i1" }] });
});

test("handleCallbackRoutes returns 404 when invocation replay is missing", async () => {
  const res = makeRes();
  const handle = callbackRoutes.createCallbackRoutes({
    callbacks: {
      validateToken: () => true,
      postMessage: () => true,
    },
    transcript: {
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
    new URL("http://127.0.0.1/api/callbacks/read-invocation?sessionId=s1&targetInvocationId=missing")
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: "Invocation not found." });
});

test("handleCallbackRoutes memory-upsert writes product memory and emits SSE", async () => {
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "s1" });
  try {
    const res = makeRes();
    const { handle, sseEvents } = makeMemoryHandle(storage, {
      sendJson: makeSendJson(res),
      readJsonBody: async () => ({
        sessionId: "s1",
        invocationId: "i1",
        callbackToken: "tok",
        kind: "decision",
        topic: "storage-primary",
        content: "SQLite is the single online write path.",
      }),
    });

    assert.equal(
      await handle(makeReq("POST"), res, new URL("http://127.0.0.1/api/callbacks/memory-upsert")),
      true
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.created, true);
    assert.equal(res.body.topic, "storage-primary");
    assert.equal(res.body.memory.kind, "decision");
    assert.equal(res.body.memory.createdBy, "codex");
    // Invocation may not be mirrored to SQLite yet; metadata still records the callback id.
    assert.equal(res.body.memory.metadata?.callbackInvocationId, "i1");
    assert.equal(sseEvents.length, 1);
    assert.equal(sseEvents[0].event, "memory");
    assert.equal(sseEvents[0].data.action, "upsert");

    // Same topic supersedes previous active entry.
    const res2 = makeRes();
    const second = makeMemoryHandle(storage, {
      sendJson: makeSendJson(res2),
      readJsonBody: async () => ({
        sessionId: "s1",
        invocationId: "i1",
        callbackToken: "tok",
        kind: "decision",
        topic: "storage-primary",
        content: "SQLite remains primary after migrate tooling.",
      }),
    });
    await second.handle(
      makeReq("POST"),
      res2,
      new URL("http://127.0.0.1/api/callbacks/memory-upsert")
    );
    assert.equal(res2.statusCode, 200);
    assert.equal(res2.body.created, true);
    assert.equal(res2.body.superseded.length, 1);
    assert.equal(storage.memory.listActive("s1").length, 1);
  } finally {
    storage.close();
  }
});

test("handleCallbackRoutes memory-upsert validates topic and availability", async () => {
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "s1" });
  try {
    const missingTopic = makeRes();
    const { handle } = makeMemoryHandle(storage, {
      sendJson: makeSendJson(missingTopic),
      readJsonBody: async () => ({
        sessionId: "s1",
        invocationId: "i1",
        callbackToken: "tok",
        kind: "fact",
        content: "no topic",
      }),
    });
    await handle(
      makeReq("POST"),
      missingTopic,
      new URL("http://127.0.0.1/api/callbacks/memory-upsert")
    );
    assert.equal(missingTopic.statusCode, 400);
    assert.match(missingTopic.body.error, /topic/i);

    const unavailable = makeRes();
    const noService = callbackRoutes.createCallbackRoutes({
      callbacks: { validateToken: () => true },
      transcript: {},
      appendToSession() {},
      getSession: () => ({ id: "s1" }),
      sessionsFile: "sessions.json",
      sendJson: makeSendJson(unavailable),
      readJsonBody: async () => ({
        sessionId: "s1",
        invocationId: "i1",
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
      new URL("http://127.0.0.1/api/callbacks/memory-upsert")
    );
    assert.equal(unavailable.statusCode, 503);
  } finally {
    storage.close();
  }
});

test("handleCallbackRoutes memory-invalidate retires thread-local memory", async () => {
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "s1" });
  storage.threads.create({ id: "other" });
  try {
    const created = storage.memory.createProduct({
      threadId: "s1",
      kind: "constraint",
      topic: "no-spawn",
      content: "Do not spawn nested subagents.",
      createdBy: "user",
    });

    const res = makeRes();
    const { handle, sseEvents } = makeMemoryHandle(storage, {
      sendJson: makeSendJson(res),
      readJsonBody: async () => ({
        sessionId: "s1",
        invocationId: "i1",
        callbackToken: "tok",
        id: created.memory.id,
        reason: "policy changed",
      }),
    });
    await handle(
      makeReq("POST"),
      res,
      new URL("http://127.0.0.1/api/callbacks/memory-invalidate")
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.memory.status, "invalidated");
    assert.equal(sseEvents[0].data.action, "invalidate");

    const otherRes = makeRes();
    const foreign = makeMemoryHandle(storage, {
      sendJson: makeSendJson(otherRes),
      readJsonBody: async () => ({
        sessionId: "other",
        invocationId: "i1",
        callbackToken: "tok",
        id: created.memory.id,
      }),
    });
    // Token map agent is fine; membership check is by thread id.
    await foreign.handle(
      makeReq("POST"),
      otherRes,
      new URL("http://127.0.0.1/api/callbacks/memory-invalidate")
    );
    assert.equal(otherRes.statusCode, 404);
  } finally {
    storage.close();
  }
});
