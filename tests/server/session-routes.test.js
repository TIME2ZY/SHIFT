const assert = require("node:assert/strict");
const test = require("node:test");

const { createSessionRoutes } = require("../../src/server/session-routes");

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

function createHandler(res, overrides = {}) {
  return createSessionRoutes({
    worktreeManager: {},
    cleanupSessionRuntime() {},
    sendJson: makeSendJson(res),
    readJsonBody: async () => ({}),
    createSession: () => null,
    getSession: () => null,
    deleteSession: () => false,
    setSessionWorktree: () => null,
    ...overrides,
  });
}

test("session creation requires and forwards projectKey", async () => {
  const res = makeRes();
  let input = null;
  const handle = createHandler(res, {
    readJsonBody: async () => ({ projectKey: "dir:project-1" }),
    createSession: (value) => {
      input = value;
      return { id: "s1", projectKey: value.projectKey };
    },
  });

  assert.equal(await handle(makeReq("POST"), res, new URL("http://127.0.0.1/api/sessions")), true);
  assert.deepEqual(input, { projectKey: "dir:project-1" });
  assert.equal(res.statusCode, 201);

  const missingRes = makeRes();
  const missing = createHandler(missingRes);
  await missing(makeReq("POST"), missingRes, new URL("http://127.0.0.1/api/sessions"));
  assert.equal(missingRes.statusCode, 400);
  assert.match(missingRes.body.error, /projectKey is required/);
});

test("workspace derives its immutable Project binding from the Session", async () => {
  const res = makeRes();
  const handle = createHandler(res, {
    getSession: () => ({
      id: "s1",
      projectKey: "dir:project-1",
      projectDir: "C:/project-1",
    }),
    worktreeManager: {
      getStatus: () => ({ branch: "codex/session-s1" }),
    },
  });

  await handle(makeReq("GET"), res, new URL("http://127.0.0.1/api/sessions/s1/workspace"));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    sessionId: "s1",
    projectKey: "dir:project-1",
    projectDir: "C:/project-1",
    worktree: { branch: "codex/session-s1" },
  });
});

test("session routes return per-agent usage and persisted invocation process", async () => {
  const usageRes = makeRes();
  const summary = { available: true, session: { totalTokens: 12 }, agents: [] };
  const usage = createHandler(usageRes, {
    getSession: () => ({ id: "s1" }),
    getUsageSummary: () => summary,
  });
  await usage(makeReq("GET"), usageRes, new URL("http://127.0.0.1/api/sessions/s1/usage"));
  assert.deepEqual(usageRes.body, summary);

  const processRes = makeRes();
  const events = [
    { eventNo: 0, kind: "thinking.delta", payload: { text: "分析" } },
    {
      eventNo: 1,
      kind: "tool.finished",
      payload: { toolId: "t1", toolName: "read_file", result: "完成" },
    },
  ];
  const process = createHandler(processRes, {
    getSession: () => ({ id: "s1" }),
    recallService: {
      readInvocationPage: async (_sessionId, _invocationId, options) => ({
        events: events[options.from] ? [events[options.from]] : [],
        total: events.length,
      }),
    },
  });
  await process(
    makeReq("GET"),
    processRes,
    new URL("http://127.0.0.1/api/sessions/s1/invocations/i1/process")
  );
  assert.equal(processRes.statusCode, 200);
  assert.equal(processRes.body.thinking.text, "分析");
  assert.equal(processRes.body.tools[0].toolName, "read_file");
});

test("session trace routes are scoped and expose durable execution summaries", async () => {
  const res = makeRes();
  const handle = createHandler(res, {
    getSession: (id) => (id === "s1" ? { id } : null),
    executionStorage: {
      executions: {
        searchForThread: (_threadId, filters) => ({
          traces: [{ traceId: "trace-1", state: filters.state || "failed" }],
          page: { total: 1, limit: 20, offset: 0 },
        }),
        listForThread: () => [{ traceId: "trace-1", state: "failed" }],
        inspect: (threadId, traceId) =>
          threadId === "s1" && traceId === "trace-1"
            ? { traceId, threadId, invocations: [], handoffs: [] }
            : null,
        export: (threadId, traceId) =>
          threadId === "s1" && traceId === "trace-1"
            ? { format: "shift-trace-export", trace: { traceId } }
            : null,
      },
    },
  });
  await handle(
    makeReq("GET"),
    res,
    new URL("http://127.0.0.1/api/sessions/s1/traces?state=failed")
  );
  assert.equal(res.body.traces[0].state, "failed");
  assert.equal(res.body.page.total, 1);
  await handle(makeReq("GET"), res, new URL("http://127.0.0.1/api/sessions/s1/traces/trace-1"));
  assert.equal(res.body.trace.traceId, "trace-1");
  await handle(
    makeReq("GET"),
    res,
    new URL("http://127.0.0.1/api/sessions/s1/traces/trace-1/export")
  );
  assert.equal(res.body.format, "shift-trace-export");
  await handle(makeReq("GET"), res, new URL("http://127.0.0.1/api/sessions/s1/traces/missing"));
  assert.equal(res.statusCode, 404);
});

test("session audit summary combines the execution read model with billing usage", async () => {
  const res = makeRes();
  const handle = createHandler(res, {
    getSession: (id) => (id === "s1" ? { id } : null),
    getUsageSummary: () => ({ available: true, session: { totalTokens: 42 }, agents: [] }),
    executionStorage: {
      executions: {
        auditSummary: (threadId) => ({
          session: { id: threadId, title: "Audit" },
          volume: { userTurns: 2, messages: 5, traces: 1, invocations: 2 },
        }),
      },
    },
  });
  await handle(makeReq("GET"), res, new URL("http://127.0.0.1/api/sessions/s1/audit-summary"));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.summary.volume.userTurns, 2);
  assert.equal(res.body.summary.usage.session.totalTokens, 42);
});

test("discarding a worktree clears only the Session runtime link", async () => {
  const res = makeRes();
  let cleared = null;
  const handle = createHandler(res, {
    getSession: () => ({ id: "s1", projectKey: "dir:project-1" }),
    worktreeManager: {
      discardWorktree: (sessionId) => ({ ok: true, sessionId }),
    },
    setSessionWorktree: (sessionId, value) => {
      cleared = { sessionId, value };
    },
  });

  await handle(makeReq("POST"), res, new URL("http://127.0.0.1/api/sessions/s1/worktree/discard"));
  assert.deepEqual(cleared, { sessionId: "s1", value: null });
  assert.deepEqual(res.body, { ok: true, sessionId: "s1" });
});
