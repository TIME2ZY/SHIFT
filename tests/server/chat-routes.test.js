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
      buildActiveMemoryCard: async () => ({ rendered: "", items: [], stats: {} }),
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
    getMaxA2ADepth: () => 15,
    parseA2AMentions: () => [],
    filterBenignStderr: (text) => text,
    runChildStream: async () => ({ code: 0, signal: null }),
    durableRecorder: {
      enabled: false,
      ensureWindow: () => null,
      startTrace: () => null,
      completeTrace() {},
      reconcileTraceHandoffs: () => 0,
    },
    eventStore: {
      append: () => ({ ok: false, event: null, sqlite: false }),
    },
    memoryCapture: {
      captureHandoff: () => ({ captured: false }),
      captureWindowSeal: () => ({ captured: false }),
    },
    storage: {
      threadSeats: {
        listEnabledForThread: (threadId) => [
          {
            seatId: `seat-${threadId}-codex`,
            threadId,
            providerId: "codex",
            label: "Codex",
            enabled: true,
          },
        ],
      },
    },
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

test("createChatRunExecutor requires authoritative persistence dependencies", () => {
  const res = makeRes();
  const deps = baseDeps(res);
  assert.throws(
    () => chatRoutes.createChatRunExecutor({ ...deps, durableRecorder: null }),
    /durableRecorder is required/
  );
  assert.throws(
    () => chatRoutes.createChatRunExecutor({ ...deps, eventStore: null }),
    /eventStore is required/
  );
  assert.throws(
    () => chatRoutes.createChatRunExecutor({ ...deps, memoryCapture: null }),
    /memoryCapture is required/
  );
});

test("startRun rejects unsupported agents before starting chat", async () => {
  const executor = chatRoutes.createChatRunExecutor(baseDeps(makeRes()));
  const result = await executor.startRun({ body: { agent: "unknown", prompt: "hi" } });
  assert.equal(result.status, 400);
  assert.deepEqual(result.json, { error: 'Unsupported agent "unknown".' });
});

test("startRun rejects a supported agent whose Seat is disabled", async () => {
  const executor = chatRoutes.createChatRunExecutor(
    baseDeps(makeRes(), {
      storage: { threadSeats: { listEnabledForThread: () => [] } },
    })
  );
  const result = await executor.startRun({
    body: { sessionId: "s1", agent: "codex", prompt: "hi" },
  });
  assert.equal(result.status, 409);
  assert.deepEqual(result.json, {
    error: 'Seat for agent "codex" is not enabled in this Session.',
    code: "SEAT_NOT_ENABLED",
  });
});

test("a slower older chat request cannot abort the newer request", async () => {
  const activeInvocations = new Map();
  const pendingBootstraps = [];
  const appended = [];
  const res1 = makeRes();
  const deps = baseDeps(res1, {
    activeInvocations,
    sessionBootstrap: {
      buildBootstrapPacket: () =>
        new Promise((resolve) => pendingBootstraps.push(() => resolve({ packet: "", inject: {} }))),
      buildActiveMemoryCard: async () => ({ rendered: "", items: [], stats: {} }),
      buildIdentity: () => "<!-- Session Identity -->\n",
    },
    contextHealth: {
      getAgentCapacity: () => 1000,
      makeTracker: () => ({ addInput() {}, addOutput() {}, getFillRatio: () => 0 }),
    },
    appendToSession: (...args) => appended.push(args),
  });
  const executor = chatRoutes.createChatRunExecutor(deps);
  const first = executor.startRun({
    body: { sessionId: "s1", agent: "codex", prompt: "older" },
  });
  await Promise.resolve();

  const second = executor.startRun({
    body: { sessionId: "s1", agent: "codex", prompt: "newer" },
  });
  await Promise.resolve();

  assert.equal(pendingBootstraps.length, 2);
  const newerController = activeInvocations.get("s1");
  pendingBootstraps[1]();
  const newer = await second;
  pendingBootstraps[0]();
  const older = await first;

  assert.equal(older.status, 409);
  assert.match(older.json.error, /superseded/);
  assert.equal(newer.status, 202);
  assert.equal(appended.length, 1);
  assert.equal(appended[0][1].content, "newer");
  assert.equal(newerController.signal.aborted, false);
});

test("chat preparation failure closes the durable trace", async () => {
  const completed = [];
  const executor = chatRoutes.createChatRunExecutor(
    baseDeps(makeRes(), {
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
      sessionBootstrap: {
        buildBootstrapPacket: async () => {
          throw Object.assign(new Error("recall unavailable"), { code: "recall_unavailable" });
        },
        buildActiveMemoryCard: async () => ({ rendered: "", items: [], stats: {} }),
        buildIdentity: () => "<!-- Session Identity -->\n",
      },
    })
  );

  await assert.rejects(
    executor.startRun({ body: { sessionId: "s1", agent: "codex", prompt: "go" } }),
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
