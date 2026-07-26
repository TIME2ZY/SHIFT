const assert = require("node:assert/strict");
const test = require("node:test");

const sessionControllerModule = require("../public/session-controller.js");
const { createRuntimeStore } = require("../public/session-runtime.js");

function makeState(overrides = {}) {
  const runtimeStore = createRuntimeStore();
  return {
    currentSessionId: null,
    selectedAgent: "codex",
    rightPanelTab: "workspace",
    worktreeStatus: { branch: "x" },
    workspace: { old: true },
    projectDir: "/tmp/old",
    ...overrides,
    runtimeStore: overrides.runtimeStore || runtimeStore,
  };
}

function baseDeps(state, extra = {}) {
  return {
    state,
    runtimeStore: state.runtimeStore,
    sessionApi: {
      listSessions: async () => [{ id: "s1" }],
      readMessages: async () => [{ role: "user", agent: "codex", content: "hi" }],
      createSession: async () => ({ id: "s2" }),
      deleteSession: async () => ({ ok: true }),
    },
    renderSessionList() {},
    addSystem() {},
    ensureSpacer() {},
    showEmpty() {},
    createMessage() {},
    messagesEl: { replaceChildren() {} },
    promptEl: { focus() {} },
    projectDirPath: { textContent: "" },
    closeSidebarIfMobile() {},
    loadProjectDir: async () => {},
    loadWorktreeStatus: async () => {},
    loadWorkspaceState: async () => {},
    renderWorktreeStatus() {},
    renderWorkspacePanel() {},
    emptyWorkspaceState: () => ({ empty: true }),
    setStatus() {},
    syncComposerControls() {},
    remountLiveMessages() {},
    ...extra,
  };
}

test("loadSessions auto-switches to the first session when none is active", async () => {
  const state = makeState();
  const seenMessages = [];
  const deps = baseDeps(state, {
    sessionApi: {
      listSessions: async () => [{ id: "s1" }],
      readMessages: async () => [{ role: "user", agent: "codex", content: "hi" }],
    },
    createMessage(msg) { seenMessages.push(msg); },
  });

  const controller = sessionControllerModule.createSessionController(deps);
  await controller.loadSessions();

  assert.equal(state.currentSessionId, "s1");
  assert.deepEqual(seenMessages, [{
    role: "user",
    agent: "codex",
    content: "hi",
    variant: "",
    invocationId: null,
    usage: null,
    showUsage: true,
    scroll: false,
  }]);
});

test("newSession focuses the prompt without clearing other session runtimes", async () => {
  const state = makeState();
  state.runtimeStore.beginRun("s-old", { abort() { throw new Error("should not abort other session"); } });
  let focused = 0;
  const deps = baseDeps(state, {
    promptEl: { value: "", focus() { focused += 1; } },
  });

  const controller = sessionControllerModule.createSessionController(deps);
  await controller.newSession();

  assert.equal(state.currentSessionId, "s2");
  assert.equal(state.runtimeStore.getStatus("s-old"), "running");
  assert.deepEqual(state.workspace, { empty: true });
  assert.equal(focused, 1);
});

test("newSession saves the previous session draft before clearing the composer", async () => {
  const state = makeState({
    currentSessionId: "s-old",
    sessions: {
      "s-old": { lastPrompt: "", lastAgent: "codex", draftPrompt: "" },
    },
  });
  const promptEl = {
    value: "unsent draft for old session",
    focus() {},
  };
  const deps = baseDeps(state, { promptEl });
  const controller = sessionControllerModule.createSessionController(deps);
  await controller.newSession();

  assert.equal(state.currentSessionId, "s2");
  assert.equal(state.sessions["s-old"].draftPrompt, "unsent draft for old session");
  assert.equal(state.sessions.s2.draftPrompt, "");
  assert.equal(promptEl.value, "");
});

test("deleteSession aborts only the deleted session runtime", async () => {
  const state = makeState();
  state.currentSessionId = "s1";
  let aborted = 0;
  let otherAborted = 0;
  state.runtimeStore.beginRun("s1", { abort() { aborted += 1; } });
  state.runtimeStore.beginRun("s2", { abort() { otherAborted += 1; } });

  const deps = baseDeps(state);
  const controller = sessionControllerModule.createSessionController(deps);
  await controller.deleteSession("s1");

  assert.equal(aborted, 1);
  assert.equal(otherAborted, 0);
  assert.equal(state.currentSessionId, null);
  assert.equal(state.runtimeStore.get("s1"), null);
  assert.equal(state.runtimeStore.getStatus("s2"), "running");
  assert.deepEqual(state.workspace, { empty: true });
  assert.equal(deps.projectDirPath.textContent, "(当前目录)");
});

test("switchSession does not abort a running previous session", async () => {
  const state = makeState();
  state.currentSessionId = "s1";
  let aborted = 0;
  state.runtimeStore.beginRun("s1", { abort() { aborted += 1; } });
  state.runtimeStore.get("s1").liveMessages.set("codex", {
    rawText: "partial",
    wrapper: { id: "live-node" },
  });

  const remounted = [];
  const deps = baseDeps(state, {
    sessionApi: {
      listSessions: async () => [{ id: "s1" }, { id: "s2" }],
      readMessages: async () => [{ role: "assistant", agent: "codex", content: "history" }],
    },
    remountLiveMessages(id) { remounted.push(id); },
  });

  // Pretend s2 is also running so remount path is exercised when we switch to it.
  state.runtimeStore.beginRun("s2", { abort() {} });
  state.runtimeStore.get("s2").liveMessages.set("opencode", {
    rawText: "bg",
    wrapper: { id: "bg-node" },
  });

  const controller = sessionControllerModule.createSessionController(deps);
  await controller.switchSession("s2");

  assert.equal(aborted, 0);
  assert.equal(state.currentSessionId, "s2");
  assert.equal(state.runtimeStore.getStatus("s1"), "running");
  assert.deepEqual(remounted, ["s2"]);
});

test("switchSession replays buffered a2a system notices not already in history", async () => {
  const state = makeState();
  state.currentSessionId = "s1";
  state.runtimeStore.beginRun("s2", { abort() {} });
  state.runtimeStore.get("s2").systemNotices = [
    { role: "system", agent: "system", content: "🔄 小筑 → Gemini", kind: "a2a-route" },
    { role: "system", agent: "system", content: "already in history", kind: "a2a-route" },
  ];
  state.runtimeStore.get("s2").liveMessages.set("opencode", {
    rawText: "",
    detached: true,
  });

  const created = [];
  const remounted = [];
  const deps = baseDeps(state, {
    sessionApi: {
      listSessions: async () => [{ id: "s1" }, { id: "s2" }],
      readMessages: async () => [
        { role: "user", agent: "codex", content: "go" },
        { role: "system", agent: "system", content: "already in history" },
      ],
    },
    createMessage(msg) { created.push(msg); },
    remountLiveMessages(id) { remounted.push(id); },
  });

  const controller = sessionControllerModule.createSessionController(deps);
  await controller.switchSession("s2");

  assert.deepEqual(remounted, ["s2"]);
  const systemCreated = created.filter((m) => m.role === "system");
  // history system + one replayed notice (duplicate skipped)
  assert.equal(systemCreated.length, 2);
  assert.equal(systemCreated[0].content, "already in history");
  assert.equal(systemCreated[1].content, "🔄 小筑 → Gemini");
});

test("switchSession ignores stale async loads from an earlier session switch", async () => {
  const state = makeState();
  const seenMessages = [];
  let resolveFirstMessages;
  const firstMessages = new Promise((resolve) => {
    resolveFirstMessages = resolve;
  });
  const deps = baseDeps(state, {
    sessionApi: {
      listSessions: async () => [{ id: "s1" }, { id: "s2" }],
      readMessages: async (id) => {
        if (id === "s1") return firstMessages;
        return [{ role: "assistant", agent: "codex", content: "new" }];
      },
    },
    createMessage(msg) { seenMessages.push([state.currentSessionId, msg.content]); },
  });

  const controller = sessionControllerModule.createSessionController(deps);
  const firstSwitch = controller.switchSession("s1");
  const secondSwitch = controller.switchSession("s2");

  await secondSwitch;
  resolveFirstMessages([{ role: "assistant", agent: "codex", content: "old" }]);
  await firstSwitch;

  assert.equal(state.currentSessionId, "s2");
  assert.deepEqual(seenMessages, [["s2", "new"]]);
});

test("switchSession restores lastAgent from session metadata", async () => {
  const state = makeState({ selectedAgent: "codex" });
  const applied = [];
  const deps = baseDeps(state, {
    sessionApi: {
      listSessions: async () => [{ id: "s1", lastagent: "opencode" }],
      readMessages: async () => [
        { role: "user", agent: "opencode", content: "hi" },
        { role: "assistant", agent: "opencode", content: "hello" },
      ],
    },
    applySessionAgent(sessionId, lastAgent) {
      applied.push([sessionId, lastAgent]);
    },
  });

  const controller = sessionControllerModule.createSessionController(deps);
  await controller.switchSession("s1");

  assert.deepEqual(applied, [["s1", "opencode"]]);
});

test("session lifecycle notifies session-scoped panels", async () => {
  const state = makeState();
  const changed = [];
  const deps = baseDeps(state, {
    onSessionChanged(id) {
      changed.push(id);
    },
  });
  const controller = sessionControllerModule.createSessionController(deps);

  await controller.switchSession("s1");
  await controller.newSession();
  await controller.deleteSession("s2");

  assert.deepEqual(changed, ["s1", "s2", null]);
});
