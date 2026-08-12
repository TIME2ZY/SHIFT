const assert = require("node:assert/strict");
const test = require("node:test");

const chatRoutes = require("../../src/server/chat-routes.js");

test("invocationUsageDelta isolates one run from cumulative window billing", () => {
  assert.deepEqual(
    chatRoutes.invocationUsageDelta(
      {
        inputTokens: 1500,
        cachedInputTokens: 600,
        outputTokens: 320,
        reasoningTokens: 80,
        totalTokens: 1820,
        costUsd: 0.12,
      },
      {
        inputTokens: 1000,
        cachedInputTokens: 400,
        outputTokens: 200,
        reasoningTokens: 50,
        totalTokens: 1200,
        costUsd: 0.08,
      }
    ),
    {
      inputTokens: 500,
      cachedInputTokens: 200,
      outputTokens: 120,
      reasoningTokens: 30,
      totalTokens: 620,
      costUsd: 0.039999999999999994,
    }
  );
});

test("contextCharsFromEvent counts thinking and tool content without duplicates", () => {
  assert.equal(chatRoutes.contextCharsFromEvent({ type: "thinking.delta", text: "思考" }), 2);
  assert.equal(
    chatRoutes.contextCharsFromEvent({
      type: "tool.finished",
      output: "same",
      result: "same",
    }),
    4
  );
  assert.equal(
    chatRoutes.contextCharsFromEvent({
      type: "tool.finished",
      output: "short preview",
      originalOutputChars: 100000,
    }),
    "short preview".length
  );
  assert.equal(
    chatRoutes.contextCharsFromEvent({
      type: "tool.finished",
      result: { status: "ok", rows: [1, 2] },
    }),
    JSON.stringify({ status: "ok", rows: [1, 2] }).length
  );
  assert.equal(
    chatRoutes.contextCharsFromEvent({ type: "text.delta", text: "counted elsewhere" }),
    0
  );
  assert.equal(chatRoutes.contextCharsFromEvent({ type: "usage.update", outputTokens: 5 }), 0);
});

function makeReq(method, headers = {}) {
  return { method, headers, once() {} };
}

function makeRes() {
  return {
    statusCode: 0,
    body: null,
    writableEnded: false,
    destroyed: false,
    writeHead() {},
    end() {},
    once() {},
  };
}

function makeSendJson(res) {
  return (response, status, value) => {
    assert.equal(response, res);
    res.statusCode = status;
    res.body = value;
  };
}

function baseDeps(res, overrides = {}) {
  return {
    rootDir: "/root",
    selfGitRoot: null,
    options: {},
    AGENTS: { codex: { id: "codex", label: "Codex" } },
    callbacks: {
      buildCallbackInstructions: () => "",
      registerThread() {},
      getThread: () => null,
      unregisterThread() {},
      createInvocation: () => ({ invocationId: "inv1", callbackToken: "tok" }),
    },
    transcript: {
      appendEvent() {},
      flush: async () => {},
    },
    contextHealth: {
      makeTracker: () => ({ addInput() {}, addOutput() {}, getFillRatio: () => 0 }),
    },
    sessionSealer: {
      makeSealer: () => ({
        isSealed: () => false,
        update: () => "active",
        getState: () => "active",
        thresholds: { warn: 0.8 },
      }),
    },
    sessionBootstrap: {
      buildBootstrapPacket: async () => ({ packet: "", inject: { items: [], stats: {} } }),
      buildIdentity: () => "<!-- Session Identity -->\n",
    },
    agentIdentity: {
      renderIdentityBlock: (agentId) => `<!-- Agent Identity: ${agentId} -->\n`,
    },
    agentHandoff: {
      extractPrimaryHandoff: () => null,
      evaluateHandoff: () => ({
        ok: false,
        degraded: true,
        missing: ["what", "why", "next_action"],
        missingRecommended: [],
        score: 0,
        hasBlock: false,
      }),
      renderHandoffTask: () => "[任务交接]\n",
      summarizeHandoff: () => ({
        hasBlock: false,
        ok: false,
        degraded: true,
        score: 0,
        missing: [],
      }),
      normalizeTo: (v) => String(v || "").toLowerCase(),
    },
    worktreeManager: {},
    worktreeManagerModule: { ensureGitRoot: () => null },
    activeInvocations: new Map(),
    sendJson: makeSendJson(res),
    sendSse() {},
    readJsonBody: async () => ({}),
    buildChatArgs: () => [],
    augmentPrompt: () => ({ augmentedPrompt: "", skillNames: [] }),
    getMaxA2ADepth: () => 0,
    parseA2AMentions: () => [],
    filterBenignStderr: (text) => text,
    runChildStream: async () => ({ code: 0, signal: null }),
    getSession: () => ({ worktree: null, projectDir: "/root" }),
    setSessionWorktree: () => ({ worktree: null, projectDir: "/root" }),
    appendToSession() {},
    getSessionMapPath: () => "/tmp/session-map.json",
    readSessionMap: () => ({}),
    recordInvocationEvent() {},
    finalizeInvocationEvent() {},
    persistInvocations() {},
    ...overrides,
  };
}

test("handleChatRoutes rejects unsupported agents before starting chat", async () => {
  const res = makeRes();
  const handle = chatRoutes.createChatRoutes(
    baseDeps(res, {
      readJsonBody: async () => ({ agent: "unknown", prompt: "hi" }),
    })
  );

  const handled = await handle(
    makeReq("POST", { host: "127.0.0.1:8787" }),
    res,
    new URL("http://127.0.0.1/api/chat")
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'Unsupported agent "unknown".' });
});

test("a slower older chat request cannot abort the newer request", async () => {
  const activeInvocations = new Map();
  const pendingReplays = [];
  const appended = [];
  const memoryCapture = {
    replayThread: () => new Promise((resolve) => pendingReplays.push(resolve)),
  };
  const res1 = makeRes();
  const deps = baseDeps(res1, {
    activeInvocations,
    memoryCapture,
    contextHealth: {
      getAgentCapacity: () => 1000,
      makeTracker: () => ({ addInput() {}, addOutput() {}, getFillRatio: () => 0 }),
    },
    readJsonBody: async (req) => req.body,
    appendToSession: (...args) => appended.push(args),
  });
  const handler = chatRoutes.createChatRoutes(deps);
  const req1 = makeReq("POST");
  req1.body = { sessionId: "s1", agent: "codex", prompt: "older" };
  const first = handler(req1, res1, { pathname: "/api/chat" });
  await Promise.resolve();

  const res2 = makeRes();
  deps.sendJson = makeSendJson(res2);
  const handler2 = chatRoutes.createChatRoutes(deps);
  const req2 = makeReq("POST");
  req2.body = { sessionId: "s1", agent: "codex", prompt: "newer" };
  const second = handler2(req2, res2, { pathname: "/api/chat" });
  await Promise.resolve();

  assert.equal(pendingReplays.length, 2);
  pendingReplays[1]();
  await second;
  pendingReplays[0]();
  await first;

  assert.equal(res1.statusCode, 409);
  assert.match(res1.body.error, /superseded/);
  assert.equal(appended.length, 1);
  assert.equal(appended[0][1].content, "newer");
});

test("chat preparation failure closes the durable trace", async () => {
  const res = makeRes();
  const completed = [];
  const handle = chatRoutes.createChatRoutes(
    baseDeps(res, {
      durableRecorder: {
        enabled: true,
        startTrace: () => ({ id: "trace-1" }),
        completeTrace: (outcome) => completed.push(outcome),
        ensureWindow: () => null,
      },
      contextHealth: {
        getAgentCapacity: () => 1000,
        makeTracker: () => ({ addInput() {}, addOutput() {}, getFillRatio: () => 0 }),
      },
      memoryCapture: {
        replayThread: async () => {
          throw Object.assign(new Error("recall unavailable"), { code: "recall_unavailable" });
        },
      },
      readJsonBody: async () => ({ sessionId: "s1", agent: "codex", prompt: "go" }),
    })
  );

  await assert.rejects(
    handle(makeReq("POST"), res, { pathname: "/api/chat" }),
    /recall unavailable/
  );
  assert.deepEqual(completed, [
    {
      traceId: "trace-1",
      state: "failed",
      terminalReason: "preparation-failed",
      failureStage: "bootstrap",
      errorCode: "recall_unavailable",
      retryable: false,
    },
  ]);
});
