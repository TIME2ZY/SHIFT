const assert = require("node:assert/strict");
const test = require("node:test");

const sessionRoutes = require("../../src/server/session-routes.js");

function makeReq(method) {
  return { method };
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

test("handleSessionRoutes lists sessions", async () => {
  const res = makeRes();
  const handle = sessionRoutes.createSessionRoutes({
    rootDir: "/root",
    worktreeManager: {},
    cleanupSessionRuntime() {},
    sendJson: makeSendJson(res),
    readJsonBody: async () => ({}),
    listSessions: () => [{ id: "s1" }],
    createSession: () => {
      throw new Error("should not create");
    },
    getSession: () => null,
    deleteSession: () => false,
    setSessionWorktree: () => null,
    validateProjectDir: () => "/root",
    setSessionProjectDir: () => null,
  });

  const handled = await handle(makeReq("GET"), res, new URL("http://127.0.0.1/api/sessions"));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { sessions: [{ id: "s1" }] });
});

test("handleSessionRoutes returns per-agent usage summary", async () => {
  const res = makeRes();
  const summary = { available: true, session: { totalTokens: 12 }, agents: [] };
  const handle = sessionRoutes.createSessionRoutes({
    rootDir: "/root",
    worktreeManager: {},
    cleanupSessionRuntime() {},
    sendJson: makeSendJson(res),
    readJsonBody: async () => ({}),
    listSessions: () => [],
    createSession: () => null,
    getSession: () => ({ id: "s1" }),
    deleteSession: () => false,
    setSessionWorktree: () => null,
    validateProjectDir: () => "/root",
    setSessionProjectDir: () => null,
    getUsageSummary: (id) => {
      assert.equal(id, "s1");
      return summary;
    },
  });
  const handled = await handle(
    makeReq("GET"),
    res,
    new URL("http://127.0.0.1/api/sessions/s1/usage")
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, summary);
});

test("handleSessionRoutes projects a persisted invocation process across pages", async () => {
  const res = makeRes();
  const reads = [];
  const events = [
    { eventNo: 0, kind: "thinking.delta", payload: { text: "分析" } },
    {
      eventNo: 1,
      kind: "tool.finished",
      payload: { toolId: "t1", toolName: "read_file", result: "完成" },
    },
  ];
  const handle = sessionRoutes.createSessionRoutes({
    rootDir: "/root",
    worktreeManager: {},
    cleanupSessionRuntime() {},
    sendJson: makeSendJson(res),
    readJsonBody: async () => ({}),
    listSessions: () => [],
    createSession: () => null,
    getSession: (id) => (id === "s1" ? { id } : null),
    deleteSession: () => false,
    setSessionWorktree: () => null,
    validateProjectDir: () => "/root",
    setSessionProjectDir: () => null,
    recallService: {
      readInvocationPage: async (sessionId, invocationId, options) => {
        reads.push({ sessionId, invocationId, options });
        const event = events[options.from];
        return {
          events: event ? [event] : [],
          total: events.length,
          from: options.from,
          limit: options.limit,
        };
      },
    },
  });

  const handled = await handle(
    makeReq("GET"),
    res,
    new URL("http://127.0.0.1/api/sessions/s1/invocations/i1/process")
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.invocationId, "i1");
  assert.equal(res.body.thinking.text, "分析");
  assert.deepEqual(res.body.tools, [
    {
      toolId: "t1",
      toolName: "read_file",
      status: "done",
      output: "完成",
      changedFiles: [],
    },
  ]);
  assert.deepEqual(res.body.timeline, [
    {
      id: "thinking-0",
      type: "thinking",
      eventNo: 0,
      lastEventNo: 0,
      text: "分析",
    },
    { id: "tool-t1", type: "tool", eventNo: 1, toolId: "t1" },
  ]);
  assert.deepEqual(
    reads.map((read) => read.options.from),
    [0, 1]
  );
});

test("handleSessionRoutes updates projectDir for an existing session", async () => {
  const res = makeRes();
  let setArgs = null;
  const handle = sessionRoutes.createSessionRoutes({
    rootDir: "/root",
    worktreeManager: {},
    cleanupSessionRuntime() {},
    sendJson: makeSendJson(res),
    readJsonBody: async () => ({ sessionId: "s1", dir: "/next" }),
    listSessions: () => [],
    createSession: () => null,
    getSession: () => ({ id: "s1", projectDir: "/root" }),
    deleteSession: () => false,
    setSessionWorktree: () => null,
    validateProjectDir: (dir) => `${dir}/validated`,
    setSessionProjectDir: (sessionId, dir) => {
      setArgs = { sessionId, dir };
      return { id: sessionId, projectDir: dir };
    },
  });

  const handled = await handle(makeReq("POST"), res, new URL("http://127.0.0.1/api/project"));
  assert.equal(handled, true);
  assert.deepEqual(setArgs, {
    sessionId: "s1",
    dir: "/next/validated",
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { dir: "/next/validated" });
});

test("handleSessionRoutes discards a worktree and clears the session link", async () => {
  const res = makeRes();
  let cleared = null;
  const handle = sessionRoutes.createSessionRoutes({
    rootDir: "/root",
    worktreeManager: {
      discardWorktree(sessionId) {
        return { ok: true, sessionId };
      },
    },
    cleanupSessionRuntime() {},
    sendJson: makeSendJson(res),
    readJsonBody: async () => ({}),
    listSessions: () => [],
    createSession: () => null,
    getSession: () => ({ id: "s1" }),
    deleteSession: () => false,
    setSessionWorktree: (sessionId, value) => {
      cleared = { sessionId, value };
      return { id: sessionId, worktree: value };
    },
    validateProjectDir: () => "/root",
    setSessionProjectDir: () => null,
  });

  const handled = await handle(
    makeReq("POST"),
    res,
    new URL("http://127.0.0.1/api/sessions/s1/worktree/discard")
  );
  assert.equal(handled, true);
  assert.deepEqual(cleared, {
    sessionId: "s1",
    value: null,
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, sessionId: "s1" });
});
