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
  assert.equal(
    chatRoutes.contextCharsFromEvent({ type: "tool.finished", subagentId: "sub-1", output: "child tool" }),
    0
  );
  assert.equal(
    chatRoutes.contextCharsFromEvent({ type: "thinking.delta", subagentId: "sub-1", text: "child thought" }),
    0
  );
  assert.equal(
    chatRoutes.contextCharsFromEvent({ type: "commentary.delta", subagentId: "sub-1", text: "child commentary" }),
    0
  );
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
      makeTracker: () => ({
        addInput() {},
        addOutput() {},
        getFillRatio: () => 0,
        getPhysicalFillRatio: () => 0,
        getUsedTokens: () => 0,
        snapshot: () => ({ billing: {} }),
        markBillingIncomplete() {},
      }),
      getAgentReserveRatio: () => 0.1,
      getAgentCapacity: () => 1000,
      getAgentSealThresholds: () => ({
        usable: { sealer: { warn: 0.8, action: 0.85, recovery: 0.9 } },
      }),
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
      sealAndRotateWindow: () => null,
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

test("trace terminal state reflects final invocation outcome rather than earlier successes", async () => {
  const completedTraces = [];
  const invocations = [
    {
      id: "inv-1",
      traceId: "trace-multi",
      state: "completed",
      terminalReason: "assistant-final",
      errorCode: null,
      failureStage: null,
    },
    {
      id: "inv-2",
      traceId: "trace-multi",
      state: "failed",
      terminalReason: "provider-failed",
      errorCode: "provider_exit_1",
      failureStage: "provider_run",
    },
  ];
  const executor = chatRoutes.createChatRunExecutor(
    baseDeps(makeRes(), {
      durableRecorder: {
        enabled: true,
        startTrace: () => ({ id: "trace-multi" }),
        startInvocation: () => ({
          invocation: { id: "inv-2" },
          binding: null,
          window: { id: "win-1", capacityTokens: 1000, reserveRatio: 0.1 },
        }),
        completeTrace: (outcome) => completedTraces.push(outcome),
        completeInvocation: () => null,
        ensureWindow: () => null,
        reconcileTraceHandoffs: () => 0,
        addWindowUsage: () => true,
        setWindowUsageSnapshot: () => true,
        sealAndRotateWindow: () => null,
      },
      storage: {
        threadSeats: { listEnabledForThread: () => [{ seatId: "seat-codex", providerId: "codex" }] },
        invocations: {
          listForThread: () => invocations,
        },
      },
      sessionBootstrap: {
        buildBootstrapPacket: async () => ({ packet: "", inject: {} }),
        buildActiveMemoryCard: async () => ({ rendered: "", items: [], stats: {} }),
        buildIdentity: () => "<!-- Session Identity -->\n",
      },
      runChildStream: async () => ({ code: 1, signal: null }),
    })
  );

  const res = await executor.startRun({
    body: { sessionId: "s1", agent: "codex", prompt: "run multi" },
  });
  await res.promise;
  assert.equal(completedTraces.length, 1);
  assert.equal(completedTraces[0].state, "failed");
  assert.equal(completedTraces[0].terminalReason, "provider-failed");
  assert.equal(completedTraces[0].errorCode, "provider_exit_1");
  assert.equal(completedTraces[0].failureStage, "provider_run");
});

test("user abort intent forces invocation and trace terminal state to aborted", async () => {
  const completedTraces = [];
  const completedInvocations = [];
  const invocations = [
    {
      id: "inv-1",
      traceId: "trace-abort",
      state: "completed",
      terminalReason: "assistant-final",
    },
    {
      id: "inv-2",
      traceId: "trace-abort",
      state: "aborted",
      terminalReason: "aborted",
      errorCode: "invocation_aborted",
      failureStage: "request",
    },
  ];
  const executor = chatRoutes.createChatRunExecutor(
    baseDeps(makeRes(), {
      durableRecorder: {
        enabled: true,
        startTrace: () => ({ id: "trace-abort" }),
        startInvocation: () => ({
          invocation: { id: "inv-2" },
          binding: null,
          window: { id: "win-1", capacityTokens: 1000, reserveRatio: 0.1 },
        }),
        completeTrace: (outcome) => completedTraces.push(outcome),
        completeInvocation: (input) => {
          completedInvocations.push(input);
          return { invocation: { id: input.invocationId, state: "aborted" } };
        },
        ensureWindow: () => null,
        reconcileTraceHandoffs: () => 0,
        addWindowUsage: () => true,
        setWindowUsageSnapshot: () => true,
        sealAndRotateWindow: () => null,
      },
      storage: {
        threadSeats: { listEnabledForThread: () => [{ seatId: "seat-codex", providerId: "codex" }] },
        invocations: {
          listForThread: () => invocations,
        },
      },
      sessionBootstrap: {
        buildBootstrapPacket: async () => ({ packet: "", inject: {} }),
        buildActiveMemoryCard: async () => ({ rendered: "", items: [], stats: {} }),
        buildIdentity: () => "<!-- Session Identity -->\n",
      },
      runChildStream: async () => {
        return { code: 1, signal: null, stopped: true, stopReason: "explicit-stop" };
      },
    })
  );

  const res = await executor.startRun({
    body: { sessionId: "s1", agent: "codex", prompt: "run abort" },
  });
  await res.promise;

  assert.equal(completedTraces.length, 1);
  assert.equal(completedTraces[0].state, "aborted");
  assert.equal(completedTraces[0].terminalReason, "request-aborted");
  assert.equal(completedTraces[0].errorCode, "invocation_aborted");
  assert.equal(completedTraces[0].failureStage, "request");
  assert.ok(
    completedInvocations.some((inv) => inv.reason === "aborted" && inv.endPayload?.terminalState === "aborted")
  );
});

test("interrupted child stream completes unclosed tools with interrupted outcome", async () => {
  const appendedEvents = [];
  const executor = chatRoutes.createChatRunExecutor(
    baseDeps(makeRes(), {
      eventStore: {
        append: (event) => {
          appendedEvents.push(event);
          return { ok: true, event, sqlite: true };
        },
      },
      durableRecorder: {
        enabled: true,
        startTrace: () => ({ id: "trace-tool-int" }),
        startInvocation: () => ({
          invocation: { id: "inv-tool-int" },
          binding: null,
          window: { id: "win-1", capacityTokens: 1000, reserveRatio: 0.1 },
        }),
        completeTrace: () => null,
        completeInvocation: () => null,
        ensureWindow: () => null,
        reconcileTraceHandoffs: () => 0,
        addWindowUsage: () => true,
        setWindowUsageSnapshot: () => true,
        sealAndRotateWindow: () => null,
      },
      storage: {
        threadSeats: { listEnabledForThread: () => [{ seatId: "seat-codex", providerId: "codex" }] },
        invocations: {
          listForThread: () => [
            {
              id: "inv-tool-int",
              traceId: "trace-tool-int",
              state: "failed",
              terminalReason: "provider-failed",
            },
          ],
        },
      },
      sessionBootstrap: {
        buildBootstrapPacket: async () => ({ packet: "", inject: {} }),
        buildActiveMemoryCard: async () => ({ rendered: "", items: [], stats: {} }),
        buildIdentity: () => "<!-- Session Identity -->\n",
      },
      runChildStream: async ({ onEvent }) => {
        onEvent({
          type: "tool.started",
          toolId: "call-open-999",
          toolName: "run_terminal_command",
          args: { command: "npm test" },
        });
        return { code: 1, signal: null };
      },
    })
  );

  const res = await executor.startRun({
    body: { sessionId: "s1", agent: "codex", prompt: "run tool" },
  });
  await res.promise;

  const finishedTool = appendedEvents.find(
    (e) => e.kind === "tool.finished" && e.payload?.toolId === "call-open-999"
  );
  assert.ok(finishedTool, "tool.finished must be appended for unclosed tool on stream exit");
  assert.equal(finishedTool.payload.status, "interrupted");
  assert.equal(finishedTool.payload.failureSource, "runtime-interrupted");
  assert.ok(finishedTool.payload.failureReason.includes("Invocation terminated before tool completed"));
});
