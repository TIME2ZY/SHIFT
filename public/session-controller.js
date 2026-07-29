(function initSessionController(globalScope) {
  "use strict";

  function createSessionController(deps) {
    const {
      state,
      runtimeStore,
      sessionApi,
      renderSessionList,
      addSystem,
      ensureSpacer,
      showEmpty,
      createMessage,
      organizeCollabMessages,
      messagesEl,
      promptEl,
      projectDirPath,
      closeSidebarIfMobile,
      loadProjectDir,
      loadWorktreeStatus,
      loadWorkspaceState,
      renderWorktreeStatus,
      renderWorkspacePanel,
      emptyWorkspaceState,
      setStatus,
      applySessionAgent,
      remountLiveMessages,
      syncComposerControls,
      loadUsageSummary,
      onSessionChanged,
    } = deps;
    let switchToken = 0;

    function store() {
      return runtimeStore || state.runtimeStore;
    }

    function notifySessionAgent(sessionId, sessions, messages) {
      if (typeof applySessionAgent !== "function") return;
      const meta = Array.isArray(sessions) ? sessions.find((s) => s && s.id === sessionId) : null;
      let lastAgent = meta && typeof meta.lastAgent === "string" ? meta.lastAgent : "";
      if (!lastAgent && Array.isArray(messages)) {
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const msg = messages[i];
          if (msg && msg.role === "user" && typeof msg.agent === "string" && msg.agent) {
            lastAgent = msg.agent;
            break;
          }
        }
      }
      applySessionAgent(sessionId, lastAgent || "");
    }

    function ensureSlot(sid) {
      if (!sid) return null;
      if (!state.sessions) state.sessions = {};
      if (!state.sessions[sid]) state.sessions[sid] = { lastPrompt: "", lastAgent: "codex" };
      return state.sessions[sid];
    }

    function saveDraftFor(sid) {
      if (!sid || !promptEl) return;
      const slot = ensureSlot(sid);
      if (!slot) return;
      slot.draftPrompt = promptEl.value;
    }

    function restoreDraftFor(sid) {
      if (!sid || !promptEl) return;
      const slot = ensureSlot(sid);
      promptEl.value = slot.draftPrompt || "";
      if (typeof window !== "undefined" && window.document) {
        promptEl.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (typeof promptEl.dispatchEvent === "function") {
        promptEl.dispatchEvent(new Event("input"));
      }
    }

    async function refreshSessionList() {
      try {
        const sessions = await sessionApi.listSessions();
        renderSessionList(sessions);
        return sessions;
      } catch {
        return [];
      }
    }

    async function switchSession(id) {
      const token = ++switchToken;
      if (id === state.currentSessionId) return;

      // Do not abort the previous session's background run. Only change the
      // display target; each session keeps its own controller/live state.
      const previousSessionId = state.currentSessionId;
      // Preserve an unsent draft so switching away does not lose work.
      saveDraftFor(previousSessionId);
      state.currentSessionId = id;
      if (typeof onSessionChanged === "function") onSessionChanged(id);
      messagesEl.replaceChildren();

      let loadedMessages = null;
      try {
        const messages = await sessionApi.readMessages(id);
        loadedMessages = messages;
        if (token !== switchToken || state.currentSessionId !== id) return;
        if (!messages || messages.length === 0) {
          ensureSpacer();
          showEmpty();
        } else {
          // Bulk insert: skip per-message scroll/animation thrash; one jump at end.
          if (messagesEl && messagesEl.classList) {
            messagesEl.classList.add("is-bulk-insert");
          }
          try {
            for (const msg of messages) {
              createMessage({
                role: msg.role,
                agent: msg.agent || msg.agentId || null,
                content: msg.content || "",
                variant: msg.exitCode && msg.exitCode !== 0 ? "error" : "",
                invocationId: msg.invocationId || null,
                usage: msg.usage || null,
                showUsage: msg.source !== "callback",
                scroll: false,
                kind: msg.kind || msg.messageType || msg.metadata?.kind || "",
                messageType: msg.messageType || msg.kind || "",
                from: msg.from || msg.metadata?.from || null,
                to: msg.to || msg.metadata?.to || null,
                handoffId: msg.handoffId || msg.metadata?.handoffId || null,
                routeStatus: msg.routeStatus || msg.metadata?.routeStatus || null,
              });
            }
            if (typeof organizeCollabMessages === "function") {
              organizeCollabMessages({ openLast: true });
            }
          } finally {
            if (messagesEl && messagesEl.classList) {
              messagesEl.classList.remove("is-bulk-insert");
            }
          }
          ensureSpacer();
          if (typeof messagesEl.scrollTop === "number") {
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
        }
      } catch (error) {
        state.currentSessionId = previousSessionId;
        if (typeof onSessionChanged === "function") onSessionChanged(previousSessionId);
        addSystem("加载消息失败: " + error.message, "error");
        ensureSpacer();
      }

      if (token !== switchToken || state.currentSessionId !== id) return;

      const rt = store() ? store().get(id) : null;
      if (rt && rt.status === "running") {
        // Replay a2a-route (and similar) system notices that may have been
        // buffered while this session was in the background. Prefer notices
        // not already present in the transcript-backed history load.
        if (Array.isArray(rt.systemNotices) && rt.systemNotices.length > 0) {
          const historySystem = new Set(
            (Array.isArray(loadedMessages) ? loadedMessages : [])
              .filter((m) => m && m.role === "system" && m.content)
              .map((m) => String(m.content))
          );
          for (const notice of rt.systemNotices) {
            if (!notice || !notice.content) continue;
            if (historySystem.has(String(notice.content))) continue;
            createMessage({
              role: notice.role || "system",
              agent: notice.agent || "system",
              content: notice.content,
              variant: notice.variant || "",
              kind: notice.kind || "",
              messageType: notice.kind || "",
              from: notice.from || null,
              to: notice.to || null,
              handoffId: notice.handoffId || null,
              routeStatus: notice.routeStatus || null,
            });
          }
        }
        // Rebuild live bubbles for an in-flight background stream only.
        // Completed agents are removed from liveMessages on agent-exit so
        // history assistant bubbles are not duplicated.
        if (typeof remountLiveMessages === "function") {
          remountLiveMessages(id);
        }
      }

      const sessions = await refreshSessionList();
      if (token !== switchToken || state.currentSessionId !== id) return;
      notifySessionAgent(id, sessions, loadedMessages);
      if (token !== switchToken || state.currentSessionId !== id) return;
      await loadProjectDir(id);
      if (token !== switchToken || state.currentSessionId !== id) return;
      await loadWorktreeStatus();
      if (token !== switchToken || state.currentSessionId !== id) return;
      if (typeof loadUsageSummary === "function") await loadUsageSummary(id);
      if (token !== switchToken || state.currentSessionId !== id) return;
      if (state.rightPanelTab === "workspace") {
        await loadWorkspaceState();
      }
      if (typeof syncComposerControls === "function") syncComposerControls();
      // Restore any draft the user had saved for this session, after the UI has settled.
      restoreDraftFor(id);
    }

    async function loadSessions() {
      const sessions = await refreshSessionList();
      if (!state.currentSessionId && sessions.length > 0) {
        try {
          await switchSession(sessions[0].id);
        } catch {}
      }
    }

    async function newSession() {
      try {
        // Preserve the leaving session's unsent draft (same as switchSession).
        const previousSessionId = state.currentSessionId;
        saveDraftFor(previousSessionId);
        const session = await sessionApi.createSession();
        state.currentSessionId = session.id;
        if (typeof onSessionChanged === "function") onSessionChanged(session.id);
        // Intentionally do not abort other sessions' runtimes.
        store()?.getOrCreate(session.id);
        messagesEl.replaceChildren();
        ensureSpacer();
        showEmpty();
        state.worktreeStatus = null;
        renderWorktreeStatus();
        state.workspace = emptyWorkspaceState();
        renderWorkspacePanel();
        state.projectDir = "";
        if (typeof applySessionAgent === "function") {
          applySessionAgent(session.id, state.selectedAgent || "codex");
        }
        await loadProjectDir(session.id);
        if (typeof loadUsageSummary === "function") await loadUsageSummary(session.id);
        setStatus("就绪");
        await refreshSessionList();
        if (typeof syncComposerControls === "function") syncComposerControls();
        // New session starts with a clean draft.
        const newSlot = ensureSlot(session.id);
        if (newSlot) newSlot.draftPrompt = "";
        if (promptEl) {
          promptEl.value = "";
          promptEl.focus();
        }
        closeSidebarIfMobile();
      } catch (error) {
        addSystem("创建会话失败: " + error.message, "error");
      }
    }

    async function deleteSession(id) {
      try {
        await sessionApi.deleteSession(id);
        if (store()) store().dispose(id);
        if (state.currentSessionId === id) {
          state.currentSessionId = null;
          if (typeof onSessionChanged === "function") onSessionChanged(null);
          messagesEl.replaceChildren();
          ensureSpacer();
          showEmpty();
          state.projectDir = "";
          projectDirPath.textContent = "(当前目录)";
          state.worktreeStatus = null;
          renderWorktreeStatus();
          state.workspace = emptyWorkspaceState();
          renderWorkspacePanel();
          setStatus("就绪");
          if (typeof syncComposerControls === "function") syncComposerControls();
        }
        await refreshSessionList();
        closeSidebarIfMobile();
      } catch (error) {
        addSystem("删除会话失败: " + error.message, "error");
      }
    }

    return {
      refreshSessionList,
      loadSessions,
      switchSession,
      newSession,
      deleteSession,
      // Exposed so the chat-client can restore an aborted/failed prompt back
      // into the composer instead of silently dropping it.
      restoreDraftFor,
    };
  }

  const api = { createSessionController };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.SessionController = api;
})(typeof window !== "undefined" ? window : globalThis);
