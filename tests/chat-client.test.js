const assert = require("node:assert/strict");
const test = require("node:test");

const chatClientModule = require("../public/chat-client.js");
const { createRuntimeStore } = require("../public/session-runtime.js");

function makeDeps(overrides = {}) {
  const runtimeStore = createRuntimeStore();
  const state = {
    currentSessionId: null,
    rightPanelTab: "agents",
    runtimeStore,
    sessions: {},
    projectDir: "",
    selectedAgent: "codex",
    lastAgent: "codex",
  };
  const promptEl = {
    value: "",
    disabled: false,
    focused: 0,
    focus() {
      this.focused += 1;
    },
  };
  const btnSend = {
    textContent: "发送",
    classList: { add() {}, remove() {} },
  };

  return {
    state,
    runtimeStore,
    promptEl,
    btnSend,
    useWorktreeInput: { checked: false },
    resolvePromptAgent: () => null,
    addSystem() {},
    setStatus() {},
    sessionApi: { createSession: async () => ({ id: "s1" }) },
    createMessage() {},
    hideMentionMenu() {},
    fetchImpl: async () => {
      throw new Error("should not fetch");
    },
    flushPendingLiveRender() {},
    renderMd: (text) => text,
    sessionController: { loadSessions() {}, refreshSessionList() {} },
    loadProjectDir() {},
    loadWorktreeStatus() {},
    loadWorkspaceState() {},
    renderSkillTags() {},
    showThinking() {},
    appendLive() {},
    applyAgentEvent() {},
    addDebug() {},
    finishStream() {},
    agentLabel: (id) => id,
    syncComposerControls() {},
    onRuntimeStatusChange() {},
    ...overrides,
  };
}

test("parseSse emits complete frames and preserves trailing partial data", () => {
  const client = chatClientModule.createChatClient(makeDeps());
  const seen = [];
  const rest = client.parseSse('event: message\ndata: {"text":"hi"}\n\npartial', (event, data) =>
    seen.push({ event, data })
  );

  assert.deepEqual(seen, [{ event: "message", data: { text: "hi" } }]);
  assert.equal(rest, "partial");
});

test("parseSse supports CRLF frames and multi-line data payloads", () => {
  const client = chatClientModule.createChatClient(makeDeps());
  const seen = [];
  const rest = client.parseSse(
    'event: message\r\ndata: {"text":\r\ndata: "hi"}\r\n\r\nevent: done\r\ndata: {}\r\n\r\n',
    (event, data) => seen.push({ event, data })
  );

  assert.deepEqual(seen, [
    { event: "message", data: { text: "hi" } },
    { event: "done", data: {} },
  ]);
  assert.equal(rest, "");
});

test("parseSse skips malformed JSON frames without throwing", () => {
  const client = chatClientModule.createChatClient(makeDeps());
  const seen = [];
  const rest = client.parseSse(
    "event: message\ndata: {not-json\n\nevent: done\ndata: {}\n\n",
    (event, data) => seen.push({ event, data })
  );
  assert.deepEqual(seen, [{ event: "done", data: {} }]);
  assert.equal(rest, "");
});

test("handleSseEvent session updates state and reloads session-scoped data", () => {
  const calls = [];
  const deps = makeDeps({
    loadProjectDir(id) {
      calls.push(["project", id]);
    },
    loadWorktreeStatus() {
      calls.push(["worktree"]);
    },
    loadWorkspaceState() {
      calls.push(["workspace"]);
    },
    sessionController: {
      loadSessions() {
        calls.push(["sessions"]);
      },
      refreshSessionList() {
        calls.push(["refresh"]);
      },
    },
  });
  deps.state.rightPanelTab = "workspace";
  const client = chatClientModule.createChatClient(deps);

  client.handleSseEvent("session", { sessionId: "s1" }, { sessionId: "s1" });

  assert.equal(deps.state.currentSessionId, "s1");
  assert.deepEqual(calls, [["sessions"], ["project", "s1"], ["worktree"], ["workspace"]]);
});

test("handleSseEvent routes memory frames to onMemoryEvent", () => {
  const seen = [];
  const deps = makeDeps({
    onMemoryEvent(payload, sessionId) {
      seen.push([payload.action, payload.sessionId, sessionId]);
    },
  });
  deps.state.currentSessionId = "s1";
  const client = chatClientModule.createChatClient(deps);

  client.handleSseEvent(
    "memory",
    {
      action: "upsert",
      sessionId: "s1",
      memory: { id: "m1", kind: "decision", content: "use sqlite" },
    },
    { sessionId: "s1" }
  );

  assert.deepEqual(seen, [["upsert", "s1", "s1"]]);
});

test("handleSseEvent routes canonical agent-event frames into the bound session", () => {
  const seen = [];
  const deps = makeDeps({
    applyAgentEvent(event, sessionId) {
      seen.push([event.type, sessionId]);
    },
  });
  deps.state.currentSessionId = "visible";
  const client = chatClientModule.createChatClient(deps);

  client.handleSseEvent(
    "agent-event",
    {
      type: "progress.update",
      agent: "opencode",
      invocationId: "inv-1",
      items: [],
    },
    { sessionId: "background" }
  );

  assert.deepEqual(seen, [["progress.update", "background"]]);
  assert.equal(deps.runtimeStore.get("background").hasStructuredEvents, true);
});

test("usage.update notifies the usage summary hook", () => {
  const seen = [];
  const client = chatClientModule.createChatClient(
    makeDeps({ onUsageEvent: (event, sessionId) => seen.push({ event, sessionId }) })
  );
  const usage = {
    type: "usage.update",
    agent: "codex",
    invocationId: "inv-usage",
    scope: "turn",
    mode: "cumulative",
    totalTokens: 12,
  };
  client.handleSseEvent("agent-event", usage, { sessionId: "s1" });
  assert.deepEqual(seen, [{ event: usage, sessionId: "s1" }]);
});

test("background SSE does not mutate the visible session UI helpers", () => {
  const calls = [];
  const deps = makeDeps({
    state: {
      currentSessionId: "visible",
      rightPanelTab: "agents",
      runtimeStore: createRuntimeStore(),
      sessions: {},
      projectDir: "",
    },
    showThinking(agent, sessionId) {
      calls.push(["think", agent, sessionId]);
    },
    appendLive(agent, text, sessionId) {
      calls.push(["live", agent, text, sessionId]);
    },
    addSystem(text) {
      calls.push(["system", text]);
    },
    addDebug(agent, text) {
      calls.push(["debug", agent, text]);
    },
  });
  deps.runtimeStore = deps.state.runtimeStore;
  const client = chatClientModule.createChatClient(deps);

  client.handleSseEvent(
    "agent-start",
    { agent: "codex", invocationId: "inv-9" },
    { sessionId: "bg" }
  );
  client.handleSseEvent("message", { agent: "codex", text: "secret" }, { sessionId: "bg" });
  client.handleSseEvent("stderr", { agent: "codex", text: "noise" }, { sessionId: "bg" });
  client.handleSseEvent("error", { message: "boom" }, { sessionId: "bg" });

  assert.deepEqual(calls, [
    ["think", "codex", "bg"],
    ["live", "codex", "secret", "bg"],
  ]);
  assert.equal(deps.runtimeStore.get("bg").status, "error");
  assert.equal(deps.runtimeStore.get("bg").liveInvocations.get("codex"), "inv-9");
});

test("a2a-route buffers system notice even when session is in background", () => {
  const calls = [];
  const runtimeStore = createRuntimeStore();
  const deps = makeDeps({
    runtimeStore,
    state: {
      currentSessionId: "visible",
      rightPanelTab: "agents",
      runtimeStore,
      sessions: {},
      projectDir: "",
    },
    addSystem(text) {
      calls.push(text);
    },
    agentLabel: (id) => (id === "codex" ? "Codex" : id === "opencode" ? "Gemini" : id),
  });
  const client = chatClientModule.createChatClient(deps);

  client.handleSseEvent(
    "a2a-route",
    {
      from: "codex",
      to: "opencode",
      handoffDegraded: false,
    },
    { sessionId: "bg" }
  );

  assert.deepEqual(calls, []);
  const notices = runtimeStore.get("bg").systemNotices;
  assert.equal(notices.length, 1);
  assert.match(notices[0].content, /Codex.*Gemini/);
  assert.equal(notices[0].kind, "a2a-route");
});

test("a2a-route paints system notice when session is active", () => {
  const calls = [];
  const runtimeStore = createRuntimeStore();
  const deps = makeDeps({
    runtimeStore,
    state: {
      currentSessionId: "s1",
      rightPanelTab: "agents",
      runtimeStore,
      sessions: {},
      projectDir: "",
    },
    addSystem(text) {
      calls.push(text);
    },
    agentLabel: (id) => id,
  });
  const client = chatClientModule.createChatClient(deps);

  client.handleSseEvent(
    "a2a-route",
    {
      from: "codex",
      to: "grok",
      handoffDegraded: true,
    },
    { sessionId: "s1" }
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0], /codex.*grok/);
  assert.match(calls[0], /交接包不完整/);
  assert.equal(runtimeStore.get("s1").systemNotices.length, 1);
});

test("a2a-skipped paints system notice when session is active", () => {
  const calls = [];
  const runtimeStore = createRuntimeStore();
  const deps = makeDeps({
    runtimeStore,
    state: {
      currentSessionId: "s1",
      rightPanelTab: "agents",
      runtimeStore,
      sessions: {},
      projectDir: "",
    },
    addSystem(text) {
      calls.push(text);
    },
    agentLabel: (id) => id,
  });
  const client = chatClientModule.createChatClient(deps);

  client.handleSseEvent(
    "a2a-skipped",
    { from: "opencode", to: "grok", reason: "max_depth", maxDepth: 15 },
    { sessionId: "s1" }
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0], /opencode.*grok/);
  assert.match(calls[0], /深度上限|未入队/);
  assert.equal(runtimeStore.get("s1").systemNotices[0].kind, "a2a-skipped");
});

test("agent-exit finalizes the agent so handoffs clear writing state", () => {
  const finalized = [];
  const runtimeStore = createRuntimeStore();
  runtimeStore.beginRun("s1", { abort() {} });
  runtimeStore.get("s1").liveMessages.set("codex", {
    rawText: "done work",
    setBadge() {},
  });
  const deps = makeDeps({
    runtimeStore,
    state: {
      currentSessionId: "s1",
      rightPanelTab: "agents",
      runtimeStore,
      sessions: {},
      projectDir: "",
    },
    finalizeLiveAgent(agent, sessionId, options) {
      finalized.push([agent, sessionId, options]);
    },
  });
  const client = chatClientModule.createChatClient(deps);

  client.handleSseEvent(
    "agent-exit",
    {
      agent: "codex",
      code: 0,
      signal: null,
      usage: { totalTokens: 321 },
    },
    { sessionId: "s1" }
  );

  assert.deepEqual(finalized, [
    ["codex", "s1", { error: false, usage: { totalTokens: 321 } }],
  ]);
});

test("sendPrompt abort finalizes live agents instead of sync innerHTML wipe", async () => {
  const finalized = [];
  const runtimeStore = createRuntimeStore();
  const deps = makeDeps({
    runtimeStore,
    promptEl: {
      value: "long reply please",
      disabled: false,
      focused: 0,
      focus() {},
    },
    state: {
      currentSessionId: "s1",
      rightPanelTab: "agents",
      runtimeStore,
      sessions: {},
      projectDir: "",
      selectedAgent: "codex",
      lastAgent: "codex",
    },
    resolvePromptAgent: () => ({ id: "codex", label: "codex" }),
    finalizeLiveAgent(agent, sessionId, options) {
      finalized.push([agent, sessionId, options]);
    },
    fetchImpl: async () => {
      runtimeStore.getOrCreate("s1").liveMessages.set("codex", {
        rawText: "partial",
        setBadge() {},
        bubble: { innerHTML: "LIVE" },
      });
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    },
  });
  const client = chatClientModule.createChatClient(deps);
  await client.sendPrompt();

  assert.equal(finalized.length, 1);
  assert.equal(finalized[0][0], "codex");
  assert.equal(finalized[0][1], "s1");
  assert.deepEqual(finalized[0][2], { error: false });
});

test("sendPrompt rejects when no agent can be resolved", async () => {
  const calls = [];
  const deps = makeDeps({
    promptEl: {
      value: "hello",
      disabled: false,
      focused: 0,
      focus() {
        this.focused += 1;
      },
    },
    resolvePromptAgent: () => null,
    addSystem(text, variant) {
      calls.push(["system", text, variant]);
    },
    setStatus(text, variant) {
      calls.push(["status", text, variant]);
    },
  });
  const client = chatClientModule.createChatClient(deps);

  await client.sendPrompt();

  assert.deepEqual(calls, [
    ["system", "没有可用的 Agent，请先加载模型列表", "error"],
    ["status", "无可用模型", "error"],
  ]);
  assert.equal(deps.promptEl.focused, 1);
});

test("sendPrompt uses a resolved default agent without requiring @mention", async () => {
  const bodies = [];
  const runtimeStore = createRuntimeStore();
  const deps = makeDeps({
    runtimeStore,
    promptEl: {
      value: "hello without mention",
      disabled: false,
      focused: 0,
      focus() {},
    },
    state: {
      currentSessionId: "s1",
      rightPanelTab: "agents",
      runtimeStore,
      sessions: {},
      projectDir: "",
      selectedAgent: "codex",
      lastAgent: "codex",
    },
    resolvePromptAgent: () => ({ id: "codex", label: "codex" }),
    createMessage() {},
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return {
        ok: true,
        body: {
          getReader() {
            return {
              async read() {
                return { done: true, value: undefined };
              },
            };
          },
        },
      };
    },
  });
  const client = chatClientModule.createChatClient(deps);

  await client.sendPrompt();

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].agent, "codex");
  assert.equal(bodies[0].prompt, "hello without mention");
  assert.equal(deps.state.sessions.s1.lastAgent, "codex");
});

test("sendPrompt keeps per-session controllers so another session can run in parallel", async () => {
  const runtimeStore = createRuntimeStore();
  const started = [];

  function hangingFetch(sessionId) {
    return async (_url, init) => {
      started.push(sessionId);
      return {
        ok: true,
        body: {
          getReader() {
            return {
              async read() {
                await new Promise((resolve, reject) => {
                  const signal = init.signal;
                  if (!signal) return;
                  if (signal.aborted) {
                    const err = new Error("aborted");
                    err.name = "AbortError";
                    reject(err);
                    return;
                  }
                  signal.addEventListener(
                    "abort",
                    () => {
                      const err = new Error("aborted");
                      err.name = "AbortError";
                      reject(err);
                    },
                    { once: true }
                  );
                });
                return { done: true, value: undefined };
              },
            };
          },
        },
      };
    };
  }

  const depsA = makeDeps({
    runtimeStore,
    state: {
      currentSessionId: "sA",
      rightPanelTab: "agents",
      runtimeStore,
      sessions: {},
      projectDir: "",
      selectedAgent: "codex",
      lastAgent: "codex",
    },
    promptEl: { value: "a", disabled: false, focus() {} },
    resolvePromptAgent: () => ({ id: "codex" }),
    fetchImpl: hangingFetch("sA"),
  });
  const clientA = chatClientModule.createChatClient(depsA);
  const sendA = clientA.sendPrompt();

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(runtimeStore.getStatus("sA"), "running");
  assert.ok(runtimeStore.get("sA").controller);

  const depsB = makeDeps({
    runtimeStore,
    state: {
      currentSessionId: "sB",
      rightPanelTab: "agents",
      runtimeStore,
      sessions: {},
      projectDir: "",
      selectedagent: "opencode",
      lastagent: "opencode",
    },
    promptEl: { value: "b", disabled: false, focus() {} },
    resolvePromptAgent: () => ({ id: "opencode" }),
    fetchImpl: hangingFetch("sB"),
  });
  const clientB = chatClientModule.createChatClient(depsB);
  const sendB = clientB.sendPrompt();
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(runtimeStore.getStatus("sA"), "running");
  assert.equal(runtimeStore.getStatus("sB"), "running");
  assert.deepEqual(started, ["sA", "sB"]);
  assert.notEqual(runtimeStore.get("sA").controller, runtimeStore.get("sB").controller);

  runtimeStore.abort("sA");
  runtimeStore.abort("sB");
  await Promise.allSettled([sendA, sendB]);
});
