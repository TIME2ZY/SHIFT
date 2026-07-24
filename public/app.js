(function () {
  "use strict";

  /* ═══════════════════════════════════════════════════════════
     DOM REFS + shared clients
     ═══════════════════════════════════════════════════════════ */

  const $ = (sel) => document.querySelector(sel);

  const messagesEl = $("#messages");
  const promptEl = $("#prompt");
  const btnSend = $("#btn-send");
  const useWorktreeInput = $("#use-worktree");
  const skillsBarEl = $("#skills-bar");
  const statusEl = $("#status");
  const sidebarEl = $("#sidebar");
  const sidebarToggle = $("#sidebar-toggle");
  const sidebarOverlay = $("#sidebar-overlay");
  const sessionListEl = $("#session-list");
  const btnNewChat = $("#btn-new-chat");
  const panelTabAgentsEl = $("#panel-tab-agents");
  const panelTabWorkspaceEl = $("#panel-tab-workspace");
  const panelTabContextEl = $("#panel-tab-context");
  const agentPanelEl = $("#agent-panel");
  const agentTabsEl = $("#agent-tabs");
  const workspacePanelEl = $("#workspace-panel");
  const contextPanelEl = $("#context-panel-inline");
  const emptyStateEl = $("#empty-state");
  const spacerEl = messagesEl.querySelector(".messages-spacer");
  const skillsTagsEl = $("#skills-tags");
  const skillsCountEl = $("#skills-count");
  const themeToggle = $("#theme-toggle");
  const projectDirEl = $("#project-dir");
  const projectDirPath = $("#project-dir-path");
  const worktreeStatusEl = $("#worktree-status");
  const mentionMenuEl = $("#mention-menu");
  // Context tab: one scroll — conclusions + invocation/search records.
  const recallBodyEl = contextPanelEl ? contextPanelEl.querySelector(".recall-body") : null;
  const recallSearchInputEl = contextPanelEl
    ? contextPanelEl.querySelector(".context-search input, .recall-search input")
    : null;
  const currentSessionTitleEl = $("#current-session-title");
  const contextStatusEl = $("#context-status");
  const runBarEl = $("#run-bar");
  const runBarLabelEl = $("#run-bar-label");
  const runBarTimeEl = $("#run-bar-time");
  const runBarStopEl = $("#run-bar-stop");
  const jumpBottomEl = $("#jump-bottom");
  const toastHostEl = $("#toast-host");
  const workspaceTabBadgeEl = $("#workspace-tab-badge");
  const composerSectionEl = document.querySelector("section.composer");

  const apiFetch = window.ApiClient.apiFetch;
  const sessionApi = window.SessionApi.createSessionApi(apiFetch);
  const worktreeApi = window.WorktreeApi.createWorktreeApi(apiFetch);
  const recallApi = window.RecallApi.createRecallApi(apiFetch);
  const memoryApi = window.MemoryApi.createMemoryApi(apiFetch);
  const escHtml = window.MarkdownLite.escHtml;
  const renderMd = window.MarkdownLite.renderMd;
  const writeClipboard = window.ClipboardUtils.writeClipboard;
  const runLatestSkillsRequest = window.LatestRequest.createLatestRequestRunner();
  const agentRouting = window.AgentRouting;
  const bus = window.EventBus.createEventBus();
  const runtimeStore = window.SessionRuntime.createRuntimeStore({ bus });
  const confirmImpl = window.UiConfirm.createConfirm();
  const sidePanelEl = $("#side-panel");

  /* ═══════════════════════════════════════════════════════════
     STATE ownership (see design §4.1)
     - uiStore/state: serializable UI selection only
     - runtimeStore: per-session live runs (not mirrored into state)
     - bus: pub/sub for ui:change / runtime:status
     - DOM: pure derived views; do not treat DOM as source of truth
     ═══════════════════════════════════════════════════════════ */

  const uiStore = window.UiStore.createUiStore({
    bus,
    initial: {
      // UI selection (serializable)
      agents: [],
      selectedAgent: "codex",
      currentSessionId: null,
      skillsMetadata: [],
      // Per-session UI slots (lastPrompt/lastAgent for retry) — not live run data
      sessions: {},
      lastPrompt: "",
      lastAgent: "codex",
      skillDebounce: null,
      projectDir: "",
      worktreeStatus: null,
      mentionOpen: false,
      mentionIndex: 0,
      mentionMatches: [],
      mentionRange: null,
      recallSearchDebounce: null,
      rightPanelTab: "agents", // agents | context | workspace
      workspace: window.WorkspacePanel.emptyWorkspaceState(),
      usageSummary: { available: false, session: {}, agents: [] },
      // NOT live run data — see runtimeStore
      runtimeStore,
    },
  });
  const state = uiStore.state;

  const display = window.DisplayHelpers.createDisplayHelpers({
    getAgents: () => state.agents,
  });
  const {
    agentLabel,
    agentMention,
    agentMeta,
    agentRoleSummary,
    agentColorIndex,
    roleDisplayName,
    roleBadgeLabel,
    fmtTime,
  } = display;

  const theme = window.Theme.createThemeController({
    toggleEl: themeToggle,
    root: document.documentElement,
    storage: localStorage,
  });
  theme.init();
  theme.bindClick();

  /* ═══════════════════════════════════════════════════════════
     Orchestrator helpers
     ═══════════════════════════════════════════════════════════ */

  function sessionSlot() {
    const sid = state.currentSessionId || "_pending";
    if (!state.sessions[sid]) {
      state.sessions[sid] = { lastPrompt: "", lastAgent: state.selectedAgent || "codex" };
    }
    return state.sessions[sid];
  }

  const localePack = window.Locale || window.LocaleZhCN;
  const L = (localePack && localePack.locale) || {};

  function formatElapsed(ms) {
    const sec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  let runBarTimerId = null;

  function clearRunBarTimer() {
    if (runBarTimerId != null) {
      clearInterval(runBarTimerId);
      runBarTimerId = null;
    }
  }

  function activeRunAgentNames(rt) {
    if (!rt) return "";
    const ids = [];
    if (rt.liveMessages && typeof rt.liveMessages.keys === "function") {
      for (const id of rt.liveMessages.keys()) ids.push(id);
    }
    if (ids.length === 0 && state.selectedAgent) ids.push(state.selectedAgent);
    return ids.map((id) => agentLabel(id)).join(" · ");
  }

  function updateRunBar() {
    if (!runBarEl) return;
    const rt = runtimeStore.get(state.currentSessionId || "_pending");
    const running = !!(rt && rt.controller);
    if (!running) {
      runBarEl.hidden = true;
      clearRunBarTimer();
      if (composerSectionEl) composerSectionEl.classList.remove("is-running");
      return;
    }
    runBarEl.hidden = false;
    if (composerSectionEl) composerSectionEl.classList.add("is-running");
    const names = activeRunAgentNames(rt);
    const labelFn = L.runBar && L.runBar.label;
    if (runBarLabelEl) {
      runBarLabelEl.textContent =
        typeof labelFn === "function" ? labelFn(names) : names ? `${names} · 生成中` : "生成中…";
    }
    const started = rt.startedAt || rt.updatedAt || Date.now();
    if (runBarTimeEl) runBarTimeEl.textContent = formatElapsed(Date.now() - started);
    if (runBarTimerId == null) {
      runBarTimerId = setInterval(() => {
        const cur = runtimeStore.get(state.currentSessionId || "_pending");
        if (!cur || !cur.controller) {
          updateRunBar();
          return;
        }
        const t0 = cur.startedAt || cur.updatedAt || Date.now();
        if (runBarTimeEl) runBarTimeEl.textContent = formatElapsed(Date.now() - t0);
      }, 1000);
    }
  }

  function autoGrowPrompt() {
    if (!promptEl) return;
    promptEl.style.height = "auto";
    const maxPx = Math.min(window.innerHeight * 0.34, 280);
    const next = Math.min(Math.max(promptEl.scrollHeight, 44), maxPx);
    promptEl.style.height = `${next}px`;
  }

  function showToast(message, options = {}) {
    if (!toastHostEl || !message) return;
    const el = document.createElement("button");
    el.type = "button";
    el.className = "toast";
    el.textContent = message;
    if (options.actionLabel) {
      const act = document.createElement("span");
      act.className = "toast-action";
      act.textContent = options.actionLabel;
      el.appendChild(act);
    }
    const dismiss = () => {
      el.remove();
    };
    el.addEventListener("click", () => {
      if (typeof options.onClick === "function") options.onClick();
      dismiss();
    });
    toastHostEl.appendChild(el);
    const ttl = typeof options.ttl === "number" ? options.ttl : 5200;
    setTimeout(dismiss, ttl);
  }

  function updateWorkspaceTabBadge() {
    if (!workspaceTabBadgeEl) return;
    const files = Array.isArray(state.workspace && state.workspace.files)
      ? state.workspace.files.length
      : 0;
    const wt = state.worktreeStatus;
    const dirty = files > 0 || (wt && wt.clean === false);
    if (!dirty) {
      workspaceTabBadgeEl.hidden = true;
      workspaceTabBadgeEl.textContent = "";
      return;
    }
    workspaceTabBadgeEl.hidden = false;
    workspaceTabBadgeEl.textContent = files > 0 ? String(files) : "!";
    workspaceTabBadgeEl.title = files > 0 ? `${files} 个文件有改动` : "工作区有未提交改动";
  }

  function updateJumpBottomVisibility() {
    if (!jumpBottomEl || !messageView || typeof messageView.isNearBottom !== "function") return;
    // Hide when empty state is showing or already near bottom.
    const emptyVisible = emptyStateEl && emptyStateEl.parentNode === messagesEl;
    if (emptyVisible) {
      jumpBottomEl.hidden = true;
      return;
    }
    jumpBottomEl.hidden = messageView.isNearBottom();
  }

  // Filled after messageView is created.
  let messageView = null;

  function syncComposerControls() {
    const rt = runtimeStore.get(state.currentSessionId || "_pending");
    const running = !!(rt && rt.controller);
    // Keep the textarea editable while generating so users can draft the next prompt.
    promptEl.disabled = false;
    const sendLabel = running
      ? (L.composer && L.composer.stop) || "停止"
      : (L.composer && L.composer.send) || "发送";
    btnSend.textContent = sendLabel;
    btnSend.setAttribute("aria-busy", running ? "true" : "false");
    btnSend.setAttribute(
      "aria-label",
      running ? (L.composer && L.composer.stopGenerate) || "停止生成" : "发送"
    );
    if (running) btnSend.classList.add("danger");
    else btnSend.classList.remove("danger");
    if (running) {
      promptEl.setAttribute(
        "title",
        (L.composer && L.composer.draftWhileRunning) || "生成中仍可编辑草稿"
      );
    } else {
      promptEl.removeAttribute("title");
    }
    updateRunBar();
  }

  function setStatus(text, cls) {
    if (!text || text === "就绪") {
      statusEl.style.display = "none";
      return;
    }
    statusEl.style.display = "";
    statusEl.textContent = text;
    statusEl.className = "main-status" + (cls ? " " + cls : "");
  }

  async function jsonOrThrow(res) {
    const text = await res.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      /* keep text */
    }
    if (!res.ok) {
      const err = new Error(data.error || `${res.status} ${res.statusText}`);
      err.body = text;
      throw err;
    }
    return data;
  }

  function resolvePromptAgent(prompt) {
    const slot = sessionSlot();
    return agentRouting.resolvePromptAgent({
      prompt,
      agents: state.agents,
      selectedAgent: state.selectedAgent,
      lastAgent: slot.lastAgent || state.lastAgent,
      defaultAgent: "codex",
    }).agent;
  }

  function setDefaultAgent(agentId, options = {}) {
    const known = state.agents.find((a) => a.id === agentId);
    if (!known) return;
    uiStore.patch({ selectedAgent: known.id, lastAgent: known.id }, { source: "setDefaultAgent" });
    sessionSlot().lastAgent = known.id;
    bus.emit("agent:default", { agentId: known.id });
    if (options.render !== false) {
      renderAgentTabs();
      renderCurrentAgent();
    }
  }

  function applySessionAgent(sessionId, lastAgent) {
    const sid = sessionId || state.currentSessionId || "_pending";
    if (!state.sessions[sid]) state.sessions[sid] = { lastPrompt: "", lastAgent: "" };
    const agentId = lastAgent || state.selectedAgent || "codex";
    const known = state.agents.find((a) => a.id === agentId);
    const resolvedId = known ? known.id : state.agents[0]?.id || "codex";
    state.sessions[sid].lastAgent = resolvedId;
    if (sid === state.currentSessionId || !state.currentSessionId) {
      uiStore.patch(
        { selectedAgent: resolvedId, lastAgent: resolvedId },
        { source: "applySessionAgent" }
      );
      renderAgentTabs();
      renderCurrentAgent();
    }
  }

  /* ═══════════════════════════════════════════════════════════
     Feature modules
     ═══════════════════════════════════════════════════════════ */

  const projectHeader = window.ProjectHeader.createProjectHeader({
    projectDirEl,
    projectDirPath,
    worktreeStatusEl,
    state,
    sessionApi,
    worktreeApi,
  });
  projectHeader.bindProjectDirEdit();
  const {
    loadProjectDir,
    loadWorktreeStatus: loadWorktreeStatusCore,
    renderWorktreeStatus,
  } = projectHeader;

  async function loadWorktreeStatus(sessionId) {
    await loadWorktreeStatusCore(sessionId);
    updateWorkspaceTabBadge();
  }

  async function loadWorkspaceState() {
    await workspacePanel.loadWorkspaceState();
    updateWorkspaceTabBadge();
  }

  const workspacePanel = window.WorkspacePanel.createWorkspacePanel({
    panelEl: workspacePanelEl,
    state,
    worktreeApi,
    escHtml,
    WorkspaceDiff: window.WorkspaceDiff,
    VirtualList: window.VirtualList,
    confirmImpl,
    onAfterDiscard: async () => {
      await loadWorktreeStatus();
      updateWorkspaceTabBadge();
    },
  });

  // One process-panel renderer for message hydrate + recall expand (locale injected).
  const processPanelRenderer = window.MessageView.createProcessPanelRenderer();

  // Lazy bind: messageView.focusProcessPanel is available after createMessageView.
  let focusProcessPanelRef = null;

  const recallPanel = window.RecallPanel.createRecallPanel({
    bodyEl: recallBodyEl,
    searchInputEl: recallSearchInputEl,
    state,
    recallApi,
    agentLabel,
    fmtTime,
    escHtml,
    locale: window.Locale || window.LocaleZhCN,
    buildProcessPanelFromEvents: (events, opts) => processPanelRenderer.fromEvents(events, opts),
    focusProcessPanel: (wrapper, opts) =>
      typeof focusProcessPanelRef === "function" ? focusProcessPanelRef(wrapper, opts) : false,
  });
  recallPanel.bindSearch();

  const memoryPanel = window.MemoryPanel.createMemoryPanel({
    bodyEl: contextPanelEl ? contextPanelEl.querySelector(".memory-body") : null,
    injectEl: $("#memory-inject-inline"),
    memoryApi,
    getSessionId: () => state.currentSessionId,
    productOnly: true,
    showConfirm: false,
    escHtml,
    t: (path, fallback) => {
      const locale = window.Locale || window.LocaleZhCN;
      if (locale && typeof locale.t === "function") return locale.t(path, fallback);
      return fallback || path;
    },
    onToast: (message, isError) => {
      if (typeof setStatus === "function") setStatus(message, isError ? "error" : "ok");
    },
  });
  memoryPanel.bind();

  function loadContextPanel() {
    memoryPanel.load();
    recallPanel.loadRecallList();
  }

  let sessionController = null;
  let chatClient = null;
  let renderAgentTabs = () => {};
  let renderCurrentAgent = () => {};
  let usageLoadToken = 0;
  let usageRefreshTimer = null;

  async function loadUsageSummary(sessionId = state.currentSessionId) {
    if (!sessionId) {
      state.usageSummary = { available: false, session: {}, agents: [] };
      renderAgentTabs();
      return state.usageSummary;
    }
    const token = ++usageLoadToken;
    try {
      const summary = await sessionApi.readUsage(sessionId);
      if (token !== usageLoadToken || state.currentSessionId !== sessionId) return null;
      state.usageSummary = summary;
      renderAgentTabs();
      return summary;
    } catch (error) {
      console.warn("Usage summary load failed:", error.message);
      return null;
    }
  }

  messageView = window.MessageView.createMessageView({
    messagesEl,
    emptyStateEl,
    spacerEl,
    state,
    runtimeStore,
    renderMd,
    writeClipboard,
    roleDisplayName,
    roleBadgeLabel,
    agentColorIndex,
    attachRecallToggle: recallPanel.attachRecallToggle,
    fetchInvocationEvents: recallPanel.fetchInvocationEvents,
    onRuntimeStatusChange,
    setStatus,
    getSessionController: () => sessionController,
    loadWorktreeStatus,
    loadWorkspaceState,
    syncComposerControls,
    getSessionSlot: sessionSlot,
    renderAgentTabs: () => renderAgentTabs(),
    getChatClient: () => chatClient,
    promptEl,
  });
  focusProcessPanelRef = messageView.focusProcessPanel;
  messageView.bindCodeBlockDelegates(document);

  const {
    createMessage,
    showThinking,
    appendLive,
    applyAgentEvent,
    flushPendingLiveRender,
    finishStream: finishStreamCore,
    finalizeLiveAgent,
    remountLiveMessages,
    addSystem,
    addDebug,
    ensureSpacer,
    showEmpty,
  } = messageView;

  async function finishStream(statusText, sessionId) {
    finishStreamCore(statusText, sessionId);
    if (sessionId && state.currentSessionId && sessionId !== state.currentSessionId) {
      updateRunBar();
      return;
    }
    try {
      await loadWorktreeStatus();
      await loadUsageSummary(sessionId || state.currentSessionId);
      if (state.rightPanelTab === "workspace") {
        await workspacePanel.loadWorkspaceState();
      }
      updateWorkspaceTabBadge();
      const files = Array.isArray(state.workspace && state.workspace.files)
        ? state.workspace.files.length
        : 0;
      const dirty = files > 0 || (state.worktreeStatus && state.worktreeStatus.clean === false);
      if (dirty && state.rightPanelTab !== "workspace") {
        const toastFn = L.toast && L.toast.workspaceDirty;
        const text =
          typeof toastFn === "function"
            ? toastFn(files)
            : files > 0
              ? `${files} 个文件有改动 · 查看工作区`
              : "工作区有改动 · 查看工作区";
        showToast(text, {
          actionLabel: "打开",
          onClick: () => activateRightTab("workspace"),
        });
      }
    } catch {
      /* non-fatal UX hook */
    }
    updateRunBar();
    updateJumpBottomVisibility();
  }

  function onRuntimeStatusChange(sessionId) {
    const sid = sessionId || state.currentSessionId;
    if (sid && typeof sessionListView?.updateStatus === "function") {
      sessionListView.updateStatus(sid, runtimeStore.getStatus(sid));
      return;
    }
    if (typeof sessionController?.refreshSessionList === "function") {
      sessionController.refreshSessionList();
    }
  }

  function toggleSidebar() {
    const open = sidebarEl.classList.toggle("open");
    if (sidebarToggle) sidebarToggle.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function closeSidebarIfMobile() {
    if (window.innerWidth <= 700) sidebarEl.classList.remove("open");
  }

  sidebarToggle.addEventListener("click", toggleSidebar);
  sidebarOverlay.addEventListener("click", toggleSidebar);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sidebarEl.classList.contains("open")) toggleSidebar();
  });

  let sessionListView = null;

  function renderSessionList(sessions) {
    if (sessionListView) sessionListView.render(sessions);
    if (currentSessionTitleEl) {
      const current = Array.isArray(sessions)
        ? sessions.find((session) => session && session.id === state.currentSessionId)
        : null;
      const title = current && current.title ? current.title : "新会话";
      currentSessionTitleEl.textContent = title;
      currentSessionTitleEl.title = title;
    }
  }

  sessionListView = window.SessionListView.createSessionListView({
    sessionListEl,
    getCurrentSessionId: () => state.currentSessionId,
    getRuntimeStatus: (id) => runtimeStore.getStatus(id),
    onSelect: (id) => {
      sessionController.switchSession(id);
      closeSidebarIfMobile();
    },
    onDelete: async (id) => {
      const ok = await confirmImpl("确认删除此对话？删除后无法恢复。", {
        title: "删除对话",
        danger: true,
        confirmLabel: "删除",
      });
      if (ok) sessionController.deleteSession(id);
    },
    fmtTime,
    escHtml,
  });

  sessionController = window.SessionController.createSessionController({
    state,
    runtimeStore,
    sessionApi,
    renderSessionList,
    addSystem,
    ensureSpacer,
    showEmpty,
    createMessage,
    messagesEl,
    spacerEl,
    promptEl,
    projectDirPath,
    closeSidebarIfMobile,
    loadProjectDir,
    loadWorktreeStatus,
    loadWorkspaceState,
    renderWorktreeStatus,
    renderWorkspacePanel: () => workspacePanel.renderWorkspacePanel(),
    emptyWorkspaceState: () => window.WorkspacePanel.emptyWorkspaceState(),
    setStatus,
    applySessionAgent,
    remountLiveMessages,
    syncComposerControls,
    loadUsageSummary,
    onSessionChanged: () => {
      if (state.rightPanelTab === "context") loadContextPanel();
    },
  });

  const RIGHT_TABS = ["agents", "context", "workspace"];
  const tabButtons = {
    agents: panelTabAgentsEl,
    context: panelTabContextEl,
    workspace: panelTabWorkspaceEl,
  };

  function setRightPanelTab(nextTab) {
    // Migrate legacy tab ids from older sessions / tests.
    if (nextTab === "recall" || nextTab === "memory") nextTab = "context";
    uiStore.patch({ rightPanelTab: nextTab }, { source: "setRightPanelTab" });
    bus.emit("panel:tab", { tab: nextTab });
    if (agentPanelEl) agentPanelEl.hidden = nextTab !== "agents";
    if (contextPanelEl) contextPanelEl.hidden = nextTab !== "context";
    if (workspacePanelEl) workspacePanelEl.hidden = nextTab !== "workspace";

    for (const id of RIGHT_TABS) {
      const btn = tabButtons[id];
      if (!btn) continue;
      const active = id === nextTab;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
      btn.tabIndex = active ? 0 : -1;
    }

    // Mobile-only height boost for context/workspace (CSS gated @media max-width 700px).
    if (sidePanelEl) {
      sidePanelEl.classList.toggle(
        "is-expanded",
        nextTab === "workspace" || nextTab === "context"
      );
    }

    if (nextTab === "context") loadContextPanel();
  }

  async function activateRightTab(nextTab) {
    setRightPanelTab(nextTab);
    if (nextTab === "workspace") await loadWorkspaceState();
  }

  panelTabAgentsEl.addEventListener("click", () => activateRightTab("agents"));
  panelTabWorkspaceEl.addEventListener("click", () => activateRightTab("workspace"));
  if (panelTabContextEl) {
    panelTabContextEl.addEventListener("click", () => activateRightTab("context"));
  }

  const tablistEl = document.querySelector(".panel-tabs");
  if (tablistEl) {
    tablistEl.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End")
        return;
      const idx = RIGHT_TABS.indexOf(state.rightPanelTab);
      if (idx < 0) return;
      e.preventDefault();
      let next = idx;
      if (e.key === "ArrowRight") next = (idx + 1) % RIGHT_TABS.length;
      if (e.key === "ArrowLeft") next = (idx - 1 + RIGHT_TABS.length) % RIGHT_TABS.length;
      if (e.key === "Home") next = 0;
      if (e.key === "End") next = RIGHT_TABS.length - 1;
      activateRightTab(RIGHT_TABS[next]).then(() => {
        const btn = tabButtons[RIGHT_TABS[next]];
        if (btn) btn.focus();
      });
    });
  }

  function renderSkillTags(active) {
    if (!skillsBarEl) return;
    const set = new Set(active || []);
    const meta = Array.isArray(state.skillsMetadata) ? state.skillsMetadata : [];
    const enabled = meta.filter((skill) => set.has(skill.name));
    if (enabled.length === 0) {
      skillsBarEl.hidden = true;
      if (skillsTagsEl) skillsTagsEl.replaceChildren();
      return;
    }
    const tags = enabled.map((s) => {
      const tag = document.createElement("span");
      tag.className = "skill-tag";
      tag.textContent = s.name;
      tag.title = s.description;
      return tag;
    });
    skillsBarEl.hidden = false;
    if (skillsCountEl) skillsCountEl.textContent = String(enabled.length);
    if (skillsTagsEl) skillsTagsEl.replaceChildren(...tags);
  }

  function scheduleUsageSummary(sessionId) {
    if (!sessionId || sessionId !== state.currentSessionId) return;
    clearTimeout(usageRefreshTimer);
    usageRefreshTimer = setTimeout(() => loadUsageSummary(sessionId), 300);
  }

  function updateActiveSkills(prompt) {
    clearTimeout(state.skillDebounce);
    state.skillDebounce = setTimeout(async () => {
      try {
        const result = await runLatestSkillsRequest.run(() =>
          apiFetch(`/api/skills?prompt=${encodeURIComponent(prompt || "")}`).then(jsonOrThrow)
        );
        if (result.applied) renderSkillTags(result.value.active);
      } catch (error) {
        console.warn("Active skills load failed:", error);
      }
    }, 300);
  }

  function insertAgentMention(agent) {
    const mention = `@${agentMention(agent)} `;
    const current = promptEl.value;
    const leadingAgent = agentRouting.findExplicitLeadingAgent(current, state.agents);

    if (!current.trim()) {
      promptEl.value = mention;
    } else if (leadingAgent) {
      const trimmedStart = current.match(/^\s*/)?.[0] || "";
      const start = trimmedStart.length;
      const afterStart = current.slice(start);
      const token = `@${agentMention(leadingAgent)}`;
      const idToken = `@${leadingAgent.id}`;
      const oldToken = afterStart.startsWith(token) ? token : idToken;
      promptEl.value = trimmedStart + mention + afterStart.slice(oldToken.length).trimStart();
    } else {
      promptEl.value = mention + current;
    }

    setDefaultAgent(agent.id, { render: true });
    promptEl.setSelectionRange(promptEl.value.length, promptEl.value.length);
    updateActiveSkills(promptEl.value);
    mentionComposer.hide();
    promptEl.focus();
  }

  const agentPanelView = window.AgentPanelView.createAgentPanelView({
    agentTabsEl,
    contextStatusEl,
    state,
    agentLabel,
    agentMention,
    agentMeta,
    agentRoleSummary,
    agentColorIndex,
    setDefaultAgent,
    insertAgentMention,
    promptEl,
  });
  renderAgentTabs = agentPanelView.renderAgentTabs;
  renderCurrentAgent = agentPanelView.renderCurrentAgent;

  if (contextStatusEl) {
    contextStatusEl.addEventListener("click", () => activateRightTab("agents"));
  }

  async function loadAgents() {
    try {
      const res = await apiFetch("/api/agents");
      const data = await jsonOrThrow(res);
      state.agents = data.agents;
      if (!state.agents.find((a) => a.id === state.selectedAgent)) {
        state.selectedAgent = state.agents[0]?.id || "codex";
      }
      state.lastAgent = state.selectedAgent;
      renderAgentTabs();
      renderCurrentAgent();
    } catch (e) {
      addSystem("加载 Agent 列表失败: " + e.message, "error");
      setStatus("加载 Agent 失败", "error");
    }
  }

  const mentionComposer = window.MentionComposer.createMentionComposer({
    promptEl,
    menuEl: mentionMenuEl,
    state,
    getAgents: () => state.agents,
    setDefaultAgent,
    agentMention,
    agentMeta,
    updateActiveSkills,
  });

  chatClient = window.ChatClient.createChatClient({
    state,
    runtimeStore,
    promptEl,
    btnSend,
    useWorktreeInput,
    resolvePromptAgent,
    addSystem,
    setStatus,
    sessionApi,
    createMessage,
    hideMentionMenu: () => mentionComposer.hide(),
    fetchImpl: apiFetch,
    flushPendingLiveRender,
    sessionController,
    loadProjectDir,
    loadWorktreeStatus,
    loadWorkspaceState,
    renderSkillTags,
    showThinking,
    appendLive,
    applyAgentEvent,
    addDebug,
    finishStream,
    finalizeLiveAgent,
    agentLabel,
    syncComposerControls,
    onRuntimeStatusChange,
    onUsageEvent: (_event, sessionId) => scheduleUsageSummary(sessionId),
    onMemoryEvent: (payload, sessionId) => {
      const sid = (payload && payload.sessionId) || sessionId;
      if (sid && state.currentSessionId && sid !== state.currentSessionId) return;
      if (state.rightPanelTab === "context") memoryPanel.load();
      const action = payload && payload.action;
      const locale = window.Locale || window.LocaleZhCN;
      const t = (path, fallback) =>
        locale && typeof locale.t === "function" ? locale.t(path, fallback) : fallback || path;
      if (action === "invalidate") {
        setStatus(t("memory.agentInvalidated", "Agent 已否定一条记忆"), "ok");
      } else {
        setStatus(t("memory.agentWrote", "Agent 已写入记忆"), "ok");
      }
    },
    onMemoryInject: (payload, sessionId) => {
      const sid = (payload && payload.sessionId) || sessionId;
      if (sid && state.currentSessionId && sid !== state.currentSessionId) return;
      if (typeof memoryPanel.setInjectPreview === "function") {
        memoryPanel.setInjectPreview(payload);
      }
      const count = Number(payload && payload.count) || 0;
      if (count > 0 && state.rightPanelTab !== "context") {
        const locale = window.Locale || window.LocaleZhCN;
        const t = (path, fallback) =>
          locale && typeof locale.t === "function" ? locale.t(path, fallback) : fallback || path;
        setStatus(
          t("memory.injectedSummary", "本回合注入 {{n}} 条").replace("{{n}}", String(count)),
          "ok"
        );
      }
    },
    onMemoryMetrics: (payload, sessionId) => {
      const sid = (payload && payload.threadId) || sessionId;
      if (sid && state.currentSessionId && sid !== state.currentSessionId) return;
      const total = Number(payload && payload.totalWrites) || 0;
      if (total > 0 && state.rightPanelTab === "context") memoryPanel.load();
    },
  });

  /* ═══════════════════════════════════════════════════════════
     Event bindings + init
     ═══════════════════════════════════════════════════════════ */

  function abortActiveRun() {
    runtimeStore.abort(state.currentSessionId);
  }

  btnNewChat.addEventListener("click", () => sessionController.newSession());
  btnSend.addEventListener("click", () => {
    const rt = runtimeStore.get(state.currentSessionId || "_pending");
    if (rt && rt.controller) {
      abortActiveRun();
      return;
    }
    chatClient.sendPrompt();
    autoGrowPrompt();
  });
  if (runBarStopEl) {
    runBarStopEl.addEventListener("click", () => abortActiveRun());
  }

  if (jumpBottomEl) {
    jumpBottomEl.addEventListener("click", () => {
      if (messageView && typeof messageView.scrollDown === "function") {
        messageView.scrollDown(true);
      }
      jumpBottomEl.hidden = true;
    });
  }
  messagesEl.addEventListener(
    "scroll",
    () => {
      updateJumpBottomVisibility();
    },
    { passive: true }
  );

  promptEl.addEventListener("input", () => {
    autoGrowPrompt();
    updateActiveSkills(promptEl.value);
    mentionComposer.update();
  });
  promptEl.addEventListener("click", () => mentionComposer.update());
  promptEl.addEventListener("keyup", (e) => {
    if (["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(e.key)) return;
    mentionComposer.update();
  });
  promptEl.addEventListener("keydown", (e) => {
    // IME composition: skip shortcuts while composing CJK candidates.
    if (e.isComposing || e.keyCode === 229) return;
    if (mentionComposer.handleKeydown(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const rt = runtimeStore.get(state.currentSessionId || "_pending");
      // While generating, Enter does not send (draft stays); use 停止 to abort.
      if (rt && rt.controller) return;
      chatClient.sendPrompt();
      autoGrowPrompt();
    }
  });

  // After send clears the textarea (chat-client), re-fit height.
  const promptValueDesc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
  if (promptValueDesc && promptValueDesc.set) {
    const nativeSet = promptValueDesc.set;
    Object.defineProperty(promptEl, "value", {
      configurable: true,
      enumerable: promptValueDesc.enumerable,
      get: promptValueDesc.get,
      set(v) {
        nativeSet.call(this, v);
        autoGrowPrompt();
      },
    });
  }

  bus.on("runtime:status", () => {
    syncComposerControls();
    updateJumpBottomVisibility();
  });

  setRightPanelTab("agents");
  loadProjectDir();
  workspacePanel.renderWorkspacePanel();
  renderSkillTags([]);
  autoGrowPrompt();
  updateRunBar();
  updateWorkspaceTabBadge();
  updateJumpBottomVisibility();

  const emptyChipsEl = $("#empty-state-chips");
  if (emptyChipsEl) {
    emptyChipsEl.addEventListener("click", (e) => {
      const chip = e.target && e.target.closest ? e.target.closest(".empty-chip") : null;
      if (!chip || !promptEl) return;
      const text = chip.getAttribute("data-prompt") || chip.textContent || "";
      if (!text.trim()) return;
      promptEl.value = text.trim();
      promptEl.focus();
      autoGrowPrompt();
      updateActiveSkills(promptEl.value);
      const len = promptEl.value.length;
      try {
        promptEl.setSelectionRange(len, len);
      } catch {
        /* ignore */
      }
    });
  }

  apiFetch("/api/skills")
    .then(jsonOrThrow)
    .then((d) => {
      state.skillsMetadata = d.skills || [];
      renderSkillTags([]);
    })
    .catch((e) => console.warn("Skills metadata load failed:", e));

  Promise.all([loadAgents(), sessionController.loadSessions()]).catch(() => {
    setStatus("加载失败", "error");
  });
})();
